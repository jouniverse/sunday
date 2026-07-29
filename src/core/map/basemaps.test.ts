import { describe, expect, it } from "vitest";
import {
  availableBasemaps,
  BASEMAPS,
  basemapById,
  metresPerPixel,
  scaleBarFor,
} from "./basemaps";

describe("basemap registry", () => {
  it("declares attribution for every provider-backed basemap", () => {
    for (const basemap of BASEMAPS) {
      if (basemap.id === "blank") continue;
      expect(basemap.attribution.length).toBeGreaterThan(0);
      expect(basemap.purpose.length).toBeGreaterThan(0);
    }
  });

  it("builds a valid style for every keyless basemap", () => {
    for (const basemap of BASEMAPS.filter((b) => !b.requiresKey)) {
      const style = basemap.build({});
      expect(style.version).toBe(8);
      expect(style.layers.length).toBeGreaterThan(0);
      // A background layer means the canvas never flashes white.
      expect(style.layers[0]?.type).toBe("background");
    }
  });

  it("hides basemaps whose key is missing", () => {
    const withoutKeys = availableBasemaps([]);
    expect(withoutKeys.some((b) => b.id === "terrain-shade")).toBe(false);
    expect(withoutKeys.some((b) => b.id === "satellite")).toBe(true);

    const withKey = availableBasemaps(["maptiler"]);
    expect(withKey.some((b) => b.id === "terrain-shade")).toBe(true);
  });

  it("embeds the key into the terrain style when one is supplied", () => {
    const terrain = basemapById("terrain-shade");
    const style = terrain.build({ maptiler: "TESTKEY" });
    expect(JSON.stringify(style)).toContain("TESTKEY");
    // Terrain basemaps must actually declare a terrain source.
    expect(style.terrain).toBeDefined();
  });

  it("falls back to the first basemap for an unknown id", () => {
    // Cast: the point is behaviour when bad data arrives from a stale project file.
    expect(basemapById("nope" as never).id).toBe("satellite");
  });
});

describe("ground resolution", () => {
  it("matches the known equatorial value at zoom 0", () => {
    expect(metresPerPixel(0, 0)).toBeCloseTo(156_543.034, 2);
  });

  it("halves with each zoom level", () => {
    const z10 = metresPerPixel(10, 0);
    const z11 = metresPerPixel(11, 0);
    expect(z10 / z11).toBeCloseTo(2, 9);
  });

  it("shrinks towards the poles", () => {
    // cos(60) = 0.5, so a pixel covers half as much ground at 60 degrees.
    expect(metresPerPixel(12, 60) / metresPerPixel(12, 0)).toBeCloseTo(0.5, 3);
  });

  it("gives a realistic resolution at a working zoom", () => {
    // Zoom 18 is roughly 0.6 m/px at mid-latitude: about right for reading roofs.
    const mpp = metresPerPixel(18, 35);
    expect(mpp).toBeGreaterThan(0.4);
    expect(mpp).toBeLessThan(0.8);
  });
});

describe("scale bar", () => {
  it("chooses round numbers only", () => {
    for (const zoom of [4, 8, 12, 14, 16, 18, 20]) {
      const bar = scaleBarFor(zoom, 35);
      expect(bar.label).toMatch(/^\d+(\.\d+)? (m|km)$/);
      // The value must be one of the round steps.
      const value = Number.parseFloat(bar.label);
      expect([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]).toContain(value);
    }
  });

  it("never exceeds its pixel budget", () => {
    for (const zoom of [4, 10, 16, 20]) {
      expect(scaleBarFor(zoom, 35, 90).pixels).toBeLessThanOrEqual(90);
    }
  });

  it("shows shorter distances as you zoom in", () => {
    const wide = scaleBarFor(8, 35);
    const close = scaleBarFor(18, 35);
    // Compare in metres.
    const metres = (label: string) =>
      label.endsWith("km") ? Number.parseFloat(label) * 1000 : Number.parseFloat(label);
    expect(metres(close.label)).toBeLessThan(metres(wide.label));
  });

  it("switches to kilometres for long distances", () => {
    expect(scaleBarFor(6, 35).label).toContain("km");
    expect(scaleBarFor(19, 35).label).toContain("m");
  });
});
