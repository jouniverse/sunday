/**
 * Resolves a Global Solar Atlas COG source from Settings and samples it over a
 * site polygon. The Rust core does the windowed read; this module only decides
 * *which* file to ask for and how to label the result.
 */

import type { RasterSource, ZonalResult } from "@/core/platform";
import { platform } from "@/core/platform";
import { useLayerStore } from "@/core/store/layerStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { LngLat } from "@/domain/geometry";

export type GsaLayer = "ghi" | "dni" | "pvout" | "gti";

const LAYER_META: Record<GsaLayer, { units: string; label: string; layerId: string }> = {
  ghi: {
    units: "kWh/m²/year",
    label: "Global horizontal irradiation",
    layerId: "gsa-ghi",
  },
  dni: {
    units: "kWh/m²/year",
    label: "Direct normal irradiation",
    layerId: "gsa-dni",
  },
  pvout: {
    units: "kWh/kWp/year",
    label: "PV output potential",
    layerId: "gsa-pvout",
  },
  gti: {
    units: "kWh/m²/year",
    label: "Global tilted irradiation",
    layerId: "",
  },
};

/** Preferred filenames, then convert-solargis-cog.sh outputs (`*_cog.tif`). */
const LAYER_FILE_CANDIDATES: Record<GsaLayer, string[]> = {
  ghi: ["GHI.tif", "GHI_cog.tif"],
  dni: ["DNI.tif", "DNI_cog.tif"],
  pvout: ["PVOUT.tif", "PVOUT_cog.tif"],
  gti: ["GTI.tif", "GTI_cog.tif"],
};

export interface ResolvedRaster {
  source: RasterSource;
  layer: GsaLayer;
  label: string;
  units: string;
  fileName: string;
}

function candidatesFor(layer: GsaLayer, dirOrBase: string, kind: "local" | "http"): ResolvedRaster[] {
  const meta = LAYER_META[layer];
  const root = dirOrBase.replace(/\/$/, "");
  return LAYER_FILE_CANDIDATES[layer].map((file) => ({
    source:
      kind === "local"
        ? ({ kind: "local", path: `${root}/${file}` } as const)
        : ({ kind: "http", url: `${root}/${file}` } as const),
    layer,
    label: meta.label,
    units: meta.units,
    fileName: file,
  }));
}

/**
 * Builds candidate RasterSources from the user's configured base URL or local
 * directory. Callers should try until one samples successfully.
 */
export function resolveGsaSources(layer: GsaLayer): ResolvedRaster[] {
  const { rasterBaseUrl, rasterLocalDir } = useSettingsStore.getState().preferences;

  if (rasterLocalDir.trim()) {
    return candidatesFor(layer, rasterLocalDir, "local");
  }

  if (rasterBaseUrl.trim()) {
    return candidatesFor(layer, rasterBaseUrl, "http");
  }

  return [];
}

/** @deprecated Prefer resolveGsaSources — kept for callers that expect a single path. */
export function resolveGsaSource(layer: GsaLayer): ResolvedRaster | null {
  return resolveGsaSources(layer)[0] ?? null;
}

export interface SiteZonalSample {
  layer: GsaLayer;
  label: string;
  units: string;
  mean: number;
  areaWeightedMean: number;
  min: number;
  max: number;
  count: number;
  method: string;
  sourceKind: "local" | "http";
  levelScale: number;
  fileName: string;
}

/**
 * Samples a GSA layer over a closed ring. Daily GSA rasters (kWh/m²/day) are
 * scaled to annual when the mean is clearly in the daily range (< 20).
 */
export async function sampleSiteRaster(
  ring: LngLat[],
  layer: GsaLayer = "ghi",
): Promise<SiteZonalSample | null> {
  const candidates = resolveGsaSources(layer);
  if (candidates.length === 0 || ring.length < 3) return null;

  const closed: LngLat[] = [...ring];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    closed.push(first);
  }

  let lastError: unknown;
  for (const resolved of candidates) {
    try {
      const result: ZonalResult = await platform().raster.zonalStats(resolved.source, [closed], {
        geographic: true,
      });

      if (result.stats.count === 0) continue;

      // GSA world rasters store average daily totals; site reports speak annually.
      const looksDaily = result.stats.areaWeightedMean > 0 && result.stats.areaWeightedMean < 20;
      const scale = looksDaily ? 365 : 1;

      if (LAYER_META[layer].layerId) {
        useLayerStore.getState().markAvailable(LAYER_META[layer].layerId);
      }

      return {
        layer,
        label: resolved.label,
        units: resolved.units,
        mean: result.stats.mean * scale,
        areaWeightedMean: result.stats.areaWeightedMean * scale,
        min: result.stats.min * scale,
        max: result.stats.max * scale,
        count: result.stats.count,
        method:
          `${result.stats.method} over ${resolved.label} (${resolved.fileName})` +
          (looksDaily ? "; daily means × 365" : "") +
          `; overview scale ${result.stats.levelScale}`,
        sourceKind: resolved.source.kind,
        levelScale: result.stats.levelScale,
        fileName: resolved.fileName,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}

export function rastersConfigured(): boolean {
  const { rasterBaseUrl, rasterLocalDir } = useSettingsStore.getState().preferences;
  return Boolean(rasterBaseUrl.trim() || rasterLocalDir.trim());
}

/** Marks GSA catalogue layers usable once a raster directory/URL is configured. */
export function markGsaLayersFromSettings(): void {
  if (!rastersConfigured()) return;
  const mark = useLayerStore.getState().markAvailable;
  mark("gsa-ghi");
  mark("gsa-dni");
  mark("gsa-pvout");
}
