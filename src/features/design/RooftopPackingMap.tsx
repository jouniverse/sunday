/**
 * MapLibre preview for local rooftop packing: satellite or dark schematic under
 * placed modules. Separate from RooftopPanelMap (Google Solar placements).
 */

import {
  AttributionControl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  Map as MapLibreMap,
  Popup,
} from "maplibre-gl";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { basemapById } from "@/core/map/basemaps";
import "@/core/map/maplibre-worker";
import "@/core/map/map.css";
import type { Site } from "@/core/store/siteStore";
import { IconButton } from "@/design-system/controls";
import { MapNorthIcon } from "@/design-system/icons";
import type { RooftopPackingResult } from "@/domain/packing/rooftop";
import { packingModulesToLngLat } from "./rooftop-schematic";

const SITE_SOURCE = "sunday-rooftop-site";
const MODULES_SOURCE = "sunday-rooftop-modules";
const MODULES_FILL = "rooftop-modules-fill";
const MODULES_LINE = "rooftop-modules-line";

export type RooftopPackingBasemap = "satellite" | "schematic";

export interface RooftopPackingMapHandle {
  fitToSite: () => void;
}

export const RooftopPackingMap = forwardRef<
  RooftopPackingMapHandle,
  {
    site: Site;
    packing: RooftopPackingResult | null;
    showModules: boolean;
    basemap?: RooftopPackingBasemap;
    inactiveModules: Set<number>;
    onToggleModule: (index: number) => void;
  }
>(function RooftopPackingMap(
  { site, packing, showModules, basemap = "schematic", inactiveModules, onToggleModule },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const popupRef = useRef<Popup | null>(null);
  const toggleRef = useRef(onToggleModule);
  toggleRef.current = onToggleModule;
  const [bearing, setBearing] = useState(0);

  const modulesGeoJson = useMemo(() => {
    if (!packing || packing.modules.length === 0) return emptyFc();
    const rings = packingModulesToLngLat(site, packing);
    return {
      type: "FeatureCollection" as const,
      features: packing.modules.map((_, index) => {
        const ring = rings[index] ?? [];
        const active = !inactiveModules.has(index);
        return {
          type: "Feature" as const,
          properties: { index, active },
          geometry: { type: "Polygon" as const, coordinates: [ring] },
        };
      }),
    };
  }, [site, packing, inactiveModules]);

  const siteGeoJson = useMemo(() => siteToGeoJson(site), [site]);

  const modulesGeoJsonRef = useRef(modulesGeoJson);
  modulesGeoJsonRef.current = modulesGeoJson;
  const siteGeoJsonRef = useRef(siteGeoJson);
  siteGeoJsonRef.current = siteGeoJson;
  const showModulesRef = useRef(showModules);
  showModulesRef.current = showModules;
  const siteRef = useRef(site);
  siteRef.current = site;

  function pushModules(map: MapLibreMap) {
    const source = map.getSource(MODULES_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(modulesGeoJsonRef.current);
    const visibility = showModulesRef.current ? "visible" : "none";
    if (map.getLayer(MODULES_FILL)) {
      map.setLayoutProperty(MODULES_FILL, "visibility", visibility);
    }
    if (map.getLayer(MODULES_LINE)) {
      map.setLayoutProperty(MODULES_LINE, "visibility", visibility);
    }
  }

  useImperativeHandle(ref, () => ({
    fitToSite: () => {
      const map = mapRef.current;
      if (map) fitSite(map, siteRef.current);
    },
  }));

  // Remount when basemap mode changes so style layers match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: geometry is pushed in a later effect
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    readyRef.current = false;
    const style =
      basemap === "schematic" ? basemapById("blank").build({}) : basemapById("satellite").build({});
    const map = new MapLibreMap({
      container: containerRef.current,
      style,
      center: siteRef.current.centre,
      zoom: 19,
      attributionControl: false,
      dragRotate: true,
      maxPitch: 75,
    });
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    mapRef.current = map;
    popupRef.current = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 8,
      className: "sunday-map-popup",
    });

    let rotateRaf = 0;
    const syncBearing = () => {
      if (rotateRaf) return;
      rotateRaf = requestAnimationFrame(() => {
        rotateRaf = 0;
        setBearing(map.getBearing());
      });
    };
    map.on("rotate", syncBearing);
    map.on("moveend", syncBearing);

    map.on("load", () => {
      map.addSource(SITE_SOURCE, { type: "geojson", data: siteGeoJsonRef.current });
      map.addLayer({
        id: "rooftop-site-fill",
        type: "fill",
        source: SITE_SOURCE,
        paint: {
          "fill-color": basemap === "schematic" ? "#3a342c" : "#c4a35a",
          "fill-opacity": basemap === "schematic" ? 0.35 : 0.18,
        },
      });
      map.addLayer({
        id: "rooftop-site-line",
        type: "line",
        source: SITE_SOURCE,
        paint: {
          "line-color": basemap === "schematic" ? "#9c8f7d" : "#e6c27a",
          "line-width": 2,
          ...(basemap === "schematic" ? { "line-dasharray": [2, 1.5] as [number, number] } : {}),
        },
      });
      map.addSource(MODULES_SOURCE, { type: "geojson", data: modulesGeoJsonRef.current });
      map.addLayer({
        id: MODULES_FILL,
        type: "fill",
        source: MODULES_SOURCE,
        layout: { visibility: showModulesRef.current ? "visible" : "none" },
        paint: {
          "fill-color": ["case", ["boolean", ["get", "active"], true], "#2a4650", "#5a564e"],
          "fill-opacity": ["case", ["boolean", ["get", "active"], true], 0.82, 0.28],
        },
      });
      map.addLayer({
        id: MODULES_LINE,
        type: "line",
        source: MODULES_SOURCE,
        layout: { visibility: showModulesRef.current ? "visible" : "none" },
        paint: {
          "line-color": ["case", ["boolean", ["get", "active"], true], "#96cfe2", "#2a2824"],
          "line-width": 0.6,
        },
      });

      map.on("mousemove", MODULES_FILL, (event: MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = "pointer";
        const feature = event.features?.[0];
        if (!feature || !popupRef.current) return;
        const index = feature.properties?.index;
        const active = feature.properties?.active;
        popupRef.current
          .setLngLat(event.lngLat)
          .setHTML(
            `<div style="color:#1b1710;font:12px/1.4 system-ui,sans-serif">` +
              `<strong>Module ${Number(index) + 1}</strong>` +
              (active === false || active === "false" ? "<br/><em>Inactive</em>" : "") +
              `</div>`,
          )
          .addTo(map);
      });
      map.on("mouseleave", MODULES_FILL, () => {
        map.getCanvas().style.cursor = "";
        popupRef.current?.remove();
      });
      map.on("click", MODULES_FILL, (event: MapLayerMouseEvent) => {
        const index = event.features?.[0]?.properties?.index;
        if (index === undefined || index === null) return;
        toggleRef.current(Number(index));
      });

      readyRef.current = true;
      pushModules(map);
      fitSite(map, siteRef.current);
      setBearing(map.getBearing());
      requestAnimationFrame(() => map.resize());
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      popupRef.current?.remove();
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [site.id, basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource(SITE_SOURCE) as GeoJSONSource | undefined)?.setData(siteGeoJson);
    fitSite(map, site);
  }, [site, siteGeoJson]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource(MODULES_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(modulesGeoJson);
    const visibility = showModules ? "visible" : "none";
    if (map.getLayer(MODULES_FILL)) {
      map.setLayoutProperty(MODULES_FILL, "visibility", visibility);
    }
    if (map.getLayer(MODULES_LINE)) {
      map.setLayoutProperty(MODULES_LINE, "visibility", visibility);
    }
  }, [modulesGeoJson, showModules]);

  const moduleCount = packing?.moduleCount ?? 0;
  let inactiveShown = 0;
  for (const index of inactiveModules) {
    if (index >= 0 && index < moduleCount) inactiveShown += 1;
  }
  const activeCount = Math.max(0, moduleCount - inactiveShown);
  const offNorth = Math.abs(((bearing % 360) + 360) % 360) > 0.5;

  const resetNorth = () => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ bearing: 0, duration: 400 });
  };

  return (
    <div className="array-map-preview">
      <div className="array-map-preview__map" ref={containerRef} />
      <div className="canvas__overlay canvas__overlay--bottom-right map-controls array-map-preview__controls">
        <IconButton
          className="map-controls__compass-btn array-map-preview__compass-btn"
          label={offNorth ? "Reset map north" : "Map facing north"}
          onClick={resetNorth}
          active={offNorth}
        >
          <span
            className="array-map-preview__compass"
            style={{ transform: `rotate(${-bearing}deg)` }}
            aria-hidden
          >
            <MapNorthIcon size={32} />
          </span>
        </IconButton>
      </div>
      <p className="array-preview__banner array-preview__banner--footer">
        {activeCount.toLocaleString()} active of {moduleCount.toLocaleString()} modules
        {inactiveShown > 0 ? ` (${inactiveShown} inactive)` : ""} · local packing
        {basemap === "schematic" ? " on dark canvas" : " over imagery"} · click a module to toggle
      </p>
    </div>
  );
});

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function siteToGeoJson(site: Site): GeoJSON.FeatureCollection {
  if (site.ring && site.ring.length >= 3) {
    const ring = [...site.ring];
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push(first);
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: site.id },
          geometry: { type: "Polygon", coordinates: [ring] },
        },
      ],
    };
  }
  return emptyFc();
}

function fitSite(map: MapLibreMap, site: Site) {
  if (!site.ring || site.ring.length < 2) {
    map.easeTo({ center: site.centre, zoom: 19, duration: 0 });
    return;
  }
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of site.ring) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding: 40, duration: 450, maxZoom: 21 },
  );
}
