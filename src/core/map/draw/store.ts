/**
 * Zustand wrapper around the draw state machine.
 *
 * The engine holds the logic; this holds the current value and the undo history,
 * and it is the only thing the adapter and the UI talk to. Undo is committed at
 * gesture boundaries — one step per vertex added or drag finished — because an
 * undo per pointer move would be useless.
 */

import { create } from "zustand";
import type { LngLat } from "@/domain/geometry";
import type { DrawConfig, DrawHistory, DrawMeasurements, DrawShape, DrawState } from "./engine";
import {
  addVertex,
  beginDragVertex,
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  cancelDrawing,
  closeShape,
  commit,
  deleteVertex,
  editShape,
  emptyDrawState,
  emptyHistory,
  endDragVertex,
  insertVertex,
  measure,
  midpointAt,
  movePointer,
  redo as historyRedo,
  removeLastVertex,
  startDrawing,
  undo as historyUndo,
  vertexAt,
} from "./engine";

interface DrawStoreState {
  state: DrawState;
  history: DrawHistory;
  /** Site the shape belongs to when editing an existing boundary. */
  editingSiteId: string | null;

  begin: (id: string) => void;
  beginEdit: (siteId: string, shape: DrawShape) => void;
  finish: () => DrawShape | null;
  cancel: () => void;

  click: (point: LngLat, config: DrawConfig) => void;
  move: (point: LngLat, config: DrawConfig) => void;
  pointerDown: (point: LngLat, config: DrawConfig) => boolean;
  pointerUp: () => void;
  doubleClick: () => void;
  removeSelectedVertex: () => void;
  backspace: () => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  measurements: () => DrawMeasurements;
}

export const useDrawStore = create<DrawStoreState>((set, get) => ({
  state: emptyDrawState(),
  history: emptyHistory(),
  editingSiteId: null,

  begin: (id) =>
    set({ state: startDrawing(id), history: emptyHistory(), editingSiteId: null }),

  beginEdit: (siteId, shape) =>
    set({ state: editShape(shape), history: commit(emptyHistory(), shape), editingSiteId: siteId }),

  finish: () => {
    const closed = closeShape(get().state);
    const shape = closed.shape;
    set({ state: closed, history: commit(get().history, shape) });
    return shape && shape.closed ? shape : null;
  },

  cancel: () => set({ state: cancelDrawing(), history: emptyHistory(), editingSiteId: null }),

  click: (point, config) => {
    const current = get().state;
    if (current.mode === "drawing") {
      const next = addVertex(current, point, config);
      set({ state: next, history: commit(get().history, next.shape) });
      return;
    }
    if (current.mode === "editing") {
      // In editing mode a click selects a vertex, or inserts one on a midpoint.
      const vertex = vertexAt(current, point, config);
      if (vertex !== null) {
        set({ state: { ...current, selectedVertex: vertex } });
        return;
      }
      const midpoint = midpointAt(current, point, config);
      if (midpoint !== null) {
        const next = insertVertex(current, midpoint, point);
        set({ state: next, history: commit(get().history, next.shape) });
      }
    }
  },

  move: (point, config) => {
    const current = get().state;
    if (current.mode === "idle") return;

    let next = movePointer(current, point, config);
    // Hover feedback only matters when not mid-drag.
    if (current.draggingVertex === null) {
      next = {
        ...next,
        hoverVertex: vertexAt(next, point, config),
        hoverMidpoint: midpointAt(next, point, config),
      };
    }
    set({ state: next });
  },

  /** Returns true when a drag started, so the adapter can lock map panning. */
  pointerDown: (point, config) => {
    const current = get().state;
    if (current.mode !== "editing") return false;
    const vertex = vertexAt(current, point, config);
    if (vertex === null) return false;
    set({ state: beginDragVertex(current, vertex) });
    return true;
  },

  pointerUp: () => {
    const current = get().state;
    if (current.draggingVertex === null) return;
    const next = endDragVertex(current);
    // One undo step for the whole drag, recorded when the pointer is released.
    set({ state: next, history: commit(get().history, next.shape) });
  },

  doubleClick: () => {
    const current = get().state;
    if (current.mode !== "drawing") return;
    const next = closeShape(current);
    set({ state: next, history: commit(get().history, next.shape) });
  },

  removeSelectedVertex: () => {
    const current = get().state;
    if (current.selectedVertex === null) return;
    const next = deleteVertex(current, current.selectedVertex);
    set({ state: next, history: commit(get().history, next.shape) });
  },

  backspace: () => {
    const current = get().state;
    if (current.mode === "drawing") {
      const next = removeLastVertex(current);
      set({ state: next, history: commit(get().history, next.shape) });
      return;
    }
    get().removeSelectedVertex();
  },

  undo: () => {
    const history = historyUndo(get().history);
    set({
      history,
      state: { ...get().state, shape: history.present, selectedVertex: null, hoverVertex: null },
    });
  },

  redo: () => {
    const history = historyRedo(get().history);
    set({
      history,
      state: { ...get().state, shape: history.present, selectedVertex: null, hoverVertex: null },
    });
  },

  canUndo: () => historyCanUndo(get().history),
  canRedo: () => historyCanRedo(get().history),

  measurements: () => measure(get().state.shape),
}));
