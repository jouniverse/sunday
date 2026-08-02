/**
 * Printable SVG monthly charts for the site report HTML export.
 *
 * Light-theme colours (the printable report is light). Shared maths with the
 * in-app MonthlySeriesChart — kept free of React so services/export stays pure.
 */

import type { MonthlyValue, ResourceReport } from "@/services/solar/types";
import { PROVIDERS } from "@/services/solar/types";

const MONTH_LABELS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const SERIES_COLOURS = ["#c08520", "#2a7a8c", "#3a6ea5", "#b8732a"];
const WIDTH = 760;
const HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 28, left: 44 };

export function buildMonthlyChartSvg(options: {
  title: string;
  unitLabel: string;
  reports: ResourceReport[];
  select: (report: ResourceReport) => MonthlyValue[] | undefined;
  valueDigits?: number;
  /** Horizontal reference line(s), e.g. annual average / consensus. */
  referenceLines?: Array<{ value: number; label: string; colour?: string }>;
}): string | null {
  const valueDigits = options.valueDigits ?? 0;
  const series = options.reports
    .map((report, index) => ({
      provider: report.provider,
      label: PROVIDERS[report.provider].label,
      colour: SERIES_COLOURS[index % SERIES_COLOURS.length] as string,
      points: climatologyPoints(options.select(report) ?? []),
    }))
    .filter((entry) => entry.points.length > 0);

  if (series.length === 0 && !(options.referenceLines?.length)) return null;

  const values = [
    ...series.flatMap((entry) => entry.points.map((point) => point.value)),
    ...(options.referenceLines ?? []).map((line) => line.value),
  ];
  if (values.length === 0) return null;

  const maxValue = Math.max(...values);
  const minValue = Math.min(...values, 0);
  const span = Math.max(maxValue - minValue, 1e-6);
  const step = niceStep(span / 4);
  const axisMin = Math.floor(minValue / step) * step;
  const axisMax = Math.ceil(maxValue / step) * step;
  const axisSpan = Math.max(axisMax - axisMin, step);

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (month: number) => PADDING.left + ((month - 1) / 11) * plotWidth;
  const y = (value: number) =>
    PADDING.top + plotHeight - ((value - axisMin) / axisSpan) * plotHeight;

  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = axisMin + (axisSpan / 4) * index;
    return `<g>
      <line x1="${PADDING.left}" x2="${WIDTH - PADDING.right}" y1="${y(value)}" y2="${y(value)}" stroke="#ddd6c8" stroke-width="1"/>
      <text x="${PADDING.left - 8}" y="${y(value) + 3}" text-anchor="end" font-size="10" font-family="IBM Plex Mono,monospace" fill="#6b6152">${format(value, valueDigits)}</text>
    </g>`;
  }).join("");

  const months = MONTH_LABELS.map(
    (label, index) =>
      `<text x="${x(index + 1)}" y="${HEIGHT - 10}" text-anchor="middle" font-size="10" fill="#6b6152">${label}</text>`,
  ).join("");

  const lines = series
    .map((entry) => {
      const points = entry.points.map((point) => `${x(point.month)},${y(point.value)}`).join(" ");
      const dots = entry.points
        .map(
          (point) =>
            `<circle cx="${x(point.month)}" cy="${y(point.value)}" r="2.5" fill="${entry.colour}"/>`,
        )
        .join("");
      return `<g><polyline points="${points}" fill="none" stroke="${entry.colour}" stroke-width="1.8" stroke-linejoin="round"/>${dots}</g>`;
    })
    .join("");

  const refs = (options.referenceLines ?? [])
    .map((line) => {
      const colour = line.colour ?? "#422c00";
      const yy = y(line.value);
      return `<g>
        <line x1="${PADDING.left}" x2="${WIDTH - PADDING.right}" y1="${yy}" y2="${yy}" stroke="${colour}" stroke-width="1.2" stroke-dasharray="5 4"/>
        <text x="${WIDTH - PADDING.right}" y="${yy - 4}" text-anchor="end" font-size="10" fill="${colour}">${escapeXml(line.label)} ${format(line.value, valueDigits)}</text>
      </g>`;
    })
    .join("");

  const legend = series
    .map(
      (entry) =>
        `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px"><span style="width:10px;height:10px;background:${entry.colour};display:inline-block"></span>${escapeXml(entry.label)}</span>`,
    )
    .join("");

  return `<section class="chart-block">
  <h2>${escapeXml(options.title)}</h2>
  <div class="chart-legend">${legend}</div>
  <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="100%" role="img" aria-label="${escapeXml(options.title)}">
    ${grid}${months}${lines}${refs}
  </svg>
  <p class="method">${escapeXml(options.unitLabel)}</p>
</section>`;
}

function format(value: number, digits: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function climatologyPoints(
  points: Array<{ month: number; value: number }>,
): Array<{ month: number; value: number }> {
  const buckets = new Map<number, number[]>();
  for (const point of points) {
    if (point.month < 1 || point.month > 12) continue;
    const list = buckets.get(point.month) ?? [];
    list.push(point.value);
    buckets.set(point.month, list);
  }
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const values = buckets.get(month);
    if (!values || values.length === 0) return null;
    return {
      month,
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
  }).filter((point): point is { month: number; value: number } => point !== null);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
