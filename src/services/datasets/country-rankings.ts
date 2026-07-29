/**
 * Bundled Global Solar Atlas country rankings.
 *
 * Small enough to ship with the app (~209 rows). The analytics view and any
 * choropleth that needs a country-level solar ranking read from here — never
 * from a live API and never from the multi-GB rasters.
 */

import rankings from "@/assets/data/country-rankings.json";

export interface CountryRanking {
  iso3: string;
  name: string;
  region: string | null;
  ghiKwhM2Day: number | null;
  ghiKwhM2Year: number | null;
  pvoutKwhKwpDay: number | null;
  pvoutKwhKwpYear: number | null;
  ghiMedianKwhM2Day: number | null;
  pvoutMedianKwhKwpDay: number | null;
  rankPvout?: number;
  rankGhi?: number | null;
}

export interface CountryRankingsDataset {
  source: string;
  vintage: string;
  licence: string;
  method: string;
  units: Record<string, string>;
  countries: CountryRanking[];
}

export type RankingMetric = "pvout" | "ghi";

export function loadCountryRankings(): CountryRankingsDataset {
  return rankings as CountryRankingsDataset;
}

/** Sorted descending by the chosen metric; countries missing that metric are dropped. */
export function rankedCountries(
  metric: RankingMetric = "pvout",
  options: { region?: string; limit?: number } = {},
): CountryRanking[] {
  const { countries } = loadCountryRankings();
  const key = metric === "pvout" ? "pvoutKwhKwpYear" : "ghiKwhM2Year";
  let rows = countries.filter((row) => row[key] !== null && row[key] !== undefined);
  if (options.region) {
    rows = rows.filter((row) => row.region === options.region);
  }
  rows = [...rows].sort((a, b) => (b[key] as number) - (a[key] as number));
  if (options.limit !== undefined) rows = rows.slice(0, options.limit);
  return rows;
}

export function countryByIso3(iso3: string): CountryRanking | undefined {
  return loadCountryRankings().countries.find(
    (row) => row.iso3.toUpperCase() === iso3.toUpperCase(),
  );
}

export function rankingProvenance(): {
  source: string;
  vintage: string;
  licence: string;
  method: string;
} {
  const data = loadCountryRankings();
  return {
    source: data.source,
    vintage: data.vintage,
    licence: data.licence,
    method: data.method,
  };
}
