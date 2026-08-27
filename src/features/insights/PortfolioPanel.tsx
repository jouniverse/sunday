/**
 * Insights Portfolio: project site roll-up + country context cards.
 */

import { useEffect, useMemo, useState } from "react";
import type { SavedDesign, Site } from "@/core/store/siteStore";
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

function capacityKwOfDesign(design: SavedDesign): number | undefined {
  if (design.capacityMwe != null && Number.isFinite(design.capacityMwe) && design.capacityMwe > 0) {
    return design.capacityMwe * 1000;
  }
  if (
    design.capacityKwDc != null &&
    Number.isFinite(design.capacityKwDc) &&
    design.capacityKwDc > 0
  ) {
    return design.capacityKwDc;
  }
  return undefined;
}

/** Working greenfield packing when the site has no named design yet. */
function workingGreenfieldPacking(site: Site) {
  const module = site.design ? moduleById(site.design.moduleId) : undefined;
  if (!site.design || !module || site.areaM2 <= 0) return undefined;
  return computeFillFactor({
    usableAreaM2: site.areaM2,
    module,
    mount: site.design.mount,
    tiltDegrees: site.design.tiltDegrees,
    gcr: site.design.groundCoverageRatio,
    balanceOfSystemFraction: site.design.balanceOfSystemFraction,
  });
}

function fillFactorOfDesign(site: Site, design: SavedDesign): number | undefined {
  if (design.kind !== "greenfield") return undefined;
  const parameters =
    design.parameters ?? (site.activeDesignId === design.id ? site.design : undefined);
  const module = parameters ? moduleById(parameters.moduleId) : undefined;
  if (!parameters || !module || site.areaM2 <= 0) return undefined;
  return computeFillFactor({
    usableAreaM2: site.areaM2,
    module,
    mount: parameters.mount,
    tiltDegrees: parameters.tiltDegrees,
    gcr: parameters.groundCoverageRatio,
    balanceOfSystemFraction: parameters.balanceOfSystemFraction,
  }).fillFactor;
}

/**
 * One rating per site for the header total: the active named design, else the
 * last saved one, else working packing. Named designs are variations, not
 * additive subarrays, so they are never summed.
 */
function representativeCapacityKw(site: Site): number | undefined {
  const designs = site.designs ?? [];
  if (designs.length > 0) {
    const chosen =
      designs.find((design) => design.id === site.activeDesignId) ?? designs[designs.length - 1];
    return chosen ? capacityKwOfDesign(chosen) : undefined;
  }
  return workingGreenfieldPacking(site)?.capacityKwDc;
}

function designKindLabel(kind: SavedDesign["kind"]): string {
  switch (kind) {
    case "greenfield":
      return "Greenfield PV";
    case "rooftop":
      return "Rooftop";
    case "csp-tower":
      return "CSP tower";
    case "csp-trough":
      return "CSP trough";
  }
}

function formatCapacity(capacityKw: number | undefined): string {
  if (capacityKw == null) return "—";
  const scaled = scalePower(capacityKw);
  return `${scaled.value} ${scaled.unit}`;
}

function formatFillFactor(fillFactor: number | undefined): string {
  if (fillFactor == null) return "—";
  return `${(fillFactor * 100).toFixed(1)}%`;
}

interface PortfolioRow {
  id: string;
  level: "site" | "design";
  siteId: string;
  designId?: string;
  name: string;
  designCount: number;
  active?: boolean;
  areaM2?: number;
  ghi?: number;
  kindLabel?: string;
  capacityKw?: number;
  fillFactor?: number;
  screened?: boolean;
  blocked?: boolean;
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
  const selectDesign = useSiteStore((state) => state.selectDesign);
  const setView = useUiStore((state) => state.setView);
  const [countryCards, setCountryCards] = useState<CountryCard[]>([]);
  const rankingsMeta = loadCountryRankings();

  const rows = useMemo(() => {
    const next: PortfolioRow[] = [];
    for (const site of sites) {
      const designs = site.designs ?? [];
      const packing = designs.length === 0 ? workingGreenfieldPacking(site) : undefined;
      next.push({
        id: site.id,
        level: "site",
        siteId: site.id,
        name: site.name,
        designCount: designs.length,
        areaM2: site.areaM2,
        ghi: site.resource?.ghiKwhM2Year,
        capacityKw: packing?.capacityKwDc,
        fillFactor: packing?.fillFactor,
        screened: site.nudges.length > 0,
        blocked: hasBlockingNudge(site.nudges),
      });
      for (const design of designs) {
        next.push({
          id: `${site.id}/${design.id}`,
          level: "design",
          siteId: site.id,
          designId: design.id,
          name: design.name,
          designCount: 0,
          active: design.id === site.activeDesignId,
          kindLabel: designKindLabel(design.kind),
          capacityKw: capacityKwOfDesign(design),
          fillFactor: fillFactorOfDesign(site, design),
        });
      }
    }
    return next;
  }, [sites]);

  const totals = useMemo(
    () => ({
      areaM2: sites.reduce((sum, site) => sum + site.areaM2, 0),
      capacityKw: sites.reduce((sum, site) => sum + (representativeCapacityKw(site) ?? 0), 0),
      designed: sites.filter((site) => representativeCapacityKw(site) !== undefined).length,
      blocked: sites.filter((site) => hasBlockingNudge(site.nudges)).length,
    }),
    [sites],
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
          caption="Sites and designs in this project"
          columns={[
            {
              key: "name",
              header: "Site",
              render: (row) =>
                row.level === "design" ? (
                  <span className="insights__portfolio-nested">
                    {row.name}
                    {row.active ? " · active" : ""}
                  </span>
                ) : (
                  <>
                    {row.name}
                    {row.designCount > 0 && (
                      <span className="insights__portfolio-meta">
                        {" "}
                        · {row.designCount} design{row.designCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </>
                ),
            },
            {
              key: "area",
              header: "Area",
              numeric: true,
              render: (row) => {
                if (row.level === "design" || row.areaM2 == null) return "—";
                if (row.areaM2 <= 0) return "point";
                const area = scaleArea(row.areaM2);
                return `${area.value} ${area.unit}`;
              },
            },
            {
              key: "ghi",
              header: "GHI",
              numeric: true,
              render: (row) => (row.ghi ? formatNumber(row.ghi, 0) : "—"),
            },
            {
              key: "kind",
              header: "Kind",
              render: (row) => row.kindLabel ?? "—",
            },
            {
              key: "capacity",
              header: "Capacity",
              numeric: true,
              render: (row) => formatCapacity(row.capacityKw),
            },
            {
              key: "fill",
              header: "Fill factor",
              numeric: true,
              render: (row) => formatFillFactor(row.fillFactor),
            },
            {
              key: "screening",
              header: "Screening",
              render: (row) => {
                if (row.level === "design") return "—";
                if (!row.screened) return "not run";
                return row.blocked ? "blocking issues" : "no obstacles";
              },
            },
          ]}
          rows={rows}
          rowKey={(row) => row.id}
          onRowClick={(row) => {
            selectSite(row.siteId);
            if (row.level === "design" && row.designId) {
              selectDesign(row.siteId, row.designId);
              setView("design");
              return;
            }
            setView("map");
          }}
        />
        <p className="report__units">
          {totals.designed} of {sites.length} sites have a saved or working design. Named designs
          are variations of a site, not additive plants — each row shows that design’s own capacity
          (PV kW DC or CSP MWₑ). Fill factor is module area over usable site area for greenfield
          packing; rooftop and CSP have none. Designed capacity above uses the active design on each
          site. Click a site to open it on the map, or a design to open it in Design.
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
