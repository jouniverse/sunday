/**
 * Resolves Insights Statistics observations for a selected indicator.
 * Bundled sources always; Ember when a key is provided for electricity metrics.
 *
 * World/regions scope uses OWID (and IRENA region/world) aggregates — Ember's
 * solar series is country-heavy and often returns no aggregates.
 */

import { latestByEntity } from "@/domain/insights/indicators";
import type { InsightObservation } from "@/domain/insights/types";
import {
  loadIrenaCapacity,
  loadOwidElectricityShare,
  loadOwidPrimaryEnergy,
  loadOwidSolarGeneration,
} from "./bundles";
import { fetchEmberSolarYearly } from "./ember";

export interface IndicatorLoadResult {
  observations: InsightObservation[];
  latest: InsightObservation[];
  method: string;
  source: string;
  vintage: string;
  licence: string;
  /** True when Ember was requested but unavailable and OWID was used. */
  reducedCapability: boolean;
  capabilityNote?: string;
}

function isAggregateEntity(row: InsightObservation): boolean {
  if (row.isAggregate) return true;
  const code = row.entityIso3.toUpperCase();
  return (
    code === "WLD" ||
    code.startsWith("OWID_") ||
    code.startsWith("REG_") ||
    code.length !== 3
  );
}

export async function loadIndicatorObservations(
  indicatorId: string,
  options: { emberApiKey?: string | null; scope: "countries" | "global" },
): Promise<IndicatorLoadResult> {
  if (indicatorId === "irena_capacity_gw") {
    const bundle = loadIrenaCapacity();
    return finish(bundle.observations, bundle, options.scope, false);
  }
  if (indicatorId === "owid_primary_energy_share") {
    const bundle = loadOwidPrimaryEnergy();
    return finish(bundle.observations, bundle, options.scope, false);
  }

  if (indicatorId === "solar_generation_twh" || indicatorId === "solar_electricity_share") {
    // Aggregates for World/regions come from OWID; Ember is used for countries.
    if (options.scope === "global") {
      const bundle =
        indicatorId === "solar_generation_twh"
          ? loadOwidSolarGeneration()
          : loadOwidElectricityShare();
      return finish(
        bundle.observations,
        bundle,
        options.scope,
        false,
        "World / regions uses Our World in Data aggregates (Ember solar series is country-level).",
      );
    }

    if (options.emberApiKey) {
      try {
        const all = await fetchEmberSolarYearly(options.emberApiKey);
        const filtered = all.filter((row) => row.indicatorId === indicatorId);
        if (filtered.length) {
          return finish(
            filtered,
            {
              source: "Ember",
              vintage: "live API",
              licence: "Ember open data terms",
              method: "Ember yearly electricity-generation series=Solar",
            },
            options.scope,
            false,
          );
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const bundle =
          indicatorId === "solar_generation_twh"
            ? loadOwidSolarGeneration()
            : loadOwidElectricityShare();
        return finish(
          bundle.observations,
          bundle,
          options.scope,
          true,
          `Ember request failed (${detail}) — showing bundled Our World in Data figures instead.`,
        );
      }
    }
    const bundle =
      indicatorId === "solar_generation_twh"
        ? loadOwidSolarGeneration()
        : loadOwidElectricityShare();
    return finish(
      bundle.observations,
      bundle,
      options.scope,
      true,
      "No Ember API key — showing bundled Our World in Data figures. Add a key in Settings → Optional keys for live Ember data.",
    );
  }

  return {
    observations: [],
    latest: [],
    method: "unknown indicator",
    source: "—",
    vintage: "—",
    licence: "—",
    reducedCapability: true,
    capabilityNote: "Unknown indicator.",
  };
}

function finish(
  observations: InsightObservation[],
  meta: { source: string; vintage: string; licence: string; method: string },
  scope: "countries" | "global",
  reducedCapability: boolean,
  capabilityNote?: string,
): IndicatorLoadResult {
  const scoped =
    scope === "global"
      ? observations.filter((row) => isAggregateEntity(row))
      : observations.filter((row) => !isAggregateEntity(row) && row.entityIso3.length === 3);
  return {
    observations: scoped,
    latest: latestByEntity(scoped),
    method: meta.method,
    source: meta.source,
    vintage: meta.vintage,
    licence: meta.licence,
    reducedCapability,
    capabilityNote,
  };
}
