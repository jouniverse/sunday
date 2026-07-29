/**
 * Data-display primitives.
 *
 * Two of these encode project-wide requirements rather than just visuals:
 * `ProvenanceBadge`, because every figure must declare its fidelity and vintage,
 * and `EnvelopeSlider`, because automation must present a range the designer can
 * move within rather than a single opaque answer.
 */

import type { ReactNode } from "react";
import { InfoIcon, WarningIcon } from "./icons";
import "./data.css";

function classes(...values: Array<string | false | undefined | null>): string {
  return values.filter(Boolean).join(" ");
}

/* --- Parameter list ------------------------------------------------------- */

export type ValueTone = "default" | "accent" | "solar" | "muted";

export interface ParamRow {
  key: string;
  label: ReactNode;
  value: ReactNode;
  tone?: ValueTone;
  title?: string;
}

export function ParamList({ rows }: { rows: ParamRow[] }) {
  return (
    <div className="ds-params">
      {rows.map((row) => (
        <div className="ds-params__row" key={row.key} title={row.title}>
          <span className="ds-params__key">{row.label}</span>
          <span
            className={classes(
              "ds-params__value",
              row.tone && row.tone !== "default" && `ds-params__value--${row.tone}`,
            )}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* --- Stats ---------------------------------------------------------------- */

export interface StatProps {
  label: string;
  value: string;
  unit?: string;
  tone?: "default" | "accent" | "solar";
}

export function Stat({ label, value, unit, tone = "default" }: StatProps) {
  return (
    <div className={classes("ds-stat", tone !== "default" && `ds-stat--${tone}`)}>
      <span className="ds-stat__label">{label}</span>
      <span className="ds-stat__value">
        {value}
        {unit && <span className="ds-stat__unit">{unit}</span>}
      </span>
    </div>
  );
}

export function StatCluster({ children }: { children: ReactNode }) {
  return <div className="ds-stats">{children}</div>;
}

/* --- Data grid ------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  header: string;
  numeric?: boolean;
  render: (row: T) => ReactNode;
}

export interface DataGridProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  caption: string;
}

export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  caption,
}: DataGridProps<T>) {
  return (
    <table className={classes("ds-grid", onRowClick && "ds-grid--clickable")}>
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} className={column.numeric ? "num" : undefined} scope="col">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <tr
              key={key}
              aria-selected={selectedKey === key}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? "num" : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* --- Provenance ----------------------------------------------------------- */

/**
 * How much a number can be trusted.
 *
 * `measured` is instrument data, `modelled` is a physical model over real
 * weather, `estimated` is an inference such as imagery-derived capacity. The
 * dataset review requires this distinction to be visible wherever a figure is.
 */
export type Fidelity = "measured" | "modelled" | "estimated" | "unknown";

export interface ProvenanceBadgeProps {
  fidelity: Fidelity;
  source: string;
  vintage?: string;
  method?: string;
}

export function ProvenanceBadge({ fidelity, source, vintage, method }: ProvenanceBadgeProps) {
  const title = [
    `Source: ${source}`,
    vintage ? `Vintage: ${vintage}` : null,
    method ? `Method: ${method}` : null,
    `Fidelity: ${fidelity}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className="ds-provenance" title={title}>
      <span className={`ds-provenance__dot ds-provenance__dot--${fidelity}`} />
      {source}
      {vintage && ` · ${vintage}`}
    </span>
  );
}

/* --- Envelope slider ------------------------------------------------------ */

export interface EnvelopeSliderProps {
  value: number;
  onChange: (value: number) => void;
  /** Hard feasible bounds. The user cannot leave these. */
  min: number;
  max: number;
  /** Recommended band from automation. The user may leave this. */
  recommendedMin: number;
  recommendedMax: number;
  step: number;
  unit: string;
  label: string;
  precision?: number;
  /** Shown when the value sits outside the recommended band. */
  outsideNote?: string;
  disabled?: boolean;
}

export function EnvelopeSlider({
  value,
  onChange,
  min,
  max,
  recommendedMin,
  recommendedMax,
  step,
  unit,
  label,
  precision = 0,
  outsideNote,
  disabled,
}: EnvelopeSliderProps) {
  const span = max - min || 1;
  const percent = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / span) * 100;
  const within = value >= recommendedMin && value <= recommendedMax;
  const format = (v: number) => `${v.toFixed(precision)}${unit}`;

  return (
    <div>
      <div className="ds-envelope">
        <div className="ds-envelope__track" />
        <div
          className="ds-envelope__band"
          style={{
            left: `${percent(recommendedMin)}%`,
            width: `${percent(recommendedMax) - percent(recommendedMin)}%`,
          }}
          title={`Recommended ${format(recommendedMin)} to ${format(recommendedMax)}`}
        />
        <input
          className="ds-envelope__input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={format(value)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      <div className="ds-envelope__labels">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
      <div className={classes("ds-envelope__note", !within && "ds-envelope__note--outside")}>
        <span className="ds-envelope__note-dot" />
        {within
          ? `Within recommended envelope (${format(recommendedMin)}–${format(recommendedMax)})`
          : (outsideNote ??
            `Outside recommended envelope (${format(recommendedMin)}–${format(recommendedMax)}) — feasible, but reduces yield`)}
      </div>
    </div>
  );
}

/* --- Meter ---------------------------------------------------------------- */

export interface MeterProps {
  value: number;
  max: number;
  /** Optional recommended band, drawn behind the fill. */
  bandMin?: number;
  bandMax?: number;
  label: string;
}

export function Meter({ value, max, bandMin, bandMax, label }: MeterProps) {
  const scale = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  return (
    <div
      className="ds-meter"
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      {bandMin !== undefined && bandMax !== undefined && (
        <div
          className="ds-meter__band"
          style={{
            left: scale(bandMin),
            width: `calc(${scale(bandMax)} - ${scale(bandMin)})`,
          }}
        />
      )}
      <div className="ds-meter__fill" style={{ width: scale(value) }} />
    </div>
  );
}

/* --- Callout -------------------------------------------------------------- */

export type CalloutTone = "info" | "warning" | "error" | "note";

export function Callout({
  tone = "info",
  children,
  showIcon = true,
}: {
  tone?: CalloutTone;
  children: ReactNode;
  showIcon?: boolean;
}) {
  return (
    <div className={`ds-callout ds-callout--${tone}`} role={tone === "error" ? "alert" : undefined}>
      {showIcon && (
        <span className="ds-callout__icon">
          {tone === "warning" || tone === "error" ? <WarningIcon size={13} /> : <InfoIcon size={13} />}
        </span>
      )}
      <div>{children}</div>
    </div>
  );
}

/* --- Empty state ---------------------------------------------------------- */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}

/**
 * Empty states always say what to do next. A blank panel in a professional tool
 * reads as a bug, not as an absence of data.
 */
export function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="ds-empty">
      {icon && <span className="ds-empty__icon">{icon}</span>}
      <span className="ds-empty__title">{title}</span>
      <p className="ds-empty__body">{body}</p>
      {action}
    </div>
  );
}

/* --- Section label -------------------------------------------------------- */

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ds-section__label">
      <span>{children}</span>
      {action}
    </div>
  );
}
