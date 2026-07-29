import { describe, expect, it } from "vitest";
import type { LngLat } from "@/domain/geometry";
import type { DrawConfig, DrawShape } from "./engine";
import {
  addVertex,
  beginDragVertex,
  canRedo,
  canUndo,
  cancelDrawing,
  closeShape,
  commit,
  deleteVertex,
  edgeMidpoints,
  editShape,
  emptyDrawState,
  emptyHistory,
  endDragVertex,
  findSnap,
  insertVertex,
  measure,
  midpointAt,
  movePointer,
  moveVertex,
  redo,
  removeLastVertex,
  startDrawing,
  toGeoJson,
  undo,
  vertexAt,
} from "./engine";

/** Snap radius of 10 px at 1 m/px, so 10 m. Easy to reason about in tests. */
const config: DrawConfig = { snapPixels: 10, metresPerPixel: 1 };

/** ~1000 m apart at this latitude, well outside the snap radius. */
const A: LngLat = [-118.0, 35.0];
const B: LngLat = [-118.0, 35.009];
const C: LngLat = [-117.99, 35.009];
const D: LngLat = [-117.99, 35.0];

function drawSquare(): ReturnType<typeof startDrawing> {
  let state = startDrawing("site-1");
  for (const point of [A, B, C, D]) {
    state = addVertex(state, point, config);
  }
  return closeShape(state);
}

describe("drawing lifecycle", () => {
  it("starts idle with nothing drawn", () => {
    const state = emptyDrawState();
    expect(state.mode).toBe("idle");
    expect(state.shape).toBeNull();
  });

  it("collects vertices while drawing", () => {
    let state = startDrawing("site-1");
    expect(state.mode).toBe("drawing");
    state = addVertex(state, A, config);
    state = addVertex(state, B, config);
    expect(state.shape?.vertices).toHaveLength(2);
    expect(state.shape?.closed).toBe(false);
  });

  it("ignores a repeated click in the same place", () => {
    let state = startDrawing("site-1");
    state = addVertex(state, A, config);
    // A click 2 m away is inside the 10 m snap radius: a double click, not a vertex.
    state = addVertex(state, [A[0], A[1] + 0.00002], config);
    expect(state.shape?.vertices).toHaveLength(1);
  });

  it("closes the ring when the first vertex is clicked again", () => {
    let state = startDrawing("site-1");
    for (const point of [A, B, C]) state = addVertex(state, point, config);
    state = addVertex(state, A, config);
    expect(state.shape?.closed).toBe(true);
    expect(state.mode).toBe("editing");
    // Closing must not store a duplicate of the first vertex.
    expect(state.shape?.vertices).toHaveLength(3);
  });

  it("refuses to close a shape with fewer than three vertices", () => {
    let state = startDrawing("site-1");
    state = addVertex(state, A, config);
    state = addVertex(state, B, config);
    const attempted = closeShape(state);
    expect(attempted.shape?.closed).toBe(false);
    expect(attempted.mode).toBe("drawing");
  });

  it("removes the last vertex on undo-while-drawing", () => {
    let state = startDrawing("site-1");
    for (const point of [A, B, C]) state = addVertex(state, point, config);
    state = removeLastVertex(state);
    expect(state.shape?.vertices).toHaveLength(2);
  });

  it("cancels the shape when the last vertex is removed", () => {
    let state = startDrawing("site-1");
    state = addVertex(state, A, config);
    state = removeLastVertex(state);
    expect(state.mode).toBe("idle");
    expect(state.shape).toBeNull();
  });

  it("cancels outright on escape", () => {
    const state = cancelDrawing();
    expect(state.mode).toBe("idle");
    expect(state.shape).toBeNull();
  });

  it("ignores vertex additions when not drawing", () => {
    const state = emptyDrawState();
    expect(addVertex(state, A, config)).toBe(state);
  });
});

describe("measurement", () => {
  it("reports nothing for an empty shape", () => {
    const result = measure(null);
    expect(result.areaM2).toBe(0);
    expect(result.vertexCount).toBe(0);
    expect(result.valid).toBe(true);
  });

  it("measures length but no area for two vertices", () => {
    let state = startDrawing("s");
    state = addVertex(state, A, config);
    state = addVertex(state, B, config);
    const result = measure(state.shape);
    expect(result.areaM2).toBe(0);
    expect(result.perimeterM).toBeGreaterThan(900);
    expect(result.perimeterM).toBeLessThan(1100);
  });

  it("measures a square's area and perimeter", () => {
    const state = drawSquare();
    const result = measure(state.shape);
    // Roughly 1000 m x 900 m at this latitude.
    expect(result.areaM2).toBeGreaterThan(700_000);
    expect(result.areaM2).toBeLessThan(1_100_000);
    expect(result.perimeterM).toBeGreaterThan(3400);
    expect(result.vertexCount).toBe(4);
    expect(result.valid).toBe(true);
  });

  it("refuses to report an area for a self-intersecting ring", () => {
    // A bow-tie: swap two vertices so the edges cross.
    const shape: DrawShape = { id: "s", vertices: [A, C, B, D], closed: true };
    const result = measure(shape);
    expect(result.valid).toBe(false);
    expect(result.areaM2).toBe(0);
    expect(result.invalidReason).toContain("crosses itself");
  });
});

describe("snapping", () => {
  it("snaps to the nearest candidate inside the radius", () => {
    const near: LngLat = [A[0] + 0.00005, A[1]]; // ~4.5 m away
    expect(findSnap(near, [A, B], config)).toEqual(A);
  });

  it("ignores candidates outside the radius", () => {
    const far: LngLat = [A[0] + 0.001, A[1]]; // ~90 m away
    expect(findSnap(far, [A], config)).toBeNull();
  });

  it("scales the radius with the map scale", () => {
    const point: LngLat = [A[0] + 0.0005, A[1]]; // ~45 m away
    // At 1 m/px a 10 px radius is 10 m: no snap.
    expect(findSnap(point, [A], config)).toBeNull();
    // Zoomed out to 20 m/px the same 10 px is 200 m: it snaps.
    expect(findSnap(point, [A], { ...config, metresPerPixel: 20 })).toEqual(A);
  });

  it("snaps a new vertex to another shape's vertex", () => {
    const neighbour: LngLat = [-117.98, 35.02];
    const nearNeighbour: LngLat = [neighbour[0] + 0.00003, neighbour[1]];
    let state = startDrawing("s");
    state = addVertex(state, nearNeighbour, { ...config, snapTargets: [neighbour] });
    // Shared boundaries must be exactly shared, not nearly.
    expect(state.shape?.vertices[0]).toEqual(neighbour);
  });

  it("exposes the snap target while moving the pointer", () => {
    let state = startDrawing("s");
    state = addVertex(state, A, config);
    state = movePointer(state, [A[0] + 0.00005, A[1]], config);
    expect(state.snapTarget).toEqual(A);
    state = movePointer(state, [A[0] + 0.01, A[1]], config);
    expect(state.snapTarget).toBeNull();
  });
});

describe("vertex editing", () => {
  it("moves a vertex", () => {
    const state = drawSquare();
    const moved: LngLat = [-117.995, 35.005];
    const next = moveVertex(state, 2, moved);
    expect(next.shape?.vertices[2]).toEqual(moved);
    expect(next.shape?.vertices).toHaveLength(4);
  });

  it("drags a vertex and snaps it to a neighbour's corner", () => {
    const neighbour: LngLat = [-117.9895, 35.0092];
    let state = drawSquare();
    state = beginDragVertex(state, 2);
    expect(state.draggingVertex).toBe(2);
    state = movePointer(state, [neighbour[0] + 0.00002, neighbour[1]], {
      ...config,
      snapTargets: [neighbour],
    });
    expect(state.shape?.vertices[2]).toEqual(neighbour);
    state = endDragVertex(state);
    expect(state.draggingVertex).toBeNull();
    expect(state.snapTarget).toBeNull();
  });

  it("does not let a dragged vertex snap to itself", () => {
    let state = drawSquare();
    state = beginDragVertex(state, 0);
    // Move barely at all: without the self-exclusion this would snap to its own
    // old position and the vertex could never be nudged.
    const nudged: LngLat = [A[0] + 0.00002, A[1]];
    state = movePointer(state, nudged, config);
    expect(state.shape?.vertices[0]).toEqual(nudged);
  });

  it("inserts a vertex on an edge", () => {
    const state = drawSquare();
    const midpoints = edgeMidpoints(state.shape);
    expect(midpoints).toHaveLength(4);

    const first = midpoints[0]!;
    const next = insertVertex(state, first.index, first.point);
    expect(next.shape?.vertices).toHaveLength(5);
    expect(next.shape?.vertices[1]).toEqual(first.point);
    expect(next.selectedVertex).toBe(1);
  });

  it("keeps the area unchanged when inserting a vertex on an edge", () => {
    const state = drawSquare();
    const before = measure(state.shape).areaM2;
    const midpoint = edgeMidpoints(state.shape)[1]!;
    const after = measure(insertVertex(state, midpoint.index, midpoint.point).shape).areaM2;
    // A collinear vertex adds a corner but no area.
    expect(after).toBeCloseTo(before, 0);
  });

  it("gives an open path one fewer midpoint than a closed ring", () => {
    let open = startDrawing("s");
    for (const point of [A, B, C]) open = addVertex(open, point, config);
    expect(edgeMidpoints(open.shape)).toHaveLength(2);
    expect(edgeMidpoints(closeShape(open).shape)).toHaveLength(3);
  });

  it("deletes a vertex", () => {
    const state = drawSquare();
    const next = deleteVertex(state, 1);
    expect(next.shape?.vertices).toHaveLength(3);
    expect(next.shape?.vertices).not.toContainEqual(B);
  });

  it("refuses to delete below three vertices in a closed ring", () => {
    let state = startDrawing("s");
    for (const point of [A, B, C]) state = addVertex(state, point, config);
    state = closeShape(state);
    // Deleting here would leave a line, not a polygon.
    expect(deleteVertex(state, 0).shape?.vertices).toHaveLength(3);
  });

  it("ignores edits to out-of-range indices", () => {
    const state = drawSquare();
    expect(moveVertex(state, 9, A)).toBe(state);
    expect(deleteVertex(state, -1)).toBe(state);
    expect(insertVertex(state, 9, A)).toBe(state);
    expect(beginDragVertex(state, 9)).toBe(state);
  });
});

describe("hit testing", () => {
  it("finds the vertex under the pointer", () => {
    const state = drawSquare();
    expect(vertexAt(state, [A[0] + 0.00005, A[1]], config)).toBe(0);
    expect(vertexAt(state, [C[0] + 0.00005, C[1]], config)).toBe(2);
    expect(vertexAt(state, [-117.5, 35.5], config)).toBeNull();
  });

  it("finds the closest vertex when two are in range", () => {
    const state = drawSquare();
    // Nearer to A than to D, though both are within a generous radius.
    const point: LngLat = [A[0] + 0.0002, A[1]];
    expect(vertexAt(state, point, { ...config, metresPerPixel: 200 })).toBe(0);
  });

  it("finds the midpoint handle under the pointer", () => {
    const state = drawSquare();
    const midpoint = edgeMidpoints(state.shape)[0]!;
    expect(midpointAt(state, midpoint.point, config)).toBe(0);
    expect(midpointAt(state, [-117.5, 35.5], config)).toBeNull();
  });
});

describe("GeoJSON output", () => {
  it("emits a closed ring", () => {
    const geojson = toGeoJson(drawSquare().shape);
    expect(geojson?.type).toBe("Polygon");
    const ring = geojson?.coordinates[0] as LngLat[];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
  });

  it("emits nothing for fewer than three vertices", () => {
    let state = startDrawing("s");
    state = addVertex(state, A, config);
    expect(toGeoJson(state.shape)).toBeNull();
  });
});

describe("undo and redo", () => {
  it("starts with nothing to undo", () => {
    const history = emptyHistory();
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });

  it("steps back and forward through committed shapes", () => {
    let history = emptyHistory();
    const one: DrawShape = { id: "s", vertices: [A], closed: false };
    const two: DrawShape = { id: "s", vertices: [A, B], closed: false };
    const three: DrawShape = { id: "s", vertices: [A, B, C], closed: false };

    history = commit(history, one);
    history = commit(history, two);
    history = commit(history, three);
    expect(history.present?.vertices).toHaveLength(3);

    history = undo(history);
    expect(history.present?.vertices).toHaveLength(2);
    history = undo(history);
    expect(history.present?.vertices).toHaveLength(1);

    history = redo(history);
    expect(history.present?.vertices).toHaveLength(2);
    expect(canRedo(history)).toBe(true);
  });

  it("does not record a commit that changes nothing", () => {
    let history = emptyHistory();
    const shape: DrawShape = { id: "s", vertices: [A, B], closed: false };
    history = commit(history, shape);
    const depth = history.past.length;
    // Same coordinates in a different object must not create an undo step.
    history = commit(history, { id: "s", vertices: [[...A] as LngLat, [...B] as LngLat], closed: false });
    expect(history.past.length).toBe(depth);
  });

  it("clears the redo stack once a new change is made", () => {
    let history = emptyHistory();
    history = commit(history, { id: "s", vertices: [A], closed: false });
    history = commit(history, { id: "s", vertices: [A, B], closed: false });
    history = undo(history);
    expect(canRedo(history)).toBe(true);

    history = commit(history, { id: "s", vertices: [A, C], closed: false });
    expect(canRedo(history)).toBe(false);
  });

  it("snapshots defensively so later mutation cannot corrupt history", () => {
    let history = emptyHistory();
    const shape: DrawShape = { id: "s", vertices: [[...A] as LngLat], closed: false };
    history = commit(history, shape);
    // Mutating the caller's array must not reach into the stored snapshot.
    shape.vertices.push(B);
    expect(history.present?.vertices).toHaveLength(1);
  });

  it("does nothing when there is nothing to undo or redo", () => {
    const history = emptyHistory();
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });
});

describe("editing an existing shape", () => {
  it("loads a saved shape straight into editing mode", () => {
    const shape: DrawShape = { id: "saved", vertices: [A, B, C, D], closed: true };
    const state = editShape(shape);
    expect(state.mode).toBe("editing");
    expect(state.shape).toBe(shape);
    expect(measure(state.shape).areaM2).toBeGreaterThan(0);
  });
});
