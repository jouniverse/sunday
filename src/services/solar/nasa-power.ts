/**
 * NASA POWER client.
 *
 * The integration review's verdict: a free, global, keyless secondary source.
 * Its value is coverage — it answers where PVGIS stops, above about 60° latitude
 * and over the oceans — and its cost is resolution: the solar parameters come from
 * a 1° grid, which is roughly 110 km. The report therefore always says which
 * grid cell answered, because a "site" report from a 1° cell is a regional
 * statement dressed as a local one.
 */

import { ApiError, query, requestJson } from "../http/client";
import { solarApiBase } from "./api-base";
import type { MonthlyValue, ResourceReport } from "./types";
import { PROVIDERS } from "./types";

/** Solar grid spacing, degrees. Used to report the answering cell honestly. */
const SOLAR_GRID_DEGREES = 1.0;

interface PowerResponse {
  properties?: {
    parameter?: Record<string, Record<string, number>>;
  };
  geometry?: { coordinates?: number[] };
  header?: {
    title?: string;
    api?: { version?: string };
    sources?: string[];
    fill_value?: number;
    start?: string | number;
    end?: string | number;
  };
  messages?: string[];
}

/** POWER's fill value for missing data. It must never enter an average. */
const FILL_VALUE = -999;

const MONTH_KEYS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

/**
 * Climatology at a point: long-term monthly and annual means.
 *
 * Parameters chosen from the review's high-value list: global, direct and diffuse
 * irradiance, air temperature, and the tilted-surface climatology that gives a
 * useful cross-check on optimal tilt.
 */
export async function fetchNasaPowerClimatology(options: {
  latitude: number;
  longitude: number;
  signal?: AbortSignal;
}): Promise<ResourceReport> {
  const provider = PROVIDERS.nasa_power;
  // SI_EF_TILTED_SURFACE is a parameter *set*: POWER expands it to
  // SI_TILTED_AVG_* keys (optimal irradiance + optimal angle among them).
  // Requesting SI_EF_OPTIMAL_ANGLE directly returns HTTP 422.
  const parameters = [
    "ALLSKY_SFC_SW_DWN", // GHI
    "ALLSKY_SFC_SW_DNI", // DNI
    "ALLSKY_SFC_SW_DIFF", // diffuse
    "T2M", // air temperature at 2 m
    "SI_EF_TILTED_SURFACE",
  ].join(",");

  const url = `${solarApiBase("nasa_power")}/climatology/point?${query({
    parameters,
    community: "re",
    latitude: options.latitude,
    longitude: options.longitude,
    format: "json",
  })}`;

  const response = await requestJson<PowerResponse>({
    provider: provider.label,
    url,
    signal: options.signal,
    // Climatology never changes; cache it for a day.
    cacheTtlMs: 24 * 60 * 60 * 1000,
  });

  const parameterData = response.properties?.parameter;
  if (!parameterData) {
    throw new ApiError({
      provider: provider.label,
      message: "NASA POWER returned no parameters for this location",
      guidance:
        (response.messages ?? []).join(" ") ||
        "Check the coordinates. POWER covers the globe, so a failure here is usually a bad request.",
    });
  }

  // POWER's daily-mean irradiance in kWh/m²/day becomes an annual sum by
  // multiplying each month's mean by that month's length.
  const ghi = annualFromDailyMeans(parameterData.ALLSKY_SFC_SW_DWN);
  const dni = annualFromDailyMeans(parameterData.ALLSKY_SFC_SW_DNI);
  const diffuse = annualFromDailyMeans(parameterData.ALLSKY_SFC_SW_DIFF);
  const tilted = annualFromDailyMeans(parameterData.SI_TILTED_AVG_OPTIMAL);
  const optimalAngle = annualMean(parameterData.SI_TILTED_AVG_OPTIMAL_ANG);

  const answeringCell = describeCell(options.latitude, options.longitude, response);

  return {
    provider: "nasa_power",
    latitude: options.latitude,
    longitude: options.longitude,
    ghiKwhM2Year: ghi ?? undefined,
    dniKwhM2Year: dni ?? undefined,
    dhiKwhM2Year: diffuse ?? undefined,
    poaKwhM2Year: tilted ?? undefined,
    optimalTiltDegrees: optimalAngle ?? undefined,
    meanAirTempC: annualMean(parameterData.T2M) ?? undefined,
    monthlyGhi: monthlySeries(parameterData.ALLSKY_SFC_SW_DWN),
    // Angles and temperatures are already monthly means — do not scale by days.
    monthlyOptimalTilt: monthlyMeans(parameterData.SI_TILTED_AVG_OPTIMAL_ANG),
    monthlyAirTempC: monthlyMeans(parameterData.T2M),
    source: provider.attribution,
    dataset: (response.header?.sources ?? []).join(", ") || provider.dataset,
    vintage: describePeriod(response),
    fidelity: "modelled",
    method:
      "NASA POWER climatology: long-term monthly means from CERES SYN1deg (solar) and " +
      "MERRA-2 (meteorology), summed to an annual total.",
    caveats: [
      `Solar parameters come from a ${SOLAR_GRID_DEGREES}° grid, about 110 km. ${answeringCell}`,
      "Use this as a global cross-check rather than a site-specific figure; PVGIS and NSRDB " +
        "are an order of magnitude finer where they have coverage.",
    ],
    requestUrl: url,
  };
}

/** Which grid cell actually answered, so the resolution claim is concrete. */
function describeCell(latitude: number, longitude: number, response: PowerResponse): string {
  const returned = response.geometry?.coordinates;
  if (Array.isArray(returned) && returned.length >= 2) {
    const [lon, lat] = returned as [number, number];
    const offsetKm = Math.round(
      Math.hypot(
        (lat - latitude) * 111,
        (lon - longitude) * 111 * Math.cos((latitude * Math.PI) / 180),
      ),
    );
    return `The value returned is for the cell centred at ${lat.toFixed(2)}°, ${lon.toFixed(2)}°, about ${offsetKm} km from the requested point.`;
  }
  return "The value applies to the whole grid cell containing this point.";
}

function describePeriod(response: PowerResponse): string | undefined {
  const { start, end } = response.header ?? {};
  if (start === undefined || end === undefined) return undefined;
  return `${start}–${end}`;
}

const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Annual total from POWER's monthly daily-mean values.
 *
 * POWER reports kWh/m²/day per month, so each month contributes
 * (daily mean × days in month). Summing the twelve monthly means directly — an
 * easy mistake — would understate the annual figure by a factor of about 30.
 */
function annualFromDailyMeans(series: Record<string, number> | undefined): number | null {
  if (!series) return null;
  let total = 0;
  let months = 0;
  MONTH_KEYS.forEach((key, index) => {
    const value = series[key];
    if (typeof value !== "number" || value <= FILL_VALUE) return;
    total += value * (DAYS_IN_MONTH[index] as number);
    months += 1;
  });
  // A partial year would be misleading, so require all twelve months.
  return months === 12 ? total : null;
}

function annualMean(series: Record<string, number> | undefined): number | null {
  if (!series) return null;
  // POWER supplies an ANN key for most parameters; prefer it when present.
  const annual = series.ANN;
  if (typeof annual === "number" && annual > FILL_VALUE) return annual;

  const values = MONTH_KEYS.map((key) => series[key]).filter(
    (value): value is number => typeof value === "number" && value > FILL_VALUE,
  );
  return values.length === 12 ? values.reduce((a, b) => a + b, 0) / 12 : null;
}

function monthlySeries(series: Record<string, number> | undefined): MonthlyValue[] | undefined {
  if (!series) return undefined;
  const values: MonthlyValue[] = [];
  MONTH_KEYS.forEach((key, index) => {
    const value = series[key];
    if (typeof value !== "number" || value <= FILL_VALUE) return;
    // Convert to a monthly total for comparability with the other providers.
    values.push({ month: index + 1, value: value * (DAYS_IN_MONTH[index] as number) });
  });
  return values.length > 0 ? values : undefined;
}

/** Monthly means as reported (tilt °, temperature °C) — no day-length scaling. */
function monthlyMeans(series: Record<string, number> | undefined): MonthlyValue[] | undefined {
  if (!series) return undefined;
  const values: MonthlyValue[] = [];
  MONTH_KEYS.forEach((key, index) => {
    const value = series[key];
    if (typeof value !== "number" || value <= FILL_VALUE) return;
    values.push({ month: index + 1, value });
  });
  return values.length > 0 ? values : undefined;
}
