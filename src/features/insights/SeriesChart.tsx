/**
 * Minimal SVG line chart for Insights time series (no chart library).
 * `hero` matches Report MonthlySeriesChart proportions (font 10, stroke 1.8).
 * `compact` is for nested Statistics half-width charts.
 */

export interface SeriesPoint {
  date: string;
  value: number;
}

export function SeriesChart({
  points,
  unit,
  showMean = true,
  variant = "compact",
  xTicks = "ends",
}: {
  points: SeriesPoint[];
  unit: string;
  showMean?: boolean;
  /** Full-width Rankings / selected-series charts use Report-like geometry. */
  variant?: "hero" | "compact";
  /** Monthly profiles (Rankings) label every point; yearly series use ends only. */
  xTicks?: "ends" | "all";
}) {
  if (points.length === 0) {
    return <p className="insights__lede">No time series for this selection.</p>;
  }

  const hero = variant === "hero";
  // Report MonthlySeriesChart: 760×220, pad {16,16,28,44}, stroke 1.8, font 10.
  const width = hero ? 760 : 720;
  const height = hero ? 220 : 200;
  const pad = hero
    ? { top: 16, right: 16, bottom: 28, left: 44 }
    : { top: 14, right: 12, bottom: 30, left: 48 };
  const strokeW = hero ? 1.8 : 1.6;
  const pointR = hero ? 2.5 : 2;
  const tickFont = 10;

  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const span = max - min || 1;

  const yAt = (value: number) => pad.top + innerH - ((value - min) / span) * innerH;

  const coords = points.map((p, i) => {
    const x = pad.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    return { x, y: yAt(p.value), ...p };
  });

  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`).join(" ");
  const meanY = yAt(mean);

  return (
    <div className={`insights__series-wrap${hero ? " insights__series-wrap--hero" : ""}`}>
      <svg
        className={`insights__series${hero ? " insights__series--hero" : ""}`}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        <title>
          Time series ({unit}): min {min.toFixed(2)}, mean {mean.toFixed(2)}, max {max.toFixed(2)}
        </title>
        <line
          x1={pad.left}
          y1={pad.top}
          x2={pad.left}
          y2={pad.top + innerH}
          stroke="var(--outline-variant)"
          strokeWidth={1}
        />
        <line
          x1={pad.left}
          y1={pad.top + innerH}
          x2={pad.left + innerW}
          y2={pad.top + innerH}
          stroke="var(--outline-variant)"
          strokeWidth={1}
        />
        {showMean && (
          <>
            <line
              x1={pad.left}
              y1={meanY}
              x2={pad.left + innerW}
              y2={meanY}
              stroke="var(--outline)"
              strokeDasharray="5 4"
              strokeWidth={1.2}
            />
            <text
              x={pad.left + innerW - 4}
              y={meanY - 4}
              textAnchor="end"
              fontSize={tickFont}
              fontFamily="var(--font-mono)"
              fill="var(--outline)"
            >
              mean {mean.toFixed(2)}
              {unit ? ` ${unit}` : ""}
            </text>
          </>
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--secondary)"
          strokeWidth={strokeW}
          strokeLinejoin="round"
        />
        {coords.map((c) => (
          <circle key={c.date} cx={c.x} cy={c.y} r={pointR} fill="var(--secondary)" />
        ))}
        {xTicks === "all"
          ? coords.map((c) => (
              <text
                key={`tick-${c.date}`}
                x={c.x}
                y={height - 8}
                textAnchor="middle"
                fontSize={tickFont}
                fill="var(--outline)"
              >
                {shortMonthTick(c.date)}
              </text>
            ))
          : (
              <>
                <text
                  x={pad.left}
                  y={height - 8}
                  fontSize={tickFont}
                  fill="var(--outline)"
                >
                  {points[0]?.date ?? ""}
                </text>
                <text
                  x={width - pad.right}
                  y={height - 8}
                  textAnchor="end"
                  fontSize={tickFont}
                  fill="var(--outline)"
                >
                  {points[points.length - 1]?.date ?? ""}
                </text>
              </>
            )}
        <text
          x={pad.left - 8}
          y={pad.top + 4}
          textAnchor="end"
          fontSize={tickFont}
          fontFamily="var(--font-mono)"
          fill="var(--outline)"
        >
          {max.toFixed(1)}
        </text>
        <text
          x={pad.left - 8}
          y={pad.top + innerH}
          textAnchor="end"
          fontSize={tickFont}
          fontFamily="var(--font-mono)"
          fill="var(--outline)"
        >
          {min.toFixed(1)}
        </text>
      </svg>
      <p className="insights__series-stats">
        Min {min.toFixed(2)}
        {unit ? ` ${unit}` : ""} · Mean {mean.toFixed(2)}
        {unit ? ` ${unit}` : ""} · Max {max.toFixed(2)}
        {unit ? ` ${unit}` : ""}
      </p>
    </div>
  );
}

/** Report-style single-letter months when the label is a month name / abbr. */
function shortMonthTick(label: string): string {
  const trimmed = label.trim();
  const months: Record<string, string> = {
    jan: "J",
    january: "J",
    feb: "F",
    february: "F",
    mar: "M",
    march: "M",
    apr: "A",
    april: "A",
    may: "M",
    jun: "J",
    june: "J",
    jul: "J",
    july: "J",
    aug: "A",
    august: "A",
    sep: "S",
    sept: "S",
    september: "S",
    oct: "O",
    october: "O",
    nov: "N",
    november: "N",
    dec: "D",
    december: "D",
  };
  const key = trimmed.toLowerCase();
  if (months[key]) return months[key]!;
  // Percentile / other axis labels (Min, 10%, Avg, …) — keep as published.
  return trimmed;
}

/** Simple vertical bars for a small categorical series (e.g. employment by tech). */
export function BarChart({
  bars,
  unit,
}: {
  bars: Array<{ label: string; value: number }>;
  unit: string;
}) {
  if (!bars.length) return <p className="insights__lede">No values.</p>;
  const max = Math.max(...bars.map((b) => b.value), 1e-9);
  return (
    <div className="insights__bars" role="img" aria-label={`Bar chart (${unit})`}>
      {bars.map((bar) => (
        <div key={bar.label} className="insights__bar-row">
          <span className="insights__bar-label">{bar.label}</span>
          <div className="insights__bar-track">
            <div
              className="insights__bar-fill"
              style={{ width: `${Math.max(2, (bar.value / max) * 100)}%` }}
            />
          </div>
          <span className="insights__bar-value mono">
            {bar.value.toFixed(1)}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
