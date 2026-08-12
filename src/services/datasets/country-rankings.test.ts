import { describe, expect, it } from "vitest";
import {
  countryByIso3,
  loadCountryRankings,
  rankedCountries,
  rankingChartSeries,
  rankingProvenance,
} from "./country-rankings";

describe("country rankings", () => {
  it("loads a non-empty catalogue with provenance", () => {
    const data = loadCountryRankings();
    expect(data.countries.length).toBeGreaterThan(100);
    expect(data.source).toMatch(/Global Solar Atlas/i);
    expect(data.licence).toMatch(/CC BY/i);
    expect(rankingProvenance().vintage).toBeTruthy();
    expect(data.distributionLabels?.length).toBe(8);
  });

  it("ranks by practical PVOUT with Chile near the top", () => {
    const top = rankedCountries("pvout", { limit: 20 });
    expect(top[0]?.pvoutKwhKwpYear).toBeGreaterThan(1800);
    // Chile's Atacama is among the highest practical potentials worldwide.
    const chile = top.find((row) => row.iso3 === "CHL");
    expect(chile).toBeDefined();
  });

  it("looks up a country by ISO3", () => {
    const sweden = countryByIso3("swe");
    expect(sweden?.name).toMatch(/Sweden/i);
    expect(sweden?.ghiKwhM2Year).toBeGreaterThan(500);
    expect(sweden?.ghiKwhM2Year).toBeLessThan(1500);
  });

  it("filters by World Bank region", () => {
    const eca = rankedCountries("ghi", { region: "ECA" });
    expect(eca.length).toBeGreaterThan(5);
    expect(eca.every((row) => row.region === "ECA")).toBe(true);
  });

  it("builds distinct T (GHI) and P (PVOUT) distribution charts", () => {
    const ghi = rankingChartSeries("CHL", "ghi");
    const pvout = rankingChartSeries("CHL", "pvout");
    expect(ghi?.points.length).toBe(8);
    expect(pvout?.points.length).toBe(8);
    expect(ghi?.unit).toBe("kWh/m²/day");
    expect(pvout?.unit).toBe("kWh/kWp/day");
    // T and P series are not the same numbers for Chile.
    expect(ghi?.points.map((p) => p.value)).not.toEqual(pvout?.points.map((p) => p.value));
  });
});
