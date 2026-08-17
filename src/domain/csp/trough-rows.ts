/**
 * Parabolic-trough row packing inside a site polygon.
 *
 * SSC TroughPhysical sizes loops/SCAs; it does not auto-place a heliostat-style
 * scatter. These rows are Sunday geometry for the schematic and for export.
 * Method string must stay `sunday-trough-rows`, never SolarPILOT.
 */

import type { LngLat } from "../geometry";
import {
  polygonBounds2D,
  rectangleInPolygon,
  rotatePoint2D,
} from "../geometry";
import { localPointToLngLat, ringToLocalFrame, unavailableSetbackM } from "./local-frame";
import type { CspTroughLayout } from "./types";

export function packTroughRows(options: {
  ring: LngLat[];
  rowPitchM: number;
  apertureM: number;
  /** Tracking-axis azimuth (degrees from north); 0 ≈ N–S rows. */
  rowAzimuthDegrees: number;
  /** Preferred length of one drawn SCA strip, m. */
  scaLengthM?: number;
  landUnavailableFraction?: number;
}): CspTroughLayout | null {
  if (options.ring.length < 3) return null;
  const { polygon, origin } = ringToLocalFrame(options.ring);
  const pitchM = Math.max(options.apertureM + 2, options.rowPitchM);
  const apertureM = options.apertureM;
  const preferredLength = options.scaLengthM ?? 48;
  const minLength = Math.max(8, apertureM);
  const gridRotation = -options.rowAzimuthDegrees;
  const rotated = polygon.map((point) => rotatePoint2D(point, gridRotation));
  const bounds = polygonBounds2D(rotated);
  const setbackM = unavailableSetbackM(rotated, options.landUnavailableFraction ?? 0);

  const strips: Array<{ x: number; y: number; width: number; height: number }> = [];
  const maxStrips = 4_000;
  for (let y = bounds.minY; y + apertureM <= bounds.maxY && strips.length < maxStrips; y += pitchM) {
    let x = bounds.minX;
    while (x + minLength <= bounds.maxX && strips.length < maxStrips) {
      let width = Math.min(preferredLength, bounds.maxX - x);
      while (width >= minLength && !rectangleInPolygon(rotated, x, y, width, apertureM, setbackM)) {
        width -= 2;
      }
      if (width >= minLength && rectangleInPolygon(rotated, x, y, width, apertureM, setbackM)) {
        strips.push({ x, y, width, height: apertureM });
        x += width + 2;
      } else {
        x += 2;
      }
    }
  }

  const stripsLngLat = strips.map((strip) => {
    const corners = [
      { x: strip.x, y: strip.y },
      { x: strip.x + strip.width, y: strip.y },
      { x: strip.x + strip.width, y: strip.y + strip.height },
      { x: strip.x, y: strip.y + strip.height },
    ].map((corner) => rotatePoint2D(corner, -gridRotation));
    return corners.map((corner) => localPointToLngLat(corner, origin));
  });

  return {
    origin,
    stripsLngLat,
    rowCount: strips.length,
    apertureAreaM2: strips.reduce((sum, strip) => sum + strip.width * strip.height, 0),
    pitchM,
    method: "sunday-trough-rows",
  };
}
