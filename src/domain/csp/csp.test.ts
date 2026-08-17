import { describe, expect, it } from "vitest";
import { delsolSpacingSketch } from "./delsol-spacing";
import { cspDesignEnvelope, cspPlantInputsStale, defaultTowerParameters, defaultTroughParameters } from "./envelope";
import { heliostatsFromLocalXy } from "./local-frame";
import { packTroughRows } from "./trough-rows";

/** 1 km square around 35°N 3°W. */
const SQUARE: Array<[number, number]> = [
  [-3.005, 34.995],
  [-2.995, 34.995],
  [-2.995, 35.005],
  [-3.005, 35.005],
];

describe("cspDesignEnvelope", () => {
  it("bounds rated power from site area", () => {
    const small = cspDesignEnvelope(50_000);
    expect(small.ratedMwe.suggested).toBeGreaterThanOrEqual(1);
    expect(small.ratedMwe.max).toBeGreaterThan(small.ratedMwe.min);
    expect(small.solarMultiple.suggested).toBeGreaterThanOrEqual(small.solarMultiple.recommendedMin);
  });

  it("defaults are inside the envelope", () => {
    const env = cspDesignEnvelope(200_000);
    const tower = defaultTowerParameters(200_000);
    expect(tower.technology).toBe("tower");
    expect(tower.ratedMwe).toBeGreaterThanOrEqual(env.ratedMwe.min);
    expect(tower.ratedMwe).toBeLessThanOrEqual(env.ratedMwe.max);
    const trough = defaultTroughParameters(200_000);
    expect(trough.technology).toBe("trough");
    expect(trough.rowAzimuthDegrees).toBe(0);
    expect(tower.landUnavailableFraction).toBe(0.1);
    expect(trough.landUnavailableFraction).toBe(0.1);
  });
});

describe("delsolSpacingSketch", () => {
  it("places heliostats inside the ring and labels the method", () => {
    const layout = delsolSpacingSketch({
      ring: SQUARE,
      towerHeightM: 150,
      heliostatWidthM: 12.2,
      heliostatHeightM: 12.2,
    });
    expect(layout).not.toBeNull();
    expect(layout!.method).toBe("delsol-spacing-sketch");
    expect(layout!.heliostatCount).toBeGreaterThan(10);
    expect(layout!.positionsLngLat.length).toBe(layout!.heliostatCount);
  });

  it("changes the field when layout method is cornfield", () => {
    const radial = delsolSpacingSketch({
      ring: SQUARE,
      towerHeightM: 150,
      heliostatWidthM: 12.2,
      heliostatHeightM: 12.2,
      layoutMethod: "radial_stagger",
    });
    const cornfield = delsolSpacingSketch({
      ring: SQUARE,
      towerHeightM: 150,
      heliostatWidthM: 12.2,
      heliostatHeightM: 12.2,
      layoutMethod: "cornfield",
    });
    expect(cornfield!.method).toBe("delsol-cornfield-sketch");
    expect(cornfield!.heliostatCount).toBeGreaterThan(10);
    expect(cornfield!.positionsLocal[0]).not.toEqual(radial!.positionsLocal[0]);
  });

  it("insets the sketch when land is reserved for roads and pads", () => {
    const full = delsolSpacingSketch({
      ring: SQUARE,
      towerHeightM: 150,
      heliostatWidthM: 12.2,
      heliostatHeightM: 12.2,
      landUnavailableFraction: 0,
    });
    const inset = delsolSpacingSketch({
      ring: SQUARE,
      towerHeightM: 150,
      heliostatWidthM: 12.2,
      heliostatHeightM: 12.2,
      landUnavailableFraction: 0.4,
    });
    expect(inset!.heliostatCount).toBeLessThan(full!.heliostatCount);
  });
});

describe("packTroughRows", () => {
  it("packs parallel rows and labels Sunday as the method", () => {
    const layout = packTroughRows({
      ring: SQUARE,
      rowPitchM: 17,
      apertureM: 5.77,
      rowAzimuthDegrees: 0,
    });
    expect(layout).not.toBeNull();
    expect(layout!.method).toBe("sunday-trough-rows");
    expect(layout!.rowCount).toBeGreaterThan(0);
    expect(layout!.stripsLngLat[0]?.length).toBe(4);
  });

  it("packs fewer strips when land is reserved for roads and pads", () => {
    const full = packTroughRows({
      ring: SQUARE,
      rowPitchM: 17,
      apertureM: 5.77,
      rowAzimuthDegrees: 0,
      landUnavailableFraction: 0,
    });
    const inset = packTroughRows({
      ring: SQUARE,
      rowPitchM: 17,
      apertureM: 5.77,
      rowAzimuthDegrees: 0,
      landUnavailableFraction: 0.4,
    });
    expect(inset!.rowCount).toBeLessThan(full!.rowCount);
  });
});

describe("heliostatsFromLocalXy", () => {
  it("clips SolarPILOT XY to the site polygon and keeps the method label", () => {
    const layout = heliostatsFromLocalXy({
      positions: [
        [0, 0],
        [50, 40],
        [50_000, 0],
      ],
      ring: SQUARE,
      heliostatWidthM: 12.2,
      heliostatHeightM: 12.2,
      method: "PySAM.Solarpilot test",
    });
    expect(layout).not.toBeNull();
    expect(layout!.method).toBe("PySAM.Solarpilot test");
    expect(layout!.heliostatCount).toBe(2);
    expect(layout!.positionsLngLat.length).toBe(2);
  });
});

describe("cspPlantInputsStale", () => {
  const base = {
    technology: "trough" as const,
    ratedMwe: 20,
    solarMultiple: 2.2,
    tesHours: 10,
    cooling: "wet" as const,
    landUnavailableFraction: 0.1,
    rowPitchM: 17,
    rowAzimuthDegrees: 0,
  };

  it("is false when knobs match the last estimate", () => {
    expect(cspPlantInputsStale(base, { ...base })).toBe(false);
  });

  it("is true when rated power moved after Estimate", () => {
    expect(cspPlantInputsStale(base, { ...base, ratedMwe: 25 })).toBe(true);
  });
});
