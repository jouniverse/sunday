/**
 * Generic monthly line chart for climatology series (GHI, tilt, temperature).
 *
 * Hand-drawn SVG rather than a charting library: a dozen points per series, and
 * the design system has strong opinions a library would fight.
 */

import { useId } from "react";
import type { MonthlyValue, ResourceReport, SolarProvider } from "@/services/solar/types";
import { PROVIDERS } from "@/services/solar/types";
import { formatNumber } from "@/domain/units";

const MONTH_LABELS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const SERIES_COLOURS = ["#f7bf59", "#96cfe2", "#a7caff", "#e8a33d"];

const WIDTH = 760;
const HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 28, left: 44 };

export function MonthlySeriesChart({
  title,
  ariaLabel,
  unitLabel,
  reports,
  select,
  valueDigits = 0,
}: {
  title: string;
  ariaLabel: string;
  unitLabel: string;
  reports: ResourceReport[];
  select: (report: ResourceReport) => MonthlyValue[] | undefined;
  valueDigits?: number;
}) {
  const clipId = useId();
  const series = reports
    .map((report, index) => ({
      provider: report.provider as SolarProvider,
      label: PROVIDERS[report.provider].label,
      colour: SERIES_COLOURS[index % SERIES_COLOURS.length] as string,
      points: climatologyPoints(select(report) ?? []),
    }))
    .filter((entry) => entry.points.length > 0);

  if (series.length === 0) return null;

  const values = series.flatMap((entry) => entry.points.map((point) => point.value));
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

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">{title}</h2>
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
        aria-label={ariaLabel}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PADDING.left} y={PADDING.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>

        {Array.from({ length: 5 }, (_, index) => {
          const value = axisMin + (axisSpan / 4) * index;
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
                {formatNumber(value, valueDigits)}
              </text>
            </g>
          );
        })}

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
                  <title>
                    {`${entry.label}, month ${point.month}: ${formatNumber(point.value, valueDigits)} ${unitLabel}`}
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </g>
      </svg>
      <p className="report__units">{unitLabel}</p>
    </div>
  );
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
