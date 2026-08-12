/**
 * Shared observation shape for Insights statistics and portfolio country cards.
 *
 * Pure domain — no React, no platform I/O.
 */

export interface InsightObservation {
  indicatorId: string;
  entityIso3: string;
  /** ISO date or year string (e.g. "2023"). */
  date: string;
  value: number;
  unit: string;
  method: string;
  source: string;
  vintage: string;
  license: string;
  /** True for World / region aggregates rather than Admin-0 countries. */
  isAggregate?: boolean;
  entityName?: string;
}

export interface IndicatorMeta {
  id: string;
  label: string;
  unit: string;
  /** Primary producer for this indicator. */
  primarySource: string;
  description: string;
}
