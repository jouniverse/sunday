/**
 * Polygon footprint layers (TZ-SAM, GM-SEUS arrays).
 *
 * Same dense-vector pattern as GEM plants:
 * - One-shot centroids + MapLibre clustering at low zoom
 * - Viewport polygon fill/line when zoomed in (budgeted query)
 * Distinct colours so these never look like GEM plant points.
 */

import type { GeoJSONSource, MapLayerMouseEvent, Map as MapLibreMap } from "maplibre-gl";
import type { PlantCentroid, VectorFeature } from "@/core/platform";
import { platform } from "@/core/platform";
import { useLayerStore } from "@/core/store/layerStore";
import { useUiStore } from "@/core/store/uiStore";
import { whenStyleReady } from "./styleReady";

export type FootprintDatasetId = "tz-sam" | "gmseus-arrays";

interface FootprintStyle {
  fill: string;
  stroke: string;
  cluster: string;
  /** Zoom at and above which viewport polygons load. */
  detailMinZoom: number;
  capacityEstimated: boolean;
}

const STYLES: Record<FootprintDatasetId, FootprintStyle> = {
  "tz-sam": {
    fill: "#c9a227",
    stroke: "#5c4a12",
    cluster: "#d4b84a",
    // Polygons as soon as clusters dissolve — large plants need mid-zoom fills.
    detailMinZoom: 9,
    capacityEstimated: true,
  },
  "gmseus-arrays": {
    fill: "#2a9d8f",
    stroke: "#0f3d38",
    cluster: "#3db8a8",
    detailMinZoom: 9,
    capacityEstimated: true,
  },
};

/** Clusters dissolve at this zoom; detailMinZoom should be ≤ this + 1. */
const CLUSTER_MAX_ZOOM = 8;
const CLUSTER_RADIUS_PX = 48;
/** Viewport polygon budget — exteriors are simplified before setData. */
const POLYGON_LIMIT = 800;
/** Debounce viewport polygon SQLite queries while the user pans/zooms. */
const POLY_DEBOUNCE_MS = 280;

const CLUSTER_FILL_OPACITY = 0.62;
const CLUSTER_TEXT_OPACITY = 0.78;
const POINT_FILL_OPACITY = 0.88;
const POLY_FILL_OPACITY = 0.35;
const POLY_LINE_OPACITY = 0.85;

interface DatasetRuntime {
  cachedCollection: GeoJSON.FeatureCollection | null;
  loadPromise: Promise<GeoJSON.FeatureCollection> | null;
  lastPolyKey: string | null;
  polyTimer: ReturnType<typeof setTimeout> | null;
  /** Monotonic id so stale polygon responses are ignored. */
  polySeq: number;
}

const runtime: Record<FootprintDatasetId, DatasetRuntime> = {
  "tz-sam": {
    cachedCollection: null,
    loadPromise: null,
    lastPolyKey: null,
    polyTimer: null,
    polySeq: 0,
  },
  "gmseus-arrays": {
    cachedCollection: null,
    loadPromise: null,
    lastPolyKey: null,
    polyTimer: null,
    polySeq: 0,
  },
};

function sourceId(dataset: FootprintDatasetId): string {
  return `sunday-fp-${dataset}`;
}
function polySourceId(dataset: FootprintDatasetId): string {
  return `sunday-fp-poly-${dataset}`;
}
function layerClusters(dataset: FootprintDatasetId): string {
  return `fp-${dataset}-clusters`;
}
function layerClusterCount(dataset: FootprintDatasetId): string {
  return `fp-${dataset}-cluster-count`;
}
function layerPoints(dataset: FootprintDatasetId): string {
  return `fp-${dataset}-points`;
}
function layerFill(dataset: FootprintDatasetId): string {
  return `fp-${dataset}-fill`;
}
function layerLine(dataset: FootprintDatasetId): string {
  return `fp-${dataset}-line`;
}

function centroidsToGeoJson(centroids: PlantCentroid[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: centroids.map((centroid) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [centroid.lon, centroid.lat] },
      properties: {
        id: centroid.id,
        name: centroid.name,
        status: centroid.status,
        technology: centroid.technology,
        capacityMw: centroid.capacityMw,
        country: centroid.country,
        source: centroid.source,
        vintage: centroid.vintage,
      },
    })),
  };
}

async function ensureCentroidCollection(
  dataset: FootprintDatasetId,
): Promise<GeoJSON.FeatureCollection> {
  const slot = runtime[dataset];
  if (slot.cachedCollection) return slot.cachedCollection;
  if (slot.loadPromise) return slot.loadPromise;

  slot.loadPromise = (async () => {
    const centroids = await platform().vector.listCentroids(dataset);
    slot.cachedCollection = centroidsToGeoJson(centroids);
    return slot.cachedCollection;
  })();

  try {
    return await slot.loadPromise;
  } finally {
    slot.loadPromise = null;
  }
}

function upsertClusteredSource(
  map: MapLibreMap,
  dataset: FootprintDatasetId,
  data: GeoJSON.FeatureCollection,
) {
  const id = sourceId(dataset);
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as GeoJSONSource).setData(data);
    return;
  }
  map.addSource(id, {
    type: "geojson",
    data,
    cluster: true,
    clusterMaxZoom: CLUSTER_MAX_ZOOM,
    clusterRadius: CLUSTER_RADIUS_PX,
    buffer: 0,
  });
}

function ensureClusterLayers(map: MapLibreMap, dataset: FootprintDatasetId) {
  const style = STYLES[dataset];
  const src = sourceId(dataset);
  const clusters = layerClusters(dataset);
  const count = layerClusterCount(dataset);
  const points = layerPoints(dataset);

  if (!map.getLayer(clusters)) {
    map.addLayer({
      id: clusters,
      type: "circle",
      source: src,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": style.cluster,
        "circle-opacity": CLUSTER_FILL_OPACITY,
        "circle-stroke-color": style.stroke,
        "circle-stroke-width": 1.1,
        "circle-radius": ["step", ["get", "point_count"], 12, 25, 16, 100, 22, 500, 28],
      },
    });
  }

  if (!map.getLayer(count)) {
    try {
      map.addLayer({
        id: count,
        type: "symbol",
        source: src,
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
      // Glyph-less styles used to abort here before points were added.
      console.warn(`[sunday map] cluster count labels skipped for ${dataset}`, error);
    }
  }

  if (!map.getLayer(points)) {
    map.addLayer({
      id: points,
      type: "circle",
      source: src,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": 4,
        "circle-color": style.fill,
        "circle-stroke-color": style.stroke,
        "circle-stroke-width": 0.9,
        "circle-opacity": POINT_FILL_OPACITY,
      },
    });
  }
}

function ensurePolygonLayers(map: MapLibreMap, dataset: FootprintDatasetId) {
  const style = STYLES[dataset];
  const src = polySourceId(dataset);
  if (!map.getSource(src)) {
    // Fresh empty source after style wipe — never reuse a stale lastPolyKey or
    // we hide centroids and show empty fills (layer “disappears”).
    runtime[dataset].lastPolyKey = null;
    map.addSource(src, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }

  const fill = layerFill(dataset);
  const line = layerLine(dataset);
  if (!map.getLayer(fill)) {
    map.addLayer({
      id: fill,
      type: "fill",
      source: src,
      paint: {
        "fill-color": style.fill,
        "fill-opacity": POLY_FILL_OPACITY,
      },
    });
  }
  if (!map.getLayer(line)) {
    map.addLayer({
      id: line,
      type: "line",
      source: src,
      paint: {
        "line-color": style.stroke,
        "line-width": 1.2,
        "line-opacity": POLY_LINE_OPACITY,
      },
    });
  }
}

function setClusterVisibility(map: MapLibreMap, dataset: FootprintDatasetId, visible: boolean) {
  const value = visible ? "visible" : "none";
  for (const id of [
    layerClusters(dataset),
    layerClusterCount(dataset),
    layerPoints(dataset),
  ]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", value);
  }
}

function setPolygonVisibility(map: MapLibreMap, dataset: FootprintDatasetId, visible: boolean) {
  const value = visible ? "visible" : "none";
  for (const id of [layerFill(dataset), layerLine(dataset)]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", value);
  }
}

function applyOpacity(map: MapLibreMap, dataset: FootprintDatasetId, opacity: number) {
  if (map.getLayer(layerClusters(dataset))) {
    map.setPaintProperty(
      layerClusters(dataset),
      "circle-opacity",
      CLUSTER_FILL_OPACITY * opacity,
    );
  }
  if (map.getLayer(layerPoints(dataset))) {
    map.setPaintProperty(layerPoints(dataset), "circle-opacity", POINT_FILL_OPACITY * opacity);
  }
  if (map.getLayer(layerClusterCount(dataset))) {
    map.setPaintProperty(
      layerClusterCount(dataset),
      "text-opacity",
      CLUSTER_TEXT_OPACITY * opacity,
    );
  }
  if (map.getLayer(layerFill(dataset))) {
    map.setPaintProperty(layerFill(dataset), "fill-opacity", POLY_FILL_OPACITY * opacity);
  }
  if (map.getLayer(layerLine(dataset))) {
    map.setPaintProperty(layerLine(dataset), "line-opacity", POLY_LINE_OPACITY * opacity);
  }
}

/** Round coords and drop holes — enough for overview fill, far cheaper to paint. */
function simplifyGeometryForDisplay(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  const roundRing = (ring: number[][]) =>
    ring.map((coord) => [round(coord[0] ?? 0), round(coord[1] ?? 0)]);

  if (geometry.type === "Polygon") {
    const exterior = geometry.coordinates[0];
    if (!exterior) return geometry;
    return { type: "Polygon", coordinates: [roundRing(exterior)] };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates
        .map((poly) => {
          const exterior = poly[0];
          return exterior ? [roundRing(exterior)] : null;
        })
        .filter((poly): poly is number[][][] => poly != null),
    };
  }
  return geometry;
}

function clearPolygons(map: MapLibreMap, dataset: FootprintDatasetId) {
  const slot = runtime[dataset];
  if (slot.polyTimer) {
    clearTimeout(slot.polyTimer);
    slot.polyTimer = null;
  }
  slot.polySeq += 1;
  const src = map.getSource(polySourceId(dataset)) as GeoJSONSource | undefined;
  if (src) src.setData({ type: "FeatureCollection", features: [] });
  slot.lastPolyKey = null;
  if (map.getLayer(layerFill(dataset)) || map.getLayer(layerLine(dataset))) {
    setPolygonVisibility(map, dataset, false);
  }
}

/** Show centroid points; hide empty polygon layers. Used when fills are unavailable. */
function showPointsHidePolygons(map: MapLibreMap, dataset: FootprintDatasetId) {
  setPolygonVisibility(map, dataset, false);
  if (map.getLayer(layerPoints(dataset))) {
    map.setLayoutProperty(layerPoints(dataset), "visibility", "visible");
  }
  if (map.getLayer(layerClusters(dataset))) {
    map.setLayoutProperty(layerClusters(dataset), "visibility", "visible");
  }
  if (map.getLayer(layerClusterCount(dataset))) {
    map.setLayoutProperty(layerClusterCount(dataset), "visibility", "visible");
  }
}

/** Show fills; hide points/clusters so they do not double-draw on top of polygons. */
function showPolygonsHidePoints(map: MapLibreMap, dataset: FootprintDatasetId) {
  setPolygonVisibility(map, dataset, true);
  for (const id of [layerPoints(dataset), layerClusters(dataset), layerClusterCount(dataset)]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  }
}

async function fetchPolygons(map: MapLibreMap, dataset: FootprintDatasetId): Promise<void> {
  ensurePolygonLayers(map, dataset);
  const src = map.getSource(polySourceId(dataset)) as GeoJSONSource | undefined;
  if (!src) return;

  const bounds = map.getBounds();
  // Coarser key (~0.02°) avoids re-query on tiny pans at regional zoom.
  const key = [
    dataset,
    bounds.getWest().toFixed(2),
    bounds.getSouth().toFixed(2),
    bounds.getEast().toFixed(2),
    bounds.getNorth().toFixed(2),
  ].join("|");
  if (key === runtime[dataset].lastPolyKey) {
    // Only hide points if fills are actually painted; otherwise keep centroids.
    showPolygonsHidePoints(map, dataset);
    return;
  }

  const seq = ++runtime[dataset].polySeq;
  try {
    const result = await platform().vector.queryBbox({
      dataset,
      minLon: bounds.getWest(),
      minLat: bounds.getSouth(),
      maxLon: bounds.getEast(),
      maxLat: bounds.getNorth(),
      limit: POLYGON_LIMIT,
      includeGeometry: true,
    });
    if (seq !== runtime[dataset].polySeq) return;
    if (!useLayerStore.getState().isVisible(dataset)) return;

    const features: GeoJSON.Feature[] = [];
    for (const feature of result.features) {
      if (!feature.geometry) continue;
      features.push({
        type: "Feature",
        geometry: simplifyGeometryForDisplay(feature.geometry as GeoJSON.Geometry),
        properties: {
          id: feature.id,
          name: feature.name,
          capacityMw: feature.capacityMw,
          source: feature.source,
          vintage: feature.vintage,
          technology: feature.technology,
          status: feature.status,
        },
      });
    }

    src.setData({ type: "FeatureCollection", features });
    runtime[dataset].lastPolyKey = key;
    // Never hide centroids unless we actually have fills — empty/error left the
    // GM-SEUS layer looking “gone” after toggle at detail zoom.
    if (features.length > 0) {
      showPolygonsHidePoints(map, dataset);
    } else {
      showPointsHidePolygons(map, dataset);
    }
  } catch (error) {
    if (seq !== runtime[dataset].polySeq) return;
    showPointsHidePolygons(map, dataset);
    const message = error instanceof Error ? error.message : String(error);
    if (/unavailable|no such|empty/i.test(message)) return;
    useUiStore.getState().notify({
      tone: "warning",
      message: `Could not load ${dataset} polygons`,
      detail: message,
    });
  }
}

function schedulePolygonRefresh(map: MapLibreMap, dataset: FootprintDatasetId) {
  const slot = runtime[dataset];
  if (slot.polyTimer) clearTimeout(slot.polyTimer);
  slot.polyTimer = setTimeout(() => {
    slot.polyTimer = null;
    void fetchPolygons(map, dataset);
  }, POLY_DEBOUNCE_MS);
}

async function refreshOne(map: MapLibreMap, dataset: FootprintDatasetId): Promise<void> {
  whenStyleReady(map, () => {
    void paintOne(map, dataset);
  });
}

const BUSY_LABEL: Record<FootprintDatasetId, string> = {
  "tz-sam": "Loading Global PV footprints",
  "gmseus-arrays": "Loading US ground-mounted arrays",
};

async function paintOne(map: MapLibreMap, dataset: FootprintDatasetId): Promise<void> {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return;
  } catch {
    return;
  }

  const visible = useLayerStore.getState().isVisible(dataset);
  const opacity = useLayerStore.getState().runtime[dataset]?.opacity ?? 1;
  const style = STYLES[dataset];
  const showDetail = map.getZoom() >= style.detailMinZoom;

  if (!visible) {
    runtime[dataset].lastPolyKey = null;
    // Avoid creating empty polygon sources for layers the user never opened.
    if (map.getSource(sourceId(dataset))) {
      setClusterVisibility(map, dataset, false);
      clearPolygons(map, dataset);
    }
    return;
  }

  const busyKey = `footprint-${dataset}`;
  try {
    // Centroid GeoJSON is loaded once; pan/zoom must not re-hit SQLite for points.
    let cached = runtime[dataset].cachedCollection;
    if (cached && cached.features.length === 0) {
      runtime[dataset].cachedCollection = null;
      cached = null;
    }
    if (!cached) {
      useUiStore.getState().startBusy(busyKey, BUSY_LABEL[dataset]);
      try {
        cached = await ensureCentroidCollection(dataset);
      } finally {
        useUiStore.getState().endBusy(busyKey);
      }
      if (!useLayerStore.getState().isVisible(dataset)) return;
    }

    // Re-add source only when style wipe / first paint removed it — not on every pan.
    if (!map.getSource(sourceId(dataset))) {
      upsertClusteredSource(map, dataset, cached);
    }
    ensureClusterLayers(map, dataset);
    ensurePolygonLayers(map, dataset);
    applyOpacity(map, dataset, opacity);

    if (showDetail) {
      // Keep centroids visible until a polygon fetch returns features (toggle-on
      // used to hide points first and then fail the fetch → “layer gone”).
      showPointsHidePolygons(map, dataset);
      schedulePolygonRefresh(map, dataset);
    } else {
      clearPolygons(map, dataset);
      showPointsHidePolygons(map, dataset);
    }

    if (cached.features.length === 0) {
      useUiStore.getState().notify({
        tone: "info",
        message: `${dataset === "tz-sam" ? "Global PV footprints" : "US ground-mounted arrays"} has no features`,
        detail: "Reinstall the dataset from Settings → Datasets if you expected data here.",
      });
    }
  } catch (error) {
    useUiStore.getState().endBusy(busyKey);
    const message = error instanceof Error ? error.message : String(error);
    if (/unavailable|no such|empty/i.test(message)) return;
    useUiStore.getState().notify({
      tone: "warning",
      message: `Could not load ${dataset} layer`,
      detail: message,
    });
  }
}

/** Refresh both footprint datasets (call on camera/style changes). */
export async function refreshFootprintLayers(map: MapLibreMap): Promise<void> {
  await Promise.all([refreshOne(map, "tz-sam"), refreshOne(map, "gmseus-arrays")]);
}

function propString(props: Record<string, unknown>, key: string): string | null {
  const value = props[key];
  if (value == null || value === "" || value === -9999 || value === "-9999") return null;
  return String(value);
}

function propNumber(props: Record<string, unknown>, key: string): number | null {
  const value = props[key];
  if (typeof value === "number" && Number.isFinite(value) && value !== -9999) return value;
  if (typeof value === "string" && value !== "" && value !== "-9999") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed !== -9999) return parsed;
  }
  return null;
}

function formatGmseusDetail(feature: VectorFeature): { message: string; detail: string } {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const name = propString(props, "name") ?? feature.name ?? "Array";
  const capEst = propNumber(props, "capMWDCest") ?? propNumber(props, "capMWDC") ?? feature.capacityMw;
  const instYr = propNumber(props, "instYr");
  const modType = propString(props, "modType");
  const mount = propString(props, "mount") ?? feature.technology;
  const totArea = propNumber(props, "totArea");
  const gcr1 = propNumber(props, "GCR1");
  const gcr2 = propNumber(props, "GCR2");
  const version = propString(props, "version")?.replace("_", ".") ?? null;
  const source = feature.source || "GM-SEUS";
  const vintage = feature.vintage;

  const parts: string[] = [];
  if (capEst != null) parts.push(`${capEst} MW DC (est)`);
  if (instYr != null) parts.push(`installed ${instYr}`);
  if (modType) parts.push(modType);
  if (mount) parts.push(mount);
  if (totArea != null) parts.push(`${Math.round(totArea).toLocaleString()} m²`);
  if (gcr1 != null || gcr2 != null) {
    const gcrBits = [gcr1, gcr2]
      .filter((v): v is number => v != null)
      .map((v) => v.toFixed(3));
    parts.push(`GCR ${gcrBits.join(" / ")}`);
  }
  parts.push([source, vintage, version].filter(Boolean).join(" "));
  return { message: name, detail: parts.filter(Boolean).join(" · ") };
}

function formatTzSamDetail(
  props: Record<string, unknown>,
  style: FootprintStyle,
): { message: string; detail: string } {
  const capacity =
    props.capacityMw != null && props.capacityMw !== ""
      ? `${props.capacityMw} MW${style.capacityEstimated ? " (estimated)" : ""}`
      : "capacity unknown";
  // No vintage — TZ-SAM releases are not stamped in the GeoJSON properties.
  return {
    message: String(props.name ?? "PV footprint"),
    detail: [capacity, props.source || "TransitionZero Solar Asset Mapper"].filter(Boolean).join(" · "),
  };
}

export function installFootprintClickHandler(map: MapLibreMap): () => void {
  const handlers: Array<() => void> = [];

  for (const dataset of ["tz-sam", "gmseus-arrays"] as FootprintDatasetId[]) {
    const style = STYLES[dataset];
    const onPoint = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const id = props.id != null ? String(props.id) : null;

      if (dataset === "gmseus-arrays" && id) {
        void platform()
          .vector.getFeature(dataset, id)
          .then((full) => {
            if (!full) {
              useUiStore.getState().notify({
                tone: "info",
                message: String(props.name ?? "Array"),
                detail: [props.capacityMw != null ? `${props.capacityMw} MW` : null, props.source, props.vintage]
                  .filter(Boolean)
                  .join(" · "),
              });
              return;
            }
            const { message, detail } = formatGmseusDetail(full);
            useUiStore.getState().notify({ tone: "info", message, detail });
          })
          .catch(() => {
            useUiStore.getState().notify({
              tone: "info",
              message: String(props.name ?? "Array"),
              detail: "Could not load array attributes",
            });
          });
        return;
      }

      const { message, detail } = formatTzSamDetail(props, style);
      useUiStore.getState().notify({ tone: "info", message, detail });
    };

    const onCluster = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const clusterId = feature.properties?.cluster_id;
      if (typeof clusterId !== "number") return;
      const source = map.getSource(sourceId(dataset)) as GeoJSONSource | undefined;
      if (!source || typeof source.getClusterExpansionZoom !== "function") return;
      const coordinates = feature.geometry.coordinates as [number, number];
      source
        .getClusterExpansionZoom(clusterId)
        .then((zoom) => {
          map.easeTo({ center: coordinates, zoom, duration: 450 });
        })
        .catch(() => undefined);
    };

    const clearCursor = () => {
      map.getCanvas().style.cursor = "";
    };

    const points = layerPoints(dataset);
    const clusters = layerClusters(dataset);
    const fill = layerFill(dataset);

    map.on("click", points, onPoint);
    map.on("click", fill, onPoint);
    map.on("click", clusters, onCluster);
    map.on("mouseenter", points, clearCursor);
    map.on("mouseleave", points, clearCursor);
    map.on("mouseenter", fill, clearCursor);
    map.on("mouseleave", fill, clearCursor);
    map.on("mouseenter", clusters, clearCursor);
    map.on("mouseleave", clusters, clearCursor);

    handlers.push(() => {
      map.off("click", points, onPoint);
      map.off("click", fill, onPoint);
      map.off("click", clusters, onCluster);
      map.off("mouseenter", points, clearCursor);
      map.off("mouseleave", points, clearCursor);
      map.off("mouseenter", fill, clearCursor);
      map.off("mouseleave", fill, clearCursor);
      map.off("mouseenter", clusters, clearCursor);
      map.off("mouseleave", clusters, clearCursor);
    });
  }

  return () => {
    for (const off of handlers) off();
  };
}

export function installFootprintLayerSync(map: MapLibreMap): () => void {
  let prevTz = useLayerStore.getState().runtime["tz-sam"];
  let prevGm = useLayerStore.getState().runtime["gmseus-arrays"];

  return useLayerStore.subscribe((state) => {
    const tz = state.runtime["tz-sam"];
    const gm = state.runtime["gmseus-arrays"];
    const changed =
      tz?.visible !== prevTz?.visible ||
      tz?.opacity !== prevTz?.opacity ||
      gm?.visible !== prevGm?.visible ||
      gm?.opacity !== prevGm?.opacity;
    prevTz = tz;
    prevGm = gm;
    if (!changed) return;
    void refreshFootprintLayers(map);
  });
}

/** Clears centroid + polygon caches after Install (or for tests). */
export function invalidateFootprintLayerCache(dataset?: FootprintDatasetId): void {
  const ids: FootprintDatasetId[] = dataset
    ? [dataset]
    : ["tz-sam", "gmseus-arrays"];
  for (const id of ids) {
    if (runtime[id].polyTimer) {
      clearTimeout(runtime[id].polyTimer);
      runtime[id].polyTimer = null;
    }
    runtime[id].cachedCollection = null;
    runtime[id].loadPromise = null;
    runtime[id].lastPolyKey = null;
    runtime[id].polySeq += 1;
  }
}
