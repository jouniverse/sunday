/**
 * Export service: CSV, JSON, GeoJSON and a printable report.
 *
 * Every core view exports, which the plan requires. Two rules run through all of
 * it: provenance travels with the data, and no export ever contains an API key.
 */

import { platform } from "@/core/platform";
import type { LngLat } from "@/domain/geometry";
import type { Site } from "@/core/store/siteStore";
import type { SiteReport } from "../solar/orchestrator";

export type ExportFormat = "csv" | "json" | "geojson" | "html";

export interface ExportMeta {
  /** Where the numbers came from; rendered into every format. */
  generatedAt: string;
  appVersion: string;
  projectName: string;
  /** Mandatory standing caveats, e.g. the screening disclaimer. */
  disclaimers: string[];
}

/* --- CSV ------------------------------------------------------------------ */

/**
 * Escapes a CSV field.
 *
 * Quotes anything containing a delimiter, a quote or a newline, and doubles
 * embedded quotes. Also prefixes a value that starts with a formula character,
 * which stops a spreadsheet from executing text out of an exported report.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "";
  const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [keys.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(keys.map((key) => csvField(row[key])).join(","));
  }
  // CRLF: Excel is the most common destination and it prefers them.
  return `${lines.join("\r\n")}\r\n`;
}

/** Comment header carrying provenance, which CSV has no other place for. */
function csvHeader(meta: ExportMeta): string {
  const lines = [
    `# Sunday ${meta.appVersion} — ${meta.projectName}`,
    `# Generated ${meta.generatedAt}`,
    ...meta.disclaimers.map((line) => `# ${line}`),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/* --- Site tables ---------------------------------------------------------- */

export function sitesToRows(sites: Site[]): Array<Record<string, unknown>> {
  return sites.map((site) => ({
    id: site.id,
    name: site.name,
    kind: site.kind,
    longitude: site.centre[0].toFixed(6),
    latitude: site.centre[1].toFixed(6),
    area_m2: site.areaM2 > 0 ? Math.round(site.areaM2) : "",
    area_ha: site.areaM2 > 0 ? (site.areaM2 / 10_000).toFixed(3) : "",
    perimeter_m: site.perimeterM > 0 ? Math.round(site.perimeterM) : "",
    geometry_valid: site.geometryValid,
    ghi_kwh_m2_year: site.resource?.ghiKwhM2Year?.toFixed(0) ?? "",
    dni_kwh_m2_year: site.resource?.dniKwhM2Year?.toFixed(0) ?? "",
    resource_source: site.resource?.source ?? "",
    resource_fidelity: site.resource?.fidelity ?? "",
    resource_method: site.resource?.method ?? "",
    mean_slope_deg: site.terrain?.meanSlopeDegrees?.toFixed(2) ?? "",
    terrain_source: site.terrain?.source ?? "",
    module: site.design?.moduleId ?? "",
    mount: site.design?.mount ?? "",
    tilt_deg: site.design?.tiltDegrees ?? "",
    azimuth_deg: site.design?.azimuthDegrees ?? "",
    ground_coverage_ratio: site.design?.groundCoverageRatio ?? "",
    // Screening flags belong in the export: a caution the user never sees again
    // is a caution that did not do its job.
    blocking_issues: site.nudges.filter((n) => n.severity === "blocking").map((n) => n.title).join("; "),
    cautions: site.nudges.filter((n) => n.severity === "caution").map((n) => n.title).join("; "),
    notes: site.notes,
  }));
}

export function exportSitesCsv(sites: Site[], meta: ExportMeta): string {
  return csvHeader(meta) + toCsv(sitesToRows(sites));
}

/* --- GeoJSON -------------------------------------------------------------- */

export function sitesToGeoJson(sites: Site[], meta: ExportMeta): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    // Non-standard but widely honoured: readers ignore unknown members, and this
    // is the only way GeoJSON can carry provenance.
    ...({
      metadata: {
        generator: `Sunday ${meta.appVersion}`,
        generatedAt: meta.generatedAt,
        project: meta.projectName,
        disclaimers: meta.disclaimers,
      },
    } as object),
    features: sites.map((site) => ({
      type: "Feature",
      id: site.id,
      geometry:
        site.ring && site.ring.length >= 3
          ? { type: "Polygon", coordinates: [[...site.ring, site.ring[0] as LngLat]] }
          : { type: "Point", coordinates: site.centre },
      properties: {
        name: site.name,
        kind: site.kind,
        areaM2: site.areaM2 || undefined,
        perimeterM: site.perimeterM || undefined,
        geometryValid: site.geometryValid,
        resource: site.resource,
        terrain: site.terrain,
        design: site.design,
        nudges: site.nudges.map((nudge) => ({
          severity: nudge.severity,
          title: nudge.title,
          basis: nudge.basis,
        })),
        notes: site.notes || undefined,
      },
    })),
  };
}

/* --- Site report ---------------------------------------------------------- */

export function reportToRows(report: SiteReport): Array<Record<string, unknown>> {
  return report.reports.map((entry) => ({
    provider: entry.provider,
    source: entry.source,
    dataset: entry.dataset,
    vintage: entry.vintage ?? "",
    fidelity: entry.fidelity,
    ghi_kwh_m2_year: entry.ghiKwhM2Year?.toFixed(0) ?? "",
    dni_kwh_m2_year: entry.dniKwhM2Year?.toFixed(0) ?? "",
    dhi_kwh_m2_year: entry.dhiKwhM2Year?.toFixed(0) ?? "",
    poa_kwh_m2_year: entry.poaKwhM2Year?.toFixed(0) ?? "",
    specific_yield_kwh_kwp: entry.specificYieldKwhPerKwp?.toFixed(0) ?? "",
    optimal_tilt_deg: entry.optimalTiltDegrees?.toFixed(1) ?? "",
    mean_air_temp_c: entry.meanAirTempC?.toFixed(1) ?? "",
    method: entry.method,
    caveats: entry.caveats.join(" | "),
  }));
}

export function exportReportCsv(report: SiteReport, meta: ExportMeta): string {
  const header = csvHeader({
    ...meta,
    disclaimers: [
      ...meta.disclaimers,
      `Location ${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)}`,
      ...report.warnings,
    ],
  });
  return header + toCsv(reportToRows(report));
}

/* --- Printable report ----------------------------------------------------- */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A self-contained HTML report.
 *
 * HTML rather than a generated PDF binary: it prints to PDF from any browser or
 * from the OS print dialog, it stays readable and searchable, and it avoids
 * shipping a PDF engine to produce a document that is mostly a table. The print
 * stylesheet is included so the printed result is deliberate rather than accidental.
 */
export function exportReportHtml(
  report: SiteReport,
  meta: ExportMeta,
  site?: Site,
): string {
  const rows = reportToRows(report);
  const columns: Array<{ key: string; label: string }> = [
    { key: "provider", label: "Source" },
    { key: "dataset", label: "Dataset" },
    { key: "fidelity", label: "Fidelity" },
    { key: "ghi_kwh_m2_year", label: "GHI" },
    { key: "dni_kwh_m2_year", label: "DNI" },
    { key: "poa_kwh_m2_year", label: "In-plane" },
    { key: "specific_yield_kwh_kwp", label: "Yield" },
    { key: "optimal_tilt_deg", label: "Optimal tilt" },
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sunday site report — ${escapeHtml(site?.name ?? "Location")}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: "IBM Plex Sans", system-ui, sans-serif; color: #1b1710; margin: 0; padding: 32px; max-width: 900px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b6152; margin: 28px 0 8px; }
  .meta { font-size: 12px; color: #6b6152; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd6c8; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b6152; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; font-family: "IBM Plex Mono", monospace; }
  .kv { display: grid; grid-template-columns: 200px 1fr; gap: 4px 16px; font-size: 12px; }
  .kv dt { color: #6b6152; }
  .kv dd { margin: 0; font-variant-numeric: tabular-nums; }
  .warn { border-left: 3px solid #b8860b; background: #fdf6e3; padding: 8px 12px; font-size: 12px; margin: 6px 0; }
  .method { font-size: 11px; color: #6b6152; line-height: 1.5; }
  footer { margin-top: 32px; font-size: 10px; color: #8a8070; line-height: 1.6; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } table { break-inside: auto; } tr { break-inside: avoid; } }
</style>
</head>
<body>
<h1>${escapeHtml(site?.name ?? "Site report")}</h1>
<p class="meta">
  ${report.latitude.toFixed(5)}°, ${report.longitude.toFixed(5)}° &middot;
  Generated ${escapeHtml(report.generatedAt)} &middot;
  Sunday ${escapeHtml(meta.appVersion)} &middot; Project ${escapeHtml(meta.projectName)}
</p>

${
  site && site.areaM2 > 0
    ? `<h2>Site</h2>
<dl class="kv">
  <dt>Area</dt><dd>${(site.areaM2 / 10_000).toFixed(2)} ha (${Math.round(site.areaM2).toLocaleString()} m²)</dd>
  <dt>Perimeter</dt><dd>${Math.round(site.perimeterM).toLocaleString()} m</dd>
  ${site.terrain?.meanSlopeDegrees !== undefined ? `<dt>Mean slope</dt><dd>${site.terrain.meanSlopeDegrees.toFixed(2)}°</dd>` : ""}
</dl>`
    : ""
}

<h2>Solar resource by source</h2>
<table>
  <thead><tr>${columns
    .map(
      (column) =>
        `<th${column.key.includes("kwh") || column.key.includes("deg") ? ' class="num"' : ""}>${escapeHtml(column.label)}</th>`,
    )
    .join("")}</tr></thead>
  <tbody>
    ${rows
      .map(
        (row) =>
          `<tr>${columns
            .map((column) => {
              const numeric = column.key.includes("kwh") || column.key.includes("deg");
              return `<td${numeric ? ' class="num"' : ""}>${escapeHtml(String(row[column.key] ?? ""))}</td>`;
            })
            .join("")}</tr>`,
      )
      .join("\n    ")}
  </tbody>
</table>

${
  report.warnings.length > 0
    ? `<h2>Disagreements and warnings</h2>
${report.warnings.map((warning) => `<p class="warn">${escapeHtml(warning)}</p>`).join("\n")}`
    : ""
}

${
  site && site.nudges.length > 0
    ? `<h2>Screening flags</h2>
<table>
  <thead><tr><th>Severity</th><th>Issue</th><th>Basis</th></tr></thead>
  <tbody>
    ${site.nudges
      .map(
        (nudge) =>
          `<tr><td>${escapeHtml(nudge.severity)}</td><td>${escapeHtml(nudge.title)}<br><span class="method">${escapeHtml(nudge.detail)}</span></td><td class="method">${escapeHtml(nudge.basis)}</td></tr>`,
      )
      .join("\n    ")}
  </tbody>
</table>`
    : ""
}

<h2>Methods</h2>
${report.reports
  .map(
    (entry) =>
      `<p class="method"><strong>${escapeHtml(entry.source)}</strong> — ${escapeHtml(entry.method)}${
        entry.caveats.length > 0 ? ` ${escapeHtml(entry.caveats.join(" "))}` : ""
      }</p>`,
  )
  .join("\n")}

<footer>
${meta.disclaimers.map((line) => escapeHtml(line)).join("<br>")}
<br>Attribution: ${report.reports.map((entry) => escapeHtml(entry.source)).join("; ")}
</footer>
</body>
</html>`;
}

/* --- Writing -------------------------------------------------------------- */

const EXTENSIONS: Record<ExportFormat, { ext: string; name: string }> = {
  csv: { ext: "csv", name: "Comma-separated values" },
  json: { ext: "json", name: "JSON" },
  geojson: { ext: "geojson", name: "GeoJSON" },
  html: { ext: "html", name: "Printable report" },
};

/** Writes an export through the platform's save dialog. */
export async function writeExport(
  baseName: string,
  format: ExportFormat,
  contents: string,
): Promise<string | null> {
  const { ext, name } = EXTENSIONS[format];
  const safeName = baseName.replace(/[^\w\-. ]+/g, "_").trim() || "sunday-export";
  return platform().shell.saveFile(`${safeName}.${ext}`, contents, [
    { name, extensions: [ext] },
  ]);
}

export function defaultMeta(projectName: string, disclaimers: string[] = []): ExportMeta {
  return {
    generatedAt: new Date().toISOString(),
    appVersion: "0.1.0",
    projectName,
    disclaimers: [
      "Estimates for planning purposes. Not a substitute for a bankable energy yield assessment.",
      ...disclaimers,
    ],
  };
}
