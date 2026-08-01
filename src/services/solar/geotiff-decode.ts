/**
 * Decodes Google Solar GeoTIFF responses into typed rasters the UI can palette
 * and overlay. Ported from the patterns in the official js-solar-potential
 * sample: fetch the authorised URL, decode with geotiff.js, apply a colour ramp.
 */

import { fromArrayBuffer } from "geotiff";
import { authorizeLayerUrl } from "../solar/google-solar";

export interface DecodedRaster {
  width: number;
  height: number;
  /** Row-major band 0 values. */
  values: Float32Array;
  min: number;
  max: number;
  nodata: number | null;
  /** Bounds if the GeoTIFF carries a ModelTiepoint + ModelPixelScale, else null. */
  bounds: { west: number; south: number; east: number; north: number } | null;
  method: string;
}

export type Rgba = [number, number, number, number];

/** Solar-amber ramp used for annual flux overlays. */
export const FLUX_RAMP: Array<{ stop: number; colour: Rgba }> = [
  { stop: 0, colour: [59, 47, 107, 220] },
  { stop: 0.25, colour: [107, 79, 160, 220] },
  { stop: 0.5, colour: [217, 164, 65, 230] },
  { stop: 0.75, colour: [247, 191, 89, 240] },
  { stop: 1, colour: [255, 240, 194, 255] },
];

/**
 * Fetches and decodes a Google Solar data-layer GeoTIFF.
 *
 * The key is appended here and never stored; the returned raster carries no
 * credentials.
 */
export async function decodeGoogleSolarGeoTiff(options: {
  url: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<DecodedRaster> {
  const authorised = authorizeLayerUrl(options.url, options.apiKey);
  const response = await fetch(authorised, { signal: options.signal });
  if (!response.ok) {
    throw new Error(
      `Google Solar GeoTIFF fetch failed (${response.status}). Check the key and that the URL has not expired.`,
    );
  }
  const buffer = await response.arrayBuffer();
  return decodeGeoTiffBuffer(buffer);
}

export async function decodeGeoTiffBuffer(buffer: ArrayBuffer): Promise<DecodedRaster> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters({ interleave: false });
  const band = rasters[0];
  if (!band) {
    throw new Error("GeoTIFF has no bands");
  }

  const values = band instanceof Float32Array ? band : Float32Array.from(band as ArrayLike<number>);
  const fileDirectory = image.fileDirectory as {
    GDAL_NODATA?: string;
    ModelPixelScale?: number[];
    ModelTiepoint?: number[];
  };
  const nodataRaw = fileDirectory.GDAL_NODATA;
  const nodata = nodataRaw !== undefined ? Number(nodataRaw) : null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] as number;
    if (!Number.isFinite(value)) continue;
    if (nodata !== null && value === nodata) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }

  return {
    width,
    height,
    values,
    min,
    max,
    nodata: nodata !== null && Number.isFinite(nodata) ? nodata : null,
    bounds:
      boundsFromGeoKeys(fileDirectory, width, height) ??
      boundsFromImageBbox(image, width, height),
    method: "geotiff.js decode of Google Solar data-layer GeoTIFF",
  };
}

/** Prefer geotiff.js getBoundingBox when ModelTiepoint tags are missing. */
function boundsFromImageBbox(
  image: { getBoundingBox?: () => number[] },
  _width: number,
  _height: number,
): DecodedRaster["bounds"] {
  try {
    const bbox = image.getBoundingBox?.();
    if (!bbox || bbox.length < 4) return null;
    const west = bbox[0] as number;
    const south = bbox[1] as number;
    const east = bbox[2] as number;
    const north = bbox[3] as number;
    if (![west, south, east, north].every(Number.isFinite)) return null;
    // Reject clearly non-geographic ranges (e.g. projected metres).
    if (Math.abs(west) > 180 || Math.abs(east) > 180 || Math.abs(south) > 90 || Math.abs(north) > 90) {
      return null;
    }
    return { west, south, east, north };
  } catch {
    return null;
  }
}

/** Fallback when a GeoTIFF has no georeference: square around a centre. */
export function boundsAroundPoint(
  longitude: number,
  latitude: number,
  radiusMeters: number,
): NonNullable<DecodedRaster["bounds"]> {
  const dLat = radiusMeters / 111_320;
  const dLng = radiusMeters / (111_320 * Math.cos((latitude * Math.PI) / 180) || 1);
  return {
    west: longitude - dLng,
    east: longitude + dLng,
    south: latitude - dLat,
    north: latitude + dLat,
  };
}

function boundsFromGeoKeys(
  fileDirectory: {
    ModelPixelScale?: number[];
    ModelTiepoint?: number[];
  },
  width: number,
  height: number,
): DecodedRaster["bounds"] {
  const scale = fileDirectory.ModelPixelScale;
  const tie = fileDirectory.ModelTiepoint;
  if (!scale || !tie || scale.length < 2 || tie.length < 6) return null;
  const pixelWidth = scale[0] as number;
  const pixelHeight = scale[1] as number;
  const originX = tie[3] as number;
  const originY = tie[4] as number;
  // GeoTIFF pixel height is typically positive in ModelPixelScale while the
  // geotransform itself goes north-up (negative y). Prefer north-up bounds.
  const south = originY - Math.abs(pixelHeight) * height;
  const north = originY;
  const west = originX;
  const east = originX + pixelWidth * width;
  return { west, south, east, north };
}

/**
 * Renders a decoded single-band raster to RGBA bytes using a ramp.
 * Returns raw bytes so unit tests do not need a canvas / ImageData polyfill.
 */
export function rasterToRgba(
  raster: DecodedRaster,
  ramp: Array<{ stop: number; colour: Rgba }> = FLUX_RAMP,
): { width: number; height: number; data: Uint8ClampedArray } {
  const { width, height, values, min, max, nodata } = raster;
  const data = new Uint8ClampedArray(width * height * 4);
  const span = max - min || 1;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] as number;
    const offset = i * 4;
    if (!Number.isFinite(value) || (nodata !== null && value === nodata)) {
      data[offset + 3] = 0;
      continue;
    }
    const t = Math.min(1, Math.max(0, (value - min) / span));
    const colour = sampleRamp(ramp, t);
    data[offset] = colour[0];
    data[offset + 1] = colour[1];
    data[offset + 2] = colour[2];
    data[offset + 3] = colour[3];
  }

  return { width, height, data };
}

/**
 * Renders a decoded single-band raster to an RGBA ImageData using a ramp.
 * Values outside [min,max] of the raster collapse to transparent.
 */
export function rasterToImageData(
  raster: DecodedRaster,
  ramp: Array<{ stop: number; colour: Rgba }> = FLUX_RAMP,
): ImageData {
  const { width, height, data } = rasterToRgba(raster, ramp);
  // Copy into a fresh ArrayBuffer-backed view — DOM ImageData rejects SharedArrayBuffer.
  const copy = new Uint8ClampedArray(data.length);
  copy.set(data);
  return new ImageData(copy, width, height);
}

function sampleRamp(ramp: Array<{ stop: number; colour: Rgba }>, t: number): Rgba {
  const first = ramp[0];
  if (!first) return [0, 0, 0, 0];
  if (t <= first.stop) return first.colour;
  for (let i = 1; i < ramp.length; i += 1) {
    const prev = ramp[i - 1];
    const next = ramp[i];
    if (!prev || !next) continue;
    if (t <= next.stop) {
      const local = (t - prev.stop) / (next.stop - prev.stop || 1);
      return [
        Math.round(prev.colour[0] + (next.colour[0] - prev.colour[0]) * local),
        Math.round(prev.colour[1] + (next.colour[1] - prev.colour[1]) * local),
        Math.round(prev.colour[2] + (next.colour[2] - prev.colour[2]) * local),
        Math.round(prev.colour[3] + (next.colour[3] - prev.colour[3]) * local),
      ];
    }
  }
  return ramp[ramp.length - 1]?.colour ?? first.colour;
}

/** Data-URL for MapLibre image sources / canvas overlays. */
export function imageDataToDataUrl(image: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

export interface DecodedRgbRaster {
  width: number;
  height: number;
  dataUrl: string;
  bounds: DecodedRaster["bounds"];
  method: string;
}

/** Decodes a 3-band Google Solar RGB GeoTIFF into a PNG data URL. */
export async function decodeGoogleSolarRgb(options: {
  url: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<DecodedRgbRaster> {
  const authorised = authorizeLayerUrl(options.url, options.apiKey);
  const response = await fetch(authorised, { signal: options.signal });
  if (!response.ok) {
    throw new Error(
      `Google Solar RGB GeoTIFF fetch failed (${response.status}). Check the key and coverage.`,
    );
  }
  const buffer = await response.arrayBuffer();
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters({ interleave: false });
  const r = rasters[0];
  const g = rasters[1] ?? rasters[0];
  const b = rasters[2] ?? rasters[0];
  if (!r || !g || !b) throw new Error("RGB GeoTIFF is missing bands");

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    data[offset] = Number(r[i]);
    data[offset + 1] = Number(g[i]);
    data[offset + 2] = Number(b[i]);
    data[offset + 3] = 255;
  }
  const copy = new Uint8ClampedArray(data.length);
  copy.set(data);
  const imageData = new ImageData(copy, width, height);
  const fileDirectory = image.fileDirectory as {
    ModelPixelScale?: number[];
    ModelTiepoint?: number[];
  };

  return {
    width,
    height,
    dataUrl: imageDataToDataUrl(imageData),
    bounds:
      boundsFromGeoKeys(fileDirectory, width, height) ??
      boundsFromImageBbox(image, width, height),
    method: "geotiff.js RGB decode of Google Solar imagery layer",
  };
}

/**
 * Decodes one band from a multi-band flux GeoTIFF (e.g. monthly flux month 1–12).
 * `bandIndex` is 0-based.
 */
export async function decodeGoogleSolarBand(options: {
  url: string;
  apiKey: string;
  bandIndex: number;
  signal?: AbortSignal;
}): Promise<DecodedRaster> {
  const authorised = authorizeLayerUrl(options.url, options.apiKey);
  const response = await fetch(authorised, { signal: options.signal });
  if (!response.ok) {
    throw new Error(
      `Google Solar GeoTIFF fetch failed (${response.status}). Check the key and that the URL has not expired.`,
    );
  }
  const buffer = await response.arrayBuffer();
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters({ interleave: false });
  const band = rasters[options.bandIndex] ?? rasters[0];
  if (!band) throw new Error("GeoTIFF has no bands");

  const values = band instanceof Float32Array ? band : Float32Array.from(band as ArrayLike<number>);
  const fileDirectory = image.fileDirectory as {
    GDAL_NODATA?: string;
    ModelPixelScale?: number[];
    ModelTiepoint?: number[];
  };
  const nodataRaw = fileDirectory.GDAL_NODATA;
  const nodata = nodataRaw !== undefined ? Number(nodataRaw) : null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] as number;
    if (!Number.isFinite(value)) continue;
    if (nodata !== null && value === nodata) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }

  return {
    width,
    height,
    values,
    min,
    max,
    nodata: nodata !== null && Number.isFinite(nodata) ? nodata : null,
    bounds:
      boundsFromGeoKeys(fileDirectory, width, height) ??
      boundsFromImageBbox(image, width, height),
    method: `geotiff.js band ${options.bandIndex} of Google Solar data-layer GeoTIFF`,
  };
}
