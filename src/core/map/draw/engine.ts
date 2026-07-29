/**
 * Polygon drawing state machine.
 *
 * Deliberately free of MapLibre, the DOM and React: it takes geographic
 * coordinates in and returns a new state out. `MapDrawAdapter` binds it to real
 * pointer events. That split is what makes the interaction the project brief
 * calls make-or-break — vertex editing, snapping, undo — fully unit-testable
 * rather than something we hope works.
 *
 * Supported: click to add vertices, live rubber band, close by clicking the first
 * vertex or finishing explicitly, drag vertices, insert a vertex on an edge,
 * delete a vertex, snap to nearby vertices, and undo/redo of every mutation.
 */

import type { LngLat } from "@/domain/geometry";
import {
  geodesicPerimeterM,
  geodesicRingAreaM2,
  haversineDistanceM,
  isSimpleRing,
} from "@/domain/geometry";

export type DrawMode = "idle" | "drawing" | "editing";

export interface DrawShape {
  id: string;
  /** Open ring: the closing vertex is implied, never stored. */
  vertices: LngLat[];
  closed: boolean;
}

export interface DrawState {
  mode: DrawMode;
  shape: DrawShape | null;
  /** Cursor position, for the rubber band segment while drawing. */
  pointer: LngLat | null;
  selectedVertex: number | null;
  hoverVertex: number | null;
  /** Midpoint handle the pointer is over, identified by its leading vertex. */
  hoverMidpoint: number | null;
  /** Vertex being dragged, if any. */
  draggingVertex: number | null;
  /** Vertex the pointer would snap to, for a visible snap indicator. */
  snapTarget: LngLat | null;
}

export interface DrawMeasurements {
  areaM2: number;
  perimeterM: number;
  vertexCount: number;
  /** False when the ring self-intersects, which makes area meaningless. */
  valid: boolean;
  /** Why it is invalid, for the UI to show inline. */
  invalidReason: string | null;
}

export interface DrawConfig {
  /** Pointer distance within which a click snaps to an existing vertex, px. */
  snapPixels: number;
  /** Metres per pixel at the current zoom, for converting the snap radius. */
  metresPerPixel: number;
  /** Other shapes whose vertices are snap candidates. */
  snapTargets?: LngLat[];
}

export function emptyDrawState(): DrawState {
  return {
    mode: "idle",
    shape: null,
    pointer: null,
    selectedVertex: null,
    hoverVertex: null,
    hoverMidpoint: null,
    draggingVertex: null,
    snapTarget: null,
  };
}

/* --- Measurement ---------------------------------------------------------- */

export function measure(shape: DrawShape | null): DrawMeasurements {
  if (!shape || shape.vertices.length === 0) {
    return { areaM2: 0, perimeterM: 0, vertexCount: 0, valid: true, invalidReason: null };
  }

  const vertexCount = shape.vertices.length;

  // A line, not yet an area.
  if (vertexCount < 3) {
    return {
      areaM2: 0,
      perimeterM: openPathLength(shape.vertices),
      vertexCount,
      valid: true,
      invalidReason: null,
    };
  }

  const ring = [...shape.vertices, shape.vertices[0] as LngLat];
  const simple = isSimpleRing(ring);

  return {
    areaM2: simple ? geodesicRingAreaM2(ring) : 0,
    perimeterM: geodesicPerimeterM(ring),
    vertexCount,
    valid: simple,
    invalidReason: simple ? null : "The boundary crosses itself, so it has no defined area.",
  };
}

function openPathLength(vertices: LngLat[]): number {
  let total = 0;
  for (let i = 0; i < vertices.length - 1; i += 1) {
    total += haversineDistanceM(vertices[i] as LngLat, vertices[i + 1] as LngLat);
  }
  return total;
}

/* --- Snapping ------------------------------------------------------------- */

/**
 * Nearest snap candidate within the snap radius, or null.
 *
 * The radius is specified in pixels and converted with the current map scale, so
 * snapping feels the same at every zoom level — a fixed metre radius would be
 * unusably sticky when zoomed out and useless when zoomed in.
 */
export function findSnap(
  point: LngLat,
  candidates: LngLat[],
  config: DrawConfig,
): LngLat | null {
  const radiusM = config.snapPixels * config.metresPerPixel;
  let best: { point: LngLat; distance: number } | null = null;

  for (const candidate of candidates) {
    const distance = haversineDistanceM(point, candidate);
    if (distance <= radiusM && (best === null || distance < best.distance)) {
      best = { point: candidate, distance };
    }
  }
  return best?.point ?? null;
}

function snapCandidates(state: DrawState, config: DrawConfig, excludeIndex?: number): LngLat[] {
  const own = (state.shape?.vertices ?? []).filter((_, index) => index !== excludeIndex);
  return [...own, ...(config.snapTargets ?? [])];
}

/* --- Transitions ---------------------------------------------------------- */

export function startDrawing(id: string): DrawState {
  return { ...emptyDrawState(), mode: "drawing", shape: { id, vertices: [], closed: false } };
}

/**
 * Adds a vertex.
 *
 * Clicking the first vertex closes the ring, which is the convention every GIS
 * tool uses. A click that lands on the previous vertex is ignored rather than
 * creating a zero-length edge.
 */
export function addVertex(state: DrawState, point: LngLat, config: DrawConfig): DrawState {
  if (state.mode !== "drawing" || !state.shape) return state;

  const vertices = state.shape.vertices;
  const radiusM = config.snapPixels * config.metresPerPixel;

  if (vertices.length >= 3) {
    const first = vertices[0] as LngLat;
    if (haversineDistanceM(point, first) <= radiusM) {
      return closeShape(state);
    }
  }

  const last = vertices[vertices.length - 1];
  if (last && haversineDistanceM(point, last) <= radiusM) {
    // Duplicate click on the same spot: nothing to add.
    return state;
  }

  const snapped = findSnap(point, config.snapTargets ?? [], config) ?? point;
  return {
    ...state,
    shape: { ...state.shape, vertices: [...vertices, snapped] },
    snapTarget: null,
  };
}

/** Closes the ring and switches to editing. Needs at least three vertices. */
export function closeShape(state: DrawState): DrawState {
  if (!state.shape || state.shape.vertices.length < 3) return state;
  return {
    ...state,
    mode: "editing",
    shape: { ...state.shape, closed: true },
    pointer: null,
    snapTarget: null,
  };
}

/** Abandons the in-progress shape entirely. */
export function cancelDrawing(): DrawState {
  return emptyDrawState();
}

/** Removes the most recent vertex; cancels the shape if that empties it. */
export function removeLastVertex(state: DrawState): DrawState {
  if (state.mode !== "drawing" || !state.shape) return state;
  const vertices = state.shape.vertices.slice(0, -1);
  if (vertices.length === 0) return cancelDrawing();
  return { ...state, shape: { ...state.shape, vertices } };
}

/** Tracks the pointer, updating the rubber band and the snap indicator. */
export function movePointer(state: DrawState, point: LngLat, config: DrawConfig): DrawState {
  if (state.mode === "idle") return state;

  if (state.draggingVertex !== null && state.shape) {
    const index = state.draggingVertex;
    const snapped = findSnap(point, snapCandidates(state, config, index), config);
    const vertices = [...state.shape.vertices];
    vertices[index] = snapped ?? point;
    return { ...state, shape: { ...state.shape, vertices }, pointer: point, snapTarget: snapped };
  }

  const candidates =
    state.mode === "drawing" ? snapCandidates(state, config) : (config.snapTargets ?? []);
  return { ...state, pointer: point, snapTarget: findSnap(point, candidates, config) };
}

export function beginDragVertex(state: DrawState, index: number): DrawState {
  if (!state.shape || index < 0 || index >= state.shape.vertices.length) return state;
  return { ...state, draggingVertex: index, selectedVertex: index };
}

export function endDragVertex(state: DrawState): DrawState {
  return { ...state, draggingVertex: null, snapTarget: null };
}

/** Moves a vertex directly, e.g. from a keyboard nudge or a numeric entry. */
export function moveVertex(state: DrawState, index: number, point: LngLat): DrawState {
  if (!state.shape || index < 0 || index >= state.shape.vertices.length) return state;
  const vertices = [...state.shape.vertices];
  vertices[index] = point;
  return { ...state, shape: { ...state.shape, vertices } };
}

/**
 * Inserts a vertex on the edge that starts at `afterIndex`.
 *
 * This is how the midpoint handles work: dragging the dot halfway along an edge
 * creates a new corner there. Without it, refining a boundary means deleting and
 * redrawing, which is exactly the clumsiness the brief warns about.
 */
export function insertVertex(state: DrawState, afterIndex: number, point: LngLat): DrawState {
  if (!state.shape) return state;
  const vertices = [...state.shape.vertices];
  if (afterIndex < 0 || afterIndex >= vertices.length) return state;
  vertices.splice(afterIndex + 1, 0, point);
  return { ...state, shape: { ...state.shape, vertices }, selectedVertex: afterIndex + 1 };
}

/** Deletes a vertex, refusing to leave a closed ring with fewer than three. */
export function deleteVertex(state: DrawState, index: number): DrawState {
  if (!state.shape) return state;
  const vertices = state.shape.vertices;
  if (index < 0 || index >= vertices.length) return state;
  if (state.shape.closed && vertices.length <= 3) return state;

  const next = vertices.filter((_, i) => i !== index);
  return {
    ...state,
    shape: { ...state.shape, vertices: next },
    selectedVertex: null,
    hoverVertex: null,
  };
}

/** Midpoints of every edge, used to render the insert handles. */
export function edgeMidpoints(shape: DrawShape | null): Array<{ index: number; point: LngLat }> {
  if (!shape || shape.vertices.length < 2) return [];
  const vertices = shape.vertices;
  const lastIndex = shape.closed ? vertices.length : vertices.length - 1;
  const midpoints: Array<{ index: number; point: LngLat }> = [];

  for (let i = 0; i < lastIndex; i += 1) {
    const a = vertices[i] as LngLat;
    const b = vertices[(i + 1) % vertices.length] as LngLat;
    midpoints.push({ index: i, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  return midpoints;
}

/** Index of the vertex under the pointer, or null. */
export function vertexAt(state: DrawState, point: LngLat, config: DrawConfig): number | null {
  if (!state.shape) return null;
  const radiusM = config.snapPixels * config.metresPerPixel;
  let best: { index: number; distance: number } | null = null;

  state.shape.vertices.forEach((vertex, index) => {
    const distance = haversineDistanceM(point, vertex);
    if (distance <= radiusM && (best === null || distance < best.distance)) {
      best = { index, distance };
    }
  });
  return best === null ? null : (best as { index: number; distance: number }).index;
}

/** Index of the edge whose midpoint handle is under the pointer, or null. */
export function midpointAt(state: DrawState, point: LngLat, config: DrawConfig): number | null {
  const radiusM = config.snapPixels * config.metresPerPixel;
  let best: { index: number; distance: number } | null = null;

  for (const { index, point: midpoint } of edgeMidpoints(state.shape)) {
    const distance = haversineDistanceM(point, midpoint);
    if (distance <= radiusM && (best === null || distance < best.distance)) {
      best = { index, distance };
    }
  }
  return best === null ? null : (best as { index: number; distance: number }).index;
}

/** Loads an existing shape for editing. */
export function editShape(shape: DrawShape): DrawState {
  return { ...emptyDrawState(), mode: "editing", shape };
}

/** GeoJSON polygon for the current shape, or null if it is not yet an area. */
export function toGeoJson(shape: DrawShape | null): GeoJSON.Polygon | null {
  if (!shape || shape.vertices.length < 3) return null;
  const ring = [...shape.vertices, shape.vertices[0] as LngLat];
  return { type: "Polygon", coordinates: [ring] };
}

/* --- History -------------------------------------------------------------- */

/**
 * Undo/redo over shape snapshots.
 *
 * Snapshots rather than inverse operations: a polygon is small, and storing whole
 * states removes a whole class of bug where an inverse operation is subtly wrong.
 * Only committed mutations are recorded, so a drag produces one undo step rather
 * than one per pointer move.
 */
export interface DrawHistory {
  past: Array<DrawShape | null>;
  present: DrawShape | null;
  future: Array<DrawShape | null>;
}

const HISTORY_LIMIT = 100;

export function emptyHistory(): DrawHistory {
  return { past: [], present: null, future: [] };
}

export function commit(history: DrawHistory, shape: DrawShape | null): DrawHistory {
  if (shapesEqual(history.present, shape)) return history;
  const past = [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: cloneShape(shape), future: [] };
}

export function undo(history: DrawHistory): DrawHistory {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, HISTORY_LIMIT),
  };
}

export function redo(history: DrawHistory): DrawHistory {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: history.future.slice(1),
  };
}

export function canUndo(history: DrawHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: DrawHistory): boolean {
  return history.future.length > 0;
}

function cloneShape(shape: DrawShape | null): DrawShape | null {
  return shape === null
    ? null
    : { id: shape.id, closed: shape.closed, vertices: shape.vertices.map(([lon, lat]) => [lon, lat]) };
}

function shapesEqual(a: DrawShape | null, b: DrawShape | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.closed !== b.closed) return false;
  if (a.vertices.length !== b.vertices.length) return false;
  return a.vertices.every((vertex, index) => {
    const other = b.vertices[index] as LngLat;
    return vertex[0] === other[0] && vertex[1] === other[1];
  });
}
