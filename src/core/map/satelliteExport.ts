/**
 * Static Esri World Imagery export URL for a site extent.
 *
 * Used by Design and Report HTML exports so we never embed a CORS-tainted
 * MapLibre canvas (which prints as a black square).
 *
 * Imagery is requested in Web Mercator (EPSG:3857) so the site outline overlay
 * matches the MapLibre map the user drew on (also Mercator), not a stretched
 * geographic (EPSG:4326) plate carrée export.
 */

import type { Site } from "@/core/store/siteStore";

export interface SatelliteSnapshot {
  url: string;
  west: number;
  south: number;
  east: number;
  north: number;
  /** Site ring in normalised image coordinates [0–1]×[0–1], y down. */
  outlineNorm: Array<[number, number]> | null;
}

const EARTH_RADIUS = 6_378_137;

export function satelliteImageUrl(site: Site, size = 900): string | null {
  return satelliteSnapshot(site, size)?.url ?? null;
}

/** Snapshot plus a normalised outline for HTML overlays (avoids canvas CORS). */
export function satelliteSnapshot(site: Site, size = 900): SatelliteSnapshot | null {
  let west: number;
  let south: number;
  let east: number;
  let north: number;
  if (!site.ring || site.ring.length < 2) {
    const [lon, lat] = site.centre;
    const d = 0.01;
    west = lon - d;
    south = lat - d;
    east = lon + d;
    north = lat + d;
  } else {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const [lng, lat] of site.ring) {
      minLng = Math.min(minLng, lng);
      minLat = Math.min(minLat, lat);
      maxLng = Math.max(maxLng, lng);
      maxLat = Math.max(maxLat, lat);
    }
    const padLng = (maxLng - minLng) * 0.12 || 0.002;
    const padLat = (maxLat - minLat) * 0.12 || 0.002;
    west = minLng - padLng;
    south = minLat - padLat;
    east = maxLng + padLng;
    north = maxLat + padLat;
  }

  // Normalise outline in Mercator metres — same CRS as the exported image.
  const [minX, minY] = projectMercator(west, south);
  const [maxX, maxY] = projectMercator(east, north);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const outlineNorm =
    site.ring && site.ring.length >= 3
      ? site.ring.map(([lng, lat]) => {
          const [x, y] = projectMercator(lng, lat);
          return [(x - minX) / spanX, (maxY - y) / spanY] as [number, number];
        })
      : null;

  // Image pixel aspect follows Mercator ground aspect so the frame is not stretched.
  const aspect = spanX / spanY;
  const width = size;
  const height = Math.max(200, Math.round(size / aspect));

  return {
    url: esriExport(west, south, east, north, width, height),
    west,
    south,
    east,
    north,
    outlineNorm,
  };
}

/** Point-location snapshot when the report has no polygon site ring. */
export function satelliteImageUrlAt(
  longitude: number,
  latitude: number,
  size = 900,
): string {
  const d = 0.008;
  return esriExport(longitude - d, latitude - d, longitude + d, latitude + d, size, Math.round(size * 0.75));
}

/** WGS84 → Web Mercator metres (EPSG:3857). */
function projectMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = (lng * Math.PI) / 180 * EARTH_RADIUS;
  const y =
    Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360)) * EARTH_RADIUS;
  return [x, y];
}

function esriExport(
  west: number,
  south: number,
  east: number,
  north: number,
  width: number,
  height: number,
): string {
  const params = new URLSearchParams({
    bbox: `${west},${south},${east},${north}`,
    bboxSR: "4326",
    // Match MapLibre’s Web Mercator so overlays align with the in-app map.
    imageSR: "3857",
    size: `${width},${height}`,
    format: "jpg",
    f: "image",
  });
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?${params}`;
}
