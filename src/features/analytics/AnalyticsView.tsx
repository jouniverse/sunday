/**
 * Analytics: project roll-up and country rankings.
 *
 * The project roll-up summarises what the user has actually computed. Country
 * rankings come from the bundled Global Solar Atlas summary tables — small enough
 * to ship with the app, always available, always labelled with provenance.
 */

import { useMemo, useState } from "react";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Select } from "@/design-system/controls";
import {
  Callout,
  DataGrid,
  EmptyState,
  ProvenanceBadge,
  Stat,
  StatCluster,
} from "@/design-system/data";
import { ChartIcon } from "@/design-system/icons";
import { computeFillFactor } from "@/domain/packing/ground-mount";
import { moduleById } from "@/domain/packing/priors";
import { hasBlockingNudge } from "@/domain/siting/nudges";
import { formatNumber, scaleArea, scalePower } from "@/domain/units";
import {
  loadCountryRankings,
  type RankingMetric,
  rankedCountries,
} from "@/services/datasets/country-rankings";

export function AnalyticsView() {
  const sites = useSiteStore((state) => state.sites);
  const selectSite = useSiteStore((state) => state.selectSite);
  const setView = useUiStore((state) => state.setView);
  const [metric, setMetric] = useState<RankingMetric>("pvout");
  const [region, setRegion] = useState<string>("all");

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
        limit: 40,
      }),
    [metric, region],
  );

  const rows = useMemo(
    () =>
      sites.map((site) => {
        const module = site.design ? moduleById(site.design.moduleId) : undefined;
        const packing =
          site.design && module && site.areaM2 > 0
            ? computeFillFactor({
                usableAreaM2: site.areaM2,
                module,
                mount: site.design.mount,
                tiltDegrees: site.design.tiltDegrees,
                gcr: site.design.groundCoverageRatio,
                balanceOfSystemFraction: site.design.balanceOfSystemFraction,
              })
            : null;

        return {
          id: site.id,
          name: site.name,
          areaM2: site.areaM2,
          ghi: site.resource?.ghiKwhM2Year,
          capacityKw: packing?.capacityKwDc,
          fillFactor: packing?.fillFactor,
          blocked: hasBlockingNudge(site.nudges),
          screened: site.nudges.length > 0,
        };
      }),
    [sites],
  );

  const totals = useMemo(
    () => ({
      areaM2: rows.reduce((sum, row) => sum + row.areaM2, 0),
      capacityKw: rows.reduce((sum, row) => sum + (row.capacityKw ?? 0), 0),
      designed: rows.filter((row) => row.capacityKw !== undefined).length,
      blocked: rows.filter((row) => row.blocked).length,
    }),
    [rows],
  );

  if (sites.length === 0) {
    return (
      <div className="content-view">
        <div className="content-view__inner">
          <EmptyState
            icon={<ChartIcon size={28} />}
            title="Nothing to analyse yet"
            body="Analytics summarises the sites and designs in this project. Add a site to see it here."
            action={<Button onClick={() => setView("map")}>Go to the map</Button>}
          />
        </div>
      </div>
    );
  }

  const area = scaleArea(totals.areaM2);
  const capacity = scalePower(totals.capacityKw);

  return (
    <div className="content-view">
      <div className="content-view__inner">
        <h1 className="content-view__title">Analytics</h1>
        <p className="content-view__lede">
          A roll-up of the sites and designs in this project. Figures come from the same models the
          design view uses, so they carry the same fidelity labels.
        </p>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Portfolio</h2>
            <StatCluster>
              <Stat label="Sites" value={String(sites.length)} />
              <Stat label="Total area" value={area.value} unit={area.unit} />
              {totals.capacityKw > 0 && (
                <Stat
                  label="Designed capacity"
                  value={capacity.value}
                  unit={capacity.unit}
                  tone="accent"
                />
              )}
            </StatCluster>
          </div>

          <DataGrid
            caption="Sites in this project"
            columns={[
              { key: "name", header: "Site", render: (row) => row.name },
              {
                key: "area",
                header: "Area",
                numeric: true,
                render: (row) =>
                  row.areaM2 > 0
                    ? `${scaleArea(row.areaM2).value} ${scaleArea(row.areaM2).unit}`
                    : "point",
              },
              {
                key: "ghi",
                header: "GHI",
                numeric: true,
                render: (row) => (row.ghi ? formatNumber(row.ghi, 0) : "—"),
              },
              {
                key: "capacity",
                header: "Capacity",
                numeric: true,
                render: (row) =>
                  row.capacityKw
                    ? `${scalePower(row.capacityKw).value} ${scalePower(row.capacityKw).unit}`
                    : "—",
              },
              {
                key: "fill",
                header: "Fill factor",
                numeric: true,
                render: (row) => (row.fillFactor ? `${(row.fillFactor * 100).toFixed(1)}%` : "—"),
              },
              {
                key: "screening",
                header: "Screening",
                render: (row) =>
                  !row.screened ? "not run" : row.blocked ? "blocking issues" : "no obstacles",
              },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
            onRowClick={(row) => {
              selectSite(row.id);
              setView("map");
            }}
          />
          <p className="report__units">
            {totals.designed} of {sites.length} sites have a design. Click a row to open it on the
            map.
          </p>
        </div>

        {totals.blocked > 0 && (
          <Callout tone="warning">
            {totals.blocked} site{totals.blocked === 1 ? " has" : "s have"} a blocking screening
            issue. Portfolio totals above include them, so review before quoting a capacity.
          </Callout>
        )}

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Country rankings</h2>
            <div style={{ display: "flex", gap: 8 }}>
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
          <DataGrid
            caption="Top countries by solar resource"
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
          />
          <p className="report__units">
            Showing {rankingRows.length} of {rankingsMeta.countries.length} countries. Annual
            figures are daily country averages × 365 from the Global Solar Atlas summary tables.
          </p>
        </div>
      </div>
    </div>
  );
}
