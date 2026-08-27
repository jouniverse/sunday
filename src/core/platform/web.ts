/**
 * Browser fallback for the platform interface.
 *
 * This exists so the whole UI, and all of `src/domain`, can be run and tested
 * without building the Rust shell. Capabilities that genuinely need native code
 * fail with an explanatory `PlatformError` rather than pretending to work —
 * a fake zonal statistic would be far worse than an honest refusal.
 */

import type {
  ApiProvider,
  AppInfo,
  BboxQuery,
  BboxResult,
  DatasetSummary,
  EngineStatus,
  LibraryIndex,
  LoadedProject,
  NearbyFeature,
  PlantCentroid,
  Platform,
  ProjectDocument,
  SettingsView,
  VectorFeature,
  ViewportPreview,
  ZonalResult,
} from "./types";
import { PlatformError, unavailable } from "./types";

const STORAGE_KEY = "sunday.settings.v1";
const LIBRARY_INDEX_KEY = "sunday.library.index.v1";
const libraryDocKey = (id: string) => `sunday.library.doc.v1.${id}`;
/** In development the Vite dev server proxies this to the local engine. */
const ENGINE_BASE = "/solar-engine";

function readLibraryIndex(): LibraryIndex {
  try {
    const raw = localStorage.getItem(LIBRARY_INDEX_KEY);
    if (!raw) return { activeId: null, entries: [] };
    const parsed = JSON.parse(raw) as LibraryIndex;
    return {
      activeId: parsed.activeId ?? null,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { activeId: null, entries: [] };
  }
}

function writeLibraryIndex(index: LibraryIndex): void {
  localStorage.setItem(LIBRARY_INDEX_KEY, JSON.stringify(index));
}

interface HealthPayload {
  pvlib_version?: string;
  pvlibVersion?: string;
  pysam_version?: string | null;
  pysamVersion?: string | null;
  csp_available?: boolean;
  cspAvailable?: boolean;
}

async function probeEngine(): Promise<EngineStatus> {
  try {
    const response = await fetch(`${ENGINE_BASE}/health`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) {
      return {
        state: "stopped",
        baseUrl: ENGINE_BASE,
        token: null,
        detail:
          "Solar engine is not answering /health. Start it with `npm run engine:dev` or from Settings.",
        pvlibVersion: null,
        pysamVersion: null,
        cspAvailable: false,
        external: true,
      };
    }
    const body = (await response.json()) as HealthPayload;
    return {
      state: "ready",
      baseUrl: ENGINE_BASE,
      token: null,
      detail: "Local pvlib sidecar reached via the Vite /solar-engine proxy.",
      pvlibVersion: body.pvlibVersion ?? body.pvlib_version ?? null,
      pysamVersion: body.pysamVersion ?? body.pysam_version ?? null,
      cspAvailable: Boolean(body.cspAvailable ?? body.csp_available),
      external: true,
    };
  } catch {
    return {
      state: "stopped",
      baseUrl: ENGINE_BASE,
      token: null,
      detail:
        "Could not reach the solar engine. Start it with `npm run engine:dev` in a terminal, then wait a few seconds.",
      pvlibVersion: null,
      pysamVersion: null,
      cspAvailable: false,
      external: true,
    };
  }
}

interface StoredSettings {
  apiKeys: Partial<Record<ApiProvider, string>>;
  preferences: Record<string, unknown>;
  rasterSources: Record<string, unknown>;
  datasets: Record<string, unknown>;
  onboardingComplete: boolean;
}

function read(): StoredSettings {
  const empty: StoredSettings = {
    apiKeys: {},
    preferences: {},
    rasterSources: {},
    datasets: {},
    onboardingComplete: false,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const settings = raw ? { ...empty, ...(JSON.parse(raw) as StoredSettings) } : empty;
    if (migrateNrelApiKey(settings)) write(settings);
    return settings;
  } catch {
    return empty;
  }
}

/** Lab renamed NREL → NLR in December 2025; keep a previously stored key. */
function migrateNrelApiKey(settings: StoredSettings): boolean {
  const keys = settings.apiKeys as Record<string, string | undefined>;
  const legacy = keys.nrel;
  if (typeof legacy !== "string") return false;
  if (!keys.nlr?.trim() && legacy.trim()) {
    keys.nlr = legacy;
  }
  delete keys.nrel;
  return true;
}

function write(settings: StoredSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota: settings simply do not persist.
  }
}

function view(settings: StoredSettings): SettingsView {
  return {
    configuredKeys: (Object.keys(settings.apiKeys) as ApiProvider[]).filter((provider) =>
      Boolean(settings.apiKeys[provider]?.trim()),
    ),
    preferences: settings.preferences,
    rasterSources: settings.rasterSources,
    datasets: settings.datasets,
    onboardingComplete: settings.onboardingComplete,
    settingsPath: "browser localStorage",
    dataDir: "unavailable in the browser",
  };
}

/** Triggers a browser download; there is no filesystem to write to. */
function download(name: string, contents: string | Uint8Array): void {
  const blob =
    typeof contents === "string"
      ? new Blob([contents], { type: "text/plain;charset=utf-8" })
      : new Blob([contents as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const webPlatform: Platform = {
  kind: "web",

  async appInfo(): Promise<AppInfo> {
    const engine = await probeEngine();
    return {
      version: "dev",
      dataDir: "unavailable in the browser",
      configDir: "unavailable in the browser",
      rasterDir: "unavailable in the browser",
      vectorDir: "unavailable in the browser",
      vectorStore: "unavailable in the browser",
      engine,
    };
  },

  async resolveLocalFileUrl() {
    return null;
  },

  settings: {
    async get() {
      return view(read());
    },
    async setApiKey(provider, key) {
      const settings = read();
      if (key?.trim()) {
        settings.apiKeys[provider] = key.trim();
      } else {
        delete settings.apiKeys[provider];
      }
      write(settings);
      return view(settings);
    },
    async revealApiKey(provider) {
      return read().apiKeys[provider] ?? null;
    },
    async update(patch) {
      const settings = read();
      if (patch.preferences) settings.preferences = patch.preferences;
      if (patch.rasterSources) settings.rasterSources = patch.rasterSources;
      if (patch.datasets) settings.datasets = patch.datasets;
      if (patch.onboardingComplete !== undefined) {
        settings.onboardingComplete = patch.onboardingComplete;
      }
      write(settings);
      return view(settings);
    },
  },

  project: {
    async save(path: string, project: ProjectDocument) {
      // No filesystem: hand the document to the browser as a download.
      download(
        path.endsWith(".sunday") ? path : `${path}.sunday`,
        JSON.stringify(project, null, 2),
      );
      return path;
    },
    async load(): Promise<LoadedProject> {
      throw unavailable("Opening a project from disk");
    },
    async pickSavePath(defaultName: string) {
      return defaultName;
    },
    async pickOpenPath() {
      throw unavailable("The file open dialog");
    },
  },

  library: {
    async list() {
      return readLibraryIndex();
    },
    async saveEntry(id: string, project: ProjectDocument) {
      const path = `browser://${id}.sunday`;
      localStorage.setItem(libraryDocKey(id), JSON.stringify(project));
      const index = readLibraryIndex();
      const entry = {
        id,
        name: project.name,
        path,
        updatedAt: project.updatedAt,
      };
      const existing = index.entries.findIndex((row) => row.id === id);
      if (existing >= 0) index.entries[existing] = entry;
      else index.entries.push(entry);
      index.activeId = id;
      writeLibraryIndex(index);
      return index;
    },
    async deleteEntry(id: string) {
      localStorage.removeItem(libraryDocKey(id));
      const index = readLibraryIndex();
      index.entries = index.entries.filter((row) => row.id !== id);
      if (index.activeId === id) {
        index.activeId = index.entries[0]?.id ?? null;
      }
      writeLibraryIndex(index);
      return index;
    },
    async setActive(id: string | null) {
      const index = readLibraryIndex();
      if (id && !index.entries.some((row) => row.id === id)) {
        throw new PlatformError("invalid", `Unknown library project ${id}`);
      }
      index.activeId = id;
      writeLibraryIndex(index);
      return index;
    },
    async loadEntry(id: string): Promise<LoadedProject> {
      const raw = localStorage.getItem(libraryDocKey(id));
      if (!raw) {
        throw new PlatformError("invalid", `Unknown library project ${id}`);
      }
      const project = JSON.parse(raw) as ProjectDocument;
      return {
        path: `browser://${id}.sunday`,
        project,
        fromNewerSchema: false,
      };
    },
  },

  raster: {
    async info() {
      throw unavailable("Reading GeoTIFF metadata");
    },
    async zonalStats(): Promise<ZonalResult> {
      throw unavailable("Zonal statistics over raster data");
    },
    async viewportPreview(): Promise<ViewportPreview> {
      throw unavailable("Solar resource map overlays");
    },
  },

  terrain: {
    async slopePreview() {
      throw unavailable("Terrain slope map overlays");
    },
    async slopeZonal() {
      throw unavailable("Terrain slope sampling");
    },
    async horizonProfile() {
      throw unavailable("Terrain horizon profile");
    },
  },

  landcover: {
    async preview() {
      throw unavailable("Land cover map overlays");
    },
  },

  vector: {
    async datasets(): Promise<DatasetSummary[]> {
      // An empty list rather than an error: "no datasets installed" is a normal
      // state that the layer panel already knows how to present.
      return [];
    },
    async queryBbox(_query: BboxQuery): Promise<BboxResult> {
      return { features: [], total: 0, truncated: false };
    },
    async listCentroids(): Promise<PlantCentroid[]> {
      return [];
    },
    async getFeature(): Promise<VectorFeature | null> {
      return null;
    },
    async nearest(): Promise<NearbyFeature[]> {
      return [];
    },
    async importFeatures(): Promise<number> {
      throw unavailable("Importing a dataset");
    },
  },

  datasets: {
    async pickDirectory() {
      throw unavailable("Choosing a datasets folder");
    },
    async gdalAvailable() {
      return false;
    },
    async discover() {
      throw unavailable("Discovering datasets");
    },
    async install() {
      throw unavailable("Installing a dataset");
    },
  },

  engine: {
    async status() {
      return probeEngine();
    },
    async start() {
      // Browser cannot spawn processes; probe and guide the user.
      const status = await probeEngine();
      if (status.state === "ready") return status;
      return {
        ...status,
        state: "unavailable",
        detail:
          "In browser dev, start the sidecar yourself with `npm run engine:dev`, then click Start again to refresh status.",
      };
    },
    async stop() {
      return {
        state: "stopped",
        baseUrl: ENGINE_BASE,
        token: null,
        detail:
          "Browser dev cannot stop an external sidecar. Interrupt the `npm run engine:dev` terminal instead.",
        pvlibVersion: null,
        pysamVersion: null,
        cspAvailable: false,
        external: true,
      };
    },
    async call<TRequest, TResponse>(endpoint: string, body: TRequest): Promise<TResponse> {
      const response = await fetch(`${ENGINE_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);

      if (!response) {
        throw new PlatformError(
          "engine_unavailable",
          "Could not reach the solar engine. Start it with `npm run engine:dev`.",
        );
      }
      if (!response.ok) {
        throw new PlatformError(
          "engine_unavailable",
          `Solar engine rejected ${endpoint} (${response.status}): ${await response.text()}`,
        );
      }
      return (await response.json()) as TResponse;
    },
  },

  shell: {
    async openExternal(url: string) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    async saveFile(suggestedName, contents) {
      download(suggestedName, contents);
      return suggestedName;
    },
    async confirm(message) {
      return window.confirm(message);
    },
  },

  http: {
    async fetchText(request) {
      const controller = new AbortController();
      const timer =
        request.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), request.timeoutMs)
          : null;
      try {
        const response = await fetch(request.url, {
          method: request.method ?? "GET",
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
        return { status: response.status, body: await response.text() };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  },
};
