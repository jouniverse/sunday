import { describe, expect, it } from "vitest";
import { toRadians } from "../units";
import {
  computeFillFactor,
  designEnvelope,
  firstOrderShadingLoss,
  gcrFromShadowLimit,
  rowGeometryFromGcr,
  shadowLimitedPitch,
  winterSolsticeNoonElevation,
} from "./ground-mount";
import { GCR_PRIORS, LAND_USE_M2_PER_KW, moduleById } from "./priors";

const MODULE = moduleById("mono-450")!;
const UTILITY_MODULE = moduleById("topcon-620")!;

describe("row geometry", () => {
  it("derives pitch from collector width and coverage ratio", () => {
    const row = rowGeometryFromGcr(MODULE, { tiltDegrees: 25, gcr: 0.5 });
    // A 2.1 m portrait module at GCR 0.5 needs a 4.2 m pitch, by definition.
    expect(row.collectorWidthM).toBeCloseTo(2.1, 10);
    expect(row.pitchM).toBeCloseTo(4.2, 10);
    expect(row.gcr).toBe(0.5);
  });

  it("stacks modules up the slope", () => {
    const row = rowGeometryFromGcr(MODULE, { tiltDegrees: 25, gcr: 0.4, modulesUpSlope: 2 });
    expect(row.collectorWidthM).toBeCloseTo(4.2, 10);
    expect(row.pitchM).toBeCloseTo(10.5, 10);
  });

  it("uses the short edge in landscape orientation", () => {
    const portrait = rowGeometryFromGcr(MODULE, { tiltDegrees: 20, gcr: 0.5 });
    const landscape = rowGeometryFromGcr(MODULE, {
      tiltDegrees: 20,
      gcr: 0.5,
      modulesInPortrait: false,
    });
    expect(landscape.collectorWidthM).toBeCloseTo(MODULE.widthM, 10);
    expect(landscape.collectorWidthM).toBeLessThan(portrait.collectorWidthM);
  });

  it("computes row height and footprint from the tilt triangle", () => {
    const row = rowGeometryFromGcr(MODULE, { tiltDegrees: 30, gcr: 0.4 });
    expect(row.heightM).toBeCloseTo(2.1 * Math.sin(toRadians(30)), 9);
    expect(row.projectedWidthM).toBeCloseTo(2.1 * Math.cos(toRadians(30)), 9);
    // Height squared plus footprint squared is the collector width squared.
    expect(row.heightM ** 2 + row.projectedWidthM ** 2).toBeCloseTo(2.1 ** 2, 9);
  });

  it("gives a flat row zero height and full footprint", () => {
    const row = rowGeometryFromGcr(MODULE, { tiltDegrees: 0, gcr: 0.5 });
    expect(row.heightM).toBeCloseTo(0, 12);
    expect(row.projectedWidthM).toBeCloseTo(2.1, 12);
  });
});

describe("shadow-limited spacing", () => {
  it("needs more pitch as the limiting sun gets lower", () => {
    const high = shadowLimitedPitch(2.1, 25, 40);
    const low = shadowLimitedPitch(2.1, 25, 15);
    expect(low).toBeGreaterThan(high);
  });

  it("needs more pitch as the rack gets steeper", () => {
    const shallow = shadowLimitedPitch(2.1, 10, 20);
    const steep = shadowLimitedPitch(2.1, 40, 20);
    expect(steep).toBeGreaterThan(shallow);
  });

  it("reduces to the projected width for a flat rack", () => {
    // A horizontal row casts no row-to-row shadow, so pitch is just its footprint.
    expect(shadowLimitedPitch(2.1, 0, 20)).toBeCloseTo(2.1, 9);
  });

  it("matches the closed-form shadow geometry", () => {
    const width = 4.2;
    const tilt = 30;
    const elevation = 20;
    const expected =
      width * Math.cos(toRadians(tilt)) +
      (width * Math.sin(toRadians(tilt))) / Math.tan(toRadians(elevation));
    expect(shadowLimitedPitch(width, tilt, elevation)).toBeCloseTo(expected, 9);
  });

  it("stays finite for a sun on the horizon", () => {
    // Without the clamp this diverges and would demand an infinite site.
    expect(Number.isFinite(shadowLimitedPitch(2.1, 30, 0))).toBe(true);
  });

  it("converts a shadow limit into a coverage ratio below one", () => {
    const gcr = gcrFromShadowLimit(2.1, 25, 20);
    expect(gcr).toBeGreaterThan(0);
    expect(gcr).toBeLessThan(1);
  });
});

describe("winter solstice geometry", () => {
  it("gives lower noon sun at higher latitude", () => {
    expect(winterSolsticeNoonElevation(0)).toBeCloseTo(66.56, 2);
    expect(winterSolsticeNoonElevation(35)).toBeCloseTo(31.56, 2);
    expect(winterSolsticeNoonElevation(60)).toBeCloseTo(6.56, 2);
  });

  it("is symmetric between hemispheres", () => {
    expect(winterSolsticeNoonElevation(35)).toBeCloseTo(winterSolsticeNoonElevation(-35), 10);
  });
});

describe("fill factor", () => {
  const baseInput = {
    usableAreaM2: 500_000,
    module: UTILITY_MODULE,
    mount: "fixed_tilt" as const,
    tiltDegrees: 25,
    gcr: 0.45,
  };

  it("produces a capacity consistent with area, coverage and module rating", () => {
    const result = computeFillFactor(baseInput);
    const moduleArea = UTILITY_MODULE.lengthM * UTILITY_MODULE.widthM;
    const expectedModules = Math.floor((500_000 * 0.9 * 0.45) / moduleArea);
    expect(result.moduleCount).toBe(expectedModules);
    expect(result.capacityKwDc).toBeCloseTo((expectedModules * 620) / 1000, 6);
  });

  it("keeps fill factor below the coverage ratio", () => {
    // Fill factor is measured against the whole site, coverage against the array
    // area alone, so the balance-of-system share must make it smaller.
    const result = computeFillFactor(baseInput);
    expect(result.fillFactor).toBeLessThan(result.gcr);
    expect(result.fillFactor).toBeGreaterThan(0);
  });

  it("scales capacity linearly with site area", () => {
    const small = computeFillFactor({ ...baseInput, usableAreaM2: 100_000 });
    const large = computeFillFactor({ ...baseInput, usableAreaM2: 1_000_000 });
    expect(large.capacityKwDc / small.capacityKwDc).toBeCloseTo(10, 1);
    // Density per hectare is scale-invariant.
    expect(large.densityKwPerHectare).toBeCloseTo(small.densityKwPerHectare, 0);
  });

  it("increases capacity with coverage ratio", () => {
    const sparse = computeFillFactor({ ...baseInput, gcr: 0.3 });
    const dense = computeFillFactor({ ...baseInput, gcr: 0.6 });
    expect(dense.capacityKwDc).toBeGreaterThan(sparse.capacityKwDc);
    expect(dense.landUseM2PerKw).toBeLessThan(sparse.landUseM2PerKw);
  });

  it("lands inside built-project land use for a normal design", () => {
    const result = computeFillFactor(baseInput);
    expect(result.landUseM2PerKw).toBeGreaterThan(LAND_USE_M2_PER_KW.directMin);
    expect(result.landUseM2PerKw).toBeLessThan(LAND_USE_M2_PER_KW.directMax);
    expect(result.landUseWithinRuleOfThumb).toBe(true);
    expect(result.notes).toHaveLength(0);
  });

  it("reports total project area above the array-block area", () => {
    const result = computeFillFactor(baseInput);
    // Roads, pads and setbacks roughly double or triple the fenced footprint.
    expect(result.totalProjectLandUseM2PerKw).toBeGreaterThan(result.landUseM2PerKw);
    // And the total should land in the familiar 5-10 acres/MW band.
    expect(result.totalProjectLandUseM2PerKw).toBeGreaterThan(LAND_USE_M2_PER_KW.totalMin);
    expect(result.totalProjectLandUseM2PerKw).toBeLessThan(LAND_USE_M2_PER_KW.totalMax);
  });

  it("flags a design that leaves built-project land use", () => {
    // A very sparse tracker layout uses much more land per kW than built projects.
    const result = computeFillFactor({
      ...baseInput,
      mount: "single_axis",
      gcr: 0.15,
    });
    expect(result.landUseWithinRuleOfThumb).toBe(false);
    expect(result.notes.join(" ")).toContain("above the");
  });

  it("clamps an infeasible coverage ratio and says so", () => {
    const result = computeFillFactor({ ...baseInput, gcr: 0.95 });
    expect(result.gcr).toBe(GCR_PRIORS.fixed_tilt.max);
    expect(result.notes.join(" ")).toContain("outside the feasible range");
  });

  it("returns nothing placeable for a site with no usable area", () => {
    const result = computeFillFactor({ ...baseInput, usableAreaM2: 0 });
    expect(result.capacityKwDc).toBe(0);
    expect(result.moduleCount).toBe(0);
    expect(result.notes.join(" ")).toContain("no usable area");
  });

  it("places fewer watts with a less efficient module in the same area", () => {
    const efficient = computeFillFactor({ ...baseInput, module: UTILITY_MODULE });
    const thinFilm = computeFillFactor({ ...baseInput, module: moduleById("thin-film-380")! });
    // Same ground, same coverage: the higher-efficiency module wins on capacity.
    expect(efficient.capacityKwDc).toBeGreaterThan(thinFilm.capacityKwDc);
  });

  it("always reports its method", () => {
    expect(computeFillFactor(baseInput).method).toContain("Area-based packing");
  });
});

describe("design envelope", () => {
  it("suggests a tilt near latitude for a fixed rack", () => {
    const envelope = designEnvelope(35, MODULE, "fixed_tilt");
    expect(envelope.tilt.suggested).toBeGreaterThan(20);
    expect(envelope.tilt.suggested).toBeLessThanOrEqual(35);
    expect(envelope.tilt.recommendedMin).toBeLessThan(envelope.tilt.suggested);
    expect(envelope.tilt.recommendedMax).toBeGreaterThan(envelope.tilt.suggested);
  });

  it("flattens the suggested tilt at high latitude", () => {
    const mid = designEnvelope(35, MODULE, "fixed_tilt");
    const high = designEnvelope(65, MODULE, "fixed_tilt");
    // Still steeper than mid-latitude, but not the full 65 degrees.
    expect(high.tilt.suggested).toBeGreaterThan(mid.tilt.suggested);
    expect(high.tilt.suggested).toBeLessThan(60);
  });

  it("gives trackers a horizontal rack", () => {
    const envelope = designEnvelope(35, MODULE, "single_axis");
    expect(envelope.tilt.suggested).toBe(0);
    expect(envelope.tilt.max).toBe(0);
    expect(envelope.rationale.join(" ")).toContain("horizontally");
  });

  it("suggests a coverage ratio inside its own recommended band", () => {
    for (const mount of ["fixed_tilt", "single_axis"] as const) {
      const envelope = designEnvelope(35, MODULE, mount);
      expect(envelope.gcr.suggested).toBeGreaterThanOrEqual(envelope.gcr.recommendedMin);
      expect(envelope.gcr.suggested).toBeLessThanOrEqual(envelope.gcr.recommendedMax);
      expect(envelope.gcr.min).toBeLessThan(envelope.gcr.recommendedMin);
      expect(envelope.gcr.max).toBeGreaterThan(envelope.gcr.recommendedMax);
    }
  });

  it("packs trackers less densely than fixed racks", () => {
    const fixed = designEnvelope(35, MODULE, "fixed_tilt");
    const tracker = designEnvelope(35, MODULE, "single_axis");
    expect(tracker.gcr.suggested).toBeLessThan(fixed.gcr.suggested);
  });

  it("keeps pitch and coverage ratio consistent", () => {
    const envelope = designEnvelope(35, MODULE, "fixed_tilt");
    // Pitch at the suggested coverage ratio must equal width / gcr.
    expect(envelope.pitch.suggested).toBeCloseTo(MODULE.lengthM / envelope.gcr.suggested, 1);
    // A denser packing means a shorter pitch.
    expect(envelope.pitch.min).toBeLessThan(envelope.pitch.max);
  });

  it("explains every bound it proposes", () => {
    const rationale = designEnvelope(35, MODULE, "fixed_tilt").rationale.join(" ");
    expect(rationale).toContain("latitude");
    expect(rationale).toContain("shadow");
    expect(rationale).toContain("GM-SEUS");
  });

  it("works at the equator and at high latitude without producing nonsense", () => {
    for (const latitude of [0, 15, 35, 55, 68, -35]) {
      const envelope = designEnvelope(latitude, MODULE, "fixed_tilt");
      expect(Number.isFinite(envelope.pitch.suggested)).toBe(true);
      expect(envelope.pitch.suggested).toBeGreaterThan(0);
      expect(envelope.gcr.suggested).toBeGreaterThan(0);
      expect(envelope.gcr.suggested).toBeLessThan(1);
    }
  });
});

describe("first-order shading loss", () => {
  it("grows with coverage ratio", () => {
    const sparse = firstOrderShadingLoss(0.25, 25, 35);
    const dense = firstOrderShadingLoss(0.6, 25, 35);
    expect(dense.lossFraction).toBeGreaterThan(sparse.lossFraction);
  });

  it("grows with tilt at a fixed coverage ratio", () => {
    const shallow = firstOrderShadingLoss(0.45, 10, 35);
    const steep = firstOrderShadingLoss(0.45, 40, 35);
    expect(steep.lossFraction).toBeGreaterThan(shallow.lossFraction);
  });

  it("is bounded and never negative", () => {
    for (const gcr of [0.05, 0.2, 0.5, 0.75]) {
      for (const tilt of [0, 15, 30, 60]) {
        const { lossFraction } = firstOrderShadingLoss(gcr, tilt, 45);
        expect(lossFraction).toBeGreaterThanOrEqual(0);
        expect(lossFraction).toBeLessThanOrEqual(0.35);
      }
    }
  });

  it("is essentially zero for a flat array", () => {
    expect(firstOrderShadingLoss(0.5, 0, 35).lossFraction).toBeCloseTo(0, 6);
  });

  it("declares itself a first-order estimate", () => {
    expect(firstOrderShadingLoss(0.45, 25, 35).method).toContain("First-order");
  });
});
