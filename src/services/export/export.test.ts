import { describe, expect, it } from "vitest";
import type { Site } from "@/core/store/siteStore";
import type { SiteReport } from "../solar/orchestrator";
import {
  csvField,
  defaultMeta,
  exportReportCsv,
  exportReportHtml,
  exportSitesCsv,
  sitesToGeoJson,
  sitesToRows,
  toCsv,
} from "./index";

const meta = defaultMeta("Mojave study", ["Screening only."]);

const site: Site = {
  id: "site-1",
  name: "Mojave Site B",
  kind: "area",
  ring: [
    [-118.2, 35.0],
    [-118.19, 35.0],
    [-118.19, 35.01],
    [-118.2, 35.01],
  ],
  centre: [-118.195, 35.005],
  createdAt: "2026-07-29T12:00:00Z",
  areaM2: 842_000,
  perimeterM: 3680,
  geometryValid: true,
  resource: {
    ghiKwhM2Year: 2050,
    dniKwhM2Year: 2600,
    source: "PVGIS",
    fidelity: "modelled",
    method: "PVGIS monthly radiation",
  },
  terrain: { meanSlopeDegrees: 1.4, source: "Copernicus DEM" },
  nudges: [
    {
      id: "slope-caution",
      severity: "caution",
      title: "Grading cost likely",
      detail: "Mean slope above the screening threshold.",
      basis: "Siting literature",
    },
    {
      id: "protected-area",
      severity: "blocking",
      title: "Inside a protected area",
      detail: "Boundary intersects a designation.",
      basis: "WDPA",
    },
  ],
  notes: "Access from the north track.",
};

const report: SiteReport = {
  latitude: 35.005,
  longitude: -118.195,
  generatedAt: "2026-07-29T12:05:00Z",
  outcomes: [],
  reports: [
    {
      provider: "pvgis",
      latitude: 35.005,
      longitude: -118.195,
      ghiKwhM2Year: 2050,
      dniKwhM2Year: 2600,
      specificYieldKwhPerKwp: 1830,
      optimalTiltDegrees: 30,
      source: "European Commission JRC, PVGIS",
      dataset: "PVGIS-SARAH3",
      fidelity: "modelled",
      method: "PVGIS grid-connected PV model",
      caveats: ["About 5 km resolution."],
      requestUrl: "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=35",
      monthlyGhi: Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        value: 120 + index * 8,
      })),
    },
    {
      provider: "nasa_power",
      latitude: 35.005,
      longitude: -118.195,
      ghiKwhM2Year: 1980,
      optimalTiltDegrees: 32,
      meanAirTempC: 17,
      source: "NASA POWER",
      dataset: "CERES SYN1deg",
      fidelity: "modelled",
      method: "Climatology means",
      caveats: [],
      monthlyGhi: Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        value: 110 + index * 7,
      })),
      monthlyOptimalTilt: Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        value: 20 + index,
      })),
      monthlyAirTempC: Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        value: 10 + index,
      })),
    },
  ],
  comparisons: [],
  consensus: {
    optimalTiltDegrees: { value: 32, from: ["nasa_power"], note: "NASA POWER" },
    meanAirTempC: { value: 17, from: ["nasa_power"], note: "NASA POWER" },
  },
  warnings: ["Global horizontal irradiation differs by 4% between sources."],
};

describe("CSV escaping", () => {
  it("quotes fields containing delimiters, quotes or newlines", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralises values a spreadsheet would treat as a formula", () => {
    // A site name beginning with = must not execute when the CSV is opened.
    expect(csvField("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1+A1")).toBe("'-1+A1");
    expect(csvField("@import")).toBe("'@import");
  });

  it("leaves plain numeric fields alone so longitudes stay readable", () => {
    expect(csvField("-118.175601")).toBe("-118.175601");
    expect(csvField("-1")).toBe("-1");
    expect(csvField("35.073635")).toBe("35.073635");
  });

  it("renders empty for missing values", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("builds a table with a stable column order", () => {
    const csv = toCsv([{ b: 2, a: 1 }, { a: 3, c: 4 }]);
    const [header] = csv.split("\r\n");
    expect(header).toBe("b,a,c");
    expect(csv).toContain("2,1,");
  });

  it("returns nothing for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});

describe("site export", () => {
  it("includes geometry, resource and provenance columns", () => {
    const [row] = sitesToRows([site]);
    expect(row?.name).toBe("Mojave Site B");
    expect(row?.area_ha).toBe("84.200");
    expect(row?.ghi_kwh_m2_year).toBe("2050");
    expect(row?.resource_source).toBe("PVGIS");
    expect(row?.resource_fidelity).toBe("modelled");
  });

  it("carries screening flags into the export", () => {
    const [row] = sitesToRows([site]);
    // A caution the user never sees again is a caution that failed.
    expect(row?.blocking_issues).toBe("Inside a protected area");
    expect(row?.cautions).toBe("Grading cost likely");
  });

  it("prefixes the CSV with provenance and disclaimers", () => {
    const csv = exportSitesCsv([site], meta);
    expect(csv).toContain("# Sunday 0.1.0 — Mojave study");
    expect(csv).toContain("# Screening only.");
    expect(csv).toContain("# Estimates for planning purposes.");
  });

  it("emits GeoJSON with a closed ring and full properties", () => {
    const collection = sitesToGeoJson([site], meta);
    expect(collection.type).toBe("FeatureCollection");
    const feature = collection.features[0];
    expect(feature?.geometry.type).toBe("Polygon");

    const ring = (feature?.geometry as GeoJSON.Polygon).coordinates[0];
    // GeoJSON requires the ring to close.
    expect(ring?.[0]).toEqual(ring?.[ring.length - 1]);
    expect(feature?.properties?.areaM2).toBe(842_000);
    expect(feature?.properties?.resource).toBeDefined();
    expect(feature?.properties?.nudges).toHaveLength(2);
  });

  it("emits a point geometry for a point site", () => {
    const pointSite: Site = { ...site, kind: "point", ring: null, areaM2: 0 };
    const collection = sitesToGeoJson([pointSite], meta);
    expect(collection.features[0]?.geometry.type).toBe("Point");
  });

  it("attaches generator metadata to the collection", () => {
    const collection = sitesToGeoJson([site], meta) as GeoJSON.FeatureCollection & {
      metadata?: { generator?: string; disclaimers?: string[] };
    };
    expect(collection.metadata?.generator).toContain("Sunday");
    expect(collection.metadata?.disclaimers?.length).toBeGreaterThan(0);
  });
});

describe("report export", () => {
  it("lists one row per source with its method", () => {
    const csv = exportReportCsv(report, meta);
    expect(csv).toContain("pvgis");
    expect(csv).toContain("nasa_power");
    expect(csv).toContain("PVGIS grid-connected PV model");
  });

  it("records disagreements in the CSV header", () => {
    const csv = exportReportCsv(report, meta);
    expect(csv).toContain("# Global horizontal irradiation differs by 4%");
  });

  it("produces a self-contained HTML report", () => {
    const html = exportReportHtml(report, meta, site);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Self-contained: no external stylesheet or script.
    expect(html).not.toContain("<script");
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain("@media print");
  });

  it("includes site geometry, sources, warnings and screening flags", () => {
    const html = exportReportHtml(report, meta, site);
    expect(html).toContain("Mojave Site B");
    expect(html).toContain("84.20 ha");
    expect(html).toContain("PVGIS-SARAH3");
    expect(html).toContain("Global horizontal irradiation differs");
    expect(html).toContain("Inside a protected area");
    expect(html).toContain("Screening only.");
  });

  it("embeds satellite imagery and monthly charts in the HTML report", () => {
    const html = exportReportHtml(report, meta, site);
    expect(html).toContain("Site location");
    expect(html).toContain("World_Imagery/MapServer/export");
    expect(html).toContain("Monthly irradiation");
  });

  it("escapes untrusted text rather than injecting it", () => {
    const hostile: Site = { ...site, name: '<img src=x onerror="alert(1)">' };
    const html = exportReportHtml(report, meta, hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("omits the site section when reporting a bare location", () => {
    const html = exportReportHtml(report, meta);
    expect(html).toContain("Site report");
    expect(html).not.toContain("Perimeter");
  });
});
