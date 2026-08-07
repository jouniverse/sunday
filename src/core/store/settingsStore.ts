/**
 * Settings, mirrored from the native layer.
 *
 * Key *values* never live here — only the list of which providers are configured.
 * A value is fetched for the duration of a single outbound request and then
 * dropped, so no part of the React tree ever holds a secret.
 */

import { create } from "zustand";
import type { ApiProvider, SettingsView } from "../platform";
import { platform } from "../platform";

export interface Preferences {
  units: "metric" | "imperial";
  currency: string;
  /** Show a first-order estimate when the solar engine is unavailable. */
  allowFirstOrderFallback: boolean;
  /** Base URL for Solargis/GSA cloud-optimised rasters, if the team hosts them. */
  rasterBaseUrl: string;
  /** Local directory holding installed/app-registered rasters (usually `{dataDir}/rasters`). */
  rasterLocalDir: string;
  /**
   * User-picked folder of raw downloads (Solargis, GEM, TZ-SAM, GM-SEUS, …).
   * Install discovers expected basenames under this root.
   */
  datasetsRoot: string;
  /** Accept the CC BY-NC licence gate on TZ-SAM. */
  acceptNonCommercialLayers: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  units: "metric",
  currency: "USD",
  allowFirstOrderFallback: true,
  rasterBaseUrl: "",
  rasterLocalDir: "",
  datasetsRoot: "",
  acceptNonCommercialLayers: false,
};

interface SettingsState {
  loaded: boolean;
  configuredKeys: ApiProvider[];
  preferences: Preferences;
  datasets: Record<string, { downloaded: boolean; path?: string; sizeMb?: number }>;
  settingsPath: string;
  dataDir: string;
  onboardingComplete: boolean;

  load: () => Promise<void>;
  setApiKey: (provider: ApiProvider, key: string | null) => Promise<void>;
  hasKey: (provider: ApiProvider) => boolean;
  /** Fetches a key for one request. Never stored in the React tree. */
  useKey: (provider: ApiProvider) => Promise<string | null>;
  setPreferences: (patch: Partial<Preferences>) => Promise<void>;
  setDatasetState: (
    dataset: string,
    state: { downloaded: boolean; path?: string; sizeMb?: number },
  ) => Promise<void>;
  completeOnboarding: () => Promise<void>;
}

function normalizeDatasets(
  raw: unknown,
): SettingsState["datasets"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: SettingsState["datasets"] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    out[key] = {
      downloaded: Boolean(row.downloaded),
      path: typeof row.path === "string" ? row.path : undefined,
      sizeMb: typeof row.sizeMb === "number" ? row.sizeMb : undefined,
    };
  }
  return out;
}

function applyView(view: SettingsView) {
  const preferences = {
    ...DEFAULT_PREFERENCES,
    ...(view.preferences as Partial<Preferences>),
  };
  // One-time migration: older builds only had rasterLocalDir as the folder hint.
  if (!preferences.datasetsRoot.trim() && preferences.rasterLocalDir.trim()) {
    preferences.datasetsRoot = preferences.rasterLocalDir;
  }
  return {
    loaded: true,
    configuredKeys: view.configuredKeys,
    preferences,
    datasets: normalizeDatasets(view.datasets),
    settingsPath: view.settingsPath,
    dataDir: view.dataDir,
    onboardingComplete: view.onboardingComplete,
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  loaded: false,
  configuredKeys: [],
  preferences: DEFAULT_PREFERENCES,
  datasets: {},
  settingsPath: "",
  dataDir: "",
  onboardingComplete: false,

  load: async () => {
    const view = await platform().settings.get();
    set(applyView(view));
    // SQLite is source of truth for vector installs — repair Settings chips and
    // Layer panel usability if the JSON flag drifted (e.g. after a reinstall).
    await syncDownloadedFromVectorStore(set, get);
  },

  setApiKey: async (provider, key) => {
    const view = await platform().settings.setApiKey(provider, key);
    set(applyView(view));
  },

  hasKey: (provider) => get().configuredKeys.includes(provider),

  useKey: (provider) => platform().settings.revealApiKey(provider),

  setPreferences: async (patch) => {
    const preferences = { ...get().preferences, ...patch };
    const view = await platform().settings.update({ preferences });
    set(applyView(view));
  },

  setDatasetState: async (dataset, state) => {
    const datasets = { ...get().datasets, [dataset]: state };
    const view = await platform().settings.update({ datasets });
    set(applyView(view));
  },

  completeOnboarding: async () => {
    const view = await platform().settings.update({ onboardingComplete: true });
    set(applyView(view));
  },
}));

/**
 * Mark any vector dataset that already has rows in the app store as downloaded.
 * Fixes “Installed in Settings but greyed out in Layers” after a flag mismatch.
 */
async function syncDownloadedFromVectorStore(
  set: (partial: ReturnType<typeof applyView>) => void,
  get: () => SettingsState,
): Promise<void> {
  try {
    const summaries = await platform().vector.datasets();
    if (summaries.length === 0) return;

    const current = { ...get().datasets };
    let changed = false;
    for (const row of summaries) {
      if (row.featureCount <= 0) continue;
      if (current[row.dataset]?.downloaded) continue;
      current[row.dataset] = {
        ...current[row.dataset],
        downloaded: true,
      };
      changed = true;
    }
    if (!changed) return;

    const view = await platform().settings.update({ datasets: current });
    set(applyView(view));
  } catch {
    // Browser fallback has no vector store; ignore.
  }
}
