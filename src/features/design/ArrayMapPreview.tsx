/**
 * MapLibre preview for greenfield Design: satellite or dark schematic under
 * array strips.
 *
 * Per notes/design-schematic-rendering.md: WebGL + GeoJSON (setData) instead of
 * SVG DOM polygons, so the full layout can pan/zoom without truncation. Source
 * and layers are created once; parameter changes push MultiPolygon GeoJSON.
 */

import { Map as MapLibreMap, type GeoJSONSource } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { basemapById } from "@/core/map/basemaps";
import "@/core/map/maplibre-worker";
import type { Site } from "@/core/store/siteStore";
import type { ModuleSpec, MountType } from "@/domain/packing/priors";
import { computeArrayStrips } from "./ArrayPreview";

export { satelliteImageUrl } from "@/core/map/satelliteExport";

const SITE_SOURCE = "sunday-array-site";
const STRIPS_SOURCE = "sunday-array-strips";

export type ArrayMapBasemap = "satellite" | "schematic";

export function ArrayMapPreview({
  site,
  module,
  tiltDegrees,
  gcr,
  azimuth,
  mount = "fixed_tilt",
  showStrips,
  basemap = "satellite",
  onCaptureReady,
}: {
  site: Site;
  module: ModuleSpec;
  tiltDegrees: number;
  gcr: number;
  azimuth: number;
  mount?: MountType;
  showStrips: boolean;
  /** Dark blank canvas for schematic-only; Esri imagery for satellite modes. */
  basemap?: ArrayMapBasemap;
  onCaptureReady?: (capture: () => string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);

  // Full strip set — WebGL can hold tens of thousands; no viewport truncation.
  const layout = useMemo(
    () =>
      computeArrayStrips({
        site,
        module,
        tiltDegrees,
        gcr,
        azimuth,
        mount,
        maxStrips: Number.POSITIVE_INFINITY,
      }),
    [site, module, tiltDegrees, gcr, azimuth, mount],
  );

  const stripsGeoJson = useMemo(() => {
    if (!layout || layout.stripsLngLat.length === 0) return emptyFc();
    // One MultiPolygon feature is cheaper for setData than N Feature polygons.
    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { count: layout.stripsLngLat.length },
          geometry: {
            type: "MultiPolygon" as const,
            coordinates: layout.stripsLngLat.map((ring) => [[...ring, ring[0]!]]),
          },
        },
      ],
    };
  }, [layout]);

  const siteGeoJson = useMemo(() => siteToGeoJson(site), [site]);

  // Keep latest data in refs so the load handler and updates always see current values.
  const stripsGeoJsonRef = useRef(stripsGeoJson);
  stripsGeoJsonRef.current = stripsGeoJson;
  const siteGeoJsonRef = useRef(siteGeoJson);
  siteGeoJsonRef.current = siteGeoJson;
  const showStripsRef = useRef(showStrips);
  showStripsRef.current = showStrips;

  function pushStrips(map: MapLibreMap) {
    const source = map.getSource(STRIPS_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(stripsGeoJsonRef.current);
    const visibility = showStripsRef.current ? "visible" : "none";
    if (map.getLayer("strips-fill")) map.setLayoutProperty("strips-fill", "visibility", visibility);
    if (map.getLayer("strips-line")) map.setLayoutProperty("strips-line", "visibility", visibility);
  }

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
      attributionControl: { compact: true },
    });
    mapRef.current = map;

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
      map.addSource(STRIPS_SOURCE, { type: "geojson", data: stripsGeoJsonRef.current });
      map.addLayer({
        id: "strips-fill",
        type: "fill",
        source: STRIPS_SOURCE,
        layout: { visibility: showStripsRef.current ? "visible" : "none" },
        paint: { "fill-color": "#2a4650", "fill-opacity": 0.78 },
      });
      map.addLayer({
        id: "strips-line",
        type: "line",
        source: STRIPS_SOURCE,
        layout: { visibility: showStripsRef.current ? "visible" : "none" },
        paint: { "line-color": "#96cfe2", "line-width": 0.5 },
      });
      readyRef.current = true;
      pushStrips(map);
      fitSite(map, site);
      requestAnimationFrame(() => map.resize());
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    onCaptureReady?.(() => {
      try {
        return map.getCanvas().toDataURL("image/jpeg", 0.85);
      } catch {
        return null;
      }
    });

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
    fitSite(map, site);
  }, [site, siteGeoJson]);

  // Push geometry whenever packing parameters change — no rAF early-return that
  // can drop updates when the style is still loading.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    pushStrips(map);
  }, [stripsGeoJson, showStrips]);

  const stripCount = layout?.stripCount ?? 0;

  return (
    <div className="array-map-preview">
      <div className="array-map-preview__map" ref={containerRef} />
      {stripCount > 0 && (
        <p className="array-preview__banner array-preview__banner--footer">
          {stripCount.toLocaleString()} row strips · WebGL schematic
          {basemap === "schematic" ? " on dark canvas" : " over imagery"} · scroll to zoom, drag to
          pan
        </p>
      )}
    </div>
  );
}

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
    { padding: 48, duration: 0, maxZoom: 18 },
  );
}
