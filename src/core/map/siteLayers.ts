/**
 * Renders project sites and the in-progress drawing onto the map.
 *
 * Colour discipline from the design system: teal is geometry and measurement,
 * amber is a solar quantity or a primary action. Site boundaries are therefore
 * teal, and the vertex handles that respond to the pointer are amber.
 */

import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { LngLat } from "@/domain/geometry";
import { useLayerStore } from "../store/layerStore";
import { useSiteStore } from "../store/siteStore";
import { edgeMidpoints } from "./draw/engine";
import { useDrawStore } from "./draw/store";

export const SITE_SOURCE_ID = "sunday-sites";
export const DRAW_SOURCE_ID = "sunday-draw";
const VERTEX_SOURCE_ID = "sunday-draw-vertices";

/** Ensures a GeoJSON source exists, then sets its data. */
function upsertSource(map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection) {
  const existing = map.getSource(id);
  if (existing && "setData" in existing) {
    (existing as GeoJSONSource).setData(data);
    return;
  }
  map.addSource(id, { type: "geojson", data });
}

function siteFeatures(): GeoJSON.FeatureCollection {
  const { sites, selectedSiteId } = useSiteStore.getState();
  const features: GeoJSON.Feature[] = [];

  for (const site of sites) {
    const selected = site.id === selectedSiteId;
    if (site.ring && site.ring.length >= 3) {
      features.push({
        type: "Feature",
        id: site.id,
        geometry: {
          type: "Polygon",
          coordinates: [[...site.ring, site.ring[0] as LngLat]],
        },
        properties: {
          id: site.id,
          name: site.name,
          selected,
          valid: site.geometryValid,
          kind: site.kind,
        },
      });
    } else {
      features.push({
        type: "Feature",
        id: site.id,
        geometry: { type: "Point", coordinates: site.centre },
        properties: { id: site.id, name: site.name, selected, kind: site.kind },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function drawFeatures(): GeoJSON.FeatureCollection {
  const { state } = useDrawStore.getState();
  const shape = state.shape;
  if (!shape || shape.vertices.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }

  const features: GeoJSON.Feature[] = [];
  const vertices = shape.vertices;

  if (shape.closed && vertices.length >= 3) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[...vertices, vertices[0] as LngLat]] },
      properties: { valid: true },
    });
  } else if (vertices.length >= 2) {
    // Open path plus the rubber band to the pointer, so the shape being drawn
    // reads as one continuous line.
    const path = state.pointer ? [...vertices, state.pointer] : vertices;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: path },
      properties: { valid: true },
    });
  } else if (vertices.length === 1 && state.pointer) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [vertices[0] as LngLat, state.pointer] },
      properties: { valid: true },
    });
  }

  return { type: "FeatureCollection", features };
}

function vertexFeatures(): GeoJSON.FeatureCollection {
  const { state } = useDrawStore.getState();
  const shape = state.shape;
  if (!shape) return { type: "FeatureCollection", features: [] };

  const features: GeoJSON.Feature[] = shape.vertices.map((vertex, index) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: vertex },
    properties: {
      role: "vertex",
      index,
      selected: state.selectedVertex === index,
      hover: state.hoverVertex === index,
    },
  }));

  // Midpoint handles only appear once the shape is closed and editable; showing
  // them mid-draw would be noise competing with the rubber band.
  if (shape.closed) {
    for (const { index, point } of edgeMidpoints(shape)) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: point },
        properties: { role: "midpoint", index, hover: state.hoverMidpoint === index },
      });
    }
  }

  if (state.snapTarget) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: state.snapTarget },
      properties: { role: "snap" },
    });
  }

  return { type: "FeatureCollection", features };
}

/** Adds or updates every app-owned layer. Safe to call repeatedly. */
export function renderSiteLayers(map: MapLibreMap): void {
  try {
    if (!map.getStyle() || !map.isStyleLoaded()) {
      map.once("styledata", () => renderSiteLayers(map));
      return;
    }
  } catch {
    return;
  }

  upsertSource(map, SITE_SOURCE_ID, siteFeatures());
  upsertSource(map, DRAW_SOURCE_ID, drawFeatures());
  upsertSource(map, VERTEX_SOURCE_ID, vertexFeatures());

  const sitesVisible = useLayerStore.getState().isVisible("sites");
  const visibility = sitesVisible ? "visible" : "none";

  if (!map.getLayer("sites-fill")) {
    map.addLayer({
      id: "sites-fill",
      type: "fill",
      source: SITE_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        // Invalid geometry turns red: the user must see that the area is not usable.
        "fill-color": [
          "case",
          ["==", ["get", "valid"], false],
          "#ffb4ab",
          ["boolean", ["get", "selected"], false],
          "#96cfe2",
          "#85bed0",
        ],
        "fill-opacity": ["case", ["boolean", ["get", "selected"], false], 0.22, 0.12],
      },
    });
    map.addLayer({
      id: "sites-outline",
      type: "line",
      source: SITE_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "line-color": [
          "case",
          ["==", ["get", "valid"], false],
          "#ffb4ab",
          ["boolean", ["get", "selected"], false],
          "#96cfe2",
          "#4f4536",
        ],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 2, 1.2],
      },
    });
    map.addLayer({
      id: "sites-point",
      type: "circle",
      source: SITE_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": ["case", ["boolean", ["get", "selected"], false], 7, 5],
        "circle-color": "#f7bf59",
        "circle-stroke-color": "#422c00",
        "circle-stroke-width": 1.5,
      },
    });
  }

  for (const id of ["sites-fill", "sites-outline", "sites-point"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  }

  if (!map.getLayer("draw-fill")) {
    map.addLayer({
      id: "draw-fill",
      type: "fill",
      source: DRAW_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#96cfe2", "fill-opacity": 0.18 },
    });
    map.addLayer({
      id: "draw-line",
      type: "line",
      source: DRAW_SOURCE_ID,
      paint: {
        "line-color": "#96cfe2",
        "line-width": 1.8,
        // Dashes read as "in progress"; a solid line reads as committed.
        "line-dasharray": [2, 1.5],
      },
    });
  }

  if (!map.getLayer("draw-midpoints")) {
    map.addLayer({
      id: "draw-midpoints",
      type: "circle",
      source: VERTEX_SOURCE_ID,
      filter: ["==", ["get", "role"], "midpoint"],
      paint: {
        "circle-radius": ["case", ["boolean", ["get", "hover"], false], 5, 3],
        "circle-color": "#241f18",
        "circle-stroke-color": "#9c8f7d",
        "circle-stroke-width": 1,
      },
    });
    map.addLayer({
      id: "draw-snap",
      type: "circle",
      source: VERTEX_SOURCE_ID,
      filter: ["==", ["get", "role"], "snap"],
      paint: {
        "circle-radius": 9,
        "circle-color": "transparent",
        "circle-stroke-color": "#f7bf59",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: "draw-vertices",
      type: "circle",
      source: VERTEX_SOURCE_ID,
      filter: ["==", ["get", "role"], "vertex"],
      paint: {
        "circle-radius": [
          "case",
          ["boolean", ["get", "selected"], false],
          6,
          ["boolean", ["get", "hover"], false],
          6,
          4.5,
        ],
        "circle-color": ["case", ["boolean", ["get", "selected"], false], "#f7bf59", "#241f18"],
        "circle-stroke-color": "#f7bf59",
        "circle-stroke-width": 1.5,
      },
    });
  }
}
