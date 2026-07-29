/**
 * Rooftop module packing.
 *
 * Unlike the ground-mount case, rooftops are small enough that placing actual
 * modules is both tractable and necessary: a designer will look at the result and
 * count panels. The approach follows the reviewable auto-layout pattern from the
 * Solar-Roof-AI review — propose a grid, then let the user adjust it.
 *
 * Geometry is done in a local metres frame, not in degrees, so that a roof at
 * 60°N is not silently stretched. `toLocalFrame` in `../geometry` handles the
 * projection.
 */

import type { Point2D, Polygon2D } from "../geometry";
import {
  polygonArea2D,
  polygonBounds2D,
  pointInPolygon2D,
  rectangleInPolygon,
  rotatePoint2D,
} from "../geometry";
import type { ModuleSpec } from "./priors";
import { ROOFTOP_DEFAULTS } from "./priors";

export type ModuleOrientation = "portrait" | "landscape";

export interface PlacedModule {
  /** Corners in the local metres frame, clockwise from the lower-left. */
  corners: [Point2D, Point2D, Point2D, Point2D];
  centre: Point2D;
  orientation: ModuleOrientation;
  /** Row index up the roof, for wiring into strings later. */
  row: number;
  column: number;
}

export interface RooftopPackingInput {
  /** Roof outline in a local metres frame. */
  roof: Polygon2D;
  /** Obstructions to avoid: vents, chimneys, plant, skylights. */
  exclusions?: Polygon2D[];
  module: ModuleSpec;
  orientation: ModuleOrientation;
  /**
   * Rotation of the module grid within the roof plane, degrees. For a pitched
   * roof this aligns modules with the eaves; for flat roofs it is the array
   * azimuth relative to the local frame's x-axis.
   */
  gridRotationDegrees: number;
  perimeterSetbackM?: number;
  moduleGapM?: number;
  /** Extra clearance kept around each exclusion polygon. */
  obstacleClearanceM?: number;
  /** Row pitch for a flat-roof tilted rack; omit for flush-mounted modules. */
  rowPitchM?: number;
}

export interface RooftopPackingResult {
  modules: PlacedModule[];
  moduleCount: number;
  capacityKwDc: number;
  /** Module aperture area over gross roof area. */
  coverage: number;
  roofAreaM2: number;
  usableAreaM2: number;
  moduleAreaM2: number;
  orientation: ModuleOrientation;
  gridRotationDegrees: number;
  method: string;
  notes: string[];
}

/**
 * Packs modules into a roof polygon.
 *
 * A module is kept only if all four of its corners lie inside the setback-shrunk
 * roof and outside every exclusion. Corner testing rather than centre testing is
 * the point: a centre test would happily hang a module over the eaves.
 */
export function packRooftop(input: RooftopPackingInput): RooftopPackingResult {
  const {
    roof,
    exclusions = [],
    module,
    orientation,
    gridRotationDegrees,
    perimeterSetbackM = ROOFTOP_DEFAULTS.perimeterSetbackM,
    moduleGapM = ROOFTOP_DEFAULTS.moduleGapM,
    obstacleClearanceM = ROOFTOP_DEFAULTS.obstacleClearanceM,
    rowPitchM,
  } = input;

  const notes: string[] = [];
  const roofAreaM2 = polygonArea2D(roof);

  if (roofAreaM2 <= 0) {
    return empty(orientation, gridRotationDegrees, 0, ["Roof outline encloses no area."]);
  }

  // Module footprint in the grid frame.
  const moduleWidth = orientation === "portrait" ? module.widthM : module.lengthM;
  const moduleHeight = orientation === "portrait" ? module.lengthM : module.widthM;
  const stepX = moduleWidth + moduleGapM;
  const stepY = (rowPitchM ?? moduleHeight + moduleGapM);

  if (rowPitchM !== undefined && rowPitchM < moduleHeight) {
    notes.push(
      `Row pitch of ${rowPitchM.toFixed(2)} m is shorter than the ${moduleHeight.toFixed(2)} m ` +
        "module, so rows would overlap. Increase the pitch.",
    );
    return empty(orientation, gridRotationDegrees, roofAreaM2, notes);
  }

  // Work in the grid frame: rotate the roof by -rotation, lay out an axis-aligned
  // grid, then rotate each placed module back. Rotating the geometry once is
  // cheaper and less error-prone than rotating every candidate rectangle.
  const rotation = -gridRotationDegrees;
  const roofInGrid = roof.map((point) => rotatePoint2D(point, rotation));
  const exclusionsInGrid = exclusions.map((polygon) =>
    polygon.map((point) => rotatePoint2D(point, rotation)),
  );

  const bounds = polygonBounds2D(roofInGrid);
  const startX = bounds.minX + perimeterSetbackM;
  const startY = bounds.minY + perimeterSetbackM;
  const limitX = bounds.maxX - perimeterSetbackM;
  const limitY = bounds.maxY - perimeterSetbackM;

  if (limitX - startX < moduleWidth || limitY - startY < moduleHeight) {
    notes.push(
      `No module fits after a ${perimeterSetbackM.toFixed(2)} m perimeter setback. ` +
        "Reduce the setback, change orientation, or use a smaller module.",
    );
    return empty(orientation, gridRotationDegrees, roofAreaM2, notes);
  }

  const modules: PlacedModule[] = [];
  const columns = Math.floor((limitX - startX + moduleGapM) / stepX);
  const rows = Math.floor((limitY - startY + moduleGapM) / stepY);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = startX + column * stepX;
      const y = startY + row * stepY;

      // Reject as soon as the rectangle leaves the setback-shrunk roof.
      if (
        !rectangleInPolygon(roofInGrid, x, y, moduleWidth, moduleHeight, perimeterSetbackM)
      ) {
        continue;
      }
      if (
        intersectsAnyExclusion(
          exclusionsInGrid,
          x,
          y,
          moduleWidth,
          moduleHeight,
          obstacleClearanceM,
        )
      ) {
        continue;
      }

      const cornersInGrid: [Point2D, Point2D, Point2D, Point2D] = [
        { x, y },
        { x: x + moduleWidth, y },
        { x: x + moduleWidth, y: y + moduleHeight },
        { x, y: y + moduleHeight },
      ];
      modules.push({
        corners: cornersInGrid.map((corner) => rotatePoint2D(corner, gridRotationDegrees)) as [
          Point2D,
          Point2D,
          Point2D,
          Point2D,
        ],
        centre: rotatePoint2D(
          { x: x + moduleWidth / 2, y: y + moduleHeight / 2 },
          gridRotationDegrees,
        ),
        orientation,
        row,
        column,
      });
    }
  }

  const singleModuleAreaM2 = module.lengthM * module.widthM;
  const moduleAreaM2 = modules.length * singleModuleAreaM2;
  const exclusionArea = exclusions.reduce((total, polygon) => total + polygonArea2D(polygon), 0);

  if (modules.length === 0) {
    notes.push(
      "No module position satisfied the setbacks and exclusions. Try the other orientation " +
        "or rotate the grid to align with the roof edges.",
    );
  }

  return {
    modules,
    moduleCount: modules.length,
    capacityKwDc: (modules.length * module.ratedPowerW) / 1000,
    coverage: moduleAreaM2 / roofAreaM2,
    roofAreaM2,
    usableAreaM2: Math.max(0, roofAreaM2 - exclusionArea),
    moduleAreaM2,
    orientation,
    gridRotationDegrees,
    method:
      "Grid packing in the roof plane: every module corner must lie inside the setback-shrunk " +
      "roof outline and clear of all exclusion zones.",
    notes,
  };
}

function intersectsAnyExclusion(
  exclusions: Polygon2D[],
  x: number,
  y: number,
  width: number,
  height: number,
  clearance: number,
): boolean {
  const minX = x - clearance;
  const minY = y - clearance;
  const maxX = x + width + clearance;
  const maxY = y + height + clearance;

  for (const exclusion of exclusions) {
    const bounds = polygonBounds2D(exclusion);
    // Cheap bounding-box rejection first.
    if (bounds.maxX < minX || bounds.minX > maxX || bounds.maxY < minY || bounds.minY > maxY) {
      continue;
    }
    // Any exclusion vertex inside the padded module rectangle is a conflict.
    for (const vertex of exclusion) {
      if (vertex.x >= minX && vertex.x <= maxX && vertex.y >= minY && vertex.y <= maxY) {
        return true;
      }
    }
    // Or any padded module corner inside the exclusion.
    const corners: Point2D[] = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
    if (corners.some((corner) => pointInPolygon2D(exclusion, corner))) {
      return true;
    }
  }
  return false;
}

function empty(
  orientation: ModuleOrientation,
  gridRotationDegrees: number,
  roofAreaM2: number,
  notes: string[],
): RooftopPackingResult {
  return {
    modules: [],
    moduleCount: 0,
    capacityKwDc: 0,
    coverage: 0,
    roofAreaM2,
    usableAreaM2: roofAreaM2,
    moduleAreaM2: 0,
    orientation,
    gridRotationDegrees,
    method: "no modules placed",
    notes,
  };
}

/**
 * Tries both orientations and a set of grid rotations, returning the best result
 * and the alternatives.
 *
 * The alternatives matter as much as the winner: showing that portrait yields 24
 * modules and landscape 22 lets a designer choose landscape for a reason the tool
 * cannot know, such as an existing rail layout.
 */
export function searchRooftopLayout(
  input: Omit<RooftopPackingInput, "orientation" | "gridRotationDegrees">,
  options: { rotations?: number[] } = {},
): { best: RooftopPackingResult; alternatives: RooftopPackingResult[] } {
  // Roof edges are usually the right alignment, so candidate rotations default to
  // the bearings of the outline's own edges plus the cardinal grid.
  const rotations = options.rotations ?? defaultRotations(input.roof);
  const results: RooftopPackingResult[] = [];

  for (const orientation of ["portrait", "landscape"] as const) {
    for (const rotation of rotations) {
      results.push(packRooftop({ ...input, orientation, gridRotationDegrees: rotation }));
    }
  }

  results.sort((a, b) => b.capacityKwDc - a.capacityKwDc || b.coverage - a.coverage);
  const [best, ...rest] = results;
  return {
    best: best ?? empty("portrait", 0, polygonArea2D(input.roof), ["No layout was evaluated."]),
    // Keep one representative per orientation/rotation pair, best first.
    alternatives: rest.slice(0, 5),
  };
}

/** Edge bearings of the polygon, deduplicated modulo 90 degrees. */
function defaultRotations(roof: Polygon2D): number[] {
  const angles = new Set<number>([0]);
  for (let i = 0; i < roof.length; i += 1) {
    const a = roof[i] as Point2D;
    const b = roof[(i + 1) % roof.length] as Point2D;
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    // Modulo 90: a grid aligned to an edge is the same grid as one aligned to
    // its perpendicular, just with rows and columns swapped.
    const normalised = Math.round(((angle % 90) + 90) % 90);
    angles.add(normalised);
  }
  return [...angles];
}
