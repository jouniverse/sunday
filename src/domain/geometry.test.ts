import { describe, expect, it } from "vitest";
import type { LngLat } from "./geometry";
import {
  closeRing,
  distanceToBoundary2D,
  distanceToSegment2D,
  dominantEdgeBearing,
  geodesicPerimeterM,
  geodesicPolygonAreaM2,
  geodesicRingAreaM2,
  haversineDistanceM,
  isSimpleRing,
  pointInPolygon2D,
  polygonArea2D,
  polygonBounds2D,
  rectangleInPolygon,
  ringBounds,
  ringCentroid,
  ringToLocalFrame,
  rotatePoint2D,
  toGeographic,
  toLocalFrame,
} from "./geometry";

/** A square of the given side in degrees, anchored at (lon, lat). */
function degreeSquare(lon: number, lat: number, side: number): LngLat[] {
  return [
    [lon, lat],
    [lon + side, lat],
    [lon + side, lat + side],
    [lon, lat + side],
    [lon, lat],
  ];
}

describe("geodesic distance", () => {
  it("matches a known intercity distance", () => {
    // Los Angeles to New York is about 3936 km.
    const d = haversineDistanceM([-118.2437, 34.0522], [-74.006, 40.7128]);
    expect(d / 1000).toBeCloseTo(3936, 0);
  });

  it("gives a degree of latitude its textbook length", () => {
    const d = haversineDistanceM([0, 0], [0, 1]);
    expect(d).toBeCloseTo(111_195, -2);
  });

  it("shrinks a degree of longitude towards the pole", () => {
    const atEquator = haversineDistanceM([0, 0], [1, 0]);
    const at60 = haversineDistanceM([0, 60], [1, 60]);
    // cos(60) = 0.5, so a degree of longitude is half as long.
    expect(at60 / atEquator).toBeCloseTo(0.5, 2);
  });

  it("is zero for coincident points and symmetric otherwise", () => {
    expect(haversineDistanceM([10, 20], [10, 20])).toBe(0);
    const forward = haversineDistanceM([10, 20], [11, 21]);
    const backward = haversineDistanceM([11, 21], [10, 20]);
    expect(forward).toBeCloseTo(backward, 9);
  });
});

describe("geodesic area", () => {
  it("computes a one-degree square near the equator", () => {
    // Exact spherical area of the 0-1 degree cell is
    // R^2 * dLambda * (sin(1 deg) - sin(0)) = 12,363.7 km2 at R = 6,371,008.8 m.
    const area = geodesicRingAreaM2(degreeSquare(0, 0, 1));
    expect(area / 1e6).toBeCloseTo(12_363.7, 0);
  });

  it("shrinks the same degree square at high latitude", () => {
    const equator = geodesicRingAreaM2(degreeSquare(0, 0, 1));
    const northern = geodesicRingAreaM2(degreeSquare(0, 60, 1));
    // This is the error a planar area computed from degrees would make.
    expect(northern).toBeLessThan(equator * 0.55);
    expect(northern).toBeGreaterThan(equator * 0.45);
  });

  it("is independent of winding direction", () => {
    const ring = degreeSquare(10, 45, 0.01);
    const reversed = [...ring].reverse();
    expect(geodesicRingAreaM2(reversed)).toBeCloseTo(geodesicRingAreaM2(ring), 6);
  });

  it("returns zero for a degenerate ring", () => {
    expect(geodesicRingAreaM2([])).toBe(0);
    expect(
      geodesicRingAreaM2([
        [0, 0],
        [1, 1],
      ]),
    ).toBe(0);
  });

  it("subtracts holes from the outer ring", () => {
    const outer = degreeSquare(0, 0, 0.1);
    const hole = degreeSquare(0.02, 0.02, 0.02);
    const withHole = geodesicPolygonAreaM2([outer, hole]);
    const withoutHole = geodesicPolygonAreaM2([outer]);
    expect(withHole).toBeLessThan(withoutHole);
    expect(withoutHole - withHole).toBeCloseTo(geodesicRingAreaM2(hole), 3);
  });
});

describe("perimeter", () => {
  it("sums the sides of a square", () => {
    const side = haversineDistanceM([0, 0], [0.01, 0]);
    const perimeter = geodesicPerimeterM(degreeSquare(0, 0, 0.01));
    // Four sides; the north edge is marginally shorter than the south one.
    expect(perimeter).toBeGreaterThan(side * 3.9);
    expect(perimeter).toBeLessThan(side * 4.1);
  });

  it("closes an open ring before measuring", () => {
    const open: LngLat[] = [
      [0, 0],
      [0.01, 0],
      [0.01, 0.01],
      [0, 0.01],
    ];
    const closed = closeRing(open);
    expect(geodesicPerimeterM(open)).toBeCloseTo(geodesicPerimeterM(closed), 6);
  });
});

describe("bounds and centroid", () => {
  it("computes ring bounds", () => {
    expect(ringBounds(degreeSquare(-10, 20, 5))).toEqual({
      minLon: -10,
      minLat: 20,
      maxLon: -5,
      maxLat: 25,
    });
  });

  it("puts a square's centroid at its centre", () => {
    const [lon, lat] = ringCentroid(degreeSquare(10, 45, 0.02));
    expect(lon).toBeCloseTo(10.01, 5);
    expect(lat).toBeCloseTo(45.01, 5);
  });

  it("pulls an L-shape's centroid towards its bulk", () => {
    const shape: LngLat[] = [
      [0, 0],
      [0.02, 0],
      [0.02, 0.005],
      [0.005, 0.005],
      [0.005, 0.02],
      [0, 0.02],
      [0, 0],
    ];
    const [lon, lat] = ringCentroid(shape);
    // Symmetric about the diagonal, and inside the shape rather than in the notch.
    expect(lon).toBeCloseTo(lat, 4);
    expect(lon).toBeLessThan(0.01);
  });

  it("falls back to the vertex mean for a zero-area ring", () => {
    const collinear: LngLat[] = [
      [0, 0],
      [0.01, 0],
      [0.02, 0],
      [0, 0],
    ];
    const [lon, lat] = ringCentroid(collinear);
    expect(Number.isFinite(lon)).toBe(true);
    expect(Number.isFinite(lat)).toBe(true);
    expect(lat).toBeCloseTo(0, 6);
  });
});

describe("local frame", () => {
  it("round-trips a point through the local frame", () => {
    const origin: LngLat = [-118.17, 35.05];
    for (const point of [
      [-118.17, 35.05],
      [-118.16, 35.06],
      [-118.2, 35.0],
    ] as LngLat[]) {
      const [lon, lat] = toGeographic(toLocalFrame(point, origin), origin);
      expect(lon).toBeCloseTo(point[0], 9);
      expect(lat).toBeCloseTo(point[1], 9);
    }
  });

  it("puts the origin at zero", () => {
    const origin: LngLat = [12, 55];
    expect(toLocalFrame(origin, origin)).toEqual({ x: 0, y: 0 });
  });

  it("agrees with geodesic distance over site-scale spans", () => {
    const origin: LngLat = [-118.17, 35.05];
    const other: LngLat = [-118.16, 35.06];
    const local = toLocalFrame(other, origin);
    const planar = Math.hypot(local.x, local.y);
    const geodesic = haversineDistanceM(origin, other);
    // Within 0.5% across ~1.4 km, which is the accuracy claim for this projection.
    expect(Math.abs(planar - geodesic) / geodesic).toBeLessThan(0.005);
  });

  it("preserves area to within a fraction of a percent", () => {
    const ring = degreeSquare(-118.2, 35.0, 0.01);
    const { polygon } = ringToLocalFrame(ring);
    const planarArea = polygonArea2D(polygon);
    const geodesicArea = geodesicRingAreaM2(ring);
    expect(Math.abs(planarArea - geodesicArea) / geodesicArea).toBeLessThan(0.005);
  });
});

describe("planar geometry", () => {
  const unitSquare = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("computes shoelace area regardless of winding", () => {
    expect(polygonArea2D(unitSquare)).toBe(100);
    expect(polygonArea2D([...unitSquare].reverse())).toBe(100);
  });

  it("computes bounds", () => {
    expect(polygonBounds2D(unitSquare)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it("tests point containment", () => {
    expect(pointInPolygon2D(unitSquare, { x: 5, y: 5 })).toBe(true);
    expect(pointInPolygon2D(unitSquare, { x: 15, y: 5 })).toBe(false);
    expect(pointInPolygon2D(unitSquare, { x: -0.1, y: 5 })).toBe(false);
  });

  it("handles a concave polygon's notch", () => {
    const lShape = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon2D(lShape, { x: 2, y: 2 })).toBe(true);
    // Inside the bounding box, but in the missing quadrant.
    expect(pointInPolygon2D(lShape, { x: 8, y: 8 })).toBe(false);
  });

  it("measures distance to a segment including its ends", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(distanceToSegment2D({ x: 5, y: 3 }, a, b)).toBeCloseTo(3, 9);
    // Beyond the end: distance to the endpoint, not to the infinite line.
    expect(distanceToSegment2D({ x: 14, y: 0 }, a, b)).toBeCloseTo(4, 9);
    expect(distanceToSegment2D({ x: 5, y: 0 }, a, b)).toBeCloseTo(0, 9);
    // Degenerate segment.
    expect(distanceToSegment2D({ x: 3, y: 4 }, a, a)).toBeCloseTo(5, 9);
  });

  it("measures distance to the nearest boundary edge", () => {
    expect(distanceToBoundary2D(unitSquare, { x: 5, y: 1 })).toBeCloseTo(1, 9);
    expect(distanceToBoundary2D(unitSquare, { x: 5, y: 5 })).toBeCloseTo(5, 9);
  });

  it("rotates points about the origin", () => {
    const rotated = rotatePoint2D({ x: 1, y: 0 }, 90);
    expect(rotated.x).toBeCloseTo(0, 9);
    expect(rotated.y).toBeCloseTo(1, 9);
    // Four quarter turns return to the start.
    let point = { x: 3, y: 4 };
    for (let i = 0; i < 4; i += 1) point = rotatePoint2D(point, 90);
    expect(point.x).toBeCloseTo(3, 9);
    expect(point.y).toBeCloseTo(4, 9);
  });
});

describe("rectangle fitting", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it("accepts a rectangle well inside", () => {
    expect(rectangleInPolygon(square, 2, 2, 4, 4)).toBe(true);
  });

  it("rejects a rectangle that overhangs", () => {
    expect(rectangleInPolygon(square, 8, 8, 4, 4)).toBe(false);
  });

  it("enforces the setback rather than just containment", () => {
    // A rectangle flush with the boundary is allowed when no setback is asked
    // for, and rejected as soon as one is: that difference is the whole point of
    // the clearance test.
    expect(rectangleInPolygon(square, 1, 1, 4, 4, 0)).toBe(true);
    expect(rectangleInPolygon(square, 1, 1, 4, 4, 0.5)).toBe(true);
    // 0.2 m from the edge cannot satisfy a 0.5 m setback.
    expect(rectangleInPolygon(square, 0.2, 0.2, 4, 4, 0.5)).toBe(false);
    // Nor can a rectangle whose far corner is exactly on the boundary.
    expect(rectangleInPolygon(square, 6, 6, 4, 4, 0.5)).toBe(false);
  });
});

describe("bearings", () => {
  it("reports the dominant edge bearing as a compass angle", () => {
    // A wide east-west rectangle: its long edge runs due east.
    const ring: LngLat[] = [
      [0, 0],
      [0.02, 0],
      [0.02, 0.002],
      [0, 0.002],
      [0, 0],
    ];
    expect(dominantEdgeBearing(ring)).toBeCloseTo(90, 0);
  });

  it("reports a north-south long edge as a bearing near zero or 180", () => {
    const ring: LngLat[] = [
      [0, 0],
      [0.002, 0],
      [0.002, 0.02],
      [0, 0.02],
      [0, 0],
    ];
    const bearing = dominantEdgeBearing(ring);
    expect(Math.min(Math.abs(bearing), Math.abs(bearing - 180), Math.abs(bearing - 360))).toBeLessThan(
      2,
    );
  });
});

describe("ring validity", () => {
  it("accepts a simple square", () => {
    expect(isSimpleRing(degreeSquare(0, 0, 0.01))).toBe(true);
  });

  it("rejects a bow-tie", () => {
    // The classic self-intersection: swapping two vertices crosses the edges.
    const bowTie: LngLat[] = [
      [0, 0],
      [0.01, 0.01],
      [0.01, 0],
      [0, 0.01],
      [0, 0],
    ];
    expect(isSimpleRing(bowTie)).toBe(false);
  });

  it("rejects a ring with too few vertices", () => {
    expect(
      isSimpleRing([
        [0, 0],
        [0.01, 0],
        [0, 0],
      ]),
    ).toBe(false);
  });

  it("accepts a concave but simple polygon", () => {
    const lShape: LngLat[] = [
      [0, 0],
      [0.02, 0],
      [0.02, 0.005],
      [0.005, 0.005],
      [0.005, 0.02],
      [0, 0.02],
      [0, 0],
    ];
    expect(isSimpleRing(lShape)).toBe(true);
  });
});
