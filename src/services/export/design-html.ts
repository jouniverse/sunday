/**
 * Print-friendly HTML for greenfield and rooftop Design summaries.
 *
 * Opens via the same save dialog as other exports; the user prints to PDF from
 * the browser / OS print sheet. Optional images (schematic, satellite, flux)
 * are embedded as data URLs.
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
  /** data: URL or https URL */
  src: string;
  caption?: string;
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
    .filter((image) => image.src)
    .map(
      (image) => `
  <h2>${escapeHtml(image.title)}</h2>
  <figure class="fig">
    <img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.title)}" />
    ${image.caption ? `<figcaption>${escapeHtml(image.caption)}</figcaption>` : ""}
  </figure>`,
    )
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
  .fig img { max-width: 100%; height: auto; border: 1px solid #ddd4c4; background: #f7f3ea; }
  .fig figcaption { font-size: 11px; color: #6b6152; margin-top: 6px; }
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
