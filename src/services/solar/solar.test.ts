/**
 * API client tests against golden fixtures.
 *
 * The fixtures are trimmed versions of real response shapes, taken from the
 * documented structures in `notes/postman` and the API docs. They exist to catch
 * parsing regressions — a unit confusion or a renamed key — without hitting a
 * live public service in CI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHttpCache } from "../http/client";
import { fetchNasaPowerClimatology } from "./nasa-power";
import { fetchNlrResource, fetchPvWatts, redactKey } from "./nlr";
import { generateSiteReport } from "./orchestrator";
import {
  climatologyFromMrcalc,
  fetchPvgisPerformance,
  fetchPvgisRadiation,
  fromPvgisAzimuth,
  toPvgisAzimuth,
} from "./pvgis";
import { compareValues } from "./types";

/** Installs a fetch stub that answers by URL substring. */
function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      return new Response("no stub", { status: 404, statusText: "Not Found" });
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  clearHttpCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* --- PVGIS ---------------------------------------------------------------- */

const PVGIS_MRCALC = {
  meta: { inputs: { meteo_data: { radiation_db: "PVGIS-SARAH3" } } },
  outputs: {
    monthly: Array.from({ length: 12 }, (_, index) => ({
      month: index + 1,
      // 150 kWh/m2 a month is 1800 a year: a sunny site.
      "H(h)_m": 150,
      "Hb(n)_m": 190,
      "Hd(h)_m": 55,
      T2m: 18,
    })),
  },
};

const PVGIS_PVCALC = {
  inputs: {
    mounting_system: { fixed: { slope: { value: 31 }, azimuth: { value: -2 } } },
    meteo_data: { radiation_db: "PVGIS-SARAH3", year_min: 2005, year_max: 2023 },
  },
  outputs: {
    monthly: {
      fixed: Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        E_m: 150,
        "H(i)_m": 175,
      })),
    },
    totals: { fixed: { E_y: 1800, "H(i)_y": 2100, SD_y: 90, l_total: -14 } },
  },
};

describe("PVGIS azimuth convention", () => {
  it("converts Sunday's north-referenced azimuth to PVGIS's south-referenced one", () => {
    // This conversion silently broke earlier reference apps, hence the explicit test.
    expect(toPvgisAzimuth(180)).toBe(0); // due south
    expect(toPvgisAzimuth(90)).toBe(-90); // due east
    expect(toPvgisAzimuth(270)).toBe(90); // due west
    expect(toPvgisAzimuth(0)).toBe(180); // due north
  });

  it("round-trips through both conversions", () => {
    for (const azimuth of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect(fromPvgisAzimuth(toPvgisAzimuth(azimuth))).toBeCloseTo(azimuth, 9);
    }
  });

  it("keeps PVGIS azimuths inside its own range", () => {
    for (const azimuth of [0, 90, 180, 270, 359]) {
      const converted = toPvgisAzimuth(azimuth);
      expect(converted).toBeGreaterThan(-181);
      expect(converted).toBeLessThanOrEqual(180);
    }
  });
});

describe("PVGIS radiation", () => {
  it("sums monthly radiation into annual totals", async () => {
    stubFetch([{ match: "MRcalc", body: PVGIS_MRCALC }]);
    const report = await fetchPvgisRadiation({ latitude: 35, longitude: -118 });

    expect(report.ghiKwhM2Year).toBeCloseTo(1800, 6);
    expect(report.dniKwhM2Year).toBeCloseTo(2280, 6);
    expect(report.dhiKwhM2Year).toBeCloseTo(660, 6);
    expect(report.meanAirTempC).toBeCloseTo(18, 6);
    expect(report.monthlyGhi).toHaveLength(12);
    expect(report.monthlyDni).toHaveLength(12);
    expect(report.monthlyDni?.every((point) => point.value === 190)).toBe(true);
    expect(report.dataset).toBe("PVGIS-SARAH3");
    expect(report.fidelity).toBe("modelled");
  });

  it("averages multi-year MRcalc rows into a 12-month climatology", async () => {
    // Real MRcalc returns one row per month per year (e.g. 19×12), not 12 means.
    const monthly = [2020, 2021].flatMap((year) =>
      Array.from({ length: 12 }, (_, index) => ({
        year,
        month: index + 1,
        "H(h)_m": year === 2020 ? 100 : 200,
        "Hb(n)_m": 150,
        "Hd(h)_m": 40,
        T2m: 10,
      })),
    );
    stubFetch([{ match: "MRcalc", body: { outputs: { monthly }, meta: PVGIS_MRCALC.meta } }]);
    const report = await fetchPvgisRadiation({ latitude: 35, longitude: -118 });

    expect(report.monthlyGhi).toHaveLength(12);
    expect(report.monthlyGhi?.every((point) => point.value === 150)).toBe(true);
    expect(report.ghiKwhM2Year).toBeCloseTo(1800, 6);
    expect(report.method).toContain("2020–2021");
  });

  it("explains a location outside coverage instead of returning zeros", async () => {
    stubFetch([{ match: "MRcalc", body: { outputs: { monthly: [] } } }]);
    await expect(fetchPvgisRadiation({ latitude: 85, longitude: 0 })).rejects.toMatchObject({
      guidance: expect.stringContaining("NASA POWER"),
    });
  });
});

describe("climatologyFromMrcalc", () => {
  it("keeps a single-year series as twelve months", () => {
    const climate = climatologyFromMrcalc(PVGIS_MRCALC.outputs.monthly);
    expect(climate.monthlyGhi).toHaveLength(12);
    expect(climate.monthlyDni).toHaveLength(12);
    expect(climate.ghiKwhM2Year).toBeCloseTo(1800, 6);
    expect(climate.sampleYears).toBe(1);
  });
});

describe("PVGIS performance", () => {
  it("reads annual yield, in-plane irradiation and the optimised angles", async () => {
    stubFetch([{ match: "PVcalc", body: PVGIS_PVCALC }]);
    const report = await fetchPvgisPerformance({
      latitude: 35,
      longitude: -118,
      peakPowerKw: 1,
      optimise: true,
    });

    expect(report.specificYieldKwhPerKwp).toBeCloseTo(1800, 6);
    expect(report.poaKwhM2Year).toBeCloseTo(2100, 6);
    expect(report.optimalTiltDegrees).toBe(31);
    // PVGIS reported -2 degrees from south, which is 178 from north.
    expect(report.optimalAzimuthDegrees).toBeCloseTo(178, 6);
    expect(report.vintage).toBe("2005–2023");
  });

  it("normalises yield by the requested capacity", async () => {
    stubFetch([{ match: "PVcalc", body: PVGIS_PVCALC }]);
    const report = await fetchPvgisPerformance({
      latitude: 35,
      longitude: -118,
      peakPowerKw: 100,
    });
    // The stub reports 1800 kWh total; at 100 kW that is 18 kWh/kWp.
    expect(report.specificYieldKwhPerKwp).toBeCloseTo(18, 6);
  });

  it("surfaces interannual variability as a caveat", async () => {
    stubFetch([{ match: "PVcalc", body: PVGIS_PVCALC }]);
    const report = await fetchPvgisPerformance({ latitude: 35, longitude: -118 });
    expect(report.caveats.join(" ")).toContain("Year-to-year variability is ±5.0%");
  });
});

/* --- NASA POWER ----------------------------------------------------------- */

const POWER_CLIMATOLOGY = {
  header: { sources: ["CERES", "MERRA2"], start: 2001, end: 2020 },
  geometry: { coordinates: [-118.5, 35.5, 0] },
  properties: {
    parameter: {
      // 5 kWh/m2/day: about 1826 kWh/m2/year.
      ALLSKY_SFC_SW_DWN: monthly(5),
      ALLSKY_SFC_SW_DNI: monthly(6),
      ALLSKY_SFC_SW_DIFF: monthly(1.5),
      T2M: { ...monthly(17), ANN: 17 },
      CLOUD_AMT: { ...monthly(42), ANN: 42 },
      SI_TILTED_AVG_OPTIMAL: monthly(5.8),
      SI_TILTED_AVG_OPTIMAL_ANG: { ...monthly(30), ANN: 30 },
    },
  },
};

function monthly(value: number): Record<string, number> {
  return {
    JAN: value,
    FEB: value,
    MAR: value,
    APR: value,
    MAY: value,
    JUN: value,
    JUL: value,
    AUG: value,
    SEP: value,
    OCT: value,
    NOV: value,
    DEC: value,
  };
}

describe("NASA POWER", () => {
  it("scales daily means by month length rather than summing them", async () => {
    stubFetch([{ match: "climatology/point", body: POWER_CLIMATOLOGY }]);
    const report = await fetchNasaPowerClimatology({ latitude: 35, longitude: -118 });

    // 5 kWh/m2/day over 365.25 days is about 1826, not 60.
    expect(report.ghiKwhM2Year).toBeGreaterThan(1800);
    expect(report.ghiKwhM2Year).toBeLessThan(1840);
    expect(report.dniKwhM2Year).toBeGreaterThan(2100);
    expect(report.monthlyDni).toHaveLength(12);
    expect(report.meanAirTempC).toBe(17);
    expect(report.optimalTiltDegrees).toBe(30);
  });

  it("states which grid cell answered", async () => {
    stubFetch([{ match: "climatology/point", body: POWER_CLIMATOLOGY }]);
    const report = await fetchNasaPowerClimatology({ latitude: 35, longitude: -118 });
    const caveats = report.caveats.join(" ");
    // The honesty requirement: a 1 degree cell is not a site.
    expect(caveats).toContain("110 km");
    expect(caveats).toContain("35.50°");
  });

  it("discards fill values rather than averaging them in", async () => {
    const withFill = structuredClone(POWER_CLIMATOLOGY);
    withFill.properties.parameter.ALLSKY_SFC_SW_DWN.JUL = -999;
    stubFetch([{ match: "climatology/point", body: withFill }]);

    const report = await fetchNasaPowerClimatology({ latitude: 35, longitude: -118 });
    // An incomplete year must not be reported as an annual total.
    expect(report.ghiKwhM2Year).toBeUndefined();
    // But the months that are present are still usable.
    expect(report.monthlyGhi).toHaveLength(11);
  });

  it("reports a missing-parameter response as an error with guidance", async () => {
    stubFetch([{ match: "climatology/point", body: { messages: ["Bad request"] } }]);
    await expect(
      fetchNasaPowerClimatology({ latitude: 35, longitude: -118 }),
    ).rejects.toMatchObject({ guidance: expect.stringContaining("Bad request") });
  });
});

/* --- NLR ------------------------------------------------------------------ */

describe("NLR", () => {
  const RESOURCE = {
    outputs: {
      avg_ghi: { annual: 5.5, monthly: monthlyLower(5.5) },
      avg_dni: { annual: 7.0, monthly: monthlyLower(7.0) },
      avg_lat_tilt: { annual: 6.3, monthly: monthlyLower(6.3) },
    },
  };

  function monthlyLower(value: number): Record<string, number> {
    return {
      jan: value,
      feb: value,
      mar: value,
      apr: value,
      may: value,
      jun: value,
      jul: value,
      aug: value,
      sep: value,
      oct: value,
      nov: value,
      dec: value,
    };
  }

  it("scales daily means to annual totals", async () => {
    stubFetch([{ match: "solar_resource", body: RESOURCE }]);
    const report = await fetchNlrResource({
      latitude: 35,
      longitude: -118,
      apiKey: "SECRET",
    });
    expect(report.ghiKwhM2Year).toBeCloseTo(5.5 * 365.25, 4);
    expect(report.dniKwhM2Year).toBeCloseTo(7.0 * 365.25, 4);
    expect(report.monthlyDni).toHaveLength(12);
    expect(report.monthlyGhi).toBeDefined();
    // NSRDB is a validated satellite product, so it is labelled measured.
    expect(report.fidelity).toBe("measured");
  });

  it("never stores the API key in the recorded request", async () => {
    stubFetch([{ match: "solar_resource", body: RESOURCE }]);
    const report = await fetchNlrResource({
      latitude: 35,
      longitude: -118,
      apiKey: "SUPERSECRET",
    });
    // An exported report must not carry a live credential.
    expect(report.requestUrl).not.toContain("SUPERSECRET");
    expect(report.requestUrl).toContain("api_key=REDACTED");
  });

  it("redacts keys from arbitrary URLs", () => {
    expect(redactKey("https://x/y?api_key=abc123&lat=1")).toBe(
      "https://x/y?api_key=REDACTED&lat=1",
    );
  });

  it("explains an out-of-coverage location", async () => {
    stubFetch([{ match: "solar_resource", body: { errors: ["No data for this location"] } }]);
    await expect(
      fetchNlrResource({ latitude: 60, longitude: 25, apiKey: "K" }),
    ).rejects.toMatchObject({ guidance: expect.stringContaining("Americas") });
  });

  it("reads PVWatts annual energy and the station distance", async () => {
    stubFetch([
      {
        match: "pvwatts",
        body: {
          version: "8.0.0",
          station_info: { location: "Mojave", distance: 12_400 },
          outputs: {
            ac_annual: 185_000,
            solrad_annual: 6.1,
            ac_monthly: Array.from({ length: 12 }, () => 15_416),
          },
        },
      },
    ]);

    const report = await fetchPvWatts({
      latitude: 35,
      longitude: -118,
      apiKey: "K",
      capacityKwDc: 100,
    });
    expect(report.specificYieldKwhPerKwp).toBeCloseTo(1850, 6);
    expect(report.monthlyYield).toHaveLength(12);
    expect(report.caveats.join(" ")).toContain("12.4 km");
  });
});

/* --- Comparison and orchestration ---------------------------------------- */

describe("source comparison", () => {
  it("reports spread across providers", () => {
    const comparison = compareValues("GHI", "kWh/m²/yr", [
      { provider: "pvgis", value: 1800, fidelity: "modelled" },
      { provider: "nasa_power", value: 1900, fidelity: "modelled" },
    ]);
    expect(comparison?.min).toBe(1800);
    expect(comparison?.max).toBe(1900);
    expect(comparison?.mean).toBe(1850);
    expect(comparison?.relativeSpread).toBeCloseTo(100 / 1850, 9);
    // Around 5% is normal disagreement between datasets, not worth alarming over.
    expect(comparison?.significant).toBe(false);
  });

  it("flags a disagreement worth the user's attention", () => {
    const comparison = compareValues("GHI", "kWh/m²/yr", [
      { provider: "pvgis", value: 1500, fidelity: "modelled" },
      { provider: "nasa_power", value: 2000, fidelity: "modelled" },
    ]);
    expect(comparison?.significant).toBe(true);
  });

  it("ignores missing values instead of treating them as zero", () => {
    const comparison = compareValues("DNI", "kWh/m²/yr", [
      { provider: "pvgis", value: 2000, fidelity: "modelled" },
      { provider: "nlr", value: undefined, fidelity: "measured" },
    ]);
    expect(comparison?.values).toHaveLength(1);
    expect(comparison?.significant).toBe(false);
  });

  it("returns nothing when no source answered", () => {
    expect(
      compareValues("DNI", "kWh/m²/yr", [
        { provider: "pvgis", value: undefined, fidelity: "modelled" },
      ]),
    ).toBeNull();
  });
});

describe("site report orchestration", () => {
  const noKeys = async () => null;

  it("assembles a report from the providers that answered", async () => {
    stubFetch([
      { match: "MRcalc", body: PVGIS_MRCALC },
      { match: "PVcalc", body: PVGIS_PVCALC },
      { match: "climatology/point", body: POWER_CLIMATOLOGY },
    ]);

    const report = await generateSiteReport({
      latitude: 35,
      longitude: -118,
      providers: ["pvgis", "nasa_power"],
      getApiKey: noKeys,
    });

    expect(report.reports).toHaveLength(2);
    expect(report.outcomes.every((outcome) => outcome.status === "ok")).toBe(true);
    expect(report.comparisons.length).toBeGreaterThan(0);
  });

  it("prefers the higher-resolution source for a consensus value", async () => {
    stubFetch([
      { match: "MRcalc", body: PVGIS_MRCALC },
      { match: "PVcalc", body: PVGIS_PVCALC },
      { match: "climatology/point", body: POWER_CLIMATOLOGY },
    ]);

    const report = await generateSiteReport({
      latitude: 35,
      longitude: -118,
      providers: ["pvgis", "nasa_power"],
      getApiKey: noKeys,
    });

    // PVGIS at 5 km outranks POWER at 1 degree for irradiation.
    expect(report.consensus.ghiKwhM2Year?.from).toEqual(["pvgis"]);
    expect(report.consensus.ghiKwhM2Year?.note).toContain("highest-resolution");
    // Optimal tilt prefers NASA POWER (PVGIS slopes can be unreliable globally).
    expect(report.consensus.optimalTiltDegrees?.from).toEqual(["nasa_power"]);
    expect(report.consensus.optimalTiltDegrees?.value).toBe(30);
  });

  it("exposes NASA POWER monthly tilt and air temperature series", async () => {
    stubFetch([{ match: "climatology/point", body: POWER_CLIMATOLOGY }]);
    const report = await fetchNasaPowerClimatology({ latitude: 35, longitude: -118 });
    expect(report.monthlyOptimalTilt).toHaveLength(12);
    expect(report.monthlyOptimalTilt?.[0]?.value).toBe(30);
    expect(report.monthlyAirTempC).toHaveLength(12);
    expect(report.monthlyAirTempC?.[0]?.value).toBe(17);
    expect(report.monthlyCloudPct).toHaveLength(12);
    expect(report.monthlyCloudPct?.[0]?.value).toBe(42);
  });

  it("survives one provider failing", async () => {
    stubFetch([
      { match: "MRcalc", body: PVGIS_MRCALC },
      { match: "PVcalc", body: PVGIS_PVCALC },
      { match: "climatology/point", body: { error: "boom" }, status: 500 },
    ]);

    const report = await generateSiteReport({
      latitude: 35,
      longitude: -118,
      providers: ["pvgis", "nasa_power"],
      getApiKey: noKeys,
      // One attempt: the retry policy is tested separately.
    });

    expect(report.reports).toHaveLength(1);
    const failed = report.outcomes.find((outcome) => outcome.provider === "nasa_power");
    expect(failed?.status).toBe("failed");
    expect(failed?.guidance).toBeTruthy();
  }, 20_000);

  it("skips a keyed provider with an actionable reason", async () => {
    stubFetch([
      { match: "MRcalc", body: PVGIS_MRCALC },
      { match: "PVcalc", body: PVGIS_PVCALC },
    ]);

    const report = await generateSiteReport({
      latitude: 35,
      longitude: -118,
      providers: ["pvgis", "nlr"],
      getApiKey: noKeys,
    });

    const skipped = report.outcomes.find((outcome) => outcome.provider === "nlr");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.guidance).toContain("Settings");
  });

  it("never calls the metered API speculatively", async () => {
    const spy = stubFetch([
      { match: "MRcalc", body: PVGIS_MRCALC },
      { match: "PVcalc", body: PVGIS_PVCALC },
    ]);

    const report = await generateSiteReport({
      latitude: 35,
      longitude: -118,
      providers: ["pvgis", "google_solar"],
      getApiKey: async () => "KEY",
    });

    const skipped = report.outcomes.find((outcome) => outcome.provider === "google_solar");
    expect(skipped?.status).toBe("skipped");
    // No request must have gone to the paid endpoint.
    const called = spy.mock.calls.map((call) => String(call[0])).join(" ");
    expect(called).not.toContain("solar.googleapis.com");
  });

  it("warns when sources disagree materially", async () => {
    const lowPvgis = structuredClone(PVGIS_MRCALC);
    for (const month of lowPvgis.outputs.monthly) month["H(h)_m"] = 90; // 1080/yr

    stubFetch([
      { match: "MRcalc", body: lowPvgis },
      { match: "PVcalc", body: PVGIS_PVCALC },
      { match: "climatology/point", body: POWER_CLIMATOLOGY }, // ~1826/yr
    ]);

    const report = await generateSiteReport({
      latitude: 35,
      longitude: -118,
      providers: ["pvgis", "nasa_power"],
      getApiKey: noKeys,
    });

    expect(report.warnings.join(" ")).toContain("Global horizontal irradiation differs");
    expect(report.warnings.join(" ")).toContain("not resolved by averaging");
  });

  it("reports progress as each provider settles", async () => {
    stubFetch([
      { match: "MRcalc", body: PVGIS_MRCALC },
      { match: "PVcalc", body: PVGIS_PVCALC },
      { match: "climatology/point", body: POWER_CLIMATOLOGY },
    ]);

    const progress: Array<[number, number]> = [];
    await generateSiteReport({
      latitude: 35,
      longitude: -118,
      providers: ["pvgis", "nasa_power"],
      getApiKey: noKeys,
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("PVGIS radiation database selection", () => {
  it("prefers SARAH3 inside the European–African footprint", async () => {
    const { pvgisRadiationDatabase } = await import("./pvgis");
    expect(pvgisRadiationDatabase(48, 2)).toBe("PVGIS-SARAH3");
    expect(pvgisRadiationDatabase(0, 20)).toBe("PVGIS-SARAH3");
  });

  it("forces ERA5 at high latitude", async () => {
    const { pvgisRadiationDatabase } = await import("./pvgis");
    expect(pvgisRadiationDatabase(65, 25)).toBe("PVGIS-ERA5");
    expect(pvgisRadiationDatabase(-62, -70)).toBe("PVGIS-ERA5");
  });
});
