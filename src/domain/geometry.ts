/**
 * Planar and geodesic geometry.
 *
 * Two frames are in play and mixing them is the classic source of wrong areas:
 *
 * - **Geographic**: `[longitude, latitude]` in degrees, as GeoJSON and MapLibre
 *   use. Distances and areas here need geodesic formulas.
 * - **Local metres**: a tangent-plane frame centred on a site, where ordinary
 *   Euclidean geometry is valid. Module packing happens here.
 *
 * `toLocalFrame` and `toGeographic` convert between them. Anything measured in
 * metres must go through the local frame first.
 */

import { EARTH_RADIUS_M, M_PER_DEG_LAT, toDegrees, toRadians } from "./units";

export interface Point2D {
  x: number;
  y: number;
}

/** A closed ring in the local metres frame; the closing vertex is implicit. */
export type Polygon2D = Point2D[];

/** GeoJSON-order coordinate: longitude first. */
export type LngLat = [number, number];

/* --- Geodesic measurement -------------------------------------------------- */

/** Great-circle distance in metres. */
export function haversineDistanceM(a: LngLat, b: LngLat): number {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dPhi = phi2 - phi1;
  const dLambda = toRadians(lon2 - lon1);
  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Geodesic area of a ring in square metres, using the spherical excess formula.
 *
 * This is the same approach as `@turf/area`, kept here so the domain layer has no
 * runtime dependency and so the formula is auditable: a planar area computed from
 * degrees would be wrong by a factor of cos(latitude), which at 60°N is a factor
 * of two.
 */
export function geodesicRingAreaM2(ring: LngLat[]): number {
  if (ring.length < 3) return 0;

  let total = 0;
  const count = ring.length;
  for (let i = 0; i < count; i += 1) {
    const [lon1, lat1] = ring[i] as LngLat;
    const [lon2, lat2] = ring[(i + 1) % count] as LngLat;
    total +=
      toRadians(lon2 - lon1) * (2 + Math.sin(toRadians(lat1)) + Math.sin(toRadians(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Polygon area with holes subtracted; outer ring first. */
export function geodesicPolygonAreaM2(rings: LngLat[][]): number {
  if (rings.length === 0) return 0;
  const [outer, ...holes] = rings;
  const outerArea = geodesicRingAreaM2(outer as LngLat[]);
  return holes.reduce((area, hole) => area - geodesicRingAreaM2(hole), outerArea);
}

/** Perimeter of a ring in metres, closing it if the caller did not. */
export function geodesicPerimeterM(ring: LngLat[]): number {
  if (ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    total += haversineDistanceM(ring[i] as LngLat, ring[i + 1] as LngLat);
  }
  const first = ring[0] as LngLat;
  const last = ring[ring.length - 1] as LngLat;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    total += haversineDistanceM(last, first);
  }
  return total;
}

export interface GeoBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function ringBounds(ring: LngLat[]): GeoBounds {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** Area-weighted centroid of a ring, computed in a local frame for accuracy. */
export function ringCentroid(ring: LngLat[]): LngLat {
  if (ring.length === 0) return [0, 0];
  if (ring.length < 3) {
    const sum = ring.reduce<[number, number]>((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }

  const origin = ringBounds(ring);
  const originLngLat: LngLat = [
    (origin.minLon + origin.maxLon) / 2,
    (origin.minLat + origin.maxLat) / 2,
  ];
  const local = ring.map((point) => toLocalFrame(point, originLngLat));

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < local.length; i += 1) {
    const a = local[i] as Point2D;
    const b = local[(i + 1) % local.length] as Point2D;
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }

  // A degenerate (zero-area) ring has no meaningful area centroid; fall back to
  // the vertex mean rather than dividing by zero.
  if (Math.abs(twiceArea) < 1e-12) {
    const mean = local.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return toGeographic({ x: mean.x / local.length, y: mean.y / local.length }, originLngLat);
  }

  return toGeographic({ x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) }, originLngLat);
}

/* --- Local frame ---------------------------------------------------------- */

/**
 * Projects a geographic point into a local metres frame centred on `origin`.
 *
 * An equirectangular tangent-plane projection: x scales by cos(latitude) so
 * east-west distances are right, y is a straight latitude scale. Accurate to well
 * under a metre across a few kilometres, which is the scale of any single site,
 * and it has the great advantage of being obvious.
 */
export function toLocalFrame(point: LngLat, origin: LngLat): Point2D {
  const [lon, lat] = point;
  const [originLon, originLat] = origin;
  const metresPerDegreeLon = M_PER_DEG_LAT * Math.cos(toRadians(originLat));
  return {
    x: (lon - originLon) * metresPerDegreeLon,
    y: (lat - originLat) * M_PER_DEG_LAT,
  };
}

export function toGeographic(point: Point2D, origin: LngLat): LngLat {
  const [originLon, originLat] = origin;
  const metresPerDegreeLon = M_PER_DEG_LAT * Math.cos(toRadians(originLat));
  return [originLon + point.x / metresPerDegreeLon, originLat + point.y / M_PER_DEG_LAT];
}

/** Converts a ring to the local frame, using its own centroid as the origin. */
export function ringToLocalFrame(ring: LngLat[]): { polygon: Polygon2D; origin: LngLat } {
  const origin = ringCentroid(ring);
  return { polygon: ring.map((point) => toLocalFrame(point, origin)), origin };
}

/* --- Planar geometry ------------------------------------------------------ */

/** Shoelace area in the local frame, always positive. */
export function polygonArea2D(polygon: Polygon2D): number {
  if (polygon.length < 3) return 0;
  let twice = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point2D;
    const b = polygon[(i + 1) % polygon.length] as Point2D;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function polygonBounds2D(polygon: Polygon2D): Bounds2D {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { x, y } of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Ray-casting point-in-polygon test. Boundary cases resolve consistently. */
export function pointInPolygon2D(polygon: Polygon2D, point: Point2D): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as Point2D;
    const b = polygon[j] as Point2D;
    const straddles = a.y > point.y !== b.y > point.y;
    if (!straddles) continue;
    const xCrossing = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (point.x < xCrossing) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to a segment, in the local frame. */
export function distanceToSegment2D(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  // Projection parameter, clamped to the segment.
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Shortest distance from a point to a polygon's boundary. */
export function distanceToBoundary2D(polygon: Polygon2D, point: Point2D): number {
  let shortest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point2D;
    const b = polygon[(i + 1) % polygon.length] as Point2D;
    shortest = Math.min(shortest, distanceToSegment2D(point, a, b));
  }
  return shortest;
}

/**
 * Whether an axis-aligned rectangle fits inside a polygon with a setback.
 *
 * All four corners must be inside, and each must clear the boundary by at least
 * `setback`. Testing corners rather than the centre is what stops a module from
 * overhanging the eaves; the clearance test is what makes the setback real
 * rather than decorative.
 */
export function rectangleInPolygon(
  polygon: Polygon2D,
  x: number,
  y: number,
  width: number,
  height: number,
  setback = 0,
): boolean {
  const corners: Point2D[] = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  for (const corner of corners) {
    if (!pointInPolygon2D(polygon, corner)) return false;
    if (setback > 0 && distanceToBoundary2D(polygon, corner) < setback) return false;
  }
  return true;
}

/** Rotates a point about the origin of the local frame. */
export function rotatePoint2D(point: Point2D, degrees: number): Point2D {
  if (degrees === 0) return point;
  const angle = toRadians(degrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

/**
 * Dominant edge bearing of a ring, in degrees clockwise from north.
 *
 * Used to guess the orientation a rooftop array should follow: the longest edge
 * of a roof outline is almost always the eaves or the ridge.
 */
export function dominantEdgeBearing(ring: LngLat[]): number {
  if (ring.length < 2) return 0;
  const { polygon } = ringToLocalFrame(ring);
  let bestLength = -1;
  let bearing = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point2D;
    const b = polygon[(i + 1) % polygon.length] as Point2D;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > bestLength) {
      bestLength = length;
      // atan2(east, north) gives a compass bearing, not a maths angle.
      bearing = toDegrees(Math.atan2(b.x - a.x, b.y - a.y));
    }
  }
  return ((bearing % 360) + 360) % 360;
}

/** Closes a ring if the caller left it open, as GeoJSON requires. */
export function closeRing(ring: LngLat[]): LngLat[] {
  if (ring.length < 3) return ring;
  const first = ring[0] as LngLat;
  const last = ring[ring.length - 1] as LngLat;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/**
 * Whether a ring is simple, meaning no two non-adjacent edges cross.
 *
 * A self-intersecting site boundary produces a meaningless area, so the draw
 * tools use this to refuse to finish an invalid polygon rather than quietly
 * reporting a wrong number.
 */
export function isSimpleRing(ring: LngLat[]): boolean {
  const open = dropClosingVertex(ring);
  const count = open.length;
  if (count < 3) return false;

  for (let i = 0; i < count; i += 1) {
    const a1 = open[i] as LngLat;
    const a2 = open[(i + 1) % count] as LngLat;
    for (let j = i + 1; j < count; j += 1) {
      // Adjacent edges share a vertex, which is not an intersection.
      if (j === i || (j + 1) % count === i || j === (i + 1) % count) continue;
      const b1 = open[j] as LngLat;
      const b2 = open[(j + 1) % count] as LngLat;
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

function dropClosingVertex(ring: LngLat[]): LngLat[] {
  if (ring.length < 2) return ring;
  const first = ring[0] as LngLat;
  const last = ring[ring.length - 1] as LngLat;
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

function segmentsIntersect(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // Collinear overlap counts as an intersection too.
  return (
    (d1 === 0 && onSegment(p3, p4, p1)) ||
    (d2 === 0 && onSegment(p3, p4, p2)) ||
    (d3 === 0 && onSegment(p1, p2, p3)) ||
    (d4 === 0 && onSegment(p1, p2, p4))
  );
}

function cross(a: LngLat, b: LngLat, c: LngLat): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: LngLat, b: LngLat, point: LngLat): boolean {
  return (
    Math.min(a[0], b[0]) <= point[0] &&
    point[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= point[1] &&
    point[1] <= Math.max(a[1], b[1])
  );
}
