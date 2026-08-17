"""The pvlib calls behind each endpoint.

Kept free of FastAPI so it can be tested directly, and so a future batch or CLI
entry point can reuse it.
"""

from __future__ import annotations

import re

import numpy as np
import pandas as pd
import pvlib
from pvlib.location import Location
from pvlib.modelchain import ModelChain
from pvlib.pvsystem import Array, FixedMount, PVSystem, SingleAxisTrackerMount
from pvlib.temperature import TEMPERATURE_MODEL_PARAMETERS

from . import __version__
from .models import (
    ArraySpec,
    DegradationRequest,
    DegradationResponse,
    MethodBlock,
    ModelChainRequest,
    ModelChainResponse,
    MonthlyValue,
    OptimalTiltRequest,
    OptimalTiltResponse,
    Site,
    SunPathPoint,
    SunPathRequest,
    SunPathResponse,
    SunPathTrace,
    TiltCandidate,
    TransposeRequest,
    TransposeResponse,
    WeatherSource,
)

#: Tilts within this fraction of the optimum are treated as equally good. It
#: comes from the fact that annual insolation is flat near the optimum, so
#: presenting a single "correct" tilt would overstate the precision.
ENVELOPE_TOLERANCE = 0.005


class EngineError(ValueError):
    """A request that pvlib cannot answer as asked."""


_ISO_OFFSET = re.compile(r"^([+-])(\d{2}):?(\d{2})$")


def zoneinfo_key(tz: str) -> str:
    """Map a site timezone string to a ZoneInfo key pvlib Location accepts.

    ISO offsets like `-08:00` are not IANA names — Location uses zoneinfo and
    raises ZoneInfoNotFoundError. `Etc/GMT±N` uses POSIX-inverted signs
    (Etc/GMT+8 is UTC−8).
    """
    name = (tz or "UTC").strip()
    if name.upper() in {"UTC", "Z", "GMT"}:
        return "UTC"
    match = _ISO_OFFSET.match(name)
    if match:
        hours = int(match.group(2))
        if match.group(1) == "-":
            hours = -hours
        if hours == 0:
            return "UTC"
        posix = -hours
        sign = "+" if posix >= 0 else "-"
        return f"Etc/GMT{sign}{abs(posix)}"
    return name


def location_of(site: Site) -> Location:
    return Location(
        latitude=site.latitude,
        longitude=site.longitude,
        altitude=site.altitude,
        tz=zoneinfo_key(site.timezone),
    )


def build_weather(site: Site, source: WeatherSource) -> tuple[pd.DataFrame, str]:
    """Returns an hourly (or 15-minute) weather frame and a provenance label."""
    location = location_of(site)

    if source.kind == "clearsky":
        times = pd.date_range(
            f"{source.year}-01-01",
            f"{source.year}-12-31 23:59",
            freq=source.freq,
            tz=zoneinfo_key(site.timezone),
        )
        weather = location.get_clearsky(times, model="ineichen")
        weather["temp_air"] = source.default_temp_air
        weather["wind_speed"] = source.default_wind_speed
        return weather, "Ineichen-Perez clear-sky model (cloudless upper bound)"

    if not source.times or not source.ghi:
        raise EngineError("a series weather source needs both times and ghi")
    if len(source.times) != len(source.ghi):
        raise EngineError("times and ghi must have the same length")

    index = pd.DatetimeIndex(pd.to_datetime(source.times, utc=True)).tz_convert(zoneinfo_key(site.timezone))
    weather = pd.DataFrame(index=index)
    weather["ghi"] = np.asarray(source.ghi, dtype=float)

    solar_position = location.get_solarposition(index)

    if source.dni is not None and source.dhi is not None:
        _require_same_length(source.dni, source.ghi, "dni")
        _require_same_length(source.dhi, source.ghi, "dhi")
        weather["dni"] = np.asarray(source.dni, dtype=float)
        weather["dhi"] = np.asarray(source.dhi, dtype=float)
        label = "supplied GHI, DNI and DHI"
    else:
        # Split GHI into beam and diffuse with the Erbs correlation. Named in the
        # method block because a decomposed series is less certain than a
        # measured one.
        erbs = pvlib.irradiance.erbs(
            weather["ghi"], solar_position["apparent_zenith"], index
        )
        weather["dni"] = erbs["dni"]
        weather["dhi"] = erbs["dhi"]
        label = "supplied GHI, beam/diffuse split with the Erbs correlation"

    weather["temp_air"] = (
        np.asarray(source.temp_air, dtype=float)
        if source.temp_air is not None
        else source.default_temp_air
    )
    weather["wind_speed"] = (
        np.asarray(source.wind_speed, dtype=float)
        if source.wind_speed is not None
        else source.default_wind_speed
    )
    return weather, label


def _require_same_length(values: list[float], reference: list[float], name: str) -> None:
    if len(values) != len(reference):
        raise EngineError(f"{name} must have the same length as ghi")


def _mount(array: ArraySpec):
    if array.mount == "single_axis":
        return SingleAxisTrackerMount(
            axis_tilt=0.0,
            # A north-south axis is the standard single-axis layout.
            axis_azimuth=180.0,
            max_angle=array.max_angle,
            backtrack=array.backtrack,
            gcr=array.ground_coverage_ratio,
        )
    return FixedMount(
        surface_tilt=array.surface_tilt, surface_azimuth=array.surface_azimuth
    )


def _hours_per_step(index: pd.DatetimeIndex) -> float:
    """Energy integration step in hours, inferred from the index."""
    if len(index) < 2:
        return 1.0
    deltas = index.to_series().diff().dropna()
    if deltas.empty:
        return 1.0
    return float(deltas.median().total_seconds() / 3600.0)


def run_model_chain(request: ModelChainRequest) -> ModelChainResponse:
    site, array = request.site, request.array
    location = location_of(site)
    weather, weather_label = build_weather(site, request.weather)

    dc_capacity_w = array.dc_capacity_kw * 1000.0
    thermal = TEMPERATURE_MODEL_PARAMETERS["sapm"][request.thermal_model]

    pv_array = Array(
        mount=_mount(array),
        # PVWatts DC model: nameplate power and its temperature coefficient.
        module_parameters={"pdc0": dc_capacity_w, "gamma_pdc": array.gamma_pdc},
        temperature_model_parameters=thermal,
    )
    system = PVSystem(
        arrays=[pv_array],
        inverter_parameters={
            "pdc0": dc_capacity_w / array.dc_ac_ratio,
            "eta_inv_nom": array.inverter_efficiency,
        },
    )
    chain = ModelChain(
        system,
        location,
        aoi_model="physical",
        spectral_model="no_loss",
        transposition_model=request.transposition_model,
    )
    chain.run_model(weather)

    step_hours = _hours_per_step(weather.index)
    # Clip negatives: pvlib reports inverter night-time consumption, which is
    # not a generation loss and would distort monthly sums.
    ac_kwh = chain.results.ac.clip(lower=0.0) * step_hours / 1000.0
    # System losses (soiling, mismatch, wiring, availability) are not part of
    # the PVWatts DC/AC chain, so they are applied once, here.
    ac_kwh = ac_kwh * (1.0 - array.system_losses)

    poa = chain.results.total_irrad["poa_global"]
    poa_kwh_m2 = poa.clip(lower=0.0) * step_hours / 1000.0

    monthly = [
        MonthlyValue(
            month=int(month),
            energy_kwh=float(ac_kwh[ac_kwh.index.month == month].sum()),
            poa_kwh_m2=float(poa_kwh_m2[poa_kwh_m2.index.month == month].sum()),
        )
        for month in range(1, 13)
    ]

    annual = float(ac_kwh.sum())
    poa_annual = float(poa_kwh_m2.sum())
    specific_yield = annual / array.dc_capacity_kw
    hours = float(len(weather.index)) * step_hours
    capacity_factor = annual / (array.dc_capacity_kw * hours) if hours else 0.0
    # Performance ratio: actual yield over the yield an ideal array would give
    # for the same plane-of-array insolation at STC.
    performance_ratio = specific_yield / poa_annual if poa_annual > 0 else 0.0

    notes = []
    if request.weather.kind == "clearsky":
        notes.append(
            "Clear-sky weather ignores cloud cover: treat this as a physical "
            "upper bound, not an expected yield."
        )
    if array.mount == "single_axis":
        notes.append(
            f"Single-axis tracking, +/-{array.max_angle:g} deg, "
            f"backtracking {'on' if array.backtrack else 'off'} at GCR "
            f"{array.ground_coverage_ratio:.2f}."
        )

    return ModelChainResponse(
        annual_energy_kwh=annual,
        specific_yield_kwh_per_kwp=specific_yield,
        capacity_factor=capacity_factor,
        poa_annual_kwh_m2=poa_annual,
        performance_ratio=performance_ratio,
        monthly=monthly,
        method=method_block(
            transposition=request.transposition_model,
            cell_temperature=f"SAPM {request.thermal_model}",
            dc_model="PVWatts DC",
            ac_model="PVWatts inverter",
            weather=weather_label,
            notes=notes
            + [f"System losses applied: {array.system_losses * 100:.1f}%"],
        ),
    )


def find_optimal_tilt(request: OptimalTiltRequest) -> OptimalTiltResponse:
    site = request.site
    location = location_of(site)
    weather, weather_label = build_weather(site, request.weather)
    solar_position = location.get_solarposition(weather.index)
    dni_extra = pvlib.irradiance.get_extra_radiation(weather.index)
    airmass = location.get_airmass(solar_position=solar_position)
    step_hours = _hours_per_step(weather.index)

    azimuths = _inclusive_range(
        request.azimuth_min, request.azimuth_max, request.azimuth_step
    )
    tilts = _inclusive_range(request.tilt_min, request.tilt_max, request.tilt_step)
    if not azimuths or not tilts:
        raise EngineError("the requested tilt/azimuth search range is empty")

    candidates: list[TiltCandidate] = []
    for azimuth in azimuths:
        for tilt in tilts:
            total = pvlib.irradiance.get_total_irradiance(
                surface_tilt=tilt,
                surface_azimuth=azimuth,
                solar_zenith=solar_position["apparent_zenith"],
                solar_azimuth=solar_position["azimuth"],
                dni=weather["dni"],
                ghi=weather["ghi"],
                dhi=weather["dhi"],
                dni_extra=dni_extra,
                airmass=airmass["airmass_relative"],
                model=request.transposition_model,
            )
            insolation = float(
                (total["poa_global"].clip(lower=0.0) * step_hours / 1000.0).sum()
            )
            candidates.append(
                TiltCandidate(
                    surface_tilt=tilt,
                    surface_azimuth=azimuth,
                    poa_annual_kwh_m2=insolation,
                    relative=1.0,
                )
            )

    best = max(candidates, key=lambda c: c.poa_annual_kwh_m2)
    peak = best.poa_annual_kwh_m2
    for candidate in candidates:
        candidate.relative = candidate.poa_annual_kwh_m2 / peak if peak > 0 else 0.0

    # The envelope is the contiguous band of tilts at the best azimuth that stay
    # within tolerance of the peak. This is what the UI offers as the range the
    # designer may move within without a meaningful yield penalty.
    at_best_azimuth = sorted(
        (c for c in candidates if c.surface_azimuth == best.surface_azimuth),
        key=lambda c: c.surface_tilt,
    )
    within = [c.surface_tilt for c in at_best_azimuth if c.relative >= 1.0 - ENVELOPE_TOLERANCE]

    return OptimalTiltResponse(
        optimal=best,
        envelope_tilt_min=min(within) if within else best.surface_tilt,
        envelope_tilt_max=max(within) if within else best.surface_tilt,
        envelope_tolerance=ENVELOPE_TOLERANCE,
        candidates=candidates,
        method=method_block(
            transposition=request.transposition_model,
            cell_temperature="not modelled (irradiance search)",
            dc_model="not modelled",
            ac_model="not modelled",
            weather=weather_label,
            notes=[
                "Maximises annual plane-of-array insolation, which ignores "
                "temperature and soiling effects that shift the economic optimum "
                "by a degree or two.",
            ],
        ),
    )


def _inclusive_range(start: float, stop: float, step: float) -> list[float]:
    if step <= 0 or stop < start:
        return []
    count = int(round((stop - start) / step)) + 1
    return [round(start + i * step, 6) for i in range(count)]


#: Default sun-path dates: solstices, equinoxes. Month/day pairs.
_KEY_DATES = (
    ((6, 21), "Summer solstice"),
    ((3, 20), "Spring equinox"),
    ((12, 21), "Winter solstice"),
)


def sun_path(request: SunPathRequest) -> SunPathResponse:
    site = request.site
    location = location_of(site)

    if request.dates:
        dates = [(pd.Timestamp(d).date(), pd.Timestamp(d).strftime("%d %b")) for d in request.dates]
    else:
        dates = [
            (pd.Timestamp(year=request.year, month=m, day=d).date(), label)
            for (m, d), label in _KEY_DATES
        ]

    traces: list[SunPathTrace] = []
    for date, label in dates:
        times = pd.date_range(
            f"{date} 00:00",
            f"{date} 23:59",
            freq=f"{request.step_minutes}min",
            tz=zoneinfo_key(site.timezone),
        )
        position = location.get_solarposition(times)

        aoi_series = None
        if request.surface_tilt is not None and request.surface_azimuth is not None:
            aoi_series = pvlib.irradiance.aoi(
                request.surface_tilt,
                request.surface_azimuth,
                position["apparent_zenith"],
                position["azimuth"],
            )

        points = [
            SunPathPoint(
                time=timestamp.isoformat(),
                elevation=float(position["apparent_elevation"].iloc[i]),
                azimuth=float(position["azimuth"].iloc[i]),
                aoi=float(aoi_series.iloc[i]) if aoi_series is not None else None,
            )
            for i, timestamp in enumerate(times)
        ]

        above = position["apparent_elevation"] > 0
        traces.append(
            SunPathTrace(
                date=str(date),
                label=label,
                points=points,
                daylight_hours=float(above.sum()) * request.step_minutes / 60.0,
                max_elevation=float(position["apparent_elevation"].max()),
            )
        )

    return SunPathResponse(
        traces=traces,
        method=method_block(
            transposition="not applicable",
            cell_temperature="not applicable",
            dc_model="not applicable",
            ac_model="not applicable",
            weather="geometry only",
        ),
    )


def transpose(request: TransposeRequest) -> TransposeResponse:
    site = request.site
    location = location_of(site)
    index = pd.DatetimeIndex(pd.to_datetime(request.times, utc=True)).tz_convert(zoneinfo_key(site.timezone))
    if len(index) != len(request.ghi):
        raise EngineError("times and ghi must have the same length")

    ghi = pd.Series(np.asarray(request.ghi, dtype=float), index=index)
    position = location.get_solarposition(index)

    if request.dni is not None and request.dhi is not None:
        dni = pd.Series(np.asarray(request.dni, dtype=float), index=index)
        dhi = pd.Series(np.asarray(request.dhi, dtype=float), index=index)
        weather_label = "supplied GHI, DNI and DHI"
    else:
        erbs = pvlib.irradiance.erbs(ghi, position["apparent_zenith"], index)
        dni, dhi = erbs["dni"], erbs["dhi"]
        weather_label = "supplied GHI, beam/diffuse split with the Erbs correlation"

    total = pvlib.irradiance.get_total_irradiance(
        surface_tilt=request.surface_tilt,
        surface_azimuth=request.surface_azimuth,
        solar_zenith=position["apparent_zenith"],
        solar_azimuth=position["azimuth"],
        dni=dni,
        ghi=ghi,
        dhi=dhi,
        dni_extra=pvlib.irradiance.get_extra_radiation(index),
        airmass=location.get_airmass(solar_position=position)["airmass_relative"],
        albedo=request.albedo,
        model=request.model,
    )

    step_hours = _hours_per_step(index)
    poa_total = float((total["poa_global"].clip(lower=0.0) * step_hours / 1000.0).sum())
    ghi_total = float((ghi.clip(lower=0.0) * step_hours / 1000.0).sum())

    return TransposeResponse(
        times=[t.isoformat() for t in index],
        poa_global=[float(v) for v in total["poa_global"].fillna(0.0)],
        poa_direct=[float(v) for v in total["poa_direct"].fillna(0.0)],
        poa_diffuse=[float(v) for v in total["poa_diffuse"].fillna(0.0)],
        total_kwh_m2=poa_total,
        transposition_factor=poa_total / ghi_total if ghi_total > 0 else 0.0,
        method=method_block(
            transposition=request.model,
            cell_temperature="not modelled",
            dc_model="not modelled",
            ac_model="not modelled",
            weather=weather_label,
            notes=[f"Ground albedo {request.albedo:.2f}"],
        ),
    )


#: Below this the year-on-year method has too little data to support a claim.
MIN_DEGRADATION_YEARS = 2.0


def degradation(request: DegradationRequest) -> DegradationResponse:
    """Year-on-year degradation, following the RdTools approach.

    For each observation, compare it with the observation about 365 days later
    and take the median of the resulting annual rates. The median is what makes
    the method robust to outages and soiling events, which is exactly why we do
    not fit a straight line through the raw series.
    """
    if len(request.times) != len(request.values):
        raise EngineError("times and values must have the same length")
    if len(request.times) < 24:
        raise EngineError("need at least 24 observations to estimate degradation")

    index = pd.DatetimeIndex(pd.to_datetime(request.times, utc=True))
    series = pd.Series(np.asarray(request.values, dtype=float), index=index).dropna()
    series = series[series > 0]
    if series.empty:
        raise EngineError("no positive normalised values to analyse")

    years_covered = (series.index[-1] - series.index[0]).total_seconds() / (365.25 * 86400)
    if years_covered < MIN_DEGRADATION_YEARS:
        raise EngineError(
            f"series covers {years_covered:.2f} years; year-on-year degradation "
            f"needs at least {MIN_DEGRADATION_YEARS:g}"
        )

    # Drop the timezone before going to numpy: a tz-aware index converts to an
    # object array of Timestamps, which does not support vectorised arithmetic.
    timestamps = series.index.tz_convert("UTC").tz_localize(None).to_numpy(dtype="datetime64[ns]")
    values = series.to_numpy()
    rates: list[float] = []
    # Tolerance for "one year later"; a month either side keeps monthly series usable.
    tolerance = np.timedelta64(30, "D")
    one_year = np.timedelta64(365, "D")

    for i, start in enumerate(timestamps):
        target = start + one_year
        j = int(np.argmin(np.abs(timestamps - target)))
        if abs(timestamps[j] - target) > tolerance or j == i:
            continue
        elapsed_years = (timestamps[j] - start) / np.timedelta64(1, "D") / 365.25
        if elapsed_years <= 0 or values[i] <= 0:
            continue
        rates.append(((values[j] / values[i]) - 1.0) / elapsed_years * 100.0)

    if len(rates) < 6:
        raise EngineError(
            "too few year-apart pairs to estimate degradation; the series needs "
            "at least two full years of overlapping coverage"
        )

    rate_array = np.asarray(rates)
    median = float(np.median(rate_array))
    # Percentile interval on the pair distribution, matching RdTools' reporting
    # of an empirical rather than parametric confidence band.
    tail = (1.0 - request.confidence) / 2.0 * 100.0
    interval = (
        float(np.percentile(rate_array, tail)),
        float(np.percentile(rate_array, 100.0 - tail)),
    )

    return DegradationResponse(
        rate_percent_per_year=median,
        confidence_interval=interval,
        years_covered=float(years_covered),
        sample_pairs=len(rates),
        method=method_block(
            transposition="not applicable",
            cell_temperature="not applicable",
            dc_model="not applicable",
            ac_model="not applicable",
            weather="caller-supplied normalised series",
            notes=[
                "Year-on-year median of annualised rates (RdTools method).",
                f"Empirical {request.confidence * 100:.0f}% interval from "
                f"{len(rates)} year-apart pairs.",
            ],
        ),
    )


def method_block(
    *,
    transposition: str,
    cell_temperature: str,
    dc_model: str,
    ac_model: str,
    weather: str,
    notes: list[str] | None = None,
) -> MethodBlock:
    return MethodBlock(
        engine=f"sunday-solar-engine {__version__}",
        pvlib_version=pvlib.__version__,
        solar_position="NREL SPA (pvlib default)",
        transposition=transposition,
        cell_temperature=cell_temperature,
        dc_model=dc_model,
        ac_model=ac_model,
        weather=weather,
        notes=notes or [],
    )
