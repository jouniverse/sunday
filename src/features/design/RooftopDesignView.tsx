/**
 * Rooftop / BIPV design panel.
 *
 * Uses Google Solar building insights when a key is present, otherwise packs a
 * drawn roof outline with the same reviewable auto-layout engine. Automation
 * proposes a module count; the designer can change orientation and setbacks.
 */

import { useEffect, useMemo, useState } from "react";
import { useProjectLibraryStore } from "@/core/store/projectLibraryStore";
import { useProjectStore } from "@/core/store/projectStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { Site } from "@/core/store/siteStore";
import { newDesignId, useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Field, Input, Select, Stepper, Switch } from "@/design-system/controls";
import {
  Callout,
  EmptyState,
  EnvelopeSlider,
  ParamList,
  ProvenanceBadge,
  SectionLabel,
  Stat,
  StatCluster,
} from "@/design-system/data";
import { PanelIcon, PolygonIcon } from "@/design-system/icons";
import { COST_DEFAULTS, computeOwnerCashFlow } from "@/domain/finance/cashflow";
import { ringToLocalFrame } from "@/domain/geometry";
import { MODULE_LIBRARY, moduleById, ROOFTOP_DEFAULTS } from "@/domain/packing/priors";
import type { ModuleOrientation } from "@/domain/packing/rooftop";
import { packRooftop, searchRooftopLayout } from "@/domain/packing/rooftop";
import { formatNumber, formatPercent, scaleEnergy, scaleMoney, scalePower } from "@/domain/units";
import { defaultMeta, toCsv, writeExport } from "@/services/export";
import { exportDesignHtml } from "@/services/export/design-html";
import { buildZip } from "@/services/export/zip";
import { fetchBuildingInsights, findSolarConfig, dataLayerRadiusMeters } from "@/services/solar/google-solar";
import {
  imageDataToDataUrl,
  rasterToImageData,
  type DecodedRaster,
} from "@/services/solar/geotiff-decode";
import type { BuildingInsights } from "@/services/solar/types";
import { SidePanel } from "@/shell/SidePanel";
import { DesignExportMenu, type DesignExportFormat } from "./DesignExportMenu";
import {
  activePanelsExport,
  allPanelsExport,
  composeRgbPanelsDataUrl,
  RooftopPanelMap,
} from "./RooftopPanelMap";
import "./design.css";

export function RooftopDesignView({ site }: { site: Site }) {
  const saveNamedDesign = useSiteStore((state) => state.saveNamedDesign);
  const selectDesign = useSiteStore((state) => state.selectDesign);
  const renameDesign = useSiteStore((state) => state.renameDesign);
  const setResource = useSiteStore((state) => state.setResource);
  const renameSite = useSiteStore((state) => state.renameSite);
  const markDirty = useProjectStore((state) => state.markDirty);
  const notify = useUiStore((state) => state.notify);
  const leftCollapsed = useUiStore((state) => state.leftPanelCollapsed);
  const toggleLeft = useUiStore((state) => state.toggleLeftPanel);
  const rightCollapsed = useUiStore((state) => state.rightPanelCollapsed);
  const toggleRight = useUiStore((state) => state.toggleRightPanel);
  const setRightCollapsed = useUiStore((state) => state.setRightPanelCollapsed);
  const revealApiKey = useSettingsStore((state) => state.useKey);
  const currency = useSettingsStore((state) => state.preferences.currency);
  const hasGoogleKey = useSettingsStore((state) => state.configuredKeys.includes("google_solar"));

  const [moduleId, setModuleId] = useState(site.design?.moduleId ?? "mono-450");
  const [orientation, setOrientation] = useState<ModuleOrientation>("portrait");
  const [setbackM, setSetbackM] = useState<number>(ROOFTOP_DEFAULTS.perimeterSetbackM);
  const [insights, setInsights] = useState<BuildingInsights | null>(null);
  const [panelCount, setPanelCount] = useState(1);
  const [inactivePanels, setInactivePanels] = useState<Set<number>>(() => new Set());
  const [fetching, setFetching] = useState(false);
  const [fluxSummary, setFluxSummary] = useState<{
    min: number;
    max: number;
    mean: number;
    width: number;
    height: number;
    method: string;
    imageryDate?: string;
    /** True when min/max/mean were computed under the Google Solar roof MASK. */
    roofMasked?: boolean;
  } | null>(null);
  const [rgbOverlay, setRgbOverlay] = useState<{
    dataUrl: string;
    bounds: { west: number; south: number; east: number; north: number };
  } | null>(null);
  const [fluxRaster, setFluxRaster] = useState<DecodedRaster | null>(null);
  const [roofMaskRaster, setRoofMaskRaster] = useState<DecodedRaster | null>(null);
  const [monthlyFluxUrl, setMonthlyFluxUrl] = useState<string | null>(null);
  /** Last dataLayers radius — used when monthly GeoTIFFs omit georeference. */
  const [dataLayerRadiusM, setDataLayerRadiusM] = useState(90);
  const [fluxMonth, setFluxMonth] = useState(0);
  const [showRgb, setShowRgb] = useState(true);
  const [showFlux, setShowFlux] = useState(false);
  const [showPanels, setShowPanels] = useState(true);
  const [rgbOpacity, setRgbOpacity] = useState(0.65);
  const [fluxOpacity, setFluxOpacity] = useState(0.55);
  const projectName = useProjectStore((state) => state.name);
  const savedDesigns = site.designs ?? [];
  const [designNameDraft, setDesignNameDraft] = useState(() => {
    const active = site.designs?.find((entry) => entry.id === site.activeDesignId);
    return active?.name ?? "";
  });
  const [siteNameDraft, setSiteNameDraft] = useState(site.name);

  const module = useMemo(() => {
    const selected = moduleById(moduleId);
    if (selected) return selected;
    const fallback = MODULE_LIBRARY[0];
    if (!fallback) throw new Error("MODULE_LIBRARY is empty");
    return fallback;
  }, [moduleId]);

  const localRoof = useMemo(() => {
    if (!site.ring || site.ring.length < 3) return null;
    return ringToLocalFrame(site.ring).polygon;
  }, [site.ring]);

  const packing = useMemo(() => {
    if (!localRoof) return null;
    return packRooftop({
      roof: localRoof,
      module,
      orientation,
      gridRotationDegrees: site.design?.azimuthDegrees ?? 0,
      perimeterSetbackM: setbackM,
    });
  }, [localRoof, module, orientation, setbackM, site.design?.azimuthDegrees]);

  const search = useMemo(() => {
    if (!localRoof) return null;
    return searchRooftopLayout({
      roof: localRoof,
      module,
      perimeterSetbackM: setbackM,
    });
  }, [localRoof, module, setbackM]);

  const googleConfig = useMemo(() => {
    if (!insights) return null;
    return findSolarConfig(insights.configurations, panelCount);
  }, [insights, panelCount]);

  const bestConfig = googleConfig ?? insights?.configurations[0];
  const activePanelRows = useMemo(() => {
    if (!insights) return [];
    return activePanelsExport(insights, panelCount, inactivePanels);
  }, [insights, panelCount, inactivePanels]);
  const activeEnergyKwh = activePanelRows.reduce((sum, row) => sum + row.energy, 0);
  // Scale Google reference-panel energy/capacity to the module the designer selected.
  const googleWatts = insights?.panelCapacityWatts || module.ratedPowerW;
  const moduleScale = googleWatts > 0 ? module.ratedPowerW / googleWatts : 1;
  const capacityKw =
    insights && activePanelRows.length > 0
      ? (activePanelRows.length * module.ratedPowerW) / 1000
      : insights && bestConfig
        ? (bestConfig.panelCount * module.ratedPowerW) / 1000
        : (packing?.capacityKwDc ?? 0);
  const annualKwh =
    insights && activePanelRows.length > 0
      ? activeEnergyKwh * moduleScale
      : bestConfig
        ? bestConfig.yearlyEnergyDcKwh * moduleScale
        : site.resource?.ghiKwhM2Year && capacityKw
          ? site.resource.ghiKwhM2Year * capacityKw * 0.75
          : null;

  useEffect(() => {
    if (!insights) return;
    const max = Math.max(insights.solarPanels.length, insights.maxPanelCount, 1);
    const preferred =
      insights.configurations.find((c) => c.panelCount > 4)?.panelCount ??
      insights.configurations[0]?.panelCount ??
      Math.min(max, Math.max(insights.solarPanels.length, 1));
    setPanelCount(Math.min(preferred, max));
    setInactivePanels(new Set());
  }, [insights]);

  async function loadDataLayers(fromInsights?: BuildingInsights | null) {
    setFetching(true);
    try {
      const key = await revealApiKey("google_solar");
      if (!key) {
        notify({
          tone: "warning",
          message: "Add a Google Solar API key in Settings",
        });
        return;
      }
      const bi = fromInsights ?? insights;
      // Prefer the building centre Google returned — site click can be tens of metres off.
      const longitude = bi?.centre[0] ?? site.centre[0];
      const latitude = bi?.centre[1] ?? site.centre[1];
      const radiusMeters = dataLayerRadiusMeters(bi?.wholeRoofAreaM2);
      setDataLayerRadiusM(radiusMeters);

      const { fetchDataLayerUrls } = await import("@/services/solar/google-solar");
      const {
        decodeGoogleSolarBand,
        decodeGoogleSolarGeoTiff,
        decodeGoogleSolarRgb,
      } = await import("@/services/solar/geotiff-decode");
      const layers = await fetchDataLayerUrls({
        latitude,
        longitude,
        radiusMeters,
        apiKey: key,
        view: "FULL_LAYERS",
        requiredQuality: "BASE",
      });
      setMonthlyFluxUrl(layers.monthlyFluxUrl ?? null);

      if (layers.rgbUrl) {
        try {
          const { boundsAroundPoint } = await import("@/services/solar/geotiff-decode");
          const rgb = await decodeGoogleSolarRgb({ url: layers.rgbUrl, apiKey: key });
          const bounds =
            rgb.bounds ??
            boundsAroundPoint(longitude, latitude, radiusMeters);
          setRgbOverlay({ dataUrl: rgb.dataUrl, bounds });
          setShowRgb(true);
        } catch (error) {
          notify({
            tone: "warning",
            message: "RGB overlay could not be decoded",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const fluxUrl = layers.annualFluxUrl;
      if (!fluxUrl) {
        notify({
          tone: "warning",
          message: "No annual flux layer at this location",
          detail: "Google Solar data layers are limited to covered urban areas.",
        });
        return;
      }
      const { boundsAroundPoint, fluxStatsUnderMask } = await import(
        "@/services/solar/geotiff-decode"
      );
      let raster =
        fluxMonth > 0 && layers.monthlyFluxUrl
          ? await decodeGoogleSolarBand({
              url: layers.monthlyFluxUrl,
              apiKey: key,
              bandIndex: fluxMonth - 1,
            })
          : await decodeGoogleSolarGeoTiff({ url: fluxUrl, apiKey: key });
      if (!raster.bounds) {
        raster = {
          ...raster,
          bounds: boundsAroundPoint(longitude, latitude, radiusMeters),
        };
      }

      // Decode MASK for roof-only statistics; do not apply it to the displayed image.
      let maskRaster: Awaited<ReturnType<typeof decodeGoogleSolarGeoTiff>> | null = null;
      if (layers.maskUrl) {
        try {
          maskRaster = await decodeGoogleSolarGeoTiff({ url: layers.maskUrl, apiKey: key });
        } catch {
          maskRaster = null;
        }
      }
      const stats = fluxStatsUnderMask(raster, maskRaster);

      setRoofMaskRaster(maskRaster);
      setFluxRaster(raster);
      setShowFlux(true);
      setFluxSummary({
        min: stats.min,
        max: stats.max,
        mean: stats.mean,
        width: raster.width,
        height: raster.height,
        method: stats.roofMasked
          ? `${raster.method} · stats over roof MASK (${stats.sampleCount.toLocaleString()} px)`
          : `${raster.method} · stats over full raster (no MASK)`,
        imageryDate: layers.imageryDate,
        roofMasked: stats.roofMasked,
      });
      notify({
        tone: "success",
        message: `Data layers loaded (${raster.width}×${raster.height}, r=${radiusMeters} m)`,
        detail: stats.roofMasked
          ? "Flux summary uses the Google Solar roof mask."
          : raster.method,
      });
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not load Google Solar data layers",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFetching(false);
    }
  }

  async function loadMonthlyBand(month: number) {
    if (!monthlyFluxUrl || month <= 0) return;
    setFetching(true);
    try {
      const key = await revealApiKey("google_solar");
      if (!key) return;
      const { boundsAroundPoint, decodeGoogleSolarBand, fluxStatsUnderMask } = await import(
        "@/services/solar/geotiff-decode"
      );
      let raster = await decodeGoogleSolarBand({
        url: monthlyFluxUrl,
        apiKey: key,
        bandIndex: month - 1,
      });
      // Monthly bands often omit georeferencing; fall back like the annual path.
      if (!raster.bounds) {
        raster = {
          ...raster,
          bounds: boundsAroundPoint(
            insights?.centre[0] ?? site.centre[0],
            insights?.centre[1] ?? site.centre[1],
            dataLayerRadiusM,
          ),
        };
      }
      const stats = fluxStatsUnderMask(raster, roofMaskRaster);
      setFluxRaster(raster);
      setFluxSummary((prev) => ({
        min: stats.min,
        max: stats.max,
        mean: stats.mean,
        width: raster.width,
        height: raster.height,
        method: stats.roofMasked
          ? `${raster.method} · stats over roof MASK`
          : raster.method,
        imageryDate: prev?.imageryDate,
        roofMasked: stats.roofMasked,
      }));
      setShowFlux(true);
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not load monthly flux",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFetching(false);
    }
  }

  async function queryGoogleSolar() {
    setFetching(true);
    try {
      const key = await revealApiKey("google_solar");
      if (!key) {
        notify({
          tone: "warning",
          message: "Add a Google Solar API key in Settings",
          detail: "Building insights are only available with a key.",
        });
        return;
      }
      const result = await fetchBuildingInsights({
        latitude: site.centre[1],
        longitude: site.centre[0],
        apiKey: key,
        qualityFallback: true,
      });
      setInsights(result);
      if (result.maxSunshineHoursPerYear) {
        const top = result.configurations[0];
        setResource(site.id, {
          ghiKwhM2Year: result.maxSunshineHoursPerYear,
          source: result.source,
          vintage: result.imageryDate,
          fidelity: "modelled",
          method:
            `Google Solar building insights (${result.imageryQuality ?? "unknown"}); ` +
            `${result.solarPanels.length} panel placements` +
            (top
              ? `; top config ${top.panelCount} panels / ${Math.round(top.yearlyEnergyDcKwh)} kWh/yr DC`
              : "") +
            ". Sunshine hours are a site proxy — not a GHI substitute.",
        });
      }
      renameSite(site.id, result.name || site.name);
      markDirty();
      notify({
        tone: "success",
        message: `Building insights loaded (${result.maxPanelCount} panels max)`,
        detail: result.caveats[0],
      });
      // Pull RGB + flux for the map without blocking the insights success path.
      // Pass `result` — React state has not flushed `insights` yet.
      void loadDataLayers(result);
    } catch (error) {
      notify({
        tone: "error",
        message: "Google Solar request failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFetching(false);
    }
  }

  function persistDesign(options: { asNew: boolean }) {
    const segment = insights?.roofSegments[0];
    const id = options.asNew ? newDesignId() : (site.activeDesignId ?? newDesignId());
    const fallback = `Design ${savedDesigns.filter((entry) => entry.kind === "rooftop").length + (options.asNew || !site.activeDesignId ? 1 : 0)}`;
    const name =
      designNameDraft.trim() ||
      savedDesigns.find((entry) => entry.id === id)?.name ||
      fallback;
    saveNamedDesign(site.id, {
      id,
      name,
      updatedAt: new Date().toISOString(),
      kind: "rooftop",
      parameters: {
        moduleId,
        mount: "fixed_tilt",
        tiltDegrees: segment?.pitchDegrees ?? 20,
        azimuthDegrees: segment?.azimuthDegrees ?? 180,
        groundCoverageRatio: packing?.coverage ?? 0.5,
        balanceOfSystemFraction: 0.05,
        systemLosses: 0.1,
      },
      capacityKwDc: capacityKw,
      annualKwh: annualKwh ?? undefined,
      googlePanelCount: panelCount,
      inactivePanelIndices: [...inactivePanels],
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
      return;
    }
    const selected = savedDesigns.find((entry) => entry.id === designId);
    if (!selected) return;
    selectDesign(site.id, designId);
    setDesignNameDraft(selected.name);
    setModuleId(selected.parameters.moduleId);
    if (selected.googlePanelCount) setPanelCount(selected.googlePanelCount);
    setInactivePanels(new Set(selected.inactivePanelIndices ?? []));
  }

  async function buildHtmlExport(): Promise<string> {
    const capacityScaled = scalePower(capacityKw);
    const energyScaled = annualKwh ? scaleEnergy(annualKwh) : null;
    const images = [];
    if (rgbOverlay?.dataUrl) {
      images.push({
        title: "RGB imagery",
        src: rgbOverlay.dataUrl,
        caption: "Google Solar RGB layer.",
      });
      if (insights) {
        try {
          const composite = await composeRgbPanelsDataUrl({
            rgbDataUrl: rgbOverlay.dataUrl,
            bounds: rgbOverlay.bounds,
            insights,
            panelCount,
            inactive: inactivePanels,
          });
          if (composite) {
            const energies = insights.solarPanels
              .slice(0, panelCount)
              .filter((_, index) => !inactivePanels.has(index))
              .map((panel) => panel.yearlyEnergyDcKwh);
            const eMin = energies.length ? Math.min(...energies) : 0;
            const eMax = energies.length ? Math.max(...energies) : 1;
            images.push({
              title: "RGB with panel layout",
              src: composite,
              caption:
                "Google Solar RGB with active panels coloured by yearly DC energy. Inactive panels are omitted.",
            });
            images.push({
              title: "Panel energy legend",
              src: panelEnergyLegendDataUrl(eMin, eMax),
              caption: "Cool (low yearly DC kWh) → warm (high yearly DC kWh).",
            });
          }
        } catch {
          // Composite is best-effort; RGB alone still ships.
        }
      }
    }
    if (fluxRaster && fluxMonth === 0) {
      try {
        const fluxSrc = imageDataToDataUrl(rasterToImageData(fluxRaster));
        const min = fluxSummary?.min ?? 0;
        const max = fluxSummary?.max ?? 0;
        const mean = fluxSummary?.mean;
        const roofNote = fluxSummary?.roofMasked
          ? " Range/mean over the roof MASK (image shown unmasked)."
          : "";
        images.push({
          title: "Annual flux",
          src: fluxSrc,
          caption:
            mean != null
              ? `Google Solar annual flux. Range ${Math.round(min)}–${Math.round(max)} kWh/m²/yr (mean ${Math.round(mean)}).${roofNote}`
              : "Google Solar annual flux overlay.",
        });
        images.push({
          title: "Flux legend",
          src: fluxLegendDataUrl(min, max),
          caption: "Low (purple) → high (cream), kWh/m²/year.",
        });
      } catch {
        // Decoding can fail in non-browser export paths; skip rather than break HTML.
      }
    }
    return exportDesignHtml({
      title: "Rooftop design summary",
      siteName: site.name,
      meta: defaultMeta(projectName),
      sections: [
        {
          title: "System summary",
          rows: [
            { label: "DC capacity", value: `${capacityScaled.value} ${capacityScaled.unit}` },
            {
              label: "Annual output",
              value: energyScaled ? `${energyScaled.value} ${energyScaled.unit}` : "—",
            },
            {
              label: "Active panels",
              value: insights ? String(activePanelRows.length) : String(packing?.moduleCount ?? "—"),
            },
            {
              label: "Inactive panels",
              value: String(inactivePanels.size),
            },
            { label: "Module", value: module.name },
          ],
        },
        {
          title: "Parameters",
          rows: [
            { label: "Orientation", value: orientation },
            { label: "Perimeter setback", value: `${setbackM.toFixed(2)} m` },
            { label: "Google panel count", value: insights ? String(panelCount) : "—" },
            {
              label: "Selected config",
              value: bestConfig
                ? `${bestConfig.panelCount} panels · ${Math.round(bestConfig.yearlyEnergyDcKwh)} kWh/year`
                : "—",
            },
          ],
        },
        {
          title: "Results",
          rows: [
            {
              label: "Specific yield",
              value:
                annualKwh && capacityKw > 0
                  ? `${formatNumber(annualKwh / capacityKw, 0)} kWh/kWp`
                  : "—",
            },
            {
              label: "Method",
              value: insights
                ? "Google Solar building insights · active panels only"
                : "Local rooftop packing",
            },
          ],
        },
      ],
      images,
      notes: [
        "Inactive panels are excluded from capacity and annual output.",
        "Print this page to PDF from the browser or system print dialog.",
      ],
    });
  }

  async function runExport(format: DesignExportFormat) {
    if (!insights) {
      notify({ tone: "warning", message: "Load Google Solar insights before exporting panels." });
      return;
    }
    const base = `${site.name}-rooftop`;
    if (format === "html") {
      const path = await writeExport(`${base}-summary`, "html", await buildHtmlExport());
      if (path) notify({ tone: "success", message: `Exported HTML to ${path}` });
      return;
    }
    const { panelRectangle } = await import("./RooftopPanelMap");
    const geojson = JSON.stringify(
      {
        type: "FeatureCollection",
        features: activePanelRows.map((row) => {
          const panel = insights.solarPanels[row.panel - 1]!;
          return {
            type: "Feature",
            properties: row,
            geometry: {
              type: "Polygon",
              coordinates: [panelRectangle(panel, insights.panelHeightM, insights.panelWidthM)],
            },
          };
        }),
      },
      null,
      2,
    );
    const csv = toCsv(allPanelsExport(insights, panelCount, inactivePanels), [
      "panel",
      "segment",
      "lat",
      "lon",
      "energy",
      "pitch",
      "azimuth",
      "orientation",
      "active",
    ]);
    const json = JSON.stringify(
      {
        site: site.name,
        meta: defaultMeta(projectName),
        panelCount,
        activePanels: activePanelRows.length,
        inactivePanels: inactivePanels.size,
        capacityKwDc: capacityKw,
        annualEnergyDcKwh: annualKwh,
        googleReferencePanelWatts: insights.panelCapacityWatts,
        selectedConfig: bestConfig,
        parameters: { moduleId, orientation, setbackM },
      },
      null,
      2,
    );
    if (format === "geojson") {
      const path = await writeExport(`${site.name}-panels`, "geojson", geojson);
      if (path) notify({ tone: "success", message: `Exported GeoJSON to ${path}` });
      return;
    }
    if (format === "csv") {
      const path = await writeExport(`${site.name}-panels`, "csv", csv);
      if (path) notify({ tone: "success", message: `Exported CSV to ${path}` });
      return;
    }
    if (format === "json") {
      const path = await writeExport(base, "json", json);
      if (path) notify({ tone: "success", message: `Exported JSON to ${path}` });
      return;
    }
    const zip = buildZip([
      { name: `${base}.json`, data: json },
      { name: `${site.name}-panels.csv`, data: csv },
      { name: `${site.name}-panels.geojson`, data: geojson },
      { name: `${base}-summary.html`, data: await buildHtmlExport() },
    ]);
    const path = await writeExport(base, "zip", zip);
    if (path) notify({ tone: "success", message: `Exported ZIP to ${path}` });
  }

  const cashflow =
    annualKwh && capacityKw > 0 && capacityKw <= 500
      ? computeOwnerCashFlow({
          capacityKwDc: capacityKw,
          annualKwh,
          costs: { ...COST_DEFAULTS.commercial, currency },
          tariffPerKwh: 0.18,
          selfConsumptionFraction: 0.7,
          exportPricePerKwh: 0.05,
        })
      : null;

  if (!localRoof && !insights) {
    return (
      <div className="content-view">
        <div className="content-view__inner">
          <EmptyState
            icon={<PolygonIcon size={28} />}
            title="Rooftop design needs a roof outline or building insights"
            body={
              hasGoogleKey
                ? "Query Google Solar for this location, or draw the roof outline on the map."
                : "Draw the roof outline on the map, or add a Google Solar key to pull building geometry."
            }
            action={
              hasGoogleKey ? (
                <Button variant="primary" disabled={fetching} onClick={queryGoogleSolar}>
                  {fetching ? "Querying…" : "Query Google Solar"}
                </Button>
              ) : undefined
            }
          />
        </div>
      </div>
    );
  }

  const capacity = scalePower(capacityKw);

  return (
    <>
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
          <span className="projects__meta"> · rooftop</span>
        </div>
        <div className="subbar__spacer" />
        <StatCluster>
          <Stat label="Capacity" value={capacity.value} unit={capacity.unit} tone="accent" />
          {annualKwh && (
            <Stat
              label="Annual output"
              value={scaleEnergy(annualKwh).value}
              unit={scaleEnergy(annualKwh).unit}
              tone="solar"
            />
          )}
          {packing && <Stat label="Modules" value={String(packing.moduleCount)} />}
        </StatCluster>
      </div>

      <div className="workspace">
        <SidePanel
          side="left"
          title="Rooftop parameters"
          collapsed={leftCollapsed}
          onToggle={toggleLeft}
        >
          {leftCollapsed ? (
            <div className="design-rail-placeholder" title="Rooftop parameters">
              <PanelIcon size={16} />
            </div>
          ) : (
            <>
              <p className="design__lede">
                Automation proposes a panel layout. Change orientation and setbacks; the count
                updates live. Google Solar configurations, when available, are shown for comparison
                — not as a single opaque answer.
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
                <Input
                  value={designNameDraft}
                  onChange={(event) => setDesignNameDraft(event.target.value)}
                  placeholder="e.g. South roof high yield"
                />
              </Field>

              {hasGoogleKey && (
                <div className="design-button-stack">
                  <Button block disabled={fetching} onClick={queryGoogleSolar}>
                    {fetching
                      ? "Querying Google Solar…"
                      : insights
                        ? "Refresh building insights"
                        : "Query Google Solar"}
                  </Button>
                  <Button block disabled={fetching} onClick={() => void loadDataLayers()}>
                    {fluxSummary || rgbOverlay
                      ? "Refresh RGB + flux layers"
                      : "Load RGB + flux layers"}
                  </Button>
                </div>
              )}

              <Field
                label="Module"
                hint={
                  insights
                    ? "Summary DC uses Google’s reference panel watts when a Google layout is active."
                    : undefined
                }
              >
                <Select
                  value={moduleId}
                  onChange={(event) => setModuleId(event.target.value)}
                  options={MODULE_LIBRARY.filter((entry) => entry.ratedPowerW <= 500).map(
                    (entry) => ({
                      value: entry.id,
                      label: `${entry.name} · ${(entry.efficiency * 100).toFixed(1)}%`,
                    }),
                  )}
                />
              </Field>

              <Field
                label="Module orientation"
                hint={insights ? "Local packing only — ignored while the Google panel map is shown." : undefined}
              >
                <Select
                  value={orientation}
                  onChange={(event) => setOrientation(event.target.value as ModuleOrientation)}
                  options={[
                    { value: "portrait", label: "Portrait" },
                    { value: "landscape", label: "Landscape" },
                  ]}
                  disabled={Boolean(insights?.solarPanels.length)}
                />
              </Field>

              <Field
                label="Perimeter setback"
                hint={insights ? "Local packing only — ignored while the Google panel map is shown." : undefined}
              >
                <Stepper
                  value={setbackM}
                  onChange={setSetbackM}
                  step={0.05}
                  min={0.2}
                  max={1.5}
                  precision={2}
                  unit="m"
                  label="Perimeter setback"
                />
              </Field>

              {insights && insights.solarPanels.length > 0 && (
                <Field
                  label="Panel count (Google Solar)"
                  hint="Shows the first N panels from Google's preferred order. Match a configuration ladder entry when possible."
                >
                  <Stepper
                    value={panelCount}
                    onChange={setPanelCount}
                    step={1}
                    min={1}
                    max={Math.max(insights.solarPanels.length, insights.maxPanelCount, 1)}
                    unit="panels"
                    label="Google Solar panel count"
                  />
                  <EnvelopeSlider
                    value={panelCount}
                    onChange={setPanelCount}
                    min={1}
                    max={Math.max(insights.solarPanels.length, insights.maxPanelCount, 1)}
                    recommendedMin={1}
                    recommendedMax={Math.max(insights.solarPanels.length, insights.maxPanelCount, 1)}
                    step={1}
                    unit="panels"
                    label="Google Solar panel count"
                  />
                </Field>
              )}

              {search && !insights?.solarPanels.length && (
                <Callout tone="note">
                  Best searched layout: {search.best.moduleCount} modules ({search.best.orientation},{" "}
                  {search.best.gridRotationDegrees.toFixed(0)}° grid).
                </Callout>
              )}

              <div className="design-button-stack">
                <Button
                  block
                  variant="primary"
                  icon={<PanelIcon size={13} />}
                  onClick={() => persistDesign({ asNew: false })}
                >
                  Save design
                </Button>
                <Button block onClick={() => persistDesign({ asNew: true })}>
                  Save as new design
                </Button>
              </div>
            </>
          )}
        </SidePanel>

        <main className="canvas-host">
          <div className="canvas-toolbar design-canvas-toolbar">
            <span className="canvas-toolbar__label">
              {insights?.solarPanels.length
                ? "Google Solar panel map"
                : "Rooftop packing"}
            </span>
            <div className="design-canvas-toolbar__actions">
              <DesignExportMenu onExport={runExport} />
            </div>
          </div>
          {insights && insights.solarPanels.length > 0 && (
            <div className="rooftop-map-controls">
              <div className="rooftop-map-controls__panel-group">
                <label className="rooftop-map-controls__toggle">
                  <span>Panels</span>
                  <Switch checked={showPanels} label="Panels" onChange={setShowPanels} />
                </label>
                <div className="rooftop-map-controls__activate" role="group" aria-label="Panel activation">
                  <Button size="sm" variant="ghost" onClick={() => setInactivePanels(new Set())}>
                    Activate all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setInactivePanels(
                        new Set(Array.from({ length: panelCount }, (_, index) => index)),
                      )
                    }
                  >
                    Deactivate all
                  </Button>
                </div>
              </div>
              <label className="rooftop-map-controls__toggle">
                <span>RGB</span>
                <Switch
                  checked={showRgb}
                  label="RGB"
                  onChange={(on) => {
                    setShowRgb(on);
                    if (on && !rgbOverlay) void loadDataLayers();
                  }}
                />
              </label>
              <label
                className={[
                  "rooftop-map-controls__slider",
                  !(showRgb && rgbOverlay) && "rooftop-map-controls__slider--disabled",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="label">RGB opacity</span>
                <input
                  className="rooftop-map-controls__range"
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={rgbOpacity}
                  disabled={!showRgb || !rgbOverlay}
                  aria-label="RGB overlay opacity"
                  onChange={(event) => setRgbOpacity(Number(event.target.value))}
                />
              </label>
              <label className="rooftop-map-controls__toggle">
                <span>Flux</span>
                <Switch
                  checked={showFlux && Boolean(fluxRaster)}
                  label="Flux"
                  disabled={!fluxRaster}
                  onChange={setShowFlux}
                />
              </label>
              <label
                className={[
                  "rooftop-map-controls__slider",
                  !(showFlux && fluxRaster) && "rooftop-map-controls__slider--disabled",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="label">Flux opacity</span>
                <input
                  className="rooftop-map-controls__range"
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={fluxOpacity}
                  disabled={!showFlux || !fluxRaster}
                  aria-label="Flux overlay opacity"
                  onChange={(event) => setFluxOpacity(Number(event.target.value))}
                />
              </label>
              {monthlyFluxUrl && (
                <label className="rooftop-map-controls__select">
                  <span className="label">Flux period</span>
                  <Select
                    value={String(fluxMonth)}
                    onChange={(event) => {
                      const month = Number(event.target.value);
                      setFluxMonth(month);
                      if (month > 0) void loadMonthlyBand(month);
                      else void loadDataLayers();
                    }}
                    options={[
                      { value: "0", label: "Annual" },
                      ...[
                        "January",
                        "February",
                        "March",
                        "April",
                        "May",
                        "June",
                        "July",
                        "August",
                        "September",
                        "October",
                        "November",
                        "December",
                      ].map((label, index) => ({
                        value: String(index + 1),
                        label,
                      })),
                    ]}
                  />
                </label>
              )}
            </div>
          )}
          <div className="design-canvas design-canvas--map">
            {insights && insights.solarPanels.length > 0 ? (
              <RooftopPanelMap
                insights={insights}
                panelCount={panelCount}
                inactivePanels={inactivePanels}
                showPanels={showPanels}
                onTogglePanel={(index) => {
                  setInactivePanels((prev) => {
                    const next = new Set(prev);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    return next;
                  });
                }}
                overlays={{
                  rgbDataUrl: showRgb ? rgbOverlay?.dataUrl : undefined,
                  rgbBounds: showRgb ? rgbOverlay?.bounds : undefined,
                  fluxRaster,
                }}
                rgbOpacity={rgbOpacity}
                showFlux={showFlux}
                fluxOpacity={fluxOpacity}
              />
            ) : packing ? (
              <ParamList
                rows={[
                  {
                    key: "modules",
                    label: "Modules placed",
                    value: String(packing.moduleCount),
                    tone: "accent",
                  },
                  {
                    key: "coverage",
                    label: "Roof coverage",
                    value: formatPercent(packing.coverage),
                  },
                  {
                    key: "usable",
                    label: "Usable area",
                    value: `${formatNumber(packing.usableAreaM2, 1)} m²`,
                  },
                  {
                    key: "method",
                    label: "Method",
                    value: packing.method,
                  },
                ]}
              />
            ) : (
              <Callout tone="note">
                Draw a roof outline to run local packing, or query Google Solar for panel placements.
              </Callout>
            )}
            {packing?.notes.map((note) => (
              <Callout key={note} tone="warning">
                {note}
              </Callout>
            ))}
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
          {fluxSummary && (
            <>
              <SectionLabel>Annual flux GeoTIFF</SectionLabel>
              <ParamList
                rows={[
                  {
                    key: "mean",
                    label: "Mean flux",
                    value: formatNumber(fluxSummary.mean, 0),
                    tone: "solar",
                  },
                  {
                    key: "range",
                    label: fluxSummary.roofMasked ? "Range (roof)" : "Range",
                    value: `${formatNumber(fluxSummary.min, 0)}–${formatNumber(fluxSummary.max, 0)}`,
                  },
                  {
                    key: "size",
                    label: "Raster",
                    value: `${fluxSummary.width}×${fluxSummary.height}`,
                  },
                ]}
              />
              <ProvenanceBadge
                fidelity="modelled"
                source="Google Solar annual flux"
                vintage={fluxSummary.imageryDate}
                method={fluxSummary.method}
              />
            </>
          )}

          {insights && (
            <>
              <SectionLabel>Google Solar</SectionLabel>
              <ParamList
                rows={[
                  {
                    key: "maxPanels",
                    label: "Max panels",
                    value: String(insights.maxPanelCount),
                  },
                  {
                    key: "maxArea",
                    label: "Whole roof area",
                    value: insights.wholeRoofAreaM2
                      ? `${formatNumber(insights.wholeRoofAreaM2, 0)} m²`
                      : "—",
                  },
                  {
                    key: "sunshine",
                    label: "Sunshine hours",
                    value: insights.maxSunshineHoursPerYear
                      ? formatNumber(insights.maxSunshineHoursPerYear, 0)
                      : "—",
                  },
                  {
                    key: "segments",
                    label: "Roof segments",
                    value: String(insights.roofSegments.length),
                  },
                ]}
              />
              <ProvenanceBadge
                fidelity="modelled"
                source={insights.source}
                vintage={insights.imageryDate}
                method={`imagery ${insights.imageryQuality ?? "unknown"}; ${insights.solarPanels.length} panel placements`}
              />
              {bestConfig && (
                <p className="design__rationale">
                  Selected config ≈ {bestConfig.panelCount} panels · Google ref{" "}
                  {formatNumber(bestConfig.yearlyEnergyDcKwh, 0)} kWh/yr DC. Active panels:{" "}
                  {activePanelRows.length}
                  {inactivePanels.size > 0 ? ` (${inactivePanels.size} inactive)` : ""} · scaled to{" "}
                  {module.name} ({module.ratedPowerW} W) ≈{" "}
                  {formatNumber(activeEnergyKwh * moduleScale, 0)} kWh/yr DC (Google ref was{" "}
                  {insights.panelCapacityWatts} W). Capacity and annual output use active panels
                  only.
                </p>
              )}
              {inactivePanels.size > 0 && (
                <Callout tone="note">
                  {inactivePanels.size} panel{inactivePanels.size === 1 ? "" : "s"} marked inactive.
                  GeoJSON exports active panels only; CSV includes an active column. Totals above
                  exclude inactive energy.
                </Callout>
              )}
              {insights.configurations.length > 0 && (
                <Field label="Configuration ladder">
                  <Select
                    className="rooftop-config-select"
                    value={String(bestConfig?.panelCount ?? "")}
                    onChange={(event) => setPanelCount(Number(event.target.value))}
                    options={insights.configurations.map((config) => ({
                      value: String(config.panelCount),
                      label: `${config.panelCount} panels · ${formatNumber(config.yearlyEnergyDcKwh, 0)} kWh/yr DC`,
                    }))}
                  />
                </Field>
              )}
              {insights.caveats.slice(0, 2).map((caveat) => (
                <Callout key={caveat} tone="note">
                  {caveat}
                </Callout>
              ))}
            </>
          )}

          {cashflow && annualKwh && (
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
                  },
                ]}
              />
            </>
          )}

          {!insights && !packing && (
            <Callout tone="note">
              Query Google Solar or draw a roof outline to see panel counts and payback.
            </Callout>
          )}
        </SidePanel>
      </div>
    </>
  );
}

/** Compact colour bar for HTML export — matches the map flux ramp. */
function fluxLegendDataUrl(min: number, max: number): string {
  const lo = Math.round(min);
  const hi = Math.round(max);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="48" viewBox="0 0 360 48">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="rgb(59,47,107)"/>
      <stop offset="55%" stop-color="rgb(217,164,65)"/>
      <stop offset="100%" stop-color="rgb(255,240,194)"/>
    </linearGradient>
  </defs>
  <rect x="12" y="10" width="336" height="14" rx="3" fill="url(#g)"/>
  <text x="12" y="40" font-family="system-ui,sans-serif" font-size="11" fill="#1b1710">${lo}</text>
  <text x="348" y="40" font-family="system-ui,sans-serif" font-size="11" fill="#1b1710" text-anchor="end">${hi}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Cool→warm ramp matching `energyColour` in RooftopPanelMap. */
function panelEnergyLegendDataUrl(min: number, max: number): string {
  const lo = Math.round(min);
  const hi = Math.round(max);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="48" viewBox="0 0 360 48">
  <defs>
    <linearGradient id="p" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="rgb(40,90,160)"/>
      <stop offset="100%" stop-color="rgb(240,190,40)"/>
    </linearGradient>
  </defs>
  <rect x="12" y="10" width="336" height="14" rx="3" fill="url(#p)"/>
  <text x="12" y="40" font-family="system-ui,sans-serif" font-size="11" fill="#1b1710">${lo} kWh/yr</text>
  <text x="348" y="40" font-family="system-ui,sans-serif" font-size="11" fill="#1b1710" text-anchor="end">${hi} kWh/yr</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
