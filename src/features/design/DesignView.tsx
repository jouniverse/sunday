/**
 * System design view.
 *
 * The envelope pattern in practice: automation proposes a feasible range and a
 * recommended band from site geometry and latitude, the designer moves inside it,
 * and every consequence updates live. Nothing is hidden and nothing is locked.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectLibraryStore } from "@/core/store/projectLibraryStore";
import { useProjectStore } from "@/core/store/projectStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { Site, DesignParameters } from "@/core/store/siteStore";
import { newDesignId, systemFamilyOf, useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Field, IconButton, Input, Select, Stepper } from "@/design-system/controls";
import {
  Callout,
  EmptyState,
  EnvelopeSlider,
  Meter,
  ParamList,
  ProvenanceBadge,
  SectionLabel,
  Stat,
  StatCluster,
} from "@/design-system/data";
import { CompassIcon, CrosshairIcon, PanelIcon, PolygonIcon } from "@/design-system/icons";
import { COST_DEFAULTS, computeLcoe, computeOwnerCashFlow } from "@/domain/finance/cashflow";
import {
  computeFillFactor,
  designEnvelope,
  firstOrderShadingLoss,
} from "@/domain/packing/ground-mount";
import type { MountType } from "@/domain/packing/priors";
import { defaultSystemLosses, MODULE_LIBRARY, moduleById } from "@/domain/packing/priors";
import {
  compassPoint,
  equatorFacingAzimuth,
  formatNumber,
  formatPercent,
  scaleArea,
  scaleEnergy,
  scaleMoney,
  scalePower,
} from "@/domain/units";
import { modelledOrFirstOrder } from "@/services/engine/client";
import { defaultMeta, toCsv, writeExport } from "@/services/export";
import { exportDesignHtml } from "@/services/export/design-html";
import { buildZip } from "@/services/export/zip";
import { SidePanel } from "@/shell/SidePanel";
import { satelliteSnapshot } from "@/core/map/satelliteExport";
import { ArrayMapPreview, type ArrayMapPreviewHandle } from "./ArrayMapPreview";
import { buildFullSchematicSvg, computeArrayStrips } from "./ArrayPreview";
import { CspDesignView } from "./CspDesignView";
import { DesignExportMenu, type DesignExportFormat } from "./DesignExportMenu";
import { RooftopDesignView } from "./RooftopDesignView";
import "./design.css";

const MOUNTS: Array<{ value: MountType; label: string }> = [
  { value: "fixed_tilt", label: "Fixed tilt" },
  { value: "single_axis", label: "Single-axis tracker" },
  { value: "dual_axis", label: "Dual-axis tracker" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function activeGreenfieldParameters(site: Site): DesignParameters | undefined {
  const active = site.designs?.find(
    (entry) => entry.id === site.activeDesignId && entry.kind === "greenfield",
  );
  return active?.parameters ?? site.design;
}

export function DesignView() {
  const sites = useSiteStore((state) => state.sites);
  const selectedId = useSiteStore((state) => state.selectedSiteId);
  const setView = useUiStore((state) => state.setView);
  const site = sites.find((entry) => entry.id === selectedId) ?? null;

  if (!site) {
    return (
      <div className="content-view">
        <div className="content-view__inner">
          <EmptyState
            icon={<PolygonIcon size={28} />}
            title="Select a site"
            body="Pick a site from the map, then open Design. Area sites use the greenfield packing engine or CSP design; rooftop sites use local module packing, with optional Google Solar building insights."
            action={<Button onClick={() => setView("map")}>Go to the map</Button>}
          />
        </div>
      </div>
    );
  }

  const family = systemFamilyOf(site);

  if (family === "csp") {
    if (!site.ring || !site.geometryValid) {
      return (
        <div className="content-view">
          <div className="content-view__inner">
            <EmptyState
              icon={<PolygonIcon size={28} />}
              title="Select a site with a boundary"
              body="A CSP design needs an area to place the field in. Draw a boundary on the map, then choose CSP under System in the inspector."
              action={<Button onClick={() => setView("map")}>Go to the map</Button>}
            />
          </div>
        </div>
      );
    }
    return <CspDesignView key={site.id} site={site} />;
  }

  if (family === "pv-rooftop" || site.kind === "rooftop") {
    return <RooftopDesignView key={site.id} site={site} />;
  }

  if (!site.ring || !site.geometryValid) {
    return (
      <div className="content-view">
        <div className="content-view__inner">
          <EmptyState
            icon={<PolygonIcon size={28} />}
            title="Select a site with a boundary"
            body="A greenfield design needs an area to place modules in. Draw a boundary on the map, or choose Rooftop PV under System in the inspector."
            action={<Button onClick={() => setView("map")}>Go to the map</Button>}
          />
        </div>
      </div>
    );
  }

  return <DesignWorkspace key={site.id} site={site} />;
}

function DesignWorkspace({ site }: { site: Site }) {
  const saveNamedDesign = useSiteStore((state) => state.saveNamedDesign);
  const selectDesign = useSiteStore((state) => state.selectDesign);
  const renameDesign = useSiteStore((state) => state.renameDesign);
  const renameSite = useSiteStore((state) => state.renameSite);
  const markDirty = useProjectStore((state) => state.markDirty);
  const notify = useUiStore((state) => state.notify);
  const leftCollapsed = useUiStore((state) => state.leftPanelCollapsed);
  const toggleLeft = useUiStore((state) => state.toggleLeftPanel);
  const rightCollapsed = useUiStore((state) => state.rightPanelCollapsed);
  const toggleRight = useUiStore((state) => state.toggleRightPanel);
  const setRightCollapsed = useUiStore((state) => state.setRightPanelCollapsed);
  const currency = useSettingsStore((state) => state.preferences.currency);
  const projectName = useProjectStore((state) => state.name);

  const latitude = site.centre[1];
  const saved = activeGreenfieldParameters(site);
  const [moduleId, setModuleId] = useState(saved?.moduleId ?? "topcon-620");
  const [mount, setMount] = useState<MountType>(saved?.mount ?? "fixed_tilt");
  /** schematic | blend (satellite + schematic) | satellite-only */
  const [previewMode, setPreviewMode] = useState<"schematic" | "blend" | "satellite">("schematic");
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [designNameDraft, setDesignNameDraft] = useState(() => {
    const active = site.designs?.find((entry) => entry.id === site.activeDesignId);
    return active?.name ?? "";
  });
  const [siteNameDraft, setSiteNameDraft] = useState(site.name);
  const mapPreviewRef = useRef<ArrayMapPreviewHandle | null>(null);

  const module =
    moduleById(moduleId) ?? (MODULE_LIBRARY[0] as NonNullable<ReturnType<typeof moduleById>>);
  const envelope = useMemo(
    () => designEnvelope(latitude, module, mount),
    [latitude, module, mount],
  );

  // Prefer a measured/modelled optimal tilt from the site report (NASA POWER
  // consensus) over the latitude rule-of-thumb when available.
  const resourceTilt = site.resource?.optimalTiltDegrees;
  const [tilt, setTilt] = useState(saved?.tiltDegrees ?? resourceTilt ?? envelope.tilt.suggested);
  const [gcr, setGcr] = useState(saved?.groundCoverageRatio ?? envelope.gcr.suggested);
  const [azimuth, setAzimuth] = useState(
    saved?.azimuthDegrees ?? equatorFacingAzimuth(latitude),
  );
  const [bosFraction, setBosFraction] = useState(saved?.balanceOfSystemFraction ?? 0.1);

  // Keep sliders inside a new module/mount envelope. Do not reset to suggested
  // values — that wiped saved designs after load (moduleId change → new envelope).
  useEffect(() => {
    setTilt((current) => clamp(current, envelope.tilt.min, envelope.tilt.max));
    setGcr((current) => clamp(current, envelope.gcr.min, envelope.gcr.max));
  }, [envelope]);

  const packing = useMemo(
    () =>
      computeFillFactor({
        usableAreaM2: site.areaM2,
        module,
        mount,
        tiltDegrees: tilt,
        gcr,
        balanceOfSystemFraction: bosFraction,
      }),
    [site.areaM2, module, mount, tilt, gcr, bosFraction],
  );

  const shading = useMemo(() => firstOrderShadingLoss(gcr, tilt, latitude), [gcr, tilt, latitude]);

  const [energy, setEnergy] = useState<{
    annualKwh: number;
    specificYieldKwhPerKwp: number;
    capacityFactor: number;
    performanceRatio: number;
    fidelity: "modelled" | "first_order";
    method: string;
    caveats: string[];
  } | null>(null);
  const [running, setRunning] = useState(false);
  const setResource = useSiteStore((state) => state.setResource);
  const [zonal, setZonal] = useState<{
    ghi: number;
    method: string;
    min: number;
    max: number;
  } | null>(null);
  const [sampling, setSampling] = useState(false);

  const ghi = zonal?.ghi ?? site.resource?.ghiKwhM2Year;

  async function sampleRasterResource() {
    if (!site.ring || site.ring.length < 3) {
      notify({
        tone: "warning",
        message: "A boundary is required to sample a raster",
      });
      return;
    }
    setSampling(true);
    try {
      const { sampleSiteRaster, rastersConfigured, markGsaLayersFromSettings } = await import(
        "@/services/datasets/raster-sample"
      );
      if (!rastersConfigured()) {
        notify({
          tone: "info",
          message: "No Solargis COG source configured",
          detail: "Set a raster base URL or local directory in Settings, then sample again.",
        });
        return;
      }
      markGsaLayersFromSettings();
      const sample = await sampleSiteRaster(site.ring, "ghi");
      if (!sample) {
        notify({
          tone: "warning",
          message: "Raster sample returned no pixels",
          detail:
            "Check that the COG covers this site. Expected GHI.tif or GHI_cog.tif in the configured directory.",
        });
        return;
      }
      setZonal({
        ghi: sample.areaWeightedMean,
        method: sample.method,
        min: sample.min,
        max: sample.max,
      });
      setResource(site.id, {
        ghiKwhM2Year: sample.areaWeightedMean,
        source: `Solargis / Global Solar Atlas (${sample.fileName})`,
        fidelity: "modelled",
        method: sample.method,
      });
      markDirty();
      notify({
        tone: "success",
        message: `Site GHI ${Math.round(sample.areaWeightedMean)} kWh/m²/year from COG`,
        detail: sample.method,
      });
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not sample the solar raster",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSampling(false);
    }
  }

  async function runEnergyModel() {
    if (!ghi) {
      notify({
        tone: "warning",
        message: "Fetch the solar resource first",
        detail: "A yield estimate needs an irradiation figure for this location.",
      });
      return;
    }
    setRunning(true);
    try {
      const result = await modelledOrFirstOrder({
        site: { latitude, longitude: site.centre[0] },
        array: {
          surface_tilt: mount === "fixed_tilt" ? tilt : 0,
          surface_azimuth: azimuth,
          dc_capacity_kw: packing.capacityKwDc,
          gamma_pdc: module.gammaPdc,
          system_losses: defaultSystemLosses() + shading.lossFraction,
          mount: mount === "fixed_tilt" ? "fixed" : "single_axis",
          ground_coverage_ratio: gcr,
        },
        fallbackGhiKwhM2Year: ghi,
        meanAmbientTempC: site.resource?.meanAirTempC,
      });
      setEnergy(result);
      if (result.fidelity === "first_order") {
        notify({
          tone: "info",
          message: "Using a first-order estimate",
          detail: result.caveats.join(" "),
        });
      }
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not model the system",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(false);
    }
  }

  const savedDesigns = (site.designs ?? []).filter((entry) => entry.kind === "greenfield");
  const activeDesign = savedDesigns.find((entry) => entry.id === site.activeDesignId) ?? null;

  function designParameters() {
    return {
      moduleId,
      mount,
      tiltDegrees: tilt,
      azimuthDegrees: azimuth,
      groundCoverageRatio: gcr,
      balanceOfSystemFraction: bosFraction,
      systemLosses: defaultSystemLosses(),
    };
  }

  function persistDesign(options: { asNew: boolean }) {
    const id = options.asNew ? newDesignId() : (site.activeDesignId ?? newDesignId());
    const fallback = `Design ${savedDesigns.filter((entry) => entry.kind === "greenfield").length + (options.asNew || !site.activeDesignId ? 1 : 0)}`;
    const name =
      designNameDraft.trim() ||
      savedDesigns.find((entry) => entry.id === id)?.name ||
      fallback;
    saveNamedDesign(site.id, {
      id,
      name,
      updatedAt: new Date().toISOString(),
      kind: "greenfield",
      parameters: designParameters(),
      capacityKwDc: packing.capacityKwDc,
      annualKwh: energy?.annualKwh,
    });
    setDesignNameDraft(name);
    markDirty();
    void useProjectLibraryStore.getState().saveActiveToLibrary().catch(() => undefined);
    notify({
      tone: "success",
      message: options.asNew ? `Saved new design “${name}”` : `Updated design “${name}”`,
      detail: "Projects → sites → designs.",
    });
  }

  function loadSavedDesign(designId: string) {
    if (!designId) {
      selectDesign(site.id, null);
      setDesignNameDraft("");
      setAzimuth(equatorFacingAzimuth(latitude));
      return;
    }
    const selected = savedDesigns.find((entry) => entry.id === designId);
    if (!selected?.parameters) return;
    selectDesign(site.id, designId);
    setDesignNameDraft(selected.name);
    setModuleId(selected.parameters.moduleId);
    setMount(selected.parameters.mount);
    setTilt(selected.parameters.tiltDegrees);
    setAzimuth(selected.parameters.azimuthDegrees);
    setGcr(selected.parameters.groundCoverageRatio);
    setBosFraction(selected.parameters.balanceOfSystemFraction);
  }

  function designSummaryPayload() {
    return {
      siteId: site.id,
      siteName: site.name,
      designId: site.activeDesignId ?? null,
      designName: activeDesign?.name ?? (designNameDraft || null),
      moduleId,
      mount,
      tiltDegrees: tilt,
      azimuthDegrees: azimuth,
      groundCoverageRatio: gcr,
      balanceOfSystemFraction: bosFraction,
      packing: {
        moduleCount: packing.moduleCount,
        capacityKwDc: packing.capacityKwDc,
        fillFactor: packing.fillFactor,
        densityKwPerHectare: packing.densityKwPerHectare,
        method: packing.method,
      },
      energy,
      note: "Packing module count is GCR/area-based. Modelled annual energy includes azimuth via the pvlib / first-order path.",
    };
  }

  function buildHtmlExport(): string {
    const capacityScaled = scalePower(packing.capacityKwDc);
    const images = [];
    // Inline SVG — data: URLs silently fail for large schematics in WebKit.
    const schematic = buildFullSchematicSvg({
      site,
      module,
      tiltDegrees: tilt,
      gcr,
      azimuth,
      mount,
    });
    if (schematic) {
      images.push({
        title: "Array schematic",
        inlineSvg: schematic,
        caption: "Full plan view of row strips inside the site boundary.",
      });
    }
    const satellite = satelliteSnapshot(site);
    if (satellite) {
      images.push({
        title: "Site satellite",
        src: satellite.url,
        caption:
          "Esri World Imagery for the site extent. Amber outline marks the site boundary.",
        outlineNorm: satellite.outlineNorm,
      });
    }
    return exportDesignHtml({
      title: "Greenfield design summary",
      siteName: site.name,
      meta: defaultMeta(projectName),
      sections: [
        {
          title: "System summary",
          rows: [
            { label: "DC capacity", value: `${capacityScaled.value} ${capacityScaled.unit}` },
            { label: "Modules", value: String(packing.moduleCount) },
            {
              label: "Annual output",
              value: energy
                ? `${scaleEnergy(energy.annualKwh).value} ${scaleEnergy(energy.annualKwh).unit}`
                : "Not modelled yet",
            },
            {
              label: "Site area",
              value: `${scaleArea(site.areaM2).value} ${scaleArea(site.areaM2).unit}`,
            },
          ],
        },
        {
          title: "Parameters",
          rows: [
            { label: "Module", value: module.name },
            { label: "Mount", value: mount },
            { label: "Tilt", value: `${tilt}°` },
            { label: "Azimuth", value: `${azimuth}° (${compassPoint(azimuth)})` },
            { label: "GCR", value: formatPercent(gcr) },
            { label: "BOS share", value: formatPercent(bosFraction) },
          ],
        },
        {
          title: "Results",
          rows: energy
            ? [
                {
                  label: "Specific yield",
                  value: `${formatNumber(energy.specificYieldKwhPerKwp, 0)} kWh/kWp`,
                },
                { label: "Capacity factor", value: formatPercent(energy.capacityFactor) },
                { label: "Method", value: energy.method },
              ]
            : [{ label: "Status", value: "Run Estimate annual output first" }],
        },
      ],
      images,
      notes: [
        "Module packing count comes from GCR and site area. Annual energy changes with azimuth for fixed arrays.",
        "Print this page to PDF from the browser or system print dialog.",
      ],
    });
  }

  function buildGeoJson(): string {
    const strips = computeArrayStrips({
      site,
      module,
      tiltDegrees: tilt,
      gcr,
      azimuth,
      mount,
    });
    return JSON.stringify(
      {
        type: "FeatureCollection",
        features: (strips?.stripsLngLat ?? []).map((ring, index) => ({
          type: "Feature",
          properties: {
            index,
            mount,
            gcr,
            azimuth,
            pitch_m: strips?.pitchM,
          },
          geometry: {
            type: "Polygon",
            coordinates: [[...ring, ring[0]]],
          },
        })),
      },
      null,
      2,
    );
  }

  function buildDesignCsv(): string {
    const summary = designSummaryPayload();
    const row: Record<string, unknown> = {
      site_id: summary.siteId,
      site_name: summary.siteName,
      design_id: summary.designId ?? "",
      design_name: summary.designName ?? "",
      module_id: summary.moduleId,
      mount: summary.mount,
      tilt_deg: summary.tiltDegrees,
      azimuth_deg: summary.azimuthDegrees,
      ground_coverage_ratio: summary.groundCoverageRatio,
      bos_fraction: summary.balanceOfSystemFraction,
      module_count: summary.packing.moduleCount,
      capacity_kw_dc: summary.packing.capacityKwDc,
      fill_factor: summary.packing.fillFactor,
      density_kw_per_ha: summary.packing.densityKwPerHectare,
      packing_method: summary.packing.method,
      annual_kwh: energy?.annualKwh ?? "",
      specific_yield_kwh_per_kwp: energy?.specificYieldKwhPerKwp ?? "",
      capacity_factor: energy?.capacityFactor ?? "",
      energy_method: energy?.method ?? "",
      note: summary.note,
    };
    return toCsv([row]);
  }

  async function runExport(format: DesignExportFormat) {
    const base = `${site.name}-design`;
    if (format === "html") {
      const path = await writeExport(base, "html", buildHtmlExport());
      if (path) notify({ tone: "success", message: `Exported HTML to ${path}` });
      return;
    }
    if (format === "geojson") {
      const path = await writeExport(`${site.name}-array`, "geojson", buildGeoJson());
      if (path) notify({ tone: "success", message: `Exported GeoJSON to ${path}` });
      return;
    }
    if (format === "json") {
      const path = await writeExport(base, "json", JSON.stringify(designSummaryPayload(), null, 2));
      if (path) notify({ tone: "success", message: `Exported JSON to ${path}` });
      return;
    }
    if (format === "csv") {
      const path = await writeExport(base, "csv", buildDesignCsv());
      if (path) notify({ tone: "success", message: `Exported CSV to ${path}` });
      return;
    }
    const zip = buildZip([
      { name: `${base}.json`, data: JSON.stringify(designSummaryPayload(), null, 2) },
      { name: `${base}.csv`, data: buildDesignCsv() },
      { name: `${site.name}-array.geojson`, data: buildGeoJson() },
      { name: `${base}.html`, data: buildHtmlExport() },
    ]);
    const path = await writeExport(base, "zip", zip);
    if (path) notify({ tone: "success", message: `Exported ZIP to ${path}` });
  }

  const finance = useMemo(() => {
    if (!energy) return null;
    const costs = packing.capacityKwDc > 1000 ? COST_DEFAULTS.utility : COST_DEFAULTS.commercial;
    return computeLcoe({
      capacityKwDc: packing.capacityKwDc,
      annualKwh: energy.annualKwh,
      costs: { ...costs, currency },
    });
  }, [energy, packing.capacityKwDc, currency]);

  const capacity = scalePower(packing.capacityKwDc);
  const area = scaleArea(site.areaM2);

  return (
    <div className="map-workspace">
      <div className="subbar">
        <div className="breadcrumb design-breadcrumb">
          <span>Design</span>
          <span className="breadcrumb__sep">/</span>
          <input
            className="design-breadcrumb__input"
            aria-label="Site name"
            value={siteNameDraft}
            onChange={(event) => setSiteNameDraft(event.target.value)}
            onBlur={() => {
              const next = siteNameDraft.trim();
              if (next && next !== site.name) {
                renameSite(site.id, next);
                markDirty();
              } else {
                setSiteNameDraft(site.name);
              }
            }}
          />
          <span className="breadcrumb__sep">/</span>
          <input
            className="design-breadcrumb__input design-breadcrumb__input--design"
            aria-label="Design name"
            placeholder="Working design"
            value={designNameDraft}
            onChange={(event) => setDesignNameDraft(event.target.value)}
            onBlur={() => {
              if (site.activeDesignId && designNameDraft.trim()) {
                renameDesign(site.id, site.activeDesignId, designNameDraft.trim());
                markDirty();
              }
            }}
          />
        </div>
        <div className="subbar__spacer" />
        <StatCluster>
          <Stat label="Capacity" value={capacity.value} unit={capacity.unit} tone="accent" />
          {energy && (
            <Stat
              label="Annual output"
              value={scaleEnergy(energy.annualKwh).value}
              unit={scaleEnergy(energy.annualKwh).unit}
              tone="solar"
            />
          )}
          {finance && (
            <Stat
              label="LCOE"
              value={`${finance.lcoePerKwh.toFixed(3)}`}
              unit={`${currency}/kWh`}
            />
          )}
        </StatCluster>
      </div>

      <div className="workspace">
        <SidePanel
          side="left"
          title="System parameters"
          collapsed={leftCollapsed}
          onToggle={toggleLeft}
        >
          {leftCollapsed ? (
            <div className="design-rail-placeholder" title="System parameters">
              <PanelIcon size={16} />
            </div>
          ) : (
            <>
              <p className="design__lede">
                Automation computes a feasible envelope from the site and its latitude. Fine-tune
                inside it; leaving the recommended band is allowed and always labelled.
              </p>

              <Field label="Saved designs" hint="Select a saved design, or save as new to keep variants.">
                <Select
                  value={site.activeDesignId ?? ""}
                  onChange={(event) => loadSavedDesign(event.target.value)}
                  options={[
                    { value: "", label: "Working design (unsaved)" },
                    ...savedDesigns.map((entry) => ({
                      value: entry.id,
                      label: `${entry.name}${entry.capacityKwDc ? ` · ${entry.capacityKwDc.toFixed(1)} kW` : ""}`,
                    })),
                  ]}
                />
              </Field>
              <Field label="Design name">
                <div className="design-name-row">
                  <Input
                    value={designNameDraft}
                    onChange={(event) => setDesignNameDraft(event.target.value)}
                    placeholder="e.g. Fixed 32° south"
                  />
                  <IconButton
                    label="Zoom to site"
                    onClick={() => mapPreviewRef.current?.fitToSite()}
                  >
                    <CrosshairIcon size={16} />
                  </IconButton>
                </div>
              </Field>

              <Field label="Module">
                <Select
                  value={moduleId}
                  onChange={(event) => setModuleId(event.target.value)}
                  options={MODULE_LIBRARY.map((entry) => ({
                    value: entry.id,
                    label: `${entry.name} · ${(entry.efficiency * 100).toFixed(1)}%`,
                  }))}
                />
              </Field>

              <Field label="Mounting">
                <Select
                  value={mount}
                  onChange={(event) => setMount(event.target.value as MountType)}
                  options={MOUNTS}
                />
              </Field>

              {mount === "fixed_tilt" && (
                <Field label="Tilt angle">
                  <Stepper
                    value={tilt}
                    onChange={setTilt}
                    step={1}
                    min={envelope.tilt.min}
                    max={envelope.tilt.max}
                    unit="°"
                    label="Tilt angle"
                  />
                  <EnvelopeSlider
                    value={tilt}
                    onChange={setTilt}
                    min={envelope.tilt.min}
                    max={envelope.tilt.max}
                    recommendedMin={envelope.tilt.recommendedMin}
                    recommendedMax={envelope.tilt.recommendedMax}
                    step={1}
                    unit="°"
                    label="Tilt angle"
                  />
                </Field>
              )}

              <Field
                label="Ground coverage ratio (GCR)"
                hint="Collector width ÷ row pitch (not the fraction of the whole site covered by modules)."
              >
                <Stepper
                  value={gcr}
                  onChange={setGcr}
                  step={0.01}
                  min={envelope.gcr.min}
                  max={envelope.gcr.max}
                  precision={2}
                  label="Ground coverage ratio"
                />
                <EnvelopeSlider
                  value={gcr}
                  onChange={setGcr}
                  min={envelope.gcr.min}
                  max={envelope.gcr.max}
                  recommendedMin={envelope.gcr.recommendedMin}
                  recommendedMax={envelope.gcr.recommendedMax}
                  step={0.01}
                  unit=""
                  precision={2}
                  label="Ground coverage ratio"
                  outsideNote="Outside built practice for this mount — feasible, but expect more row shading or wasted land."
                />
              </Field>

              <Field
                label="Row pitch"
                hint={`${packing.row.pitchM.toFixed(2)} m centre to centre, ${packing.row.gapM.toFixed(2)} m clear between rows.`}
              >
                <div />
              </Field>

              <Field
                label="Array orientation"
                hint="Module packing count comes from GCR and site area. Annual energy does change with azimuth — equator-facing is best; large deviations cut yield substantially."
              >
                <div className="design__compass">
                  <CompassIcon size={28} />
                  <div>
                    <div className="design__azimuth mono">{azimuth.toFixed(0)}°</div>
                    <div className="design__azimuth-label">{compassPoint(azimuth)}</div>
                  </div>
                  <Stepper
                    value={azimuth}
                    onChange={setAzimuth}
                    step={5}
                    min={0}
                    max={360}
                    unit="°"
                    label="Array azimuth"
                  />
                </div>
              </Field>

              <Field
                label="Roads, pads and margins"
                hint="Share of the site not available to the array."
              >
                <Stepper
                  value={bosFraction * 100}
                  onChange={(value) => setBosFraction(value / 100)}
                  step={1}
                  min={0}
                  max={40}
                  unit="%"
                  label="Balance of system share"
                />
              </Field>

              <SectionLabel>Why these bounds</SectionLabel>
              {envelope.rationale.map((line) => (
                <p key={line} className="design__rationale">
                  {line}
                </p>
              ))}
            </>
          )}
        </SidePanel>

        <main className="canvas canvas--schematic">
          <div className="canvas-toolbar design-canvas-toolbar">
            <Select
              aria-label="Preview mode"
              value={previewMode}
              onChange={(event) =>
                setPreviewMode(event.target.value as "schematic" | "blend" | "satellite")
              }
              options={[
                { value: "schematic", label: "Schematic" },
                { value: "satellite", label: "Satellite" },
                { value: "blend", label: "Satellite + Schematic" },
              ]}
            />
            <div className="design-canvas-toolbar__actions">
              <DesignExportMenu onExport={runExport} />
            </div>
          </div>
          <div className="design-preview-stack">
            <div className="design-preview-stack__map">
              <ArrayMapPreview
                ref={mapPreviewRef}
                site={site}
                module={module}
                tiltDegrees={tilt}
                gcr={gcr}
                azimuth={azimuth}
                mount={mount}
                showStrips={previewMode !== "satellite"}
                basemap={previewMode === "schematic" ? "schematic" : "satellite"}
              />
            </div>
          </div>

          <div
            className={`design-summary-panel${summaryCollapsed ? " design-summary-panel--collapsed" : ""}`}
          >
            <div className="design-summary-panel__head">
              <h3 className="design__summary-title">System summary</h3>
              <Button size="sm" variant="ghost" onClick={() => setSummaryCollapsed((v) => !v)}>
                {summaryCollapsed ? "Expand" : "Minimize"}
              </Button>
            </div>
            {!summaryCollapsed && (
              <>
                <ParamList
                  rows={[
                    { key: "area", label: "Site area", value: `${area.value} ${area.unit}` },
                    {
                      key: "modules",
                      label: "Module count",
                      value: packing.moduleCount.toLocaleString(),
                    },
                    {
                      key: "capacity",
                      label: "Capacity DC",
                      value: `${capacity.value} ${capacity.unit}`,
                      tone: "accent",
                    },
                    {
                      key: "gcr",
                      label: "GCR (row)",
                      value: formatPercent(gcr),
                    },
                    {
                      key: "fill",
                      label: "Fill factor (site)",
                      value: formatPercent(packing.fillFactor),
                    },
                    {
                      key: "density",
                      label: "Density",
                      value: `${formatNumber(packing.densityKwPerHectare, 0)} kW/ha`,
                    },
                    {
                      key: "land",
                      label: "Land use",
                      value: `${formatNumber(packing.landUseM2PerKw, 1)} m²/kW`,
                      tone: packing.landUseWithinRuleOfThumb ? "default" : "muted",
                    },
                  ]}
                />

                <div className="design__meter">
                  <span className="label">Row GCR against built practice</span>
                  <Meter
                    value={gcr}
                    max={envelope.gcr.max}
                    bandMin={envelope.gcr.recommendedMin}
                    bandMax={envelope.gcr.recommendedMax}
                    label="Ground coverage ratio against built practice"
                  />
                </div>

                {packing.notes.map((note) => (
                  <Callout key={note} tone="warning">
                    {note}
                  </Callout>
                ))}

                <Button block disabled={sampling} onClick={sampleRasterResource}>
                  {sampling
                    ? "Sampling COG…"
                    : zonal
                      ? "Resample site from Solargis COG"
                      : "Sample site from Solargis COG"}
                </Button>
                {zonal && (
                  <Callout tone="note">
                    COG GHI {Math.round(zonal.ghi)} kWh/m²/year (range {Math.round(zonal.min)}–
                    {Math.round(zonal.max)}). {zonal.method}
                  </Callout>
                )}
                <Button
                  block
                  variant="primary"
                  icon={<PanelIcon size={13} />}
                  disabled={running}
                  onClick={runEnergyModel}
                >
                  {running ? "Modelling…" : "Estimate annual output"}
                </Button>
                <div className="design-button-stack">
                  <Button block variant="primary" onClick={() => persistDesign({ asNew: false })}>
                    Save design
                  </Button>
                  <Button block onClick={() => persistDesign({ asNew: true })}>
                    Save as new design
                  </Button>
                </div>
              </>
            )}
          </div>
        </main>

        {rightCollapsed ? (
          <div className="design-results-reopen">
            <Button size="sm" onClick={() => setRightCollapsed(false)}>
              Show results
            </Button>
          </div>
        ) : null}
        <SidePanel side="right" title="Results" collapsed={rightCollapsed} onToggle={toggleRight}>
          {energy ? (
            <>
              <ParamList
                rows={[
                  {
                    key: "annual",
                    label: "Annual output",
                    value: `${scaleEnergy(energy.annualKwh).value} ${scaleEnergy(energy.annualKwh).unit}`,
                    tone: "solar",
                  },
                  {
                    key: "specific",
                    label: "Specific yield",
                    value: `${formatNumber(energy.specificYieldKwhPerKwp, 0)} kWh/kWp`,
                  },
                  {
                    key: "cf",
                    label: "Capacity factor",
                    value: formatPercent(energy.capacityFactor),
                  },
                  {
                    key: "pr",
                    label: "Performance ratio",
                    value: formatPercent(energy.performanceRatio),
                  },
                  {
                    key: "shading",
                    label: "Row shading loss",
                    value: formatPercent(shading.lossFraction),
                  },
                ]}
              />
              <ProvenanceBadge
                fidelity={energy.fidelity === "modelled" ? "modelled" : "estimated"}
                source={
                  energy.fidelity === "modelled" ? "pvlib solar engine" : "Sunday first-order model"
                }
                method={energy.method}
              />
              {energy.caveats.map((caveat) => (
                <Callout key={caveat} tone="note">
                  {caveat}
                </Callout>
              ))}

              {finance && (
                <>
                  <SectionLabel>Economics</SectionLabel>
                  <ParamList
                    rows={[
                      {
                        key: "lcoe",
                        label: "LCOE",
                        value: `${finance.lcoePerKwh.toFixed(3)} ${currency}/kWh`,
                        tone: "accent",
                      },
                      {
                        key: "capex",
                        label: "Capital cost",
                        value: `${scaleMoney(finance.netCapex, currency).value}${scaleMoney(finance.netCapex, currency).unit}`,
                      },
                    ]}
                  />
                  {finance.assumptions.map((assumption) => (
                    <p key={assumption} className="design__rationale">
                      {assumption}
                    </p>
                  ))}
                  <RooftopFinance
                    capacityKwDc={packing.capacityKwDc}
                    annualKwh={energy.annualKwh}
                    currency={currency}
                  />
                </>
              )}

            </>
          ) : (
            <Callout tone="note">
              {ghi
                ? "Estimate the annual output to see yield, performance ratio and levelised cost."
                : "This site has no resource data yet. Fetch it from the map inspector first."}
            </Callout>
          )}
        </SidePanel>
      </div>
    </div>
  );
}

/**
 * Owner cash flow, shown only for systems small enough for it to make sense.
 *
 * A utility plant sells into a market and is judged on LCOE; a rooftop displaces
 * retail purchases and is judged on payback. Showing the wrong one is worse than
 * showing neither.
 */
function RooftopFinance({
  capacityKwDc,
  annualKwh,
  currency,
}: {
  capacityKwDc: number;
  annualKwh: number;
  currency: string;
}) {
  if (capacityKwDc > 500) return null;

  const cashflow = computeOwnerCashFlow({
    capacityKwDc,
    annualKwh,
    costs: { ...COST_DEFAULTS.commercial, currency },
    tariffPerKwh: 0.18,
    selfConsumptionFraction: 0.6,
    exportPricePerKwh: 0.05,
  });

  return (
    <>
      <SectionLabel>Owner cash flow</SectionLabel>
      <ParamList
        rows={[
          {
            key: "payback",
            label: "Discounted payback",
            value:
              cashflow.discountedPaybackYears === null
                ? "never at these prices"
                : `${cashflow.discountedPaybackYears.toFixed(1)} yr`,
          },
          {
            key: "npv",
            label: "Net present value",
            value: `${scaleMoney(cashflow.netPresentValue, currency).value}${scaleMoney(cashflow.netPresentValue, currency).unit}`,
            tone: cashflow.netPresentValue > 0 ? "accent" : "muted",
          },
          {
            key: "irr",
            label: "Internal rate of return",
            value:
              cashflow.internalRateOfReturn === null
                ? "—"
                : formatPercent(cashflow.internalRateOfReturn),
          },
        ]}
      />
      <p className="design__rationale">{cashflow.assumptions[1]}</p>
    </>
  );
}
