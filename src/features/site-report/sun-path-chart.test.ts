import { describe, expect, it } from "vitest";
import type { SunPathResult } from "@/services/engine/client";
import { buildSunPathChartSvg } from "@/services/export/sun-path-chart";

const SUN: SunPathResult = {
  traces: [
    {
      date: "2023-06-21",
      label: "Summer solstice",
      daylight_hours: 14,
      max_elevation: 78,
      points: [
        { time: "2023-06-21T06:00:00-08:00", elevation: 5, azimuth: 60, aoi: null },
        { time: "2023-06-21T12:00:00-08:00", elevation: 78, azimuth: 180, aoi: null },
        { time: "2023-06-21T18:00:00-08:00", elevation: 5, azimuth: 300, aoi: null },
      ],
    },
    {
      date: "2023-12-21",
      label: "Winter solstice",
      daylight_hours: 10,
      max_elevation: 32,
      points: [
        { time: "2023-12-21T08:00:00-08:00", elevation: 5, azimuth: 120, aoi: null },
        { time: "2023-12-21T12:00:00-08:00", elevation: 32, azimuth: 180, aoi: null },
        { time: "2023-12-21T16:00:00-08:00", elevation: 5, azimuth: 240, aoi: null },
      ],
    },
  ],
  method: {
    engine: "sunday-solar",
    pvlib_version: "0.11",
    solar_position: "NREL SPA (pvlib default)",
    transposition: "not applicable",
    cell_temperature: "not applicable",
    dc_model: "not applicable",
    ac_model: "not applicable",
    weather: "geometry only",
    notes: [],
  },
};

describe("buildSunPathChartSvg", () => {
  it("renders a cartesian svg with solstice traces and optional horizon", () => {
    const svg = buildSunPathChartSvg({
      sunPath: SUN,
      latitude: 35,
      horizon: {
        samples: [
          { azimuth: 0, elevationDegrees: 2 },
          { azimuth: 180, elevationDegrees: 12 },
          { azimuth: 270, elevationDegrees: 4 },
        ],
        radiusM: 20_000,
        method: "terrarium-z10-horizon",
      },
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("High sun");
    expect(svg).toContain("Low sun");
    expect(svg).toContain("polygon");
    expect(svg).toContain("NREL SPA");
  });
});
