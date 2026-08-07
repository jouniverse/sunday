/**
 * Re-paint Sunday overlays after MapLibre style swaps.
 *
 * setStyle must never run while a previous style is still loading — that produces
 * "Unable to perform style diff: Style is not done loading" and a black canvas.
 */

import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { refreshFootprintLayers } from "./footprintLayers";
import { refreshPlantLayer } from "./plantLayers";
import { refreshResourceRasterLayers } from "./resourceRasterLayers";
import { renderSiteLayers } from "./siteLayers";
import { whenStyleReady } from "./styleReady";

export { whenStyleReady } from "./styleReady";

function paintOverlays(map: MapLibreMap): void {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return;
  } catch {
    return;
  }
  renderSiteLayers(map);
  void refreshPlantLayer(map);
  void refreshFootprintLayers(map);
  void refreshResourceRasterLayers(map);
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
    const timer = window.setTimeout(finish, 2_000);
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
      const settle = () => {
        if (settled) return;
        settled = true;
        map.off("style.load", settle);
        window.clearTimeout(timer);
        map.resize();
        paintOverlays(map);
        resolve();
      };
      map.once("style.load", settle);
      map.setStyle(latest);
      const timer = window.setTimeout(settle, 2_000);
    });
  });
}

/** Sites + plants + footprints. Safe to call repeatedly (coalesced). */
export function repaintOverlayLayers(map: MapLibreMap): void {
  whenStyleReady(map, () => paintOverlays(map));
}

/** True when app overlay sources are missing (style swap wiped them). */
export function overlaysNeedRepair(map: MapLibreMap): boolean {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return false;
    return !map.getSource("sunday-sites");
  } catch {
    return false;
  }
}
