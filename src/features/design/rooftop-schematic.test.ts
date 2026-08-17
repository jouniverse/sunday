import { describe, expect, it } from "vitest";
import type { Site } from "@/core/store/siteStore";
import { ringToLocalFrame } from "@/domain/geometry";
import { moduleById } from "@/domain/packing/priors";
import { packRooftop } from "@/domain/packing/rooftop";
import { buildRooftopSchematicSvg, packingModulesToLngLat } from "./rooftop-schematic";

const MODULE = moduleById("mono-450");
if (!MODULE) throw new Error("MODULE_LIBRARY is missing mono-450");

const RING: [number, number][] = [
  [-118.17, 35.05],
  [-118.1699, 35.05],
  [-118.1699, 35.05008],
  [-118.17, 35.05008],
];

const site: Site = {
  id: "roof-1",
  name: "Test roof",
  kind: "rooftop",
  ring: RING,
  centre: [-118.16995, 35.05004],
  createdAt: "2026-08-17T00:00:00Z",
  areaM2: 80,
  perimeterM: 36,
  geometryValid: true,
  nudges: [],
  notes: "",
};

describe("rooftop packing schematic helpers", () => {
  it("projects packed modules back to closed lng/lat rings", () => {
    const { polygon } = ringToLocalFrame(RING);
    const packing = packRooftop({
      roof: polygon,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    expect(packing.moduleCount).toBeGreaterThan(0);
    const rings = packingModulesToLngLat(site, packing);
    expect(rings).toHaveLength(packing.moduleCount);
    for (const ring of rings) {
      expect(ring.length).toBe(5);
      expect(ring[0]).toEqual(ring[4]);
    }
  });

  it("builds an inline SVG schematic for HTML export", () => {
    const { polygon } = ringToLocalFrame(RING);
    const packing = packRooftop({
      roof: polygon,
      module: MODULE,
      orientation: "portrait",
      gridRotationDegrees: 0,
    });
    const svg = buildRooftopSchematicSvg({ site, packing });
    expect(svg).toContain("<svg");
    expect(svg).toContain(`${packing.moduleCount} modules`);
    expect(svg).toContain("path");
  });
});
