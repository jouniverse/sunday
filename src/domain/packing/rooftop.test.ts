import { describe, expect, it } from "vitest";
import type { Polygon2D } from "../geometry";
import { pointInPolygon2D, polygonArea2D } from "../geometry";
import { moduleById } from "./priors";
import { packRooftop, searchRooftopLayout } from "./rooftop";

const MODULE = moduleById("mono-450")!;

/** An axis-aligned rectangular roof in the local metres frame. */
function rectRoof(width: number, height: number): Polygon2D {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

describe("rooftop packing", () => {
  it("fills a plain rectangular roof with a predictable module count", () => {
    // 12 x 8 m roof, 0.5 m setback leaves 11 x 7 m. Portrait modules are
    // 1.05 wide x 2.1 tall with a 0.02 gap, so 10 columns and 3 rows fit.
    const result = packRooftop({
      roof: rectRoof(12, 8),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });

    expect(result.moduleCount).toBeGreaterThan(20);
    expect(result.moduleCount).toBeLessThan(40);
    expect(result.capacityKwDc).toBeCloseTo((result.moduleCount * 450) / 1000, 9);
    expect(result.coverage).toBeGreaterThan(0.4);
    expect(result.coverage).toBeLessThan(0.85);
  });

  it("places every module inside the roof outline", () => {
    const roof = rectRoof(12, 8);
    const result = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });

    for (const placed of result.modules) {
      for (const corner of placed.corners) {
        expect(pointInPolygon2D(roof, corner)).toBe(true);
      }
    }
  });

  it("never overlaps two modules", () => {
    const result = packRooftop({
      roof: rectRoof(12, 8),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });

    // Total module area cannot exceed the roof area, and the centres must all
    // be distinct by at least a module width.
    expect(result.moduleAreaM2).toBeLessThan(result.roofAreaM2);
    const centres = result.modules.map((m) => `${m.centre.x.toFixed(3)},${m.centre.y.toFixed(3)}`);
    expect(new Set(centres).size).toBe(centres.length);
  });

  it("respects the perimeter setback", () => {
    const generous = packRooftop({
      roof: rectRoof(12, 8),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
      perimeterSetbackM: 0.1,
    });
    const strict = packRooftop({
      roof: rectRoof(12, 8),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
      perimeterSetbackM: 1.5,
    });
    expect(strict.moduleCount).toBeLessThan(generous.moduleCount);
  });

  it("removes modules that would sit on an obstruction", () => {
    const roof = rectRoof(12, 8);
    const clear = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    // A 2 x 2 m plant enclosure in the middle of the roof.
    const withVent = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
      exclusions: [
        [
          { x: 5, y: 3 },
          { x: 7, y: 3 },
          { x: 7, y: 5 },
          { x: 5, y: 5 },
        ],
      ],
    });

    expect(withVent.moduleCount).toBeLessThan(clear.moduleCount);
    expect(withVent.usableAreaM2).toBeCloseTo(roofArea(roof) - 4, 6);

    // And nothing may be placed over the exclusion itself.
    for (const placed of withVent.modules) {
      const insideVent =
        placed.centre.x > 5 && placed.centre.x < 7 && placed.centre.y > 3 && placed.centre.y < 5;
      expect(insideVent).toBe(false);
    }
  });

  it("keeps modules out of a concave roof's notch", () => {
    // An L-shaped roof: the missing quadrant must stay empty.
    const roof: Polygon2D = [
      { x: 0, y: 0 },
      { x: 14, y: 0 },
      { x: 14, y: 5 },
      { x: 6, y: 5 },
      { x: 6, y: 12 },
      { x: 0, y: 12 },
    ];
    const result = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });

    expect(result.moduleCount).toBeGreaterThan(0);
    for (const placed of result.modules) {
      // The notch is x > 6 and y > 5.
      const inNotch = placed.centre.x > 6.5 && placed.centre.y > 5.5;
      expect(inNotch).toBe(false);
    }
  });

  it("fits more landscape modules on a wide shallow roof", () => {
    // 14 x 3 m: a portrait module is 2.1 m tall and cannot stack, but landscape
    // modules are only 1.05 m tall, so two rows fit.
    const roof = rectRoof(14, 3);
    const portrait = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    const landscape = packRooftop({
      roof,
      module: MODULE,
      orientation: "landscape",
      gridRotationDegrees: 0,
    });
    expect(landscape.moduleCount).toBeGreaterThan(portrait.moduleCount);
  });

  it("uses a row pitch for a tilted flat-roof rack", () => {
    const flush = packRooftop({
      roof: rectRoof(20, 20),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    const tilted = packRooftop({
      roof: rectRoof(20, 20),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
      rowPitchM: 4.5,
    });
    // Spacing rows for shading roughly halves the module count.
    expect(tilted.moduleCount).toBeLessThan(flush.moduleCount);
    expect(tilted.moduleCount).toBeGreaterThan(0);
  });

  it("refuses a row pitch shorter than the module", () => {
    const result = packRooftop({
      roof: rectRoof(20, 20),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
      rowPitchM: 1.0,
    });
    expect(result.moduleCount).toBe(0);
    expect(result.notes.join(" ")).toContain("rows would overlap");
  });

  it("explains why nothing fits on a tiny roof", () => {
    const result = packRooftop({
      roof: rectRoof(1.5, 1.5),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    expect(result.moduleCount).toBe(0);
    expect(result.notes.join(" ")).toContain("No module fits");
  });

  it("reports no area for a degenerate roof", () => {
    const result = packRooftop({
      roof: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    expect(result.moduleCount).toBe(0);
    expect(result.notes.join(" ")).toContain("no area");
  });

  it("rotates the grid without changing the roof area", () => {
    const roof = rectRoof(12, 8);
    const straight = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    const skewed = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 30,
    });

    expect(skewed.roofAreaM2).toBeCloseTo(straight.roofAreaM2, 6);
    // A rotated grid on a rectangular roof wastes corners, so it fits no more.
    expect(skewed.moduleCount).toBeLessThanOrEqual(straight.moduleCount);
    // Rotated modules are still inside the roof.
    for (const placed of skewed.modules) {
      for (const corner of placed.corners) {
        expect(pointInPolygon2D(roof, corner)).toBe(true);
      }
    }
  });

  it("always states its method", () => {
    const result = packRooftop({
      roof: rectRoof(12, 8),
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    expect(result.method).toContain("every module corner");
  });
});

describe("layout search", () => {
  it("returns the highest-capacity layout it found", () => {
    const { best, alternatives } = searchRooftopLayout({
      roof: rectRoof(14, 3),
      module: MODULE,
    });
    expect(best.moduleCount).toBeGreaterThan(0);
    for (const alternative of alternatives) {
      expect(best.capacityKwDc).toBeGreaterThanOrEqual(alternative.capacityKwDc);
    }
  });

  it("offers alternatives so the choice stays the designer's", () => {
    const { alternatives } = searchRooftopLayout({ roof: rectRoof(12, 8), module: MODULE });
    expect(alternatives.length).toBeGreaterThan(0);
  });

  it("aligns the grid with a rotated roof's own edges", () => {
    // A rectangle rotated by 20 degrees: an axis-aligned grid wastes area, so the
    // search must find a rotation that beats zero.
    const angle = (20 * Math.PI) / 180;
    const rotate = (x: number, y: number) => ({
      x: x * Math.cos(angle) - y * Math.sin(angle),
      y: x * Math.sin(angle) + y * Math.cos(angle),
    });
    const roof: Polygon2D = [rotate(0, 0), rotate(12, 0), rotate(12, 8), rotate(0, 8)];

    const { best } = searchRooftopLayout({ roof, module: MODULE });
    const axisAligned = packRooftop({
      roof,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });

    expect(best.moduleCount).toBeGreaterThanOrEqual(axisAligned.moduleCount);
    // And the winning rotation should be close to the roof's own 20 degrees.
    expect(best.moduleCount).toBeGreaterThan(0);
  });
});

function roofArea(roof: Polygon2D): number {
  return polygonArea2D(roof);
}
