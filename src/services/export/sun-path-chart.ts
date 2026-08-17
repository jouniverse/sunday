/**
 * Printable Cartesian sun-path SVG for the site report HTML export.
 *
 * Azimuth on x (0° north → 360°), apparent elevation on y (0–90°).
 * Light-theme colours — the printable report is light.
 */

import type { HorizonProfile } from "@/domain/siting/horizon";
import { sunPathTraceKind } from "@/domain/siting/horizon";
import type { SunPathResult } from "@/services/engine/client";

const WIDTH = 760;
const HEIGHT = 280;
const PADDING = { top: 16, right: 16, bottom: 32, left: 44 };

const KIND_COLOUR = {
  high: "#c08520",
  equinox: "#2a7a8c",
  low: "#3a6ea5",
} as const;

const KIND_LABEL = {
  high: "High sun",
  equinox: "Equinox",
  low: "Low sun",
} as const;

export function buildSunPathChartSvg(options: {
  sunPath: SunPathResult;
  latitude: number;
  horizon?: HorizonProfile | null;
}): string | null {
  const traces = options.sunPath.traces
    .map((trace) => {
      const kind = sunPathTraceKind(trace.date, options.latitude);
      const points = trace.points
        .filter((point) => point.elevation > 0)
        .map((point) => ({
          azimuth: point.azimuth,
          elevation: point.elevation,
          hour: localHour(point.time),
        }));
      return { kind, label: `${KIND_LABEL[kind]} (${trace.date.slice(5)})`, colour: KIND_COLOUR[kind], points };
    })
    .filter((trace) => trace.points.length > 2);
  if (traces.length === 0) return null;

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (azimuth: number) => PADDING.left + (azimuth / 360) * plotWidth;
  const y = (elevation: number) =>
    PADDING.top + plotHeight - (Math.max(0, Math.min(90, elevation)) / 90) * plotHeight;

  const grid = [0, 15, 30, 45, 60, 75, 90]
    .map(
      (el) =>
        `<g>
      <line x1="${PADDING.left}" x2="${WIDTH - PADDING.right}" y1="${y(el)}" y2="${y(el)}" stroke="#ddd6c8" stroke-width="1"/>
      <text x="${PADDING.left - 8}" y="${y(el) + 3}" text-anchor="end" font-size="10" font-family="IBM Plex Mono,monospace" fill="#6b6152">${el}°</text>
    </g>`,
    )
    .join("");

  const azimuths = [0, 90, 180, 270, 360]
    .map(
      (az) =>
        `<g>
      <line x1="${x(az)}" x2="${x(az)}" y1="${PADDING.top}" y2="${HEIGHT - PADDING.bottom}" stroke="#eee8dc" stroke-width="1"/>
      <text x="${x(az)}" y="${HEIGHT - 10}" text-anchor="middle" font-size="10" fill="#6b6152">${azimuthLabel(az)}</text>
    </g>`,
    )
    .join("");

  const horizon = options.horizon?.samples ?? [];
  let horizonMarkup = "";
  if (horizon.length >= 3) {
    const sorted = [...horizon].sort((a, b) => a.azimuth - b.azimuth);
    const top = sorted.map((sample) => `${x(sample.azimuth)},${y(sample.elevationDegrees)}`).join(" ");
    const ground = `${x(360)},${y(0)} ${x(0)},${y(0)}`;
    horizonMarkup = `<polygon points="${top} ${ground}" fill="rgba(156,143,125,0.28)" stroke="#8a8070" stroke-width="1"/>`;
  }

  const lines = traces
    .map((trace) => {
      const segments = splitAzimuthWrap(trace.points);
      const polylines = segments
        .map((segment) => {
          const pts = segment.map((point) => `${x(point.azimuth)},${y(point.elevation)}`).join(" ");
          return `<polyline points="${pts}" fill="none" stroke="${trace.colour}" stroke-width="1.8" stroke-linejoin="round"/>`;
        })
        .join("");
      const hours = hourMarks(trace.points)
        .map(
          (mark) =>
            `<text x="${x(mark.azimuth)}" y="${y(mark.elevation) - 4}" text-anchor="middle" font-size="9" fill="${trace.colour}">${mark.hour}</text>`,
        )
        .join("");
      return `<g>${polylines}${hours}</g>`;
    })
    .join("");

  const legend = traces
    .filter((trace, index, all) => all.findIndex((entry) => entry.kind === trace.kind) === index)
    .map(
      (trace) =>
        `<span style="margin-right:12px"><span style="display:inline-block;width:10px;height:10px;background:${trace.colour};margin-right:4px;vertical-align:middle"></span>${escapeXml(trace.label)}</span>`,
    )
    .join("");
  const horizonLegend = horizon.length >= 3 ? `<span style="margin-right:12px">Terrarium horizon</span>` : "";

  const method = options.sunPath.method.solar_position
    ? `${options.sunPath.method.solar_position}; ${options.sunPath.method.weather}`
    : "pvlib solar position";
  const horizonNote = options.horizon?.method
    ? ` Horizon: ${options.horizon.method}.`
    : " Far-field terrain horizon unavailable (desktop Terrarium).";

  return `<div class="chart-block">
  <h2>Sun path</h2>
  <div class="chart-legend">${legend}${horizonLegend}</div>
  <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="100%" role="img" aria-label="Sun path diagram">
    ${grid}${azimuths}${horizonMarkup}${lines}
  </svg>
  <p class="method">${escapeXml(method)}.${escapeXml(horizonNote)} Cartesian azimuth × elevation; solstice/equinox envelope. Does not include trees or buildings.</p>
</div>`;
}

function azimuthLabel(azimuth: number): string {
  if (azimuth === 0 || azimuth === 360) return "N";
  if (azimuth === 90) return "E";
  if (azimuth === 180) return "S";
  if (azimuth === 270) return "W";
  return `${azimuth}°`;
}

function localHour(iso: string): number | null {
  const match = iso.match(/T(\d{2}):/);
  if (!match) return null;
  return Number(match[1]);
}

function splitAzimuthWrap(
  points: Array<{ azimuth: number; elevation: number; hour: number | null }>,
): Array<Array<{ azimuth: number; elevation: number }>> {
  const segments: Array<Array<{ azimuth: number; elevation: number }>> = [];
  let current: Array<{ azimuth: number; elevation: number }> = [];
  for (const point of points) {
    const last = current[current.length - 1];
    if (last && Math.abs(point.azimuth - last.azimuth) > 180) {
      segments.push(current);
      current = [];
    }
    current.push({ azimuth: point.azimuth, elevation: point.elevation });
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function hourMarks(
  points: Array<{ azimuth: number; elevation: number; hour: number | null }>,
): Array<{ azimuth: number; elevation: number; hour: string }> {
  const seen = new Set<number>();
  const marks: Array<{ azimuth: number; elevation: number; hour: string }> = [];
  for (const point of points) {
    if (point.hour == null || point.hour % 2 !== 0 || point.elevation < 8) continue;
    if (seen.has(point.hour)) continue;
    seen.add(point.hour);
    marks.push({ azimuth: point.azimuth, elevation: point.elevation, hour: String(point.hour) });
  }
  return marks;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
