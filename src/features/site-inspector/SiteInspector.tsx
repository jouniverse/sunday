/**
 * Right-hand inspector for the selected site.
 *
 * This is where a drawn boundary turns into engineering: geometry, then resource,
 * then screening flags, then a route into the design workflow. Every number shows
 * where it came from, and every action says what it will do before it does it.
 */

import { useState } from "react";
import { useDrawStore } from "@/core/map/draw/store";
import { useMapStore } from "@/core/store/mapStore";
import { useProjectStore } from "@/core/store/projectStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { Site, SystemFamily } from "@/core/store/siteStore";
import { screeningTechnologyOf, systemFamilyOf, useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Field, IconButton, Input, Select } from "@/design-system/controls";
import {
  Callout,
  EmptyState,
  ParamList,
  ProvenanceBadge,
  SectionLabel,
} from "@/design-system/data";
import { CrosshairIcon, PolygonIcon, ReportIcon, SunIcon, TrashIcon } from "@/design-system/icons";
import type { TechnologyProfile } from "@/domain/siting/nudges";
import { evaluateSite, summariseNudges } from "@/domain/siting/nudges";
import { formatCoordinates, formatNumber, scaleArea, scaleDistance } from "@/domain/units";
import { useResourceCacheStore } from "@/core/store/resourceCacheStore";
import { platform } from "@/core/platform";
import { queryNearestGridDistance } from "@/services/datasets/grid-distance";
import { querySiteProtectedAreaOverlap } from "@/services/datasets/wdpa-intersect";
import { generateSiteReport } from "@/services/solar/orchestrator";
import type { SolarProvider } from "@/services/solar/types";
import { NudgeList } from "./NudgeList";
import "./inspector.css";

export function SiteInspector() {
  const sites = useSiteStore((state) => state.sites);
  const selectedId = useSiteStore((state) => state.selectedSiteId);
  const selectSite = useSiteStore((state) => state.selectSite);
  const site = sites.find((entry) => entry.id === selectedId) ?? null;

  if (sites.length === 0) {
    return (
      <EmptyState
        icon={<PolygonIcon size={28} />}
        title="No sites yet"
        body="Draw a boundary with the Draw site tool, or mark a location, to start a resource report and a system design."
      />
    );
  }

  if (!site) {
    return (
      <div>
        <SectionLabel>Sites</SectionLabel>
        {sites.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="site-list__item"
            onClick={() => selectSite(entry.id)}
          >
            <span className="site-list__name">{entry.name}</span>
            <span className="site-list__meta mono">
              {entry.areaM2 > 0
                ? `${scaleArea(entry.areaM2).value} ${scaleArea(entry.areaM2).unit}`
                : "point"}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return <SiteDetail site={site} />;
}

function SiteDetail({ site }: { site: Site }) {
  const sites = useSiteStore((state) => state.sites);
  const renameSite = useSiteStore((state) => state.renameSite);
  const removeSite = useSiteStore((state) => state.removeSite);
  const selectSite = useSiteStore((state) => state.selectSite);
  const setResource = useSiteStore((state) => state.setResource);
  const setTerrain = useSiteStore((state) => state.setTerrain);
  const setNudges = useSiteStore((state) => state.setNudges);
  const setSystemFamily = useSiteStore((state) => state.setSystemFamily);
  const setScreeningTechnology = useSiteStore((state) => state.setScreeningTechnology);
  const flyTo = useMapStore((state) => state.flyTo);
  const setView = useUiStore((state) => state.setView);
  const notify = useUiStore((state) => state.notify);
  const startBusy = useUiStore((state) => state.startBusy);
  const endBusy = useUiStore((state) => state.endBusy);
  const screeningBusy = useUiStore((state) => Boolean(state.busy.screening));
  const markDirty = useProjectStore((state) => state.markDirty);
  const beginEdit = useDrawStore((state) => state.beginEdit);
  const cancelDraw = useDrawStore((state) => state.cancel);
  const useKey = useSettingsStore((state) => state.useKey);

  const [fetching, setFetching] = useState(false);
  const technology = screeningTechnologyOf(site);

  const area = scaleArea(site.areaM2);
  const perimeter = scaleDistance(site.perimeterM);

  /** Fans the location out to the free providers and stores the consensus. */
  async function fetchResource() {
    setFetching(true);
    startBusy("resource", "Fetching solar resource");
    try {
      const latitude = site.centre[1];
      const longitude = site.centre[0];
      const cache = useResourceCacheStore.getState();
      let report = cache.get(latitude, longitude);
      const fromCache = Boolean(report);
      if (!report) {
        const providers: SolarProvider[] = ["pvgis", "nasa_power", "nlr"];
        report = await generateSiteReport({
          latitude,
          longitude,
          providers,
          getApiKey: (provider) => useKey(provider),
          capacityKwDc: 1,
          optimiseTilt: true,
        });
        cache.set(latitude, longitude, report);
      }

      const consensus = report.consensus;
      if (!consensus.ghiKwhM2Year) {
        const failures = report.outcomes
          .filter((outcome) => outcome.status !== "ok")
          .map((outcome) => `${outcome.provider}: ${outcome.reason ?? ""}`)
          .join(" · ");
        const pvgis = report.reports.find((entry) => entry.provider === "pvgis");
        notify({
          tone: "warning",
          message: "No source returned irradiation for this location",
          detail:
            failures +
            (pvgis?.requestUrl ? ` · PVGIS URL: ${pvgis.requestUrl}` : ""),
        });
        return;
      }

      const primary = report.reports.find(
        (entry) => entry.provider === consensus.ghiKwhM2Year?.from[0],
      );
      const pvgisFailure = report.outcomes.find(
        (outcome) => outcome.provider === "pvgis" && outcome.status !== "ok",
      );
      setResource(site.id, {
        ghiKwhM2Year: consensus.ghiKwhM2Year.value,
        dniKwhM2Year: consensus.dniKwhM2Year?.value,
        optimalTiltDegrees: consensus.optimalTiltDegrees?.value,
        meanAirTempC: consensus.meanAirTempC?.value ?? primary?.meanAirTempC,
        source: primary?.source ?? "multiple sources",
        vintage: primary?.vintage,
        fidelity: primary?.fidelity ?? "modelled",
        method:
          (primary?.dataset ? `${primary.dataset} · ` : "") +
          (consensus.ghiKwhM2Year.note ?? primary?.method ?? "multi-source consensus"),
      });
      markDirty();

      for (const warning of report.warnings) {
        notify({ tone: "warning", message: warning });
      }
      if (pvgisFailure) {
        notify({
          tone: "warning",
          message: "PVGIS did not return data for this site",
          detail: pvgisFailure.reason ?? "See Report view for the full provider breakdown.",
        });
      }
      notify({
        tone: "success",
        message: `Resource fetched from ${report.reports.length} source${report.reports.length === 1 ? "" : "s"}`,
        detail: fromCache
          ? "Reused the cached multi-source report from Report / a prior fetch."
          : undefined,
      });
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not fetch the solar resource",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFetching(false);
      endBusy("resource");
    }
  }

  /** Runs the screening soft rules over whatever facts are known. */
  async function runScreening() {
    startBusy("screening", "Running screening checks");
    // Two frames so React can commit the busy state and the status bar can paint
    // before WDPA / Terrarium / Overpass occupy the main thread.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    try {
      let inProtectedArea: boolean | undefined;
      let protectedAreasAvailable: boolean | undefined;
      try {
        const wdpa = await querySiteProtectedAreaOverlap({
          centre: site.centre,
          ring: site.ring,
        });
        protectedAreasAvailable = wdpa.available;
        inProtectedArea = wdpa.available ? wdpa.intersects : undefined;
      } catch (error) {
        protectedAreasAvailable = false;
        notify({
          tone: "warning",
          message: "Protected-area check failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      // Sample AWS Terrarium slope for the selected site (desktop). Leave unset on failure.
      let meanSlopeDegrees = site.terrain?.meanSlopeDegrees;
      let aspectDegrees = site.terrain?.aspectDegrees;
      if (platform().kind === "tauri") {
        try {
          const ring =
            site.ring && site.ring.length >= 3
              ? site.ring
              : ([
                  [site.centre[0] - 0.002, site.centre[1] - 0.002],
                  [site.centre[0] + 0.002, site.centre[1] - 0.002],
                  [site.centre[0] + 0.002, site.centre[1] + 0.002],
                  [site.centre[0] - 0.002, site.centre[1] + 0.002],
                ] as Array<[number, number]>);
          const zonal = await platform().terrain.slopeZonal([ring]);
          setTerrain(site.id, {
            meanSlopeDegrees: zonal.meanSlopeDegrees,
            maxSlopeDegrees: zonal.maxSlopeDegrees,
            meanElevationM: zonal.meanElevationM ?? undefined,
            source: `AWS Terrarium (${zonal.method})`,
          });
          meanSlopeDegrees = zonal.meanSlopeDegrees;
        } catch (error) {
          notify({
            tone: "info",
            message: "Terrain slope not sampled",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Indicative OSM HV proximity (Overpass). Omit distance when unavailable.
      let gridDistanceKm: number | undefined;
      try {
        const grid = await queryNearestGridDistance({ centre: site.centre });
        if (!grid.available) {
          notify({
            tone: "info",
            message: "Grid distance not checked",
            detail:
              "Overpass was unreachable. Check the network; OSM coverage varies by region.",
          });
        } else if (grid.distanceKm != null) {
          gridDistanceKm = grid.distanceKm;
        } else {
          notify({
            tone: "info",
            message: "No mapped HV grid within 100 km",
            detail: "OSM via Overpass — indicative only, not hosting capacity.",
          });
        }
      } catch (error) {
        notify({
          tone: "info",
          message: "Grid distance not checked",
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      const nudges = evaluateSite({
        areaM2: site.areaM2,
        latitude: site.centre[1],
        technology,
        meanSlopeDegrees,
        aspectDegrees,
        ghiKwhM2Year: site.resource?.ghiKwhM2Year,
        dniKwhM2Year: site.resource?.dniKwhM2Year,
        invalidGeometry: site.ring !== null && !site.geometryValid,
        inProtectedArea,
        protectedAreasAvailable,
        gridDistanceKm,
      });
      setNudges(site.id, nudges);
      markDirty();

      const summary = summariseNudges(nudges);
      notify({
        tone: summary.blocking > 0 ? "warning" : "info",
        message:
          summary.blocking > 0
            ? `${summary.blocking} blocking issue${summary.blocking === 1 ? "" : "s"} found`
            : summary.caution > 0
              ? `${summary.caution} point${summary.caution === 1 ? "" : "s"} to check`
              : "No obstacles found in the screening checks",
        detail: summary.disclaimer,
      });
    } finally {
      endBusy("screening");
    }
  }

  return (
    <div className="inspector">
      {sites.length > 1 && (
        <Field label="Site">
          <Select
            aria-label="Select site"
            value={site.id}
            options={sites.map((entry) => ({
              value: entry.id,
              label:
                entry.areaM2 > 0
                  ? `${entry.name} (${scaleArea(entry.areaM2).value} ${scaleArea(entry.areaM2).unit})`
                  : `${entry.name} (point)`,
            }))}
            onChange={(event) => selectSite(event.target.value)}
          />
        </Field>
      )}

      <div className="inspector__head">
        <Input
          value={site.name}
          aria-label="Site name"
          onChange={(event) => {
            renameSite(site.id, event.target.value);
            markDirty();
          }}
        />
        <IconButton
          label="Zoom to this site"
          size="sm"
          onClick={() => flyTo({ longitude: site.centre[0], latitude: site.centre[1], zoom: 15 })}
        >
          <CrosshairIcon size={14} />
        </IconButton>
        <IconButton
          label="Delete this site"
          size="sm"
          onClick={() => {
            const draw = useDrawStore.getState();
            if (draw.editingSiteId === site.id) {
              cancelDraw();
            }
            removeSite(site.id);
            markDirty();
          }}
        >
          <TrashIcon size={14} />
        </IconButton>
      </div>

      <SectionLabel>Geometry</SectionLabel>
      <ParamList
        rows={[
          {
            key: "centre",
            label: "Centre",
            value: formatCoordinates(site.centre[1], site.centre[0]),
          },
          ...(site.ring
            ? [
                {
                  key: "area",
                  label: "Area",
                  value: site.geometryValid ? `${area.value} ${area.unit}` : "invalid",
                  tone: site.geometryValid ? ("accent" as const) : ("muted" as const),
                },
                {
                  key: "perimeter",
                  label: "Perimeter",
                  value: `${perimeter.value} ${perimeter.unit}`,
                },
                { key: "corners", label: "Corners", value: String(site.ring.length) },
              ]
            : []),
        ]}
      />

      {site.ring && !site.geometryValid && (
        <Callout tone="error">
          This boundary crosses itself, so it has no defined area. Edit the corners until the
          outline is simple.
        </Callout>
      )}

      {site.ring && (
        <Button
          block
          icon={<PolygonIcon size={13} />}
          onClick={() =>
            beginEdit(site.id, {
              id: site.id,
              vertices: site.ring as [number, number][],
              closed: true,
            })
          }
        >
          Edit boundary
        </Button>
      )}

      <SectionLabel>Solar resource</SectionLabel>
      {site.resource ? (
        <>
          <ParamList
            rows={[
              {
                key: "ghi",
                label: "GHI",
                value: `${formatNumber(site.resource.ghiKwhM2Year ?? 0, 0)} kWh/m²/yr`,
                tone: "solar",
              },
              ...(site.resource.dniKwhM2Year
                ? [
                    {
                      key: "dni",
                      label: "DNI",
                      value: `${formatNumber(site.resource.dniKwhM2Year, 0)} kWh/m²/yr`,
                    },
                  ]
                : []),
              ...(site.resource.optimalTiltDegrees !== undefined
                ? [
                    {
                      key: "tilt",
                      label: "Optimal tilt",
                      value: `${formatNumber(site.resource.optimalTiltDegrees, 1)}°`,
                      tone: "accent" as const,
                    },
                  ]
                : []),
            ]}
          />
          <ProvenanceBadge
            fidelity={site.resource.fidelity}
            source={site.resource.source}
            vintage={site.resource.vintage}
            method={site.resource.method}
          />
        </>
      ) : (
        <Callout tone="note">
          No resource data yet. Fetching queries PVGIS and NASA POWER, which are free and need no
          key, plus NLR if you have configured a key.
        </Callout>
      )}

      <Button
        block
        variant={site.resource ? "secondary" : "primary"}
        icon={<SunIcon size={13} />}
        disabled={fetching}
        onClick={fetchResource}
      >
        {fetching ? "Fetching…" : site.resource ? "Refresh resource" : "Fetch solar resource"}
      </Button>

      <SectionLabel>Screening</SectionLabel>
      <div className="inspector__technology">
        {(
          [
            ["pv_fixed", "PV fixed"],
            ["pv_tracker", "PV tracker"],
            ["csp", "CSP"],
            ["rooftop", "Rooftop"],
          ] as Array<[TechnologyProfile, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="tool-chip"
            aria-pressed={technology === value}
            onClick={() => {
              setScreeningTechnology(site.id, value);
              markDirty();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Button block disabled={screeningBusy} onClick={() => void runScreening()}>
        {screeningBusy ? "Running screening checks…" : "Run screening checks"}
      </Button>
      <NudgeList nudges={site.nudges} />

      <SectionLabel>System</SectionLabel>
      <div className="inspector__technology">
        {(
          [
            ["pv-greenfield", "PV"],
            ["pv-rooftop", "Rooftop PV"],
            ["csp", "CSP"],
          ] as Array<[SystemFamily, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="tool-chip"
            aria-pressed={systemFamilyOf(site) === value}
            onClick={() => {
              setSystemFamily(site.id, value);
              markDirty();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inspector__actions">
        <Button
          block
          variant="primary"
          disabled={
            systemFamilyOf(site) !== "pv-rooftop" && (!site.ring || !site.geometryValid)
          }
          onClick={() => setView("design")}
          title={
            systemFamilyOf(site) === "pv-rooftop"
              ? "Design a rooftop system"
              : site.ring
                ? "Design a system for this boundary"
                : "Area designs need a boundary; choose Rooftop PV for building-level design"
          }
        >
          Design a system
        </Button>
        <Button block icon={<ReportIcon size={13} />} onClick={() => setView("report")}>
          Open site report
        </Button>
      </div>
    </div>
  );
}
