/**
 * Basemap registry.
 *
 * Site selection needs more than satellite imagery: a topographic map to read
 * terrain, a street map to find access, and a hillshade to judge slope. Each
 * entry declares its attribution and whether it needs a key, because the app runs
 * on the user's own credentials and must never silently break a provider's terms.
 */

import type { StyleSpecification } from "maplibre-gl";

export type BasemapId =
  | "satellite"
  | "streets"
  | "topographic"
  | "terrain-shade"
  | "countries"
  | "blank";

export interface BasemapDefinition {
  id: BasemapId;
  label: string;
  /** One line explaining when this basemap is the right choice. */
  purpose: string;
  attribution: string;
  /** Provider key required, if any; the basemap is disabled without it. */
  requiresKey?: "maptiler" | "stadia";
  /** Whether the source can carry a 3D terrain mesh. */
  supportsTerrain?: boolean;
  build: (keys: Partial<Record<string, string>>) => StyleSpecification;
}

/**
 * Free glyph atlas for MapLibre symbol layers (cluster counts, etc.).
 * Attached to every basemap so cluster labels work on Satellite / Streets too.
 */
const MAP_GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

/** Raster style from a single XYZ tile template. */
function rasterStyle(options: {
  url: string | string[];
  attribution: string;
  maxzoom?: number;
  background: string;
  /** Soften bright street tiles so overlays remain readable. */
  opacity?: number;
}): StyleSpecification {
  return {
    version: 8,
    glyphs: MAP_GLYPHS,
    sources: {
      base: {
        type: "raster",
        tiles: Array.isArray(options.url) ? options.url : [options.url],
        tileSize: 256,
        maxzoom: options.maxzoom ?? 19,
        attribution: options.attribution,
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": options.background } },
      {
        id: "base",
        type: "raster",
        source: "base",
        paint: { "raster-opacity": options.opacity ?? 1 },
      },
    ],
  };
}

export const BASEMAPS: BasemapDefinition[] = [
  {
    id: "satellite",
    label: "Satellite",
    purpose: "Reading roofs, existing arrays and ground cover.",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    build: () =>
      rasterStyle({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
        background: "#0f0c07",
      }),
  },
  {
    id: "streets",
    label: "Streets",
    purpose: "Access roads, parcels and place names.",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    build: () =>
      rasterStyle({
        // Voyager is readable but bright; dial opacity so site overlays stay primary.
        url: [
          "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
          "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
          "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
        ],
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
        maxzoom: 20,
        background: "#e8e4db",
        opacity: 0.78,
      }),
  },
  {
    id: "topographic",
    label: "Topographic",
    purpose: "Contours and relief, for judging slope before sampling a DEM.",
    attribution: "&copy; OpenTopoMap (CC-BY-SA) &copy; OpenStreetMap contributors",
    build: () =>
      rasterStyle({
        url: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
        attribution: "&copy; OpenTopoMap (CC-BY-SA) &copy; OpenStreetMap contributors",
        maxzoom: 17,
        background: "#17130c",
      }),
  },
  {
    id: "terrain-shade",
    label: "Terrain 3D",
    purpose: "Hillshade with an optional 3D mesh, for slope and aspect.",
    attribution: "&copy; MapTiler &copy; OpenStreetMap contributors",
    requiresKey: "maptiler",
    supportsTerrain: true,
    build: (keys) => {
      const key = keys.maptiler ?? "";
      return {
        version: 8,
        glyphs: MAP_GLYPHS,
        sources: {
          base: {
            type: "raster",
            tiles: [`https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.jpg?key=${key}`],
            tileSize: 256,
            maxzoom: 20,
            attribution: "&copy; MapTiler &copy; OpenStreetMap contributors",
          },
          // Separate DEM sources: MapLibre warns when one source feeds hillshade + terrain.
          hillshadeDem: {
            type: "raster-dem",
            url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`,
            tileSize: 256,
          },
          terrain: {
            type: "raster-dem",
            url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${key}`,
            tileSize: 256,
          },
        },
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#0f0c07" } },
          { id: "base", type: "raster", source: "base" },
          {
            id: "hillshade",
            type: "hillshade",
            source: "hillshadeDem",
            paint: {
              "hillshade-shadow-color": "#0a0805",
              "hillshade-highlight-color": "#d3c4b1",
              "hillshade-exaggeration": 0.4,
            },
          },
        ],
        terrain: { source: "terrain", exaggeration: 1 },
      };
    },
  },
  {
    id: "countries",
    label: "Countries",
    purpose: "Dark schematic with country outlines — best for sparse global data layers.",
    attribution: "Natural Earth / country boundaries",
    build: () => ({
      version: 8,
      glyphs: MAP_GLYPHS,
      sources: {
        countries: {
          type: "geojson",
          // Served from Vite `public/data` in both browser and tauri:dev.
          data: "/data/countries.geojson",
        },
      },
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#12100c" } },
        {
          id: "countries-fill",
          type: "fill",
          source: "countries",
          paint: {
            "fill-color": "#1c1914",
            "fill-opacity": 0.95,
          },
        },
        {
          id: "countries-line",
          type: "line",
          source: "countries",
          paint: {
            "line-color": "#6b6152",
            "line-width": 0.8,
            "line-opacity": 0.85,
          },
        },
      ],
    }),
  },
  {
    id: "blank",
    label: "None",
    purpose: "Data layers on a plain canvas, with no imagery to read through.",
    attribution: "",
    build: () => ({
      version: 8,
      glyphs: MAP_GLYPHS,
      sources: {},
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#0f0c07" } },
      ],
    }),
  },
];

export function basemapById(id: BasemapId): BasemapDefinition {
  return BASEMAPS.find((basemap) => basemap.id === id) ?? (BASEMAPS[0] as BasemapDefinition);
}

/** Basemaps usable with the keys currently configured. */
export function availableBasemaps(configuredKeys: string[]): BasemapDefinition[] {
  return BASEMAPS.filter(
    (basemap) => !basemap.requiresKey || configuredKeys.includes(basemap.requiresKey),
  );
}

/**
 * Ground resolution in metres per pixel at a given zoom and latitude.
 *
 * The draw engine needs this to keep its snap radius a constant number of pixels,
 * and the scale bar needs it to be right. The 156543.03392 constant is the
 * equatorial metres per pixel at zoom 0 for 256 px tiles.
 */
export function metresPerPixel(zoom: number, latitude: number): number {
  const EQUATORIAL_M_PER_PX_Z0 = 156_543.033_92;
  return (EQUATORIAL_M_PER_PX_Z0 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

/** A round scale-bar length and its pixel width at the current scale. */
export function scaleBarFor(
  zoom: number,
  latitude: number,
  maxPixels = 90,
): { label: string; pixels: number } {
  const mpp = metresPerPixel(zoom, latitude);
  const maxMetres = mpp * maxPixels;
  // Round steps only: a scale bar reading "137 m" is useless for pacing distance.
  const steps = [
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000,
    200_000, 500_000, 1_000_000, 2_000_000,
  ];
  const chosen = [...steps].reverse().find((step) => step <= maxMetres) ?? steps[0] ?? 1;
  return {
    label: chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`,
    pixels: chosen / mpp,
  };
}
