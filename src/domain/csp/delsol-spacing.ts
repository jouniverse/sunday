/**
 * DELSOL empirical field sketches (SolarPILOT help resource).
 *
 * Used only as a labelled sketch when PySAM/SolarPILOT is unavailable, and as
 * the live schematic while the designer moves tower height / layout method.
 * This is not a SolarPILOT layout and must never be presented as annual energy.
 *
 * Source: SolarPILOT DelsolEmpiricalSpacing.py / Wagner & Wendelin (2018) lineage.
 */

import type { LngLat, Point2D } from "../geometry";
import { distanceToBoundary2D, pointInPolygon2D, polygonBounds2D } from "../geometry";
import { localPointToLngLat, ringToLocalFrame, unavailableSetbackM } from "./local-frame";
import type { CspHeliostatLayout, CspLayoutMethod } from "./types";

function delsolSpacing(
  radiusM: number,
  towerHeightM: number,
  helioWidthM: number,
): { rsep: number; asep: number } {
  const phi0 = Math.atan(towerHeightM / Math.max(radiusM, 1));
  const tanPhi = Math.tan(phi0);
  let rsep =
    1.1442399 / Math.max(tanPhi, 1e-3) - 1.093519 + 3.0683558 * phi0 - 1.1255617 * phi0 * phi0;
  let asep = 1.7490871 + 0.63964099 * phi0 + 0.028726279 / (phi0 - 0.049023315);
  asep *= 1 / (1 - (rsep * helioWidthM) / (towerHeightM * 2 * Math.max(radiusM, 1)));
  rsep *= 0.5;
  return { rsep: Math.max(1.1, rsep), asep: Math.max(1.1, asep) };
}

function insideUsable(polygon: Point2D[], point: Point2D, setbackM: number): boolean {
  if (!pointInPolygon2D(polygon, point)) return false;
  if (setbackM > 0 && distanceToBoundary2D(polygon, point) < setbackM) return false;
  return true;
}

function radialStagger(
  polygon: Point2D[],
  tht: number,
  hw: number,
  maxHeliostats: number,
  setbackM: number,
): Point2D[] {
  const rMin = tht * 0.75;
  const rMax = tht * 8.5;
  const positions: Point2D[] = [];
  for (let r = rMin; r <= rMax && positions.length < maxHeliostats; ) {
    const { rsep, asep } = delsolSpacing(r, tht, hw);
    const stepR = rsep * hw;
    const circ = 2 * Math.PI * r;
    const count = Math.max(6, Math.floor(circ / (asep * hw)));
    const dTheta = (2 * Math.PI) / count;
    for (let i = 0; i < count && positions.length < maxHeliostats; i += 1) {
      const theta = i * dTheta;
      const point = { x: r * Math.sin(theta), y: r * Math.cos(theta) };
      if (insideUsable(polygon, point, setbackM)) positions.push(point);
    }
    r += stepR;
  }
  return positions;
}

function cornfieldGrid(
  polygon: Point2D[],
  tht: number,
  hw: number,
  maxHeliostats: number,
  setbackM: number,
): Point2D[] {
  const rMin = tht * 0.75;
  const rChar = tht * 3;
  const { rsep, asep } = delsolSpacing(rChar, tht, hw);
  const dx = asep * hw;
  const dy = rsep * hw;
  const bounds = polygonBounds2D(polygon);
  const positions: Point2D[] = [];
  for (let y = bounds.minY + dy / 2; y <= bounds.maxY && positions.length < maxHeliostats; y += dy) {
    for (let x = bounds.minX + dx / 2; x <= bounds.maxX && positions.length < maxHeliostats; x += dx) {
      const point = { x, y };
      const radius = Math.hypot(x, y);
      if (radius < rMin) continue;
      if (insideUsable(polygon, point, setbackM)) positions.push(point);
    }
  }
  return positions;
}

export function delsolSpacingSketch(options: {
  ring: LngLat[];
  towerHeightM: number;
  heliostatWidthM: number;
  heliostatHeightM: number;
  layoutMethod?: CspLayoutMethod;
  landUnavailableFraction?: number;
}): CspHeliostatLayout | null {
  if (options.ring.length < 3) return null;
  const { polygon, origin } = ringToLocalFrame(options.ring);
  const tht = options.towerHeightM;
  const hw = options.heliostatWidthM;
  const maxHeliostats = 8_000;
  const layoutMethod = options.layoutMethod ?? "radial_stagger";
  const setbackM = unavailableSetbackM(polygon, options.landUnavailableFraction ?? 0);
  const positions =
    layoutMethod === "cornfield"
      ? cornfieldGrid(polygon, tht, hw, maxHeliostats, setbackM)
      : radialStagger(polygon, tht, hw, maxHeliostats, setbackM);

  return {
    origin,
    positionsLocal: positions,
    positionsLngLat: positions.map((p) => localPointToLngLat(p, origin)),
    heliostatCount: positions.length,
    reflectiveAreaM2: positions.length * options.heliostatWidthM * options.heliostatHeightM,
    method:
      layoutMethod === "cornfield" ? "delsol-cornfield-sketch" : "delsol-spacing-sketch",
  };
}
