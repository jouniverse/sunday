import { describe, expect, it } from "vitest";
import { dataLayerRadiusMeters } from "./google-solar";

describe("dataLayerRadiusMeters", () => {
  it("defaults to 90 m when area is missing", () => {
    expect(dataLayerRadiusMeters(undefined)).toBe(90);
    expect(dataLayerRadiusMeters(null)).toBe(90);
    expect(dataLayerRadiusMeters(0)).toBe(90);
  });

  it("uses √area rounded up to 5 m", () => {
    // 10_000 m² → √ = 100 → already a multiple of 5
    expect(dataLayerRadiusMeters(10_000)).toBe(100);
    // 10_001 → √ ≈ 100.005 → ceil to 105
    expect(dataLayerRadiusMeters(10_001)).toBe(105);
    // 2_500 → √ = 50
    expect(dataLayerRadiusMeters(2_500)).toBe(50);
  });

  it("floors tiny roofs at 25 m", () => {
    expect(dataLayerRadiusMeters(100)).toBe(25); // √ = 10 → would be 10
  });

  it("caps at 175 m so FULL_LAYERS monthly flux stays valid", () => {
    expect(dataLayerRadiusMeters(50_000)).toBe(175); // √ ≈ 224
  });
});
