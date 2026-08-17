import { describe, expect, it } from "vitest";
import { packTroughRows } from "@/domain/csp/trough-rows";
import { buildCspSchematicSvg } from "./csp-schematic-svg";

/** 1 km square around 35°N 3°W. */
const SQUARE: Array<[number, number]> = [
  [-3.005, 34.995],
  [-2.995, 34.995],
  [-2.995, 35.005],
  [-3.005, 35.005],
];

describe("buildCspSchematicSvg", () => {
  it("returns null for an incomplete ring", () => {
    expect(buildCspSchematicSvg({ ring: SQUARE.slice(0, 2), technology: "tower" })).toBeNull();
  });

  it("draws a tower field with a boundary polygon and a tower marker", () => {
    const svg = buildCspSchematicSvg({
      ring: SQUARE,
      technology: "tower",
      heliostatsLocal: [
        { x: 40, y: 10 },
        { x: -20, y: 30 },
      ],
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<polygon");
    expect(svg).toContain("<circle");
    expect(svg).toContain("2 heliostats");
  });

  it("draws trough strips as filled paths", () => {
    const layout = packTroughRows({
      ring: SQUARE,
      rowPitchM: 15,
      apertureM: 5.77,
      rowAzimuthDegrees: 0,
    });
    expect(layout).not.toBeNull();
    const svg = buildCspSchematicSvg({
      ring: SQUARE,
      technology: "trough",
      troughStripsLngLat: layout!.stripsLngLat,
      origin: layout!.origin,
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<polygon");
    expect(svg).toContain("trough strips");
    expect(svg).toMatch(/<path d="M/);
  });
});
