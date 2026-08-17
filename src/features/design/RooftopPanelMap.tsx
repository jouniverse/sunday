/**
 * Satellite map with Google Solar panel placements for rooftop Design.
 *
 * Panels are coloured by yearlyEnergyDcKwh, clickable to toggle active/inactive,
 * and optional RGB + flux GeoTIFF overlays sit above the Esri basemap.
 */

import { Map as MapLibreMap, Popup, type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { basemapById } from "@/core/map/basemaps";
import "@/core/map/maplibre-worker";
import type { BuildingInsights, GoogleSolarPanel, RoofSegment } from "@/services/solar/types";
import type { DecodedRaster } from "@/services/solar/geotiff-decode";
import { imageDataToDataUrl, rasterToImageData } from "@/services/solar/geotiff-decode";

const PANEL_SOURCE = "sunday-google-panels";
const PANEL_LAYER = "sunday-google-panels-fill";
const PANEL_OUTLINE = "sunday-google-panels-line";
const RGB_SOURCE = "sunday-google-rgb";
const RGB_LAYER = "sunday-google-rgb";
const FLUX_SOURCE = "sunday-google-flux";
const FLUX_LAYER = "sunday-google-flux";

function offsetLngLat(
  [lng, lat]: [number, number],
  eastM: number,
  northM: number,
): [number, number] {
  const latRad = (lat * Math.PI) / 180;
  const dLat = northM / 111_320;
  const dLng = eastM / (111_320 * Math.cos(latRad));
  return [lng + dLng, lat + dLat];
}

/** Axis-aligned rectangle in metres around a panel centre (portrait/landscape). */
export function panelRectangle(
  panel: GoogleSolarPanel,
  heightM: number,
  widthM: number,
): [number, number][] {
  const longM = Math.max(heightM, widthM);
  const shortM = Math.min(heightM, widthM);
  const portrait = String(panel.orientation).toUpperCase().startsWith("P");
  const halfE = (portrait ? shortM : longM) / 2;
  const halfN = (portrait ? longM : shortM) / 2;
  const c = panel.centre;
  return [
    offsetLngLat(c, -halfE, -halfN),
    offsetLngLat(c, halfE, -halfN),
    offsetLngLat(c, halfE, halfN),
    offsetLngLat(c, -halfE, halfN),
    offsetLngLat(c, -halfE, -halfN),
  ];
}

export function energyColour(energy: number, min: number, max: number, active: boolean): string {
  if (!active) return "#5a564e";
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (energy - min) / span));
  // Cool → warm solar ramp.
  const r = Math.round(40 + t * 200);
  const g = Math.round(90 + t * 100);
  const b = Math.round(160 - t * 120);
  return `rgb(${r},${g},${b})`;
}

function panelsGeoJson(
  panels: GoogleSolarPanel[],
  count: number,
  heightM: number,
  widthM: number,
  inactive: Set<number>,
  energyMin: number,
  energyMax: number,
): GeoJSON.FeatureCollection {
  const slice = panels.slice(0, Math.max(0, count));
  return {
    type: "FeatureCollection",
    features: slice.map((panel, index) => {
      const active = !inactive.has(index);
      return {
        type: "Feature",
        properties: {
          index,
          energy: panel.yearlyEnergyDcKwh,
          segment: panel.segmentIndex,
          active,
          colour: energyColour(panel.yearlyEnergyDcKwh, energyMin, energyMax, active),
        },
        geometry: {
          type: "Polygon",
          coordinates: [panelRectangle(panel, heightM, widthM)],
        },
      };
    }),
  };
}

export interface RooftopOverlayUrls {
  rgbDataUrl?: string;
  rgbBounds?: { west: number; south: number; east: number; north: number } | null;
  fluxRaster?: DecodedRaster | null;
}

export interface RooftopPanelMapProps {
  insights: BuildingInsights;
  panelCount: number;
  inactivePanels: Set<number>;
  onTogglePanel: (index: number) => void;
  overlays?: RooftopOverlayUrls;
  rgbOpacity?: number;
  showFlux?: boolean;
  fluxOpacity?: number;
  /** When false, hide panel fills so flux/RGB legends dominate. */
  showPanels?: boolean;
  /** When false the map stays mounted but hidden — RGB/flux layers are kept. */
  visible?: boolean;
}

export function RooftopPanelMap({
  insights,
  panelCount,
  inactivePanels,
  onTogglePanel,
  overlays,
  rgbOpacity = 0.65,
  showFlux = false,
  fluxOpacity = 0.55,
  showPanels = true,
  visible = true,
}: RooftopPanelMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const toggleRef = useRef(onTogglePanel);
  toggleRef.current = onTogglePanel;

  const energies = useMemo(() => {
    const slice = insights.solarPanels.slice(0, Math.max(0, panelCount));
    const values = slice.map((panel) => panel.yearlyEnergyDcKwh);
    return {
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 1,
    };
  }, [insights.solarPanels, panelCount]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const style = basemapById("satellite").build({});
    const map = new MapLibreMap({
      container: containerRef.current,
      style,
      center: [insights.centre[0], insights.centre[1]],
      zoom: 19,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    popupRef.current = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 8,
      className: "sunday-map-popup",
    });

    map.on("load", () => {
      map.addSource(PANEL_SOURCE, {
        type: "geojson",
        data: panelsGeoJson(
          insights.solarPanels,
          panelCount,
          insights.panelHeightM,
          insights.panelWidthM,
          inactivePanels,
          energies.min,
          energies.max,
        ),
      });
      map.addLayer({
        id: PANEL_LAYER,
        type: "fill",
        source: PANEL_SOURCE,
        layout: { visibility: showPanels ? "visible" : "none" },
        paint: {
          "fill-color": ["get", "colour"],
          "fill-opacity": ["case", ["boolean", ["get", "active"], true], 0.7, 0.25],
        },
      });
      map.addLayer({
        id: PANEL_OUTLINE,
        type: "line",
        source: PANEL_SOURCE,
        layout: { visibility: showPanels ? "visible" : "none" },
        paint: {
          "line-color": ["case", ["boolean", ["get", "active"], true], "#422c00", "#2a2824"],
          "line-width": 1,
        },
      });

      map.on("mousemove", PANEL_LAYER, (event: MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = "";
        const feature = event.features?.[0];
        if (!feature || !popupRef.current) return;
        const energy = feature.properties?.energy;
        const index = feature.properties?.index;
        const active = feature.properties?.active;
        popupRef.current
          .setLngLat(event.lngLat)
          .setHTML(
            `<div style="color:#1b1710;font:12px/1.4 system-ui,sans-serif">` +
              `<strong>Panel ${Number(index) + 1}</strong><br/>` +
              `${Number(energy).toFixed(0)} kWh/yr DC` +
              (active === false || active === "false" ? "<br/><em>Inactive</em>" : "") +
              `</div>`,
          )
          .addTo(map);
      });
      map.on("mouseleave", PANEL_LAYER, () => {
        map.getCanvas().style.cursor = "";
        popupRef.current?.remove();
      });
      map.on("click", PANEL_LAYER, (event: MapLayerMouseEvent) => {
        const index = event.features?.[0]?.properties?.index;
        if (index === undefined || index === null) return;
        toggleRef.current(Number(index));
      });
    });

    return () => {
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insights.centre[0], insights.centre[1], insights.name]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getSource(PANEL_SOURCE)) return;
    const source = map.getSource(PANEL_SOURCE);
    if (source && "setData" in source) {
      (source as GeoJSONSource).setData(
        panelsGeoJson(
          insights.solarPanels,
          panelCount,
          insights.panelHeightM,
          insights.panelWidthM,
          inactivePanels,
          energies.min,
          energies.max,
        ),
      );
    }
  }, [insights, panelCount, inactivePanels, energies.min, energies.max]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      if (!map.getLayer(PANEL_LAYER)) return;
      const visibility = showPanels ? "visible" : "none";
      map.setLayoutProperty(PANEL_LAYER, "visibility", visibility);
      if (map.getLayer(PANEL_OUTLINE)) {
        map.setLayoutProperty(PANEL_OUTLINE, "visibility", visibility);
      }
    };
    apply();
    // First toggle can race map load; re-apply once the style is ready.
    map.once("idle", apply);
  }, [showPanels]);

  // RGB overlay. Wait for style load so a remount still paints.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const bounds = overlays?.rgbBounds;
      const url = overlays?.rgbDataUrl;
      if (map.getLayer(RGB_LAYER)) map.removeLayer(RGB_LAYER);
      if (map.getSource(RGB_SOURCE)) map.removeSource(RGB_SOURCE);
      if (!url || !bounds) return;
      const coordinates: [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ] = [
        [bounds.west, bounds.north],
        [bounds.east, bounds.north],
        [bounds.east, bounds.south],
        [bounds.west, bounds.south],
      ];
      map.addSource(RGB_SOURCE, { type: "image", url, coordinates });
      map.addLayer(
        {
          id: RGB_LAYER,
          type: "raster",
          source: RGB_SOURCE,
          paint: { "raster-opacity": rgbOpacity },
        },
        map.getLayer(PANEL_LAYER) ? PANEL_LAYER : undefined,
      );
    };
    return whenStyleReady(map, apply);
  }, [overlays?.rgbDataUrl, overlays?.rgbBounds, rgbOpacity]);

  // Annual / monthly flux overlay.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const raster = overlays?.fluxRaster;
      if (map.getLayer(FLUX_LAYER)) map.removeLayer(FLUX_LAYER);
      if (map.getSource(FLUX_SOURCE)) map.removeSource(FLUX_SOURCE);
      if (!showFlux || !raster?.bounds) return;
      const dataUrl = imageDataToDataUrl(rasterToImageData(raster));
      const { west, south, east, north } = raster.bounds;
      const coordinates: [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ] = [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ];
      map.addSource(FLUX_SOURCE, { type: "image", url: dataUrl, coordinates });
      map.addLayer(
        {
          id: FLUX_LAYER,
          type: "raster",
          source: FLUX_SOURCE,
          paint: { "raster-opacity": fluxOpacity },
        },
        map.getLayer(PANEL_LAYER) ? PANEL_LAYER : undefined,
      );
    };
    return whenStyleReady(map, apply);
  }, [overlays?.fluxRaster, showFlux, fluxOpacity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!visible || !map) return;
    requestAnimationFrame(() => map.resize());
  }, [visible]);

  const shown = Math.min(panelCount, insights.solarPanels.length);
  let inactiveShown = 0;
  for (const index of inactivePanels) {
    if (index >= 0 && index < shown) inactiveShown += 1;
  }
  const activeCount = Math.max(0, shown - inactiveShown);
  const flux = overlays?.fluxRaster;
  const showFluxLegend = Boolean(showFlux && flux && !showPanels);

  return (
    <div className="rooftop-panel-map">
      <div ref={containerRef} className="rooftop-panel-map__canvas" />
      <div className="rooftop-panel-map__legend">
        {showFluxLegend && flux ? (
          <>
            <span
              className="rooftop-panel-map__swatch"
              style={{ background: "rgb(59, 47, 107)" }}
            />
            {flux.min.toFixed(0)}
            <span className="rooftop-panel-map__swatch rooftop-panel-map__swatch--flux" />
            <span
              className="rooftop-panel-map__swatch"
              style={{ background: "rgb(255, 240, 194)" }}
            />
            {flux.max.toFixed(0)} kWh/kWp/yr flux
          </>
        ) : (
          <>
            <span
              className="rooftop-panel-map__swatch"
              style={{ background: energyColour(energies.min, energies.min, energies.max, true) }}
            />
            {energies.min.toFixed(0)}
            <span className="rooftop-panel-map__swatch rooftop-panel-map__swatch--mid" />
            <span
              className="rooftop-panel-map__swatch"
              style={{ background: energyColour(energies.max, energies.min, energies.max, true) }}
            />
            {energies.max.toFixed(0)} kWh/yr DC
          </>
        )}
      </div>
      <p className="rooftop-panel-map__note">
        {activeCount} active of {shown} shown panels
        {inactiveShown > 0 ? ` (${inactiveShown} inactive — excluded from totals/exports)` : ""}
        {showPanels ? " · click a panel to toggle" : " · panels hidden"}. Positions may sit
        slightly off the Esri basemap; Google RGB aligns better when loaded.
      </p>
    </div>
  );
}

export function segmentStatsForPanel(
  insights: BuildingInsights,
  panel: GoogleSolarPanel,
): RoofSegment | undefined {
  return insights.roofSegments.find((segment) => segment.index === panel.segmentIndex);
}

export type PanelExportRow = {
  panel: number;
  segment: number;
  lat: number;
  lon: number;
  energy: number;
  pitch: number | "";
  azimuth: number | "";
  orientation: string;
  active: "yes" | "no";
};

/** Active panels only — used for GeoJSON and totals. */
export function activePanelsExport(
  insights: BuildingInsights,
  panelCount: number,
  inactive: Set<number>,
): PanelExportRow[] {
  return allPanelsExport(insights, panelCount, inactive).filter((row) => row.active === "yes");
}

/** All shown panels with an active flag — preferred for CSV. */
export function allPanelsExport(
  insights: BuildingInsights,
  panelCount: number,
  inactive: Set<number>,
): PanelExportRow[] {
  return insights.solarPanels.slice(0, panelCount).map((panel, index) => {
    const segment = segmentStatsForPanel(insights, panel);
    return {
      panel: index + 1,
      segment: panel.segmentIndex,
      lat: panel.centre[1],
      lon: panel.centre[0],
      energy: panel.yearlyEnergyDcKwh,
      pitch: segment?.pitchDegrees ?? "",
      azimuth: segment?.azimuthDegrees ?? "",
      orientation: panel.orientation,
      active: inactive.has(index) ? "no" : "yes",
    };
  });
}

/**
 * Composite RGB base + energy-coloured active panels for HTML export.
 * Inactive panels are drawn dimmer so the report still shows the full layout.
 */
export async function composeRgbPanelsDataUrl(options: {
  rgbDataUrl: string;
  bounds: { west: number; south: number; east: number; north: number };
  insights: BuildingInsights;
  panelCount: number;
  inactive: Set<number>;
  width?: number;
}): Promise<string | null> {
  const width = options.width ?? 900;
  const { west, south, east, north } = options.bounds;
  const spanLng = east - west || 1e-9;
  const spanLat = north - south || 1e-9;
  const height = Math.round(width * (spanLat / spanLng));

  const image = await loadImage(options.rgbDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);

  const slice = options.insights.solarPanels.slice(0, Math.max(0, options.panelCount));
  const active = slice.filter((_, index) => !options.inactive.has(index));
  const energies = active.map((panel) => panel.yearlyEnergyDcKwh);
  const min = energies.length ? Math.min(...energies) : 0;
  const max = energies.length ? Math.max(...energies) : 1;

  const toPx = (lng: number, lat: number): [number, number] => [
    ((lng - west) / spanLng) * width,
    ((north - lat) / spanLat) * height,
  ];

  // Report image shows active panels only — inactive are omitted so the ramp
  // stays unambiguous and the layout the user kept is what prints.
  slice.forEach((panel, index) => {
    if (options.inactive.has(index)) return;
    const ring = panelRectangle(panel, options.insights.panelHeightM, options.insights.panelWidthM);
    ctx.beginPath();
    ring.forEach(([lng, lat], i) => {
      const [x, y] = toPx(lng, lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = energyColour(panel.yearlyEnergyDcKwh, min, max, true);
    ctx.globalAlpha = 0.78;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#422c00";
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  return canvas.toDataURL("image/jpeg", 0.88);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode RGB imagery"));
    image.src = src;
  });
}

/** Run `apply` now if the style is ready, otherwise on the next `load`. */
function whenStyleReady(map: MapLibreMap, apply: () => void): () => void {
  if (map.isStyleLoaded()) {
    apply();
    return () => undefined;
  }
  map.once("load", apply);
  return () => {
    map.off("load", apply);
  };
}
