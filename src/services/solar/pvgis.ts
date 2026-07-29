/**
 * PVGIS client (JRC, European Commission).
 *
 * PVGIS is the workhorse: global, free, no key, and it returns both the resource
 * and a modelled PV yield. Two quirks were documented in the reference-app review
 * and are handled here:
 *
 * 1. `outputformat=json` returns a nested structure whose keys differ between
 *    endpoints, so parsing is per-endpoint rather than generic.
 * 2. Coverage stops around 60-65 degrees latitude for the satellite databases; a
 *    request outside it fails with a message worth passing through verbatim.
 */

import { ApiError, query, requestJson } from "../http/client";
import type { MonthlyValue, ResourceReport } from "./types";
import { PROVIDERS } from "./types";

const BASE = "https://re.jrc.ec.europa.eu/api/v5_3";

export interface PvgisOptions {
  latitude: number;
  longitude: number;
  /** Installed peak power, kW. PVGIS scales its yield to this. */
  peakPowerKw?: number;
  /** System losses in percent, PVGIS's own convention. */
  lossesPercent?: number;
  /** Fixed tilt in degrees; omit with `optimise` to let PVGIS choose. */
  tiltDegrees?: number;
  /** PVGIS azimuth: 0 is south, negative east, positive west. */
  azimuthDegrees?: number;
  /** Ask PVGIS for the optimal tilt and azimuth. */
  optimise?: boolean;
  /** Mounting: free-standing racks or building-integrated. */
  mounting?: "free" | "building";
  signal?: AbortSignal;
}

/**
 * Converts Sunday's azimuth convention (degrees clockwise from north, 180 south)
 * to PVGIS's (0 south, negative east, positive west).
 *
 * This conversion is exactly the kind of thing that silently produced wrong
 * numbers in the earlier reference apps, so it is a named function with tests.
 */
export function toPvgisAzimuth(azimuthFromNorth: number): number {
  const normalised = ((azimuthFromNorth % 360) + 360) % 360;
  const fromSouth = normalised - 180;
  // Wrap into (-180, 180].
  if (fromSouth > 180) return fromSouth - 360;
  if (fromSouth <= -180) return fromSouth + 360;
  return fromSouth;
}

/** The inverse, for reading PVGIS's optimal azimuth back. */
export function fromPvgisAzimuth(pvgisAzimuth: number): number {
  return ((pvgisAzimuth + 180) % 360 + 360) % 360;
}

interface PvcalcResponse {
  inputs?: {
    mounting_system?: {
      fixed?: { slope?: { value?: number }; azimuth?: { value?: number } };
    };
    meteo_data?: { radiation_db?: string; year_min?: number; year_max?: number };
  };
  outputs?: {
    monthly?: { fixed?: Array<{ month: number; E_m?: number; "H(i)_m"?: number }> };
    totals?: {
      fixed?: {
        E_y?: number;
        "H(i)_y"?: number;
        SD_y?: number;
        l_total?: number;
      };
    };
  };
}

interface MrcalcResponse {
  outputs?: {
    monthly?: Array<{
      month: number;
      "H(h)_m"?: number;
      "Hb(n)_m"?: number;
      "Hd(h)_m"?: number;
      T2m?: number;
    }>;
  };
  meta?: { inputs?: { meteo_data?: { radiation_db?: string } } };
}

/**
 * Grid-connected PV performance: annual and monthly energy plus in-plane
 * irradiation, optionally with PVGIS's own tilt optimisation.
 */
export async function fetchPvgisPerformance(options: PvgisOptions): Promise<ResourceReport> {
  const provider = PROVIDERS.pvgis;
  const peakPowerKw = options.peakPowerKw ?? 1;
  const params: Record<string, string | number | boolean | undefined> = {
    lat: options.latitude,
    lon: options.longitude,
    peakpower: peakPowerKw,
    loss: options.lossesPercent ?? 14,
    pvtechchoice: "crystSi",
    mountingplace: options.mounting === "building" ? "building" : "free",
    outputformat: "json",
  };

  if (options.optimise) {
    // Let PVGIS search both angles; it reports what it chose in `inputs`.
    params.optimalangles = 1;
  } else {
    params.angle = options.tiltDegrees ?? 30;
    params.aspect = toPvgisAzimuth(options.azimuthDegrees ?? 180);
  }

  const url = `${BASE}/PVcalc?${query(params)}`;
  const response = await requestJson<PvcalcResponse>({
    provider: provider.label,
    url,
    signal: options.signal,
  });

  const totals = response.outputs?.totals?.fixed;
  if (!totals || typeof totals.E_y !== "number") {
    throw new ApiError({
      provider: provider.label,
      message: "PVGIS returned no annual total for this location",
      guidance:
        "PVGIS satellite coverage stops near 60–65° latitude and excludes some ocean areas. " +
        "Try NASA POWER, which is global.",
    });
  }

  const fixed = response.inputs?.mounting_system?.fixed;
  const meteo = response.inputs?.meteo_data;

  const monthlyYield: MonthlyValue[] = (response.outputs?.monthly?.fixed ?? [])
    .filter((entry) => typeof entry.E_m === "number")
    .map((entry) => ({ month: entry.month, value: entry.E_m as number }));

  const caveats: string[] = [];
  if (typeof totals.SD_y === "number" && totals.E_y > 0) {
    // Interannual variability is real information a single number hides.
    caveats.push(
      `Year-to-year variability is ±${((totals.SD_y / totals.E_y) * 100).toFixed(1)}% ` +
        "(one standard deviation across the database's years).",
    );
  }
  if (options.optimise) {
    caveats.push("Tilt and azimuth were optimised by PVGIS for maximum annual yield.");
  }

  return {
    provider: "pvgis",
    latitude: options.latitude,
    longitude: options.longitude,
    poaKwhM2Year: totals["H(i)_y"],
    optimalTiltDegrees: options.optimise ? fixed?.slope?.value : undefined,
    optimalAzimuthDegrees:
      options.optimise && typeof fixed?.azimuth?.value === "number"
        ? fromPvgisAzimuth(fixed.azimuth.value)
        : undefined,
    specificYieldKwhPerKwp: totals.E_y / peakPowerKw,
    monthlyYield,
    source: provider.attribution,
    dataset: meteo?.radiation_db ?? provider.dataset,
    vintage:
      meteo?.year_min && meteo?.year_max ? `${meteo.year_min}–${meteo.year_max}` : undefined,
    fidelity: "modelled",
    method:
      "PVGIS grid-connected PV model over satellite-derived irradiance, with the reported " +
      `system loss of ${options.lossesPercent ?? 14}%.`,
    caveats,
    requestUrl: url,
  };
}

/**
 * Monthly radiation: GHI, DNI, diffuse and air temperature.
 *
 * Fetched separately from the performance call because PVGIS splits them across
 * endpoints, and because the resource is meaningful without a system attached.
 */
export async function fetchPvgisRadiation(options: {
  latitude: number;
  longitude: number;
  signal?: AbortSignal;
}): Promise<ResourceReport> {
  const provider = PROVIDERS.pvgis;
  const url = `${BASE}/MRcalc?${query({
    lat: options.latitude,
    lon: options.longitude,
    horirrad: 1,
    d2g: 1,
    avtemp: 1,
    outputformat: "json",
  })}`;

  const response = await requestJson<MrcalcResponse>({
    provider: provider.label,
    url,
    signal: options.signal,
  });

  const monthly = response.outputs?.monthly ?? [];
  if (monthly.length === 0) {
    throw new ApiError({
      provider: provider.label,
      message: "PVGIS returned no monthly radiation for this location",
      guidance: "The location is probably outside PVGIS coverage. NASA POWER is global.",
    });
  }

  // MRcalc reports monthly sums; averaging across years is already done upstream.
  const sum = (key: "H(h)_m" | "Hb(n)_m" | "Hd(h)_m") =>
    monthly.reduce((total, entry) => total + (entry[key] ?? 0), 0);

  const temperatures = monthly
    .map((entry) => entry.T2m)
    .filter((value): value is number => typeof value === "number");

  return {
    provider: "pvgis",
    latitude: options.latitude,
    longitude: options.longitude,
    ghiKwhM2Year: sum("H(h)_m"),
    dniKwhM2Year: sum("Hb(n)_m") || undefined,
    dhiKwhM2Year: sum("Hd(h)_m") || undefined,
    meanAirTempC:
      temperatures.length > 0
        ? temperatures.reduce((a, b) => a + b, 0) / temperatures.length
        : undefined,
    monthlyGhi: monthly
      .filter((entry) => typeof entry["H(h)_m"] === "number")
      .map((entry) => ({ month: entry.month, value: entry["H(h)_m"] as number })),
    source: provider.attribution,
    dataset: response.meta?.inputs?.meteo_data?.radiation_db ?? provider.dataset,
    fidelity: "modelled",
    method: "PVGIS monthly radiation, averaged over the database's full period.",
    caveats: [`Spatial resolution is ${provider.resolution}, so this is an area average.`],
    requestUrl: url,
  };
}
