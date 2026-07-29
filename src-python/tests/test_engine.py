"""Physics tests for the solar engine.

These check behaviour that must hold for any correct implementation — hemisphere
symmetry, tilt optima near latitude, monotonic seasonal elevation — rather than
pinning exact pvlib outputs, which would break on every upstream release without
telling us anything useful.
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from sunday_solar.engine import (
    EngineError,
    degradation,
    find_optimal_tilt,
    run_model_chain,
    sun_path,
    transpose,
)
from sunday_solar.models import (
    ArraySpec,
    DegradationRequest,
    ModelChainRequest,
    OptimalTiltRequest,
    Site,
    SunPathRequest,
    TransposeRequest,
    WeatherSource,
)

MOJAVE = Site(latitude=35.05, longitude=-118.17, altitude=800, timezone="UTC")
HELSINKI = Site(latitude=60.17, longitude=24.94, altitude=20, timezone="UTC")
SYDNEY = Site(latitude=-33.87, longitude=151.21, altitude=30, timezone="UTC")


# --------------------------------------------------------------------------
# ModelChain
# --------------------------------------------------------------------------


def test_annual_yield_is_physically_plausible() -> None:
    result = run_model_chain(ModelChainRequest(site=MOJAVE, array=ArraySpec()))

    # Clear-sky specific yield in the Mojave should be high but bounded: real
    # sites there reach ~1900 kWh/kWp, and a cloudless year sits above that.
    assert 1500 < result.specific_yield_kwh_per_kwp < 3000
    assert 0.15 < result.capacity_factor < 0.40
    # Performance ratio is a fraction; anything above 1 would mean the model is
    # producing more than the incident energy allows.
    assert 0.6 < result.performance_ratio < 0.95
    assert len(result.monthly) == 12
    assert math.isclose(
        sum(m.energy_kwh for m in result.monthly), result.annual_energy_kwh, rel_tol=1e-6
    )
    assert result.method.pvlib_version
    assert any("upper bound" in note for note in result.method.notes)


def test_sunnier_latitude_outyields_a_cloudier_northern_one() -> None:
    mojave = run_model_chain(ModelChainRequest(site=MOJAVE, array=ArraySpec()))
    helsinki = run_model_chain(
        ModelChainRequest(site=HELSINKI, array=ArraySpec(surface_tilt=45))
    )
    assert mojave.specific_yield_kwh_per_kwp > helsinki.specific_yield_kwh_per_kwp


def test_yield_scales_linearly_with_dc_capacity() -> None:
    small = run_model_chain(
        ModelChainRequest(site=MOJAVE, array=ArraySpec(dc_capacity_kw=10))
    )
    large = run_model_chain(
        ModelChainRequest(site=MOJAVE, array=ArraySpec(dc_capacity_kw=1000))
    )
    assert math.isclose(
        small.specific_yield_kwh_per_kwp,
        large.specific_yield_kwh_per_kwp,
        rel_tol=1e-6,
    )
    assert math.isclose(large.annual_energy_kwh, small.annual_energy_kwh * 100, rel_tol=1e-6)


def test_system_losses_reduce_energy_proportionally() -> None:
    lossless = run_model_chain(
        ModelChainRequest(site=MOJAVE, array=ArraySpec(system_losses=0.0))
    )
    lossy = run_model_chain(
        ModelChainRequest(site=MOJAVE, array=ArraySpec(system_losses=0.20))
    )
    assert math.isclose(
        lossy.annual_energy_kwh, lossless.annual_energy_kwh * 0.80, rel_tol=1e-6
    )


def test_single_axis_tracking_beats_a_fixed_mount() -> None:
    fixed = run_model_chain(
        ModelChainRequest(site=MOJAVE, array=ArraySpec(mount="fixed", surface_tilt=30))
    )
    tracked = run_model_chain(
        ModelChainRequest(site=MOJAVE, array=ArraySpec(mount="single_axis"))
    )
    assert tracked.annual_energy_kwh > fixed.annual_energy_kwh
    assert any("tracking" in note.lower() for note in tracked.method.notes)


def test_northern_and_southern_hemisphere_are_mirror_images() -> None:
    north = run_model_chain(
        ModelChainRequest(
            site=Site(latitude=33.87, longitude=151.21, timezone="UTC"),
            array=ArraySpec(surface_tilt=30, surface_azimuth=180),
        )
    )
    south = run_model_chain(
        ModelChainRequest(site=SYDNEY, array=ArraySpec(surface_tilt=30, surface_azimuth=0))
    )
    # Equator-facing arrays at mirrored latitudes must yield nearly the same.
    assert math.isclose(
        north.specific_yield_kwh_per_kwp,
        south.specific_yield_kwh_per_kwp,
        rel_tol=0.05,
    )


def test_summer_outproduces_winter_in_the_northern_hemisphere() -> None:
    result = run_model_chain(ModelChainRequest(site=HELSINKI, array=ArraySpec(surface_tilt=45)))
    june = next(m for m in result.monthly if m.month == 6)
    december = next(m for m in result.monthly if m.month == 12)
    # Clear-sky weather understates real seasonality at this latitude, because it
    # gives December the cloudless days it never actually gets. Even so, day
    # length alone must produce a large summer surplus.
    assert june.energy_kwh > december.energy_kwh * 3


# --------------------------------------------------------------------------
# Optimal tilt
# --------------------------------------------------------------------------


def test_optimal_tilt_faces_the_equator_and_tracks_latitude() -> None:
    result = find_optimal_tilt(
        OptimalTiltRequest(site=MOJAVE, tilt_max=60, tilt_step=5, azimuth_step=30)
    )
    # Northern hemisphere: due south, within one azimuth step.
    assert abs(result.optimal.surface_azimuth - 180) <= 30
    # Optimal tilt for a clear-sky year sits within ~15 degrees of latitude.
    assert abs(result.optimal.surface_tilt - MOJAVE.latitude) < 15
    assert result.envelope_tilt_min <= result.optimal.surface_tilt <= result.envelope_tilt_max
    # A flat optimum should give a band, not a single point.
    assert result.envelope_tilt_max > result.envelope_tilt_min
    assert result.optimal.relative == pytest.approx(1.0)


def test_high_latitude_prefers_a_steeper_tilt() -> None:
    mojave = find_optimal_tilt(
        OptimalTiltRequest(site=MOJAVE, tilt_max=70, tilt_step=5, azimuth_step=45)
    )
    helsinki = find_optimal_tilt(
        OptimalTiltRequest(site=HELSINKI, tilt_max=70, tilt_step=5, azimuth_step=45)
    )
    assert helsinki.optimal.surface_tilt > mojave.optimal.surface_tilt


def test_southern_hemisphere_optimum_faces_north() -> None:
    result = find_optimal_tilt(
        OptimalTiltRequest(
            site=SYDNEY,
            azimuth_min=0,
            azimuth_max=360,
            azimuth_step=45,
            tilt_max=60,
            tilt_step=10,
        )
    )
    # Due north is 0 or 360 degrees.
    assert min(result.optimal.surface_azimuth, 360 - result.optimal.surface_azimuth) <= 45


def test_empty_search_range_is_rejected() -> None:
    with pytest.raises(EngineError):
        find_optimal_tilt(
            OptimalTiltRequest(site=MOJAVE, tilt_min=40, tilt_max=10, tilt_step=5)
        )


# --------------------------------------------------------------------------
# Sun path
# --------------------------------------------------------------------------


def test_sun_path_defaults_to_solstices_and_equinox() -> None:
    result = sun_path(SunPathRequest(site=MOJAVE, step_minutes=30))
    labels = [trace.label for trace in result.traces]
    assert "Summer solstice" in labels
    assert "Winter solstice" in labels

    summer = next(t for t in result.traces if t.label == "Summer solstice")
    winter = next(t for t in result.traces if t.label == "Winter solstice")
    assert summer.max_elevation > winter.max_elevation
    assert summer.daylight_hours > winter.daylight_hours
    assert len(summer.points) == 48


def test_sun_path_reports_angle_of_incidence_for_a_surface() -> None:
    result = sun_path(
        SunPathRequest(
            site=MOJAVE, step_minutes=60, surface_tilt=30, surface_azimuth=180
        )
    )
    trace = result.traces[0]
    assert all(point.aoi is not None for point in trace.points)
    # Around solar noon a south-facing tilted surface sees a small incidence angle.
    noon = min(trace.points, key=lambda p: abs(90 - p.elevation - 0))
    assert 0 <= noon.aoi <= 180


def test_polar_summer_has_no_night() -> None:
    tromso = Site(latitude=69.65, longitude=18.96, timezone="UTC")
    result = sun_path(
        SunPathRequest(site=tromso, dates=["2023-06-21"], step_minutes=30)
    )
    assert result.traces[0].daylight_hours > 23


# --------------------------------------------------------------------------
# Transposition
# --------------------------------------------------------------------------


def _summer_day_ghi() -> tuple[list[str], list[float]]:
    times = pd.date_range("2023-06-21 00:00", "2023-06-21 23:00", freq="1h", tz="UTC")
    # A smooth bell curve peaking at solar noon; enough for a sanity check.
    ghi = [max(0.0, 950 * math.cos((h - 12) / 12 * math.pi * 0.9)) for h in range(24)]
    return [t.isoformat() for t in times], ghi


def test_tilting_towards_the_equator_gains_insolation_in_winter() -> None:
    times = pd.date_range("2023-12-21 00:00", "2023-12-21 23:00", freq="1h", tz="UTC")
    ghi = [max(0.0, 500 * math.cos((h - 12) / 12 * math.pi * 0.9)) for h in range(24)]
    stamps = [t.isoformat() for t in times]

    flat = transpose(
        TransposeRequest(
            site=MOJAVE, surface_tilt=0, surface_azimuth=180, times=stamps, ghi=ghi
        )
    )
    tilted = transpose(
        TransposeRequest(
            site=MOJAVE, surface_tilt=50, surface_azimuth=180, times=stamps, ghi=ghi
        )
    )
    assert tilted.total_kwh_m2 > flat.total_kwh_m2
    assert tilted.transposition_factor > 1.0
    # A horizontal surface receives the horizontal irradiance by definition.
    assert flat.transposition_factor == pytest.approx(1.0, abs=0.02)


def test_transposition_returns_one_value_per_timestamp() -> None:
    stamps, ghi = _summer_day_ghi()
    result = transpose(
        TransposeRequest(
            site=MOJAVE, surface_tilt=25, surface_azimuth=180, times=stamps, ghi=ghi
        )
    )
    assert len(result.poa_global) == len(stamps)
    assert all(v >= 0 for v in result.poa_global)
    assert "Erbs" in result.method.weather


def test_mismatched_series_lengths_are_rejected() -> None:
    stamps, ghi = _summer_day_ghi()
    with pytest.raises(EngineError):
        transpose(
            TransposeRequest(
                site=MOJAVE,
                surface_tilt=25,
                surface_azimuth=180,
                times=stamps,
                ghi=ghi[:-2],
            )
        )


# --------------------------------------------------------------------------
# Degradation
# --------------------------------------------------------------------------


def _monthly_series(years: float, rate_per_year: float) -> tuple[list[str], list[float]]:
    periods = int(years * 12)
    index = pd.date_range("2018-01-31", periods=periods, freq="ME", tz="UTC")
    values = [1.0 * (1 + rate_per_year / 100.0) ** (i / 12.0) for i in range(periods)]
    return [t.isoformat() for t in index], values


def test_recovers_a_known_degradation_rate() -> None:
    times, values = _monthly_series(years=6, rate_per_year=-0.5)
    result = degradation(DegradationRequest(times=times, values=values))
    assert result.rate_percent_per_year == pytest.approx(-0.5, abs=0.1)
    assert result.confidence_interval[0] <= result.rate_percent_per_year
    assert result.confidence_interval[1] >= result.rate_percent_per_year
    assert result.years_covered > 4
    assert result.sample_pairs > 12


def test_is_robust_to_a_single_outage_month() -> None:
    times, values = _monthly_series(years=6, rate_per_year=-0.5)
    # An outage halves one month's normalised yield; a median-based method
    # should barely notice, where a least-squares fit would be pulled off.
    values[20] = values[20] * 0.5
    result = degradation(DegradationRequest(times=times, values=values))
    assert result.rate_percent_per_year == pytest.approx(-0.5, abs=0.2)


def test_refuses_a_series_that_is_too_short_to_support_a_claim() -> None:
    times, values = _monthly_series(years=1.5, rate_per_year=-0.5)
    with pytest.raises(EngineError, match="at least 2"):
        degradation(DegradationRequest(times=times, values=values))


def test_refuses_mismatched_degradation_inputs() -> None:
    times, values = _monthly_series(years=6, rate_per_year=-0.5)
    with pytest.raises(EngineError):
        degradation(DegradationRequest(times=times, values=values[:-1]))
