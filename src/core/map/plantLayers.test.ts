import { describe, expect, it } from "vitest";
import type { PlantCentroid } from "@/core/platform";
import { jitterCoLocatedCentroids } from "./plantLayers";

function plant(id: string, lon: number, lat: number): PlantCentroid {
  return {
    id,
    lon,
    lat,
    capacityMw: 10,
    status: "operating",
    technology: "PV",
    country: "USA",
    name: id,
    source: "GEM",
    vintage: "2026-02",
  };
}

describe("jitterCoLocatedCentroids", () => {
  it("leaves a solitary plant on its recorded coordinate", () => {
    const [placed] = jitterCoLocatedCentroids([plant("a", -118.1, 34.2)]);
    expect(placed?.displayLon).toBeCloseTo(-118.1, 6);
    expect(placed?.displayLat).toBeCloseTo(34.2, 6);
    expect(placed?.coLocatedCount).toBe(1);
  });

  it("spreads identical coordinates into a ring and keeps GEM phase ids", () => {
    const placed = jitterCoLocatedCentroids([
      plant("phase-b", -118.5, 35.0),
      plant("phase-a", -118.5, 35.0),
      plant("phase-c", -118.5, 35.0),
    ]);
    expect(placed).toHaveLength(3);
    expect(placed.map((p) => p.id).sort()).toEqual(["phase-a", "phase-b", "phase-c"]);
    expect(placed.every((p) => p.coLocatedCount === 3)).toBe(true);

    // No two display positions should coincide.
    const keys = new Set(placed.map((p) => `${p.displayLon.toFixed(7)},${p.displayLat.toFixed(7)}`));
    expect(keys.size).toBe(3);

    // Ring stays near the true pin (~40 m).
    for (const p of placed) {
      const dLonM = (p.displayLon - -118.5) * 111_320 * Math.cos((35 * Math.PI) / 180);
      const dLatM = (p.displayLat - 35.0) * 110_540;
      const dist = Math.hypot(dLonM, dLatM);
      expect(dist).toBeGreaterThan(30);
      expect(dist).toBeLessThan(55);
    }
  });

  it("groups near-identical coordinates that only differ by GPS noise", () => {
    // Same when rounded to 5 decimals; differ only in the 6th+ place.
    const placed = jitterCoLocatedCentroids([
      plant("a", -118.1234541, 35.1234541),
      plant("b", -118.1234549, 35.1234549),
    ]);
    expect(placed.every((p) => p.coLocatedCount === 2)).toBe(true);
    // Two-point ring is north/south of centre — lon matches, lat differs.
    expect(placed[0]?.displayLat).not.toBeCloseTo(placed[1]?.displayLat ?? 0, 7);
  });
});
