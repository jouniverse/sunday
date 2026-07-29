/**
 * Resolves a Global Solar Atlas COG source from Settings and samples it over a
 * site polygon. The Rust core does the windowed read; this module only decides
 * *which* file to ask for and how to label the result.
 */

import type { RasterSource, ZonalResult } from "@/core/platform";
import { platform } from "@/core/platform";
import { useSettingsStore } from "@/core/store/settingsStore";
import type { LngLat } from "@/domain/geometry";

export type GsaLayer = "ghi" | "dni" | "pvout" | "gti";

const LAYER_FILES: Record<GsaLayer, { file: string; units: string; label: string }> = {
  ghi: {
    file: "GHI.tif",
    units: "kWh/m²/year",
    label: "Global horizontal irradiation",
  },
  dni: {
    file: "DNI.tif",
    units: "kWh/m²/year",
    label: "Direct normal irradiation",
  },
  pvout: {
    file: "PVOUT.tif",
    units: "kWh/kWp/year",
    label: "PV output potential",
  },
  gti: {
    file: "GTI.tif",
    units: "kWh/m²/year",
    label: "Global tilted irradiation",
  },
};

export interface ResolvedRaster {
  source: RasterSource;
  layer: GsaLayer;
  label: string;
  units: string;
}

/**
 * Builds a RasterSource from the user's configured base URL or local directory.
 * Returns null when neither is set — the greenfield path then falls back to APIs.
 */
export function resolveGsaSource(layer: GsaLayer): ResolvedRaster | null {
  const { rasterBaseUrl, rasterLocalDir } = useSettingsStore.getState().preferences;
  const meta = LAYER_FILES[layer];
  const file = meta.file;

  if (rasterLocalDir.trim()) {
    const dir = rasterLocalDir.replace(/\/$/, "");
    return {
      source: { kind: "local", path: `${dir}/${file}` },
      layer,
      label: meta.label,
      units: meta.units,
    };
  }

  if (rasterBaseUrl.trim()) {
    const base = rasterBaseUrl.replace(/\/$/, "");
    return {
      source: { kind: "http", url: `${base}/${file}` },
      layer,
      label: meta.label,
      units: meta.units,
    };
  }

  return null;
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
}

/**
 * Samples a GSA layer over a closed ring. Daily GSA rasters (kWh/m²/day) are
 * scaled to annual when the mean is clearly in the daily range (< 20).
 */
export async function sampleSiteRaster(
  ring: LngLat[],
  layer: GsaLayer = "ghi",
): Promise<SiteZonalSample | null> {
  const resolved = resolveGsaSource(layer);
  if (!resolved || ring.length < 3) return null;

  const closed: LngLat[] = [...ring];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    closed.push(first);
  }

  const result: ZonalResult = await platform().raster.zonalStats(resolved.source, [closed], {
    geographic: true,
  });

  if (result.stats.count === 0) return null;

  // GSA world rasters store average daily totals; site reports speak annually.
  const looksDaily = result.stats.areaWeightedMean > 0 && result.stats.areaWeightedMean < 20;
  const scale = looksDaily ? 365 : 1;

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
      `${result.stats.method} over ${resolved.label} COG` +
      (looksDaily ? "; daily means × 365" : "") +
      `; overview scale ${result.stats.levelScale}`,
    sourceKind: resolved.source.kind,
    levelScale: result.stats.levelScale,
  };
}

export function rastersConfigured(): boolean {
  const { rasterBaseUrl, rasterLocalDir } = useSettingsStore.getState().preferences;
  return Boolean(rasterBaseUrl.trim() || rasterLocalDir.trim());
}
