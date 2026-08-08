/**
 * Protected areas (WDPA) — local PMTiles paint windowed to screening AOIs.
 *
 * Full-globe paint of WDPA is intentionally blocked: without a screening area
 * the layer stays off with guidance. SQLite simplified geometries are for
 * screening intersects, not for map paint.
 */

import type { Map as MapLibreMap } from "maplibre-gl";
import { platform } from "@/core/platform";
import { useLayerStore } from "@/core/store/layerStore";
import type { Bounds } from "@/core/store/mapStore";
import { useScreeningStore } from "@/core/store/screeningStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import { useUiStore } from "@/core/store/uiStore";
import { ensurePmtilesProtocol } from "./pmtilesProtocol";

export const WDPA_SOURCE_ID = "sunday-wdpa";
export const WDPA_FILL_LAYER = "wdpa-fill";
export const WDPA_LINE_LAYER = "wdpa-line";
/** tippecanoe layer name written by install_wdpa. */
const WDPA_SOURCE_LAYER = "protected_areas";
const MIN_ZOOM = 5;

let lastKey: string | null = null;
let guidedMissingAoi = false;

function pmtilesPath(vectorDir: string): string {
  const sep = vectorDir.includes("\\") ? "\\" : "/";
  const base = vectorDir.endsWith(sep) ? vectorDir.slice(0, -1) : vectorDir;
  return `${base}${sep}protected_areas.pmtiles`;
}

function removeWdpaLayers(map: MapLibreMap): void {
  if (map.getLayer(WDPA_LINE_LAYER)) map.removeLayer(WDPA_LINE_LAYER);
  if (map.getLayer(WDPA_FILL_LAYER)) map.removeLayer(WDPA_FILL_LAYER);
  if (map.getSource(WDPA_SOURCE_ID)) map.removeSource(WDPA_SOURCE_ID);
  lastKey = null;
}

function applyOpacity(map: MapLibreMap, opacity: number): void {
  if (map.getLayer(WDPA_FILL_LAYER)) {
    map.setPaintProperty(WDPA_FILL_LAYER, "fill-opacity", 0.35 * opacity);
  }
  if (map.getLayer(WDPA_LINE_LAYER)) {
    map.setPaintProperty(WDPA_LINE_LAYER, "line-opacity", 0.85 * opacity);
  }
}

async function ensureSource(map: MapLibreMap, bounds: Bounds, fileUrl: string): Promise<void> {
  ensurePmtilesProtocol();
  const key = [
    fileUrl,
    bounds.minLon.toFixed(4),
    bounds.minLat.toFixed(4),
    bounds.maxLon.toFixed(4),
    bounds.maxLat.toFixed(4),
  ].join("|");
  if (map.getSource(WDPA_SOURCE_ID) && lastKey === key) return;

  removeWdpaLayers(map);
  map.addSource(WDPA_SOURCE_ID, {
    type: "vector",
    url: `pmtiles://${fileUrl}`,
    // Window tile requests to the screening AOI bbox.
    bounds: [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat],
    minzoom: MIN_ZOOM,
  });
  map.addLayer({
    id: WDPA_FILL_LAYER,
    type: "fill",
    source: WDPA_SOURCE_ID,
    "source-layer": WDPA_SOURCE_LAYER,
    minzoom: MIN_ZOOM,
    paint: {
      "fill-color": [
        "match",
        ["to-string", ["get", "IUCN_CAT"]],
        "Ia",
        "#2d6a4f",
        "Ib",
        "#2d6a4f",
        "II",
        "#40916c",
        "III",
        "#40916c",
        "IV",
        "#74c69d",
        "V",
        "#74c69d",
        "VI",
        "#74c69d",
        "#95d5b2",
      ],
      "fill-opacity": 0.35,
    },
  });
  map.addLayer({
    id: WDPA_LINE_LAYER,
    type: "line",
    source: WDPA_SOURCE_ID,
    "source-layer": WDPA_SOURCE_LAYER,
    minzoom: MIN_ZOOM,
    paint: {
      "line-color": "#1b4332",
      "line-width": 1,
      "line-opacity": 0.85,
    },
  });
  lastKey = key;
}

export async function refreshProtectedAreaLayers(map: MapLibreMap): Promise<void> {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return;
  } catch {
    return;
  }

  const visible = useLayerStore.getState().runtime.wdpa?.visible ?? false;
  const opacity = useLayerStore.getState().runtime.wdpa?.opacity ?? 1;
  const installed = Boolean(useSettingsStore.getState().datasets.wdpa?.downloaded);
  const aoi = useScreeningStore.getState().activeBounds();

  if (!visible) {
    removeWdpaLayers(map);
    guidedMissingAoi = false;
    return;
  }

  if (!installed) {
    removeWdpaLayers(map);
    return;
  }

  if (!aoi) {
    removeWdpaLayers(map);
    if (!guidedMissingAoi) {
      guidedMissingAoi = true;
      useUiStore.getState().notify({
        tone: "info",
        message: "Draw a screening area first",
        detail: "Protected areas only paint inside a screening area.",
      });
    }
    // Keep the catalogue toggle honest — turn visibility off so the switch matches paint.
    useLayerStore.getState().setVisible("wdpa", false);
    return;
  }

  guidedMissingAoi = false;

  if (platform().kind !== "tauri") {
    removeWdpaLayers(map);
    useUiStore.getState().notify({
      tone: "info",
      message: "Protected areas need the desktop app",
      detail: "Local PMTiles paint is unavailable in the browser preview.",
    });
    useLayerStore.getState().setVisible("wdpa", false);
    return;
  }

  try {
    const info = await platform().appInfo();
    const path = pmtilesPath(info.vectorDir);
    const fileUrl = await platform().resolveLocalFileUrl(path);
    if (!fileUrl) {
      removeWdpaLayers(map);
      return;
    }
    await ensureSource(map, aoi, fileUrl);
    applyOpacity(map, opacity);
  } catch (error) {
    console.warn("[sunday map] WDPA paint failed", error);
    removeWdpaLayers(map);
  }
}

/** Subscribe layer + screening changes; returns unsubscribe. */
export function installProtectedAreaLayerSync(map: MapLibreMap): () => void {
  const sync = () => {
    void refreshProtectedAreaLayers(map);
  };
  const unsubLayer = useLayerStore.subscribe(sync);
  const unsubScreening = useScreeningStore.subscribe(sync);
  const unsubSettings = useSettingsStore.subscribe(sync);
  sync();
  return () => {
    unsubLayer();
    unsubScreening();
    unsubSettings();
  };
}
