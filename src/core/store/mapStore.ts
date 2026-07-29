/**
 * Map view state.
 *
 * Adapted from GeoLibre's store-driven map controller pattern: React never talks
 * to the MapLibre instance directly. Components read this store, and a single
 * effect in `MapView` reconciles the map to it. That is what keeps panels, the
 * status bar and the map from fighting over the camera.
 */

import { create } from "zustand";
import type { BasemapId } from "../map/basemaps";
import { metresPerPixel } from "../map/basemaps";

export interface Viewport {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface Bounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** Default view: the Mojave, which is where the prototypes are anchored. */
const DEFAULT_VIEWPORT: Viewport = {
  longitude: -118.174,
  latitude: 35.052,
  zoom: 12,
  bearing: 0,
  pitch: 0,
};

export type MapTool = "pan" | "draw-polygon" | "place-point" | "measure";

interface MapState {
  viewport: Viewport;
  bounds: Bounds | null;
  basemap: BasemapId;
  /** True while a 3D terrain mesh is enabled on a terrain-capable basemap. */
  terrain3d: boolean;
  tool: MapTool;
  /** Cursor position in geographic coordinates, for the status bar. */
  cursor: { longitude: number; latitude: number } | null;
  /** Ground resolution at the current camera, cached for the draw engine. */
  metresPerPixel: number;

  setViewport: (viewport: Viewport) => void;
  setBounds: (bounds: Bounds) => void;
  setBasemap: (basemap: BasemapId) => void;
  setTerrain3d: (enabled: boolean) => void;
  setTool: (tool: MapTool) => void;
  setCursor: (cursor: { longitude: number; latitude: number } | null) => void;
  /** Requests a camera move; `MapView` applies it and clears the request. */
  flyTo: (target: Partial<Viewport> & { longitude: number; latitude: number }) => void;
  pendingFlyTo: (Partial<Viewport> & { longitude: number; latitude: number }) | null;
  clearFlyTo: () => void;
  fitBounds: (bounds: Bounds) => void;
  pendingFitBounds: Bounds | null;
  clearFitBounds: () => void;
}

export const useMapStore = create<MapState>((set) => ({
  viewport: DEFAULT_VIEWPORT,
  bounds: null,
  basemap: "satellite",
  terrain3d: false,
  tool: "pan",
  cursor: null,
  metresPerPixel: metresPerPixel(DEFAULT_VIEWPORT.zoom, DEFAULT_VIEWPORT.latitude),
  pendingFlyTo: null,
  pendingFitBounds: null,

  setViewport: (viewport) =>
    set({ viewport, metresPerPixel: metresPerPixel(viewport.zoom, viewport.latitude) }),
  setBounds: (bounds) => set({ bounds }),
  setBasemap: (basemap) => set({ basemap }),
  setTerrain3d: (terrain3d) => set({ terrain3d }),
  setTool: (tool) => set({ tool }),
  setCursor: (cursor) => set({ cursor }),

  flyTo: (target) => set({ pendingFlyTo: target }),
  clearFlyTo: () => set({ pendingFlyTo: null }),
  fitBounds: (bounds) => set({ pendingFitBounds: bounds }),
  clearFitBounds: () => set({ pendingFitBounds: null }),
}));
