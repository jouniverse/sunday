/**
 * Tauri implementation of the platform interface.
 *
 * Every call funnels through `call()` so native errors arrive as `PlatformError`
 * with their `kind` intact, which is what lets features distinguish "no data
 * here" from "the file is missing" from "you have no API key".
 */

import type {
  AppInfo,
  ApiProvider,
  BboxQuery,
  BboxResult,
  DatasetDiscoverResult,
  DatasetInstallResult,
  DatasetSummary,
  EngineStatus,
  HttpFetchTextRequest,
  HttpFetchTextResult,
  LibraryIndex,
  LoadedProject,
  NativeError,
  NearbyFeature,
  PlantCentroid,
  Platform,
  ProjectDocument,
  RasterInfo,
  RasterSource,
  SettingsView,
  TerrainSlopeZonalResult,
  VectorFeature,
  ViewportPreview,
  ZonalResult,
} from "./types";
import { PlatformError } from "./types";

function isNativeError(value: unknown): value is NativeError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof (value as NativeError).message === "string"
  );
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return (await invoke(command, args)) as T;
  } catch (error) {
    if (isNativeError(error)) {
      throw new PlatformError(error.kind, error.message);
    }
    throw new PlatformError("invalid", String(error));
  }
}

/** Cached so repeated engine calls do not re-query the supervisor. */
let engineStatusCache: EngineStatus | null = null;

async function engineTarget(): Promise<EngineStatus> {
  if (engineStatusCache?.state === "ready") return engineStatusCache;
  engineStatusCache = await call<EngineStatus>("engine_status");
  if (engineStatusCache.state !== "ready") {
    // Start on demand: the engine is only needed once someone asks for physics.
    engineStatusCache = await call<EngineStatus>("engine_start");
  }
  return engineStatusCache;
}

export const tauriPlatform: Platform = {
  kind: "tauri",

  appInfo: () => call<AppInfo>("app_info"),

  async resolveLocalFileUrl(absolutePath: string) {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    return convertFileSrc(absolutePath);
  },

  settings: {
    get: () => call<SettingsView>("settings_get"),
    setApiKey: (provider: ApiProvider, key: string | null) =>
      call<SettingsView>("settings_set_api_key", { provider, key }),
    revealApiKey: (provider: ApiProvider) =>
      call<string | null>("settings_reveal_api_key", { provider }),
    update: (patch) => call<SettingsView>("settings_update", patch),
  },

  project: {
    save: (path: string, project: ProjectDocument) =>
      call<string>("project_save", { path, project }),
    load: (path: string) => call<LoadedProject>("project_load", { path }),

    async pickSavePath(defaultName: string) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      return await save({
        defaultPath: defaultName,
        filters: [{ name: "Sunday project", extensions: ["sunday"] }],
      });
    },

    async pickOpenPath() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Sunday project", extensions: ["sunday"] }],
      });
      return typeof picked === "string" ? picked : null;
    },
  },

  library: {
    list: () => call<LibraryIndex>("library_list"),
    saveEntry: (id: string, project: ProjectDocument) =>
      call<LibraryIndex>("library_save_entry", { id, project }),
    deleteEntry: (id: string) => call<LibraryIndex>("library_delete_entry", { id }),
    setActive: (id: string | null) => call<LibraryIndex>("library_set_active", { id }),
    async loadEntry(id: string) {
      const index = await call<LibraryIndex>("library_list");
      const entry = index.entries.find((row) => row.id === id);
      if (!entry) {
        throw new PlatformError("invalid", `Unknown library project ${id}`);
      }
      return call<LoadedProject>("project_load", { path: entry.path });
    },
  },

  raster: {
    info: (source: RasterSource) => call<RasterInfo>("raster_info", { source }),
    zonalStats: (source, rings, options) =>
      call<ZonalResult>("raster_zonal_stats", {
        request: {
          source,
          rings,
          band: options?.band ?? 0,
          geographic: options?.geographic ?? true,
        },
      }),
    viewportPreview: (source, bounds, options) =>
      call<ViewportPreview>("raster_viewport_preview", {
        request: {
          source,
          minLon: bounds.minLon,
          minLat: bounds.minLat,
          maxLon: bounds.maxLon,
          maxLat: bounds.maxLat,
          band: options?.band ?? 0,
          maxPixels: options?.maxPixels ?? 262_144,
        },
      }),
  },

  terrain: {
    slopePreview: (bounds) =>
      call<ViewportPreview>("terrain_slope_preview", {
        request: {
          minLon: bounds.minLon,
          minLat: bounds.minLat,
          maxLon: bounds.maxLon,
          maxLat: bounds.maxLat,
        },
      }),
    slopeZonal: (rings) =>
      call<TerrainSlopeZonalResult>("terrain_slope_zonal", {
        request: { rings },
      }),
  },

  landcover: {
    preview: (bounds) =>
      call<ViewportPreview>("landcover_preview", {
        request: {
          minLon: bounds.minLon,
          minLat: bounds.minLat,
          maxLon: bounds.maxLon,
          maxLat: bounds.maxLat,
        },
      }),
  },

  vector: {
    datasets: () => call<DatasetSummary[]>("vector_datasets"),
    queryBbox: (query: BboxQuery) => call<BboxResult>("vector_query_bbox", { query }),
    listCentroids: (dataset: string) => call<PlantCentroid[]>("vector_list_centroids", { dataset }),
    getFeature: (dataset: string, id: string) =>
      call<VectorFeature | null>("vector_get_feature", { dataset, id }),
    nearest: (dataset, lon, lat, radiusKm, limit) =>
      call<NearbyFeature[]>("vector_nearest", { dataset, lon, lat, radiusKm, limit }),
    importFeatures: ({ dataset, source, vintage, license, features }) =>
      call<number>("vector_import_features", {
        dataset,
        source,
        vintage: vintage ?? null,
        license: license ?? null,
        features,
      }),
  },

  datasets: {
    async pickDirectory() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: false, directory: true });
      return typeof picked === "string" ? picked : null;
    },
    gdalAvailable: () => call<boolean>("gdal_available"),
    discover: (root, datasetId) =>
      call<DatasetDiscoverResult>("dataset_discover", { root, dataset: datasetId }),
    install: (datasetId, sourcePath) =>
      call<DatasetInstallResult>("dataset_install", {
        dataset: datasetId,
        sourcePath,
      }),
  },

  engine: {
    status: async () => {
      engineStatusCache = await call<EngineStatus>("engine_status");
      return engineStatusCache;
    },
    start: async () => {
      engineStatusCache = await call<EngineStatus>("engine_start");
      return engineStatusCache;
    },
    stop: async () => {
      engineStatusCache = await call<EngineStatus>("engine_stop");
      return engineStatusCache;
    },

    async call<TRequest, TResponse>(endpoint: string, body: TRequest): Promise<TResponse> {
      const status = await engineTarget();
      if (status.state !== "ready") {
        throw new PlatformError(
          "engine_unavailable",
          status.detail ??
            "The solar engine is not running, so pvlib-backed results are unavailable.",
        );
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (status.token) headers.Authorization = `Bearer ${status.token}`;

      const response = await fetch(`${status.baseUrl}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new PlatformError(
          "engine_unavailable",
          `Solar engine rejected ${endpoint} (${response.status}): ${detail}`,
        );
      }
      return (await response.json()) as TResponse;
    },
  },

  shell: {
    async openExternal(url: string) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      try {
        await openUrl(url);
      } catch (error) {
        throw new PlatformError(
          "invalid",
          error instanceof Error
            ? error.message
            : `Could not open ${url} in the system browser`,
        );
      }
    },

    async saveFile(suggestedName, contents, filters) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: suggestedName, filters });
      if (!path) return null;
      // Written through our own command rather than the fs plugin: the user has
      // already chosen this exact path in the native dialog, so a broad
      // filesystem scope would be granting far more access than the task needs.
      if (typeof contents === "string") {
        await call<void>("write_file_text", { path, contents });
      } else {
        await call<void>("write_file_bytes", { path, contents: Array.from(contents) });
      }
      return path;
    },

    async confirm(message, title = "Sunday") {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return ask(message, { title, kind: "warning" });
    },
  },

  http: {
    fetchText: (request: HttpFetchTextRequest) =>
      call<HttpFetchTextResult>("http_fetch_text", { request }),
  },
};
