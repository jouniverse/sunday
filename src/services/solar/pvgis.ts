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
import { solarApiBase } from "./api-base";
import type { MonthlyValue, ResourceReport } from "./types";
import { PROVIDERS } from "./types";

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
  return (((pvgisAzimuth + 180) % 360) + 360) % 360;
}

/**
 * Chooses a v5.3 `raddatabase` for reproducible requests.
 *
 * PVGIS auto-picks when omitted, but high latitudes and ocean edges are clearer
 * when we ask for ERA5 explicitly. SARAH3 covers Europe, Africa, the Middle East
 * and parts of South America; elsewhere ERA5 is the global reanalysis fallback.
 */
export function pvgisRadiationDatabase(
  latitude: number,
  _longitude: number,
): "PVGIS-SARAH3" | "PVGIS-ERA5" {
  if (Math.abs(latitude) >= 60) return "PVGIS-ERA5";
  const lon = _longitude;
  const inSarah =
    (lon >= -25 && lon <= 65 && latitude > -40 && latitude < 65) ||
    (lon >= -80 && lon <= -30 && latitude >= -40 && latitude <= 15);
  return inSarah ? "PVGIS-SARAH3" : "PVGIS-ERA5";
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

interface MrcalcMonth {
  /** Present when MRcalc returns the full multi-year series (default). */
  year?: number;
  month: number;
  "H(h)_m"?: number;
  "Hb(n)_m"?: number;
  "Hd(h)_m"?: number;
  T2m?: number;
}

interface MrcalcResponse {
  outputs?: {
    monthly?: MrcalcMonth[];
  };
  meta?: { inputs?: { meteo_data?: { radiation_db?: string } } };
}

/**
 * Collapses MRcalc's multi-year monthly series into a 12-month climatology.
 *
 * Without startyear/endyear, PVGIS MRcalc returns every month in the database
 * period (e.g. 2005–2023 → 228 rows). Charting that raw series draws the
 * seasonal cycle once per year. Annual totals must also use monthly means,
 * not the sum of every year in the archive.
 */
export function climatologyFromMrcalc(monthly: MrcalcMonth[]): {
  monthlyGhi: MonthlyValue[];
  ghiKwhM2Year: number;
  dniKwhM2Year: number | undefined;
  dhiKwhM2Year: number | undefined;
  meanAirTempC: number | undefined;
  yearMin: number | undefined;
  yearMax: number | undefined;
  sampleYears: number;
} {
  const years = monthly
    .map((entry) => entry.year)
    .filter((year): year is number => typeof year === "number");
  const yearMin = years.length > 0 ? Math.min(...years) : undefined;
  const yearMax = years.length > 0 ? Math.max(...years) : undefined;
  const sampleYears =
    yearMin !== undefined && yearMax !== undefined ? yearMax - yearMin + 1 : 1;

  const meanForMonth = (
    month: number,
    key: "H(h)_m" | "Hb(n)_m" | "Hd(h)_m" | "T2m",
  ): number | undefined => {
    const values = monthly
      .filter((entry) => entry.month === month)
      .map((entry) => entry[key])
      .filter((value): value is number => typeof value === "number");
    if (values.length === 0) return undefined;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  const monthlyGhi: MonthlyValue[] = [];
  let ghiKwhM2Year = 0;
  let dniYear = 0;
  let dhiYear = 0;
  let hasDni = false;
  let hasDhi = false;
  const temperatures: number[] = [];

  for (let month = 1; month <= 12; month += 1) {
    const ghi = meanForMonth(month, "H(h)_m");
    if (ghi !== undefined) {
      monthlyGhi.push({ month, value: ghi });
      ghiKwhM2Year += ghi;
    }
    const dni = meanForMonth(month, "Hb(n)_m");
    if (dni !== undefined) {
      dniYear += dni;
      hasDni = true;
    }
    const dhi = meanForMonth(month, "Hd(h)_m");
    if (dhi !== undefined) {
      dhiYear += dhi;
      hasDhi = true;
    }
    const temp = meanForMonth(month, "T2m");
    if (temp !== undefined) temperatures.push(temp);
  }

  return {
    monthlyGhi,
    ghiKwhM2Year,
    dniKwhM2Year: hasDni ? dniYear : undefined,
    dhiKwhM2Year: hasDhi ? dhiYear : undefined,
    meanAirTempC:
      temperatures.length > 0
        ? temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length
        : undefined,
    yearMin,
    yearMax,
    sampleYears,
  };
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
    raddatabase: pvgisRadiationDatabase(options.latitude, options.longitude),
  };

  if (options.optimise) {
    // Let PVGIS search both angles; it reports what it chose in `inputs`.
    params.optimalangles = 1;
  } else {
    params.angle = options.tiltDegrees ?? 30;
    params.aspect = toPvgisAzimuth(options.azimuthDegrees ?? 180);
  }

  const url = `${solarApiBase("pvgis")}/PVcalc?${query(params)}`;
  let response: PvcalcResponse & { message?: string };
  try {
    response = await requestJson<PvcalcResponse & { message?: string }>({
      provider: provider.label,
      url,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError({
        provider: error.provider,
        status: error.status,
        message: `${error.message} (request: ${url})`,
        guidance: error.guidance,
        retryable: error.retryable,
      });
    }
    throw error;
  }

  if (typeof response.message === "string" && response.message && !response.outputs?.totals) {
    throw new ApiError({
      provider: provider.label,
      message: `PVGIS: ${response.message}`,
      guidance:
        "Check latitude/longitude and radiation database (SARAH3 vs ERA5). " +
        `Request: ${url}`,
    });
  }

  const totals = response.outputs?.totals?.fixed;
  if (!totals || typeof totals.E_y !== "number") {
    throw new ApiError({
      provider: provider.label,
      message: `PVGIS returned no annual total for this location (request: ${url})`,
      guidance:
        "PVGIS satellite coverage stops near 60–65° latitude and excludes some ocean areas. " +
        "Try NASA POWER, which is global, or force ERA5 via a high-latitude site.",
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
  const radiationDb = meteo?.radiation_db;
  if (radiationDb) {
    caveats.push(`Radiation database: ${radiationDb}.`);
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
    dataset: radiationDb ?? provider.dataset,
    vintage: meteo?.year_min && meteo?.year_max ? `${meteo.year_min}–${meteo.year_max}` : undefined,
    fidelity: "modelled",
    method:
      "PVGIS grid-connected PV model over satellite-derived irradiance, with the reported " +
      `system loss of ${options.lossesPercent ?? 14}%` +
      (radiationDb ? ` (${radiationDb})` : "") +
      ".",
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
  const raddatabase = pvgisRadiationDatabase(options.latitude, options.longitude);
  const url = `${solarApiBase("pvgis")}/MRcalc?${query({
    lat: options.latitude,
    lon: options.longitude,
    horirrad: 1,
    // Postman / PVGIS v5 flag for DNI (maps to Hb(n)_m in the JSON response).
    mr_dni: 1,
    d2g: 1,
    avtemp: 1,
    outputformat: "json",
    raddatabase,
  })}`;

  let response: MrcalcResponse & { message?: string; status?: number };
  try {
    response = await requestJson<MrcalcResponse & { message?: string; status?: number }>({
      provider: provider.label,
      url,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError({
        provider: error.provider,
        status: error.status,
        message: `${error.message} (request: ${url})`,
        guidance: error.guidance,
        retryable: error.retryable,
      });
    }
    throw error;
  }

  if (typeof response.message === "string" && response.message && !response.outputs?.monthly) {
    throw new ApiError({
      provider: provider.label,
      message: `PVGIS: ${response.message}`,
      guidance:
        "Try the other radiation database, or NASA POWER for global coverage. " +
        `Request: ${url}`,
    });
  }

  const monthly = response.outputs?.monthly ?? [];
  if (monthly.length === 0) {
    throw new ApiError({
      provider: provider.label,
      message: `PVGIS returned no monthly radiation for this location (request: ${url})`,
      guidance: "The location is probably outside PVGIS coverage. NASA POWER is global.",
    });
  }

  const climate = climatologyFromMrcalc(monthly);
  const dataset = response.meta?.inputs?.meteo_data?.radiation_db ?? raddatabase;
  const period =
    climate.yearMin !== undefined && climate.yearMax !== undefined
      ? `${climate.yearMin}–${climate.yearMax}`
      : "the database period";

  return {
    provider: "pvgis",
    latitude: options.latitude,
    longitude: options.longitude,
    ghiKwhM2Year: climate.ghiKwhM2Year,
    dniKwhM2Year: climate.dniKwhM2Year,
    dhiKwhM2Year: climate.dhiKwhM2Year,
    meanAirTempC: climate.meanAirTempC,
    monthlyGhi: climate.monthlyGhi,
    source: provider.attribution,
    dataset,
    fidelity: "modelled",
    method: `PVGIS MRcalc monthly radiation (${dataset}): calendar-month means over ${period} (${climate.sampleYears} year${climate.sampleYears === 1 ? "" : "s"}).`,
    caveats: [
      `Spatial resolution is ${provider.resolution}, so this is an area average.`,
      `Requested radiation database: ${raddatabase}.`,
      monthly.length > 12
        ? `MRcalc returned ${monthly.length} monthly rows; Sunday averages them to a 12-month climatology for the chart and annual totals.`
        : `Radiation database period: ${period}.`,
    ],
    requestUrl: url,
  };
}
