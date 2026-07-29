/**
 * NREL client: solar resource and PVWatts v8.
 *
 * US-focused and key-gated. Where it has coverage it is the highest-fidelity
 * free source available, because NSRDB is a 4 km satellite product validated
 * against ground stations. Outside the Americas it returns nothing, and the
 * client says so rather than returning zeros.
 */

import { ApiError, query, requestJson } from "../http/client";
import type { MonthlyValue, ResourceReport } from "./types";
import { PROVIDERS } from "./types";

const BASE = "https://developer.nrel.gov/api";

interface SolarResourceResponse {
  errors?: string[];
  warnings?: string[];
  outputs?: {
    avg_dni?: { annual?: number; monthly?: Record<string, number> };
    avg_ghi?: { annual?: number; monthly?: Record<string, number> };
    avg_lat_tilt?: { annual?: number; monthly?: Record<string, number> };
  };
}

interface PvWattsResponse {
  errors?: string[];
  warnings?: string[];
  station_info?: { location?: string; distance?: number; solar_resource_file?: string };
  outputs?: {
    ac_annual?: number;
    solrad_annual?: number;
    capacity_factor?: number;
    ac_monthly?: number[];
    solrad_monthly?: number[];
    poa_monthly?: number[];
  };
  version?: string;
}

const MONTH_KEYS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

/**
 * Long-term average resource: GHI, DNI and latitude-tilt irradiation.
 *
 * NREL reports these as daily means in kWh/m²/day, so they are scaled to annual
 * totals here to match the other providers.
 */
export async function fetchNrelResource(options: {
  latitude: number;
  longitude: number;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<ResourceReport> {
  const provider = PROVIDERS.nrel;
  const url = `${BASE}/solar/solar_resource/v1.json?${query({
    api_key: options.apiKey,
    lat: options.latitude,
    lon: options.longitude,
  })}`;

  const response = await requestJson<SolarResourceResponse>({
    provider: provider.label,
    url,
    signal: options.signal,
    cacheTtlMs: 24 * 60 * 60 * 1000,
  });

  if (response.errors?.length) {
    throw new ApiError({
      provider: provider.label,
      message: response.errors.join(" "),
      guidance:
        "NREL's solar resource dataset covers the Americas. Outside that, use PVGIS or NASA POWER.",
    });
  }

  const ghiDaily = response.outputs?.avg_ghi?.annual;
  const dniDaily = response.outputs?.avg_dni?.annual;
  const tiltDaily = response.outputs?.avg_lat_tilt?.annual;

  if (typeof ghiDaily !== "number") {
    throw new ApiError({
      provider: provider.label,
      message: "NREL returned no annual irradiation for this location",
      guidance: "This location is probably outside NSRDB coverage. PVGIS and NASA POWER are global.",
    });
  }

  return {
    provider: "nrel",
    latitude: options.latitude,
    longitude: options.longitude,
    // Daily means to annual totals.
    ghiKwhM2Year: ghiDaily * 365.25,
    dniKwhM2Year: typeof dniDaily === "number" ? dniDaily * 365.25 : undefined,
    poaKwhM2Year: typeof tiltDaily === "number" ? tiltDaily * 365.25 : undefined,
    monthlyGhi: monthlyFromDailyMeans(response.outputs?.avg_ghi?.monthly),
    source: provider.attribution,
    dataset: provider.dataset,
    fidelity: "measured",
    method:
      "NREL solar resource: long-term monthly and annual averages from the National Solar " +
      "Radiation Database, scaled from daily means to annual totals.",
    caveats: [
      `Spatial resolution is ${provider.resolution}.`,
      ...(response.warnings ?? []),
    ],
    requestUrl: redactKey(url),
  };
}

/** PVWatts v8 modelled system performance. */
export async function fetchPvWatts(options: {
  latitude: number;
  longitude: number;
  apiKey: string;
  capacityKwDc?: number;
  tiltDegrees?: number;
  /** Degrees clockwise from north; PVWatts uses the same convention. */
  azimuthDegrees?: number;
  /** System losses in percent. */
  lossesPercent?: number;
  /** 0 fixed open rack, 1 fixed roof mount, 2 single axis, 4 dual axis. */
  arrayType?: 0 | 1 | 2 | 4;
  moduleType?: 0 | 1 | 2;
  dcAcRatio?: number;
  groundCoverageRatio?: number;
  signal?: AbortSignal;
}): Promise<ResourceReport> {
  const provider = PROVIDERS.nrel;
  const capacityKwDc = options.capacityKwDc ?? 1;

  const url = `${BASE}/pvwatts/v8.json?${query({
    api_key: options.apiKey,
    lat: options.latitude,
    lon: options.longitude,
    system_capacity: capacityKwDc,
    azimuth: options.azimuthDegrees ?? 180,
    tilt: options.tiltDegrees ?? 20,
    array_type: options.arrayType ?? 0,
    module_type: options.moduleType ?? 0,
    losses: options.lossesPercent ?? 14,
    dc_ac_ratio: options.dcAcRatio ?? 1.2,
    gcr: options.groundCoverageRatio ?? 0.4,
    timeframe: "monthly",
  })}`;

  const response = await requestJson<PvWattsResponse>({
    provider: provider.label,
    url,
    signal: options.signal,
  });

  if (response.errors?.length) {
    throw new ApiError({
      provider: provider.label,
      message: response.errors.join(" "),
      guidance:
        "PVWatts needs a valid key and a location inside its weather coverage. Check the key in Settings.",
    });
  }

  const annual = response.outputs?.ac_annual;
  if (typeof annual !== "number") {
    throw new ApiError({
      provider: provider.label,
      message: "PVWatts returned no annual energy",
      guidance: "The location is probably outside PVWatts weather coverage.",
    });
  }

  const monthlyYield: MonthlyValue[] = (response.outputs?.ac_monthly ?? []).map((value, index) => ({
    month: index + 1,
    value,
  }));

  const caveats: string[] = [...(response.warnings ?? [])];
  const station = response.station_info;
  if (station?.location && typeof station.distance === "number") {
    // Distance to the weather station is the honest measure of locality here.
    caveats.push(
      `Weather from ${station.location}, ${(station.distance / 1000).toFixed(1)} km from the requested point.`,
    );
  }

  return {
    provider: "nrel",
    latitude: options.latitude,
    longitude: options.longitude,
    poaKwhM2Year:
      typeof response.outputs?.solrad_annual === "number"
        ? response.outputs.solrad_annual * 365.25
        : undefined,
    specificYieldKwhPerKwp: annual / capacityKwDc,
    monthlyYield,
    source: provider.attribution,
    dataset: station?.solar_resource_file ?? provider.dataset,
    fidelity: "modelled",
    method: `NREL PVWatts ${response.version ?? "v8"} with the reported array type and loss assumptions.`,
    caveats,
    requestUrl: redactKey(url),
  };
}

function monthlyFromDailyMeans(
  monthly: Record<string, number> | undefined,
): MonthlyValue[] | undefined {
  if (!monthly) return undefined;
  const days = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const values = MONTH_KEYS.map((key, index) => {
    const value = monthly[key];
    return typeof value === "number"
      ? { month: index + 1, value: value * (days[index] as number) }
      : null;
  }).filter((entry): entry is MonthlyValue => entry !== null);
  return values.length > 0 ? values : undefined;
}

/**
 * Strips the key from a URL before it is stored in a report.
 *
 * Reports get exported and shared. A live API key inside an exported PDF is a
 * credential leak, so the recorded request URL never contains one.
 */
export function redactKey(url: string): string {
  return url.replace(/api_key=[^&]+/, "api_key=REDACTED");
}
