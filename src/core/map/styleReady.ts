/**
 * Coalesced MapLibre style-settle helper.
 *
 * One pending settle per map — stacking style.load / styledata / idle / setTimeout
 * on every overlay refresh was freezing the app after basemap changes.
 */

import type { Map as MapLibreMap } from "maplibre-gl";

interface PendingSettle {
  callbacks: Array<() => void>;
  timers: number[];
  onStyleLoad: () => void;
  onStyleData: () => void;
  onIdle: () => void;
  /** When true, ignore the currently-loaded style and wait for the next load. */
  waitForNextStyle: boolean;
}

const pendingByMap = new WeakMap<MapLibreMap, PendingSettle>();

function styleAcceptsLayers(map: MapLibreMap): boolean {
  try {
    return Boolean(map.getStyle() && map.isStyleLoaded());
  } catch {
    return false;
  }
}

function clearPending(map: MapLibreMap): PendingSettle | undefined {
  const pending = pendingByMap.get(map);
  if (!pending) return undefined;
  map.off("style.load", pending.onStyleLoad);
  map.off("styledata", pending.onStyleData);
  map.off("idle", pending.onIdle);
  for (const id of pending.timers) window.clearTimeout(id);
  pendingByMap.delete(map);
  return pending;
}

function flush(map: MapLibreMap): void {
  const pending = pendingByMap.get(map);
  if (!pending) return;
  if (!styleAcceptsLayers(map)) return;
  if (pending.waitForNextStyle) return;

  const callbacks = pending.callbacks.slice();
  clearPending(map);
  for (const cb of callbacks) {
    try {
      cb();
    } catch {
      // One overlay failure must not block the rest.
    }
  }
}

function armSettle(map: MapLibreMap, waitForNextStyle: boolean, fn: () => void): void {
  let pending = pendingByMap.get(map);
  if (pending) {
    pending.callbacks.push(fn);
    pending.waitForNextStyle = pending.waitForNextStyle || waitForNextStyle;
    if (!pending.waitForNextStyle) flush(map);
    return;
  }

  const onStyleLoad = () => {
    const current = pendingByMap.get(map);
    if (current) current.waitForNextStyle = false;
    flush(map);
  };
  // Older MapLibre paths surface readiness on styledata; keep both.
  const onStyleData = () => {
    const current = pendingByMap.get(map);
    if (!current) return;
    if (current.waitForNextStyle) return;
    flush(map);
  };
  const onIdle = () => flush(map);

  pending = {
    callbacks: [fn],
    timers: [],
    onStyleLoad,
    onStyleData,
    onIdle,
    waitForNextStyle,
  };
  pendingByMap.set(map, pending);
  map.on("style.load", onStyleLoad);
  map.on("styledata", onStyleData);
  map.on("idle", onIdle);

  if (!waitForNextStyle) {
    flush(map);
    pending.timers.push(window.setTimeout(() => flush(map), 80));
    pending.timers.push(window.setTimeout(() => flush(map), 400));
  } else {
    // After setStyle: style.load clears the flag; these are backstops.
    pending.timers.push(
      window.setTimeout(() => {
        const current = pendingByMap.get(map);
        if (current) current.waitForNextStyle = false;
        flush(map);
      }, 800),
    );
  }
}

/** Run `fn` once the *current* style can accept addSource / addLayer. */
export function whenStyleReady(map: MapLibreMap, fn: () => void): void {
  armSettle(map, false, fn);
}

/** Register callbacks that run after the *next* style load (call before setStyle). */
export function afterNextStyleLoad(map: MapLibreMap, fn: () => void): void {
  // Do not clear an in-flight waitForNextStyle settle — merge into it.
  const existing = pendingByMap.get(map);
  if (existing?.waitForNextStyle) {
    existing.callbacks.push(fn);
    return;
  }
  clearPending(map);
  armSettle(map, true, fn);
}
