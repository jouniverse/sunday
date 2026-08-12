/**
 * Country / region detail card for Insights Statistics.
 * Rendered below the map or table (not a side rail) so charts keep usable width.
 */

import { useEffect, useMemo, useState } from "react";
import { Chip, Select } from "@/design-system/controls";
import { Callout, ProvenanceBadge } from "@/design-system/data";
import { INSIGHT_INDICATORS, seriesForEntity } from "@/domain/insights/indicators";
import type { InsightObservation } from "@/domain/insights/types";
import { countryByIso3 } from "@/services/datasets/country-rankings";
import {
  irenaBalanceFor,
  irenaCapacityGw,
  irenaEmploymentFor,
  irenaFinanceFor,
  irenaInnovationFor,
  loadIrenaCapacity,
  loadIrenaCountryExtras,
  loadOwidElectricityShare,
  loadOwidPrimaryEnergy,
  loadOwidSolarGeneration,
} from "@/services/insights/bundles";
import { fetchEmberSolarEmissionsYearly, fetchEmberSolarMonthlyLastYear } from "@/services/insights/ember";
import { BarChart, SeriesChart } from "./SeriesChart";

const TECH_ORDER = [
  "Solar photovoltaic",
  "Solar heating /cooling",
  "Concentrated solar power",
  "All technologies",
];

function latestChip(
  observations: InsightObservation[],
  iso3: string,
): InsightObservation | undefined {
  const series = seriesForEntity(observations, iso3);
  return series.length ? series[series.length - 1] : undefined;
}

export function CountryDetailPanel({
  iso3,
  mapIndicatorId,
  mapSeries,
  mapUnit,
  emberApiKey,
  compactLayout = false,
}: {
  iso3: string;
  mapIndicatorId: string;
  mapSeries: Array<{ date: string; value: number }>;
  mapUnit: string;
  emberApiKey: string | null;
  /** Wider below-map card: two-column chart grid, no rail chrome. */
  compactLayout?: boolean;
}) {
  const name = countryByIso3(iso3)?.name ?? iso3;
  const extrasMeta = loadIrenaCountryExtras();
  const [innovSector, setInnovSector] = useState("Power");
  const [emissions, setEmissions] = useState<InsightObservation[]>([]);
  const [monthly, setMonthly] = useState<InsightObservation[]>([]);
  const [emberNote, setEmberNote] = useState<string | null>(null);

  const coreChips = useMemo(() => {
    const capacity = loadIrenaCapacity().observations;
    const primary = loadOwidPrimaryEnergy().observations;
    const generation = loadOwidSolarGeneration().observations;
    const share = loadOwidElectricityShare().observations;
    return INSIGHT_INDICATORS.map((meta) => {
      const bundle =
        meta.id === "irena_capacity_gw"
          ? capacity
          : meta.id === "owid_primary_energy_share"
            ? primary
            : meta.id === "solar_generation_twh"
              ? generation
              : share;
      const hit = latestChip(bundle, iso3);
      return { meta, hit };
    });
  }, [iso3]);

  const employment = irenaEmploymentFor(iso3);
  const finance = irenaFinanceFor(iso3);
  const innovation = irenaInnovationFor(iso3);
  const balance = irenaBalanceFor(iso3);
  const capacityGw = irenaCapacityGw(iso3);

  const employmentBars = useMemo(() => {
    if (!employment) return [];
    const all = employment.technologies["All technologies"];
    return TECH_ORDER.filter((tech) => employment.technologies[tech] !== undefined).map((tech) => ({
      label: tech.replace("Solar photovoltaic", "PV").replace("Solar heating /cooling", "Heat"),
      value: employment.technologies[tech] ?? 0,
      shareOfAll: all && all > 0 ? ((employment.technologies[tech] ?? 0) / all) * 100 : undefined,
    }));
  }, [employment]);

  const innovSectors = useMemo(() => {
    if (!innovation) return ["Power"];
    return [...new Set(innovation.rows.map((r) => r.sector))].sort();
  }, [innovation]);

  const innovSeries = useMemo(() => {
    if (!innovation) return [] as Array<{ date: string; subtechnology: string; value: number }>;
    return innovation.rows
      .filter((r) => r.sector === innovSector)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [innovation, innovSector]);

  const innovLines = useMemo(() => {
    const bySub = new Map<string, Array<{ date: string; value: number }>>();
    for (const row of innovSeries) {
      const list = bySub.get(row.subtechnology) ?? [];
      list.push({ date: row.date, value: row.value });
      bySub.set(row.subtechnology, list);
    }
    return [...bySub.entries()];
  }, [innovSeries]);

  useEffect(() => {
    let cancelled = false;
    setEmissions([]);
    setMonthly([]);
    setEmberNote(null);
    if (!emberApiKey) {
      setEmberNote(
        "Add an Ember API key in Settings → Optional keys for emissions and monthly generation.",
      );
      return;
    }
    // Aggregates (OWID_*, REG_*, WLD) are not Ember country codes.
    if (iso3.length !== 3 || iso3.startsWith("REG") || iso3.startsWith("OWID")) {
      setEmberNote("Ember extras are available for ISO3 countries, not world/region aggregates.");
      return;
    }
    void (async () => {
      try {
        const [em, mo] = await Promise.all([
          fetchEmberSolarEmissionsYearly(emberApiKey, iso3),
          fetchEmberSolarMonthlyLastYear(emberApiKey, iso3),
        ]);
        if (cancelled) return;
        setEmissions(em);
        setMonthly(mo);
      } catch (error) {
        if (cancelled) return;
        setEmberNote(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [emberApiKey, iso3]);

  const mapIndicatorLabel =
    INSIGHT_INDICATORS.find((i) => i.id === mapIndicatorId)?.label ?? "Selected indicator";

  const body = (
    <>
      {!compactLayout && (
        <h3>
          {name}{" "}
          <span className="mono" style={{ color: "var(--outline)", fontWeight: 400 }}>
            {iso3}
          </span>
        </h3>
      )}
      {compactLayout && (
        <p className="report__units mono" style={{ marginTop: 0 }}>
          {iso3}
        </p>
      )}
      <ProvenanceBadge
        fidelity="modelled"
        source={extrasMeta.source}
        vintage={extrasMeta.vintage}
        method={extrasMeta.method}
      />

      <section className="insights__detail-section">
        <h4>Latest values</h4>
        <div className="insights__chip-grid">
          {coreChips.map(({ meta, hit }) => (
            <Chip key={meta.id} tone={hit ? "ok" : "neutral"} title={meta.description}>
              {meta.label.split(" ").slice(0, 3).join(" ")}:{" "}
              {hit ? `${hit.value.toFixed(2)} ${meta.unit}` : "—"}
            </Chip>
          ))}
          {capacityGw !== undefined && (
            <Chip tone="ok">IRENA capacity: {capacityGw.toFixed(2)} GW</Chip>
          )}
          {balance?.solarPv !== null && balance?.solarPv !== undefined && (
            <Chip tone="neutral">
              RE balance PV {balance.year}: {balance.solarPv.toFixed(1)}
            </Chip>
          )}
          {balance?.solarThermal !== null && balance?.solarThermal !== undefined && (
            <Chip tone="neutral">
              RE balance thermal {balance.year}: {balance.solarThermal.toFixed(1)}
            </Chip>
          )}
        </div>
      </section>

      {/*
        Compact (below-map) layout: fixed rows — primary full-bleed, then pairs —
        so wide desktops do not scatter charts into three+ ragged columns.
      */}
      {compactLayout ? (
        <div className="insights__detail-stack">
          <section className="insights__detail-section">
            <h4>{mapIndicatorLabel} (selected series)</h4>
            <SeriesChart points={mapSeries} unit={mapUnit} variant="hero" />
          </section>

          {(employmentBars.length > 0 || (finance && finance.series.length > 0)) && (
            <div className="insights__detail-pair">
              {employmentBars.length > 0 && (
                <section className="insights__detail-section">
                  <h4>Solar employment {employment?.year} (thousand jobs)</h4>
                  <BarChart
                    bars={employmentBars.map((b) => ({ label: b.label, value: b.value }))}
                    unit="k"
                  />
                  {employment?.technologies["All technologies"] !== undefined && (
                    <p className="report__units">
                      Share of all renewable jobs:{" "}
                      {employmentBars
                        .filter((b) => b.shareOfAll !== undefined)
                        .map((b) => `${b.label} ${b.shareOfAll?.toFixed(0)}%`)
                        .join(" · ") || "—"}
                    </p>
                  )}
                </section>
              )}
              {finance && finance.series.length > 0 && (
                <section className="insights__detail-section">
                  <h4>Solar finance flows</h4>
                  <SeriesChart points={finance.series} unit="USD m" />
                </section>
              )}
            </div>
          )}

          {(emberNote || emissions.length > 0 || monthly.length > 0) && (
            <section className="insights__detail-section">
              <h4>Ember extras</h4>
              {emberNote && <Callout tone="note">{emberNote}</Callout>}
              {(emissions.length > 0 || monthly.length > 0) && (
                <div className="insights__detail-pair">
                  {emissions.length > 0 && (
                    <div className="insights__detail-subchart">
                      <p className="insights__feed-meta">Power-sector emissions (Solar)</p>
                      <SeriesChart
                        points={seriesForEntity(emissions, iso3).map((r) => ({
                          date: r.date,
                          value: r.value,
                        }))}
                        unit="MtCO₂"
                      />
                    </div>
                  )}
                  {monthly.length > 0 && (
                    <div className="insights__detail-subchart">
                      <p className="insights__feed-meta">Monthly solar generation (recent)</p>
                      <SeriesChart
                        points={monthly.map((r) => ({ date: r.date, value: r.value }))}
                        unit="TWh"
                        showMean={false}
                      />
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {innovation && innovLines.length > 0 && (
            <section className="insights__detail-section">
              <h4>Solar innovation (filed patents)</h4>
              <Select
                value={innovSector}
                onChange={(event) => setInnovSector(event.target.value)}
                options={innovSectors.map((s) => ({ value: s, label: s }))}
              />
              <div className="insights__detail-pair">
                {innovLines.map(([sub, points]) => (
                  <div key={sub} className="insights__detail-subchart">
                    <p className="insights__feed-meta">{sub}</p>
                    <SeriesChart points={points} unit="patents" showMean={false} />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : (
        <div>
          <section className="insights__detail-section">
            <h4>{mapIndicatorLabel} (selected series)</h4>
            <SeriesChart points={mapSeries} unit={mapUnit} variant="hero" />
          </section>

          {employmentBars.length > 0 && (
            <section className="insights__detail-section">
              <h4>Solar employment {employment?.year} (thousand jobs)</h4>
              <BarChart
                bars={employmentBars.map((b) => ({ label: b.label, value: b.value }))}
                unit="k"
              />
              {employment?.technologies["All technologies"] !== undefined && (
                <p className="report__units">
                  Share of all renewable jobs:{" "}
                  {employmentBars
                    .filter((b) => b.shareOfAll !== undefined)
                    .map((b) => `${b.label} ${b.shareOfAll?.toFixed(0)}%`)
                    .join(" · ") || "—"}
                </p>
              )}
            </section>
          )}

          {finance && finance.series.length > 0 && (
            <section className="insights__detail-section">
              <h4>Solar finance flows</h4>
              <SeriesChart points={finance.series} unit="USD m" />
            </section>
          )}

          <section className="insights__detail-section">
            <h4>Ember extras</h4>
            {emberNote && <Callout tone="note">{emberNote}</Callout>}
            {emissions.length > 0 && (
              <>
                <p className="insights__feed-meta">Power-sector emissions (Solar)</p>
                <SeriesChart
                  points={seriesForEntity(emissions, iso3).map((r) => ({
                    date: r.date,
                    value: r.value,
                  }))}
                  unit="MtCO₂"
                />
              </>
            )}
            {monthly.length > 0 && (
              <>
                <p className="insights__feed-meta">Monthly solar generation (recent)</p>
                <SeriesChart
                  points={monthly.map((r) => ({ date: r.date, value: r.value }))}
                  unit="TWh"
                  showMean={false}
                />
              </>
            )}
          </section>

          {innovation && innovLines.length > 0 && (
            <section className="insights__detail-section">
              <h4>Solar innovation (filed patents)</h4>
              <Select
                value={innovSector}
                onChange={(event) => setInnovSector(event.target.value)}
                options={innovSectors.map((s) => ({ value: s, label: s }))}
              />
              {innovLines.map(([sub, points]) => (
                <div key={sub} style={{ marginTop: 8 }}>
                  <p className="insights__feed-meta">{sub}</p>
                  <SeriesChart points={points} unit="patents" showMean={false} />
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </>
  );

  if (compactLayout) {
    return (
      <div className="insights__country-detail" aria-label={`${name} detail`}>
        {body}
      </div>
    );
  }

  return (
    <aside className="insights__side" aria-label={`${name} country detail`}>
      {body}
    </aside>
  );
}
