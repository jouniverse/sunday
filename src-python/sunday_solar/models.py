"""Request and response schemas for the solar engine.

These are the contract between the frontend and pvlib. Ranges are validated
here so a mistyped tilt fails as a 422 rather than silently producing a
plausible-looking wrong number.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Site(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    #  Metres above sea level; affects air mass and therefore clear-sky irradiance.
    altitude: float = Field(0.0, ge=-500, le=9000)
    #  IANA name. UTC keeps results reproducible when the caller does not care.
    timezone: str = "UTC"


class ArraySpec(BaseModel):
    """Geometry and electrical rating of one array.

    `dc_capacity_kw` is nameplate DC at standard test conditions. Sunday's
    packing engine supplies it, so the engine never has to guess module counts.
    """

    surface_tilt: float = Field(25.0, ge=0, le=90)
    #  Degrees clockwise from north: 180 is due south.
    surface_azimuth: float = Field(180.0, ge=0, le=360)
    dc_capacity_kw: float = Field(1.0, gt=0, le=5_000_000)
    #  Power temperature coefficient, %/degC. Negative for every real module.
    gamma_pdc: float = Field(-0.004, ge=-0.01, le=0.0)
    #  DC to AC ratio; 1.2 is a common utility-scale choice.
    dc_ac_ratio: float = Field(1.2, ge=0.8, le=2.0)
    inverter_efficiency: float = Field(0.96, gt=0.5, le=1.0)
    #  Soiling, wiring, mismatch, availability. Applied on top of the pvlib run.
    system_losses: float = Field(0.14, ge=0.0, le=0.6)
    mount: Literal["fixed", "single_axis"] = "fixed"
    #  Single-axis tracker rotation limit, degrees either side of horizontal.
    max_angle: float = Field(60.0, ge=5, le=90)
    #  Backtrack to avoid row-to-row shading; requires ground coverage ratio.
    backtrack: bool = True
    ground_coverage_ratio: float = Field(0.35, gt=0.0, le=1.0)


class WeatherSource(BaseModel):
    """Where the engine gets irradiance from.

    `clearsky` is explicitly a physical upper bound, not a yield estimate: it
    ignores clouds. Callers that want a real estimate pass measured or TMY data
    through `series`, which is what the API clients supply.
    """

    kind: Literal["clearsky", "series"] = "clearsky"
    #  Only for kind="series": ISO 8601 timestamps.
    times: list[str] | None = None
    ghi: list[float] | None = None
    dni: list[float] | None = None
    dhi: list[float] | None = None
    temp_air: list[float] | None = None
    wind_speed: list[float] | None = None
    #  Only for kind="clearsky".
    year: int = Field(2023, ge=1990, le=2100)
    freq: Literal["15min", "1h"] = "1h"
    #  Constants used when a series omits meteorology.
    default_temp_air: float = Field(20.0, ge=-60, le=60)
    default_wind_speed: float = Field(1.0, ge=0, le=40)


class ModelChainRequest(BaseModel):
    site: Site
    array: ArraySpec
    weather: WeatherSource = WeatherSource()
    transposition_model: Literal["haydavies", "perez", "isotropic", "klucher"] = "haydavies"
    #  Rack thermal model; open rack runs cooler than a close roof mount.
    thermal_model: Literal[
        "open_rack_glass_polymer",
        "open_rack_glass_glass",
        "close_mount_glass_glass",
        "insulated_back_glass_polymer",
    ] = "open_rack_glass_polymer"


class MonthlyValue(BaseModel):
    month: int
    energy_kwh: float
    poa_kwh_m2: float


class MethodBlock(BaseModel):
    """Provenance for a result. The UI renders this next to the numbers."""

    engine: str
    pvlib_version: str
    solar_position: str
    transposition: str
    cell_temperature: str
    dc_model: str
    ac_model: str
    weather: str
    notes: list[str] = []


class ModelChainResponse(BaseModel):
    annual_energy_kwh: float
    #  Annual energy per kW of installed DC capacity; the comparable figure.
    specific_yield_kwh_per_kwp: float
    #  Annual AC energy over nameplate DC energy: the capacity factor.
    capacity_factor: float
    #  Plane-of-array insolation, kWh/m2/year.
    poa_annual_kwh_m2: float
    performance_ratio: float
    monthly: list[MonthlyValue]
    method: MethodBlock


class OptimalTiltRequest(BaseModel):
    site: Site
    #  Azimuths to search, degrees from north. Defaults to equator-facing.
    azimuth_min: float = Field(90.0, ge=0, le=360)
    azimuth_max: float = Field(270.0, ge=0, le=360)
    azimuth_step: float = Field(15.0, gt=0, le=90)
    tilt_min: float = Field(0.0, ge=0, le=90)
    tilt_max: float = Field(70.0, ge=0, le=90)
    tilt_step: float = Field(2.5, gt=0, le=15)
    weather: WeatherSource = WeatherSource()
    transposition_model: Literal["haydavies", "perez", "isotropic", "klucher"] = "haydavies"


class TiltCandidate(BaseModel):
    surface_tilt: float
    surface_azimuth: float
    poa_annual_kwh_m2: float
    #  Fraction of the best candidate's insolation, so the UI can draw an
    #  envelope of near-optimal choices rather than a single "correct" answer.
    relative: float


class OptimalTiltResponse(BaseModel):
    optimal: TiltCandidate
    #  Tilt range within `envelope_tolerance` of optimal at the optimal azimuth.
    envelope_tilt_min: float
    envelope_tilt_max: float
    envelope_tolerance: float
    candidates: list[TiltCandidate]
    method: MethodBlock


class SunPathRequest(BaseModel):
    site: Site
    #  Local dates to trace. Defaults to solstices and equinoxes.
    dates: list[str] | None = None
    year: int = Field(2023, ge=1990, le=2100)
    step_minutes: int = Field(10, ge=1, le=60)
    surface_tilt: float | None = Field(None, ge=0, le=90)
    surface_azimuth: float | None = Field(None, ge=0, le=360)


class SunPathPoint(BaseModel):
    time: str
    #  Refraction-corrected elevation; negative values are below the horizon.
    elevation: float
    azimuth: float
    #  Angle of incidence on the given surface, when one was supplied.
    aoi: float | None = None


class SunPathTrace(BaseModel):
    date: str
    label: str
    points: list[SunPathPoint]
    #  Sun above the horizon, in hours.
    daylight_hours: float
    max_elevation: float


class SunPathResponse(BaseModel):
    traces: list[SunPathTrace]
    method: MethodBlock


class TransposeRequest(BaseModel):
    site: Site
    surface_tilt: float = Field(..., ge=0, le=90)
    surface_azimuth: float = Field(..., ge=0, le=360)
    times: list[str]
    ghi: list[float]
    dni: list[float] | None = None
    dhi: list[float] | None = None
    model: Literal["haydavies", "perez", "isotropic", "klucher"] = "haydavies"
    #  Ground reflectance; 0.2 is the usual default, snow is much higher.
    albedo: float = Field(0.2, ge=0.0, le=1.0)


class TransposeResponse(BaseModel):
    times: list[str]
    poa_global: list[float]
    poa_direct: list[float]
    poa_diffuse: list[float]
    total_kwh_m2: float
    #  Ratio of plane-of-array to horizontal insolation: the tilt gain.
    transposition_factor: float
    method: MethodBlock


class DegradationRequest(BaseModel):
    """Year-on-year degradation from a measured energy series.

    Deliberately minimal: it reports a rate and an interval from normalised
    yield, and refuses series that are too short to support a claim.
    """

    times: list[str]
    #  Normalised performance, e.g. measured energy over modelled energy.
    values: list[float]
    confidence: float = Field(0.68, gt=0.5, lt=1.0)


class DegradationResponse(BaseModel):
    #  Percent per year; negative means the array is losing output.
    rate_percent_per_year: float
    confidence_interval: tuple[float, float]
    years_covered: float
    sample_pairs: int
    method: MethodBlock
