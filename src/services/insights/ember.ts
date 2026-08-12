/**
 * Ember Energy API client for Insights electricity indicators.
 *
 * Free API key required. Offline / missing key → callers use OWID bundles.
 */

import { platform } from "@/core/platform";
import type { InsightObservation } from "@/domain/insights/types";

const BASE = "https://api.ember-energy.org/v1";

export interface EmberYearlyRow {
  entity_code?: string;
  entity?: string;
  date?: string | number;
  generation_twh?: number;
  share_of_generation_pct?: number;
  series?: string;
  is_aggregate_entity?: boolean;
}

export async function fetchEmberSolarYearly(
  apiKey: string,
  options: { entityCode?: string; startDate?: string } = {},
): Promise<InsightObservation[]> {
  const params = new URLSearchParams({
    series: "Solar",
    is_aggregate_series: "false",
    api_key: apiKey,
    start_date: options.startDate ?? "2000",
  });
  if (options.entityCode) params.set("entity_code", options.entityCode);

  const url = `${BASE}/electricity-generation/yearly?${params.toString()}`;
  const response = await platform().http.fetchText({ url, timeoutMs: 60_000 });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Ember API ${response.status}: ${response.body?.slice(0, 200) ?? "request failed"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("Ember API returned non-JSON");
  }

  const rows = extractRows(parsed);
  const observations: InsightObservation[] = [];
  for (const row of rows) {
    const iso3 = String(row.entity_code ?? "")
      .trim()
      .toUpperCase();
    const date = String(row.date ?? "").trim();
    if (!iso3 || !date) continue;
    const isAggregate = Boolean(row.is_aggregate_entity) || iso3.length !== 3;
    if (row.generation_twh !== undefined && Number.isFinite(row.generation_twh)) {
      observations.push({
        indicatorId: "solar_generation_twh",
        entityIso3: iso3,
        entityName: row.entity,
        date,
        value: row.generation_twh,
        unit: "TWh",
        method: "Ember yearly electricity-generation series=Solar",
        source: "Ember",
        vintage: date,
        license: "Ember open data terms",
        isAggregate,
      });
    }
    if (row.share_of_generation_pct !== undefined && Number.isFinite(row.share_of_generation_pct)) {
      observations.push({
        indicatorId: "solar_electricity_share",
        entityIso3: iso3,
        entityName: row.entity,
        date,
        value: row.share_of_generation_pct,
        unit: "%",
        method: "Ember yearly share_of_generation_pct series=Solar",
        source: "Ember",
        vintage: date,
        license: "Ember open data terms",
        isAggregate,
      });
    }
  }
  return observations;
}

/** Power-sector emissions yearly for one entity (series=Solar). */
export async function fetchEmberSolarEmissionsYearly(
  apiKey: string,
  entityCode: string,
): Promise<InsightObservation[]> {
  const params = new URLSearchParams({
    series: "Solar",
    entity_code: entityCode,
    is_aggregate_series: "false",
    api_key: apiKey,
    start_date: "2000",
  });
  const url = `${BASE}/power-sector-emissions/yearly?${params.toString()}`;
  const response = await platform().http.fetchText({ url, timeoutMs: 30_000 });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Ember emissions ${response.status}: ${response.body?.slice(0, 200) ?? "request failed"}`,
    );
  }
  const parsed = JSON.parse(response.body) as unknown;
  const rows = extractRows(parsed) as Array<
    EmberYearlyRow & { emissions_mtco2?: number; share_of_emissions_pct?: number }
  >;
  const observations: InsightObservation[] = [];
  for (const row of rows) {
    const iso3 = String(row.entity_code ?? "")
      .trim()
      .toUpperCase();
    const date = String(row.date ?? "").trim();
    if (!iso3 || !date) continue;
    if (row.emissions_mtco2 !== undefined && Number.isFinite(row.emissions_mtco2)) {
      observations.push({
        indicatorId: "ember_solar_emissions_mtco2",
        entityIso3: iso3,
        entityName: row.entity,
        date,
        value: row.emissions_mtco2,
        unit: "MtCO₂",
        method: "Ember power-sector-emissions yearly series=Solar",
        source: "Ember",
        vintage: date,
        license: "CC BY 4.0 (Ember)",
      });
    }
  }
  return observations;
}

/** Monthly solar generation for the latest available year for one entity. */
export async function fetchEmberSolarMonthlyLastYear(
  apiKey: string,
  entityCode: string,
): Promise<InsightObservation[]> {
  const params = new URLSearchParams({
    series: "Solar",
    entity_code: entityCode,
    is_aggregate_series: "false",
    api_key: apiKey,
    start_date: "2024-01",
  });
  const url = `${BASE}/electricity-generation/monthly?${params.toString()}`;
  const response = await platform().http.fetchText({ url, timeoutMs: 30_000 });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Ember monthly ${response.status}: ${response.body?.slice(0, 200) ?? "request failed"}`,
    );
  }
  const parsed = JSON.parse(response.body) as unknown;
  const rows = extractRows(parsed);
  return rows
    .filter((row) => row.generation_twh !== undefined && Number.isFinite(row.generation_twh))
    .map((row) => ({
      indicatorId: "solar_generation_twh_monthly",
      entityIso3: String(row.entity_code ?? entityCode).toUpperCase(),
      entityName: row.entity,
      date: String(row.date ?? "").slice(0, 7),
      value: row.generation_twh as number,
      unit: "TWh",
      method: "Ember monthly electricity-generation series=Solar",
      source: "Ember",
      vintage: String(row.date ?? ""),
      license: "CC BY 4.0 (Ember)",
    }));
}

function extractRows(parsed: unknown): EmberYearlyRow[] {
  if (Array.isArray(parsed)) return parsed as EmberYearlyRow[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as EmberYearlyRow[];
    if (Array.isArray(obj.results)) return obj.results as EmberYearlyRow[];
  }
  return [];
}
