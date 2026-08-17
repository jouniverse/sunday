/**
 * Local rooftop packing → lng/lat rings and inline SVG schematic.
 * Kept out of the MapLibre component so export and tests do not load the map.
 */

import type { Site } from "@/core/store/siteStore";
import { type Point2D, polygonBounds2D, ringToLocalFrame, toGeographic } from "@/domain/geometry";
import type { RooftopPackingResult } from "@/domain/packing/rooftop";

export function packingModulesToLngLat(
  site: Site,
  packing: RooftopPackingResult,
): Array<Array<[number, number]>> {
  if (!site.ring || site.ring.length < 3) return [];
  const { origin } = ringToLocalFrame(site.ring);
  return packing.modules.map((placed) => {
    const ring = placed.corners.map((corner) => toGeographic(corner, origin));
    const first = ring[0];
    if (first) ring.push(first);
    return ring;
  });
}

export function buildRooftopSchematicSvg(options: {
  site: Site;
  packing: RooftopPackingResult;
}): string | null {
  if (!options.site.ring || options.site.ring.length < 3) return null;
  const width = 900;
  const height = 620;
  const margin = 40;
  const { polygon } = ringToLocalFrame(options.site.ring);
  const bounds = polygonBounds2D(polygon);
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  const fitScale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const project = (point: Point2D): [number, number] => [
    margin + (point.x - bounds.minX) * fitScale,
    height - margin - (point.y - bounds.minY) * fitScale,
  ];
  const boundary = polygon
    .map(project)
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const modulePaths = options.packing.modules
    .map((placed) => {
      const pts = placed.corners.map(project);
      const first = pts[0];
      if (!first) return "";
      return (
        `M${first[0].toFixed(1)} ${first[1].toFixed(1)}` +
        pts
          .slice(1)
          .map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`)
          .join("") +
        "Z"
      );
    })
    .filter(Boolean)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Rooftop packing schematic">
  <rect width="${width}" height="${height}" fill="#131009"/>
  <polygon points="${boundary}" fill="none" stroke="#4f4536" stroke-width="1.4" stroke-dasharray="4 3"/>
  <path d="${modulePaths}" fill="#2a4650" stroke="#96cfe2" stroke-width="0.4"/>
  <text x="${margin}" y="28" font-size="11" fill="#9c8f7d" font-family="IBM Plex Mono,monospace">${options.packing.moduleCount} modules · ${options.packing.method}</text>
</svg>`;
}
