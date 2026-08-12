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
import { useScreeningStore } from "../store/screeningStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSiteStore } from "../store/siteStore";
import { basemapById } from "./basemaps";
import { installDrawAdapter } from "./draw/adapter";
import {
  installFootprintClickHandler,
  installFootprintLayerSync,
  refreshFootprintLayers,
} from "./footprintLayers";
import { installPlantClickHandler, installPlantLayerSync, refreshPlantLayer } from "./plantLayers";
import {
  overlaysNeedRepair,
  repaintOverlayLayers,
  setStyleAndRepaint,
} from "./overlayLayers";
import { ensurePmtilesProtocol } from "./pmtilesProtocol";
import { installProtectedAreaLayerSync } from "./protectedAreaLayers";
import {
  installResourceRasterLayerSync,
  scheduleResourceRasterRefresh,
} from "./resourceRasterLayers";
import { renderScreeningLayers } from "./screeningLayers";
import { renderSiteLayers } from "./siteLayers";
import { whenStyleReady } from "./styleReady";
import { installLandCoverLayerSync } from "./landCoverLayers";
import {
  installPowerGridClickHandler,
  installPowerGridLayerSync,
} from "./powerGridLayers";
import { installTerrainSlopeLayerSync } from "./terrainSlopeLayers";
import "./map.css";

export function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  /**
   * Signature of the style currently on the map (`basemapId|key`).
   * setStyle is skipped when this matches — a second setStyle while the first
   * style is still loading is what produced the black Project canvas.
   */
  const appliedStyleRef = useRef<string | null>(null);

  const basemap = useMapStore((state) => state.basemap);
  const terrain3d = useMapStore((state) => state.terrain3d);
  const tool = useMapStore((state) => state.tool);
  const configuredKeysKey = useSettingsStore((state) => [...state.configuredKeys].sort().join(","));
  const preciseCursor =
    tool === "draw-polygon" || tool === "draw-screening" || tool === "place-point";

  // --- Map creation. Runs once. ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    ensurePmtilesProtocol();
    const { viewport, basemap: initialBasemap } = useMapStore.getState();
    appliedStyleRef.current = `${initialBasemap}|`;

    const map = new MapLibreMap({
      container: containerRef.current,
      style: basemapById(initialBasemap).build({}),
      center: [viewport.longitude, viewport.latitude],
      zoom: viewport.zoom,
      bearing: viewport.bearing,
      pitch: viewport.pitch,
      attributionControl: false,
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
      void refreshFootprintLayers(map);
      scheduleResourceRasterRefresh(map);
      // Style wipe can leave sites/screening missing; repair on camera settle.
      if (overlaysNeedRepair(map)) {
        repaintOverlayLayers(map);
      }
    };

    map.on("moveend", publishCamera);
    map.on("zoomend", publishCamera);
    let rotateRaf = 0;
    map.on("rotate", () => {
      if (rotateRaf) return;
      rotateRaf = requestAnimationFrame(() => {
        rotateRaf = 0;
        const { viewport: current } = useMapStore.getState();
        const bearing = map.getBearing();
        if (Math.abs(current.bearing - bearing) < 0.25) return;
        useMapStore.getState().setViewport({ ...current, bearing });
      });
    });
    map.on("load", () => {
      map.resize();
      publishCamera();
      repaintOverlayLayers(map);
      // Idle after first paint catches project hydrate that raced `load`.
      map.once("idle", () => {
        repaintOverlayLayers(map);
      });
    });
    map.on("mousemove", (event: MapMouseEvent) => {
      useMapStore.getState().setCursor({ longitude: event.lngLat.lng, latitude: event.lngLat.lat });
    });
    map.on("mouseout", () => useMapStore.getState().setCursor(null));

    const uninstallDraw = installDrawAdapter(map);
    const uninstallPlants = installPlantClickHandler(map);
    const uninstallPlantSync = installPlantLayerSync(map);
    // Footprint handlers must not abort map init if a layer id is not ready yet.
    let uninstallFootprints: () => void = () => {};
    let uninstallFootprintSync: () => void = () => {};
    try {
      uninstallFootprints = installFootprintClickHandler(map);
      uninstallFootprintSync = installFootprintLayerSync(map);
    } catch (error) {
      console.warn("[sunday map] footprint handlers deferred", error);
    }
    const uninstallResourceSync = installResourceRasterLayerSync(map);
    const uninstallWdpaSync = installProtectedAreaLayerSync(map);
    const uninstallSlopeSync = installTerrainSlopeLayerSync(map);
    const uninstallLandCoverSync = installLandCoverLayerSync(map);
    const uninstallPowerSync = installPowerGridLayerSync(map);
    const uninstallPowerClick = installPowerGridClickHandler(map);

    const observer = new ResizeObserver(() => {
      map.resize();
      // Height can go 0 → positive when the flex host finishes layout.
      requestAnimationFrame(() => map.resize());
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      uninstallDraw();
      uninstallPlants();
      uninstallPlantSync();
      uninstallFootprints();
      uninstallFootprintSync();
      uninstallResourceSync();
      uninstallWdpaSync();
      uninstallSlopeSync();
      uninstallLandCoverSync();
      uninstallPowerSync();
      uninstallPowerClick();
      map.remove();
      mapRef.current = null;
      appliedStyleRef.current = null;
    };
    // Intentionally empty: the map is created once and mutated by other effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Basemap swap (only when basemap id or API key actually changes). ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const definition = basemapById(basemap);
    const configuredKeys = configuredKeysKey ? configuredKeysKey.split(",") : [];

    const apply = (keys: Record<string, string>) => {
      const signature = `${basemap}|${definition.requiresKey ? (keys[definition.requiresKey] ?? "") : ""}`;
      if (appliedStyleRef.current === signature) return;
      appliedStyleRef.current = signature;
      // Coalesced setStyle + overlay restore (sites, screening, plants, footprints, …).
      setStyleAndRepaint(map, definition.build(keys));
    };

    if (definition.requiresKey && configuredKeys.includes(definition.requiresKey)) {
      void useSettingsStore
        .getState()
        .useKey(definition.requiresKey)
        .then((value) => {
          if (!value) return;
          apply({ [definition.requiresKey as string]: value });
        });
      return;
    }
    apply({});
  }, [basemap, configuredKeysKey]);

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
    whenStyleReady(map, apply);
  }, [terrain3d]);

  useEffect(() =>
    useMapStore.subscribe((state, previous) => {
      const map = mapRef.current;
      if (!map) return;

      if (state.pendingFlyTo && state.pendingFlyTo !== previous.pendingFlyTo) {
        const target = state.pendingFlyTo;
        map.flyTo({
          center: [target.longitude, target.latitude],
          zoom: target.zoom ?? map.getZoom(),
          bearing: target.bearing ?? map.getBearing(),
          pitch: target.pitch ?? map.getPitch(),
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

  // Sites often arrive from project hydrate *after* map load — always re-paint
  // via whenStyleReady (see siteLayers). Guarding on getSource used to skip the
  // first hydrate and leave sites invisible until a later selection change.
  useEffect(() =>
    useSiteStore.subscribe(() => {
      const map = mapRef.current;
      if (!map) return;
      renderSiteLayers(map);
    }),
  );

  useEffect(() =>
    useScreeningStore.subscribe(() => {
      const map = mapRef.current;
      if (!map) return;
      renderScreeningLayers(map);
    }),
  );

  // Sites layer visibility only — plants/footprints have dedicated install*LayerSync.
  useEffect(() =>
    useLayerStore.subscribe((state, previous) => {
      const map = mapRef.current;
      if (!map) return;
      const sitesChanged =
        state.runtime.sites?.visible !== previous.runtime.sites?.visible ||
        state.runtime.sites?.opacity !== previous.runtime.sites?.opacity;
      if (!sitesChanged) return;
      renderSiteLayers(map);
      renderScreeningLayers(map);
    }),
  );

  return (
    <div
      className={preciseCursor ? "map-canvas map-canvas--precise" : "map-canvas"}
      ref={containerRef}
      data-testid="map-canvas"
    />
  );
}
