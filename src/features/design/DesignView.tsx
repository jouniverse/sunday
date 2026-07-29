/**
 * System design view.
 *
 * The envelope pattern in practice: automation proposes a feasible range and a
 * recommended band from site geometry and latitude, the designer moves inside it,
 * and every consequence updates live. Nothing is hidden and nothing is locked.
 */

import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "@/core/store/projectStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { Site } from "@/core/store/siteStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Field, Select, Stepper } from "@/design-system/controls";
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
import { CompassIcon, ExportIcon, PanelIcon, PolygonIcon } from "@/design-system/icons";
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
import { defaultMeta, exportSitesCsv, writeExport } from "@/services/export";
import { SidePanel } from "@/shell/SidePanel";
import { ArrayPreview } from "./ArrayPreview";
import { RooftopDesignView } from "./RooftopDesignView";
import "./design.css";

const MOUNTS: Array<{ value: MountType; label: string }> = [
  { value: "fixed_tilt", label: "Fixed tilt" },
  { value: "single_axis", label: "Single-axis tracker" },
  { value: "dual_axis", label: "Dual-axis tracker" },
];

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
            body="Pick a site from the map, then open Design. Area sites use the greenfield packing engine; rooftop sites use building insights and module packing."
            action={<Button onClick={() => setView("map")}>Go to the map</Button>}
          />
        </div>
      </div>
    );
  }

  if (site.kind === "rooftop") {
    return <RooftopDesignView site={site} />;
  }

  if (!site.ring || !site.geometryValid) {
    return (
      <div className="content-view">
        <div className="content-view__inner">
          <EmptyState
            icon={<PolygonIcon size={28} />}
            title="Select a site with a boundary"
            body="A greenfield design needs an area to place modules in. Draw a boundary on the map, or mark the site as a rooftop and query Google Solar."
            action={<Button onClick={() => setView("map")}>Go to the map</Button>}
          />
        </div>
      </div>
    );
  }

  return <DesignWorkspace site={site} />;
}

function DesignWorkspace({ site }: { site: Site }) {
  const setDesign = useSiteStore((state) => state.setDesign);
  const markDirty = useProjectStore((state) => state.markDirty);
  const notify = useUiStore((state) => state.notify);
  const leftCollapsed = useUiStore((state) => state.leftPanelCollapsed);
  const toggleLeft = useUiStore((state) => state.toggleLeftPanel);
  const currency = useSettingsStore((state) => state.preferences.currency);
  const projectName = useProjectStore((state) => state.name);

  const latitude = site.centre[1];
  const [moduleId, setModuleId] = useState(site.design?.moduleId ?? "topcon-620");
  const [mount, setMount] = useState<MountType>(site.design?.mount ?? "fixed_tilt");

  const module =
    moduleById(moduleId) ?? (MODULE_LIBRARY[0] as NonNullable<ReturnType<typeof moduleById>>);
  const envelope = useMemo(
    () => designEnvelope(latitude, module, mount),
    [latitude, module, mount],
  );

  const [tilt, setTilt] = useState(site.design?.tiltDegrees ?? envelope.tilt.suggested);
  const [gcr, setGcr] = useState(site.design?.groundCoverageRatio ?? envelope.gcr.suggested);
  const [azimuth, setAzimuth] = useState(
    site.design?.azimuthDegrees ?? equatorFacingAzimuth(latitude),
  );
  const [bosFraction, setBosFraction] = useState(site.design?.balanceOfSystemFraction ?? 0.1);

  // A new module or mount changes what is feasible, so re-anchor to the new
  // envelope rather than leaving the sliders somewhere now-invalid.
  useEffect(() => {
    setTilt(envelope.tilt.suggested);
    setGcr(envelope.gcr.suggested);
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
      const { sampleSiteRaster, rastersConfigured } = await import(
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
      const sample = await sampleSiteRaster(site.ring, "ghi");
      if (!sample) {
        notify({
          tone: "warning",
          message: "Raster sample returned no pixels",
          detail: "Check that the COG covers this site and that the path or URL is reachable.",
        });
        return;
      }
      setZonal({
        ghi: sample.areaWeightedMean,
        method: sample.method,
        min: sample.min,
        max: sample.max,
      });
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

  function saveDesign() {
    setDesign(site.id, {
      moduleId,
      mount,
      tiltDegrees: tilt,
      azimuthDegrees: azimuth,
      groundCoverageRatio: gcr,
      balanceOfSystemFraction: bosFraction,
      systemLosses: defaultSystemLosses(),
    });
    markDirty();
    notify({ tone: "success", message: `Design saved to ${site.name}` });
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
    <>
      <div className="subbar">
        <div className="breadcrumb">
          <span>Design</span>
          <span className="breadcrumb__sep">/</span>
          <span className="breadcrumb__current">{site.name}</span>
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
          <p className="design__lede">
            Automation computes a feasible envelope from the site and its latitude. Fine-tune inside
            it; leaving the recommended band is allowed and always labelled.
          </p>

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

          <Field label="Ground coverage ratio">
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

          <Field label="Array orientation">
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
        </SidePanel>

        <main className="canvas canvas--schematic">
          <ArrayPreview
            site={site}
            module={module}
            tiltDegrees={tilt}
            gcr={gcr}
            azimuth={azimuth}
          />

          <div className="canvas__overlay canvas__overlay--bottom-right design__summary">
            <h3 className="design__summary-title">System summary</h3>
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
                  key: "fill",
                  label: "Fill factor",
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
              <span className="label">Coverage against built practice</span>
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
            <Button block onClick={saveDesign}>
              Save design to site
            </Button>
          </div>
        </main>

        <SidePanel side="right" title="Results" collapsed={false} onToggle={() => undefined}>
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

              <Button
                block
                icon={<ExportIcon size={13} />}
                onClick={async () => {
                  const csv = exportSitesCsv([site], defaultMeta(projectName));
                  const path = await writeExport(`${site.name}-design`, "csv", csv);
                  if (path) notify({ tone: "success", message: `Exported to ${path}` });
                }}
              >
                Export design
              </Button>
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
    </>
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
