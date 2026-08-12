/**
 * Global Solar Atlas (GHI / DNI / PVOUT) map overlays.
 *
 * Viewport-bounded COG preview from Rust → MapLibre image + raster layer.
 * No user screening polygon: the camera bbox is the window; overviews keep
 * multi-GB GHI/DNI reads cheap at low zoom.
 */

import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import { PlatformError, platform } from "@/core/platform";
import type { ViewportPreview } from "@/core/platform";
import { useLayerStore } from "@/core/store/layerStore";
import { useUiStore } from "@/core/store/uiStore";
import { resolveGsaSources, type GsaLayer } from "@/services/datasets/raster-sample";
import { whenStyleReady } from "./styleReady";

export type GsaLayerId = "gsa-ghi" | "gsa-dni" | "gsa-pvout";

const LAYER_TO_GSA: Record<GsaLayerId, GsaLayer> = {
  "gsa-ghi": "ghi",
  "gsa-dni": "dni",
  "gsa-pvout": "pvout",
};

const ALL_IDS: GsaLayerId[] = ["gsa-ghi", "gsa-dni", "gsa-pvout"];

const DEBOUNCE_MS = 300;
/** Match Rust default — ~512². */
const MAX_PIXELS = 262_144;

interface SlotRuntime {
  timer: ReturnType<typeof setTimeout> | null;
  seq: number;
  lastKey: string | null;
  /** Last successful preview for the canvas legend. */
  preview: ViewportPreview | null;
  objectUrl: string | null;
}

const runtime: Record<GsaLayerId, SlotRuntime> = {
  "gsa-ghi": { timer: null, seq: 0, lastKey: null, preview: null, objectUrl: null },
  "gsa-dni": { timer: null, seq: 0, lastKey: null, preview: null, objectUrl: null },
  "gsa-pvout": { timer: null, seq: 0, lastKey: null, preview: null, objectUrl: null },
};

/** Listeners for map-canvas legend updates. */
type PreviewListener = () => void;
const previewListeners = new Set<PreviewListener>();

export type ActiveGsaPreview = {
  layerId: GsaLayerId;
  preview: ViewportPreview;
  units: string;
  label: string;
};

/**
 * Cached for useSyncExternalStore — getSnapshot must return the same reference
 * when nothing changed, or React 19 loops ("Maximum update depth exceeded").
 */
let cachedActivePreview: ActiveGsaPreview | null = null;

export function subscribeGsaPreview(listener: PreviewListener): () => void {
  previewListeners.add(listener);
  // Visibility can change without a new preview object; re-check the snapshot.
  const unsubLayers = useLayerStore.subscribe(() => {
    const next = computeActiveGsaPreview();
    if (next !== cachedActivePreview) {
      cachedActivePreview = next;
      listener();
    }
  });
  return () => {
    previewListeners.delete(listener);
    unsubLayers();
  };
}

function notifyPreviewListeners() {
  cachedActivePreview = computeActiveGsaPreview();
  for (const listener of previewListeners) listener();
}

function computeActiveGsaPreview(): ActiveGsaPreview | null {
  const state = useLayerStore.getState();
  for (const id of ALL_IDS) {
    if (!state.isVisible(id)) continue;
    const preview = runtime[id].preview;
    if (!preview) continue;
    // Reuse the cached object when layer + preview identity are unchanged.
    if (
      cachedActivePreview &&
      cachedActivePreview.layerId === id &&
      cachedActivePreview.preview === preview
    ) {
      return cachedActivePreview;
    }
    const meta =
      id === "gsa-ghi"
        ? { units: "kWh/m²/year", label: "Global horizontal irradiation" }
        : id === "gsa-dni"
          ? { units: "kWh/m²/year", label: "Direct normal irradiation" }
          : { units: "kWh/kWp/year", label: "PV output potential" };
    return { layerId: id, preview, ...meta };
  }
  return null;
}

/** Topmost visible GSA layer with a painted preview (catalogue order). */
export function getActiveGsaPreview(): ActiveGsaPreview | null {
  const next = computeActiveGsaPreview();
  cachedActivePreview = next;
  return cachedActivePreview;
}

function sourceId(id: GsaLayerId): string {
  return `sunday-gsa-${id}`;
}
function layerId(id: GsaLayerId): string {
  return `gsa-${id}-raster`;
}

function revokeUrl(id: GsaLayerId) {
  const url = runtime[id].objectUrl;
  if (url) {
    URL.revokeObjectURL(url);
    runtime[id].objectUrl = null;
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

function previewToObjectUrl(preview: ViewportPreview): string {
  const canvas = document.createElement("canvas");
  canvas.width = preview.width;
  canvas.height = preview.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for raster preview");
  const rgba = base64ToRgbaBytes(preview.rgbaBase64);
  // Copy into a fresh ArrayBuffer-backed view — ImageData rejects SharedArrayBuffer-typed views.
  const pixels = new Uint8ClampedArray(rgba.length);
  pixels.set(rgba);
  const imageData = new ImageData(pixels, preview.width, preview.height);
  ctx.putImageData(imageData, 0, 0);
  // toBlob is async; use data URL for a synchronous MapLibre setData path.
  return canvas.toDataURL("image/png");
}

function removeLayer(map: MapLibreMap, id: GsaLayerId) {
  const lid = layerId(id);
  const sid = sourceId(id);
  if (map.getLayer(lid)) map.removeLayer(lid);
  if (map.getSource(sid)) map.removeSource(sid);
  revokeUrl(id);
  runtime[id].lastKey = null;
  runtime[id].preview = null;
  notifyPreviewListeners();
}

function applyOpacity(map: MapLibreMap, id: GsaLayerId, opacity: number) {
  const lid = layerId(id);
  if (map.getLayer(lid)) {
    map.setPaintProperty(lid, "raster-opacity", opacity);
  }
}

function upsertImage(
  map: MapLibreMap,
  id: GsaLayerId,
  url: string,
  bounds: ViewportPreview["bounds"],
  opacity: number,
) {
  const sid = sourceId(id);
  const lid = layerId(id);
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

  const existing = map.getSource(sid) as ImageSource | undefined;
  if (existing && typeof existing.updateImage === "function") {
    existing.updateImage({ url, coordinates });
  } else {
    if (map.getLayer(lid)) map.removeLayer(lid);
    if (map.getSource(sid)) map.removeSource(sid);
    map.addSource(sid, { type: "image", url, coordinates });
    // Below site fills so project geometry stays on top.
    const beforeId = map.getLayer("sites-fill") ? "sites-fill" : undefined;
    map.addLayer(
      {
        id: lid,
        type: "raster",
        source: sid,
        paint: { "raster-opacity": opacity },
      },
      beforeId,
    );
  }
  applyOpacity(map, id, opacity);
}

async function fetchOne(map: MapLibreMap, id: GsaLayerId): Promise<void> {
  const visible = useLayerStore.getState().isVisible(id);
  const opacity = useLayerStore.getState().runtime[id]?.opacity ?? 1;

  if (!visible) {
    if (map.getSource(sourceId(id))) removeLayer(map, id);
    return;
  }

  const gsa = LAYER_TO_GSA[id];
  const candidates = resolveGsaSources(gsa);
  if (candidates.length === 0) {
    removeLayer(map, id);
    useUiStore.getState().notify({
      tone: "warning",
      message: "Solar resource raster not configured",
      detail: "Install GHI / DNI / PVOUT in Settings → Solar resource rasters, or set a raster folder.",
    });
    return;
  }

  const bounds = map.getBounds();
  const key = [
    id,
    candidates[0]?.source.kind === "local"
      ? candidates[0].source.path
      : candidates[0]?.source.kind === "http"
        ? candidates[0].source.url
        : "",
    bounds.getWest().toFixed(3),
    bounds.getSouth().toFixed(3),
    bounds.getEast().toFixed(3),
    bounds.getNorth().toFixed(3),
    map.getZoom().toFixed(1),
  ].join("|");

  if (key === runtime[id].lastKey && runtime[id].preview) {
    applyOpacity(map, id, opacity);
    return;
  }

  const seq = ++runtime[id].seq;
  let lastError: unknown;
  for (const resolved of candidates) {
    try {
      const preview = await platform().raster.viewportPreview(
        resolved.source,
        {
          minLon: bounds.getWest(),
          minLat: bounds.getSouth(),
          maxLon: bounds.getEast(),
          maxLat: bounds.getNorth(),
        },
        { maxPixels: MAX_PIXELS },
      );
      if (seq !== runtime[id].seq) return;
      if (!useLayerStore.getState().isVisible(id)) return;

      const url = previewToObjectUrl(preview);
      revokeUrl(id);
      // data URLs do not need revoke; keep slot for symmetry with future blob URLs
      runtime[id].objectUrl = null;
      upsertImage(map, id, url, preview.bounds, opacity);
      runtime[id].lastKey = key;
      runtime[id].preview = preview;
      notifyPreviewListeners();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (seq !== runtime[id].seq) return;
  runtime[id].preview = null;
  notifyPreviewListeners();

  const message =
    lastError instanceof PlatformError
      ? lastError.message
      : lastError instanceof Error
        ? lastError.message
        : String(lastError ?? "unknown error");
  if (/unavailable|not configured|browser/i.test(message)) return;
  useUiStore.getState().notify({
    tone: "warning",
    message: `Could not paint ${id}`,
    detail: message,
  });
}

function scheduleOne(map: MapLibreMap, id: GsaLayerId) {
  const slot = runtime[id];
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void fetchOne(map, id);
  }, DEBOUNCE_MS);
}

/** Refresh all GSA overlays (camera / style / toggle). */
export async function refreshResourceRasterLayers(map: MapLibreMap): Promise<void> {
  whenStyleReady(map, () => {
    void Promise.all(ALL_IDS.map((id) => fetchOne(map, id)));
  });
}

/** Debounced refresh after pan/zoom. */
export function scheduleResourceRasterRefresh(map: MapLibreMap): void {
  for (const id of ALL_IDS) {
    if (useLayerStore.getState().isVisible(id)) {
      scheduleOne(map, id);
    } else if (map.getSource(sourceId(id))) {
      removeLayer(map, id);
    }
  }
}

export function installResourceRasterLayerSync(map: MapLibreMap): () => void {
  let prev = ALL_IDS.map((id) => useLayerStore.getState().runtime[id]);

  return useLayerStore.subscribe((state) => {
    const next = ALL_IDS.map((id) => state.runtime[id]);
    const changed = ALL_IDS.some((_, i) => {
      const a = prev[i];
      const b = next[i];
      return a?.visible !== b?.visible || a?.opacity !== b?.opacity;
    });
    prev = next;
    if (!changed) return;

    for (const id of ALL_IDS) {
      const opacity = state.runtime[id]?.opacity ?? 1;
      if (state.isVisible(id)) {
        if (runtime[id].preview && map.getSource(sourceId(id))) {
          applyOpacity(map, id, opacity);
          // Visibility just turned on with stale geometry — full refresh.
          if (!map.getLayer(layerId(id))) scheduleOne(map, id);
        } else {
          scheduleOne(map, id);
        }
      } else {
        removeLayer(map, id);
      }
    }
  });
}

/** Clears preview caches (e.g. after Install). */
export function invalidateResourceRasterCache(layerId?: GsaLayerId): void {
  const ids = layerId ? [layerId] : ALL_IDS;
  for (const id of ids) {
    if (runtime[id].timer) {
      clearTimeout(runtime[id].timer);
      runtime[id].timer = null;
    }
    runtime[id].seq += 1;
    runtime[id].lastKey = null;
    runtime[id].preview = null;
    revokeUrl(id);
  }
  notifyPreviewListeners();
}
