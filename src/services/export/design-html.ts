/**
 * Print-friendly HTML for greenfield and rooftop Design summaries.
 *
 * Opens via the same save dialog as other exports; the user prints to PDF from
 * the browser / OS print sheet. Optional images (schematic, satellite, flux)
 * are embedded as data URLs or https URLs.
 */

import type { ExportMeta } from "./index";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface DesignHtmlSection {
  title: string;
  rows: Array<{ label: string; value: string }>;
}

export interface DesignHtmlImage {
  title: string;
  /** data: URL or https URL — omit when `inlineSvg` is provided. */
  src?: string;
  /**
   * Raw SVG markup embedded inline. Prefer this for large schematics — data:
   * URLs hit length limits and disappear in WebKit.
   */
  inlineSvg?: string;
  caption?: string;
  /**
   * Optional site outline in normalised image coordinates (0–1, y down).
   * Rendered as an SVG overlay so we never need canvas CORS for Esri tiles.
   */
  outlineNorm?: Array<[number, number]> | null;
}

export function exportDesignHtml(options: {
  title: string;
  siteName: string;
  meta: ExportMeta;
  sections: DesignHtmlSection[];
  notes?: string[];
  images?: DesignHtmlImage[];
}): string {
  const sectionsHtml = options.sections
    .map(
      (section) => `
  <h2>${escapeHtml(section.title)}</h2>
  <dl class="kv">
    ${section.rows
      .map(
        (row) =>
          `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`,
      )
      .join("")}
  </dl>`,
    )
    .join("");

  const notesHtml = (options.notes ?? [])
    .map((note) => `<div class="warn">${escapeHtml(note)}</div>`)
    .join("");

  const imagesHtml = (options.images ?? [])
    .filter((image) => image.src || image.inlineSvg)
    .map((image) => {
      const outline = image.outlineNorm;
      const overlay =
        outline && outline.length >= 3
          ? `<svg class="fig__outline" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${outline.map(([x, y]) => `${x},${y}`).join(" ")}" />
    </svg>`
          : "";
      const body = image.inlineSvg
        ? `<div class="fig__frame fig__frame--svg">${image.inlineSvg}</div>`
        : `<div class="fig__frame">
      <img src="${escapeHtml(image.src ?? "")}" alt="${escapeHtml(image.title)}" />
      ${overlay}
    </div>`;
      return `
  <h2>${escapeHtml(image.title)}</h2>
  <figure class="fig">
    ${body}
    ${image.caption ? `<figcaption>${escapeHtml(image.caption)}</figcaption>` : ""}
  </figure>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title)} — ${escapeHtml(options.siteName)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: "IBM Plex Sans", system-ui, sans-serif; color: #1b1710; margin: 0; padding: 32px; max-width: 860px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b6152; margin: 28px 0 8px; }
  .meta { font-size: 12px; color: #6b6152; margin-bottom: 20px; }
  .kv { display: grid; grid-template-columns: 220px 1fr; gap: 4px 16px; font-size: 12.5px; }
  .kv dt { color: #6b6152; }
  .kv dd { margin: 0; font-variant-numeric: tabular-nums; }
  .warn { border-left: 3px solid #b8860b; background: #fdf6e3; padding: 8px 12px; font-size: 12px; margin: 8px 0; }
  .fig { margin: 0 0 16px; }
  .fig__frame { position: relative; display: inline-block; max-width: 100%; border: 1px solid #ddd4c4; background: #f7f3ea; line-height: 0; }
  .fig__frame img { max-width: 100%; height: auto; display: block; }
  .fig__frame--svg { width: 100%; background: #131009; }
  .fig__frame--svg svg { display: block; width: 100%; height: auto; }
  .fig__outline { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .fig__outline polygon { fill: rgba(247, 191, 89, 0.22); stroke: #f7bf59; stroke-width: 0.004; }
  .fig figcaption { font-size: 11px; color: #6b6152; margin-top: 6px; line-height: 1.4; }
  footer { margin-top: 32px; font-size: 10px; color: #8a8070; line-height: 1.6; }
  @media print { body { padding: 12px; } }
</style>
</head>
<body>
  <h1>${escapeHtml(options.title)}</h1>
  <div class="meta">
    ${escapeHtml(options.siteName)} · ${escapeHtml(options.meta.projectName)} ·
    Sunday ${escapeHtml(options.meta.appVersion)} · ${escapeHtml(options.meta.generatedAt)}
  </div>
  ${sectionsHtml}
  ${imagesHtml}
  ${notesHtml}
  <footer>
    ${(options.meta.disclaimers ?? []).map((line) => escapeHtml(line)).join("<br>")}
  </footer>
</body>
</html>`;
}
