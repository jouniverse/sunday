/**
 * Monthly irradiation profile, one line per source.
 *
 * Hand-drawn SVG rather than a charting library: this is a dozen points per
 * series, the design system has strong opinions a library would fight, and a
 * chart library is a large dependency for a line and twelve ticks.
 */

import { useId } from "react";
import type { ResourceReport } from "@/services/solar/types";
import { PROVIDERS } from "@/services/solar/types";
import { formatNumber } from "@/domain/units";

const MONTH_LABELS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** Assigned in order so the same source keeps its colour across renders. */
const SERIES_COLOURS = ["#f7bf59", "#96cfe2", "#a7caff", "#e8a33d"];

const WIDTH = 760;
const HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 28, left: 44 };

export function MonthlyChart({ reports }: { reports: ResourceReport[] }) {
  const clipId = useId();
  const series = reports
    .map((report, index) => ({
      provider: report.provider,
      label: PROVIDERS[report.provider].label,
      colour: SERIES_COLOURS[index % SERIES_COLOURS.length] as string,
      points: report.monthlyGhi ?? [],
    }))
    .filter((entry) => entry.points.length > 0);

  if (series.length === 0) return null;

  const maxValue = Math.max(
    ...series.flatMap((entry) => entry.points.map((point) => point.value)),
  );
  // Round the axis up to a clean step so the gridlines read sensibly.
  const step = niceStep(maxValue / 4);
  const axisMax = Math.ceil(maxValue / step) * step;

  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const x = (month: number) => PADDING.left + ((month - 1) / 11) * plotWidth;
  const y = (value: number) => PADDING.top + plotHeight - (value / axisMax) * plotHeight;

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">Monthly irradiation</h2>
        <div className="chart__legend">
          {series.map((entry) => (
            <span key={entry.provider} className="chart__legend-item">
              <span className="chart__swatch" style={{ background: entry.colour }} />
              {entry.label}
            </span>
          ))}
        </div>
      </div>

      <svg
        className="chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Monthly global horizontal irradiation by source"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PADDING.left} y={PADDING.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>

        {/* Gridlines and y axis */}
        {Array.from({ length: 5 }, (_, index) => {
          const value = (axisMax / 4) * index;
          return (
            <g key={value}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--outline-variant)"
                strokeWidth="1"
                opacity={index === 0 ? 1 : 0.45}
              />
              <text
                x={PADDING.left - 8}
                y={y(value) + 3}
                textAnchor="end"
                fontSize="10"
                fontFamily="var(--font-mono)"
                fill="var(--outline)"
              >
                {formatNumber(value, 0)}
              </text>
            </g>
          );
        })}

        {/* Month ticks */}
        {MONTH_LABELS.map((label, index) => (
          <text
            key={`${label}-${index}`}
            x={x(index + 1)}
            y={HEIGHT - 10}
            textAnchor="middle"
            fontSize="10"
            fill="var(--outline)"
          >
            {label}
          </text>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {series.map((entry) => (
            <g key={entry.provider}>
              <polyline
                points={entry.points.map((point) => `${x(point.month)},${y(point.value)}`).join(" ")}
                fill="none"
                stroke={entry.colour}
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              {entry.points.map((point) => (
                <circle
                  key={point.month}
                  cx={x(point.month)}
                  cy={y(point.value)}
                  r="2.5"
                  fill={entry.colour}
                >
                  <title>{`${entry.label}, month ${point.month}: ${formatNumber(point.value, 0)} kWh/m²`}</title>
                </circle>
              ))}
            </g>
          ))}
        </g>
      </svg>
      <p className="report__units">Monthly global horizontal irradiation, kWh/m² per month.</p>
    </div>
  );
}

/** Rounds an axis step to 1, 2 or 5 times a power of ten. */
function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}
