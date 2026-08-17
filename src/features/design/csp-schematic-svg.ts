/**
 * Inline SVG schematic for CSP HTML export (same pattern as greenfield
 * `buildFullSchematicSvg`). Inline markup — not a data URL — so WebKit does
 * not drop a large heliostat field.
 */

import type { LngLat, Point2D } from "@/domain/geometry";
import { polygonBounds2D } from "@/domain/geometry";
import { lngLatToLocalPoint, ringToLocalFrame } from "@/domain/csp/local-frame";
import type { CspLocalPoint, CspTechnology } from "@/domain/csp/types";

const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 620;
const MARGIN = 40;
const MAX_HELIOSTATS = 8_000;

export function buildCspSchematicSvg(options: {
  ring: LngLat[];
  technology: CspTechnology;
  heliostatsLocal?: CspLocalPoint[];
  troughStripsLngLat?: Array<Array<[number, number]>>;
  origin?: LngLat;
  caption?: string;
}): string | null {
  if (options.ring.length < 3) return null;
  const { polygon, origin } = ringToLocalFrame(options.ring);
  const bounds = polygonBounds2D(polygon);
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  const fitScale = Math.min((VIEW_WIDTH - MARGIN * 2) / spanX, (VIEW_HEIGHT - MARGIN * 2) / spanY);
  const project = (point: Point2D): [number, number] => [
    MARGIN + (point.x - bounds.minX) * fitScale,
    VIEW_HEIGHT - MARGIN - (point.y - bounds.minY) * fitScale,
  ];
  const boundary = polygon.map(project).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  let fieldPath = "";
  let extraMark = "";
  let countLabel = "";
  if (options.technology === "tower") {
    const points = (options.heliostatsLocal ?? []).slice(0, MAX_HELIOSTATS);
    const size = Math.max(1.2, Math.min(3.2, 900 / Math.max(points.length, 1)));
    fieldPath = points
      .map((point) => {
        const [x, y] = project(point);
        return `M${(x - size / 2).toFixed(1)} ${(y - size / 2).toFixed(1)}h${size.toFixed(1)}v${size.toFixed(1)}h${(-size).toFixed(1)}z`;
      })
      .join("");
    const [tx, ty] = project({ x: 0, y: 0 });
    const towerMark = `<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="5" fill="#e6c27a" stroke="#f7bf59" stroke-width="1.2"/>`;
    countLabel = `${points.length.toLocaleString()} heliostats`;
    extraMark = towerMark;
  } else {
    const originLngLat = options.origin ?? origin;
    const strips = options.troughStripsLngLat ?? [];
    fieldPath = strips
      .map((ring) => {
        const corners = ring.map((lngLat) => project(lngLatToLocalPoint(lngLat, originLngLat)));
        const first = corners[0];
        if (!first) return "";
        return (
          `M${first[0].toFixed(1)} ${first[1].toFixed(1)}` +
          corners
            .slice(1)
            .map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`)
            .join("") +
          "Z"
        );
      })
      .filter(Boolean)
      .join("");
    countLabel = `${strips.length.toLocaleString()} trough strips`;
  }

  const caption = options.caption ?? countLabel;
  const fill = options.technology === "tower" ? "#8a6a3a" : "#6b5344";
  const stroke = options.technology === "tower" ? "#c4a35a" : "#c4a35a";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" width="100%" role="img" aria-label="CSP field schematic">
  <rect width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" fill="#131009"/>
  <polygon points="${boundary}" fill="none" stroke="#4f4536" stroke-width="1.4" stroke-dasharray="4 3"/>
  <path d="${fieldPath}" fill="${fill}" stroke="${stroke}" stroke-width="0.6"/>
  ${extraMark}
  <text x="${MARGIN}" y="28" font-size="11" fill="#9c8f7d" font-family="IBM Plex Mono,monospace">${escapeXml(caption)}</text>
</svg>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
