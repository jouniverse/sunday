/**
 * Insights Portfolio: project site roll-up + country context cards.
 */

import { useEffect, useMemo, useState } from "react";
import type { Site } from "@/core/store/siteStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button } from "@/design-system/controls";
import {
  Callout,
  DataGrid,
  EmptyState,
  ProvenanceBadge,
  Stat,
  StatCluster,
} from "@/design-system/data";
import { ChartIcon } from "@/design-system/icons";
import { capacityDisagreementPct } from "@/domain/insights/indicators";
import { computeFillFactor } from "@/domain/packing/ground-mount";
import { moduleById } from "@/domain/packing/priors";
import { hasBlockingNudge } from "@/domain/siting/nudges";
import { formatNumber, scaleArea, scalePower } from "@/domain/units";
import { countryByIso3, loadCountryRankings } from "@/services/datasets/country-rankings";
import { gemOperatingGw, irenaCapacityGw } from "@/services/insights/bundles";
import { iso3ForLngLat } from "@/services/insights/country-from-point";

/** Sum named-design ratings so CSP MWₑ and rooftop kW show, not only greenfield packing. */
function designedCapacityKw(site: Site): number | undefined {
  const fromSaved = (site.designs ?? []).reduce((sum, design) => {
    if (design.capacityMwe != null && Number.isFinite(design.capacityMwe) && design.capacityMwe > 0) {
      return sum + design.capacityMwe * 1000;
    }
    if (design.capacityKwDc != null && Number.isFinite(design.capacityKwDc) && design.capacityKwDc > 0) {
      return sum + design.capacityKwDc;
    }
    return sum;
  }, 0);
  if (fromSaved > 0) return fromSaved;

  const module = site.design ? moduleById(site.design.moduleId) : undefined;
  if (!site.design || !module || site.areaM2 <= 0) return undefined;
  return computeFillFactor({
    usableAreaM2: site.areaM2,
    module,
    mount: site.design.mount,
    tiltDegrees: site.design.tiltDegrees,
    gcr: site.design.groundCoverageRatio,
    balanceOfSystemFraction: site.design.balanceOfSystemFraction,
  }).capacityKwDc;
}

function greenfieldFillFactor(site: Site): number | undefined {
  const designs = site.designs ?? [];
  const hasGreenfield = designs.some((design) => design.kind === "greenfield");
  const onlyOtherFamilies =
    designs.length > 0 &&
    !hasGreenfield &&
    designs.every(
      (design) =>
        design.kind === "rooftop" || design.kind === "csp-tower" || design.kind === "csp-trough",
    );
  if (onlyOtherFamilies) return undefined;
  const module = site.design ? moduleById(site.design.moduleId) : undefined;
  if (!site.design || !module || site.areaM2 <= 0) return undefined;
  return computeFillFactor({
    usableAreaM2: site.areaM2,
    module,
    mount: site.design.mount,
    tiltDegrees: site.design.tiltDegrees,
    gcr: site.design.groundCoverageRatio,
    balanceOfSystemFraction: site.design.balanceOfSystemFraction,
  }).fillFactor;
}

interface CountryCard {
  iso3: string;
  name: string;
  siteCount: number;
  rankPvout: number | null | undefined;
  rankGhi: number | null | undefined;
  ghi: number | null | undefined;
  pvout: number | null | undefined;
  irenaGw: number | undefined;
  gemGw: number | undefined;
  disagreementPct: number | null;
}

export function PortfolioPanel() {
  const sites = useSiteStore((state) => state.sites);
  const selectSite = useSiteStore((state) => state.selectSite);
  const setView = useUiStore((state) => state.setView);
  const [countryCards, setCountryCards] = useState<CountryCard[]>([]);
  const rankingsMeta = loadCountryRankings();

  const rows = useMemo(
    () =>
      sites.map((site) => {
        const designs = site.designs ?? [];
        return {
          id: site.id,
          name: site.name,
          areaM2: site.areaM2,
          ghi: site.resource?.ghiKwhM2Year,
          capacityKw: designedCapacityKw(site),
          fillFactor: greenfieldFillFactor(site),
          designCount: designs.length,
          designNames: designs.map((design) => design.name).join(", "),
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

  useEffect(() => {
    let cancelled = false;
    async function resolveCountries() {
      const counts = new Map<string, { name: string; count: number }>();
      for (const site of sites) {
        const hit = await iso3ForLngLat(site.centre[0], site.centre[1]);
        if (!hit) continue;
        const prev = counts.get(hit.iso3) ?? { name: hit.name, count: 0 };
        prev.count += 1;
        counts.set(hit.iso3, prev);
      }
      if (cancelled) return;
      const cards: CountryCard[] = [...counts.entries()].map(([iso3, meta]) => {
        const ranking = countryByIso3(iso3);
        const irenaGw = irenaCapacityGw(iso3);
        const gemGw = gemOperatingGw(iso3);
        return {
          iso3,
          name: ranking?.name ?? meta.name,
          siteCount: meta.count,
          rankPvout: ranking?.rankPvout,
          rankGhi: ranking?.rankGhi,
          ghi: ranking?.ghiKwhM2Year,
          pvout: ranking?.pvoutKwhKwpYear,
          irenaGw,
          gemGw,
          disagreementPct: capacityDisagreementPct(irenaGw, gemGw),
        };
      });
      setCountryCards(cards.sort((a, b) => a.name.localeCompare(b.name)));
    }
    void resolveCountries();
    return () => {
      cancelled = true;
    };
  }, [sites]);

  if (sites.length === 0) {
    return (
      <div className="insights__placeholder">
        <EmptyState
          icon={<ChartIcon size={28} />}
          title="Nothing in the portfolio yet"
          body="Insights Portfolio summarises the sites and designs in this project. Other Insights features stay available without sites."
          action={<Button onClick={() => setView("map")}>Go to Project</Button>}
        />
      </div>
    );
  }

  const area = scaleArea(totals.areaM2);
  const capacity = scalePower(totals.capacityKw);

  return (
    <>
      <div className="card">
        <div className="card__head">
          <h2 className="card__title">Sites</h2>
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
              key: "designs",
              header: "Designs",
              render: (row) =>
                row.designCount > 0 ? row.designNames : "—",
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
          {totals.designed} of {sites.length} sites have a saved or working design. Capacity sums
          named designs (PV kW DC and CSP MWₑ). Click a row to open it on the map.
        </p>
      </div>

      {totals.blocked > 0 && (
        <Callout tone="warning">
          {totals.blocked} site{totals.blocked === 1 ? " has" : "s have"} a blocking screening
          issue. Portfolio totals above include them, so review before quoting a capacity.
        </Callout>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card__head">
          <h2 className="card__title">Country context</h2>
        </div>
        <ProvenanceBadge
          fidelity="modelled"
          source={rankingsMeta.source}
          vintage={rankingsMeta.vintage}
          method={`${rankingsMeta.method} Capacity: IRENA + GEM (shown separately).`}
        />
        {countryCards.length === 0 ? (
          <p className="insights__lede">Resolving countries for site locations…</p>
        ) : (
          <div className="insights__country-cards">
            {countryCards.map((card) => (
              <article key={card.iso3} className="insights__country-card">
                <h3>
                  {card.name}{" "}
                  <span className="mono" style={{ color: "var(--outline)" }}>
                    ({card.iso3})
                  </span>
                </h3>
                <dl>
                  <dt>Sites in project</dt>
                  <dd>{card.siteCount}</dd>
                  <dt>PVOUT rank</dt>
                  <dd>{card.rankPvout ?? "—"}</dd>
                  <dt>GHI rank</dt>
                  <dd>{card.rankGhi ?? "—"}</dd>
                  <dt>GHI</dt>
                  <dd>{card.ghi ? `${formatNumber(card.ghi, 0)} kWh/m²` : "—"}</dd>
                  <dt>PVOUT</dt>
                  <dd>{card.pvout ? `${formatNumber(card.pvout, 0)} kWh/kWp` : "—"}</dd>
                  <dt>IRENA capacity</dt>
                  <dd>{card.irenaGw !== undefined ? `${card.irenaGw.toFixed(2)} GW` : "—"}</dd>
                  <dt>GEM operating</dt>
                  <dd>{card.gemGw !== undefined ? `${card.gemGw.toFixed(2)} GW` : "—"}</dd>
                </dl>
                {card.disagreementPct !== null && card.disagreementPct > 15 && (
                  <Callout tone="warning">
                    IRENA and GEM differ by {card.disagreementPct.toFixed(0)}%. Official capacity
                    and inventory are not the same thing — both are shown.
                  </Callout>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
