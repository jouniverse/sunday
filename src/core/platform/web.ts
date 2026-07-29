/**
 * Browser fallback for the platform interface.
 *
 * This exists so the whole UI, and all of `src/domain`, can be run and tested
 * without building the Rust shell. Capabilities that genuinely need native code
 * fail with an explanatory `PlatformError` rather than pretending to work —
 * a fake zonal statistic would be far worse than an honest refusal.
 */

import type {
  AppInfo,
  ApiProvider,
  BboxQuery,
  BboxResult,
  DatasetSummary,
  EngineStatus,
  LoadedProject,
  NearbyFeature,
  Platform,
  ProjectDocument,
  SettingsView,
  VectorFeature,
  ZonalResult,
} from "./types";
import { PlatformError, unavailable } from "./types";

const STORAGE_KEY = "sunday.settings.v1";
/** In development the Vite dev server proxies this to the local engine. */
const ENGINE_BASE = "/solar-engine";

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
    return raw ? { ...empty, ...(JSON.parse(raw) as StoredSettings) } : empty;
  } catch {
    return empty;
  }
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

const engineStatus: EngineStatus = {
  state: "ready",
  baseUrl: ENGINE_BASE,
  token: null,
  detail: "Development mode: the engine must be started manually with `npm run engine:dev`.",
  pvlibVersion: null,
  external: true,
};

export const webPlatform: Platform = {
  kind: "web",

  async appInfo(): Promise<AppInfo> {
    return {
      version: "dev",
      dataDir: "unavailable in the browser",
      configDir: "unavailable in the browser",
      rasterDir: "unavailable in the browser",
      vectorStore: "unavailable in the browser",
      engine: engineStatus,
    };
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
      download(path.endsWith(".sunday") ? path : `${path}.sunday`, JSON.stringify(project, null, 2));
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

  raster: {
    async info() {
      throw unavailable("Reading GeoTIFF metadata");
    },
    async zonalStats(): Promise<ZonalResult> {
      throw unavailable("Zonal statistics over raster data");
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

  engine: {
    async status() {
      return engineStatus;
    },
    async start() {
      return engineStatus;
    },
    async stop() {
      return engineStatus;
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
  },
};
