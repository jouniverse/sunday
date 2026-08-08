/**
 * Power grid overlay — OpenInfraMap hosted MVTs, windowed to a focus bbox.
 *
 * Focus = screening AOI if present, else selected site padded by ~50 km.
 * Paint is indicative OSM infrastructure (not hosting capacity).
 */

import type { Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";
import { ringBounds, type LngLat } from "@/domain/geometry";
import { useDrawStore } from "@/core/map/draw/store";
import { useLayerStore } from "@/core/store/layerStore";
import type { Bounds } from "@/core/store/mapStore";
import { useMapStore } from "@/core/store/mapStore";
import { useScreeningStore } from "@/core/store/screeningStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";

export const POWER_SOURCE_ID = "sunday-osm-power";
export const POWER_LINE_LAYER = "osm-power-line";
export const POWER_SUBSTATION_FILL = "osm-power-substation-fill";
export const POWER_SUBSTATION_POINT = "osm-power-substation-point";

const LAYER_CATALOGUE_ID = "osm-power";
const TILE_URL = "https://openinframap.org/map/power/{z}/{x}/{y}.pbf";
const MIN_ZOOM = 6;
const MAX_ZOOM = 17;
/** Soft outer band from site-selection notes — pad focus around a site. */
const SITE_PAD_KM = 50;

const CLICK_LAYERS = [POWER_LINE_LAYER, POWER_SUBSTATION_FILL, POWER_SUBSTATION_POINT] as const;

let lastKey: string | null = null;
let guidedMissingFocus = false;

function padBoundsKm(bounds: Bounds, padKm: number): Bounds {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const dLat = padKm / 111;
  const dLon = padKm / (111 * cosLat);
  return {
    minLon: bounds.minLon - dLon,
    minLat: bounds.minLat - dLat,
    maxLon: bounds.maxLon + dLon,
    maxLat: bounds.maxLat + dLat,
  };
}

/** Screening AOI, else selected (or first) site padded by SITE_PAD_KM. */
export function powerGridFocusBounds(): Bounds | null {
  const aoi = useScreeningStore.getState().activeBounds();
  if (aoi) return aoi;

  const { sites, selectedSiteId } = useSiteStore.getState();
  const site = sites.find((entry) => entry.id === selectedSiteId) ?? sites[0];
  if (!site) return null;

  if (site.ring && site.ring.length >= 3) {
    return padBoundsKm(ringBounds(site.ring as LngLat[]), SITE_PAD_KM);
  }

  const [lon, lat] = site.centre;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dLat = SITE_PAD_KM / 111;
  const dLon = SITE_PAD_KM / (111 * cosLat);
  return {
    minLon: lon - dLon,
    minLat: lat - dLat,
    maxLon: lon + dLon,
    maxLat: lat + dLat,
  };
}

function removeLayers(map: MapLibreMap): void {
  for (const id of [
    POWER_LINE_LAYER,
    POWER_SUBSTATION_FILL,
    POWER_SUBSTATION_POINT,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(POWER_SOURCE_ID)) map.removeSource(POWER_SOURCE_ID);
  lastKey = null;
}

function applyOpacity(map: MapLibreMap, opacity: number): void {
  if (map.getLayer(POWER_LINE_LAYER)) {
    map.setPaintProperty(POWER_LINE_LAYER, "line-opacity", 0.9 * opacity);
  }
  if (map.getLayer(POWER_SUBSTATION_FILL)) {
    map.setPaintProperty(POWER_SUBSTATION_FILL, "fill-opacity", 0.45 * opacity);
  }
  if (map.getLayer(POWER_SUBSTATION_POINT)) {
    map.setPaintProperty(POWER_SUBSTATION_POINT, "circle-opacity", 0.9 * opacity);
  }
}

/** Catalogue legend stops: &lt;110 / 110–220 / ≥220 kV (OIM voltage is kV). */
const LINE_COLOR: unknown = [
  "step",
  ["to-number", ["coalesce", ["get", "voltage"], 0]],
  "#96cfe2",
  110,
  "#e8a33d",
  220,
  "#ffb4ab",
];

function beforeId(map: MapLibreMap): string | undefined {
  if (map.getLayer("sites-fill")) return "sites-fill";
  if (map.getLayer("screening-fill")) return "screening-fill";
  return undefined;
}

function ensureSource(map: MapLibreMap, bounds: Bounds): void {
  const key = [
    bounds.minLon.toFixed(4),
    bounds.minLat.toFixed(4),
    bounds.maxLon.toFixed(4),
    bounds.maxLat.toFixed(4),
  ].join("|");
  if (map.getSource(POWER_SOURCE_ID) && lastKey === key) return;

  removeLayers(map);
  map.addSource(POWER_SOURCE_ID, {
    type: "vector",
    tiles: [TILE_URL],
    minzoom: MIN_ZOOM,
    maxzoom: MAX_ZOOM,
    bounds: [bounds.minLon, bounds.minLat, bounds.maxLon, bounds.maxLat],
    attribution: "© OpenStreetMap · OpenInfraMap",
  });

  const before = beforeId(map);

  map.addLayer(
    {
      id: POWER_LINE_LAYER,
      type: "line",
      source: POWER_SOURCE_ID,
      "source-layer": "power_line",
      minzoom: MIN_ZOOM,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": LINE_COLOR as never,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          6,
          1.2,
          12,
          2.5,
          16,
          4,
        ],
        "line-opacity": 0.9,
      },
    },
    before,
  );

  map.addLayer(
    {
      id: POWER_SUBSTATION_FILL,
      type: "fill",
      source: POWER_SOURCE_ID,
      "source-layer": "power_substation",
      minzoom: MIN_ZOOM,
      paint: {
        "fill-color": "#a7caff",
        "fill-opacity": 0.45,
        "fill-outline-color": "#6b9bd1",
      },
    },
    before,
  );

  map.addLayer(
    {
      id: POWER_SUBSTATION_POINT,
      type: "circle",
      source: POWER_SOURCE_ID,
      "source-layer": "power_substation_point",
      minzoom: MIN_ZOOM,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3, 12, 5, 16, 7],
        "circle-color": "#a7caff",
        "circle-stroke-color": "#6b9bd1",
        "circle-stroke-width": 1,
        "circle-opacity": 0.9,
      },
    },
    before,
  );

  lastKey = key;
}

export async function refreshPowerGridLayers(map: MapLibreMap): Promise<void> {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return;
  } catch {
    return;
  }

  const visible = useLayerStore.getState().runtime[LAYER_CATALOGUE_ID]?.visible ?? false;
  const opacity = useLayerStore.getState().runtime[LAYER_CATALOGUE_ID]?.opacity ?? 1;
  const focus = powerGridFocusBounds();

  if (!visible) {
    removeLayers(map);
    guidedMissingFocus = false;
    return;
  }

  if (!focus) {
    removeLayers(map);
    if (!guidedMissingFocus) {
      guidedMissingFocus = true;
      useUiStore.getState().notify({
        tone: "info",
        message: "Draw a screening area or select a site first",
        detail: "Power grid only paints around a screening area or site (~50 km).",
      });
    }
    useLayerStore.getState().setVisible(LAYER_CATALOGUE_ID, false);
    return;
  }

  guidedMissingFocus = false;

  try {
    ensureSource(map, focus);
    applyOpacity(map, opacity);
  } catch (error) {
    console.warn("[sunday map] power grid paint failed", error);
    removeLayers(map);
    useUiStore.getState().notify({
      tone: "warning",
      message: "Could not paint power grid",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function formatVoltage(props: Record<string, unknown>): string | null {
  const raw = props.voltage;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return `${raw} kV`;
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return `${n} kV`;
    return raw;
  }
  return null;
}

export function installPowerGridClickHandler(map: MapLibreMap): () => void {
  const activeLayers = (): string[] =>
    CLICK_LAYERS.filter((id) => Boolean(map.getLayer(id)));

  const onClick = (event: MapLayerMouseEvent) => {
    const layers = activeLayers();
    if (layers.length === 0) return;
    const features = map.queryRenderedFeatures(event.point, { layers });
    const feature = features[0];
    if (!feature) return;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const layerId = feature.layer?.id ?? "";
    const kind = layerId.includes("substation") ? "Substation" : "Power line";
    const voltage = formatVoltage(props);
    const name =
      (typeof props.name === "string" && props.name) ||
      (typeof props.operator === "string" && props.operator) ||
      null;
    const osmId =
      props.osm_id != null
        ? `OSM ${props.osm_id}`
        : props["@id"] != null
          ? String(props["@id"])
          : null;

    useUiStore.getState().notify({
      tone: "info",
      message: name ? `${kind}: ${name}` : kind,
      detail: [voltage, osmId, "OSM via OpenInfraMap — indicative"]
        .filter(Boolean)
        .join(" · "),
    });
  };

  const onMove = (event: MapLayerMouseEvent) => {
    // Do not steal the cursor while digitising sites / screening areas.
    if (useMapStore.getState().tool !== "pan") return;
    if (useDrawStore.getState().state.mode !== "idle") return;
    const layers = activeLayers();
    if (layers.length === 0) {
      map.getCanvas().style.cursor = "";
      return;
    }
    const hit = map.queryRenderedFeatures(event.point, { layers });
    map.getCanvas().style.cursor = hit.length > 0 ? "pointer" : "";
  };

  map.on("click", onClick);
  map.on("mousemove", onMove);

  return () => {
    map.off("click", onClick);
    map.off("mousemove", onMove);
    map.getCanvas().style.cursor = "";
  };
}

export function installPowerGridLayerSync(map: MapLibreMap): () => void {
  const sync = () => {
    void refreshPowerGridLayers(map);
  };
  const unsubLayer = useLayerStore.subscribe(sync);
  const unsubScreening = useScreeningStore.subscribe(sync);
  const unsubSites = useSiteStore.subscribe(sync);
  sync();
  return () => {
    unsubLayer();
    unsubScreening();
    unsubSites();
    removeLayers(map);
  };
}
