/**
 * Multi-project library: index of `.sunday` documents the user can switch between.
 *
 * The active project still lives in `projectStore` + site/layer/map stores. This
 * store owns the catalogue, persistence into the app data dir (or localStorage
 * in the browser), and restore-on-launch of the last active id.
 */

import { create } from "zustand";
import { platform } from "../platform";
import type { LibraryEntry, ProjectDocument } from "../platform";
import { useDrawStore } from "../map/draw/store";
import { useLayerStore } from "./layerStore";
import type { LayerRuntimeState } from "./layerStore";
import { useMapStore } from "./mapStore";
import type { Viewport } from "./mapStore";
import { useProjectStore } from "./projectStore";
import { useSiteStore } from "./siteStore";
import type { Site } from "./siteStore";

/** Cancels in-progress draw gestures and returns the map to pan. */
function resetMapInteraction(): void {
  useDrawStore.getState().cancel();
  useMapStore.getState().setTool("pan");
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ensures library names stay unique (case-insensitive). */
export function uniqueProjectName(desired: string, existing: string[]): string {
  const base = desired.trim() || "Untitled project";
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`.toLowerCase())) n += 1;
  return `${base} (${n})`;
}

function applyDocument(document: ProjectDocument, path: string, fromNewerSchema: boolean): void {
  resetMapInteraction();
  if (Array.isArray(document.sites)) {
    useSiteStore.getState().replaceAll(document.sites as Site[]);
  } else {
    useSiteStore.getState().clear();
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

  useProjectStore.setState({
    name: document.name,
    path,
    createdAt: document.createdAt,
    dirty: false,
    lastSavedAt: new Date().toISOString(),
    loadedFromNewerSchema: fromNewerSchema,
    libraryId: (document as { libraryId?: string }).libraryId ?? null,
  });
}

interface ProjectLibraryState {
  entries: LibraryEntry[];
  activeId: string | null;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  createProject: (name?: string) => Promise<string>;
  switchProject: (id: string) => Promise<boolean>;
  renameActive: (name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Persist the in-memory project into the library (also marks active). */
  saveActiveToLibrary: () => Promise<void>;
}

export const useProjectLibraryStore = create<ProjectLibraryState>((set, get) => ({
  entries: [],
  activeId: null,
  hydrated: false,

  hydrate: async () => {
    const index = await platform().library.list();
    set({ entries: index.entries, activeId: index.activeId, hydrated: true });

    if (index.activeId) {
      try {
        const loaded = await platform().library.loadEntry(index.activeId);
        applyDocument(loaded.project, loaded.path, loaded.fromNewerSchema);
        useProjectStore.setState({ libraryId: index.activeId });
        return;
      } catch {
        // Fall through and ensure there is at least one project.
      }
    }

    if (index.entries.length === 0) {
      await get().createProject("Untitled project");
    } else if (index.entries[0]) {
      await get().switchProject(index.entries[0].id);
    }
  },

  createProject: async (name = "Untitled project") => {
    const uniqueName = uniqueProjectName(name, get().entries.map((entry) => entry.name));
    const id = newId();
    resetMapInteraction();
    useSiteStore.getState().clear();
    const createdAt = new Date().toISOString();
    useProjectStore.setState({
      name: uniqueName,
      path: null,
      createdAt,
      dirty: false,
      lastSavedAt: null,
      loadedFromNewerSchema: false,
      libraryId: id,
    });

    const document = useProjectStore.getState().serialise();
    const index = await platform().library.saveEntry(id, document);
    set({ entries: index.entries, activeId: index.activeId });
    useProjectStore.setState({
      path: index.entries.find((entry) => entry.id === id)?.path ?? null,
      dirty: false,
      lastSavedAt: new Date().toISOString(),
    });
    return id;
  },

  switchProject: async (id) => {
    if (id === get().activeId) return true;

    const project = useProjectStore.getState();
    if (project.dirty) {
      // Never use window.confirm in Tauri — it throws dialog.confirm not allowed.
      const saveFirst = await platform().shell.confirm(
        `"${project.name}" has unsaved changes. Save before switching?`,
        "Unsaved changes",
      );
      if (saveFirst) {
        await get().saveActiveToLibrary();
      } else {
        const discard = await platform().shell.confirm(
          "Discard unsaved changes and switch anyway?",
          "Discard changes",
        );
        if (!discard) return false;
      }
    }

    const loaded = await platform().library.loadEntry(id);
    applyDocument(loaded.project, loaded.path, loaded.fromNewerSchema);
    useProjectStore.setState({ libraryId: id });
    const index = await platform().library.setActive(id);
    set({ entries: index.entries, activeId: index.activeId });
    return true;
  },

  renameActive: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name cannot be empty.");
    const activeId = get().activeId;
    const clash = get().entries.some(
      (entry) =>
        entry.id !== activeId && entry.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (clash) {
      throw new Error(`A project named “${trimmed}” already exists. Choose a different name.`);
    }
    useProjectStore.getState().rename(trimmed);
    await get().saveActiveToLibrary();
  },

  deleteProject: async (id) => {
    const { entries, activeId } = get();
    if (entries.length <= 1) {
      throw new Error("Keep at least one project in the library.");
    }
    const index = await platform().library.deleteEntry(id);
    set({ entries: index.entries, activeId: index.activeId });

    if (activeId === id && index.activeId) {
      const loaded = await platform().library.loadEntry(index.activeId);
      applyDocument(loaded.project, loaded.path, loaded.fromNewerSchema);
      useProjectStore.setState({ libraryId: index.activeId });
    } else if (activeId === id) {
      await get().createProject("Untitled project");
    }
  },

  saveActiveToLibrary: async () => {
    let id = useProjectStore.getState().libraryId;
    if (!id) {
      id = newId();
      useProjectStore.setState({ libraryId: id });
    }
    const document = useProjectStore.getState().serialise();
    const index = await platform().library.saveEntry(id, document);
    set({ entries: index.entries, activeId: index.activeId });
    useProjectStore.setState({
      path: index.entries.find((entry) => entry.id === id)?.path ?? null,
      dirty: false,
      lastSavedAt: new Date().toISOString(),
    });
  },
}));
