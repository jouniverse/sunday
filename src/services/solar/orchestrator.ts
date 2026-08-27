/**
 * Fans a location out to every available provider and assembles one report.
 *
 * The rules that matter here:
 *
 * - One provider failing must not fail the report. Each source is settled
 *   independently and its failure recorded as a reason, not an exception.
 * - Sources are never silently averaged. Where two providers answer the same
 *   question, both values are shown with their spread, and a large disagreement
 *   is flagged.
 * - The paid API is only called when the caller explicitly asks for it.
 */

import type { ApiError } from "../http/client";
import { fetchNasaPowerClimatology } from "./nasa-power";
import { fetchNlrResource, fetchPvWatts } from "./nlr";
import { fetchPvgisPerformance, fetchPvgisRadiation } from "./pvgis";
import type { Comparison, ResourceReport, SolarProvider } from "./types";
import { compareValues } from "./types";

export interface SiteReportRequest {
  latitude: number;
  longitude: number;
  /** Providers to consult. Missing keys are skipped with a stated reason. */
  providers: SolarProvider[];
  /** Resolves a provider's key, or null when it is not configured. */
  getApiKey: (provider: "google_solar" | "nlr") => Promise<string | null>;
  capacityKwDc?: number;
  tiltDegrees?: number;
  azimuthDegrees?: number;
  lossesPercent?: number;
  /** Ask PVGIS to optimise tilt and azimuth as well. */
  optimiseTilt?: boolean;
  signal?: AbortSignal;
  /** Called as each provider settles, for incremental UI updates. */
  onProgress?: (completed: number, total: number, provider: SolarProvider) => void;
}

export interface ProviderOutcome {
  provider: SolarProvider;
  status: "ok" | "skipped" | "failed";
  report?: ResourceReport;
  /** Why it was skipped or how it failed, always actionable. */
  reason?: string;
  guidance?: string;
}

export interface SiteReport {
  latitude: number;
  longitude: number;
  generatedAt: string;
  outcomes: ProviderOutcome[];
  reports: ResourceReport[];
  comparisons: Comparison[];
  /** Best available consensus values, with their origin named. */
  consensus: {
    ghiKwhM2Year?: { value: number; from: SolarProvider[]; note: string };
    dniKwhM2Year?: { value: number; from: SolarProvider[]; note: string };
    specificYieldKwhPerKwp?: { value: number; from: SolarProvider[]; note: string };
    optimalTiltDegrees?: { value: number; from: SolarProvider[]; note: string };
    meanAirTempC?: { value: number; from: SolarProvider[]; note: string };
  };
  warnings: string[];
}

/**
 * Provider preference for irradiance / yield consensus figures.
 *
 * Ordered by the fidelity of the underlying dataset, which the reviews
 * established: NSRDB at 4 km is measured, PVGIS at 5 km is modelled from
 * satellite, POWER at 1 degree is a regional average.
 */
const FIDELITY_ORDER: SolarProvider[] = ["nlr", "pvgis", "google_solar", "nasa_power"];

/**
 * Optimal tilt preference. PVGIS PVcalc can return nonsensical slopes outside
 * its strongest coverage (e.g. −1° in inland Australia while latitude ≈ 33°).
 * NASA POWER’s SI_TILTED_AVG_OPTIMAL_ANG tracks the tilt-near-latitude rule
 * more reliably globally; we still show PVGIS in the comparison table.
 */
const TILT_ORDER: SolarProvider[] = ["nasa_power", "nlr", "google_solar", "pvgis"];

/** Near-surface air temperature: MERRA-2 via POWER is the global default. */
const AIR_TEMP_ORDER: SolarProvider[] = ["nasa_power", "nlr", "pvgis", "google_solar"];

export async function generateSiteReport(request: SiteReportRequest): Promise<SiteReport> {
  const outcomes: ProviderOutcome[] = [];
  const total = request.providers.length;
  let completed = 0;

  const record = (outcome: ProviderOutcome) => {
    outcomes.push(outcome);
    completed += 1;
    request.onProgress?.(completed, total, outcome.provider);
  };

  // Sequential rather than parallel: these are public, rate-limited services and
  // a burst of simultaneous requests is what gets a client throttled.
  for (const provider of request.providers) {
    if (request.signal?.aborted) break;

    try {
      switch (provider) {
        case "pvgis": {
          const [radiation, performance] = await Promise.all([
            fetchPvgisRadiation({
              latitude: request.latitude,
              longitude: request.longitude,
              signal: request.signal,
            }),
            fetchPvgisPerformance({
              latitude: request.latitude,
              longitude: request.longitude,
              peakPowerKw: request.capacityKwDc ?? 1,
              lossesPercent: request.lossesPercent,
              tiltDegrees: request.tiltDegrees,
              azimuthDegrees: request.azimuthDegrees,
              optimise: request.optimiseTilt ?? true,
              signal: request.signal,
            }),
          ]);
          // The two PVGIS endpoints describe the same location, so they merge.
          record({ provider, status: "ok", report: { ...radiation, ...merge(performance) } });
          break;
        }

        case "nasa_power": {
          const report = await fetchNasaPowerClimatology({
            latitude: request.latitude,
            longitude: request.longitude,
            signal: request.signal,
          });
          record({ provider, status: "ok", report });
          break;
        }

        case "nlr": {
          const key = await request.getApiKey("nlr");
          if (!key) {
            record({
              provider,
              status: "skipped",
              reason: "No NLR API key configured.",
              guidance: "Add a free NLR key in Settings to include NSRDB and PVWatts.",
            });
            break;
          }
          const resource = await fetchNlrResource({
            latitude: request.latitude,
            longitude: request.longitude,
            apiKey: key,
            signal: request.signal,
          });
          let merged = resource;
          try {
            const pvwatts = await fetchPvWatts({
              latitude: request.latitude,
              longitude: request.longitude,
              apiKey: key,
              capacityKwDc: request.capacityKwDc ?? 1,
              tiltDegrees: request.tiltDegrees,
              azimuthDegrees: request.azimuthDegrees,
              lossesPercent: request.lossesPercent,
              signal: request.signal,
            });
            merged = { ...resource, ...merge(pvwatts) };
          } catch {
            // The resource figures are still worth having without PVWatts.
            merged = {
              ...resource,
              caveats: [...resource.caveats, "PVWatts did not answer, so no modelled yield from NLR."],
            };
          }
          record({ provider, status: "ok", report: merged });
          break;
        }

        case "google_solar": {
          // Building insights are a rooftop workflow, not a resource report, and
          // this is the one metered API: it is never called speculatively here.
          record({
            provider,
            status: "skipped",
            reason: "Google Solar is a rooftop-specific source.",
            guidance: "Use the rooftop design workflow to query it for a specific building.",
          });
          break;
        }

        default:
          break;
      }
    } catch (error) {
      const apiError = error as ApiError;
      record({
        provider,
        status: "failed",
        reason: apiError.message ?? String(error),
        guidance: apiError.guidance,
      });
    }
  }

  const reports = outcomes
    .filter((outcome) => outcome.status === "ok" && outcome.report)
    .map((outcome) => outcome.report as ResourceReport);

  const comparisons = buildComparisons(reports);
  const warnings = comparisons
    .filter((comparison) => comparison.significant)
    .map(
      (comparison) =>
        `${comparison.quantity} differs by ${(comparison.relativeSpread * 100).toFixed(0)}% ` +
        `between sources (${comparison.min.toFixed(0)}–${comparison.max.toFixed(0)} ${comparison.unit}). ` +
        "Both values are shown; the difference is real and not resolved by averaging.",
    );

  if (reports.length === 0) {
    warnings.push("No provider returned data for this location.");
  }

  return {
    latitude: request.latitude,
    longitude: request.longitude,
    generatedAt: new Date().toISOString(),
    outcomes,
    reports,
    comparisons,
    consensus: buildConsensus(reports),
    warnings,
  };
}

/** Drops undefined fields so a merge never overwrites a value with nothing. */
function merge(report: ResourceReport): Partial<ResourceReport> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(report)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result as Partial<ResourceReport>;
}

function buildComparisons(reports: ResourceReport[]): Comparison[] {
  const definitions: Array<{
    quantity: string;
    unit: string;
    select: (report: ResourceReport) => number | undefined;
  }> = [
    { quantity: "Global horizontal irradiation", unit: "kWh/m²/yr", select: (r) => r.ghiKwhM2Year },
    { quantity: "Direct normal irradiation", unit: "kWh/m²/yr", select: (r) => r.dniKwhM2Year },
    { quantity: "In-plane irradiation", unit: "kWh/m²/yr", select: (r) => r.poaKwhM2Year },
    { quantity: "Specific yield", unit: "kWh/kWp/yr", select: (r) => r.specificYieldKwhPerKwp },
    { quantity: "Optimal tilt", unit: "°", select: (r) => r.optimalTiltDegrees },
    {
      quantity: "Mean air temperature (2 m)",
      unit: "°C",
      select: (r) => r.meanAirTempC,
    },
  ];

  return definitions
    .map((definition) =>
      compareValues(
        definition.quantity,
        definition.unit,
        reports.map((report) => ({
          provider: report.provider,
          value: definition.select(report),
          fidelity: report.fidelity,
        })),
      ),
    )
    .filter((comparison): comparison is Comparison => comparison !== null);
}

/**
 * Picks a single value per quantity by dataset fidelity, and names its source.
 *
 * Explicitly *not* an average. When sources disagree the report shows both; this
 * only chooses which one the design workflow proceeds with, and records why.
 */
function buildConsensus(reports: ResourceReport[]): SiteReport["consensus"] {
  const pick = (
    select: (report: ResourceReport) => number | undefined,
    order: SolarProvider[] = FIDELITY_ORDER,
    reason = "the highest-resolution source that answered",
  ) => {
    const candidates = reports
      .map((report) => ({ provider: report.provider, value: select(report) }))
      .filter((entry): entry is { provider: SolarProvider; value: number } =>
        typeof entry.value === "number" && Number.isFinite(entry.value),
      );
    if (candidates.length === 0) return undefined;

    const best = [...candidates].sort(
      (a, b) => order.indexOf(a.provider) - order.indexOf(b.provider),
    )[0] as { provider: SolarProvider; value: number };

    return {
      value: best.value,
      from: [best.provider],
      note:
        candidates.length === 1
          ? `Only ${best.provider} reported this value.`
          : `Taken from ${best.provider}, ${reason}. ` +
            `${candidates.length} sources reported this quantity.`,
    };
  };

  return {
    ghiKwhM2Year: pick((r) => r.ghiKwhM2Year),
    dniKwhM2Year: pick((r) => r.dniKwhM2Year),
    specificYieldKwhPerKwp: pick((r) => r.specificYieldKwhPerKwp),
    optimalTiltDegrees: pick(
      (r) => r.optimalTiltDegrees,
      TILT_ORDER,
      "the preferred source for global tilt (NASA POWER over PVGIS outside strong coverage)",
    ),
    meanAirTempC: pick(
      (r) => r.meanAirTempC,
      AIR_TEMP_ORDER,
      "the preferred meteorology source",
    ),
  };
}
