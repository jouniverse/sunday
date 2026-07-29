/**
 * Schematic plan view of the array inside the site boundary.
 *
 * An orthographic drawing rather than a map: at design scale what matters is the
 * row geometry against the boundary, and imagery underneath makes that harder to
 * read, not easier. The boundary is drawn from the real polygon in its local
 * metres frame, so what is shown is the actual site shape.
 */

import { useMemo } from "react";
import type { Site } from "@/core/store/siteStore";
import type { ModuleSpec } from "@/domain/packing/priors";
import { rowGeometryFromGcr } from "@/domain/packing/ground-mount";
import {
  polygonBounds2D,
  rectangleInPolygon,
  ringToLocalFrame,
  rotatePoint2D,
} from "@/domain/geometry";
import type { Point2D } from "@/domain/geometry";

const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 620;
const MARGIN = 40;

export interface ArrayPreviewProps {
  site: Site;
  module: ModuleSpec;
  tiltDegrees: number;
  gcr: number;
  azimuth: number;
}

export function ArrayPreview({ site, module, tiltDegrees, gcr, azimuth }: ArrayPreviewProps) {
  const layout = useMemo(() => {
    if (!site.ring || site.ring.length < 3) return null;

    const { polygon } = ringToLocalFrame(site.ring);
    const row = rowGeometryFromGcr(module, { tiltDegrees, gcr });

    // Rows run perpendicular to the array azimuth, so the grid is rotated by it.
    const gridRotation = -(azimuth - 180);
    const rotated = polygon.map((point) => rotatePoint2D(point, gridRotation));
    const bounds = polygonBounds2D(rotated);

    // A row is one module long across and the pitch deep; step through the
    // bounding box and keep the strips that fit inside the boundary.
    const stripLength = module.lengthM * 6;
    const strips: Array<{ x: number; y: number; width: number; height: number }> = [];
    const maxStrips = 4000; // Preview only; never let a huge site stall the UI.

    for (let y = bounds.minY; y + row.projectedWidthM <= bounds.maxY; y += row.pitchM) {
      for (let x = bounds.minX; x + stripLength <= bounds.maxX; x += stripLength) {
        if (strips.length >= maxStrips) break;
        if (rectangleInPolygon(rotated, x, y, stripLength, row.projectedWidthM)) {
          strips.push({ x, y, width: stripLength, height: row.projectedWidthM });
        }
      }
    }

    // Project back into the unrotated frame for drawing.
    const strapsInFrame = strips.map((strip) => {
      const corners: Point2D[] = [
        { x: strip.x, y: strip.y },
        { x: strip.x + strip.width, y: strip.y },
        { x: strip.x + strip.width, y: strip.y + strip.height },
        { x: strip.x, y: strip.y + strip.height },
      ];
      return corners.map((corner) => rotatePoint2D(corner, -gridRotation));
    });

    return { polygon, strips: strapsInFrame, row };
  }, [site.ring, module, tiltDegrees, gcr, azimuth]);

  if (!layout) return null;

  // Fit the site into the viewbox with a uniform scale, so shape is preserved.
  const bounds = polygonBounds2D(layout.polygon);
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((VIEW_WIDTH - MARGIN * 2) / spanX, (VIEW_HEIGHT - MARGIN * 2) / spanY);

  const project = (point: Point2D): [number, number] => [
    MARGIN + (point.x - bounds.minX) * scale,
    // Flip y: screen coordinates grow downwards, north is up.
    VIEW_HEIGHT - MARGIN - (point.y - bounds.minY) * scale,
  ];

  const boundaryPath = layout.polygon.map(project).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  return (
    <svg
      className="array-preview"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Plan view of the array layout for ${site.name}`}
    >
      <defs>
        <pattern id="preview-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="var(--canvas-grid-line)" strokeWidth="1" />
        </pattern>
      </defs>

      <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="var(--canvas-schematic)" />
      <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#preview-grid)" />

      {/* Site boundary */}
      <polygon
        points={boundaryPath}
        fill="none"
        stroke="var(--outline-variant)"
        strokeWidth="1.4"
        strokeDasharray="4 3"
      />

      {/* Module rows */}
      <g>
        {layout.strips.map((corners, index) => (
          <polygon
            key={index}
            points={corners.map(project).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
            fill="#2a4650"
            stroke="var(--secondary)"
            strokeWidth="0.8"
          />
        ))}
      </g>

      {/* North arrow: an orthographic drawing needs an orientation reference. */}
      <g transform={`translate(${VIEW_WIDTH - 56} 46)`}>
        <path d="M0 14 L0 -14 M0 -14 L-5 -6 M0 -14 L5 -6" stroke="var(--on-surface-variant)" strokeWidth="1.4" fill="none" />
        <text y="26" textAnchor="middle" fontSize="10" fill="var(--on-surface-variant)">
          N
        </text>
      </g>

      {/* Scale reference */}
      <g transform={`translate(${MARGIN} ${VIEW_HEIGHT - 18})`}>
        <line x1="0" y1="0" x2={100 * scale} y2="0" stroke="var(--on-surface-variant)" strokeWidth="1.5" />
        <text x={(100 * scale) / 2} y="-5" textAnchor="middle" fontSize="10" fill="var(--on-surface-variant)">
          100 m
        </text>
      </g>

      <text x={MARGIN} y="28" fontSize="11" fill="var(--outline)" fontFamily="var(--font-mono)">
        Pitch {layout.row.pitchM.toFixed(2)} m · gap {layout.row.gapM.toFixed(2)} m · schematic, not a construction drawing
      </text>
    </svg>
  );
}
