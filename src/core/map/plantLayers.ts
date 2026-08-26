/**
 * GEM plant inventory layer — dense geospatial display.
 *
 * Pattern from notes/dense-geospatial-display.md:
 * - Load all centroids once (lean IPC), never the 109 MB GeoJSON
 * - Cluster below a zoom threshold; individual points above it
 * - Pan/zoom must not re-hit SQLite — MapLibre's built-in Supercluster handles LOD
 *
 * Co-located phases (same / near-identical lon-lat) are jittered into a small
 * ring so every GEM phase id stays independently clickable.
 */

import type { GeoJSONSource, MapLayerMouseEvent, Map as MapLibreMap } from "maplibre-gl";
import type { PlantCentroid } from "@/core/platform";
import { platform } from "@/core/platform";
import { useLayerStore } from "@/core/store/layerStore";
import { useUiStore } from "@/core/store/uiStore";
import { whenStyleReady } from "./styleReady";

export const PLANT_SOURCE_ID = "sunday-plants";
const LAYER_CLUSTERS = "plants-clusters";
const LAYER_CLUSTER_COUNT = "plants-cluster-count";
const LAYER_HALO = "plants-halo";
const LAYER_FILL = "plants-circle";

/** Clusters dissolve into individuals past this zoom (MapLibre clusterMaxZoom). */
const CLUSTER_MAX_ZOOM = 11;
const CLUSTER_RADIUS_PX = 52;

/* --- Style knobs (tweak here) --------------------------------------------- */
/** Cluster bubble fill opacity (× layer opacity slider). */
const CLUSTER_FILL_OPACITY = 0.68;
/** Cluster count label opacity (× layer opacity slider). */
const CLUSTER_TEXT_OPACITY = 0.78;
/** Unclustered plant fill opacity (× layer opacity slider). */
const PLANT_FILL_OPACITY = 0.92;
/** Soft halo behind each plant. */
const PLANT_HALO_OPACITY = 0.2;

/**
 * Group key precision: 5 decimal degrees ≈ 1.1 m. Near-identical GEM pins that
 * only differ by GPS noise share a key and get spiderfied together.
 */
const COORD_GROUP_DECIMALS = 5;
/** Ring radius in metres for the first ring of co-located phases. */
const JITTER_BASE_RADIUS_M = 40;
/** Extra metres of radius per additional ring when a site has many phases. */
const JITTER_RING_STEP_M = 28;
/** Max points per ring before starting a new concentric ring. */
const JITTER_PER_RING = 8;

let cachedCollection: GeoJSON.FeatureCollection | null = null;
let loadPromise: Promise<GeoJSON.FeatureCollection> | null = null;

function statusColour(status: string | null | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (value.includes("operat")) return "#f7bf59";
  if (value.includes("construction") || value.includes("building")) return "#96cfe2";
  if (value.includes("thermal") || value.includes("csp")) return "#a7caff";
  return "#9c8f7d";
}

function coordGroupKey(lon: number, lat: number): string {
  return `${lon.toFixed(COORD_GROUP_DECIMALS)},${lat.toFixed(COORD_GROUP_DECIMALS)}`;
}

/** Metres → degrees at a given latitude (lon shrinks with cos(lat)). */
function metresToDegrees(metres: number, lat: number): { dLon: number; dLat: number } {
  const dLat = metres / 110_540;
  const dLon = metres / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return { dLon, dLat };
}

/**
 * Spread co-located phases in concentric rings around the shared pin.
 * Single-occupant positions stay exactly on the recorded coordinate.
 */
export function jitterCoLocatedCentroids(
  centroids: PlantCentroid[],
): Array<PlantCentroid & { displayLon: number; displayLat: number; coLocatedCount: number }> {
  const groups = new Map<string, PlantCentroid[]>();
  for (const centroid of centroids) {
    const key = coordGroupKey(centroid.lon, centroid.lat);
    const list = groups.get(key);
    if (list) list.push(centroid);
    else groups.set(key, [centroid]);
  }

  const result: Array<
    PlantCentroid & { displayLon: number; displayLat: number; coLocatedCount: number }
  > = [];

  for (const group of groups.values()) {
    // Stable order within a pin so reloads do not reshuffle the ring.
    group.sort((a, b) => a.id.localeCompare(b.id));
    const n = group.length;
    const centreLon = group.reduce((sum, c) => sum + c.lon, 0) / n;
    const centreLat = group.reduce((sum, c) => sum + c.lat, 0) / n;

    if (n === 1) {
      const only = group[0]!;
      result.push({
        ...only,
        displayLon: only.lon,
        displayLat: only.lat,
        coLocatedCount: 1,
      });
      continue;
    }

    for (let i = 0; i < n; i++) {
      const ring = Math.floor(i / JITTER_PER_RING);
      const indexInRing = i % JITTER_PER_RING;
      const slotsInRing = Math.min(JITTER_PER_RING, n - ring * JITTER_PER_RING);
      const angle = (2 * Math.PI * indexInRing) / slotsInRing - Math.PI / 2;
      const radiusM = JITTER_BASE_RADIUS_M + ring * JITTER_RING_STEP_M;
      const { dLon, dLat } = metresToDegrees(radiusM, centreLat);
      const item = group[i]!;
      result.push({
        ...item,
        displayLon: centreLon + dLon * Math.cos(angle),
        displayLat: centreLat + dLat * Math.sin(angle),
        coLocatedCount: n,
      });
    }
  }

  return result;
}

function centroidsToGeoJson(centroids: PlantCentroid[]): GeoJSON.FeatureCollection {
  const placed = jitterCoLocatedCentroids(centroids);
  return {
    type: "FeatureCollection",
    features: placed.map((centroid) => ({
      type: "Feature",
      id: centroid.id,
      geometry: {
        type: "Point",
        coordinates: [centroid.displayLon, centroid.displayLat],
      },
      properties: {
        id: centroid.id,
        name: centroid.name,
        status: centroid.status,
        technology: centroid.technology,
        capacityMw: centroid.capacityMw,
        country: centroid.country,
        source: centroid.source,
        vintage: centroid.vintage,
        colour: statusColour(centroid.status ?? centroid.technology),
        // True GEM pin — display coords may be spiderfied.
        trueLon: centroid.lon,
        trueLat: centroid.lat,
        coLocatedCount: centroid.coLocatedCount,
      },
    })),
  };
}

async function ensureCentroidCollection(): Promise<GeoJSON.FeatureCollection> {
  if (cachedCollection) return cachedCollection;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const centroids = await platform().vector.listCentroids("gem-solar");
    cachedCollection = centroidsToGeoJson(centroids);
    return cachedCollection;
  })();

  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function upsertClusteredSource(map: MapLibreMap, data: GeoJSON.FeatureCollection) {
  const existing = map.getSource(PLANT_SOURCE_ID);
  if (existing && "setData" in existing) {
    // Source already clustered — only replace data after import/invalidate.
    (existing as GeoJSONSource).setData(data);
    return;
  }
  map.addSource(PLANT_SOURCE_ID, {
    type: "geojson",
    data,
    cluster: true,
    clusterMaxZoom: CLUSTER_MAX_ZOOM,
    clusterRadius: CLUSTER_RADIUS_PX,
    buffer: 0,
  });
}

function ensureLayers(map: MapLibreMap) {
  if (!map.getLayer(LAYER_CLUSTERS)) {
    map.addLayer({
      id: LAYER_CLUSTERS,
      type: "circle",
      source: PLANT_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#f7bf59",
        "circle-opacity": CLUSTER_FILL_OPACITY,
        "circle-stroke-color": "#422c00",
        "circle-stroke-width": 1.2,
        "circle-radius": [
          "step",
          ["get", "point_count"],
          14,
          25,
          18,
          100,
          24,
          500,
          30,
          2000,
          36,
        ],
      },
    });
  }

  if (!map.getLayer(LAYER_CLUSTER_COUNT)) {
    try {
      map.addLayer({
        id: LAYER_CLUSTER_COUNT,
        type: "symbol",
        source: PLANT_SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 11,
          "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#17130c",
          "text-opacity": CLUSTER_TEXT_OPACITY,
        },
      });
    } catch (error) {
      console.warn("[sunday map] plant cluster count labels skipped", error);
    }
  }

  if (!map.getLayer(LAYER_HALO)) {
    map.addLayer({
      id: LAYER_HALO,
      type: "circle",
      source: PLANT_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        // Slightly larger than fill so the soft glow reads at site zoom.
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "capacityMw"], 1],
          1,
          5.5,
          50,
          9,
          250,
          13,
          1000,
          18,
        ],
        "circle-color": ["get", "colour"],
        "circle-opacity": PLANT_HALO_OPACITY,
      },
    });
  }

  if (!map.getLayer(LAYER_FILL)) {
    map.addLayer({
      id: LAYER_FILL,
      type: "circle",
      source: PLANT_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "capacityMw"], 1],
          1,
          3.5,
          50,
          5.5,
          250,
          8,
          1000,
          11,
        ],
        "circle-color": ["get", "colour"],
        "circle-stroke-color": "#422c00",
        "circle-stroke-width": 0.9,
        "circle-opacity": PLANT_FILL_OPACITY,
      },
    });
  }
}

function setPlantVisibility(map: MapLibreMap, visible: boolean) {
  const value = visible ? "visible" : "none";
  for (const id of [LAYER_CLUSTERS, LAYER_CLUSTER_COUNT, LAYER_HALO, LAYER_FILL]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", value);
  }
}

function applyOpacity(map: MapLibreMap, opacity: number) {
  if (map.getLayer(LAYER_CLUSTERS)) {
    map.setPaintProperty(LAYER_CLUSTERS, "circle-opacity", CLUSTER_FILL_OPACITY * opacity);
  }
  if (map.getLayer(LAYER_FILL)) {
    map.setPaintProperty(LAYER_FILL, "circle-opacity", PLANT_FILL_OPACITY * opacity);
    map.setPaintProperty(LAYER_FILL, "circle-radius", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "capacityMw"], 1],
      1,
      3.5,
      50,
      5.5,
      250,
      8,
      1000,
      11,
    ]);
  }
  if (map.getLayer(LAYER_HALO)) {
    map.setPaintProperty(LAYER_HALO, "circle-opacity", PLANT_HALO_OPACITY * opacity);
    map.setPaintProperty(LAYER_HALO, "circle-radius", [
      "interpolate",
      ["linear"],
      ["coalesce", ["get", "capacityMw"], 1],
      1,
      5.5,
      50,
      9,
      250,
      13,
      1000,
      18,
    ]);
  }
  if (map.getLayer(LAYER_CLUSTER_COUNT)) {
    map.setPaintProperty(LAYER_CLUSTER_COUNT, "text-opacity", CLUSTER_TEXT_OPACITY * opacity);
  }
}

/** Loads centroids once (if needed) and paints clustered / individual plants. */
export async function refreshPlantLayer(map: MapLibreMap): Promise<void> {
  whenStyleReady(map, () => {
    void paintPlantLayer(map);
  });
}

const PLANT_BUSY_KEY = "gem-solar";
const PLANT_BUSY_LABEL = "Loading solar power plants";

async function paintPlantLayer(map: MapLibreMap): Promise<void> {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return;
  } catch {
    return;
  }

  const visible = useLayerStore.getState().isVisible("gem-solar");
  const layer = useLayerStore.getState().runtime["gem-solar"];
  const opacity = layer?.opacity ?? 1;

  if (!visible) {
    setPlantVisibility(map, false);
    useUiStore.getState().endBusy(PLANT_BUSY_KEY);
    return;
  }

  // After the one-shot load, pan/zoom is free — only visibility/opacity need paint updates.
  if (map.getSource(PLANT_SOURCE_ID) && cachedCollection) {
    ensureLayers(map);
    setPlantVisibility(map, true);
    applyOpacity(map, opacity);
    useUiStore.getState().endBusy(PLANT_BUSY_KEY);
    return;
  }

  useUiStore.getState().startBusy(PLANT_BUSY_KEY, PLANT_BUSY_LABEL);
  try {
    const data = await ensureCentroidCollection();
    if (!useLayerStore.getState().isVisible("gem-solar")) return;

    upsertClusteredSource(map, data);
    ensureLayers(map);
    setPlantVisibility(map, true);
    applyOpacity(map, opacity);

    if (data.features.length === 0) {
      useUiStore.getState().notify({
        tone: "info",
        message: "No solar plants are installed yet",
        detail: "Install gem-solar from Settings → Datasets to enable this layer.",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unavailable|no such|empty/i.test(message)) return;
    useUiStore.getState().notify({
      tone: "warning",
      message: "Could not load plant layer",
      detail: message,
    });
  } finally {
    useUiStore.getState().endBusy(PLANT_BUSY_KEY);
  }
}

/** Click handler: expand clusters, or toast plant details for individuals. */
export function installPlantClickHandler(map: MapLibreMap): () => void {
  const onPlantClick = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    if (!feature) return;
    const props = feature.properties ?? {};
    const capacity =
      typeof props.capacityMw === "number"
        ? `${props.capacityMw} MW`
        : props.capacityMw
          ? `${props.capacityMw} MW`
          : "capacity unknown";
    const coLocated =
      typeof props.coLocatedCount === "number" && props.coLocatedCount > 1
        ? `${props.coLocatedCount} phases at this site`
        : null;
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
        coLocated,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  };

  const onClusterClick = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    if (!feature || feature.geometry.type !== "Point") return;
    const clusterId = feature.properties?.cluster_id;
    if (typeof clusterId !== "number") return;
    const source = map.getSource(PLANT_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source || typeof source.getClusterExpansionZoom !== "function") return;

    const coordinates = feature.geometry.coordinates as [number, number];
    source
      .getClusterExpansionZoom(clusterId)
      .then((zoom) => {
        map.easeTo({ center: coordinates, zoom, duration: 450 });
      })
      .catch(() => {
        // Expansion zoom is best-effort; ignore if the cluster was dissolved.
      });
  };

  const clearCursor = () => {
    map.getCanvas().style.cursor = "";
  };

  map.on("click", LAYER_FILL, onPlantClick);
  map.on("click", LAYER_CLUSTERS, onClusterClick);
  map.on("mouseenter", LAYER_FILL, clearCursor);
  map.on("mouseleave", LAYER_FILL, clearCursor);
  map.on("mouseenter", LAYER_CLUSTERS, clearCursor);
  map.on("mouseleave", LAYER_CLUSTERS, clearCursor);

  return () => {
    map.off("click", LAYER_FILL, onPlantClick);
    map.off("click", LAYER_CLUSTERS, onClusterClick);
    map.off("mouseenter", LAYER_FILL, clearCursor);
    map.off("mouseleave", LAYER_FILL, clearCursor);
    map.off("mouseenter", LAYER_CLUSTERS, clearCursor);
    map.off("mouseleave", LAYER_CLUSTERS, clearCursor);
  };
}

/**
 * Keep plant visibility/opacity in sync with the layer store.
 *
 * Bound to the map instance (not a React effect) so slider drags always reach
 * MapLibre paint properties even when other view-layer subscriptions are busy.
 */
export function installPlantLayerSync(map: MapLibreMap): () => void {
  let prevVisible = useLayerStore.getState().runtime["gem-solar"]?.visible ?? false;
  let prevOpacity = useLayerStore.getState().runtime["gem-solar"]?.opacity ?? 1;

  return useLayerStore.subscribe((state) => {
    const visible = state.runtime["gem-solar"]?.visible ?? false;
    const opacity = state.runtime["gem-solar"]?.opacity ?? 1;
    if (visible === prevVisible && opacity === prevOpacity) return;
    prevVisible = visible;
    prevOpacity = opacity;
    if (visible && !cachedCollection) {
      useUiStore.getState().startBusy(PLANT_BUSY_KEY, PLANT_BUSY_LABEL);
    }
    void refreshPlantLayer(map);
  });
}

/** Clears the in-memory centroid cache so the next refresh reloads from SQLite. */
export function invalidatePlantLayerCache(): void {
  cachedCollection = null;
  loadPromise = null;
}
