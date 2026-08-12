/**
 * Re-paint Sunday overlays after MapLibre style swaps.
 *
 * setStyle must never run while a previous style is still loading — that produces
 * "Unable to perform style diff: Style is not done loading" and a black canvas.
 */

import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { useLayerStore } from "@/core/store/layerStore";
import { refreshFootprintLayers } from "./footprintLayers";
import { refreshPlantLayer } from "./plantLayers";
import { refreshProtectedAreaLayers, WDPA_SOURCE_ID } from "./protectedAreaLayers";
import { refreshResourceRasterLayers } from "./resourceRasterLayers";
import { renderScreeningLayers } from "./screeningLayers";
import { renderSiteLayers } from "./siteLayers";
import { refreshLandCoverLayers } from "./landCoverLayers";
import { POWER_SOURCE_ID, refreshPowerGridLayers } from "./powerGridLayers";
import { refreshTerrainSlopeLayers } from "./terrainSlopeLayers";
import { whenStyleReady } from "./styleReady";

export { whenStyleReady } from "./styleReady";

function paintOverlays(map: MapLibreMap): void {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return;
  } catch {
    return;
  }
  renderSiteLayers(map);
  renderScreeningLayers(map);
  void refreshPlantLayer(map);
  void refreshFootprintLayers(map);
  void refreshResourceRasterLayers(map);
  void refreshProtectedAreaLayers(map);
  void refreshTerrainSlopeLayers(map);
  void refreshLandCoverLayers(map);
  void refreshPowerGridLayers(map);
}

/** One in-flight setStyle per map; further requests replace the queued style. */
const styleQueue = new WeakMap<
  MapLibreMap,
  { inflight: Promise<void>; pending: StyleSpecification | null }
>();

function waitForStyle(map: MapLibreMap): Promise<void> {
  try {
    if (map.getStyle() && map.isStyleLoaded()) return Promise.resolve();
  } catch {
    // continue
  }
  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    const finish = () => {
      if (done) return;
      done = true;
      map.off("style.load", finish);
      map.off("idle", finish);
      window.clearTimeout(timer);
      resolve();
    };
    map.on("style.load", finish);
    map.on("idle", finish);
    timer = window.setTimeout(finish, 2_000);
  });
}

/**
 * Apply a basemap style, waiting for any in-flight setStyle to finish first.
 * If another request arrives while loading, only the latest style is applied.
 */
export function setStyleAndRepaint(map: MapLibreMap, style: StyleSpecification): void {
  let slot = styleQueue.get(map);
  if (!slot) {
    slot = { inflight: Promise.resolve(), pending: null };
    styleQueue.set(map, slot);
  }

  // Coalesce: keep only the newest requested style.
  slot.pending = style;

  slot.inflight = slot.inflight.then(async () => {
    const next = slot!.pending;
    slot!.pending = null;
    if (!next) return;

    // Wait out the current style before replacing it.
    await waitForStyle(map);

    // A newer request may have arrived while we waited.
    const latest = slot!.pending ?? next;
    slot!.pending = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      // Declared before settle — style.load can fire synchronously during setStyle
      // and must not hit the temporal dead zone on `const timer`.
      let timer = 0;
      const settle = () => {
        if (settled) return;
        settled = true;
        map.off("style.load", settle);
        window.clearTimeout(timer);
        map.resize();
        whenStyleReady(map, () => {
          paintOverlays(map);
          // Backstop: sites may restore while power/GSA/terrain still need a second pass.
          map.once("idle", () => {
            if (overlaysNeedRepair(map)) paintOverlays(map);
          });
        });
        resolve();
      };
      map.once("style.load", settle);
      map.setStyle(latest);
      timer = window.setTimeout(settle, 2_000);
    });
  });
}

/** Sites + plants + footprints. Safe to call repeatedly (coalesced). */
export function repaintOverlayLayers(map: MapLibreMap): void {
  whenStyleReady(map, () => paintOverlays(map));
}

/** True when a visible overlay's MapLibre source is missing (style swap wiped it). */
export function overlaysNeedRepair(map: MapLibreMap): boolean {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return false;
    if (!map.getSource("sunday-sites")) return true;

    const runtime = useLayerStore.getState().runtime;
    if (runtime["osm-power"]?.visible && !map.getSource(POWER_SOURCE_ID)) return true;
    if (runtime["gsa-ghi"]?.visible && !map.getSource("sunday-gsa-gsa-ghi")) return true;
    if (runtime["gsa-dni"]?.visible && !map.getSource("sunday-gsa-gsa-dni")) return true;
    if (runtime["gsa-pvout"]?.visible && !map.getSource("sunday-gsa-gsa-pvout")) return true;
    if (runtime["terrain-slope"]?.visible && !map.getSource("sunday-terrain-slope")) return true;
    if (runtime.landcover?.visible && !map.getSource("sunday-landcover")) return true;
    if (runtime.wdpa?.visible && !map.getSource(WDPA_SOURCE_ID)) return true;
    return false;
  } catch {
    return false;
  }
}
