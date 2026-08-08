/**
 * Site ∩ WDPA screening query against the simplified SQLite geometries.
 *
 * Map paint uses PMTiles; this path is for Run screening checks only.
 */

import booleanIntersects from "@turf/boolean-intersects";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { polygon as turfPolygon } from "@turf/helpers";
import { platform } from "@/core/platform";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { LngLat } from "@/domain/geometry";

const QUERY_LIMIT = 80;

export type WdpaScreeningResult =
  | { available: false; intersects: false }
  | { available: true; intersects: boolean; name?: string };

function siteRingBounds(ring: LngLat[]): {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
} | null {
  if (ring.length < 3) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function asPolygonFeature(
  geometry: GeoJSON.Geometry,
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    return { type: "Feature", properties: {}, geometry };
  }
  return null;
}

/** True when WDPA has been installed into the app data directory. */
export function wdpaDatasetInstalled(): boolean {
  return Boolean(useSettingsStore.getState().datasets.wdpa?.downloaded);
}

/**
 * Query simplified WDPA polygons that overlap the site bbox, then test
 * geometric intersection (or point-in-polygon for a marked location).
 */
export async function querySiteProtectedAreaOverlap(input: {
  centre: LngLat;
  ring: LngLat[] | null;
}): Promise<WdpaScreeningResult> {
  if (!wdpaDatasetInstalled()) {
    return { available: false, intersects: false };
  }

  const bounds = input.ring ? siteRingBounds(input.ring) : null;
  const queryBounds = bounds ?? {
    minLon: input.centre[0] - 0.02,
    minLat: input.centre[1] - 0.02,
    maxLon: input.centre[0] + 0.02,
    maxLat: input.centre[1] + 0.02,
  };

  const result = await platform().vector.queryBbox({
    dataset: "wdpa",
    ...queryBounds,
    limit: QUERY_LIMIT,
    includeGeometry: true,
  });

  const sitePoly =
    input.ring && input.ring.length >= 3
      ? turfPolygon([[...input.ring, input.ring[0] as LngLat]])
      : null;

  for (const feature of result.features) {
    if (!feature.geometry) continue;
    const other = asPolygonFeature(feature.geometry);
    if (!other) continue;

    let hits = false;
    if (sitePoly) {
      hits = booleanIntersects(sitePoly, other);
    } else {
      hits = booleanPointInPolygon(input.centre, other);
    }
    if (hits) {
      return {
        available: true,
        intersects: true,
        name: feature.name ?? undefined,
      };
    }
  }

  return { available: true, intersects: false };
}
