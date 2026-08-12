/**
 * Terrain slope overlay — AWS Terrarium DEM → slope %, AOI-windowed.
 *
 * Same product rules as WDPA: requires a screening area. Caches by AOI bbox
 * (not every pan) so tile fetches stay bounded.
 */

import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import { PlatformError, platform } from "@/core/platform";
import type { ViewportPreview } from "@/core/platform";
import { useLayerStore } from "@/core/store/layerStore";
import { useScreeningStore } from "@/core/store/screeningStore";
import { useUiStore } from "@/core/store/uiStore";
import { whenStyleReady } from "./styleReady";

const BUSY_KEY = "terrain-slope";

const SOURCE_ID = "sunday-terrain-slope";
const LAYER_ID = "terrain-slope-raster";
const LAYER_CATALOGUE_ID = "terrain-slope";

let lastKey: string | null = null;
let objectUrl: string | null = null;
let preview: ViewportPreview | null = null;
let guidedMissingAoi = false;
let inFlight: Promise<void> | null = null;

function revokeUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

function base64ToRgbaBytes(base64: string): Uint8ClampedArray {
  const binary = atob(base64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function previewToDataUrl(p: ViewportPreview): string {
  const canvas = document.createElement("canvas");
  canvas.width = p.width;
  canvas.height = p.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for slope preview");
  const rgba = base64ToRgbaBytes(p.rgbaBase64);
  const pixels = new Uint8ClampedArray(rgba.length);
  pixels.set(rgba);
  ctx.putImageData(new ImageData(pixels, p.width, p.height), 0, 0);
  return canvas.toDataURL("image/png");
}

function removeLayer(map: MapLibreMap) {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  revokeUrl();
  lastKey = null;
  preview = null;
}

function applyOpacity(map: MapLibreMap, opacity: number) {
  if (map.getLayer(LAYER_ID)) {
    map.setPaintProperty(LAYER_ID, "raster-opacity", opacity);
  }
}

function upsertImage(map: MapLibreMap, url: string, bounds: ViewportPreview["bounds"], opacity: number) {
  const coordinates: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ] = [
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
  ];
  const existing = map.getSource(SOURCE_ID) as ImageSource | undefined;
  if (existing && typeof existing.updateImage === "function") {
    existing.updateImage({ url, coordinates });
  } else {
    if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    map.addSource(SOURCE_ID, { type: "image", url, coordinates });
    const beforeId = map.getLayer("sites-fill")
      ? "sites-fill"
      : map.getLayer("screening-fill")
        ? "screening-fill"
        : undefined;
    map.addLayer(
      {
        id: LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        paint: { "raster-opacity": opacity },
      },
      beforeId,
    );
  }
  applyOpacity(map, opacity);
}

async function paintTerrainSlope(map: MapLibreMap): Promise<void> {
  const visible = useLayerStore.getState().runtime[LAYER_CATALOGUE_ID]?.visible ?? false;
  const opacity = useLayerStore.getState().runtime[LAYER_CATALOGUE_ID]?.opacity ?? 1;
  const aoi = useScreeningStore.getState().activeBounds();

  if (!visible) {
    removeLayer(map);
    guidedMissingAoi = false;
    return;
  }

  if (!aoi) {
    removeLayer(map);
    if (!guidedMissingAoi) {
      guidedMissingAoi = true;
      useUiStore.getState().notify({
        tone: "info",
        message: "Draw a screening area first",
        detail: "Terrain slope only paints inside a screening area.",
      });
    }
    useLayerStore.getState().setVisible(LAYER_CATALOGUE_ID, false);
    return;
  }

  guidedMissingAoi = false;

  if (platform().kind !== "tauri") {
    removeLayer(map);
    useUiStore.getState().notify({
      tone: "info",
      message: "Terrain slope needs the desktop app",
      detail: "AWS Terrarium tiles are fetched by the native core.",
    });
    useLayerStore.getState().setVisible(LAYER_CATALOGUE_ID, false);
    return;
  }

  const key = [
    aoi.minLon.toFixed(4),
    aoi.minLat.toFixed(4),
    aoi.maxLon.toFixed(4),
    aoi.maxLat.toFixed(4),
  ].join("|");

  // Style wipe removes the source but leaves lastKey/preview — re-attach from cache.
  if (lastKey === key && preview) {
    if (map.getSource(SOURCE_ID)) {
      applyOpacity(map, opacity);
      return;
    }
    const url = objectUrl ?? previewToDataUrl(preview);
    if (!objectUrl) objectUrl = url;
    upsertImage(map, url, preview.bounds, opacity);
    return;
  }

  if (inFlight) {
    await inFlight;
    if (map.getSource(SOURCE_ID) && lastKey === key) {
      applyOpacity(map, opacity);
      return;
    }
  }

  inFlight = (async () => {
    useUiStore.getState().startBusy(BUSY_KEY, "Loading terrain slope");
    try {
      const next = await platform().terrain.slopePreview(aoi);
      const url = previewToDataUrl(next);
      revokeUrl();
      objectUrl = url;
      preview = next;
      upsertImage(map, url, next.bounds, opacity);
      lastKey = key;
    } catch (error) {
      removeLayer(map);
      const detail =
        error instanceof PlatformError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      useUiStore.getState().notify({
        tone: "warning",
        message: "Could not paint terrain slope",
        detail,
      });
    } finally {
      useUiStore.getState().endBusy(BUSY_KEY);
      inFlight = null;
    }
  })();

  await inFlight;
}

export async function refreshTerrainSlopeLayers(map: MapLibreMap): Promise<void> {
  whenStyleReady(map, () => {
    void paintTerrainSlope(map);
  });
}

export function installTerrainSlopeLayerSync(map: MapLibreMap): () => void {
  const sync = () => {
    void refreshTerrainSlopeLayers(map);
  };
  const unsubLayer = useLayerStore.subscribe(sync);
  const unsubScreening = useScreeningStore.subscribe(sync);
  sync();
  return () => {
    unsubLayer();
    unsubScreening();
  };
}
