import { describe, expect, it } from "vitest";
import {
  azimuthDifference,
  capacityFactor,
  compassPoint,
  equatorFacingAzimuth,
  formatCoordinates,
  formatPercent,
  m2ToAcres,
  m2ToHectares,
  normaliseAzimuth,
  scaleArea,
  scaleEnergy,
  scaleMoney,
  scalePower,
  slopeDegreesToPercent,
  slopePercentToDegrees,
  specificYield,
  toDegrees,
  toRadians,
} from "./units";

describe("angles", () => {
  it("round-trips degrees and radians", () => {
    for (const degrees of [0, 23.5, 45, 90, 180, 359.9]) {
      expect(toDegrees(toRadians(degrees))).toBeCloseTo(degrees, 10);
    }
  });

  it("normalises azimuths into a single turn", () => {
    expect(normaliseAzimuth(0)).toBe(0);
    expect(normaliseAzimuth(360)).toBe(0);
    expect(normaliseAzimuth(450)).toBe(90);
    expect(normaliseAzimuth(-90)).toBe(270);
    expect(normaliseAzimuth(-370)).toBeCloseTo(350, 10);
  });

  it("measures azimuth difference across north", () => {
    // The failure this guards against: 350 and 10 are 20 degrees apart, not 340.
    expect(azimuthDifference(350, 10)).toBeCloseTo(20, 10);
    expect(azimuthDifference(10, 350)).toBeCloseTo(20, 10);
    expect(azimuthDifference(0, 180)).toBe(180);
    expect(azimuthDifference(180, 180)).toBe(0);
  });

  it("faces the equator in both hemispheres", () => {
    expect(equatorFacingAzimuth(35)).toBe(180);
    expect(equatorFacingAzimuth(-35)).toBe(0);
    expect(equatorFacingAzimuth(0)).toBe(180);
  });

  it("labels compass points", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(180)).toBe("S");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(270)).toBe("W");
    expect(compassPoint(202.5)).toBe("SSW");
    // Wraps back to north rather than falling off the end of the table.
    expect(compassPoint(359)).toBe("N");
  });
});

describe("areas", () => {
  it("converts between area units", () => {
    expect(m2ToHectares(10_000)).toBe(1);
    // One acre is 4046.856 m2; the classic 5-10 acres/MW rule depends on this.
    expect(m2ToAcres(4046.8564224)).toBeCloseTo(1, 9);
  });

  it("scales area to the unit a planner would use", () => {
    expect(scaleArea(500)).toEqual({ value: "500", unit: "m²" });
    expect(scaleArea(842_000).unit).toBe("ha");
    expect(scaleArea(842_000).value).toBe("84.20");
    expect(scaleArea(25_000_000).unit).toBe("km²");
  });
});

describe("slope", () => {
  it("converts slope between degrees and percent", () => {
    expect(slopeDegreesToPercent(45)).toBeCloseTo(100, 9);
    expect(slopeDegreesToPercent(0)).toBe(0);
    // The utility-PV screening limit of ~3-5% is a shallow angle.
    expect(slopePercentToDegrees(5)).toBeCloseTo(2.862, 3);
  });

  it("round-trips slope conversions", () => {
    for (const percent of [0, 1, 3, 5, 10, 30]) {
      expect(slopeDegreesToPercent(slopePercentToDegrees(percent))).toBeCloseTo(percent, 9);
    }
  });
});

describe("energy metrics", () => {
  it("computes capacity factor against a full year", () => {
    // 1 kW running flat out all year is 8760 kWh, so that is a factor of 1.
    expect(capacityFactor(8760, 1)).toBeCloseTo(1, 10);
    expect(capacityFactor(1752, 1)).toBeCloseTo(0.2, 10);
    expect(capacityFactor(1000, 0)).toBe(0);
  });

  it("computes specific yield per installed kW", () => {
    expect(specificYield(190_000, 100)).toBe(1900);
    expect(specificYield(100, 0)).toBe(0);
  });
});

describe("formatting", () => {
  it("scales power through kW, MW and GW", () => {
    expect(scalePower(4.5)).toEqual({ value: "4.50", unit: "kW" });
    expect(scalePower(850)).toEqual({ value: "850.0", unit: "kW" });
    expect(scalePower(8280)).toEqual({ value: "8.28", unit: "MW" });
    expect(scalePower(2_500_000)).toEqual({ value: "2.50", unit: "GW" });
  });

  it("scales energy through MWh, GWh and TWh", () => {
    expect(scaleEnergy(750)).toEqual({ value: "750", unit: "kWh" });
    expect(scaleEnergy(14_200_000)).toEqual({ value: "14.20", unit: "GWh" });
    expect(scaleEnergy(2.4e9)).toEqual({ value: "2.40", unit: "TWh" });
  });

  it("scales money for capital costs", () => {
    expect(scaleMoney(12_400_000)).toEqual({ value: "$12.40", unit: "M" });
    expect(scaleMoney(24_500)).toEqual({ value: "$24.5", unit: "k" });
    expect(scaleMoney(900)).toEqual({ value: "$900", unit: "" });
  });

  it("renders coordinates with hemispheres", () => {
    expect(formatCoordinates(34.0522, -118.2437)).toBe("34.0522° N, 118.2437° W");
    expect(formatCoordinates(-33.8688, 151.2093)).toBe("33.8688° S, 151.2093° E");
  });

  it("shows an em dash rather than NaN for missing values", () => {
    expect(scalePower(Number.NaN).value).toBe("—");
    expect(scaleEnergy(Number.POSITIVE_INFINITY).value).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });

  it("formats fractions as percentages", () => {
    expect(formatPercent(0.685, 1)).toBe("68.5%");
    expect(formatPercent(1)).toBe("100.0%");
  });
});
