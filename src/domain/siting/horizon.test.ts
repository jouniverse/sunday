import { describe, expect, it } from "vitest";
import {
  interpolateHorizonElevation,
  solarTimezoneFromLongitude,
  sunBlockedByHorizon,
  sunPathTraceKind,
} from "./horizon";

const RIDGE = [
  { azimuth: 0, elevationDegrees: 2 },
  { azimuth: 90, elevationDegrees: 20 },
  { azimuth: 180, elevationDegrees: 2 },
  { azimuth: 270, elevationDegrees: 4 },
];

describe("solarTimezoneFromLongitude", () => {
  it("uses longitude/15 hours from UTC", () => {
    expect(solarTimezoneFromLongitude(-118)).toBe("Etc/GMT+8");
    expect(solarTimezoneFromLongitude(133)).toBe("Etc/GMT-9");
    expect(solarTimezoneFromLongitude(0)).toBe("UTC");
  });
});

describe("sunPathTraceKind", () => {
  it("treats June as high-sun in the north and low-sun in the south", () => {
    expect(sunPathTraceKind("2023-06-21", 35)).toBe("high");
    expect(sunPathTraceKind("2023-06-21", -33)).toBe("low");
    expect(sunPathTraceKind("2023-12-21", 35)).toBe("low");
    expect(sunPathTraceKind("2023-12-21", -33)).toBe("high");
    expect(sunPathTraceKind("2023-03-20", 35)).toBe("equinox");
  });
});

describe("interpolateHorizonElevation", () => {
  it("returns the sample on a bin centre", () => {
    expect(interpolateHorizonElevation(RIDGE, 90)).toBe(20);
  });

  it("interpolates between bins and wraps 0/360", () => {
    const mid = interpolateHorizonElevation(RIDGE, 45);
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(20);
    const wrap = interpolateHorizonElevation(RIDGE, 350);
    expect(wrap).not.toBeNull();
    expect(wrap!).toBeGreaterThan(1);
  });
});

describe("sunBlockedByHorizon", () => {
  it("flags sun below the terrain maskangle", () => {
    expect(sunBlockedByHorizon(10, 20)).toBe(true);
    expect(sunBlockedByHorizon(25, 20)).toBe(false);
  });
});
