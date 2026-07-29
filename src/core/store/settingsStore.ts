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
  /** Local directory holding user-supplied rasters. */
  rasterLocalDir: string;
  /** Accept the CC BY-NC licence gate on TZ-SAM. */
  acceptNonCommercialLayers: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  units: "metric",
  currency: "USD",
  allowFirstOrderFallback: true,
  rasterBaseUrl: "",
  rasterLocalDir: "",
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

function applyView(view: SettingsView) {
  return {
    loaded: true,
    configuredKeys: view.configuredKeys,
    preferences: { ...DEFAULT_PREFERENCES, ...(view.preferences as Partial<Preferences>) },
    datasets: (view.datasets ?? {}) as SettingsState["datasets"],
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
