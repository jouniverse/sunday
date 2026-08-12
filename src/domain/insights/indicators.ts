import type { IndicatorMeta, InsightObservation } from "./types";

export const INSIGHT_INDICATORS: IndicatorMeta[] = [
  {
    id: "irena_capacity_gw",
    label: "Installed solar capacity",
    unit: "GW",
    primarySource: "IRENA",
    description: "Official electrical capacity of solar (utility + distributed aggregates).",
  },
  {
    id: "owid_primary_energy_share",
    label: "Share of primary energy from solar",
    unit: "%",
    primarySource: "Our World in Data",
    description: "Solar as a share of primary energy (EI / Smil / EIA via OWID).",
  },
  {
    id: "solar_generation_twh",
    label: "Electricity generation from solar",
    unit: "TWh",
    primarySource: "Ember",
    description: "Annual solar electricity generation. Ember live; OWID offline fallback.",
  },
  {
    id: "solar_electricity_share",
    label: "Share of electricity from solar",
    unit: "%",
    primarySource: "Ember",
    description: "Solar share of electricity generation. Ember live; OWID offline fallback.",
  },
];

export function indicatorById(id: string): IndicatorMeta | undefined {
  return INSIGHT_INDICATORS.find((row) => row.id === id);
}

/** Latest observation per entity (by date string, lexicographic years work). */
export function latestByEntity(rows: InsightObservation[]): InsightObservation[] {
  const best = new Map<string, InsightObservation>();
  for (const row of rows) {
    const prev = best.get(row.entityIso3);
    if (!prev || row.date >= prev.date) best.set(row.entityIso3, row);
  }
  return [...best.values()];
}

export function seriesForEntity(rows: InsightObservation[], iso3: string): InsightObservation[] {
  return rows
    .filter((row) => row.entityIso3.toUpperCase() === iso3.toUpperCase())
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Flag capacity disagreement when both official (IRENA) and inventory (GEM)
 * figures exist. Returns relative spread or null when either side is missing.
 */
export function capacityDisagreementPct(
  irenaGw: number | undefined,
  gemOperatingGw: number | undefined,
): number | null {
  if (irenaGw === undefined || gemOperatingGw === undefined) return null;
  if (irenaGw <= 0 && gemOperatingGw <= 0) return null;
  const denom = Math.max(irenaGw, gemOperatingGw, 1e-9);
  return (Math.abs(irenaGw - gemOperatingGw) / denom) * 100;
}
