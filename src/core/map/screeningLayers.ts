/**
 * Screening area polygons on the Project map.
 *
 * Distinct from site cyan: muted amber dashed outline so AOIs read as
 * “land window”, not as a project site.
 */

import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { LngLat } from "@/domain/geometry";
import { useScreeningStore } from "@/core/store/screeningStore";
import { whenStyleReady } from "./styleReady";

export const SCREENING_SOURCE_ID = "sunday-screening";

function upsertSource(map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection) {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as GeoJSONSource).setData(data);
    return;
  }
  map.addSource(id, { type: "geojson", data });
}

function features(): GeoJSON.FeatureCollection {
  const { areas, selectedId } = useScreeningStore.getState();
  const list: GeoJSON.Feature[] = [];
  for (const area of areas) {
    if (area.ring.length < 3) continue;
    const selected = area.id === selectedId;
    list.push({
      type: "Feature",
      id: area.id,
      geometry: {
        type: "Polygon",
        coordinates: [[...area.ring, area.ring[0] as LngLat]],
      },
      properties: {
        id: area.id,
        name: area.name,
        selected,
        valid: area.geometryValid,
      },
    });
  }
  return { type: "FeatureCollection", features: list };
}

export function renderScreeningLayers(map: MapLibreMap): void {
  whenStyleReady(map, () => paintScreeningLayers(map));
}

function paintScreeningLayers(map: MapLibreMap): void {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) return;
  } catch {
    return;
  }

  upsertSource(map, SCREENING_SOURCE_ID, features());

  if (!map.getLayer("screening-fill")) {
    map.addLayer({
      id: "screening-fill",
      type: "fill",
      source: SCREENING_SOURCE_ID,
      paint: {
        "fill-color": [
          "case",
          ["==", ["get", "valid"], false],
          "#ffb4ab",
          ["boolean", ["get", "selected"], false],
          "#c9a227",
          "#9c8f7d",
        ],
        "fill-opacity": ["case", ["boolean", ["get", "selected"], false], 0.14, 0.08],
      },
    });
    map.addLayer({
      id: "screening-outline",
      type: "line",
      source: SCREENING_SOURCE_ID,
      paint: {
        "line-color": [
          "case",
          ["==", ["get", "valid"], false],
          "#ffb4ab",
          ["boolean", ["get", "selected"], false],
          "#c9a227",
          "#6b5d4d",
        ],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 2.2, 1.4],
        "line-dasharray": [2, 1.5],
      },
    });
  }
}
