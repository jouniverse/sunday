/**
 * Rooftop / BIPV design panel.
 *
 * Uses Google Solar building insights when a key is present, otherwise packs a
 * drawn roof outline with the same reviewable auto-layout engine. Automation
 * proposes a module count; the designer can change orientation and setbacks.
 */

import { useMemo, useState } from "react";
import { useProjectStore } from "@/core/store/projectStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { Site } from "@/core/store/siteStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Field, Select, Stepper } from "@/design-system/controls";
import {
  Callout,
  EmptyState,
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
import { fetchBuildingInsights } from "@/services/solar/google-solar";
import type { BuildingInsights } from "@/services/solar/types";
import { SidePanel } from "@/shell/SidePanel";

export function RooftopDesignView({ site }: { site: Site }) {
  const setDesign = useSiteStore((state) => state.setDesign);
  const setResource = useSiteStore((state) => state.setResource);
  const renameSite = useSiteStore((state) => state.renameSite);
  const markDirty = useProjectStore((state) => state.markDirty);
  const notify = useUiStore((state) => state.notify);
  const leftCollapsed = useUiStore((state) => state.leftPanelCollapsed);
  const toggleLeft = useUiStore((state) => state.toggleLeftPanel);
  const revealApiKey = useSettingsStore((state) => state.useKey);
  const currency = useSettingsStore((state) => state.preferences.currency);
  const hasGoogleKey = useSettingsStore((state) => state.configuredKeys.includes("google_solar"));

  const [moduleId, setModuleId] = useState(site.design?.moduleId ?? "mono-450");
  const [orientation, setOrientation] = useState<ModuleOrientation>("portrait");
  const [setbackM, setSetbackM] = useState<number>(ROOFTOP_DEFAULTS.perimeterSetbackM);
  const [insights, setInsights] = useState<BuildingInsights | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fluxSummary, setFluxSummary] = useState<{
    min: number;
    max: number;
    mean: number;
    width: number;
    height: number;
    method: string;
    imageryDate?: string;
  } | null>(null);

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

  const bestConfig = insights?.configurations[0];
  const capacityKw =
    packing?.capacityKwDc ??
    (bestConfig && insights ? (bestConfig.panelCount * insights.panelCapacityWatts) / 1000 : 0);
  const annualKwh =
    bestConfig?.yearlyEnergyDcKwh ??
    (site.resource?.ghiKwhM2Year && capacityKw
      ? site.resource.ghiKwhM2Year * capacityKw * 0.75
      : null);

  async function loadAnnualFlux() {
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
      const { fetchDataLayerUrls } = await import("@/services/solar/google-solar");
      const { decodeGoogleSolarGeoTiff } = await import("@/services/solar/geotiff-decode");
      const layers = await fetchDataLayerUrls({
        latitude: site.centre[1],
        longitude: site.centre[0],
        radiusMeters: 50,
        apiKey: key,
        view: "IMAGERY_AND_ANNUAL_FLUX_LAYERS",
        requiredQuality: "BASE",
      });
      if (!layers.annualFluxUrl) {
        notify({
          tone: "warning",
          message: "No annual flux layer at this location",
          detail: "Google Solar data layers are limited to covered urban areas.",
        });
        return;
      }
      const raster = await decodeGoogleSolarGeoTiff({
        url: layers.annualFluxUrl,
        apiKey: key,
      });
      let sum = 0;
      let count = 0;
      for (let i = 0; i < raster.values.length; i += 1) {
        const value = raster.values[i] as number;
        if (!Number.isFinite(value)) continue;
        if (raster.nodata !== null && value === raster.nodata) continue;
        sum += value;
        count += 1;
      }
      setFluxSummary({
        min: raster.min,
        max: raster.max,
        mean: count > 0 ? sum / count : 0,
        width: raster.width,
        height: raster.height,
        method: raster.method,
        imageryDate: layers.imageryDate,
      });
      notify({
        tone: "success",
        message: `Annual flux layer decoded (${raster.width}×${raster.height})`,
        detail: raster.method,
      });
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not decode the flux GeoTIFF",
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
        requiredQuality: "BASE",
      });
      setInsights(result);
      if (result.maxSunshineHoursPerYear) {
        setResource(site.id, {
          ghiKwhM2Year: result.maxSunshineHoursPerYear,
          source: result.source,
          vintage: result.imageryDate,
          fidelity: "modelled",
          method:
            `Building insights (${result.imageryQuality ?? "BASE"}); max sunshine hours used as a ` +
            "site-level irradiance proxy — not a substitute for a resource report.",
        });
      }
      renameSite(site.id, result.name || site.name);
      markDirty();
      notify({
        tone: "success",
        message: `Building insights loaded (${result.maxPanelCount} panels max)`,
        detail: result.caveats[0],
      });
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

  function saveDesign() {
    const segment = insights?.roofSegments[0];
    setDesign(site.id, {
      moduleId,
      mount: "fixed_tilt",
      tiltDegrees: segment?.pitchDegrees ?? 20,
      azimuthDegrees: segment?.azimuthDegrees ?? 180,
      groundCoverageRatio: packing?.coverage ?? 0.5,
      balanceOfSystemFraction: 0.05,
      systemLosses: 0.1,
    });
    markDirty();
    notify({ tone: "success", message: `Rooftop design saved to ${site.name}` });
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
        <div className="breadcrumb">
          <span>Design</span>
          <span className="breadcrumb__sep">/</span>
          <span className="breadcrumb__current">{site.name} · rooftop</span>
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
          <p className="design__lede">
            Automation proposes a panel layout. Change orientation and setbacks; the count updates
            live. Google Solar configurations, when available, are shown for comparison — not as a
            single opaque answer.
          </p>

          {hasGoogleKey && (
            <>
              <Button block disabled={fetching} onClick={queryGoogleSolar}>
                {fetching
                  ? "Querying Google Solar…"
                  : insights
                    ? "Refresh building insights"
                    : "Query Google Solar"}
              </Button>
              <Button block disabled={fetching} onClick={loadAnnualFlux}>
                {fluxSummary ? "Refresh annual flux GeoTIFF" : "Load annual flux GeoTIFF"}
              </Button>
            </>
          )}

          <Field label="Module">
            <Select
              value={moduleId}
              onChange={(event) => setModuleId(event.target.value)}
              options={MODULE_LIBRARY.filter((entry) => entry.ratedPowerW <= 500).map((entry) => ({
                value: entry.id,
                label: `${entry.name} · ${(entry.efficiency * 100).toFixed(1)}%`,
              }))}
            />
          </Field>

          <Field label="Module orientation">
            <Select
              value={orientation}
              onChange={(event) => setOrientation(event.target.value as ModuleOrientation)}
              options={[
                { value: "portrait", label: "Portrait" },
                { value: "landscape", label: "Landscape" },
              ]}
            />
          </Field>

          <Field label="Perimeter setback">
            <Stepper
              value={setbackM}
              onChange={setSetbackM}
              step={0.05}
              min={0.2}
              max={1.5}
              unit="m"
              label="Perimeter setback"
            />
          </Field>

          {search && (
            <Callout tone="note">
              Best searched layout: {search.best.moduleCount} modules ({search.best.orientation},{" "}
              {search.best.gridRotationDegrees.toFixed(0)}° grid).
            </Callout>
          )}

          <Button block variant="primary" icon={<PanelIcon size={13} />} onClick={saveDesign}>
            Save rooftop design
          </Button>
        </SidePanel>

        <main className="canvas-host">
          <div className="canvas-toolbar">
            <span className="canvas-toolbar__label">Rooftop packing</span>
          </div>
          <div className="design-canvas">
            {packing ? (
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
                Draw a roof outline to run local packing, or rely on Google Solar configurations.
              </Callout>
            )}
            {packing?.notes.map((note) => (
              <Callout key={note} tone="warning">
                {note}
              </Callout>
            ))}
          </div>
        </main>

        <SidePanel side="right" title="Results" collapsed={false} onToggle={() => undefined}>
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
                    label: "Range",
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
                method={`requiredQuality=BASE; imagery ${insights.imageryQuality ?? "unknown"}`}
              />
              {insights.caveats.map((caveat) => (
                <Callout key={caveat} tone="note">
                  {caveat}
                </Callout>
              ))}
              {insights.configurations.slice(0, 3).map((config) => (
                <Callout key={`${config.panelCount}-${config.yearlyEnergyDcKwh}`} tone="note">
                  Config: {config.panelCount} panels · {formatNumber(config.yearlyEnergyDcKwh, 0)}{" "}
                  kWh/year DC
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
