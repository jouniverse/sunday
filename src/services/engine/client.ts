/**
 * Typed client for the pvlib sidecar.
 *
 * Mirrors `src-python/sunday_solar/models.py`. Every call has a documented
 * fallback in `src/domain`, so a missing engine degrades the fidelity of an
 * answer rather than removing the feature.
 */

import { platform } from "@/core/platform";
import { PlatformError } from "@/core/platform";

export interface EngineSite {
  latitude: number;
  longitude: number;
  altitude?: number;
  timezone?: string;
}

export interface EngineArray {
  surface_tilt: number;
  surface_azimuth: number;
  dc_capacity_kw: number;
  gamma_pdc?: number;
  dc_ac_ratio?: number;
  inverter_efficiency?: number;
  system_losses?: number;
  mount?: "fixed" | "single_axis";
  max_angle?: number;
  backtrack?: boolean;
  ground_coverage_ratio?: number;
}

export interface EngineWeather {
  kind: "clearsky" | "series";
  times?: string[];
  ghi?: number[];
  dni?: number[];
  dhi?: number[];
  temp_air?: number[];
  wind_speed?: number[];
  year?: number;
  freq?: "15min" | "1h";
  default_temp_air?: number;
  default_wind_speed?: number;
}

export interface EngineMethod {
  engine: string;
  pvlib_version: string;
  solar_position: string;
  transposition: string;
  cell_temperature: string;
  dc_model: string;
  ac_model: string;
  weather: string;
  notes: string[];
}

export interface ModelChainResult {
  annual_energy_kwh: number;
  specific_yield_kwh_per_kwp: number;
  capacity_factor: number;
  poa_annual_kwh_m2: number;
  performance_ratio: number;
  monthly: Array<{ month: number; energy_kwh: number; poa_kwh_m2: number }>;
  method: EngineMethod;
}

export interface OptimalTiltResult {
  optimal: { surface_tilt: number; surface_azimuth: number; poa_annual_kwh_m2: number; relative: number };
  envelope_tilt_min: number;
  envelope_tilt_max: number;
  envelope_tolerance: number;
  candidates: Array<{
    surface_tilt: number;
    surface_azimuth: number;
    poa_annual_kwh_m2: number;
    relative: number;
  }>;
  method: EngineMethod;
}

export interface SunPathResult {
  traces: Array<{
    date: string;
    label: string;
    daylight_hours: number;
    max_elevation: number;
    points: Array<{ time: string; elevation: number; azimuth: number; aoi: number | null }>;
  }>;
  method: EngineMethod;
}

export interface TransposeResult {
  times: string[];
  poa_global: number[];
  poa_direct: number[];
  poa_diffuse: number[];
  total_kwh_m2: number;
  transposition_factor: number;
  method: EngineMethod;
}

export interface DegradationResult {
  rate_percent_per_year: number;
  confidence_interval: [number, number];
  years_covered: number;
  sample_pairs: number;
  method: EngineMethod;
}

/** Thrown when the engine is absent or refuses a request. */
export class EngineUnavailable extends Error {
  readonly guidance: string;

  constructor(message: string, guidance: string) {
    super(message);
    this.name = "EngineUnavailable";
    this.guidance = guidance;
  }
}

async function call<TRequest, TResponse>(endpoint: string, body: TRequest): Promise<TResponse> {
  try {
    return await platform().engine.call<TRequest, TResponse>(endpoint, body);
  } catch (error) {
    if (error instanceof PlatformError) {
      throw new EngineUnavailable(
        error.message,
        "Sunday will fall back to a labelled first-order estimate. Start the solar engine to " +
          "get a pvlib-modelled result.",
      );
    }
    throw error;
  }
}

export function runModelChain(request: {
  site: EngineSite;
  array: EngineArray;
  weather?: EngineWeather;
  transposition_model?: "haydavies" | "perez" | "isotropic" | "klucher";
  thermal_model?: string;
}): Promise<ModelChainResult> {
  return call("/model-chain", request);
}

export function findOptimalTilt(request: {
  site: EngineSite;
  azimuth_min?: number;
  azimuth_max?: number;
  azimuth_step?: number;
  tilt_min?: number;
  tilt_max?: number;
  tilt_step?: number;
  weather?: EngineWeather;
}): Promise<OptimalTiltResult> {
  return call("/optimal-tilt", request);
}

export function fetchSunPath(request: {
  site: EngineSite;
  dates?: string[];
  year?: number;
  step_minutes?: number;
  surface_tilt?: number;
  surface_azimuth?: number;
}): Promise<SunPathResult> {
  return call("/sun-path", request);
}

export function transpose(request: {
  site: EngineSite;
  surface_tilt: number;
  surface_azimuth: number;
  times: string[];
  ghi: number[];
  dni?: number[];
  dhi?: number[];
  model?: "haydavies" | "perez" | "isotropic" | "klucher";
  albedo?: number;
}): Promise<TransposeResult> {
  return call("/transpose", request);
}

export function estimateDegradation(request: {
  times: string[];
  values: number[];
  confidence?: number;
}): Promise<DegradationResult> {
  return call("/degradation", request);
}

/**
 * Runs a model chain, falling back to the local first-order estimate.
 *
 * The single most important property: the caller can always render a number, and
 * the returned `fidelity` says which kind it got. No silent substitution.
 */
export async function modelledOrFirstOrder(options: {
  site: EngineSite;
  array: EngineArray;
  weather?: EngineWeather;
  /** Annual GHI for the fallback path, kWh/m²/year. */
  fallbackGhiKwhM2Year: number;
  meanAmbientTempC?: number;
}): Promise<{
  annualKwh: number;
  specificYieldKwhPerKwp: number;
  capacityFactor: number;
  performanceRatio: number;
  monthly?: Array<{ month: number; energy_kwh: number }>;
  fidelity: "modelled" | "first_order";
  method: string;
  caveats: string[];
}> {
  try {
    const result = await runModelChain({
      site: options.site,
      array: options.array,
      weather: options.weather,
    });
    return {
      annualKwh: result.annual_energy_kwh,
      specificYieldKwhPerKwp: result.specific_yield_kwh_per_kwp,
      capacityFactor: result.capacity_factor,
      performanceRatio: result.performance_ratio,
      monthly: result.monthly,
      fidelity: "modelled",
      method: `pvlib ${result.method.pvlib_version}: ${result.method.transposition} transposition, ${result.method.cell_temperature}, ${result.method.dc_model}.`,
      caveats: result.method.notes,
    };
  } catch (error) {
    if (!(error instanceof EngineUnavailable)) throw error;

    const { estimateAnnualYield } = await import("@/domain/pv/yield");
    const estimate = estimateAnnualYield({
      ghiKwhM2Year: options.fallbackGhiKwhM2Year,
      capacityKwDc: options.array.dc_capacity_kw,
      surfaceTiltDegrees: options.array.surface_tilt,
      surfaceAzimuthDegrees: options.array.surface_azimuth,
      latitude: options.site.latitude,
      meanAmbientTempC: options.meanAmbientTempC,
      gammaPdc: options.array.gamma_pdc,
      systemLosses: options.array.system_losses,
    });

    return {
      annualKwh: estimate.annualKwh,
      specificYieldKwhPerKwp: estimate.specificYieldKwhPerKwp,
      capacityFactor: estimate.capacityFactor,
      performanceRatio: estimate.breakdown.performanceRatio,
      fidelity: "first_order",
      method: estimate.method,
      caveats: [...estimate.caveats, error.guidance],
    };
  }
}
