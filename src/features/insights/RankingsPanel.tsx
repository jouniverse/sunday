/**
 * Insights Rankings: Solargis choropleth | table + country T/P distribution chart.
 */

import { useMemo, useState } from "react";
import { useInsightsStore } from "@/core/store/insightsStore";
import { Select } from "@/design-system/controls";
import { DataGrid, ProvenanceBadge } from "@/design-system/data";
import { formatNumber } from "@/domain/units";
import {
  countryByIso3,
  loadCountryRankings,
  rankingChartSeries,
  type RankingMetric,
  rankedCountries,
} from "@/services/datasets/country-rankings";
import { ChoroplethMap } from "./ChoroplethMap";
import { SeriesChart } from "./SeriesChart";

export function RankingsPanel() {
  const rankingsMode = useInsightsStore((s) => s.rankingsMode);
  const setRankingsMode = useInsightsStore((s) => s.setRankingsMode);
  const selectedCountryIso3 = useInsightsStore((s) => s.selectedCountryIso3);
  const setSelectedCountryIso3 = useInsightsStore((s) => s.setSelectedCountryIso3);

  const [metric, setMetric] = useState<RankingMetric>("pvout");
  const [region, setRegion] = useState("all");

  const rankingsMeta = loadCountryRankings();

  const regions = useMemo(() => {
    const values = new Set(
      rankingsMeta.countries
        .map((row) => row.region)
        .filter((value): value is string => Boolean(value)),
    );
    return ["all", ...[...values].sort()];
  }, [rankingsMeta.countries]);

  const rankingRows = useMemo(
    () =>
      rankedCountries(metric, {
        region: region === "all" ? undefined : region,
      }),
    [metric, region],
  );

  const choroplethRows = useMemo(
    () =>
      rankingRows.map((row) => ({
        iso3: row.iso3,
        name: row.name,
        value: (metric === "pvout" ? row.pvoutKwhKwpYear : row.ghiKwhM2Year) ?? 0,
      })),
    [metric, rankingRows],
  );

  const selected = selectedCountryIso3 ? countryByIso3(selectedCountryIso3) : undefined;
  const chartSeries =
    selectedCountryIso3 != null ? rankingChartSeries(selectedCountryIso3, metric) : null;

  const unit = metric === "pvout" ? "kWh/kWp" : "kWh/m²";

  return (
    <>
      <div className="insights__main-head">
        <div>
          <h2 className="insights__title">Country rankings</h2>
          <p className="insights__lede">
            Global Solar Atlas country averages. Map, table, and country chart share the same metric
            and region filters (T = GHI, P = PVOUT).
          </p>
        </div>
        <div className="insights__toolbar">
          <div className="insights__tabs" role="tablist" aria-label="Rankings view">
            <button
              type="button"
              className="insights__tab"
              role="tab"
              aria-selected={rankingsMode === "map"}
              onClick={() => setRankingsMode("map")}
            >
              Map
            </button>
            <button
              type="button"
              className="insights__tab"
              role="tab"
              aria-selected={rankingsMode === "table"}
              onClick={() => setRankingsMode("table")}
            >
              Table
            </button>
          </div>
          <Select
            value={metric}
            onChange={(event) => setMetric(event.target.value as RankingMetric)}
            options={[
              { value: "pvout", label: "Practical PVOUT" },
              { value: "ghi", label: "Theoretical GHI" },
            ]}
          />
          <Select
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            options={regions.map((value) => ({
              value,
              label: value === "all" ? "All regions" : value,
            }))}
          />
        </div>
      </div>

      <ProvenanceBadge
        fidelity="modelled"
        source={rankingsMeta.source}
        vintage={rankingsMeta.vintage}
        method={`${rankingsMeta.method} Licence: ${rankingsMeta.licence}.`}
      />

      {rankingsMode === "map" ? (
        <ChoroplethMap
          rows={choroplethRows}
          selectedIso3={selectedCountryIso3}
          onSelect={setSelectedCountryIso3}
          unit={unit}
          valueFormat={(v) => formatNumber(v, 0)}
        />
      ) : (
        <div className="insights__scroll-table">
          <DataGrid
            caption="Countries by solar resource"
            columns={[
              {
                key: "rank",
                header: "#",
                numeric: true,
                render: (row) =>
                  String(metric === "pvout" ? (row.rankPvout ?? "—") : (row.rankGhi ?? "—")),
              },
              { key: "name", header: "Country", render: (row) => row.name },
              {
                key: "region",
                header: "Region",
                render: (row) => row.region ?? "—",
              },
              {
                key: "ghi",
                header: "GHI",
                numeric: true,
                render: (row) =>
                  row.ghiKwhM2Year ? `${formatNumber(row.ghiKwhM2Year, 0)} kWh/m²` : "—",
              },
              {
                key: "pvout",
                header: "PVOUT",
                numeric: true,
                render: (row) =>
                  row.pvoutKwhKwpYear ? `${formatNumber(row.pvoutKwhKwpYear, 0)} kWh/kWp` : "—",
              },
            ]}
            rows={rankingRows}
            rowKey={(row) => row.iso3}
            onRowClick={(row) => setSelectedCountryIso3(row.iso3)}
          />
        </div>
      )}

      <p className="report__units">
        {rankingsMode === "table"
          ? `Showing all ${rankingRows.length} countries with data.`
          : `Choropleth of ${choroplethRows.length} countries. Hover for values; click for distribution chart.`}
      </p>

      {selected && chartSeries && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card__head">
            <h2 className="card__title">
              {selected.name} — {chartSeries.titleSuffix}
            </h2>
          </div>
          <ProvenanceBadge
            fidelity="modelled"
            source={rankingsMeta.source}
            vintage={rankingsMeta.vintage}
            method={chartSeries.method}
          />
          <SeriesChart
            points={chartSeries.points}
            unit={chartSeries.unit}
            variant="hero"
            xTicks={chartSeries.xTicks}
          />
          <p className="report__units">{chartSeries.caption}</p>
        </div>
      )}
    </>
  );
}
