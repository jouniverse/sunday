/**
 * Insights Statistics: indicator choropleth / table tabs + country card below.
 */

import { useEffect, useMemo, useState } from "react";
import { useInsightsStore } from "@/core/store/insightsStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import { Button, Select } from "@/design-system/controls";
import { Callout, DataGrid, ProvenanceBadge } from "@/design-system/data";
import { INSIGHT_INDICATORS, seriesForEntity } from "@/domain/insights/indicators";
import type { InsightObservation } from "@/domain/insights/types";
import { countryByIso3 } from "@/services/datasets/country-rankings";
import { loadIndicatorObservations } from "@/services/insights/indicator-data";
import { ChoroplethMap } from "./ChoroplethMap";
import { CountryDetailPanel } from "./CountryDetailPanel";

type StatsViewMode = "map" | "table";

function entityLabel(row: InsightObservation): string {
  return countryByIso3(row.entityIso3)?.name ?? row.entityName ?? row.entityIso3;
}

export function StatisticsPanel() {
  const selectedIndicatorId = useInsightsStore((s) => s.selectedIndicatorId);
  const setSelectedIndicatorId = useInsightsStore((s) => s.setSelectedIndicatorId);
  const statisticsScope = useInsightsStore((s) => s.statisticsScope);
  const setStatisticsScope = useInsightsStore((s) => s.setStatisticsScope);
  const selectedCountryIso3 = useInsightsStore((s) => s.selectedCountryIso3);
  const setSelectedCountryIso3 = useInsightsStore((s) => s.setSelectedCountryIso3);
  const revealApiKey = useSettingsStore((s) => s.useKey);

  const [viewMode, setViewMode] = useState<StatsViewMode>("map");
  const [latest, setLatest] = useState<InsightObservation[]>([]);
  const [all, setAll] = useState<InsightObservation[]>([]);
  const [emberApiKey, setEmberApiKey] = useState<string | null>(null);
  const [meta, setMeta] = useState({
    source: "—",
    vintage: "—",
    licence: "—",
    method: "—",
    reducedCapability: false,
    capabilityNote: undefined as string | undefined,
  });
  const [busy, setBusy] = useState(false);

  const indicator = INSIGHT_INDICATORS.find((i) => i.id === selectedIndicatorId);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      const needsEmber =
        selectedIndicatorId === "solar_generation_twh" ||
        selectedIndicatorId === "solar_electricity_share";
      const key = await revealApiKey("ember");
      if (cancelled) return;
      setEmberApiKey(key);
      const result = await loadIndicatorObservations(selectedIndicatorId, {
        emberApiKey: needsEmber ? key : null,
        scope: statisticsScope,
      });
      if (cancelled) return;
      setLatest(result.latest);
      setAll(result.observations);
      setMeta({
        source: result.source,
        vintage: result.vintage,
        licence: result.licence,
        method: result.method,
        reducedCapability: result.reducedCapability,
        capabilityNote: result.capabilityNote,
      });
      // Drop a country selection that is not in the new scope's latest set.
      const selected = useInsightsStore.getState().selectedCountryIso3;
      if (selected && !result.latest.some((row) => row.entityIso3 === selected)) {
        setSelectedCountryIso3(null);
      }
      setBusy(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIndicatorId, statisticsScope, revealApiKey, setSelectedCountryIso3]);

  const choroplethRows = useMemo(
    () =>
      latest
        .filter((row) => row.entityIso3.length === 3 && !row.isAggregate)
        .map((row) => ({
          iso3: row.entityIso3,
          name: entityLabel(row),
          value: row.value,
        })),
    [latest],
  );

  const series = selectedCountryIso3
    ? seriesForEntity(all, selectedCountryIso3).map((row) => ({
        date: row.date,
        value: row.value,
      }))
    : [];

  const tableRows = useMemo(() => [...latest].sort((a, b) => b.value - a.value), [latest]);

  const showMapTab = statisticsScope === "countries";
  const selectedName = selectedCountryIso3
    ? countryByIso3(selectedCountryIso3)?.name ??
      latest.find((r) => r.entityIso3 === selectedCountryIso3)?.entityName ??
      selectedCountryIso3
    : null;

  return (
    <>
      <div className="insights__main-head">
        <div>
          <h2 className="insights__title">Statistics</h2>
          <p className="insights__lede">
            Pick an indicator for the map or table. Select an entity to open its detail card below —
            core values, related IRENA series, and Ember extras when available.
          </p>
        </div>
        <div className="insights__toolbar">
          <div className="insights__tabs" role="tablist" aria-label="Statistics view">
            {showMapTab && (
              <button
                type="button"
                className="insights__tab"
                role="tab"
                aria-selected={viewMode === "map"}
                onClick={() => setViewMode("map")}
              >
                Map
              </button>
            )}
            <button
              type="button"
              className="insights__tab"
              role="tab"
              aria-selected={viewMode === "table" || !showMapTab}
              onClick={() => setViewMode("table")}
            >
              Table
            </button>
          </div>
          <Select
            value={selectedIndicatorId}
            onChange={(event) => setSelectedIndicatorId(event.target.value)}
            options={INSIGHT_INDICATORS.map((row) => ({
              value: row.id,
              label: `${row.label} (${row.unit})`,
            }))}
          />
          <Select
            value={statisticsScope}
            onChange={(event) => {
              const scope = event.target.value as "countries" | "global";
              setStatisticsScope(scope);
              setSelectedCountryIso3(null);
              if (scope === "global") setViewMode("table");
              else setViewMode("map");
            }}
            options={[
              { value: "countries", label: "Countries" },
              { value: "global", label: "World / regions" },
            ]}
          />
        </div>
      </div>

      <ProvenanceBadge
        fidelity="modelled"
        source={meta.source}
        vintage={meta.vintage}
        method={`${meta.method} Licence: ${meta.licence}.`}
      />
      {meta.capabilityNote && (
        <Callout tone={meta.reducedCapability ? "note" : "info"}>{meta.capabilityNote}</Callout>
      )}
      {busy && <p className="insights__lede">Loading indicator…</p>}

      {viewMode === "map" && showMapTab ? (
        <ChoroplethMap
          rows={choroplethRows}
          selectedIso3={selectedCountryIso3}
          onSelect={setSelectedCountryIso3}
          unit={indicator?.unit ?? ""}
        />
      ) : (
        <div className="insights__scroll-table">
          <DataGrid
            caption={`${indicator?.label ?? "Indicator"} — all entities with data`}
            columns={[
              {
                key: "name",
                header: "Entity",
                render: (row) => entityLabel(row),
              },
              { key: "iso", header: "Code", render: (row) => row.entityIso3 },
              { key: "year", header: "Year", render: (row) => row.date },
              {
                key: "value",
                header: indicator?.unit ?? "Value",
                numeric: true,
                render: (row) => row.value.toFixed(2),
              },
            ]}
            rows={tableRows}
            rowKey={(row) => `${row.entityIso3}-${row.date}`}
            onRowClick={(row) => setSelectedCountryIso3(row.entityIso3)}
          />
        </div>
      )}

      <p className="report__units">
        {tableRows.length} entities
        {statisticsScope === "global" ? " (world / regions)" : ""}.{" "}
        {selectedCountryIso3
          ? `Detail card open for ${selectedName}.`
          : "Click a row or map country to open the detail card below."}
      </p>

      {selectedCountryIso3 && (
        <div className="card insights__country-detail-card">
          <div className="card__head">
            <h2 className="card__title">{selectedName} — country / region detail</h2>
            <Button onClick={() => setSelectedCountryIso3(null)}>Close</Button>
          </div>
          <CountryDetailPanel
            iso3={selectedCountryIso3}
            mapIndicatorId={selectedIndicatorId}
            mapSeries={series}
            mapUnit={indicator?.unit ?? ""}
            emberApiKey={emberApiKey}
            compactLayout
          />
        </div>
      )}
    </>
  );
}
