/**
 * Typed client for CSP sidecar routes (`/csp/*`).
 *
 * PV ModelChain is unchanged in `client.ts`. Missing PySAM is a labelled
 * reduced-capability state — never a fake annual energy figure.
 */

import { platform } from "@/core/platform";
import { EngineUnavailable } from "./client";

export interface CspTowerLayoutRequest {
  latitude: number;
  longitude: number;
  h_tower: number;
  q_design: number;
  helio_width: number;
  helio_height: number;
  dni_des?: number;
  layout_method: "radial_stagger" | "cornfield";
}

export interface CspTowerLayoutResult {
  heliostat_positions: Array<[number, number] | number[]>;
  number_heliostats: number;
  area_sf: number;
  land_area: number;
  optical_efficiency?: number | null;
  h_tower_opt?: number | null;
  method: string;
}

export interface CspPlantRequest {
  latitude: number;
  longitude: number;
  rated_mwe: number;
  solar_multiple: number;
  tes_hours: number;
  cooling: "wet" | "dry" | "hybrid";
  h_tower?: number;
  helio_width?: number;
  helio_height?: number;
  row_pitch_m?: number;
  row_azimuth_degrees?: number;
  aperture_m?: number;
}

export interface CspPlantResult {
  annual_energy_kwh: number;
  capacity_factor: number;
  water_use_m3?: number | null;
  lcoe_usd_per_kwh?: number | null;
  lcoe_method?: string | null;
  total_installed_cost_usd?: number | null;
  method: string;
}

async function callCsp<TRequest, TResponse>(endpoint: string, body: TRequest): Promise<TResponse> {
  try {
    return await platform().engine.call<TRequest, TResponse>(endpoint, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /not installed|nrel-pysam|nlr-pysam/i.test(message);
    throw new EngineUnavailable(
      message,
      missing
        ? "From src-python run `pip install nlr-pysam` or `npm run engine:csp`, then restart the solar engine. CSP yield is not estimated without PySAM."
        : "The live schematic is still a labelled sketch. Annual energy stays blank until the plant run succeeds. If the status bar still says the engine is live, wait a moment — a native SSC crash is isolated and should not kill the sidecar.",
    );
  }
}

export function runTowerLayout(request: CspTowerLayoutRequest): Promise<CspTowerLayoutResult> {
  return callCsp("/csp/tower/layout", request);
}

export function runTowerPlant(request: CspPlantRequest): Promise<CspPlantResult> {
  return callCsp<CspPlantRequest, Record<string, unknown>>("/csp/tower/plant", request).then(
    normalizePlantResult,
  );
}

export function runTroughPlant(request: CspPlantRequest): Promise<CspPlantResult> {
  return callCsp<CspPlantRequest, Record<string, unknown>>("/csp/trough/plant", request).then(
    normalizePlantResult,
  );
}

function normalizePlantResult(raw: Record<string, unknown>): CspPlantResult {
  const annual = Number(raw.annual_energy_kwh ?? raw.annualEnergyKwh);
  const cf = Number(raw.capacity_factor ?? raw.capacityFactor);
  const method = typeof raw.method === "string" ? raw.method : "";
  if (!Number.isFinite(annual) || annual <= 0) {
    throw new EngineUnavailable(
      "CSP plant returned no usable annual energy.",
      method
        ? `${method} Restart the solar engine after a sidecar update, then estimate again.`
        : "Restart the solar engine after a sidecar update, then estimate again.",
    );
  }
  const water = raw.water_use_m3 ?? raw.waterUseM3;
  const lcoeRaw = Number(raw.lcoe_usd_per_kwh ?? raw.lcoeUsdPerKwh);
  const lcoeMethod = typeof raw.lcoe_method === "string" ? raw.lcoe_method : null;
  const iccRaw = Number(raw.total_installed_cost_usd ?? raw.totalInstalledCostUsd);
  return {
    annual_energy_kwh: annual,
    capacity_factor: Number.isFinite(cf) ? cf : Number.NaN,
    water_use_m3: typeof water === "number" ? water : null,
    lcoe_usd_per_kwh: Number.isFinite(lcoeRaw) && lcoeRaw > 0 ? lcoeRaw : null,
    lcoe_method: lcoeMethod,
    total_installed_cost_usd: Number.isFinite(iccRaw) && iccRaw > 0 ? iccRaw : null,
    method,
  };
}
