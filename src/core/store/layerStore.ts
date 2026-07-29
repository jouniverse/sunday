/**
 * Data layer catalogue and visibility.
 *
 * Every layer declares its provenance and its availability requirement, so the
 * layer panel can explain *why* something is unavailable instead of just greying
 * it out. That requirement comes straight from the dataset review: a layer whose
 * licence or download state is invisible is a layer waiting to be misused.
 */

import { create } from "zustand";
import { useSettingsStore } from "./settingsStore";

export type LayerKind = "raster" | "vector" | "derived";

export type LayerAvailability =
  | { state: "ready" }
  | { state: "needs-key"; provider: string }
  | { state: "needs-download"; dataset: string; approximateMb: number }
  | { state: "needs-desktop" }
  | { state: "licence-gated"; licence: string };

export interface LayerDefinition {
  id: string;
  label: string;
  group: "resource" | "infrastructure" | "land" | "context";
  kind: LayerKind;
  /** One line on what the layer is for. */
  purpose: string;
  source: string;
  vintage?: string;
  licence?: string;
  /** Whether the layer is usable right now, and if not what is missing. */
  availability: LayerAvailability;
  defaultVisible: boolean;
  /** Legend entries, for a categorical or ramped layer. */
  legend?: Array<{ colour: string; label: string }>;
  /** Units of the underlying values, for a raster. */
  units?: string;
}

export interface LayerRuntimeState {
  visible: boolean;
  opacity: number;
}

/**
 * The layer catalogue.
 *
 * P0 tier from the dataset review: GEM as the plant catalogue, GM-SEUS for US
 * array polygons and design priors, Solargis/GSA rasters as the resource canvas.
 * Everything else is declared but marked with what it needs.
 */
export const LAYER_CATALOGUE: LayerDefinition[] = [
  {
    id: "gsa-ghi",
    label: "Global horizontal irradiation",
    group: "resource",
    kind: "raster",
    purpose: "The primary solar resource surface for photovoltaic yield.",
    source: "Global Solar Atlas (Solargis / World Bank ESMAP)",
    vintage: "2020 release",
    licence: "CC BY 4.0",
    availability: { state: "needs-download", dataset: "gsa-ghi", approximateMb: 480 },
    defaultVisible: false,
    units: "kWh/m²/year",
    legend: [
      { colour: "#3b2f6b", label: "< 1000" },
      { colour: "#6b4fa0", label: "1000–1400" },
      { colour: "#d9a441", label: "1400–1800" },
      { colour: "#f7bf59", label: "1800–2200" },
      { colour: "#fff0c2", label: "> 2200" },
    ],
  },
  {
    id: "gsa-dni",
    label: "Direct normal irradiation",
    group: "resource",
    kind: "raster",
    purpose: "Decisive for concentrating solar power, which cannot use diffuse light.",
    source: "Global Solar Atlas (Solargis / World Bank ESMAP)",
    vintage: "2020 release",
    licence: "CC BY 4.0",
    availability: { state: "needs-download", dataset: "gsa-dni", approximateMb: 480 },
    defaultVisible: false,
    units: "kWh/m²/year",
  },
  {
    id: "gsa-pvout",
    label: "PV output potential",
    group: "resource",
    kind: "raster",
    purpose: "Specific yield for a reference system, useful for a quick comparison.",
    source: "Global Solar Atlas (Solargis / World Bank ESMAP)",
    vintage: "2020 release",
    licence: "CC BY 4.0",
    availability: { state: "needs-download", dataset: "gsa-pvout", approximateMb: 260 },
    defaultVisible: false,
    units: "kWh/kWp/year",
  },
  {
    id: "gem-solar",
    label: "Solar power plants",
    group: "infrastructure",
    kind: "vector",
    purpose: "Named utility-scale plants with capacity, status and technology.",
    source: "Global Energy Monitor, Global Solar Power Tracker",
    vintage: "February 2026",
    licence: "CC BY 4.0 (rows cross-referenced to TZ-SAM are BY-NC)",
    availability: { state: "needs-download", dataset: "gem-solar", approximateMb: 33 },
    defaultVisible: false,
    legend: [
      { colour: "#f7bf59", label: "Operating" },
      { colour: "#96cfe2", label: "Construction" },
      { colour: "#9c8f7d", label: "Announced or pre-construction" },
      { colour: "#a7caff", label: "Solar thermal" },
    ],
  },
  {
    id: "gmseus-arrays",
    label: "US ground-mounted arrays",
    group: "infrastructure",
    kind: "vector",
    purpose:
      "Measured array footprints with coverage ratios and mount type — the empirical basis " +
      "for Sunday's packing defaults.",
    source: "GM-SEUS v2.0",
    vintage: "2024",
    licence: "CC BY 4.0",
    availability: { state: "needs-download", dataset: "gmseus-arrays", approximateMb: 55 },
    defaultVisible: false,
  },
  {
    id: "tz-sam",
    label: "Global PV footprints",
    group: "infrastructure",
    kind: "vector",
    purpose: "Imagery-derived footprints with estimated capacity, worldwide.",
    source: "TransitionZero Solar Asset Mapper",
    vintage: "Q1 2024",
    licence: "CC BY-NC 4.0",
    availability: { state: "licence-gated", licence: "CC BY-NC 4.0" },
    defaultVisible: false,
  },
  {
    id: "osm-power",
    label: "Power grid",
    group: "infrastructure",
    kind: "vector",
    purpose:
      "Mapped transmission lines and substations, for proximity context only — not hosting " +
      "capacity.",
    source: "OpenStreetMap via OpenInfraMap",
    licence: "ODbL",
    // Tiles/query wiring lands with the P1 grid overlay; do not advertise ready.
    availability: { state: "needs-download", dataset: "osm-power", approximateMb: 0 },
    defaultVisible: false,
    legend: [
      { colour: "#ffb4ab", label: "≥ 220 kV" },
      { colour: "#e8a33d", label: "110–220 kV" },
      { colour: "#96cfe2", label: "< 110 kV" },
      { colour: "#a7caff", label: "Substation" },
    ],
  },
  {
    id: "wdpa",
    label: "Protected areas",
    group: "land",
    kind: "vector",
    purpose: "Hard exclusion in every siting framework.",
    source: "World Database on Protected Areas",
    licence: "WDPA terms of use",
    availability: { state: "needs-download", dataset: "wdpa", approximateMb: 210 },
    defaultVisible: false,
  },
  {
    id: "landcover",
    label: "Land cover",
    group: "land",
    kind: "raster",
    purpose: "Cropland, forest, wetland and barren classes, for the siting soft rules.",
    source: "ESA WorldCover",
    vintage: "2021",
    licence: "CC BY 4.0",
    availability: { state: "needs-download", dataset: "landcover", approximateMb: 640 },
    defaultVisible: false,
  },
  {
    id: "terrain-slope",
    label: "Terrain slope",
    group: "land",
    kind: "derived",
    purpose: "Slope derived from an elevation model, for grading risk.",
    source: "Copernicus DEM via the active terrain basemap",
    licence: "Copernicus terms",
    availability: { state: "needs-key", provider: "maptiler" },
    defaultVisible: false,
    units: "%",
  },
  {
    id: "google-solar-flux",
    label: "Rooftop annual flux",
    group: "resource",
    kind: "raster",
    purpose: "Per-pixel rooftop irradiance for building-level design.",
    source: "Google Solar API data layers",
    licence: "Google Maps Platform terms",
    availability: { state: "needs-key", provider: "google_solar" },
    defaultVisible: false,
    units: "kWh/kW/year",
  },
  {
    id: "sites",
    label: "My sites",
    group: "context",
    kind: "vector",
    purpose: "Boundaries and locations in the current project.",
    source: "This project",
    availability: { state: "ready" },
    defaultVisible: true,
  },
];

interface LayerState {
  runtime: Record<string, LayerRuntimeState>;
  /** Layer order, topmost last. Only affects rendering. */
  order: string[];

  setVisible: (id: string, visible: boolean) => void;
  toggle: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
  isVisible: (id: string) => boolean;
  visibleLayers: () => LayerDefinition[];
  replaceAll: (runtime: Record<string, LayerRuntimeState>) => void;
  /** Marks a downloaded dataset's layer as usable. */
  markAvailable: (id: string) => void;
}

function initialRuntime(): Record<string, LayerRuntimeState> {
  return Object.fromEntries(
    LAYER_CATALOGUE.map((layer) => [
      layer.id,
      { visible: layer.defaultVisible && layer.availability.state === "ready", opacity: 1 },
    ]),
  );
}

export function layerById(id: string): LayerDefinition | undefined {
  return LAYER_CATALOGUE.find((layer) => layer.id === id);
}

export function isLayerUsable(layer: LayerDefinition): boolean {
  if (layer.availability.state === "ready") return true;

  // Runtime unlocks: a key in Settings or an installed dataset makes the layer
  // usable without mutating the catalogue definition permanently.
  if (layer.availability.state === "needs-key") {
    const provider = layer.availability.provider as "google_solar" | "nrel" | "maptiler" | "stadia";
    return useSettingsStore.getState().configuredKeys.includes(provider);
  }

  if (layer.availability.state === "needs-download") {
    return Boolean(useSettingsStore.getState().datasets[layer.availability.dataset]?.downloaded);
  }

  if (layer.availability.state === "licence-gated") {
    return useSettingsStore.getState().preferences.acceptNonCommercialLayers;
  }

  return false;
}

/** Human-readable reason a layer cannot be switched on yet. */
export function unavailableReason(layer: LayerDefinition): string | null {
  switch (layer.availability.state) {
    case "ready":
      return null;
    case "needs-key":
      return `Add a ${layer.availability.provider.replace("_", " ")} API key in Settings to use this layer.`;
    case "needs-download":
      if (layer.availability.approximateMb <= 0) {
        return `${layer.label} is catalogued but not wired to a live source yet.`;
      }
      return `Download the ${layer.availability.dataset} dataset (about ${layer.availability.approximateMb} MB) in Settings.`;
    case "needs-desktop":
      return "This layer needs the desktop app rather than the browser dev server.";
    case "licence-gated":
      return `Licensed ${layer.availability.licence}; enable it in Settings once you have confirmed your use is permitted.`;
    default:
      return null;
  }
}

export const useLayerStore = create<LayerState>((set, get) => ({
  runtime: initialRuntime(),
  order: LAYER_CATALOGUE.map((layer) => layer.id),

  setVisible: (id, visible) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        [id]: { ...(state.runtime[id] ?? { opacity: 1, visible: false }), visible },
      },
    })),

  toggle: (id) => {
    const current = get().runtime[id]?.visible ?? false;
    get().setVisible(id, !current);
  },

  setOpacity: (id, opacity) =>
    set((state) => ({
      runtime: {
        ...state.runtime,
        [id]: {
          ...(state.runtime[id] ?? { visible: false, opacity: 1 }),
          opacity: Math.min(1, Math.max(0, opacity)),
        },
      },
    })),

  isVisible: (id) => get().runtime[id]?.visible ?? false,

  visibleLayers: () => {
    const { runtime, order } = get();
    return order
      .map((id) => layerById(id))
      .filter((layer): layer is LayerDefinition => Boolean(layer && runtime[layer.id]?.visible));
  },

  replaceAll: (runtime) => set({ runtime: { ...initialRuntime(), ...runtime } }),

  markAvailable: (id) => {
    const layer = layerById(id);
    if (layer) layer.availability = { state: "ready" };
    // Force subscribers to re-read the catalogue.
    set((state) => ({ runtime: { ...state.runtime } }));
  },
}));
