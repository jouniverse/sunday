/**
 * The MapLibre canvas and the single place that touches the map instance.
 *
 * The store is the source of truth for the camera; this component reconciles the
 * map to it and reports user-driven camera changes back. Nothing else in the app
 * holds a reference to the map, which is what keeps panels, the status bar and the
 * draw tools from fighting over it.
 */

import { Map as MapLibreMap, type MapMouseEvent } from "maplibre-gl";
import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
// Must run before any Map is constructed — see maplibre-worker.ts.
import "./maplibre-worker";
import { useLayerStore } from "../store/layerStore";
import { useMapStore } from "../store/mapStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSiteStore } from "../store/siteStore";
import { basemapById } from "./basemaps";
import { installDrawAdapter } from "./draw/adapter";
import {
  installPlantClickHandler,
  invalidatePlantLayerCache,
  refreshPlantLayer,
} from "./plantLayers";
import { renderSiteLayers, SITE_SOURCE_ID } from "./siteLayers";
import "./map.css";

export function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  const basemap = useMapStore((state) => state.basemap);
  const terrain3d = useMapStore((state) => state.terrain3d);
  const configuredKeys = useSettingsStore((state) => state.configuredKeys);

  // --- Map creation. Runs once; the style is swapped in a later effect. ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const { viewport } = useMapStore.getState();
    const map = new MapLibreMap({
      container: containerRef.current,
      style: basemapById(basemap).build({}),
      center: [viewport.longitude, viewport.latitude],
      zoom: viewport.zoom,
      bearing: viewport.bearing,
      pitch: viewport.pitch,
      attributionControl: false,
      // The app draws its own zoom controls in the design language.
      dragRotate: true,
      maxPitch: 75,
    });
    mapRef.current = map;

    const publishCamera = () => {
      const centre = map.getCenter();
      useMapStore.getState().setViewport({
        longitude: centre.lng,
        latitude: centre.lat,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      });
      const bounds = map.getBounds();
      useMapStore.getState().setBounds({
        minLon: bounds.getWest(),
        minLat: bounds.getSouth(),
        maxLon: bounds.getEast(),
        maxLat: bounds.getNorth(),
      });
      void refreshPlantLayer(map);
    };

    map.on("moveend", publishCamera);
    map.on("zoomend", publishCamera);
    map.on("load", () => {
      publishCamera();
      renderSiteLayers(map);
    });
    map.on("mousemove", (event: MapMouseEvent) => {
      useMapStore.getState().setCursor({ longitude: event.lngLat.lng, latitude: event.lngLat.lat });
    });
    map.on("mouseout", () => useMapStore.getState().setCursor(null));

    const uninstallDraw = installDrawAdapter(map);
    const uninstallPlants = installPlantClickHandler(map);

    // MapWorkspace stays mounted but is often `display: none` while other tabs
    // are open. Resize when the canvas becomes visible again so hit-testing and
    // cursors stay aligned after project / view switches.
    const observer = new ResizeObserver(() => {
      map.resize();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      uninstallDraw();
      uninstallPlants();
      map.remove();
      mapRef.current = null;
    };
    // Intentionally empty: the map is created once and mutated by other effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Basemap swap. Re-adds the app's own layers, which a style change drops. ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const definition = basemapById(basemap);
    const keys: Record<string, string> = {};
    // Only the presence of a key is known here; the value is fetched on demand.
    if (definition.requiresKey && configuredKeys.includes(definition.requiresKey)) {
      useSettingsStore
        .getState()
        .useKey(definition.requiresKey)
        .then((value) => {
          if (!value) return;
          keys[definition.requiresKey as string] = value;
          map.setStyle(definition.build(keys));
        });
      return;
    }
    map.setStyle(definition.build(keys));

    const onStyleLoad = () => {
      renderSiteLayers(map);
      invalidatePlantLayerCache();
      void refreshPlantLayer(map);
    };
    map.once("styledata", onStyleLoad);
  }, [basemap, configuredKeys]);

  // --- 3D terrain toggle. ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = () => {
      const hasTerrainSource = Boolean(map.getSource("terrain"));
      if (terrain3d && hasTerrainSource) {
        map.setTerrain({ source: "terrain", exaggeration: 1.4 });
        if (map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 600 });
      } else {
        map.setTerrain(null);
        if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 400 });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("styledata", apply);
  }, [terrain3d]);

  // --- Camera requests from anywhere in the app. ---
  useEffect(() =>
    useMapStore.subscribe((state, previous) => {
      const map = mapRef.current;
      if (!map) return;

      if (state.pendingFlyTo && state.pendingFlyTo !== previous.pendingFlyTo) {
        const target = state.pendingFlyTo;
        map.flyTo({
          center: [target.longitude, target.latitude],
          zoom: target.zoom ?? map.getZoom(),
          duration: 900,
          essential: true,
        });
        useMapStore.getState().clearFlyTo();
      }

      if (state.pendingFitBounds && state.pendingFitBounds !== previous.pendingFitBounds) {
        const b = state.pendingFitBounds;
        map.fitBounds(
          [
            [b.minLon, b.minLat],
            [b.maxLon, b.maxLat],
          ],
          { padding: 80, duration: 900 },
        );
        useMapStore.getState().clearFitBounds();
      }
    }),
  );

  // --- Site geometry. Redraws whenever a boundary changes. ---
  useEffect(() =>
    useSiteStore.subscribe(() => {
      const map = mapRef.current;
      if (map?.getSource(SITE_SOURCE_ID)) renderSiteLayers(map);
    }),
  );

  // --- Layer visibility and opacity. ---
  useEffect(() =>
    useLayerStore.subscribe(() => {
      const map = mapRef.current;
      if (!map?.isStyleLoaded()) return;
      renderSiteLayers(map);
      invalidatePlantLayerCache();
      void refreshPlantLayer(map);
    }),
  );

  return <div className="map-canvas" ref={containerRef} data-testid="map-canvas" />;
}
