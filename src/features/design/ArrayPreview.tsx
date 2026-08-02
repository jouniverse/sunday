/**
 * Schematic plan view of the array inside the site boundary.
 *
 * An orthographic drawing rather than a map: at design scale what matters is the
 * row geometry against the boundary, and imagery underneath makes that harder to
 * read, not easier. Pan/zoom is available for large parcels; a satellite toggle
 * lives beside this view in DesignView when the user wants context.
 */

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import type { Site } from "@/core/store/siteStore";
import type { ModuleSpec, MountType } from "@/domain/packing/priors";
import { rowGeometryFromGcr } from "@/domain/packing/ground-mount";
import {
  polygonBounds2D,
  rectangleInPolygon,
  ringToLocalFrame,
  rotatePoint2D,
  toGeographic,
} from "@/domain/geometry";
import type { LngLat, Point2D } from "@/domain/geometry";

const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 620;
const MARGIN = 40;

export interface ArrayPreviewView {
  x: number;
  y: number;
  scale: number;
}

export interface ArrayPreviewProps {
  site: Site;
  module: ModuleSpec;
  tiltDegrees: number;
  gcr: number;
  azimuth: number;
  mount?: MountType;
  /** Pan/zoom of the schematic — used to keep the satellite layer in lockstep. */
  onViewChange?: (view: ArrayPreviewView) => void;
}

export interface ArrayStripLayout {
  stripsLocal: Point2D[][];
  stripsLngLat: LngLat[][];
  pitchM: number;
  gapM: number;
  truncated: boolean;
  maxStrips: number;
  stripCount: number;
}

/** Shared layout used by the schematic and by Design GeoJSON export. */
export function computeArrayStrips(options: {
  site: Site;
  module: ModuleSpec;
  tiltDegrees: number;
  gcr: number;
  azimuth: number;
  mount?: MountType;
  /**
   * Cap on drawn strips. Omit for the interactive SVG budget; pass `Infinity`
   * (or a very large number) for full HTML export schematics.
   */
  maxStrips?: number;
}): ArrayStripLayout | null {
  const { site, module, tiltDegrees, gcr, azimuth, mount = "fixed_tilt" } = options;
  if (!site.ring || site.ring.length < 3) return null;

  const { polygon, origin } = ringToLocalFrame(site.ring);
  const row = rowGeometryFromGcr(module, { tiltDegrees, gcr });

  // Dual-axis trackers need wider row pitch and column gaps (footprint blocks).
  const pitchScale = mount === "dual_axis" ? 1.55 : mount === "single_axis" ? 1.15 : 1;
  const pitchM = row.pitchM * pitchScale;
  const gapM = Math.max(0, pitchM - row.projectedWidthM);
  const stripLength =
    mount === "dual_axis" ? module.lengthM * 2.2 : module.lengthM * (mount === "single_axis" ? 4 : 6);
  const columnGap = mount === "dual_axis" ? module.widthM * 1.4 : 0;

  const gridRotation = -(azimuth - 180);
  const rotated = polygon.map((point) => rotatePoint2D(point, gridRotation));
  const bounds = polygonBounds2D(rotated);

  const strips: Array<{ x: number; y: number; width: number; height: number }> = [];
  // Interactive SVG cannot paint tens of thousands of polygons smoothly.
  // Packing capacity still uses computeFillFactor, not this preview count.
  const areaHa = Math.max(0.1, site.areaM2 / 10_000);
  const maxStrips =
    options.maxStrips ?? Math.min(3_000, Math.max(800, Math.round(areaHa * 120)));
  let truncated = false;

  for (let y = bounds.minY; y + row.projectedWidthM <= bounds.maxY; y += pitchM) {
    for (
      let x = bounds.minX;
      x + stripLength <= bounds.maxX;
      x += stripLength + columnGap
    ) {
      if (strips.length >= maxStrips) {
        truncated = true;
        break;
      }
      if (rectangleInPolygon(rotated, x, y, stripLength, row.projectedWidthM)) {
        strips.push({ x, y, width: stripLength, height: row.projectedWidthM });
      }
    }
    if (truncated) break;
  }

  const stripsLocal = strips.map((strip) => {
    const corners: Point2D[] = [
      { x: strip.x, y: strip.y },
      { x: strip.x + strip.width, y: strip.y },
      { x: strip.x + strip.width, y: strip.y + strip.height },
      { x: strip.x, y: strip.y + strip.height },
    ];
    return corners.map((corner) => rotatePoint2D(corner, -gridRotation));
  });

  const stripsLngLat = stripsLocal.map((corners) =>
    corners.map((corner) => toGeographic(corner, origin)),
  );

  return {
    stripsLocal,
    stripsLngLat,
    pitchM,
    gapM,
    truncated,
    maxStrips,
    stripCount: strips.length,
  };
}

export function ArrayPreview({
  site,
  module,
  tiltDegrees,
  gcr,
  azimuth,
  mount = "fixed_tilt",
  onViewChange,
}: ArrayPreviewProps) {
  const layout = useMemo(
    () => computeArrayStrips({ site, module, tiltDegrees, gcr, azimuth, mount }),
    [site, module, tiltDegrees, gcr, azimuth, mount],
  );

  const [view, setView] = useState<ArrayPreviewView>({ x: 0, y: 0, scale: 1 });
  const dragRef = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  function updateView(next: ArrayPreviewView | ((prev: ArrayPreviewView) => ArrayPreviewView)) {
    setView((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      onViewChangeRef.current?.(value);
      return value;
    });
  }

  if (!layout || !site.ring) return null;

  const { polygon } = ringToLocalFrame(site.ring);
  const bounds = polygonBounds2D(polygon);
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const fitScale = Math.min((VIEW_WIDTH - MARGIN * 2) / spanX, (VIEW_HEIGHT - MARGIN * 2) / spanY);

  const project = (point: Point2D): [number, number] => [
    MARGIN + (point.x - bounds.minX) * fitScale,
    VIEW_HEIGHT - MARGIN - (point.y - bounds.minY) * fitScale,
  ];

  const boundaryPath = polygon
    .map(project)
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");

  function onWheel(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    const rect = event.currentTarget.getBoundingClientRect();
    // Zoom toward the pointer so the schematic doesn't shrink into a corner.
    const px = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
    const py = ((event.clientY - rect.top) / rect.height) * VIEW_HEIGHT;
    updateView((prev) => {
      const nextScale = Math.min(4, Math.max(0.5, prev.scale * factor));
      const ratio = nextScale / prev.scale;
      return {
        scale: nextScale,
        x: px - (px - prev.x) * ratio,
        y: py - (py - prev.y) * ratio,
      };
    });
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const nextX = drag.viewX + (event.clientX - drag.x);
    const nextY = drag.viewY + (event.clientY - drag.y);
    updateView((prev) => ({ ...prev, x: nextX, y: nextY }));
  }

  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Capture may already have been released.
    }
  }

  return (
    <div className="array-preview-wrap">
      <svg
        className="array-preview"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Plan view of the array layout for ${site.name}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <pattern id="preview-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0H0V24" fill="none" stroke="var(--canvas-grid-line)" strokeWidth="1" />
          </pattern>
        </defs>

        <rect
          className="array-preview__backdrop"
          width={VIEW_WIDTH}
          height={VIEW_HEIGHT}
          fill="var(--canvas-schematic)"
        />
        <rect
          className="array-preview__grid"
          width={VIEW_WIDTH}
          height={VIEW_HEIGHT}
          fill="url(#preview-grid)"
        />

        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          <polygon
            points={boundaryPath}
            fill="none"
            stroke="var(--outline-variant)"
            strokeWidth="1.4"
            strokeDasharray="4 3"
          />

          <g>
            {layout.stripsLocal.map((corners, index) => (
              <polygon
                key={index}
                points={corners
                  .map(project)
                  .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
                  .join(" ")}
                fill={mount === "dual_axis" ? "#243d48" : "#2a4650"}
                stroke="var(--secondary)"
                strokeWidth="0.8"
              />
            ))}
          </g>
        </g>

        <g transform={`translate(${VIEW_WIDTH - 56} 46)`}>
          <path
            d="M0 14 L0 -14 M0 -14 L-5 -6 M0 -14 L5 -6"
            stroke="var(--on-surface-variant)"
            strokeWidth="1.4"
            fill="none"
          />
          <text y="26" textAnchor="middle" fontSize="10" fill="var(--on-surface-variant)">
            N
          </text>
        </g>

        <g transform={`translate(${MARGIN} ${VIEW_HEIGHT - 36})`}>
          <line
            x1="0"
            y1="0"
            x2={100 * fitScale * view.scale}
            y2="0"
            stroke="var(--on-surface-variant)"
            strokeWidth="1.5"
          />
          <text
            x={(100 * fitScale * view.scale) / 2}
            y="-5"
            textAnchor="middle"
            fontSize="10"
            fill="var(--on-surface-variant)"
          >
            100 m
          </text>
        </g>

        <text x={MARGIN} y="28" fontSize="11" fill="var(--outline)" fontFamily="var(--font-mono)">
          Pitch {layout.pitchM.toFixed(2)} m · gap {layout.gapM.toFixed(2)} m
          {mount === "dual_axis" ? " · dual-axis footprints" : ""} · scroll to zoom, drag to pan
        </text>
      </svg>
      {layout.truncated && (
        <p className="array-preview__banner array-preview__banner--footer">
          Viewport shows {layout.maxStrips.toLocaleString()} of the row strips for performance —
          packing fill and module count still use the full site. HTML export includes the complete
          schematic.
        </p>
      )}
    </div>
  );
}

/**
 * Full (uncapped) schematic SVG markup for HTML export.
 *
 * Returned as inline SVG (not a data: URL) — large arrays exceed practical
 * data-URL length limits and silently disappear in WebKit exports.
 */
export function buildFullSchematicSvg(options: {
  site: Site;
  module: ModuleSpec;
  tiltDegrees: number;
  gcr: number;
  azimuth: number;
  mount?: MountType;
}): string | null {
  const layout = computeArrayStrips({ ...options, maxStrips: Number.POSITIVE_INFINITY });
  if (!layout || !options.site.ring) return null;

  const { polygon } = ringToLocalFrame(options.site.ring);
  const bounds = polygonBounds2D(polygon);
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  const fitScale = Math.min((VIEW_WIDTH - MARGIN * 2) / spanX, (VIEW_HEIGHT - MARGIN * 2) / spanY);
  const project = (point: Point2D): [number, number] => [
    MARGIN + (point.x - bounds.minX) * fitScale,
    VIEW_HEIGHT - MARGIN - (point.y - bounds.minY) * fitScale,
  ];
  const boundary = polygon.map(project).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const fill = options.mount === "dual_axis" ? "#243d48" : "#2a4650";
  // Prefer compact path groups over thousands of separate polygon tags.
  const stripPaths = layout.stripsLocal
    .map((corners) => {
      const pts = corners.map(project);
      if (pts.length === 0) return "";
      const [first, ...rest] = pts;
      if (!first) return "";
      return (
        `M${first[0].toFixed(1)} ${first[1].toFixed(1)}` +
        rest.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join("") +
        "Z"
      );
    })
    .filter(Boolean)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" width="100%" role="img" aria-label="Array schematic">
  <rect width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" fill="#131009"/>
  <polygon points="${boundary}" fill="none" stroke="#4f4536" stroke-width="1.4" stroke-dasharray="4 3"/>
  <path d="${stripPaths}" fill="${fill}" stroke="#96cfe2" stroke-width="0.5"/>
  <text x="${MARGIN}" y="28" font-size="11" fill="#9c8f7d" font-family="IBM Plex Mono,monospace">Pitch ${layout.pitchM.toFixed(2)} m · ${layout.stripCount.toLocaleString()} strips</text>
</svg>`;
}

/** @deprecated Prefer buildFullSchematicSvg + inline HTML embed. */
export function buildFullSchematicSvgDataUrl(options: {
  site: Site;
  module: ModuleSpec;
  tiltDegrees: number;
  gcr: number;
  azimuth: number;
  mount?: MountType;
}): string | null {
  const svg = buildFullSchematicSvg(options);
  if (!svg) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
