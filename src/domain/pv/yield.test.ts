import { describe, expect, it } from "vitest";
import { equatorFacingAzimuth } from "../units";
import {
  estimateAnnualYield,
  optimalTiltFirstOrder,
  temperatureDerate,
  transpositionFactor,
} from "./yield";

describe("transposition factor", () => {
  it("is exactly neutral for a horizontal surface", () => {
    // A flat plane receives horizontal irradiance by definition.
    for (const latitude of [0, 20, 40, 60]) {
      expect(transpositionFactor(0, 180, latitude)).toBeCloseTo(1, 6);
    }
  });

  it("gains from tilting towards the equator", () => {
    const flat = transpositionFactor(0, 180, 45);
    const tilted = transpositionFactor(40, 180, 45);
    expect(tilted).toBeGreaterThan(flat);
  });

  it("loses from tilting away from the equator", () => {
    const towards = transpositionFactor(35, 180, 40);
    const away = transpositionFactor(35, 0, 40);
    expect(away).toBeLessThan(towards);
  });

  it("mirrors between hemispheres", () => {
    const north = transpositionFactor(35, 180, 40);
    const south = transpositionFactor(35, 0, -40);
    expect(south).toBeCloseTo(north, 6);
  });

  it("rewards steeper tilt at higher latitude", () => {
    // At 60 degrees a steep array collects much more than at 20 degrees.
    const highLatGain = transpositionFactor(50, 180, 60) / transpositionFactor(0, 180, 60);
    const lowLatGain = transpositionFactor(50, 180, 15) / transpositionFactor(0, 180, 15);
    expect(highLatGain).toBeGreaterThan(lowLatGain);
  });

  it("treats east and west symmetrically", () => {
    expect(transpositionFactor(30, 90, 40)).toBeCloseTo(transpositionFactor(30, 270, 40), 6);
  });

  it("stays within physically sensible bounds", () => {
    for (const tilt of [0, 15, 30, 45, 60, 90]) {
      for (const azimuth of [0, 90, 180, 270]) {
        for (const latitude of [-60, -30, 0, 30, 60]) {
          const factor = transpositionFactor(tilt, azimuth, latitude);
          expect(factor).toBeGreaterThan(0.3);
          // A tilted plane cannot collect more than about twice the horizontal.
          expect(factor).toBeLessThan(2.2);
        }
      }
    }
  });

  it("does not care about azimuth when flat", () => {
    // A horizontal plane has no orientation, so all azimuths must agree.
    const factors = [0, 90, 180, 270].map((azimuth) => transpositionFactor(0, azimuth, 45));
    for (const factor of factors) {
      expect(factor).toBeCloseTo(factors[0] as number, 9);
    }
  });
});

describe("temperature derate", () => {
  it("is zero when cells sit at standard test conditions", () => {
    // 25 C cell temperature means 0 C ambient with the 25 C rise.
    expect(temperatureDerate(0, -0.0035)).toBeCloseTo(0, 9);
  });

  it("grows with ambient temperature", () => {
    const mild = temperatureDerate(10, -0.0035);
    const hot = temperatureDerate(35, -0.0035);
    expect(hot).toBeGreaterThan(mild);
  });

  it("scales with the module's power coefficient", () => {
    const sensitive = temperatureDerate(25, -0.0045);
    const flat = temperatureDerate(25, -0.0025);
    expect(sensitive).toBeGreaterThan(flat);
  });

  it("produces a realistic derate for a hot desert site", () => {
    // 30 C ambient, 55 C cells, -0.35%/C: about 10.5%.
    expect(temperatureDerate(30, -0.0035)).toBeCloseTo(0.105, 3);
  });

  it("never returns a negative derate", () => {
    expect(temperatureDerate(-20, -0.0035)).toBe(0);
  });
});

describe("annual yield", () => {
  const mojave = {
    ghiKwhM2Year: 2100,
    capacityKwDc: 1000,
    surfaceTiltDegrees: 30,
    surfaceAzimuthDegrees: 180,
    latitude: 35,
    meanAmbientTempC: 20,
  };

  it("produces a specific yield in the range real plants report", () => {
    const result = estimateAnnualYield(mojave);
    // Desert US sites report roughly 1600-2000 kWh/kWp.
    expect(result.specificYieldKwhPerKwp).toBeGreaterThan(1400);
    expect(result.specificYieldKwhPerKwp).toBeLessThan(2200);
  });

  it("produces a capacity factor in the range real plants report", () => {
    const result = estimateAnnualYield(mojave);
    expect(result.capacityFactor).toBeGreaterThan(0.15);
    expect(result.capacityFactor).toBeLessThan(0.32);
  });

  it("produces a performance ratio in the range real plants report", () => {
    const result = estimateAnnualYield(mojave);
    // Well-built utility plants sit around 0.75-0.85.
    expect(result.breakdown.performanceRatio).toBeGreaterThan(0.7);
    expect(result.breakdown.performanceRatio).toBeLessThan(0.9);
  });

  it("scales linearly with capacity", () => {
    const small = estimateAnnualYield({ ...mojave, capacityKwDc: 10 });
    const large = estimateAnnualYield({ ...mojave, capacityKwDc: 10_000 });
    expect(large.annualKwh / small.annualKwh).toBeCloseTo(1000, 6);
    // Specific yield is capacity-independent.
    expect(large.specificYieldKwhPerKwp).toBeCloseTo(small.specificYieldKwhPerKwp, 9);
  });

  it("scales linearly with irradiation", () => {
    const dim = estimateAnnualYield({ ...mojave, ghiKwhM2Year: 1000 });
    const bright = estimateAnnualYield({ ...mojave, ghiKwhM2Year: 2000 });
    expect(bright.annualKwh / dim.annualKwh).toBeCloseTo(2, 9);
  });

  it("gives a sunnier site a higher yield at the same capacity", () => {
    const helsinki = estimateAnnualYield({
      ...mojave,
      ghiKwhM2Year: 980,
      latitude: 60,
      surfaceTiltDegrees: 45,
      meanAmbientTempC: 8,
    });
    const result = estimateAnnualYield(mojave);
    expect(result.annualKwh).toBeGreaterThan(helsinki.annualKwh);
    // But the cooler site converts what it gets slightly more efficiently.
    expect(helsinki.breakdown.temperatureDerate).toBeLessThan(
      result.breakdown.temperatureDerate,
    );
  });

  it("reduces yield for shading and system losses", () => {
    const clean = estimateAnnualYield({ ...mojave, systemLosses: 0.1, shadingLoss: 0 });
    const shaded = estimateAnnualYield({ ...mojave, systemLosses: 0.1, shadingLoss: 0.1 });
    expect(shaded.annualKwh).toBeCloseTo(clean.annualKwh * 0.9, 6);
  });

  it("exposes every term of the calculation", () => {
    const result = estimateAnnualYield(mojave);
    const { breakdown } = result;
    expect(breakdown.poaKwhM2Year).toBeCloseTo(
      breakdown.ghiKwhM2Year * breakdown.transpositionFactor,
      6,
    );
    // The reported energy must equal the product of the reported terms.
    expect(result.annualKwh).toBeCloseTo(
      breakdown.poaKwhM2Year * mojave.capacityKwDc * breakdown.performanceRatio,
      6,
    );
  });

  it("labels itself first-order and says how to do better", () => {
    const result = estimateAnnualYield(mojave);
    expect(result.fidelity).toBe("first_order");
    expect(result.caveats.join(" ")).toContain("solar engine");
  });

  it("warns about a high temperature derate", () => {
    const result = estimateAnnualYield({ ...mojave, meanAmbientTempC: 40, gammaPdc: -0.0045 });
    expect(result.caveats.join(" ")).toContain("Temperature derate");
  });

  it("returns zero without pretending for empty inputs", () => {
    expect(estimateAnnualYield({ ...mojave, capacityKwDc: 0 }).annualKwh).toBe(0);
    expect(estimateAnnualYield({ ...mojave, ghiKwhM2Year: 0 }).annualKwh).toBe(0);
    expect(estimateAnnualYield({ ...mojave, ghiKwhM2Year: 0 }).method).toContain("no yield");
  });
});

describe("first-order optimal tilt", () => {
  it("recommends a tilt that rises with latitude", () => {
    const tropical = optimalTiltFirstOrder(10);
    const temperate = optimalTiltFirstOrder(40);
    const northern = optimalTiltFirstOrder(60);
    expect(temperate.tilt).toBeGreaterThan(tropical.tilt);
    expect(northern.tilt).toBeGreaterThan(temperate.tilt);
  });

  it("recommends a near-flat array at the equator", () => {
    expect(optimalTiltFirstOrder(0).tilt).toBeLessThan(12);
  });

  it("returns a band because the optimum is flat", () => {
    const result = optimalTiltFirstOrder(40);
    expect(result.bandMax).toBeGreaterThan(result.bandMin);
    expect(result.tilt).toBeGreaterThanOrEqual(result.bandMin);
    expect(result.tilt).toBeLessThanOrEqual(result.bandMax);
  });

  it("agrees with its own transposition factor", () => {
    const latitude = 45;
    const result = optimalTiltFirstOrder(latitude);
    const atOptimum = transpositionFactor(result.tilt, equatorFacingAzimuth(latitude), latitude);
    expect(atOptimum).toBeCloseTo(result.factor, 9);
    // And no other tilt beats it.
    for (const tilt of [0, 10, 20, 30, 50, 60, 70]) {
      expect(transpositionFactor(tilt, equatorFacingAzimuth(latitude), latitude)).toBeLessThanOrEqual(
        result.factor + 1e-9,
      );
    }
  });

  it("mirrors between hemispheres", () => {
    expect(optimalTiltFirstOrder(-40).tilt).toBe(optimalTiltFirstOrder(40).tilt);
  });

  it("says it is a first-order search", () => {
    expect(optimalTiltFirstOrder(40).method).toContain("First-order");
  });
});
