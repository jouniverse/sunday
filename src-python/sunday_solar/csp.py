"""PySAM probe and CSP compute wrappers.

Lazy-imports NREL-PySAM so pvlib /health stays fast when the optional extra is
absent. Layout and plant routes refuse with guidance rather than inventing MWh.

SSC bundled with PySAM includes LGPL NLopt/lp_solve; we call the wheel, we do
not copy those sources.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta, timezone
from typing import Any, Iterator

import numpy as np
import pandas as pd
from pvlib.location import Location


class CspUnavailable(Exception):
    """PySAM missing or a CSP module refused the request."""


@dataclass(frozen=True)
class PysamProbe:
    available: bool
    version: str | None
    tower_layout: bool
    tower_plant: bool
    trough_plant: bool
    detail: str


def probe_pysam() -> PysamProbe:
    try:
        import PySAM  # type: ignore[import-not-found]
    except Exception:
        return PysamProbe(
            available=False,
            version=None,
            tower_layout=False,
            tower_plant=False,
            trough_plant=False,
            detail=(
                "PySAM is not installed. From the src-python directory run: "
                "pip install 'nrel-pysam>=5'  (or: pip install -e '.[csp]'). "
                "Do not run that extra from the Sunday repo root — pyproject.toml lives in src-python."
            ),
        )
    version = getattr(PySAM, "__version__", "unknown")
    tower_layout = _can_import("PySAM.Solarpilot")
    tower_plant = _can_import("PySAM.TcsmoltenSalt")
    trough_plant = _can_import("PySAM.TroughPhysical")
    return PysamProbe(
        available=tower_layout or tower_plant or trough_plant,
        version=version,
        tower_layout=tower_layout,
        tower_plant=tower_plant,
        trough_plant=trough_plant,
        detail="PySAM loaded" if version else "PySAM present",
    )


def _can_import(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def _set(model: Any, key: str, value: Any) -> bool:
    try:
        model.value(key, value)
        return True
    except Exception:
        return False


def _set_cooling(model: Any, cooling: str) -> None:
    """Wet is SAM's default. Assigning CT=0 NaNs annual_energy on MSPTNone and PhysicalTroughNone."""
    if cooling == "dry":
        _set(model, "CT", 1)
    elif cooling == "hybrid":
        _set(model, "CT", 2)


def _set_required(model: Any, key: str, value: Any) -> None:
    if not _set(model, key, value):
        raise CspUnavailable(f"PySAM rejected required input '{key}'.")


def _get(model: Any, key: str, default: Any = None) -> Any:
    try:
        return model.value(key)
    except Exception:
        return default


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _jsonable(value: Any) -> Any:
    """Pipe / JSON cannot carry numpy scalars that SSC returns."""
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, np.ndarray):
        return _jsonable(value.tolist())
    if isinstance(value, np.generic):
        return _jsonable(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _positive_energy(*values: Any) -> float | None:
    for value in values:
        number = _finite(value)
        if number is not None and number > 0:
            return number
    return None


def _plant_energy(model: Any, rated_mwe: float) -> tuple[float, float]:
    """Read annual energy / CF from SSC; refuse NaN that would JSON as null."""
    exported: dict[str, Any] = {}
    try:
        exported = model.Outputs.export()
    except Exception:
        pass
    # Prefer a positive value from either export() or value(); a 0 in one
    # channel with a real number in the other showed up as a false refusal.
    annual = _positive_energy(exported.get("annual_energy"), _get(model, "annual_energy"))
    cf = _finite(exported.get("capacity_factor"))
    if cf is None:
        cf = _finite(_get(model, "capacity_factor"))
    if cf is not None and cf > 1:
        cf = cf / 100.0
    if annual is None:
        raise CspUnavailable(
            "Plant returned no usable annual energy (NaN or zero). "
            f"P_ref={rated_mwe:g} MWe. Weather is labelled clearsky Ineichen in NSRDB column order."
        )
    if cf is None:
        rated_kwh = rated_mwe * 1000.0 * 8760.0
        cf = annual / rated_kwh if rated_kwh > 0 else 0.0
    return annual, cf


# SAM LCOE (FCR) mode — not the full Singleowner cash-flow. O&M from
# MSPTSingleOwner / PhysicalTroughSingleOwner SystemCosts (USD).
_SAM_UTILITY_FCR = 0.098
_TOWER_OM_CAPACITY_PER_KW_YEAR = 66.0
_TOWER_OM_PRODUCTION_PER_MWH = 3.5
_TROUGH_OM_CAPACITY_PER_KW_YEAR = 66.0
_TROUGH_OM_PRODUCTION_PER_MWH = 4.0


def _compute_lcoe(
    kind: str,
    annual_energy_kwh: float,
    rated_mwe: float,
    installed_cost_usd: float | None,
    version: str | None,
) -> tuple[float | None, str]:
    """Simple FCR LCOE. Capital from the plant cost model; FCR/O&M are SAM defaults."""
    if installed_cost_usd is None or installed_cost_usd <= 0 or annual_energy_kwh <= 0:
        return None, "LCOE unavailable — plant did not return total_installed_cost."
    try:
        import PySAM.Lcoefcr as Lcoefcr  # type: ignore[import-not-found]
    except Exception:
        return None, "LCOE unavailable — PySAM.Lcoefcr is not installed."
    if kind == "trough":
        om_kw = _TROUGH_OM_CAPACITY_PER_KW_YEAR
        om_mwh = _TROUGH_OM_PRODUCTION_PER_MWH
        cost_src = "PhysicalTroughSingleOwner"
    else:
        om_kw = _TOWER_OM_CAPACITY_PER_KW_YEAR
        om_mwh = _TOWER_OM_PRODUCTION_PER_MWH
        cost_src = "MSPTSingleOwner"
    rated_kw = rated_mwe * 1000.0
    try:
        model = Lcoefcr.new()
        model.value("annual_energy", annual_energy_kwh)
        model.value("capital_cost", installed_cost_usd)
        model.value("fixed_charge_rate", _SAM_UTILITY_FCR)
        model.value("fixed_operating_cost", om_kw * rated_kw)
        model.value("variable_operating_cost", om_mwh / 1000.0)
        model.execute(0)
        lcoe = _finite(model.value("lcoe_fcr"))
    except Exception as exc:
        return None, f"LCOE unavailable — Lcoefcr failed ({exc})."
    if lcoe is None or lcoe <= 0:
        return None, "LCOE unavailable — Lcoefcr returned no lcoe_fcr."
    ver = version or "unknown"
    method = (
        f"PySAM.Lcoefcr {ver} (FCR={_SAM_UTILITY_FCR:g}, capital=SAM total_installed_cost, "
        f"O&M={om_kw:g} USD/kW-yr + {om_mwh:g} USD/MWh from {cost_src} defaults, USD)"
    )
    return lcoe, method


def _sam_time_zone_hours(longitude: float) -> int:
    """SAM Time Zone is hours from UTC (negative west). Must match the Hour column.

    Writing Time Zone 0 with a far-east longitude made SSC emit
    `S_decode hour: 44` and NaN annual_energy (Australia 133°E, P_ref still valid).
    """
    return int(max(-12, min(14, round(float(longitude) / 15.0))))


def _clean_irrad(value: Any) -> float:
    number = _finite(value)
    if number is None or number < 0:
        return 0.0
    return number


def write_clearsky_weather_csv(latitude: float, longitude: float, path: str) -> None:
    """Write an NSRDB-shaped SAM CSV that SSC's CSP readers will actually use.

    A short `GHI,DNI,DHI` table is enough for SolarPILOT *layout*, but
    `TcsmoltenSalt` / `TroughPhysical` map irradiance by NSRDB column order
    (`DHI,DNI,GHI`) and will not track the field unless dew point, wind
    direction and surface albedo are present. Missing those columns yields
    eta_field = 0, negative parasitics-only energy, and `S_decode hour: 25`.

    Hour is local standard time for `round(longitude/15)` so it stays in 0–23
    at the written Time Zone. UTC timestamps with Time Zone 0 fail at large |lon|.
    """
    tz_hours = _sam_time_zone_hours(longitude)
    offset = timezone(timedelta(hours=tz_hours))
    loc = Location(latitude, longitude, tz=tz_hours, altitude=0)
    times = pd.date_range("2019-01-01", periods=8760, freq="h", tz=offset)
    cs = loc.get_clearsky(times, model="ineichen")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(
            "Source,Location ID,City,State,Country,Latitude,Longitude,Time Zone,Elevation\n"
        )
        handle.write(f"NSRDB,0,-,-,-,{latitude},{longitude},{tz_hours},0\n")
        handle.write(
            "Year,Month,Day,Hour,Minute,DHI,DNI,GHI,Dew Point,Temperature,"
            "Pressure,Wind Direction,Wind Speed,Surface Albedo\n"
        )
        for stamp, ghi, dni, dhi in zip(
            times, cs["ghi"].to_numpy(), cs["dni"].to_numpy(), cs["dhi"].to_numpy(), strict=True
        ):
            handle.write(
                f"{stamp.year},{stamp.month},{stamp.day},{stamp.hour},0,"
                f"{_clean_irrad(dhi):.1f},{_clean_irrad(dni):.1f},{_clean_irrad(ghi):.1f},"
                "5,20,950,180,3,0.2\n"
            )


@contextmanager
def _clearsky_weather_csv(latitude: float, longitude: float) -> Iterator[str]:
    fd, path = tempfile.mkstemp(prefix="sunday-csp-", suffix=".csv")
    os.close(fd)
    try:
        write_clearsky_weather_csv(latitude, longitude, path)
        yield path
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _run_isolated(kind: str, body: dict[str, Any], timeout_s: float = 180.0) -> dict[str, Any]:
    """Run SSC plant physics in a child interpreter so a SIGSEGV cannot kill uvicorn.

    multiprocessing.spawn re-imports the parent __main__ (uvicorn), so we use
    `python -m sunday_solar.csp` and a result file instead of a Pipe.
    """
    fd, out_path = tempfile.mkstemp(prefix="sunday-csp-out-", suffix=".json")
    os.close(fd)
    try:
        try:
            completed = subprocess.run(
                [sys.executable, "-m", "sunday_solar.csp", kind, out_path],
                input=json.dumps(body),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise CspUnavailable(
                f"{kind} plant timed out after {timeout_s:.0f}s. The solar engine is still running."
            ) from None
        payload: dict[str, Any] | None = None
        try:
            with open(out_path, encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                payload = loaded
        except (OSError, json.JSONDecodeError):
            payload = None
        if payload and payload.get("ok"):
            result = payload.get("result")
            if isinstance(result, dict):
                return result
            raise CspUnavailable(f"{kind} plant returned a malformed result.")
        if payload and payload.get("error"):
            raise CspUnavailable(str(payload["error"]))
        tail = (completed.stderr or completed.stdout or "").strip()[-800:]
        extra = f" {tail}" if tail else ""
        raise CspUnavailable(
            f"{kind} plant crashed in native SSC (exit {completed.returncode}). "
            f"The solar engine is still running. Try Estimate again.{extra}"
        )
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass


def _cli() -> None:
    kind = sys.argv[1]
    out_path = sys.argv[2]
    body = json.load(sys.stdin)
    try:
        if kind == "tower":
            result = _run_tower_plant(body)
        elif kind == "trough":
            result = _run_trough_plant(body)
        else:
            raise CspUnavailable(f"Unknown CSP worker '{kind}'.")
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump({"ok": True, "result": _jsonable(result)}, handle)
    except CspUnavailable as exc:
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump({"ok": False, "error": str(exc)}, handle)
        raise SystemExit(2) from exc
    except Exception as exc:
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, handle)
        raise SystemExit(1) from exc


def _assign_solarpilot_from_mspt(model: Any) -> None:
    """Copy overlapping MSPTNone defaults so SolarPILOT precheck has rec_height etc."""
    import PySAM.TcsmoltenSalt as TcsmoltenSalt  # type: ignore[import-not-found]

    plant = TcsmoltenSalt.default("MSPTNone")
    flat: dict[str, Any] = {}
    for values in plant.export().values():
        if isinstance(values, dict):
            flat.update(values)
    names = [
        name
        for name in dir(model.SolarPILOT)
        if not name.startswith("_") and name not in {"assign", "export", "replace"}
    ]
    for name in names:
        if name in flat:
            _set(model, name, flat[name])


def run_tower_layout(body: dict[str, Any]) -> dict[str, Any]:
    probe = probe_pysam()
    if not probe.tower_layout:
        raise CspUnavailable(probe.detail)
    import PySAM.Solarpilot as Solarpilot  # type: ignore[import-not-found]

    model = Solarpilot.new()
    _assign_solarpilot_from_mspt(model)

    h_tower = float(body["h_tower"])
    rec_height = float(body.get("rec_height", h_tower * (20.4598 / 194.227)))
    rec_aspect = float(body.get("rec_aspect", 20.4598 / 16.922))
    _set_required(model, "h_tower", h_tower)
    _set_required(model, "rec_height", rec_height)
    _set(model, "rec_aspect", rec_aspect)
    _set_required(model, "q_design", float(body["q_design"]))
    _set(model, "helio_width", float(body.get("helio_width", 12.2)))
    _set(model, "helio_height", float(body.get("helio_height", 12.2)))
    _set(model, "dni_des", float(body.get("dni_des", 950)))
    _set(model, "helio_optical_error", 0.00153)
    # Do not run the nested tower/receiver optimizer — that is what hung the sidecar.
    _set(model, "is_optimize", 0)
    _set(model, "calc_fluxmaps", 0)
    _set(model, "check_max_flux", 0)
    _set(model, "opt_max_iter", 1)

    latitude = float(body["latitude"])
    longitude = float(body["longitude"])
    with _clearsky_weather_csv(latitude, longitude) as weather_path:
        _set_required(model, "solar_resource_file", weather_path)
        try:
            model.execute(0)
        except Exception as exc:
            raise CspUnavailable(f"SolarPILOT layout failed: {exc}") from exc

        raw = _get(model, "heliostat_positions") or []
        try:
            raw = model.Outputs.export().get("heliostat_positions", raw)
        except Exception:
            pass

    positions: list[list[float]] = []
    for row in raw:
        if isinstance(row, (list, tuple)) and len(row) >= 2:
            positions.append([float(row[0]), float(row[1])])
        elif hasattr(row, "__len__") and len(row) >= 2:
            positions.append([float(row[0]), float(row[1])])

    n_hel = int(_get(model, "number_heliostats", len(positions)) or len(positions))
    try:
        exported = model.Outputs.export()
        n_hel = int(exported.get("number_heliostats", n_hel) or n_hel)
        area_sf = float(exported.get("area_sf", 0) or 0)
        land_area = float(exported.get("land_area", 0) or 0)
        h_opt = exported.get("h_tower_opt")
        opteff = exported.get("opteff_table")
    except Exception:
        area_sf = float(_get(model, "area_sf", 0) or 0)
        land_area = float(_get(model, "land_area", 0) or 0)
        h_opt = _get(model, "h_tower_opt")
        opteff = _get(model, "opteff_table")

    mean_eta = None
    if opteff is not None:
        try:
            mean_eta = float(np.nanmean(np.array(opteff, dtype=float)))
        except Exception:
            mean_eta = None

    return {
        "heliostat_positions": positions,
        "number_heliostats": n_hel,
        "area_sf": area_sf,
        "land_area": land_area,
        "optical_efficiency": mean_eta,
        "h_tower_opt": h_opt,
        "method": (
            f"PySAM.Solarpilot {probe.version} (cmod_solarpilot, is_optimize=0); "
            "weather=pvlib-clearsky-ineichen"
        ),
    }


def run_tower_plant(body: dict[str, Any]) -> dict[str, Any]:
    return _run_isolated("tower", body)


def run_trough_plant(body: dict[str, Any]) -> dict[str, Any]:
    return _run_isolated("trough", body)


def _run_tower_plant(body: dict[str, Any]) -> dict[str, Any]:
    probe = probe_pysam()
    if not probe.tower_plant:
        raise CspUnavailable(probe.detail)
    import PySAM.TcsmoltenSalt as TcsmoltenSalt  # type: ignore[import-not-found]

    latitude = float(body["latitude"])
    longitude = float(body["longitude"])
    rated_mwe = float(body["rated_mwe"])
    solar_multiple = float(body["solar_multiple"])
    tes_hours = float(body.get("tes_hours", 10))
    cooling = str(body.get("cooling", "wet"))
    scaling_note = ""
    energy_scale = 1.0

    def make_model() -> Any:
        try:
            return TcsmoltenSalt.default("MSPTNone")
        except Exception:
            return TcsmoltenSalt.new()

    def execute(model: Any, apply_size: bool) -> None:
        with _clearsky_weather_csv(latitude, longitude) as path:
            _set_required(model, "solar_resource_file", path)
            # Flags before size knobs — the order that keeps MSPTNone's optical table.
            _set(model, "is_dispatch", 0)
            _set(model, "sim_type", 1)
            _set(model, "field_model_type", 2)
            if apply_size:
                _set(model, "P_ref", rated_mwe)
                _set(model, "solarm", solar_multiple)
                _set(model, "tshours", tes_hours)
            _set_cooling(model, cooling)
            try:
                model.execute(0)
            except CspUnavailable:
                raise
            except Exception as exc:
                raise CspUnavailable(f"TcsmoltenSalt failed: {exc}") from exc

    model = make_model()
    try:
        execute(model, apply_size=True)
        annual, cf = _plant_energy(model, rated_mwe)
    except CspUnavailable as first:
        # Requested P_ref/SM can NaN annual_energy against the default ~115 MWe
        # field table. Fall back to that table and scale — labelled, not silent.
        model = make_model()
        try:
            execute(model, apply_size=False)
            annual_default, cf = _plant_energy(model, 115.0)
        except CspUnavailable:
            raise first from None
        p_ref_sam = _finite(_get(model, "P_ref")) or 115.0
        if p_ref_sam <= 0:
            raise first from None
        energy_scale = rated_mwe / p_ref_sam
        annual = annual_default * energy_scale
        scaling_note = (
            f"; annual scaled by rated-power ratio {rated_mwe:g}/{p_ref_sam:g} MWe "
            "because SAM returned no energy at the requested P_ref/SM"
        )

    water = _finite(_get(model, "annual_W_cooling_tower"))
    icc = _finite(_get(model, "total_installed_cost"))
    if icc is not None and energy_scale != 1.0:
        icc *= energy_scale
    lcoe, lcoe_method = _compute_lcoe("tower", annual, rated_mwe, icc, probe.version)
    return {
        "annual_energy_kwh": annual,
        "capacity_factor": cf,
        "water_use_m3": water,
        "lcoe_usd_per_kwh": lcoe,
        "lcoe_method": lcoe_method,
        "total_installed_cost_usd": icc,
        "n_hel": _get(model, "N_hel_calc"),
        "a_sf": _get(model, "A_sf"),
        "method": (
            f"PySAM.TcsmoltenSalt {probe.version} "
            "(cmod_tcsmolten_salt, MSPTNone, field_model_type=user-field, sim_type=timeseries); "
            "optics=SAM-default-heliostat-table; "
            f"cooling={cooling}; weather=pvlib-clearsky-ineichen-nsrdb-csv"
            f"{scaling_note}"
        ),
    }


def _run_trough_plant(body: dict[str, Any]) -> dict[str, Any]:
    probe = probe_pysam()
    if not probe.trough_plant:
        raise CspUnavailable(probe.detail)
    import PySAM.TroughPhysical as TroughPhysical  # type: ignore[import-not-found]

    try:
        model = TroughPhysical.default("PhysicalTroughNone")
    except Exception:
        model = TroughPhysical.new()

    weather_method = "pvlib-clearsky-ineichen-nsrdb-csv"
    rated_mwe = float(body["rated_mwe"])
    cooling = body.get("cooling", "wet")
    try:
        with _clearsky_weather_csv(float(body["latitude"]), float(body["longitude"])) as path:
            # TroughPhysical weather key is file_name, not solar_resource_file.
            # Calling execute with no file is what SIGSEGV'd uvicorn.
            assigned = _set(model, "file_name", path)
            if not assigned:
                try:
                    model.Weather.file_name = path
                except Exception as exc:
                    raise CspUnavailable(f"TroughPhysical rejected weather file: {exc}") from exc
            _set(model, "P_ref", rated_mwe)
            _set(model, "specified_solar_multiple", float(body["solar_multiple"]))
            _set(model, "use_solar_mult_or_aperture_area", 0)
            _set(model, "tshours", float(body.get("tes_hours", 10)))
            _set(model, "Row_Distance", float(body.get("row_pitch_m", 17)))
            _set(model, "azimuth", float(body.get("row_azimuth_degrees", 0)))
            # W_aperture is a per-SCA array on PhysicalTroughNone — a scalar
            # assignment is rejected; leave SAM's default SCA geometry.
            _set_cooling(model, cooling)
            model.execute(0)
    except CspUnavailable:
        raise
    except Exception as exc:
        raise CspUnavailable(f"TroughPhysical failed: {exc}") from exc

    annual, cf = _plant_energy(model, rated_mwe)
    water = _finite(_get(model, "annual_total_water_use"))
    icc = _finite(_get(model, "total_installed_cost"))
    lcoe, lcoe_method = _compute_lcoe("trough", annual, rated_mwe, icc, probe.version)
    return {
        "annual_energy_kwh": annual,
        "capacity_factor": cf,
        "water_use_m3": water,
        "lcoe_usd_per_kwh": lcoe,
        "lcoe_method": lcoe_method,
        "total_installed_cost_usd": icc,
        "n_loops": _get(model, "nLoops"),
        "n_sca": _get(model, "nSCA"),
        "method": (
            f"PySAM.TroughPhysical {probe.version} (cmod_trough_physical, PhysicalTroughNone); "
            f"layout=sunday-trough-rows; collectors=SAM-default-SCA; "
            f"cooling={cooling}; weather={weather_method}"
        ),
    }


if __name__ == "__main__":
    _cli()


