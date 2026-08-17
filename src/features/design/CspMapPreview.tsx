/**
 * MapLibre preview for CSP Design: satellite or dark schematic under a
 * heliostat scatter or trough row MultiPolygon.
 *
 * Separate from ArrayMapPreview so PV module/GCR packing is not overloaded.
 * Heliostat colour is bronze, distinct from greenfield teal strips.
 */

import {
  AttributionControl,
  Map as MapLibreMap,
  type GeoJSONSource,
} from "maplibre-gl";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { basemapById } from "@/core/map/basemaps";
import "@/core/map/maplibre-worker";
import "@/core/map/map.css";
import type { Site } from "@/core/store/siteStore";
import { IconButton } from "@/design-system/controls";
import { MapNorthIcon } from "@/design-system/icons";
import type { CspTechnology } from "@/domain/csp/types";

const SITE_SOURCE = "sunday-csp-site";
const HELIO_SOURCE = "sunday-csp-heliostats";
const TROUGH_SOURCE = "sunday-csp-trough";
const TOWER_SOURCE = "sunday-csp-tower";

export type CspMapBasemap = "satellite" | "schematic";

export interface CspMapPreviewHandle {
  fitToSite: () => void;
}

export const CspMapPreview = forwardRef<
  CspMapPreviewHandle,
  {
    site: Site;
    technology: CspTechnology;
    heliostatsLngLat: Array<[number, number]>;
    troughStripsLngLat: Array<Array<[number, number]>>;
    showField: boolean;
    basemap?: CspMapBasemap;
  }
>(function CspMapPreview(
  {
    site,
    technology,
    heliostatsLngLat,
    troughStripsLngLat,
    showField,
    basemap = "satellite",
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const [bearing, setBearing] = useState(0);

  const heliostatGeoJson = useMemo(() => {
    if (technology !== "tower" || heliostatsLngLat.length === 0) return emptyFc();
    return {
      type: "FeatureCollection" as const,
      features: heliostatsLngLat.map((coordinates, index) => ({
        type: "Feature" as const,
        properties: { index },
        geometry: { type: "Point" as const, coordinates },
      })),
    };
  }, [technology, heliostatsLngLat]);

  const troughGeoJson = useMemo(() => {
    if (technology !== "trough" || troughStripsLngLat.length === 0) return emptyFc();
    return {
      type: "FeatureCollection" as const,
      features: troughStripsLngLat.map((ring, index) => ({
        type: "Feature" as const,
        properties: { index },
        geometry: {
          type: "Polygon" as const,
          coordinates: [[...ring, ring[0]!]],
        },
      })),
    };
  }, [technology, troughStripsLngLat]);

  const siteGeoJson = useMemo(() => siteToGeoJson(site), [site]);
  const towerGeoJson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry: { type: "Point" as const, coordinates: site.centre },
        },
      ],
    }),
    [site.centre],
  );

  const heliostatGeoJsonRef = useRef(heliostatGeoJson);
  heliostatGeoJsonRef.current = heliostatGeoJson;
  const troughGeoJsonRef = useRef(troughGeoJson);
  troughGeoJsonRef.current = troughGeoJson;
  const siteGeoJsonRef = useRef(siteGeoJson);
  siteGeoJsonRef.current = siteGeoJson;
  const towerGeoJsonRef = useRef(towerGeoJson);
  towerGeoJsonRef.current = towerGeoJson;
  const showFieldRef = useRef(showField);
  showFieldRef.current = showField;
  const technologyRef = useRef(technology);
  technologyRef.current = technology;

  function pushField(map: MapLibreMap) {
    const helio = map.getSource(HELIO_SOURCE) as GeoJSONSource | undefined;
    const trough = map.getSource(TROUGH_SOURCE) as GeoJSONSource | undefined;
    if (helio) helio.setData(heliostatGeoJsonRef.current);
    if (trough) trough.setData(troughGeoJsonRef.current);
    const towerOn = showFieldRef.current && technologyRef.current === "tower";
    const troughOn = showFieldRef.current && technologyRef.current === "trough";
    if (map.getLayer("csp-heliostats")) {
      map.setLayoutProperty("csp-heliostats", "visibility", towerOn ? "visible" : "none");
    }
    if (map.getLayer("csp-tower")) {
      map.setLayoutProperty("csp-tower", "visibility", towerOn ? "visible" : "none");
    }
    if (map.getLayer("csp-trough-fill")) {
      map.setLayoutProperty("csp-trough-fill", "visibility", troughOn ? "visible" : "none");
    }
    if (map.getLayer("csp-trough-line")) {
      map.setLayoutProperty("csp-trough-line", "visibility", troughOn ? "visible" : "none");
    }
  }

  useImperativeHandle(ref, () => ({
    fitToSite: () => {
      const map = mapRef.current;
      if (map) fitSite(map, site);
    },
  }));

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    readyRef.current = false;
    const style =
      basemap === "schematic"
        ? basemapById("blank").build({})
        : basemapById("satellite").build({});
    const map = new MapLibreMap({
      container: containerRef.current,
      style,
      center: site.centre,
      zoom: 15,
      attributionControl: false,
      dragRotate: true,
      maxPitch: 75,
    });
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    mapRef.current = map;

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
        id: "site-fill",
        type: "fill",
        source: SITE_SOURCE,
        paint: {
          "fill-color": basemap === "schematic" ? "#3a342c" : "#c4a35a",
          "fill-opacity": basemap === "schematic" ? 0.35 : 0.18,
        },
      });
      map.addLayer({
        id: "site-line",
        type: "line",
        source: SITE_SOURCE,
        paint: {
          "line-color": basemap === "schematic" ? "#9c8f7d" : "#e6c27a",
          "line-width": 2,
          ...(basemap === "schematic" ? { "line-dasharray": [2, 1.5] as [number, number] } : {}),
        },
      });
      map.addSource(HELIO_SOURCE, { type: "geojson", data: heliostatGeoJsonRef.current });
      map.addLayer({
        id: "csp-heliostats",
        type: "circle",
        source: HELIO_SOURCE,
        paint: {
          "circle-color": "#5c3a2e",
          "circle-opacity": 0.88,
          "circle-stroke-color": "#e8a87c",
          "circle-stroke-width": 0.6,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 1.4, 16, 3.6, 18, 7],
        },
      });
      map.addSource(TROUGH_SOURCE, { type: "geojson", data: troughGeoJsonRef.current });
      map.addLayer({
        id: "csp-trough-fill",
        type: "fill",
        source: TROUGH_SOURCE,
        paint: { "fill-color": "#4a3d28", "fill-opacity": 0.78 },
      });
      map.addLayer({
        id: "csp-trough-line",
        type: "line",
        source: TROUGH_SOURCE,
        paint: { "line-color": "#d4b483", "line-width": 0.8 },
      });
      map.addSource(TOWER_SOURCE, { type: "geojson", data: towerGeoJsonRef.current });
      map.addLayer({
        id: "csp-tower",
        type: "circle",
        source: TOWER_SOURCE,
        paint: {
          "circle-color": "#c45c26",
          "circle-stroke-color": "#f0d0b0",
          "circle-stroke-width": 1.5,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 7, 18, 11],
        },
      });
      readyRef.current = true;
      pushField(map);
      fitSite(map, site);
      setBearing(map.getBearing());
      requestAnimationFrame(() => map.resize());
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // Remount when basemap mode changes so style layers match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id, basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource(SITE_SOURCE) as GeoJSONSource | undefined)?.setData(siteGeoJson);
    (map.getSource(TOWER_SOURCE) as GeoJSONSource | undefined)?.setData(towerGeoJson);
    fitSite(map, site);
  }, [site, siteGeoJson, towerGeoJson]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    pushField(map);
  }, [heliostatGeoJson, troughGeoJson, showField, technology]);

  const count =
    technology === "tower" ? heliostatsLngLat.length : troughStripsLngLat.length;
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
            className="map-controls__compass array-map-preview__compass"
            style={{ transform: `rotate(${-bearing}deg)` }}
            aria-hidden
          >
            <MapNorthIcon size={32} />
          </span>
        </IconButton>
      </div>
      {count > 0 && showField && (
        <p className="array-preview__banner array-preview__banner--footer">
          {technology === "tower"
            ? `${count.toLocaleString()} heliostats · bronze markers, tower at centroid`
            : `${count.toLocaleString()} trough strips · Sunday row packing`}
          {basemap === "schematic" ? " on dark canvas" : " over imagery"} · scroll to zoom, drag to
          pan
        </p>
      )}
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
    map.easeTo({ center: site.centre, zoom: 16, duration: 0 });
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
    { padding: 48, duration: 450, maxZoom: 18 },
  );
}
