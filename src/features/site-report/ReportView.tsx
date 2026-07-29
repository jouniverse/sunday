/**
 * Multi-source site report.
 *
 * The point of this view is comparison: four datasets, side by side, with their
 * resolutions and vintages visible and their disagreements stated rather than
 * averaged away. A single confident number would be easier to read and less true.
 */

import { useState } from "react";
import { useProjectStore } from "@/core/store/projectStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import { useSiteStore } from "@/core/store/siteStore";
import type { Site } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Progress } from "@/design-system/controls";
import {
  Callout,
  DataGrid,
  EmptyState,
  ParamList,
  ProvenanceBadge,
  SectionLabel,
} from "@/design-system/data";
import { ExportIcon, PinIcon, ReportIcon, SunIcon } from "@/design-system/icons";
import { generateSiteReport } from "@/services/solar/orchestrator";
import type { SiteReport } from "@/services/solar/orchestrator";
import { PROVIDERS } from "@/services/solar/types";
import type { ResourceReport, SolarProvider } from "@/services/solar/types";
import {
  defaultMeta,
  exportReportCsv,
  exportReportHtml,
  writeExport,
} from "@/services/export";
import { formatCoordinates, formatNumber } from "@/domain/units";
import { MonthlyChart } from "./MonthlyChart";
import "./report.css";

const ALL_PROVIDERS: SolarProvider[] = ["pvgis", "nasa_power", "nrel"];

export function ReportView() {
  const sites = useSiteStore((state) => state.sites);
  const selectedId = useSiteStore((state) => state.selectedSiteId);
  const setView = useUiStore((state) => state.setView);
  const site = sites.find((entry) => entry.id === selectedId) ?? null;

  if (!site) {
    return (
      <div className="content-view">
        <div className="content-view__inner">
          <EmptyState
            icon={<PinIcon size={28} />}
            title="Select a location"
            body="Mark a location or select a site on the map, then generate a report to compare every available solar resource dataset for it."
            action={<Button onClick={() => setView("map")}>Go to the map</Button>}
          />
        </div>
      </div>
    );
  }

  // Keyed on the site so switching sites clears the previous report rather than
  // leaving numbers from somewhere else on screen.
  return <SiteReportPanel key={site.id} site={site} />;
}

function SiteReportPanel({ site }: { site: Site }) {
  const notify = useUiStore((state) => state.notify);
  const projectName = useProjectStore((state) => state.name);
  const useKey = useSettingsStore((state) => state.useKey);

  const [report, setReport] = useState<SiteReport | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function generate() {
    setProgress({ done: 0, total: ALL_PROVIDERS.length });
    try {
      const result = await generateSiteReport({
        latitude: site.centre[1],
        longitude: site.centre[0],
        providers: ALL_PROVIDERS,
        getApiKey: (provider) => useKey(provider),
        capacityKwDc: 1,
        optimiseTilt: true,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setReport(result);
      for (const warning of result.warnings) {
        notify({ tone: "warning", message: warning });
      }
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not generate the report",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setProgress(null);
    }
  }

  async function exportAs(format: "csv" | "html") {
    if (!report) return;
    const meta = defaultMeta(projectName);
    const contents =
      format === "csv" ? exportReportCsv(report, meta) : exportReportHtml(report, meta, site);
    const path = await writeExport(`${site.name}-report`, format, contents);
    if (path) notify({ tone: "success", message: `Exported to ${path}` });
  }

  return (
    <div className="content-view">
      <div className="content-view__inner">
        <h1 className="content-view__title">{site.name}</h1>
        <p className="content-view__lede">
          {formatCoordinates(site.centre[1], site.centre[0])}
          {report && ` · generated ${new Date(report.generatedAt).toLocaleString()}`}
        </p>

        {!report && (
          <div className="card">
            <div className="card__head">
              <h2 className="card__title">Generate a resource report</h2>
            </div>
            <p className="report__intro">
              Sunday queries every source it can reach for this location and shows them together.
              PVGIS and NASA POWER are free and need no key. NREL needs a free key and covers the
              Americas. Google Solar is queried only from the rooftop workflow, because it is
              metered.
            </p>
            {progress ? (
              <>
                <Progress value={progress.done / progress.total} label="Querying providers" />
                <p className="report__intro">
                  Querying {progress.done} of {progress.total} sources…
                </p>
              </>
            ) : (
              <Button variant="primary" icon={<SunIcon size={13} />} onClick={generate}>
                Generate report
              </Button>
            )}
          </div>
        )}

        {report && (
          <>
            <div className="card">
              <div className="card__head">
                <h2 className="card__title">Sources</h2>
                <div className="report__actions">
                  <Button size="sm" onClick={generate}>
                    Refresh
                  </Button>
                  <Button size="sm" icon={<ExportIcon size={12} />} onClick={() => exportAs("csv")}>
                    CSV
                  </Button>
                  <Button
                    size="sm"
                    icon={<ReportIcon size={12} />}
                    onClick={() => exportAs("html")}
                  >
                    Printable
                  </Button>
                </div>
              </div>

              <DataGrid
                caption="Solar resource by source"
                columns={[
                  {
                    key: "provider",
                    header: "Source",
                    render: (row: ResourceReport) => (
                      <span title={PROVIDERS[row.provider].documentation}>
                        {PROVIDERS[row.provider].label}
                      </span>
                    ),
                  },
                  {
                    key: "resolution",
                    header: "Resolution",
                    render: (row) => PROVIDERS[row.provider].resolution,
                  },
                  {
                    key: "ghi",
                    header: "GHI",
                    numeric: true,
                    render: (row) => value(row.ghiKwhM2Year, 0),
                  },
                  {
                    key: "dni",
                    header: "DNI",
                    numeric: true,
                    render: (row) => value(row.dniKwhM2Year, 0),
                  },
                  {
                    key: "poa",
                    header: "In-plane",
                    numeric: true,
                    render: (row) => value(row.poaKwhM2Year, 0),
                  },
                  {
                    key: "yield",
                    header: "kWh/kWp",
                    numeric: true,
                    render: (row) => value(row.specificYieldKwhPerKwp, 0),
                  },
                  {
                    key: "tilt",
                    header: "Opt. tilt",
                    numeric: true,
                    render: (row) => value(row.optimalTiltDegrees, 1),
                  },
                  {
                    key: "fidelity",
                    header: "Provenance",
                    render: (row) => (
                      <ProvenanceBadge
                        fidelity={row.fidelity}
                        source={row.dataset}
                        vintage={row.vintage}
                        method={row.method}
                      />
                    ),
                  },
                ]}
                rows={report.reports}
                rowKey={(row) => row.provider}
              />
              <p className="report__units">All irradiation figures in kWh/m²/year.</p>
            </div>

            {report.comparisons.some((comparison) => comparison.significant) && (
              <div className="card">
                <div className="card__head">
                  <h2 className="card__title">Where sources disagree</h2>
                </div>
                {report.comparisons
                  .filter((comparison) => comparison.significant)
                  .map((comparison) => (
                    <Callout key={comparison.quantity} tone="warning">
                      <strong>{comparison.quantity}</strong> ranges from{" "}
                      {formatNumber(comparison.min, 0)} to {formatNumber(comparison.max, 0)}{" "}
                      {comparison.unit}, a spread of{" "}
                      {(comparison.relativeSpread * 100).toFixed(0)}%. Sunday does not average
                      these: the design workflow uses{" "}
                      {report.consensus.ghiKwhM2Year?.from.join(", ") ?? "the finest-resolution source"}{" "}
                      and records that choice.
                    </Callout>
                  ))}
              </div>
            )}

            <div className="card">
              <div className="card__head">
                <h2 className="card__title">Working values</h2>
              </div>
              <ParamList
                rows={[
                  ...(report.consensus.ghiKwhM2Year
                    ? [
                        {
                          key: "ghi",
                          label: "Global horizontal irradiation",
                          value: `${formatNumber(report.consensus.ghiKwhM2Year.value, 0)} kWh/m²/yr`,
                          tone: "solar" as const,
                          title: report.consensus.ghiKwhM2Year.note,
                        },
                      ]
                    : []),
                  ...(report.consensus.dniKwhM2Year
                    ? [
                        {
                          key: "dni",
                          label: "Direct normal irradiation",
                          value: `${formatNumber(report.consensus.dniKwhM2Year.value, 0)} kWh/m²/yr`,
                          title: report.consensus.dniKwhM2Year.note,
                        },
                      ]
                    : []),
                  ...(report.consensus.optimalTiltDegrees
                    ? [
                        {
                          key: "tilt",
                          label: "Optimal tilt",
                          value: `${formatNumber(report.consensus.optimalTiltDegrees.value, 1)}°`,
                          tone: "accent" as const,
                          title: report.consensus.optimalTiltDegrees.note,
                        },
                      ]
                    : []),
                  ...(report.consensus.specificYieldKwhPerKwp
                    ? [
                        {
                          key: "yield",
                          label: "Reference specific yield",
                          value: `${formatNumber(report.consensus.specificYieldKwhPerKwp.value, 0)} kWh/kWp/yr`,
                          title: report.consensus.specificYieldKwhPerKwp.note,
                        },
                      ]
                    : []),
                ]}
              />
              <p className="report__units">
                Chosen by dataset resolution, not by averaging. Hover a row to see why.
              </p>
            </div>

            <MonthlyChart reports={report.reports} />

            <div className="card">
              <div className="card__head">
                <h2 className="card__title">Sources that did not answer</h2>
              </div>
              {report.outcomes.filter((outcome) => outcome.status !== "ok").length === 0 ? (
                <p className="report__intro">Every requested source answered.</p>
              ) : (
                report.outcomes
                  .filter((outcome) => outcome.status !== "ok")
                  .map((outcome) => (
                    <Callout key={outcome.provider} tone={outcome.status === "failed" ? "warning" : "note"}>
                      <strong>{PROVIDERS[outcome.provider].label}</strong> — {outcome.reason}
                      {outcome.guidance && ` ${outcome.guidance}`}
                    </Callout>
                  ))
              )}
            </div>

            <SectionLabel>Methods and attribution</SectionLabel>
            {report.reports.map((entry) => (
              <p key={entry.provider} className="report__method">
                <strong>{entry.source}</strong> — {entry.method}{" "}
                {entry.caveats.join(" ")}
              </p>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function value(input: number | undefined, decimals: number): string {
  return input === undefined ? "—" : formatNumber(input, decimals);
}
