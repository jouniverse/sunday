/**
 * Shared multi-source solar report cache.
 *
 * Project inspector and Report view both call `generateSiteReport`. Caching by
 * rounded coordinates means Fetch Solar Resource and Generate report reuse the
 * same responses for an hour (HTTP cache) and for the session (this store).
 */

import { create } from "zustand";
import type { SiteReport } from "@/services/solar/orchestrator";

function cacheKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

interface ResourceCacheState {
  byLocation: Record<string, SiteReport>;
  get: (latitude: number, longitude: number) => SiteReport | null;
  set: (latitude: number, longitude: number, report: SiteReport) => void;
  clear: () => void;
}

export const useResourceCacheStore = create<ResourceCacheState>((set, get) => ({
  byLocation: {},

  get: (latitude, longitude) => get().byLocation[cacheKey(latitude, longitude)] ?? null,

  set: (latitude, longitude, report) =>
    set((state) => ({
      byLocation: { ...state.byLocation, [cacheKey(latitude, longitude)]: report },
    })),

  clear: () => set({ byLocation: {} }),
}));
