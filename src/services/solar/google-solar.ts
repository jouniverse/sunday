/**
 * Google Solar API client.
 *
 * Ported from the freezer `google-solar-gs` reference and the official sample:
 *
 * - Prefer HIGH imagery, then MEDIUM, then LOW / BASE when coverage is thinner.
 * - Building insights are keyed to a *building*, not a point, so the returned
 *   centre can be tens of metres from the click.
 * - `solarPanels[]` carries exact panel centres; configurations are the energy ladder.
 * - `imageryDate` is the only honest indicator of how current the geometry is.
 *
 * This is the one paid API Sunday uses, so it is never called speculatively: only
 * on an explicit user action. Responses are HTTP-cached (see requestJson TTL).
 */

import { ApiError, query, requestJson } from "../http/client";
import type { BuildingInsights, GoogleSolarPanel, RoofConfiguration, RoofSegment } from "./types";
import { PROVIDERS } from "./types";

const BASE = "https://solar.googleapis.com/v1";

export type ImageryQuality = "HIGH" | "MEDIUM" | "LOW" | "BASE";

interface LatLng {
  latitude: number;
  longitude: number;
}

interface RawBuildingInsights {
  name?: string;
  center?: LatLng;
  imageryDate?: { year: number; month: number; day: number };
  imageryQuality?: string;
  postalCode?: string;
  administrativeArea?: string;
  solarPotential?: {
    maxArrayPanelsCount?: number;
    maxArrayAreaMeters2?: number;
    maxSunshineHoursPerYear?: number;
    carbonOffsetFactorKgPerMwh?: number;
    panelCapacityWatts?: number;
    panelHeightMeters?: number;
    panelWidthMeters?: number;
    wholeRoofStats?: { areaMeters2?: number; sunshineQuantiles?: number[] };
    roofSegmentStats?: Array<{
      pitchDegrees?: number;
      azimuthDegrees?: number;
      stats?: { areaMeters2?: number; sunshineQuantiles?: number[] };
      center?: LatLng;
    }>;
    solarPanelConfigs?: Array<{
      panelsCount?: number;
      yearlyEnergyDcKwh?: number;
      roofSegmentSummaries?: Array<{
        segmentIndex?: number;
        panelsCount?: number;
        yearlyEnergyDcKwh?: number;
      }>;
    }>;
    solarPanels?: Array<{
      center?: LatLng;
      orientation?: string;
      segmentIndex?: number;
      yearlyEnergyDcKwh?: number;
    }>;
  };
  error?: { code?: number; message?: string; status?: string };
}

const QUALITY_FALLBACK: ImageryQuality[] = ["HIGH", "MEDIUM", "LOW", "BASE"];

/**
 * Roof geometry, panel capacity and candidate configurations for a building.
 * Tries HIGH → MEDIUM → LOW → BASE until Google returns a building.
 */
export async function fetchBuildingInsights(options: {
  latitude: number;
  longitude: number;
  apiKey: string;
  requiredQuality?: ImageryQuality;
  /** When true (default), walk the quality ladder instead of failing on HIGH. */
  qualityFallback?: boolean;
  signal?: AbortSignal;
}): Promise<BuildingInsights> {
  const qualities =
    options.qualityFallback === false
      ? [options.requiredQuality ?? "BASE"]
      : options.requiredQuality
        ? [
            options.requiredQuality,
            ...QUALITY_FALLBACK.filter((q) => q !== options.requiredQuality),
          ]
        : QUALITY_FALLBACK;

  let lastError: unknown;
  for (const quality of qualities) {
    try {
      return await fetchBuildingInsightsOnce({ ...options, requiredQuality: quality });
    } catch (error) {
      lastError = error;
      if (error instanceof ApiError && error.status === 404) continue;
      // NOT_FOUND / empty roof → try next quality; other errors (key, quota) stop.
      if (
        error instanceof ApiError &&
        /no building|NOT_FOUND|no roof/i.test(error.message)
      ) {
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ApiError({
        provider: PROVIDERS.google_solar.label,
        message: "Google Solar returned no building at any imagery quality",
        guidance:
          "Coverage is limited to selected urban areas. Draw the roof manually and use PVGIS for the resource instead.",
      });
}

async function fetchBuildingInsightsOnce(options: {
  latitude: number;
  longitude: number;
  apiKey: string;
  requiredQuality: ImageryQuality;
  signal?: AbortSignal;
}): Promise<BuildingInsights> {
  const provider = PROVIDERS.google_solar;
  const url = `${BASE}/buildingInsights:findClosest?${query({
    "location.latitude": options.latitude,
    "location.longitude": options.longitude,
    requiredQuality: options.requiredQuality,
    key: options.apiKey,
  })}`;

  const response = await requestJson<RawBuildingInsights>({
    provider: provider.label,
    url,
    signal: options.signal,
    // Paid API — cache aggressively so revisiting Design does not re-bill.
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  });

  if (response.error) {
    throw new ApiError({
      provider: provider.label,
      status: response.error.code ?? null,
      message: response.error.message ?? "Google Solar returned an error",
      guidance:
        response.error.status === "NOT_FOUND"
          ? "Google Solar has no building at this location. Coverage is limited to selected urban areas; use the greenfield workflow instead."
          : "Check the Google Solar API key in Settings, and that the Solar API is enabled for the project the key belongs to.",
    });
  }

  const potential = response.solarPotential;
  if (!potential || !response.center) {
    throw new ApiError({
      provider: provider.label,
      message: "Google Solar returned no roof geometry for this building",
      guidance:
        "Coverage is limited to selected urban areas. Draw the roof manually and use PVGIS for the resource instead.",
    });
  }

  const segments: RoofSegment[] = (potential.roofSegmentStats ?? []).map((segment, index) => ({
    index,
    pitchDegrees: segment.pitchDegrees ?? 0,
    azimuthDegrees: segment.azimuthDegrees ?? 180,
    areaM2: segment.stats?.areaMeters2 ?? 0,
    centre: [segment.center?.longitude ?? 0, segment.center?.latitude ?? 0],
    sunshineQuantilesKwh: segment.stats?.sunshineQuantiles,
  }));

  const configurations: RoofConfiguration[] = (potential.solarPanelConfigs ?? []).map((config) => ({
    panelCount: config.panelsCount ?? 0,
    yearlyEnergyDcKwh: config.yearlyEnergyDcKwh ?? 0,
    segments: (config.roofSegmentSummaries ?? []).map((summary) => ({
      segmentIndex: summary.segmentIndex ?? 0,
      panelCount: summary.panelsCount ?? 0,
      yearlyEnergyDcKwh: summary.yearlyEnergyDcKwh ?? 0,
    })),
  }));

  const solarPanels: GoogleSolarPanel[] = (potential.solarPanels ?? [])
    .filter((panel) => panel.center?.latitude !== undefined && panel.center?.longitude !== undefined)
    .map((panel) => ({
      centre: [panel.center!.longitude, panel.center!.latitude] as [number, number],
      orientation: panel.orientation ?? "LANDSCAPE",
      segmentIndex: panel.segmentIndex ?? 0,
      yearlyEnergyDcKwh: panel.yearlyEnergyDcKwh ?? 0,
    }));

  const imageryDate = response.imageryDate
    ? `${response.imageryDate.year}-${String(response.imageryDate.month).padStart(2, "0")}-${String(
        response.imageryDate.day,
      ).padStart(2, "0")}`
    : undefined;

  const caveats: string[] = [];
  if (imageryDate) {
    const age = ageInYears(imageryDate);
    caveats.push(
      age > 2
        ? `Imagery is from ${imageryDate}, about ${age.toFixed(1)} years old. Verify the roof has not changed.`
        : `Imagery is from ${imageryDate}.`,
    );
  }
  caveats.push(`Imagery quality used: ${response.imageryQuality ?? options.requiredQuality}.`);
  if (response.imageryQuality && response.imageryQuality !== "HIGH") {
    caveats.push(
      "Segment geometry is coarser than HIGH; panel counts should be treated as indicative.",
    );
  }
  caveats.push(
    "Panel centres come from Google Solar and may sit slightly off other basemaps (systematic CRS offset).",
  );
  caveats.push(
    "Yields are Google's own DC estimates for its reference panel; Sunday recomputes AC energy " +
      "for the module you select when packing locally.",
  );

  return {
    provider: "google_solar",
    name: response.name ?? "Unnamed building",
    centre: [response.center.longitude, response.center.latitude],
    imageryDate,
    imageryQuality: response.imageryQuality ?? options.requiredQuality,
    maxPanelCount: potential.maxArrayPanelsCount ?? solarPanels.length,
    panelCapacityWatts: potential.panelCapacityWatts ?? 400,
    panelHeightM: potential.panelHeightMeters ?? 1.87,
    panelWidthM: potential.panelWidthMeters ?? 1.05,
    roofSegments: segments,
    configurations,
    solarPanels,
    wholeRoofAreaM2: potential.wholeRoofStats?.areaMeters2,
    maxSunshineHoursPerYear: potential.maxSunshineHoursPerYear,
    carbonOffsetFactorKgPerMwh: potential.carbonOffsetFactorKgPerMwh,
    source: provider.attribution,
    caveats,
  };
}

export type DataLayerId =
  | "DSM"
  | "RGB"
  | "MASK"
  | "ANNUAL_FLUX"
  | "MONTHLY_FLUX"
  | "HOURLY_SHADE";

export interface DataLayerUrls {
  imageryDate?: string;
  imageryQuality?: string;
  dsmUrl?: string;
  rgbUrl?: string;
  maskUrl?: string;
  annualFluxUrl?: string;
  monthlyFluxUrl?: string;
  hourlyShadeUrls?: string[];
  /** Metres per pixel of the returned rasters. */
  pixelSizeMeters?: number;
}

/**
 * GeoTIFF URLs for a radius around a point.
 *
 * The URLs returned need the API key appended before they can be fetched, which
 * is why they are handed back rather than downloaded here: the caller fetches
 * them through the platform layer so the key never sits in a component.
 */
export async function fetchDataLayerUrls(options: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  apiKey: string;
  view?: "FULL_LAYERS" | "IMAGERY_AND_ANNUAL_FLUX_LAYERS" | "IMAGERY_LAYERS";
  requiredQuality?: ImageryQuality;
  /** 0.1, 0.25, 0.5 or 1.0 metres per pixel. */
  pixelSizeMeters?: number;
  signal?: AbortSignal;
}): Promise<DataLayerUrls> {
  const provider = PROVIDERS.google_solar;
  const url = `${BASE}/dataLayers:get?${query({
    "location.latitude": options.latitude,
    "location.longitude": options.longitude,
    radiusMeters: options.radiusMeters,
    view: options.view ?? "IMAGERY_AND_ANNUAL_FLUX_LAYERS",
    requiredQuality: options.requiredQuality ?? "HIGH",
    exactQualityRequired: false,
    pixelSizeMeters: options.pixelSizeMeters ?? 0.5,
    key: options.apiKey,
  })}`;

  const response = await requestJson<
    DataLayerUrls & {
      imageryDate?: { year: number; month: number; day: number };
      error?: { message?: string; status?: string };
    }
  >({
    provider: provider.label,
    url,
    signal: options.signal,
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  });

  if (response.error) {
    throw new ApiError({
      provider: provider.label,
      message: response.error.message ?? "Google Solar returned an error",
      guidance:
        "Data layers are only available inside the Solar API's imagery coverage. Reduce the " +
        "radius, or lower the required quality.",
    });
  }

  return {
    ...response,
    imageryDate: response.imageryDate
      ? `${response.imageryDate.year}-${String(response.imageryDate.month).padStart(2, "0")}-${String(
          response.imageryDate.day,
        ).padStart(2, "0")}`
      : undefined,
  };
}

/** Appends the key to a data-layer URL so the raster can be fetched. */
export function authorizeLayerUrl(url: string, apiKey: string): string {
  return url.includes("?") ? `${url}&key=${apiKey}` : `${url}?key=${apiKey}`;
}

/** Strips a key from a URL before it is stored or exported. */
export function redactKey(url: string): string {
  return url.replace(/([?&]key=)[^&]+/, "$1REDACTED");
}

function ageInYears(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * Best configuration at or below a target panel count.
 *
 * Google returns a ladder of configurations rather than one answer, so choosing
 * is the caller's job. Picking the largest that fits a target is the behaviour a
 * designer expects when they cap the system size.
 */
export function findSolarConfig(
  configurations: RoofConfiguration[],
  targetPanelCount: number,
): RoofConfiguration | null {
  const eligible = configurations
    .filter((config) => config.panelCount <= targetPanelCount)
    .sort((a, b) => b.panelCount - a.panelCount);
  return eligible[0] ?? configurations[0] ?? null;
}

/** Configuration whose annual DC energy is closest to a target. */
export function findConfigForEnergy(
  configurations: RoofConfiguration[],
  targetKwh: number,
): RoofConfiguration | null {
  if (configurations.length === 0) return null;
  return configurations.reduce((best, config) =>
    Math.abs(config.yearlyEnergyDcKwh - targetKwh) < Math.abs(best.yearlyEnergyDcKwh - targetKwh)
      ? config
      : best,
  );
}
