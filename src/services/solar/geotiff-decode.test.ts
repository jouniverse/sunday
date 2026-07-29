import { describe, expect, it } from "vitest";
import { FLUX_RAMP, rasterToRgba } from "./geotiff-decode";

describe("Google Solar GeoTIFF palette", () => {
  it("maps nodata and non-finite values to transparent pixels", () => {
    const image = rasterToRgba({
      width: 2,
      height: 1,
      values: Float32Array.from([Number.NaN, -9999]),
      min: 0,
      max: 100,
      nodata: -9999,
      bounds: null,
      method: "test",
    });
    expect(image.data[3]).toBe(0);
    expect(image.data[7]).toBe(0);
  });

  it("ramps low values toward the purple end and high toward amber", () => {
    const image = rasterToRgba(
      {
        width: 2,
        height: 1,
        values: Float32Array.from([0, 100]),
        min: 0,
        max: 100,
        nodata: null,
        bounds: null,
        method: "test",
      },
      FLUX_RAMP,
    );
    const lowR = image.data[0] as number;
    const highR = image.data[4] as number;
    expect(highR).toBeGreaterThan(lowR);
    expect(image.data[3]).toBeGreaterThan(0);
    expect(image.data[7]).toBeGreaterThan(0);
  });

  it("exposes a non-empty flux ramp", () => {
    expect(FLUX_RAMP.length).toBeGreaterThanOrEqual(3);
    expect(FLUX_RAMP[0]?.stop).toBe(0);
    expect(FLUX_RAMP[FLUX_RAMP.length - 1]?.stop).toBe(1);
  });
});
