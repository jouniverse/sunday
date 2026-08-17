/**
 * Cartesian sun-path diagram for the site Report.
 *
 * Solstice/equinox envelope from pvlib SPA. Optional Terrarium far-field
 * horizon overlay. Not a near-field shade study.
 */

import type { HorizonProfile } from "@/domain/siting/horizon";
import { sunPathTraceKind } from "@/domain/siting/horizon";
import type { SunPathResult } from "@/services/engine/client";

const WIDTH = 760;
const HEIGHT = 280;
const PADDING = { top: 16, right: 16, bottom: 32, left: 44 };

const KIND_COLOUR = {
  high: "#f7bf59",
  equinox: "#96cfe2",
  low: "#a7caff",
} as const;

const KIND_LABEL = {
  high: "High sun",
  equinox: "Equinox",
  low: "Low sun",
} as const;

export function SunPathChart({
  sunPath,
  latitude,
  horizon,
  engineError,
}: {
  sunPath: SunPathResult | null;
  latitude: number;
  horizon: HorizonProfile | null;
  engineError: string | null;
}) {
  if (engineError && !sunPath) {
    return (
      <div className="card">
        <div className="card__head">
          <h2 className="card__title">Sun path</h2>
        </div>
        <p className="report__intro">{engineError} The irradiation charts above do not need the engine.</p>
      </div>
    );
  }
  if (!sunPath) return null;

  const traces = sunPath.traces
    .map((trace) => {
      const kind = sunPathTraceKind(trace.date, latitude);
      const points = trace.points
        .filter((point) => point.elevation > 0)
        .map((point) => ({
          azimuth: point.azimuth,
          elevation: point.elevation,
          hour: localHour(point.time),
        }));
      return {
        kind,
        key: trace.date,
        label: `${KIND_LABEL[kind]} (${trace.date.slice(5)})`,
        colour: KIND_COLOUR[kind],
        points,
      };
    })
    .filter((trace) => trace.points.length > 2);
  if (traces.length === 0) return null;

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (azimuth: number) => PADDING.left + (azimuth / 360) * plotWidth;
  const y = (elevation: number) =>
    PADDING.top + plotHeight - (Math.max(0, Math.min(90, elevation)) / 90) * plotHeight;

  const horizonSamples = [...(horizon?.samples ?? [])].sort((a, b) => a.azimuth - b.azimuth);
  const horizonPoints =
    horizonSamples.length >= 3
      ? `${horizonSamples.map((sample) => `${x(sample.azimuth)},${y(sample.elevationDegrees)}`).join(" ")} ${x(360)},${y(0)} ${x(0)},${y(0)}`
      : "";

  const methodBits = [sunPath.method.solar_position, sunPath.method.weather].filter(Boolean).join("; ");
  const horizonNote = horizon?.method
    ? ` Horizon: ${horizon.method}.`
    : " Far-field terrain horizon unavailable in this session (desktop Terrarium).";

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">Sun path</h2>
        <div className="chart__legend">
          {uniqueKinds(traces).map((trace) => (
            <span key={trace.kind} className="chart__legend-item">
              <span className="chart__swatch" style={{ background: trace.colour }} />
              {trace.label}
            </span>
          ))}
          {horizonPoints ? (
            <span className="chart__legend-item">
              <span className="chart__swatch" style={{ background: "rgba(156,143,125,0.6)" }} />
              Terrarium horizon
            </span>
          ) : null}
        </div>
      </div>
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Sun path diagram">
        {[0, 15, 30, 45, 60, 75, 90].map((el) => (
          <g key={el}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={y(el)}
              y2={y(el)}
              stroke="var(--outline-variant)"
              strokeWidth="1"
              opacity={el === 0 ? 1 : 0.45}
            />
            <text
              x={PADDING.left - 8}
              y={y(el) + 3}
              textAnchor="end"
              fontSize="10"
              fontFamily="var(--font-mono)"
              fill="var(--outline)"
            >
              {el}°
            </text>
          </g>
        ))}
        {[0, 90, 180, 270, 360].map((az) => (
          <g key={az}>
            <line
              x1={x(az)}
              x2={x(az)}
              y1={PADDING.top}
              y2={HEIGHT - PADDING.bottom}
              stroke="var(--outline-variant)"
              strokeWidth="1"
              opacity="0.35"
            />
            <text x={x(az)} y={HEIGHT - 10} textAnchor="middle" fontSize="10" fill="var(--outline)">
              {azimuthLabel(az)}
            </text>
          </g>
        ))}
        {horizonPoints ? (
          <polygon
            points={horizonPoints}
            fill="rgba(156,143,125,0.28)"
            stroke="var(--outline)"
            strokeWidth="1"
          />
        ) : null}
        {traces.map((trace) =>
          splitAzimuthWrap(trace.points).map((segment, index) => (
            <polyline
              key={`${trace.key}-${index}`}
              points={segment.map((point) => `${x(point.azimuth)},${y(point.elevation)}`).join(" ")}
              fill="none"
              stroke={trace.colour}
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          )),
        )}
        {traces.flatMap((trace) =>
          hourMarks(trace.points).map((mark) => (
            <text
              key={`${trace.key}-h${mark.hour}`}
              x={x(mark.azimuth)}
              y={y(mark.elevation) - 4}
              textAnchor="middle"
              fontSize="9"
              fill={trace.colour}
            >
              {mark.hour}
            </text>
          )),
        )}
      </svg>
      <p className="report__units">
        {methodBits}. {horizonNote} Cartesian azimuth × elevation; solstice/equinox envelope. Does
        not include trees or buildings. Yield models are unchanged.
      </p>
    </div>
  );
}

function uniqueKinds<T extends { kind: string }>(traces: T[]): T[] {
  return traces.filter((trace, index, all) => all.findIndex((entry) => entry.kind === trace.kind) === index);
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
  points: Array<{ azimuth: number; elevation: number }>,
): Array<Array<{ azimuth: number; elevation: number }>> {
  const segments: Array<Array<{ azimuth: number; elevation: number }>> = [];
  let current: Array<{ azimuth: number; elevation: number }> = [];
  for (const point of points) {
    const last = current[current.length - 1];
    if (last && Math.abs(point.azimuth - last.azimuth) > 180) {
      segments.push(current);
      current = [];
    }
    current.push(point);
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
