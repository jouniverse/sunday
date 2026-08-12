/**
 * Bundled Global Solar Atlas country rankings.
 *
 * Small enough to ship with the app (~209 rows). The analytics view and any
 * choropleth that needs a country-level solar ranking read from here — never
 * from a live API and never from the multi-GB rasters.
 *
 * Summary statistics: (T) = theoretical GHI, (P) = practical PVOUT Level 1.
 */

import rankings from "@/assets/data/country-rankings.json";

/** Percentile ladder from Summary statistics: Min…Max (8 points). */
export type DistributionSeries = Array<number | null>;

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
  /** Spatial GHI (T) distribution within the country, kWh/m²/day. */
  ghiDistributionKwhM2Day?: DistributionSeries;
  /** Spatial PVOUT (P) distribution within the country, kWh/kWp/day. */
  pvoutDistributionKwhKwpDay?: DistributionSeries;
  rankPvout?: number;
  rankGhi?: number | null;
}

export interface CountryRankingsDataset {
  source: string;
  vintage: string;
  licence: string;
  method: string;
  units: Record<string, string>;
  distributionLabels?: string[];
  countries: CountryRanking[];
}

export type RankingMetric = "pvout" | "ghi";

export interface RankingChartSeries {
  points: Array<{ date: string; value: number }>;
  unit: string;
  titleSuffix: string;
  caption: string;
  method: string;
  /** Month ticks for seasonality; percentile ticks for spatial distribution. */
  xTicks: "ends" | "all";
}

const DEFAULT_DIST_LABELS = ["Min", "10%", "25%", "Avg", "Med", "75%", "90%", "Max"];

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

/**
 * Country detail chart for the Rankings metric toggle.
 * GHI → Summary (T) spatial percentiles; PVOUT → Summary (P) spatial percentiles.
 * (Monthly CSV is PVOUT-only; both metric charts use published T/P columns.)
 */
export function rankingChartSeries(
  iso3: string,
  metric: RankingMetric,
): RankingChartSeries | null {
  const data = loadCountryRankings();
  const row = countryByIso3(iso3);
  if (!row) return null;

  const labels = data.distributionLabels ?? DEFAULT_DIST_LABELS;
  const values =
    metric === "ghi" ? row.ghiDistributionKwhM2Day : row.pvoutDistributionKwhKwpDay;

  if (!values?.length) return null;

  const points = values
    .map((value, i) =>
      value === null || value === undefined
        ? null
        : { date: labels[i] ?? String(i + 1), value },
    )
    .filter((p): p is { date: string; value: number } => p !== null);

  if (metric === "ghi") {
    return {
      points,
      unit: "kWh/m²/day",
      titleSuffix: "GHI distribution (T)",
      caption: `Theoretical potential (GHI) spatial distribution within the country from Solargis Summary statistics (T columns). Country mean: ${
        row.ghiKwhM2Day ?? "—"
      } kWh/m²/day.`,
      method:
        "Summary statistics Theoretical potential (GHI, kWh/m²/day): Min…Max (T) within evaluated area.",
      xTicks: "all",
    };
  }

  return {
    points,
    unit: "kWh/kWp/day",
    titleSuffix: "PVOUT distribution (P)",
    caption: `Practical potential (PVOUT Level 1) spatial distribution within the country from Solargis Summary statistics (P columns). Country mean: ${
      row.pvoutKwhKwpDay ?? "—"
    } kWh/kWp/day.`,
    method:
      "Summary statistics Practical potential (PVOUT Level 1, kWh/kWp/day): Min…Max (P) within Level 1 land.",
    xTicks: "all",
  };
}
