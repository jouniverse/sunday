/**
 * Screening area polygons — AOIs that window land/terrain data layers.
 *
 * Independent of sites: sites may sit outside any screening polygon. Land
 * layers (WDPA, later LULC/slope) only paint inside these areas.
 */

import { create } from "zustand";
import type { LngLat } from "@/domain/geometry";
import {
  geodesicPerimeterM,
  geodesicPolygonAreaM2,
  isSimpleRing,
  ringCentroid,
} from "@/domain/geometry";
import type { Bounds } from "./mapStore";

/** Soft cap for land-layer windowing (~50 000 km²). */
export const SCREENING_AREA_WARN_KM2 = 50_000;

export interface ScreeningArea {
  id: string;
  name: string;
  ring: LngLat[];
  centre: LngLat;
  createdAt: string;
  areaM2: number;
  perimeterM: number;
  geometryValid: boolean;
}

interface ScreeningState {
  areas: ScreeningArea[];
  selectedId: string | null;

  addArea: (ring: LngLat[], name?: string) => string;
  updateRing: (id: string, ring: LngLat[]) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  replaceAll: (areas: ScreeningArea[]) => void;
  clear: () => void;
  selected: () => ScreeningArea | null;
  /** Selected area bbox, else union of all valid areas. */
  activeBounds: () => Bounds | null;
  /** True when any area exceeds the soft windowing cap. */
  hasOversizedArea: () => boolean;
}

let areaCounter = 0;

function geometryOf(
  ring: LngLat[],
): Pick<ScreeningArea, "areaM2" | "perimeterM" | "geometryValid" | "centre"> {
  const closed = ring.length > 0 && ring[0] !== undefined ? [...ring, ring[0] as LngLat] : ring;
  const valid = ring.length >= 3 && isSimpleRing(closed);
  return {
    areaM2: valid ? geodesicPolygonAreaM2([closed]) : 0,
    perimeterM: ring.length >= 2 ? geodesicPerimeterM(closed) : 0,
    geometryValid: valid,
    centre: ring.length > 0 ? ringCentroid(closed) : [0, 0],
  };
}

/** Bounding box of a screening ring (WGS84). */
export function screeningRingBounds(ring: LngLat[]): Bounds | null {
  if (ring.length === 0) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function ringBounds(ring: LngLat[]): Bounds | null {
  return screeningRingBounds(ring);
}

function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  return {
    minLon: Math.min(...list.map((b) => b.minLon)),
    minLat: Math.min(...list.map((b) => b.minLat)),
    maxLon: Math.max(...list.map((b) => b.maxLon)),
    maxLat: Math.max(...list.map((b) => b.maxLat)),
  };
}

export const useScreeningStore = create<ScreeningState>((set, get) => ({
  areas: [],
  selectedId: null,

  addArea: (ring, name) => {
    areaCounter += 1;
    const id = `screening-${areaCounter}`;
    const geom = geometryOf(ring);
    const area: ScreeningArea = {
      id,
      name: name ?? `Screening area ${areaCounter}`,
      ring,
      createdAt: new Date().toISOString(),
      ...geom,
    };
    set((state) => ({ areas: [...state.areas, area], selectedId: id }));
    return id;
  },

  updateRing: (id, ring) => {
    const geom = geometryOf(ring);
    set((state) => ({
      areas: state.areas.map((area) => (area.id === id ? { ...area, ring, ...geom } : area)),
    }));
  },

  rename: (id, name) => {
    set((state) => ({
      areas: state.areas.map((area) => (area.id === id ? { ...area, name } : area)),
    }));
  },

  remove: (id) => {
    set((state) => {
      const areas = state.areas.filter((area) => area.id !== id);
      const selectedId =
        state.selectedId === id ? (areas[0]?.id ?? null) : state.selectedId;
      return { areas, selectedId };
    });
  },

  select: (id) => set({ selectedId: id }),

  replaceAll: (areas) => {
    const maxNum = areas.reduce((max, area) => {
      const match = /^screening-(\d+)$/.exec(area.id);
      if (!match) return max;
      return Math.max(max, Number(match[1]));
    }, 0);
    areaCounter = Math.max(areaCounter, maxNum);
    set({
      areas,
      selectedId: areas[0]?.id ?? null,
    });
  },

  clear: () => set({ areas: [], selectedId: null }),

  selected: () => {
    const { areas, selectedId } = get();
    return areas.find((area) => area.id === selectedId) ?? null;
  },

  activeBounds: () => {
    const { areas, selectedId } = get();
    const selected = areas.find((area) => area.id === selectedId);
    if (selected?.geometryValid) {
      return ringBounds(selected.ring);
    }
    const boundsList = areas
      .filter((area) => area.geometryValid)
      .map((area) => ringBounds(area.ring))
      .filter((b): b is Bounds => b != null);
    return unionBounds(boundsList);
  },

  hasOversizedArea: () =>
    get().areas.some(
      (area) => area.geometryValid && area.areaM2 / 1e6 > SCREENING_AREA_WARN_KM2,
    ),
}));
