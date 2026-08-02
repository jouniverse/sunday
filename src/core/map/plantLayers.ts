/**
 * Viewport-bounded plant inventory layers (GEM and similar).
 *
 * The dataset review is explicit: a 109 MB GeoJSON must never be handed to the
 * map. Features come from the SQLite vector store, one bbox query at a time,
 * largest plants first, with an explicit truncation badge when the limit bites.
 */

import type { GeoJSONSource, MapLayerMouseEvent, Map as MapLibreMap } from "maplibre-gl";
import type { VectorFeature } from "@/core/platform";
import { platform } from "@/core/platform";
import { useLayerStore } from "@/core/store/layerStore";
import { useMapStore } from "@/core/store/mapStore";
import { useUiStore } from "@/core/store/uiStore";

export const PLANT_SOURCE_ID = "sunday-plants";
const LAYER_FILL = "plants-circle";
const LAYER_HALO = "plants-halo";
const VIEWPORT_LIMIT = 2_000;

let inflight: AbortController | null = null;
let lastQueryKey = "";

function statusColour(status: string | null | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (value.includes("operat")) return "#f7bf59";
  if (value.includes("construction") || value.includes("building")) return "#96cfe2";
  if (value.includes("thermal") || value.includes("csp")) return "#a7caff";
  return "#9c8f7d";
}

function featuresToGeoJson(features: VectorFeature[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.map((feature) => ({
      type: "Feature",
      id: feature.id,
      geometry: { type: "Point", coordinates: [feature.lon, feature.lat] },
      properties: {
        id: feature.id,
        dataset: feature.dataset,
        name: feature.name,
        status: feature.status,
        technology: feature.technology,
        capacityMw: feature.capacityMw,
        country: feature.country,
        source: feature.source,
        vintage: feature.vintage,
        colour: statusColour(feature.status ?? feature.technology),
        hasTzCrossRef: Boolean(feature.properties?.hasTzCrossRef),
      },
    })),
  };
}

function upsertSource(map: MapLibreMap, data: GeoJSON.FeatureCollection) {
  const existing = map.getSource(PLANT_SOURCE_ID);
  if (existing && "setData" in existing) {
    (existing as GeoJSONSource).setData(data);
    return;
  }
  map.addSource(PLANT_SOURCE_ID, { type: "geojson", data, buffer: 0 });
}

function ensureLayers(map: MapLibreMap) {
  if (!map.getLayer(LAYER_HALO)) {
    map.addLayer({
      id: LAYER_HALO,
      type: "circle",
      source: PLANT_SOURCE_ID,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "capacityMw"], 1],
          1,
          4,
          50,
          7,
          250,
          11,
          1000,
          16,
        ],
        "circle-color": ["get", "colour"],
        "circle-opacity": 0.18,
      },
    });
    map.addLayer({
      id: LAYER_FILL,
      type: "circle",
      source: PLANT_SOURCE_ID,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "capacityMw"], 1],
          1,
          2.5,
          50,
          4,
          250,
          6,
          1000,
          9,
        ],
        "circle-color": ["get", "colour"],
        "circle-stroke-color": "#422c00",
        "circle-stroke-width": 0.8,
        "circle-opacity": 0.92,
      },
    });
  }
}

/** Fetches the current viewport from the vector store and paints it. */
export async function refreshPlantLayer(map: MapLibreMap): Promise<void> {
  if (!map.isStyleLoaded()) {
    map.once("styledata", () => {
      void refreshPlantLayer(map);
    });
    return;
  }

  const visible = useLayerStore.getState().isVisible("gem-solar");
  const layer = useLayerStore.getState().runtime["gem-solar"];
  const opacity = layer?.opacity ?? 1;

  if (!visible) {
    if (map.getLayer(LAYER_FILL)) {
      map.setLayoutProperty(LAYER_FILL, "visibility", "none");
      map.setLayoutProperty(LAYER_HALO, "visibility", "none");
    }
    return;
  }

  const bounds = useMapStore.getState().bounds;
  if (!bounds) return;

  const queryKey = [
    bounds.minLon.toFixed(3),
    bounds.minLat.toFixed(3),
    bounds.maxLon.toFixed(3),
    bounds.maxLat.toFixed(3),
    VIEWPORT_LIMIT,
  ].join("|");
  if (queryKey === lastQueryKey && map.getSource(PLANT_SOURCE_ID)) {
    map.setLayoutProperty(LAYER_FILL, "visibility", "visible");
    map.setLayoutProperty(LAYER_HALO, "visibility", "visible");
    map.setPaintProperty(LAYER_FILL, "circle-opacity", 0.92 * opacity);
    map.setPaintProperty(LAYER_HALO, "circle-opacity", 0.18 * opacity);
    return;
  }

  inflight?.abort();
  inflight = new AbortController();
  const signal = inflight.signal;

  try {
    const result = await platform().vector.queryBbox({
      dataset: "gem-solar",
      minLon: bounds.minLon,
      minLat: bounds.minLat,
      maxLon: bounds.maxLon,
      maxLat: bounds.maxLat,
      limit: VIEWPORT_LIMIT,
      includeGeometry: false,
      // Default map: operating and under-construction; announced noise stays off.
      statuses: undefined,
    });

    if (signal.aborted) return;

    upsertSource(map, featuresToGeoJson(result.features));
    ensureLayers(map);
    map.setLayoutProperty(LAYER_FILL, "visibility", "visible");
    map.setLayoutProperty(LAYER_HALO, "visibility", "visible");
    map.setPaintProperty(LAYER_FILL, "circle-opacity", 0.92 * opacity);
    map.setPaintProperty(LAYER_HALO, "circle-opacity", 0.18 * opacity);
    lastQueryKey = queryKey;

    if (result.truncated) {
      useUiStore.getState().notify({
        tone: "info",
        message: `Showing ${result.features.length.toLocaleString()} of ${result.total.toLocaleString()} plants in view`,
        detail: "Zoom in to see the smaller ones; the largest plants are drawn first.",
      });
    }
  } catch (error) {
    if (signal.aborted) return;
    // An empty store is a normal state before the user installs GEM.
    const message = error instanceof Error ? error.message : String(error);
    if (/unavailable|no such|empty/i.test(message)) return;
    useUiStore.getState().notify({
      tone: "warning",
      message: "Could not load plant layer",
      detail: message,
    });
  }
}

/** Click handler: opens plant details in a toast/inspector-friendly payload. */
export function installPlantClickHandler(map: MapLibreMap): () => void {
  const onClick = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties ?? {};
    const capacity =
      typeof props.capacityMw === "number"
        ? `${props.capacityMw} MW`
        : props.capacityMw
          ? `${props.capacityMw} MW`
          : "capacity unknown";
    useUiStore.getState().notify({
      tone: "info",
      message: String(props.name ?? "Unnamed plant"),
      detail: [
        props.status,
        props.technology,
        capacity,
        props.country,
        props.source,
        props.vintage,
        props.hasTzCrossRef ? "TZ cross-ref (BY-NC)" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  };

  const onEnter = () => {
    // Keep the Sunday app cursor; do not switch to the browser hand.
    map.getCanvas().style.cursor = "";
  };
  const onLeave = () => {
    map.getCanvas().style.cursor = "";
  };

  map.on("click", LAYER_FILL, onClick);
  map.on("mouseenter", LAYER_FILL, onEnter);
  map.on("mouseleave", LAYER_FILL, onLeave);

  return () => {
    map.off("click", LAYER_FILL, onClick);
    map.off("mouseenter", LAYER_FILL, onEnter);
    map.off("mouseleave", LAYER_FILL, onLeave);
  };
}

/** Invalidates the cache so the next refresh re-queries. */
export function invalidatePlantLayerCache(): void {
  lastQueryKey = "";
}
