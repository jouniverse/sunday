/**
 * Units, conversions and formatting.
 *
 * The rule in this codebase is that a quantity's unit lives in its identifier
 * (`areaM2`, `capacityKwDc`, `annualKwh`). This module holds the conversions and
 * the display formatting so no feature invents its own rounding.
 */

/* --- Constants ------------------------------------------------------------ */

/** Mean Earth radius, IUGG. Used for geodesic distance. */
export const EARTH_RADIUS_M = 6_371_008.8;

/** Metres per degree of latitude (spherical approximation). */
export const M_PER_DEG_LAT = 111_319.49;

export const M2_PER_HECTARE = 10_000;
export const M2_PER_KM2 = 1_000_000;
export const M2_PER_ACRE = 4_046.8564224;

/** Standard test condition irradiance, W/m². The reference for DC nameplate. */
export const STC_IRRADIANCE_W_M2 = 1000;

export const HOURS_PER_YEAR = 8760;

/* --- Angles --------------------------------------------------------------- */

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
export const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

/** Wraps any angle into [0, 360). */
export function normaliseAzimuth(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Smallest absolute difference between two azimuths, in degrees.
 * Handles the wrap at north, where a naive subtraction gives 350 instead of 10.
 */
export function azimuthDifference(a: number, b: number): number {
  const diff = Math.abs(normaliseAzimuth(a) - normaliseAzimuth(b));
  return diff > 180 ? 360 - diff : diff;
}

/** Equator-facing azimuth: due south in the north, due north in the south. */
export function equatorFacingAzimuth(latitude: number): number {
  return latitude >= 0 ? 180 : 0;
}

/** 16-point compass label, for reporting an orientation in words. */
const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export function compassPoint(azimuth: number): string {
  const index = Math.round(normaliseAzimuth(azimuth) / 22.5) % 16;
  return COMPASS_POINTS[index] as string;
}

/* --- Areas ---------------------------------------------------------------- */

export const m2ToHectares = (m2: number): number => m2 / M2_PER_HECTARE;
export const m2ToKm2 = (m2: number): number => m2 / M2_PER_KM2;
export const m2ToAcres = (m2: number): number => m2 / M2_PER_ACRE;
export const hectaresToM2 = (ha: number): number => ha * M2_PER_HECTARE;

/* --- Slope ---------------------------------------------------------------- */

/** Terrain slope in percent from degrees; site-selection thresholds use percent. */
export const slopeDegreesToPercent = (degrees: number): number => Math.tan(toRadians(degrees)) * 100;
export const slopePercentToDegrees = (percent: number): number => toDegrees(Math.atan(percent / 100));

/* --- Energy --------------------------------------------------------------- */

/**
 * Capacity factor: annual energy over the energy a plant would make running at
 * nameplate for the whole year.
 */
export function capacityFactor(annualKwh: number, capacityKw: number): number {
  if (capacityKw <= 0) return 0;
  return annualKwh / (capacityKw * HOURS_PER_YEAR);
}

/** Annual energy per kW installed: the figure that compares sites fairly. */
export function specificYield(annualKwh: number, capacityKw: number): number {
  return capacityKw <= 0 ? 0 : annualKwh / capacityKw;
}

/* --- Formatting ----------------------------------------------------------- */

/**
 * Significant-figure formatting with thousands separators.
 *
 * Engineering readouts should not imply more precision than the model supports,
 * so display precision is a deliberate choice per magnitude rather than a raw
 * `toFixed`.
 */
export function formatNumber(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export interface ScaledValue {
  value: string;
  unit: string;
}

/** Picks kW / MW / GW so a readout never shows 1,240,000 kW. */
export function scalePower(kw: number): ScaledValue {
  if (!Number.isFinite(kw)) return { value: "—", unit: "kW" };
  const abs = Math.abs(kw);
  if (abs >= 1e6) return { value: formatNumber(kw / 1e6, 2), unit: "GW" };
  if (abs >= 1e3) return { value: formatNumber(kw / 1e3, 2), unit: "MW" };
  return { value: formatNumber(kw, abs < 10 ? 2 : 1), unit: "kW" };
}

/** Picks kWh / MWh / GWh / TWh. */
export function scaleEnergy(kwh: number): ScaledValue {
  if (!Number.isFinite(kwh)) return { value: "—", unit: "kWh" };
  const abs = Math.abs(kwh);
  if (abs >= 1e9) return { value: formatNumber(kwh / 1e9, 2), unit: "TWh" };
  if (abs >= 1e6) return { value: formatNumber(kwh / 1e6, 2), unit: "GWh" };
  if (abs >= 1e3) return { value: formatNumber(kwh / 1e3, 1), unit: "MWh" };
  return { value: formatNumber(kwh, 0), unit: "kWh" };
}

/** Picks m² / ha / km², matching how site areas are actually discussed. */
export function scaleArea(m2: number): ScaledValue {
  if (!Number.isFinite(m2)) return { value: "—", unit: "m²" };
  const abs = Math.abs(m2);
  if (abs >= 1e6) return { value: formatNumber(m2ToKm2(m2), 2), unit: "km²" };
  if (abs >= 1e4) return { value: formatNumber(m2ToHectares(m2), 2), unit: "ha" };
  return { value: formatNumber(m2, 0), unit: "m²" };
}

export function scaleDistance(metres: number): ScaledValue {
  if (!Number.isFinite(metres)) return { value: "—", unit: "m" };
  if (Math.abs(metres) >= 1000) return { value: formatNumber(metres / 1000, 2), unit: "km" };
  return { value: formatNumber(metres, metres < 10 ? 1 : 0), unit: "m" };
}

/** Money, rounded to whole currency units and scaled for large sums. */
export function scaleMoney(amount: number, currency = "USD"): ScaledValue {
  if (!Number.isFinite(amount)) return { value: "—", unit: currency };
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  const abs = Math.abs(amount);
  if (abs >= 1e9) return { value: `${symbol}${formatNumber(amount / 1e9, 2)}`, unit: "B" };
  if (abs >= 1e6) return { value: `${symbol}${formatNumber(amount / 1e6, 2)}`, unit: "M" };
  if (abs >= 1e4) return { value: `${symbol}${formatNumber(amount / 1e3, 1)}`, unit: "k" };
  return { value: `${symbol}${formatNumber(amount, 0)}`, unit: "" };
}

export function formatPercent(fraction: number, decimals = 1): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${formatNumber(fraction * 100, decimals)}%`;
}

/** Decimal degrees with a hemisphere letter, as used in the status bar. */
export function formatLatitude(latitude: number, decimals = 4): string {
  const hemisphere = latitude >= 0 ? "N" : "S";
  return `${Math.abs(latitude).toFixed(decimals)}° ${hemisphere}`;
}

export function formatLongitude(longitude: number, decimals = 4): string {
  const hemisphere = longitude >= 0 ? "E" : "W";
  return `${Math.abs(longitude).toFixed(decimals)}° ${hemisphere}`;
}

export function formatCoordinates(latitude: number, longitude: number, decimals = 4): string {
  return `${formatLatitude(latitude, decimals)}, ${formatLongitude(longitude, decimals)}`;
}
