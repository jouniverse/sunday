/**
 * Project document lifecycle: new, open, save, dirty tracking.
 *
 * The project is the unit of work a user keeps on disk. This store owns the
 * document metadata and orchestrates serialisation of the other stores, so there
 * is exactly one place that knows the file format.
 */

import { create } from "zustand";
import { platform } from "../platform";
import type { ProjectDocument } from "../platform";
import { useLayerStore } from "./layerStore";
import type { LayerRuntimeState } from "./layerStore";
import { useMapStore } from "./mapStore";
import type { Viewport } from "./mapStore";
import { useSiteStore } from "./siteStore";
import type { Site } from "./siteStore";

const APP_VERSION = "0.1.0";

interface ProjectState {
  name: string;
  path: string | null;
  createdAt: string;
  /** Unsaved changes present. Drives the window title and a close prompt. */
  dirty: boolean;
  lastSavedAt: string | null;
  /** Set when a file was written by a newer schema than this build understands. */
  loadedFromNewerSchema: boolean;

  markDirty: () => void;
  rename: (name: string) => void;
  newProject: () => void;
  serialise: () => ProjectDocument;
  save: (path?: string) => Promise<string | null>;
  open: (path?: string) => Promise<boolean>;
}

interface SundaySections {
  sites: Site[];
  layers: Record<string, LayerRuntimeState>;
  view: Viewport & { basemap: string; terrain3d: boolean };
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  name: "Untitled project",
  path: null,
  createdAt: new Date().toISOString(),
  dirty: false,
  lastSavedAt: null,
  loadedFromNewerSchema: false,

  markDirty: () => set({ dirty: true }),
  rename: (name) => set({ name, dirty: true }),

  newProject: () => {
    useSiteStore.getState().clear();
    set({
      name: "Untitled project",
      path: null,
      createdAt: new Date().toISOString(),
      dirty: false,
      lastSavedAt: null,
      loadedFromNewerSchema: false,
    });
  },

  serialise: () => {
    const map = useMapStore.getState();
    const sections: SundaySections = {
      sites: useSiteStore.getState().sites,
      layers: useLayerStore.getState().runtime,
      view: { ...map.viewport, basemap: map.basemap, terrain3d: map.terrain3d },
    };
    return {
      schema: 1,
      name: get().name,
      createdAt: get().createdAt,
      updatedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      sites: sections.sites,
      designs: [],
      layers: sections.layers,
      view: sections.view,
    };
  },

  save: async (path) => {
    const target = path ?? get().path ?? (await platform().project.pickSavePath(`${get().name}.sunday`));
    if (!target) return null;

    const saved = await platform().project.save(target, get().serialise());
    set({ path: saved, dirty: false, lastSavedAt: new Date().toISOString() });
    return saved;
  },

  open: async (path) => {
    const target = path ?? (await platform().project.pickOpenPath());
    if (!target) return false;

    const loaded = await platform().project.load(target);
    const document = loaded.project;

    // Restore the sections this build understands; anything else was preserved
    // verbatim by the Rust layer and will be written back untouched.
    if (Array.isArray(document.sites)) {
      useSiteStore.getState().replaceAll(document.sites as Site[]);
    }
    if (document.layers && typeof document.layers === "object") {
      useLayerStore.getState().replaceAll(document.layers as Record<string, LayerRuntimeState>);
    }
    const view = document.view as (Viewport & { basemap?: string; terrain3d?: boolean }) | undefined;
    if (view && typeof view.zoom === "number") {
      const map = useMapStore.getState();
      map.setViewport({
        longitude: view.longitude,
        latitude: view.latitude,
        zoom: view.zoom,
        bearing: view.bearing ?? 0,
        pitch: view.pitch ?? 0,
      });
      if (view.basemap) map.setBasemap(view.basemap as never);
      map.setTerrain3d(Boolean(view.terrain3d));
    }

    set({
      name: document.name,
      path: loaded.path,
      createdAt: document.createdAt,
      dirty: false,
      lastSavedAt: new Date().toISOString(),
      loadedFromNewerSchema: loaded.fromNewerSchema,
    });
    return true;
  },
}));
