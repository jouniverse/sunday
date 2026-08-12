/**
 * Insights view UI state — which feature is open, map/table modes, selections.
 *
 * Data itself lives in services / bundles; this store only remembers chrome.
 */

import { create } from "zustand";

export type InsightsFeature =
  | "portfolio"
  | "rankings"
  | "statistics"
  | "news"
  | "wb_projects"
  | "research";

export type RankingsMode = "map" | "table";
export type ResearchMode = "search" | "news";
export type StatisticsScope = "countries" | "global";

interface InsightsStoreState {
  feature: InsightsFeature;
  rankingsMode: RankingsMode;
  researchMode: ResearchMode;
  statisticsScope: StatisticsScope;
  selectedIndicatorId: string;
  selectedCountryIso3: string | null;
  selectedNewsFeedId: string | null;
  selectedResearchFeedId: string | null;
  setFeature: (feature: InsightsFeature) => void;
  setRankingsMode: (mode: RankingsMode) => void;
  setResearchMode: (mode: ResearchMode) => void;
  setStatisticsScope: (scope: StatisticsScope) => void;
  setSelectedIndicatorId: (id: string) => void;
  setSelectedCountryIso3: (iso3: string | null) => void;
  setSelectedNewsFeedId: (id: string | null) => void;
  setSelectedResearchFeedId: (id: string | null) => void;
}

export const useInsightsStore = create<InsightsStoreState>((set) => ({
  feature: "portfolio",
  rankingsMode: "table",
  researchMode: "search",
  statisticsScope: "countries",
  selectedIndicatorId: "irena_capacity_gw",
  selectedCountryIso3: null,
  selectedNewsFeedId: null,
  selectedResearchFeedId: null,
  setFeature: (feature) => set({ feature }),
  setRankingsMode: (rankingsMode) => set({ rankingsMode }),
  setResearchMode: (researchMode) => set({ researchMode }),
  setStatisticsScope: (statisticsScope) => set({ statisticsScope }),
  setSelectedIndicatorId: (selectedIndicatorId) => set({ selectedIndicatorId }),
  setSelectedCountryIso3: (selectedCountryIso3) => set({ selectedCountryIso3 }),
  setSelectedNewsFeedId: (selectedNewsFeedId) => set({ selectedNewsFeedId }),
  setSelectedResearchFeedId: (selectedResearchFeedId) => set({ selectedResearchFeedId }),
}));
