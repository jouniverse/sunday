/**
 * Control primitives.
 *
 * Hand-written rather than pulled from a component kit: the project brief asks
 * for a stylised engineering tool, and a stock kit's visual defaults fight the
 * flat-technical language at every turn.
 */

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { ChevronDownIcon, MinusIcon, PlusIcon, SearchIcon } from "./icons";
import "./controls.css";

function classes(...values: Array<string | false | undefined | null>): string {
  return values.filter(Boolean).join(" ");
}

/* --- Button --------------------------------------------------------------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  size?: "md" | "sm";
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  block,
  size = "md",
  icon,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes(
        "ds-button",
        `ds-button--${variant}`,
        block && "ds-button--block",
        size === "sm" && "ds-button--sm",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/* --- Icon button ---------------------------------------------------------- */

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control needs an accessible name. */
  label: string;
  active?: boolean;
  size?: "md" | "sm";
}

export function IconButton({
  label,
  active,
  size = "md",
  children,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={classes(
        "ds-icon-button",
        active && "ds-icon-button--active",
        size === "sm" && "ds-icon-button--sm",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* --- Field wrapper -------------------------------------------------------- */

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className="ds-field">
      <span className="ds-field__label">{label}</span>
      {children}
      {error ? (
        <span className="ds-field__error">{error}</span>
      ) : hint ? (
        <span className="ds-field__hint">{hint}</span>
      ) : null}
    </label>
  );
}

/* --- Input and select ----------------------------------------------------- */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

export function Input({ mono, invalid, className, ...rest }: InputProps) {
  return (
    <input
      className={classes(
        "ds-input",
        mono && "ds-input--mono",
        invalid && "ds-input--invalid",
        className,
      )}
      aria-invalid={invalid}
      {...rest}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string; disabled?: boolean }>;
}

export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <select className={classes("ds-select", className)} {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* --- Search --------------------------------------------------------------- */

export interface SearchBoxProps extends InputHTMLAttributes<HTMLInputElement> {
  width?: number | string;
}

export function SearchBox({ width, className, ...rest }: SearchBoxProps) {
  return (
    <div
      className={classes("ds-search", className)}
      style={width === undefined ? undefined : { flex: `0 0 ${typeof width === "number" ? `${width}px` : width}` }}
    >
      <SearchIcon size={13} />
      <input type="search" {...rest} />
    </div>
  );
}

/* --- Switch --------------------------------------------------------------- */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={classes("ds-switch", checked && "ds-switch--on")}
      onClick={() => onChange(!checked)}
    >
      <span className="ds-switch__knob" />
    </button>
  );
}

/* --- Chip ----------------------------------------------------------------- */

export type ChipTone = "neutral" | "ok" | "warning" | "error";

export interface ChipProps {
  children: ReactNode;
  tone?: ChipTone;
  dot?: boolean;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
}

export function Chip({ children, tone = "neutral", dot = true, selected, onClick, title }: ChipProps) {
  const className = classes(
    "ds-chip",
    tone !== "neutral" && `ds-chip--${tone}`,
    onClick && "ds-chip--interactive",
    selected && "ds-chip--selected",
  );
  const content = (
    <>
      {dot && <span className="ds-chip__dot" />}
      {children}
    </>
  );
  return onClick ? (
    <button type="button" className={className} onClick={onClick} title={title}>
      {content}
    </button>
  ) : (
    <span className={className} title={title}>
      {content}
    </span>
  );
}

/* --- Stepper -------------------------------------------------------------- */

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  step: number;
  min: number;
  max: number;
  unit?: string;
  /** Decimal places to display; also used to round away float drift. */
  precision?: number;
  label: string;
  disabled?: boolean;
}

export function Stepper({
  value,
  onChange,
  step,
  min,
  max,
  unit,
  precision = 0,
  label,
  disabled,
}: StepperProps) {
  const factor = 10 ** precision;
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next * factor) / factor));

  return (
    <div className="ds-stepper" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - step))}
      >
        <MinusIcon size={13} />
      </button>
      <div className="ds-stepper__value">
        <span>{value.toFixed(precision)}</span>
        {unit && <span className="ds-stepper__unit">{unit}</span>}
      </div>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + step))}
      >
        <PlusIcon size={13} />
      </button>
    </div>
  );
}

/* --- Progress and spinner ------------------------------------------------- */

export interface ProgressProps {
  /** 0..1, or omitted for an indeterminate bar. */
  value?: number;
  label: string;
}

export function Progress({ value, label }: ProgressProps) {
  const determinate = typeof value === "number";
  return (
    <div
      className={classes("ds-progress", !determinate && "ds-progress--indeterminate")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
    >
      <div
        className="ds-progress__fill"
        style={determinate ? { width: `${Math.min(100, Math.max(0, value * 100))}%` } : undefined}
      />
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return <span className="ds-spinner" role="status" aria-label={label} />;
}

/* --- Disclosure ----------------------------------------------------------- */

export interface DisclosureProps {
  open: boolean;
  onToggle: () => void;
  label: string;
}

/** Chevron toggle used by collapsible panel sections. */
export function Disclosure({ open, onToggle, label }: DisclosureProps) {
  return (
    <IconButton label={label} size="sm" onClick={onToggle} aria-expanded={open}>
      <ChevronDownIcon
        size={14}
        style={{
          transform: open ? "rotate(0deg)" : "rotate(-90deg)",
          transition: "transform var(--motion-fast) var(--easing)",
        }}
      />
    </IconButton>
  );
}
