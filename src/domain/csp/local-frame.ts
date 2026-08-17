/**
 * WGS84 ↔ tower-local metres. SSC/PySAM never see lat/lon.
 *
 * Reuses the same ENU approximation as PV packing (equirectangular about the
 * site centroid). Fine at CSP parcel scale; not a UTM zone solver.
 */

import type { LngLat, Point2D, Polygon2D } from "../geometry";
import {
  distanceToBoundary2D,
  pointInPolygon2D,
  polygonBounds2D,
  ringToLocalFrame,
  toGeographic,
  toLocalFrame,
} from "../geometry";
import type { CspHeliostatLayout, CspLocalPoint } from "./types";

export { ringToLocalFrame, toGeographic, toLocalFrame };

export function localPointToLngLat(point: Point2D, origin: LngLat): LngLat {
  return toGeographic(point, origin);
}

export function lngLatToLocalPoint(point: LngLat, origin: LngLat): Point2D {
  return toLocalFrame(point, origin);
}

/**
 * Inset that reserves about `fraction` of a compact parcel as an empty rim.
 * Used so roads/pads/margins stay off the schematic without a second overlay.
 */
export function unavailableSetbackM(polygon: Point2D[], fraction: number): number {
  const f = Math.min(0.4, Math.max(0, fraction));
  if (f <= 0) return 0;
  const bounds = polygonBounds2D(polygon);
  const side = Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (side <= 0) return 0;
  return (side / 2) * (1 - Math.sqrt(1 - f));
}

export function clipPointsToPolygon(
  points: Point2D[],
  polygon: Polygon2D,
  setbackM = 0,
): Point2D[] {
  return points.filter((point) => {
    if (!pointInPolygon2D(polygon, point)) return false;
    if (setbackM > 0 && distanceToBoundary2D(polygon, point) < setbackM) return false;
    return true;
  });
}

function asLocalPoint(row: CspLocalPoint | number[] | [number, number]): CspLocalPoint | null {
  if (Array.isArray(row)) {
    if (row.length < 2) return null;
    return { x: row[0]!, y: row[1]! };
  }
  return row;
}

/**
 * Convert SolarPILOT/PySAM tower-local XY (metres) into a clipped geographic
 * heliostat layout. Origin is the site-ring centroid — the same ENU frame
 * `ringToLocalFrame` uses. Positions outside the parcel are dropped.
 */
export function heliostatsFromLocalXy(options: {
  positions: Array<CspLocalPoint | number[] | [number, number]>;
  ring: LngLat[];
  heliostatWidthM: number;
  heliostatHeightM: number;
  method: string;
  landAreaM2?: number;
  opticalEfficiency?: number;
  landUnavailableFraction?: number;
}): CspHeliostatLayout | null {
  if (options.ring.length < 3) return null;
  const { polygon, origin } = ringToLocalFrame(options.ring);
  const parsed = options.positions
    .map(asLocalPoint)
    .filter((point): point is CspLocalPoint => point !== null);
  const setbackM = unavailableSetbackM(polygon, options.landUnavailableFraction ?? 0);
  const clipped = clipPointsToPolygon(parsed, polygon, setbackM);
  return {
    origin,
    positionsLocal: clipped,
    positionsLngLat: clipped.map((point) => localPointToLngLat(point, origin)),
    heliostatCount: clipped.length,
    reflectiveAreaM2: clipped.length * options.heliostatWidthM * options.heliostatHeightM,
    landAreaM2: options.landAreaM2,
    opticalEfficiency: options.opticalEfficiency,
    method: options.method,
  };
}
