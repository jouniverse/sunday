/**
 * Indicative distance to mapped HV power infrastructure via Overpass (OSM).
 *
 * Not hosting capacity. Voltage floor follows MapYourGrid-style HV (≥ 50 kV).
 * Uses platform().http so Tauri avoids browser CORS.
 */

import { platform } from "@/core/platform";
import { haversineDistanceM, type LngLat } from "@/domain/geometry";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const MIN_VOLTAGE_KV = 50;
const RADII_M = [50_000, 100_000] as const;

export interface GridDistanceResult {
  /** Nearest mapped HV feature distance in km, when found within the search radii. */
  distanceKm: number | null;
  voltageKv: number | null;
  label: string | null;
  /** e.g. overpass-osm-power>=50kV;radius=50000 */
  method: string;
  /** True when Overpass answered; false on network/parse failure. */
  available: boolean;
}

/** Parse OSM voltage tags (often volts; sometimes kV or semicolon lists) → max kV. */
export function parseVoltageKv(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw >= 1000 ? raw / 1000 : raw;
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  let max = 0;
  for (const part of raw.split(/[;/]/)) {
    const cleaned = part.trim().toLowerCase().replace(/,/g, "");
    const match = cleaned.match(/([\d.]+)\s*(kv|v)?/);
    if (!match) continue;
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = match[2];
    let kv = n;
    if (unit === "v") kv = n / 1000;
    else if (unit === "kv") kv = n;
    else kv = n >= 1000 ? n / 1000 : n;
    if (kv > max) max = kv;
  }
  return max > 0 ? max : null;
}

function buildQuery(lat: number, lon: number, radiusM: number): string {
  return `
[out:json][timeout:25];
(
  way["power"="line"]["voltage"](around:${radiusM},${lat},${lon});
  node["power"="substation"](around:${radiusM},${lat},${lon});
  way["power"="substation"](around:${radiusM},${lat},${lon});
  relation["power"="substation"](around:${radiusM},${lat},${lon});
);
out center tags;
`.trim();
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function elementPoint(el: OverpassElement): LngLat | null {
  if (typeof el.lat === "number" && typeof el.lon === "number") {
    return [el.lon, el.lat];
  }
  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") {
    return [el.center.lon, el.center.lat];
  }
  return null;
}

function elementLabel(el: OverpassElement): string {
  const tags = el.tags ?? {};
  const name = tags.name || tags.operator || tags.ref;
  const kind = tags.power === "substation" ? "substation" : "line";
  return name ? `${kind}: ${name}` : kind;
}

async function queryRadius(
  centre: LngLat,
  radiusM: number,
): Promise<{ distanceKm: number; voltageKv: number | null; label: string } | null> {
  const [lon, lat] = centre;
  const body = buildQuery(lat, lon, radiusM);
  const response = await platform().http.fetchText({
    url: OVERPASS_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(body)}`,
    timeoutMs: 35_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Overpass HTTP ${response.status}`);
  }
  const json = JSON.parse(response.body) as { elements?: OverpassElement[] };
  const elements = json.elements ?? [];

  let best: { distanceKm: number; voltageKv: number | null; label: string } | null = null;
  for (const el of elements) {
    const kv = parseVoltageKv(el.tags?.voltage);
    // Substations often omit voltage — still count them as HV context.
    const isSubstation = el.tags?.power === "substation";
    if (!isSubstation && (kv == null || kv < MIN_VOLTAGE_KV)) continue;
    if (isSubstation && kv != null && kv < MIN_VOLTAGE_KV) continue;

    const point = elementPoint(el);
    if (!point) continue;
    const distanceKm = haversineDistanceM(centre, point) / 1000;
    if (!best || distanceKm < best.distanceKm) {
      best = { distanceKm, voltageKv: kv, label: elementLabel(el) };
    }
  }
  return best;
}

/**
 * Nearest mapped HV line (≥ 50 kV) or substation around the site centre.
 * Tries 50 km, then 100 km. Never invents a distance on failure.
 */
export async function queryNearestGridDistance(input: {
  centre: LngLat;
}): Promise<GridDistanceResult> {
  try {
    for (const radiusM of RADII_M) {
      const hit = await queryRadius(input.centre, radiusM);
      if (hit) {
        return {
          distanceKm: hit.distanceKm,
          voltageKv: hit.voltageKv,
          label: hit.label,
          method: `overpass-osm-power>=${MIN_VOLTAGE_KV}kV;radius=${radiusM}`,
          available: true,
        };
      }
    }
    return {
      distanceKm: null,
      voltageKv: null,
      label: null,
      method: `overpass-osm-power>=${MIN_VOLTAGE_KV}kV;radius=${RADII_M[RADII_M.length - 1]};none`,
      available: true,
    };
  } catch (error) {
    return {
      distanceKm: null,
      voltageKv: null,
      label: null,
      method: `overpass-failed:${error instanceof Error ? error.message : String(error)}`,
      available: false,
    };
  }
}
