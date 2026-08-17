/**
 * CSP design workspace: power tower or parabolic trough on a drawn parcel.
 *
 * Envelope sliders propose a feasible range; SolarPILOT (PySAM) layouts the
 * tower field when available, otherwise a labelled DELSOL sketch. Trough rows
 * are Sunday-packed. Annual energy is PySAM only — never a toy MWh fallback.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineStatus } from "@/core/platform";
import { platform } from "@/core/platform";
import { satelliteSnapshot } from "@/core/map/satelliteExport";
import { useProjectLibraryStore } from "@/core/store/projectLibraryStore";
import { useProjectStore } from "@/core/store/projectStore";
import type { Site } from "@/core/store/siteStore";
import { newDesignId, useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Field, IconButton, Input, Select, Stepper } from "@/design-system/controls";
import {
  Callout,
  EnvelopeSlider,
  ParamList,
  SectionLabel,
  Stat,
  StatCluster,
} from "@/design-system/data";
import { CompassIcon, CrosshairIcon, CspIcon } from "@/design-system/icons";
import { delsolSpacingSketch } from "@/domain/csp/delsol-spacing";
import { cspDesignEnvelope, clampLandUnavailableFraction, cspPlantInputsStale, defaultTowerParameters } from "@/domain/csp/envelope";
import { heliostatsFromLocalXy } from "@/domain/csp/local-frame";
import { packTroughRows } from "@/domain/csp/trough-rows";
import type {
  CspCooling,
  CspHeliostatLayout,
  CspLayoutMethod,
  CspParameters,
  CspPlantInputs,
  CspPlantResult,
  CspTechnology,
  CspTowerParameters,
  CspTroughLayout,
  CspTroughParameters,
} from "@/domain/csp/types";
import { compassPoint, formatNumber, formatPercent, scaleArea, scaleEnergy, scaleMoney } from "@/domain/units";
import { EngineUnavailable } from "@/services/engine/client";
import { runTowerLayout, runTowerPlant, runTroughPlant } from "@/services/engine/csp-client";
import { defaultMeta, toCsv, writeExport } from "@/services/export";
import { exportDesignHtml, type DesignHtmlImage } from "@/services/export/design-html";
import { buildZip } from "@/services/export/zip";
import { SidePanel } from "@/shell/SidePanel";
import { CspMapPreview, type CspMapPreviewHandle } from "./CspMapPreview";
import { buildCspSchematicSvg } from "./csp-schematic-svg";
import { DesignExportMenu, type DesignExportFormat } from "./DesignExportMenu";
import "./design.css";

/** SAM MSPT typical Rankine efficiency — used only to size SolarPILOT q_design. */
const RANKINE_ETA = 0.412;

/** SAM Lcoefcr / ICC are USD; Sunday does not convert into the Settings currency. */
function formatLcoeUsdPerKwh(value: number): string {
  return `${value.toFixed(3)} USD/kWh`;
}

function formatCapitalUsd(amount: number): string {
  const scaled = scaleMoney(amount, "USD");
  return `${scaled.value}${scaled.unit}`;
}

const COOLING: Array<{ value: CspCooling; label: string }> = [
  { value: "wet", label: "Wet (evaporative)" },
  { value: "dry", label: "Dry (air-cooled)" },
  { value: "hybrid", label: "Hybrid" },
];

export function CspDesignView({ site }: { site: Site }) {
  const saveNamedDesign = useSiteStore((state) => state.saveNamedDesign);
  const selectDesign = useSiteStore((state) => state.selectDesign);
  const renameDesign = useSiteStore((state) => state.renameDesign);
  const renameSite = useSiteStore((state) => state.renameSite);
  const markDirty = useProjectStore((state) => state.markDirty);
  const notify = useUiStore((state) => state.notify);
  const startBusy = useUiStore((state) => state.startBusy);
  const endBusy = useUiStore((state) => state.endBusy);
  const leftCollapsed = useUiStore((state) => state.leftPanelCollapsed);
  const toggleLeft = useUiStore((state) => state.toggleLeftPanel);
  const rightCollapsed = useUiStore((state) => state.rightPanelCollapsed);
  const toggleRight = useUiStore((state) => state.toggleRightPanel);
  const setRightCollapsed = useUiStore((state) => state.setRightPanelCollapsed);
  const projectName = useProjectStore((state) => state.name);

  const envelope = useMemo(() => cspDesignEnvelope(site.areaM2), [site.areaM2]);
  const seed = site.cspDesign ?? defaultTowerParameters(site.areaM2);

  const [technology, setTechnology] = useState<CspTechnology>(seed.technology);
  const [ratedMwe, setRatedMwe] = useState(seed.ratedMwe);
  const [solarMultiple, setSolarMultiple] = useState(seed.solarMultiple);
  const [tesHours, setTesHours] = useState(seed.tesHours);
  const [cooling, setCooling] = useState<CspCooling>(seed.cooling);
  const [towerHeightM, setTowerHeightM] = useState(
    seed.technology === "tower" ? seed.towerHeightM : envelope.towerHeightM.suggested,
  );
  const [layoutMethod, setLayoutMethod] = useState<CspLayoutMethod>(
    seed.technology === "tower" ? seed.layoutMethod : "radial_stagger",
  );
  const [heliostatWidthM] = useState(12.2);
  const [heliostatHeightM] = useState(12.2);
  const [rowAzimuthDegrees, setRowAzimuthDegrees] = useState(
    seed.technology === "trough" ? seed.rowAzimuthDegrees : 0,
  );
  const [rowPitchM, setRowPitchM] = useState(
    seed.technology === "trough" ? seed.rowPitchM : envelope.rowPitchM.suggested,
  );
  const [apertureM] = useState(seed.technology === "trough" ? seed.apertureM : 5.77);
  const [landUnavailableFraction, setLandUnavailableFraction] = useState(
    clampLandUnavailableFraction(
      "landUnavailableFraction" in seed ? seed.landUnavailableFraction : undefined,
    ),
  );

  const [previewMode, setPreviewMode] = useState<"schematic" | "blend" | "satellite">("schematic");
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);
  const [designNameDraft, setDesignNameDraft] = useState(() => {
    const active = site.designs?.find((entry) => entry.id === site.activeDesignId);
    return active?.name ?? "";
  });
  const [siteNameDraft, setSiteNameDraft] = useState(site.name);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [pysamLayout, setPysamLayout] = useState<CspHeliostatLayout | null>(null);
  const [plant, setPlant] = useState<CspPlantResult | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [plantBusy, setPlantBusy] = useState(false);
  const mapPreviewRef = useRef<CspMapPreviewHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      platform()
        .engine.status()
        .then((status) => {
          if (!cancelled) setEngine(status);
        })
        .catch(() => {
          if (!cancelled) setEngine(null);
        });
    };
    refresh();
    window.addEventListener("sunday:engine-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("sunday:engine-changed", refresh);
    };
  }, []);

  const troughLayout = useMemo((): CspTroughLayout | null => {
    if (technology !== "trough" || !site.ring) return null;
    return packTroughRows({
      ring: site.ring,
      rowPitchM,
      apertureM,
      rowAzimuthDegrees,
      landUnavailableFraction,
    });
  }, [technology, site.ring, rowPitchM, apertureM, rowAzimuthDegrees, landUnavailableFraction]);

  const sketchLayout = useMemo((): CspHeliostatLayout | null => {
    if (technology !== "tower" || !site.ring) return null;
    return delsolSpacingSketch({
      ring: site.ring,
      towerHeightM,
      heliostatWidthM,
      heliostatHeightM,
      layoutMethod,
      landUnavailableFraction,
    });
  }, [
    technology,
    site.ring,
    towerHeightM,
    heliostatWidthM,
    heliostatHeightM,
    layoutMethod,
    landUnavailableFraction,
  ]);

  useEffect(() => {
    setPysamLayout(null);
  }, [technology, towerHeightM, layoutMethod, landUnavailableFraction, site.id]);

  useEffect(() => {
    setPlant(null);
  }, [site.id]);

  const towerLayout = pysamLayout ?? sketchLayout;
  const cspAvailable = Boolean(engine?.cspAvailable);
  const engineReady = engine?.state === "ready";

  const parameters: CspParameters = useMemo(() => {
    if (technology === "trough") {
      const trough: CspTroughParameters = {
        technology: "trough",
        ratedMwe,
        solarMultiple,
        rowAzimuthDegrees,
        rowPitchM,
        apertureM,
        tesHours,
        cooling,
        landUnavailableFraction,
      };
      return trough;
    }
    const tower: CspTowerParameters = {
      technology: "tower",
      ratedMwe,
      solarMultiple,
      towerHeightM,
      heliostatWidthM,
      heliostatHeightM,
      layoutMethod,
      tesHours,
      cooling,
      landUnavailableFraction,
    };
    return tower;
  }, [
    technology,
    ratedMwe,
    solarMultiple,
    tesHours,
    cooling,
    towerHeightM,
    layoutMethod,
    heliostatWidthM,
    heliostatHeightM,
    rowAzimuthDegrees,
    rowPitchM,
    apertureM,
    landUnavailableFraction,
  ]);

  const plantInputs: CspPlantInputs = useMemo(
    () => ({
      technology,
      ratedMwe,
      solarMultiple,
      tesHours,
      cooling,
      landUnavailableFraction,
      ...(technology === "tower"
        ? { towerHeightM, layoutMethod }
        : { rowPitchM, rowAzimuthDegrees }),
    }),
    [
      technology,
      ratedMwe,
      solarMultiple,
      tesHours,
      cooling,
      landUnavailableFraction,
      towerHeightM,
      layoutMethod,
      rowPitchM,
      rowAzimuthDegrees,
    ],
  );
  const plantStale = Boolean(plant && cspPlantInputsStale(plant.inputs, plantInputs));

  const savedDesigns = (site.designs ?? []).filter(
    (entry) => entry.kind === "csp-tower" || entry.kind === "csp-trough",
  );
  const activeDesign = savedDesigns.find((entry) => entry.id === site.activeDesignId) ?? null;

  function applyParameters(next: CspParameters) {
    setTechnology(next.technology);
    setRatedMwe(next.ratedMwe);
    setSolarMultiple(next.solarMultiple);
    setTesHours(next.tesHours);
    setCooling(next.cooling);
    setLandUnavailableFraction(clampLandUnavailableFraction(next.landUnavailableFraction));
    if (next.technology === "tower") {
      setTowerHeightM(next.towerHeightM);
      setLayoutMethod(next.layoutMethod);
    } else {
      setRowAzimuthDegrees(next.rowAzimuthDegrees);
      setRowPitchM(next.rowPitchM);
    }
  }

  function persistDesign(options: { asNew: boolean }) {
    const id = options.asNew ? newDesignId() : (site.activeDesignId ?? newDesignId());
    const fallback = `CSP ${savedDesigns.length + (options.asNew || !site.activeDesignId ? 1 : 0)}`;
    const name =
      designNameDraft.trim() ||
      savedDesigns.find((entry) => entry.id === id)?.name ||
      fallback;
    saveNamedDesign(site.id, {
      id,
      name,
      updatedAt: new Date().toISOString(),
      kind: technology === "tower" ? "csp-tower" : "csp-trough",
      cspParameters: parameters,
      capacityMwe: ratedMwe,
      annualKwh: plant?.annualEnergyKwh,
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
      applyParameters(defaultTowerParameters(site.areaM2));
      return;
    }
    const selected = savedDesigns.find((entry) => entry.id === designId);
    if (!selected?.cspParameters) return;
    selectDesign(site.id, designId);
    setDesignNameDraft(selected.name);
    applyParameters(selected.cspParameters);
  }

  async function generateLayout() {
    if (!site.ring) return;
    if (technology === "trough") {
      notify({
        tone: "info",
        message: "Trough rows update live",
        detail: "Parabolic-trough layout is Sunday row packing, not SolarPILOT.",
      });
      return;
    }
    if (!engineReady || !cspAvailable) {
      notify({
        tone: "warning",
        message: "Showing DELSOL spacing sketch",
        detail:
          "PySAM SolarPILOT is not available. This sketch is not a field layout and is not annual energy. Install nrel-pysam in the sidecar.",
      });
      return;
    }
    setLayoutBusy(true);
    startBusy("csp-layout", "Generating tower field");
    try {
      const qDesign = (ratedMwe * solarMultiple) / RANKINE_ETA;
      const result = await runTowerLayout({
        latitude: site.centre[1],
        longitude: site.centre[0],
        h_tower: towerHeightM,
        q_design: qDesign,
        helio_width: heliostatWidthM,
        helio_height: heliostatHeightM,
        layout_method: layoutMethod,
      });
      const layout = heliostatsFromLocalXy({
        positions: result.heliostat_positions,
        ring: site.ring,
        heliostatWidthM,
        heliostatHeightM,
        method: result.method,
        opticalEfficiency: result.optical_efficiency ?? undefined,
        landUnavailableFraction,
      });
      setPysamLayout(layout);
      notify({
        tone: "success",
        message: `${layout?.heliostatCount.toLocaleString() ?? 0} heliostats`,
        detail: result.method,
      });
    } catch (error) {
      const detail =
        error instanceof EngineUnavailable
          ? `${error.message} ${error.guidance}`
          : error instanceof Error
            ? error.message
            : String(error);
      notify({
        tone: "warning",
        message: "SolarPILOT layout unavailable — DELSOL sketch shown",
        detail,
      });
    } finally {
      setLayoutBusy(false);
      endBusy("csp-layout");
    }
  }

  async function estimateEnergy() {
    if (!engineReady || !cspAvailable) {
      notify({
        tone: "warning",
        message: "CSP yield needs PySAM",
        detail:
          "Install the sidecar extra (`pip install nrel-pysam`) and start the solar engine. Sunday will not invent an annual energy figure.",
      });
      return;
    }
    setPlantBusy(true);
    startBusy("csp-plant", "Estimating CSP yield");
    try {
      const body = {
        latitude: site.centre[1],
        longitude: site.centre[0],
        rated_mwe: ratedMwe,
        solar_multiple: solarMultiple,
        tes_hours: tesHours,
        cooling,
        h_tower: towerHeightM,
        helio_width: heliostatWidthM,
        helio_height: heliostatHeightM,
        row_pitch_m: rowPitchM,
        row_azimuth_degrees: rowAzimuthDegrees,
        aperture_m: apertureM,
      };
      const result = technology === "tower" ? await runTowerPlant(body) : await runTroughPlant(body);
      const available = 1 - landUnavailableFraction;
      const annual = result.annual_energy_kwh * available;
      const cf = Number.isFinite(result.capacity_factor)
        ? result.capacity_factor * available
        : Number.NaN;
      if (!Number.isFinite(annual) || annual <= 0) {
        throw new EngineUnavailable(
          "CSP plant returned no usable annual energy.",
          `${result.method} Restart the solar engine after a sidecar update, then estimate again.`,
        );
      }
      let lcoe = result.lcoe_usd_per_kwh ?? undefined;
      let lcoeMethod = result.lcoe_method ?? undefined;
      if (lcoe != null && available > 0 && available < 1) {
        lcoe = lcoe / available;
        lcoeMethod = `${lcoeMethod ?? "PySAM.Lcoefcr"}; land-unavailable=${(landUnavailableFraction * 100).toFixed(0)}% Sunday energy derate (LCOE × 1/available)`;
      }
      setPlant({
        annualEnergyKwh: annual,
        capacityFactor: cf,
        waterUseM3: result.water_use_m3 ?? undefined,
        lcoeUsdPerKwh: lcoe,
        lcoeMethod,
        totalInstalledCostUsd: result.total_installed_cost_usd ?? undefined,
        method:
          landUnavailableFraction > 0
            ? `${result.method}; land-unavailable=${(landUnavailableFraction * 100).toFixed(0)}% Sunday derate`
            : result.method,
        inputs: plantInputs,
      });
    } catch (error) {
      const detail =
        error instanceof EngineUnavailable
          ? `${error.message} ${error.guidance}`
          : error instanceof Error
            ? error.message
            : String(error);
      notify({
        tone: "error",
        message: "CSP yield unavailable",
        detail,
      });
      window.dispatchEvent(new Event("sunday:engine-changed"));
    } finally {
      setPlantBusy(false);
      endBusy("csp-plant");
    }
  }

  function designSummaryPayload() {
    return {
      siteId: site.id,
      siteName: site.name,
      designId: site.activeDesignId ?? null,
      designName: activeDesign?.name ?? (designNameDraft || null),
      family: "csp",
      parameters,
      layout:
        technology === "tower"
          ? {
              heliostatCount: towerLayout?.heliostatCount ?? 0,
              reflectiveAreaM2: towerLayout?.reflectiveAreaM2 ?? 0,
              method: towerLayout?.method ?? null,
            }
          : {
              rowCount: troughLayout?.rowCount ?? 0,
              apertureAreaM2: troughLayout?.apertureAreaM2 ?? 0,
              method: troughLayout?.method ?? null,
            },
      plant,
      note:
        "Tower field is PySAM SolarPILOT when available, otherwise a labelled DELSOL sketch. Trough rows are Sunday-packed. Annual energy is PySAM plant physics only.",
    };
  }

  function buildGeoJson(): string {
    if (technology === "tower") {
      const points = towerLayout?.positionsLngLat ?? [];
      return JSON.stringify(
        {
          type: "FeatureCollection",
          features: points.map((coordinates, index) => ({
            type: "Feature",
            properties: { index, technology: "tower", method: towerLayout?.method },
            geometry: { type: "Point", coordinates },
          })),
        },
        null,
        2,
      );
    }
    const strips = troughLayout?.stripsLngLat ?? [];
    return JSON.stringify(
      {
        type: "FeatureCollection",
        features: strips.map((ring, index) => ({
          type: "Feature",
          properties: { index, technology: "trough", method: troughLayout?.method },
          geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
        })),
      },
      null,
      2,
    );
  }

  function buildHtmlExport(): string {
    const images: DesignHtmlImage[] = [];
    const ring = site.ring;
    if (ring && ring.length >= 3) {
      const schematic = buildCspSchematicSvg({
        ring,
        technology,
        heliostatsLocal: towerLayout?.positionsLocal,
        troughStripsLngLat: troughLayout?.stripsLngLat,
        origin: troughLayout?.origin,
      });
      if (schematic) {
        images.push({
          title: "Field schematic",
          inlineSvg: schematic,
          caption:
            technology === "tower"
              ? "Plan view of heliostats inside the site boundary. The marker at the origin is the tower."
              : "Plan view of trough strips inside the site boundary.",
        });
      }
    }
    const satellite = satelliteSnapshot(site);
    if (satellite) {
      images.push({
        title: "Site satellite",
        src: satellite.url,
        caption:
          "Esri World Imagery for the site extent. Amber overlay marks the site boundary.",
        outlineNorm: satellite.outlineNorm,
      });
    }
    return exportDesignHtml({
      title: "CSP design summary",
      siteName: site.name,
      meta: defaultMeta(projectName),
      sections: [
        {
          title: "System summary",
          rows: [
            { label: "Technology", value: technology === "tower" ? "Solar power tower" : "Parabolic trough" },
            { label: "Rated power", value: `${formatNumber(ratedMwe, 1)} MWₑ` },
            {
              label: "Annual output",
              value: plant
                ? `${scaleEnergy(plant.annualEnergyKwh).value} ${scaleEnergy(plant.annualEnergyKwh).unit}`
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
            { label: "Solar multiple", value: formatNumber(solarMultiple, 2) },
            { label: "TES", value: `${formatNumber(tesHours, 1)} h` },
            { label: "Cooling", value: cooling },
            {
              label: "Land unavailable",
              value: `${formatNumber(landUnavailableFraction * 100, 0)}%`,
            },
            ...(technology === "tower"
              ? [
                  { label: "Tower height", value: `${formatNumber(towerHeightM, 0)} m` },
                  { label: "Layout", value: layoutMethod },
                ]
              : [
                  { label: "Row azimuth", value: `${formatNumber(rowAzimuthDegrees, 0)}°` },
                  { label: "Row pitch", value: `${formatNumber(rowPitchM, 1)} m` },
                ]),
          ],
        },
        {
          title: "Results",
          rows: plant
            ? [
                { label: "Capacity factor", value: formatPercent(plant.capacityFactor) },
                {
                  label: "LCOE",
                  value:
                    plant.lcoeUsdPerKwh != null
                      ? formatLcoeUsdPerKwh(plant.lcoeUsdPerKwh)
                      : "Unavailable",
                },
                {
                  label: "Capital cost",
                  value:
                    plant.totalInstalledCostUsd != null
                      ? formatCapitalUsd(plant.totalInstalledCostUsd)
                      : "Unavailable",
                },
                { label: "LCOE method", value: plant.lcoeMethod ?? "—" },
                { label: "Method", value: plant.method },
              ]
            : [{ label: "Status", value: "Run Estimate annual output first" }],
        },
      ],
      images,
      notes: [
        "Tower field geometry is PySAM SolarPILOT when installed; otherwise a labelled DELSOL sketch. Trough rows are Sunday packing. Yield is never estimated without PySAM.",
        "LCOE is PySAM.Lcoefcr with SAM default FCR and O&M (USD). Capital cost is SAM total_installed_cost (USD). Financial parameters are not Sunday-editable.",
        "Print this page to PDF from the browser or system print dialog.",
      ],
    });
  }

  function buildDesignCsv(): string {
    const summary = designSummaryPayload();
    return toCsv([
      {
        site_id: summary.siteId,
        site_name: summary.siteName,
        design_id: summary.designId ?? "",
        design_name: summary.designName ?? "",
        technology,
        rated_mwe: ratedMwe,
        solar_multiple: solarMultiple,
        tes_hours: tesHours,
        cooling,
        layout_method: technology === "tower" ? (towerLayout?.method ?? "") : (troughLayout?.method ?? ""),
        annual_kwh: plant?.annualEnergyKwh ?? "",
        capacity_factor: plant?.capacityFactor ?? "",
        lcoe_usd_per_kwh: plant?.lcoeUsdPerKwh ?? "",
        lcoe_method: plant?.lcoeMethod ?? "",
        total_installed_cost_usd: plant?.totalInstalledCostUsd ?? "",
        energy_method: plant?.method ?? "",
        note: summary.note,
      },
    ]);
  }

  async function runExport(format: DesignExportFormat) {
    const base = `${site.name}-csp`;
    if (format === "html") {
      const path = await writeExport(base, "html", buildHtmlExport());
      if (path) notify({ tone: "success", message: `Exported HTML to ${path}` });
      return;
    }
    if (format === "geojson") {
      const path = await writeExport(`${site.name}-csp-field`, "geojson", buildGeoJson());
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
      { name: `${site.name}-csp-field.geojson`, data: buildGeoJson() },
      { name: `${base}.html`, data: buildHtmlExport() },
    ]);
    const path = await writeExport(base, "zip", zip);
    if (path) notify({ tone: "success", message: `Exported ZIP to ${path}` });
  }

  const area = scaleArea(site.areaM2);
  const layoutMethodLabel = towerLayout?.method ?? troughLayout?.method ?? "—";

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
            className="design-breadcrumb__input"
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
          <Stat label="Rated" value={formatNumber(ratedMwe, 1)} unit="MWₑ" tone="accent" />
          {plant && (
            <Stat
              label="Annual output"
              value={scaleEnergy(plant.annualEnergyKwh).value}
              unit={scaleEnergy(plant.annualEnergyKwh).unit}
              tone="solar"
            />
          )}
          {plant?.lcoeUsdPerKwh != null && (
            <Stat
              label="LCOE"
              value={plant.lcoeUsdPerKwh.toFixed(3)}
              unit="USD/kWh"
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
            <div className="design-rail-placeholder" title="CSP parameters">
              <CspIcon size={16} />
            </div>
          ) : (
            <>
              <p className="design__lede">
                Automation proposes a feasible envelope from the site area. Fine-tune inside it;
                leaving the recommended band is allowed and labelled. Heliostats track — there is
                no tilt slider.
              </p>

              {!cspAvailable && (
                <Callout tone="warning">
                  PySAM is not installed in the solar engine. Tower layout falls back to a labelled
                  DELSOL sketch. Annual energy stays unavailable until you install{" "}
                  <code>nrel-pysam</code>.
                </Callout>
              )}

              <Field label="Saved designs" hint="Select a saved CSP design, or save as new to keep variants.">
                <Select
                  value={site.activeDesignId && savedDesigns.some((entry) => entry.id === site.activeDesignId)
                    ? site.activeDesignId
                    : ""}
                  onChange={(event) => loadSavedDesign(event.target.value)}
                  options={[
                    { value: "", label: "Working design (unsaved)" },
                    ...savedDesigns.map((entry) => ({
                      value: entry.id,
                      label: `${entry.name}${entry.capacityMwe ? ` · ${entry.capacityMwe.toFixed(1)} MWₑ` : ""}`,
                    })),
                  ]}
                />
              </Field>
              <Field label="Design name">
                <div className="design-name-row">
                  <Input
                    value={designNameDraft}
                    onChange={(event) => setDesignNameDraft(event.target.value)}
                    placeholder="e.g. Tower 50 MWₑ wet"
                  />
                  <IconButton
                    label="Zoom to site"
                    onClick={() => mapPreviewRef.current?.fitToSite()}
                  >
                    <CrosshairIcon size={16} />
                  </IconButton>
                </div>
              </Field>

              <Field label="Technology" hint="Linear Fresnel and dish are deferred. Both options stay available; yield still needs PySAM.">
                <Select
                  value={technology}
                  onChange={(event) => setTechnology(event.target.value as CspTechnology)}
                  options={[
                    { value: "tower", label: "Solar power tower" },
                    { value: "trough", label: "Parabolic trough" },
                  ]}
                />
              </Field>

              <Field label="Rated power">
                <Stepper
                  value={ratedMwe}
                  onChange={setRatedMwe}
                  step={1}
                  min={envelope.ratedMwe.min}
                  max={envelope.ratedMwe.max}
                  unit="MWₑ"
                  label="Rated power"
                />
                <EnvelopeSlider
                  value={ratedMwe}
                  onChange={setRatedMwe}
                  min={envelope.ratedMwe.min}
                  max={envelope.ratedMwe.max}
                  recommendedMin={envelope.ratedMwe.recommendedMin}
                  recommendedMax={envelope.ratedMwe.recommendedMax}
                  step={1}
                  unit="MWₑ"
                  label="Rated power"
                  outsideNote="Outside the land-use prior for this parcel — feasible, but expect a tight or sparse field."
                />
              </Field>

              <Field label="Solar multiple">
                <Stepper
                  value={solarMultiple}
                  onChange={setSolarMultiple}
                  step={0.1}
                  min={envelope.solarMultiple.min}
                  max={envelope.solarMultiple.max}
                  precision={1}
                  label="Solar multiple"
                />
                <EnvelopeSlider
                  value={solarMultiple}
                  onChange={setSolarMultiple}
                  min={envelope.solarMultiple.min}
                  max={envelope.solarMultiple.max}
                  recommendedMin={envelope.solarMultiple.recommendedMin}
                  recommendedMax={envelope.solarMultiple.recommendedMax}
                  step={0.1}
                  unit=""
                  precision={1}
                  label="Solar multiple"
                />
              </Field>

              <Field label="Thermal storage">
                <Stepper
                  value={tesHours}
                  onChange={setTesHours}
                  step={1}
                  min={envelope.tesHours.min}
                  max={envelope.tesHours.max}
                  unit="h"
                  label="TES hours"
                />
                <EnvelopeSlider
                  value={tesHours}
                  onChange={setTesHours}
                  min={envelope.tesHours.min}
                  max={envelope.tesHours.max}
                  recommendedMin={envelope.tesHours.recommendedMin}
                  recommendedMax={envelope.tesHours.recommendedMax}
                  step={1}
                  unit="h"
                  label="TES hours"
                />
              </Field>

              <Field
                label="Cooling"
                hint="A design choice, not a siting check. Water-proximity screening is not implemented."
              >
                <Select
                  value={cooling}
                  onChange={(event) => setCooling(event.target.value as CspCooling)}
                  options={COOLING}
                />
              </Field>

              <Field
                label="Roads, pads and margins"
                hint="Share of the site not available to the field. Insets the schematic from the fence line; annual energy is derated by the same share (labelled, not a SAM land model)."
              >
                <Stepper
                  value={landUnavailableFraction * 100}
                  onChange={(value) => setLandUnavailableFraction(value / 100)}
                  step={1}
                  min={0}
                  max={40}
                  unit="%"
                  label="Land unavailable"
                />
              </Field>

              {technology === "tower" && (
                <>
                  <Field label="Tower height">
                    <Stepper
                      value={towerHeightM}
                      onChange={setTowerHeightM}
                      step={5}
                      min={envelope.towerHeightM.min}
                      max={envelope.towerHeightM.max}
                      unit="m"
                      label="Tower height"
                    />
                    <EnvelopeSlider
                      value={towerHeightM}
                      onChange={setTowerHeightM}
                      min={envelope.towerHeightM.min}
                      max={envelope.towerHeightM.max}
                      recommendedMin={envelope.towerHeightM.recommendedMin}
                      recommendedMax={envelope.towerHeightM.recommendedMax}
                      step={5}
                      unit="m"
                      label="Tower height"
                    />
                  </Field>
                  <Field
                    label="Field layout method"
                    hint="Radial vs cornfield updates Sunday’s live DELSOL sketch only. This PySAM SolarPILOT build has no layout_method switch — Generate uses SolarPILOT’s default field, then clips it to the parcel."
                  >
                    <Select
                      value={layoutMethod}
                      onChange={(event) => setLayoutMethod(event.target.value as CspLayoutMethod)}
                      options={[
                        { value: "radial_stagger", label: "Radial stagger" },
                        { value: "cornfield", label: "Cornfield" },
                      ]}
                    />
                  </Field>
                </>
              )}

              {technology === "trough" && (
                <>
                  <Field
                    label="Tracking-axis azimuth"
                    hint="Trough rows track; 0° is north–south. This is not module tilt."
                  >
                    <div className="design__compass">
                      <CompassIcon size={28} />
                      <div>
                        <div className="design__azimuth mono">{rowAzimuthDegrees.toFixed(0)}°</div>
                        <div className="design__azimuth-label">{compassPoint(rowAzimuthDegrees)}</div>
                      </div>
                      <Stepper
                        value={rowAzimuthDegrees}
                        onChange={setRowAzimuthDegrees}
                        step={5}
                        min={0}
                        max={360}
                        unit="°"
                        label="Row azimuth"
                      />
                    </div>
                  </Field>
                  <Field label="Row pitch">
                    <Stepper
                      value={rowPitchM}
                      onChange={setRowPitchM}
                      step={0.5}
                      min={envelope.rowPitchM.min}
                      max={envelope.rowPitchM.max}
                      precision={1}
                      unit="m"
                      label="Row pitch"
                    />
                    <EnvelopeSlider
                      value={rowPitchM}
                      onChange={setRowPitchM}
                      min={envelope.rowPitchM.min}
                      max={envelope.rowPitchM.max}
                      recommendedMin={envelope.rowPitchM.recommendedMin}
                      recommendedMax={envelope.rowPitchM.recommendedMax}
                      step={0.5}
                      unit="m"
                      precision={1}
                      label="Row pitch"
                    />
                  </Field>
                </>
              )}

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
              <CspMapPreview
                ref={mapPreviewRef}
                site={site}
                technology={technology}
                heliostatsLngLat={towerLayout?.positionsLngLat ?? []}
                troughStripsLngLat={troughLayout?.stripsLngLat ?? []}
                showField={previewMode !== "satellite"}
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
                      key: "rated",
                      label: "Rated power",
                      value: `${formatNumber(ratedMwe, 1)} MWₑ`,
                      tone: "accent",
                    },
                    ...(technology === "tower"
                      ? [
                          {
                            key: "helio",
                            label: "Heliostats",
                            value: (towerLayout?.heliostatCount ?? 0).toLocaleString(),
                          },
                        ]
                      : [
                          {
                            key: "rows",
                            label: "Trough strips",
                            value: (troughLayout?.rowCount ?? 0).toLocaleString(),
                          },
                        ]),
                    { key: "layout", label: "Layout method", value: layoutMethodLabel },
                  ]}
                />

                <Button
                  block
                  disabled={layoutBusy || technology === "trough"}
                  onClick={() => void generateLayout()}
                >
                  {layoutBusy
                    ? "Generating field…"
                    : technology === "trough"
                      ? "Trough rows update live"
                      : cspAvailable
                        ? "Generate SolarPILOT layout"
                        : "Generate layout (DELSOL sketch)"}
                </Button>
                <p className="design__rationale">
                  {technology === "trough"
                    ? "Trough strips pack live as you change pitch and azimuth. Estimate annual output calls PySAM TroughPhysical on SAM’s default collector loops — it does not re-place the rows, and Sunday’s aperture slider is layout-only."
                    : "The map is Sunday’s DELSOL sketch until you generate. Generate runs PySAM SolarPILOT and replaces the sketch with that field, clipped to the parcel (and inset by roads/pads). Estimate uses SAM MSPTNone default field optics, not the schematic tower height; rated power, solar multiple, TES and cooling are applied."}
                </p>
                <Button
                  block
                  variant="primary"
                  icon={<CspIcon size={13} />}
                  disabled={plantBusy}
                  onClick={() => void estimateEnergy()}
                >
                  {plantBusy ? "Modelling…" : "Estimate annual output"}
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
          {plant ? (
            <>
              {plantStale ? (
                <Callout tone="warning">
                  Knobs have changed since this Estimate. Figures stay until you run Estimate
                  annual output again.
                </Callout>
              ) : null}
              <SectionLabel>Last estimate</SectionLabel>
              <ParamList
                rows={[
                  {
                    key: "annual",
                    label: "Annual output",
                    value: `${scaleEnergy(plant.annualEnergyKwh).value} ${scaleEnergy(plant.annualEnergyKwh).unit}`,
                    tone: "solar",
                  },
                  {
                    key: "cf",
                    label: "Capacity factor",
                    value: formatPercent(plant.capacityFactor),
                  },
                  ...(plant.waterUseM3 != null
                    ? [
                        {
                          key: "water",
                          label: "Cooling water",
                          value: `${formatNumber(plant.waterUseM3, 0)} m³/year`,
                        },
                      ]
                    : []),
                  {
                    key: "lcoe",
                    label: "LCOE",
                    value:
                      plant.lcoeUsdPerKwh != null
                        ? formatLcoeUsdPerKwh(plant.lcoeUsdPerKwh)
                        : "Unavailable",
                  },
                  {
                    key: "capex",
                    label: "Capital cost",
                    value:
                      plant.totalInstalledCostUsd != null
                        ? formatCapitalUsd(plant.totalInstalledCostUsd)
                        : "Unavailable",
                  },
                ]}
              />
              {plant.lcoeMethod ? <Callout tone="note">{plant.lcoeMethod}</Callout> : null}
              <SectionLabel>Estimated with</SectionLabel>
              <ParamList
                rows={[
                  {
                    key: "tech",
                    label: "Technology",
                    value:
                      plant.inputs.technology === "tower" ? "Solar power tower" : "Parabolic trough",
                  },
                  {
                    key: "rated",
                    label: "Rated power",
                    value: `${formatNumber(plant.inputs.ratedMwe, 1)} MWₑ`,
                  },
                  {
                    key: "sm",
                    label: "Solar multiple",
                    value: formatNumber(plant.inputs.solarMultiple, 2),
                  },
                  {
                    key: "tes",
                    label: "TES",
                    value: `${formatNumber(plant.inputs.tesHours, 1)} h`,
                  },
                  {
                    key: "cool",
                    label: "Cooling",
                    value: plant.inputs.cooling,
                  },
                  {
                    key: "land",
                    label: "Land unavailable",
                    value: `${formatNumber(plant.inputs.landUnavailableFraction * 100, 0)}%`,
                  },
                  ...(plant.inputs.technology === "tower"
                    ? [
                        {
                          key: "h",
                          label: "Tower height",
                          value: `${formatNumber(plant.inputs.towerHeightM ?? 0, 0)} m`,
                        },
                      ]
                    : [
                        {
                          key: "az",
                          label: "Row azimuth",
                          value: `${formatNumber(plant.inputs.rowAzimuthDegrees ?? 0, 0)}°`,
                        },
                        {
                          key: "pitch",
                          label: "Row pitch",
                          value: `${formatNumber(plant.inputs.rowPitchM ?? 0, 1)} m`,
                        },
                      ]),
                ]}
              />
              <Callout tone="note">{plant.method}</Callout>
            </>
          ) : (
            <Callout tone="note">
              Run Estimate annual output to call PySAM. Without it, Sunday will not show a yield.
              Tower annual energy uses SAM’s default heliostat optical table, not the map sketch.
              {towerLayout?.method === "delsol-spacing-sketch"
                ? " The map is a DELSOL spacing sketch, not a performance model."
                : ""}
            </Callout>
          )}
        </SidePanel>
      </div>
    </div>
  );
}
