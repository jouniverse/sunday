/**
 * MapLibre preview for greenfield Design: satellite under optional array strips.
 *
 * Replaces the old CSS-transform blend of an SVG schematic over a frozen map
 * snapshot. Pan/zoom is a real map camera; strips are GeoJSON on the same CRS.
 * Large sites draw a capped sample of strips plus a translucent site fill so the
 * UI stays responsive.
 */

import { Map as MapLibreMap, type GeoJSONSource } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { basemapById } from "@/core/map/basemaps";
import "@/core/map/maplibre-worker";
import type { Site } from "@/core/store/siteStore";
import type { ModuleSpec, MountType } from "@/domain/packing/priors";
import { computeArrayStrips } from "./ArrayPreview";

const SITE_SOURCE = "sunday-array-site";
const STRIPS_SOURCE = "sunday-array-strips";
/** Soft cap for map display — packing maths still uses the full strip set. */
const DISPLAY_STRIP_CAP = 2_500;

export function ArrayMapPreview({
  site,
  module,
  tiltDegrees,
  gcr,
  azimuth,
  mount = "fixed_tilt",
  showStrips,
  onCaptureReady,
}: {
  site: Site;
  module: ModuleSpec;
  tiltDegrees: number;
  gcr: number;
  azimuth: number;
  mount?: MountType;
  showStrips: boolean;
  onCaptureReady?: (capture: () => string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  const layout = useMemo(
    () => computeArrayStrips({ site, module, tiltDegrees, gcr, azimuth, mount }),
    [site, module, tiltDegrees, gcr, azimuth, mount],
  );

  const stripsGeoJson = useMemo(() => {
    if (!layout) return emptyFc();
    const strips = layout.stripsLngLat.slice(0, DISPLAY_STRIP_CAP);
    return {
      type: "FeatureCollection" as const,
      features: strips.map((ring, index) => ({
        type: "Feature" as const,
        properties: { index },
        geometry: {
          type: "Polygon" as const,
          coordinates: [[...ring, ring[0]!]],
        },
      })),
    };
  }, [layout]);

  const siteGeoJson = useMemo(() => siteToGeoJson(site), [site]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const style = basemapById("satellite").build({});
    const map = new MapLibreMap({
      container: containerRef.current,
      style,
      center: site.centre,
      zoom: 15,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource(SITE_SOURCE, { type: "geojson", data: siteGeoJson });
      map.addLayer({
        id: "site-fill",
        type: "fill",
        source: SITE_SOURCE,
        paint: { "fill-color": "#c4a35a", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "site-line",
        type: "line",
        source: SITE_SOURCE,
        paint: { "line-color": "#e6c27a", "line-width": 2 },
      });
      map.addSource(STRIPS_SOURCE, { type: "geojson", data: stripsGeoJson });
      map.addLayer({
        id: "strips-fill",
        type: "fill",
        source: STRIPS_SOURCE,
        layout: { visibility: showStrips ? "visible" : "none" },
        paint: { "fill-color": "#2a4650", "fill-opacity": 0.72 },
      });
      map.addLayer({
        id: "strips-line",
        type: "line",
        source: STRIPS_SOURCE,
        layout: { visibility: showStrips ? "visible" : "none" },
        paint: { "line-color": "#96cfe2", "line-width": 0.6 },
      });
      fitSite(map, site);
      requestAnimationFrame(() => map.resize());
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    onCaptureReady?.(() => {
      try {
        // May be tainted by cross-origin tiles; callers should fall back to
        // the static Esri export URL when this returns null.
        return map.getCanvas().toDataURL("image/jpeg", 0.85);
      } catch {
        return null;
      }
    });

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    (map.getSource(SITE_SOURCE) as GeoJSONSource | undefined)?.setData(siteGeoJson);
    fitSite(map, site);
  }, [site, siteGeoJson]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    (map.getSource(STRIPS_SOURCE) as GeoJSONSource | undefined)?.setData(stripsGeoJson);
  }, [stripsGeoJson]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const visibility = showStrips ? "visible" : "none";
    if (map.getLayer("strips-fill")) map.setLayoutProperty("strips-fill", "visibility", visibility);
    if (map.getLayer("strips-line")) map.setLayoutProperty("strips-line", "visibility", visibility);
  }, [showStrips]);

  const truncated =
    layout != null && (layout.truncated || layout.stripCount > DISPLAY_STRIP_CAP);

  return (
    <div className="array-map-preview">
      {truncated && (
        <p className="array-preview__banner">
          Showing {Math.min(layout?.stripCount ?? 0, DISPLAY_STRIP_CAP).toLocaleString()} of{" "}
          {layout?.stripCount.toLocaleString()} row strips for performance. Module count and
          capacity still use the full packing.
        </p>
      )}
      <div className="array-map-preview__map" ref={containerRef} />
    </div>
  );
}

/** Static Esri World Imagery export — reliable for HTML embeds (no canvas CORS). */
export function satelliteImageUrl(site: Site, size = 900): string | null {
  if (!site.ring || site.ring.length < 2) {
    const [lon, lat] = site.centre;
    const d = 0.01;
    return esriExport(lon - d, lat - d, lon + d, lat + d, size);
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
  const padLng = (maxLng - minLng) * 0.12 || 0.002;
  const padLat = (maxLat - minLat) * 0.12 || 0.002;
  return esriExport(minLng - padLng, minLat - padLat, maxLng + padLng, maxLat + padLat, size);
}

function esriExport(
  west: number,
  south: number,
  east: number,
  north: number,
  size: number,
): string {
  const params = new URLSearchParams({
    bbox: `${west},${south},${east},${north}`,
    bboxSR: "4326",
    imageSR: "4326",
    size: `${size},${Math.round(size * 0.7)}`,
    format: "jpg",
    f: "image",
  });
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?${params}`;
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
