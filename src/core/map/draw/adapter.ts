/**
 * Binds the draw state machine to real MapLibre pointer and keyboard events.
 *
 * All the logic lives in `engine.ts`; this file is only translation. It is also
 * where the small courtesies live that make drawing feel right: dragging a vertex
 * must not pan the map, the cursor must show what a click will do, and Escape and
 * Enter must always work.
 */

import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import type { LngLat } from "@/domain/geometry";
import { useMapStore } from "../../store/mapStore";
import { useProjectStore } from "../../store/projectStore";
import { useScreeningStore } from "../../store/screeningStore";
import { useSiteStore } from "../../store/siteStore";
import { renderScreeningLayers } from "../screeningLayers";
import { renderSiteLayers } from "../siteLayers";
import type { DrawConfig } from "./engine";
import { midpointAt, vertexAt } from "./engine";
import { useDrawStore } from "./store";

/** Snap radius in pixels. Generous enough to be usable, tight enough to be predictable. */
const SNAP_PIXELS = 12;

function configFor(excludeSiteId: string | null): DrawConfig {
  const { metresPerPixel } = useMapStore.getState();
  const { sites } = useSiteStore.getState();

  // Vertices of other sites are snap targets, so shared boundaries can be exact.
  const snapTargets: LngLat[] = [];
  for (const site of sites) {
    if (site.id === excludeSiteId || !site.ring) continue;
    snapTargets.push(...site.ring);
  }
  return { snapPixels: SNAP_PIXELS, metresPerPixel, snapTargets };
}

export function installDrawAdapter(map: MapLibreMap): () => void {
  let draggingVertex = false;

  const asLngLat = (event: MapMouseEvent): LngLat => [event.lngLat.lng, event.lngLat.lat];

  const redraw = () => {
    renderSiteLayers(map);
    renderScreeningLayers(map);
  };

  const onClick = (event: MapMouseEvent) => {
    const draw = useDrawStore.getState();
    const tool = useMapStore.getState().tool;
    const point = asLngLat(event);

    // Marking a location wins over a leftover draft polygon (not over editing an
    // existing site boundary from the inspector).
    if (tool === "place-point" && draw.editingSiteId === null) {
      if (draw.state.mode !== "idle") {
        draw.cancel();
      }
      useSiteStore.getState().addPointSite(point);
      useMapStore.getState().setTool("pan");
      redraw();
      return;
    }

    if (draw.state.mode === "idle") {
      // Click an existing site while panning to select it — no need to delete
      // the current selection first.
      if (tool === "pan") {
        const screeningHit = map.queryRenderedFeatures(event.point, {
          layers: ["screening-fill"].filter((id) => map.getLayer(id)),
        });
        const screeningId = screeningHit[0]?.properties?.id;
        if (typeof screeningId === "string") {
          useScreeningStore.getState().select(screeningId);
          redraw();
          return;
        }
        const hit = map.queryRenderedFeatures(event.point, {
          layers: ["sites-fill", "sites-point"].filter((id) => map.getLayer(id)),
        });
        const id = hit[0]?.properties?.id;
        if (typeof id === "string") {
          useSiteStore.getState().selectSite(id);
          redraw();
        }
      }
      return;
    }

    const wasDrawing = draw.state.mode === "drawing";
    draw.click(point, configFor(draw.editingSiteId));
    const after = useDrawStore.getState();
    // Re-clicking the first vertex closes the ring into editing mode. That
    // gesture is "finish" for a new site — commit rather than leave a draft
    // that blocks markers and never appears in the inspector.
    if (
      wasDrawing &&
      after.state.mode === "editing" &&
      after.editingSiteId === null &&
      after.state.shape?.closed
    ) {
      commitShape();
      return;
    }
    redraw();
  };

  const onMouseMove = (event: MapMouseEvent) => {
    const draw = useDrawStore.getState();
    if (draw.state.mode === "idle") return;

    draw.move(asLngLat(event), configFor(draw.editingSiteId));

    // Cursor class on `.map-canvas` owns the look; clear inline styles so CSS wins.
    map.getCanvas().style.cursor = "";

    redraw();
  };

  const onMouseDown = (event: MapMouseEvent) => {
    const draw = useDrawStore.getState();
    if (draw.state.mode !== "editing") return;

    const started = draw.pointerDown(asLngLat(event), configFor(draw.editingSiteId));
    if (started) {
      draggingVertex = true;
      // Without this the map pans out from under the vertex being dragged.
      map.dragPan.disable();
      event.preventDefault();
    }
  };

  const onMouseUp = () => {
    if (!draggingVertex) return;
    draggingVertex = false;
    if (!map.dragPan.isEnabled()) map.dragPan.enable();
    map.getCanvas().style.cursor = "";

    const draw = useDrawStore.getState();
    draw.pointerUp();

    // Live-update the site being edited so its area readout tracks the drag.
    const { editingSiteId, state } = useDrawStore.getState();
    if (editingSiteId && state.shape) {
      useSiteStore.getState().updateSiteRing(editingSiteId, state.shape.vertices);
    }
    redraw();
  };

  const onDoubleClick = (event: MapMouseEvent) => {
    const draw = useDrawStore.getState();
    if (draw.state.mode !== "drawing") return;
    // Suppress MapLibre's double-click zoom while finishing a shape.
    event.preventDefault();
    draw.doubleClick();
    commitShape();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Never hijack keys while the user is typing in a panel.
    const target = event.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

    const draw = useDrawStore.getState();
    if (draw.state.mode === "idle") return;

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        draw.cancel();
        useMapStore.getState().setTool("pan");
        redraw();
        break;
      case "Enter":
        event.preventDefault();
        commitShape();
        break;
      case "Backspace":
      case "Delete":
        event.preventDefault();
        draw.backspace();
        redraw();
        break;
      case "z":
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          if (event.shiftKey) draw.redo();
          else draw.undo();
          redraw();
        }
        break;
      default:
        break;
    }
  };

  /** Closes the shape and turns it into a site or screening area. */
  function commitShape() {
    const draw = useDrawStore.getState();
    const tool = useMapStore.getState().tool;
    const editingSiteId = draw.editingSiteId;
    const asScreening =
      tool === "draw-screening" ||
      (draw.state.shape?.id.startsWith("screening-draft-") ?? false);
    const shape = draw.finish();
    if (!shape) {
      // finish() can fail on a degenerate ring — never leave a stuck draft/edit.
      useDrawStore.getState().cancel();
      useMapStore.getState().setTool("pan");
      redraw();
      return;
    }

    if (editingSiteId) {
      useSiteStore.getState().updateSiteRing(editingSiteId, shape.vertices);
    } else if (asScreening) {
      useScreeningStore.getState().addArea(shape.vertices);
      useProjectStore.getState().markDirty();
    } else {
      useSiteStore.getState().addAreaSite(shape.vertices);
    }
    useDrawStore.getState().cancel();
    useMapStore.getState().setTool("pan");
    redraw();
  }

  /** Starts drawing whenever a polygon tool is selected. */
  const unsubscribeTool = useMapStore.subscribe((state, previous) => {
    if (state.tool === previous.tool) return;
    const draw = useDrawStore.getState();
    const canvas = map.getCanvas();
    if (state.tool === "draw-polygon" || state.tool === "draw-screening") {
      // Always start a fresh draft. An inspector boundary edit (or a stuck
      // previous draft) must not block adding another site or screening area.
      if (draw.state.mode !== "idle" || draw.editingSiteId !== null) {
        draw.cancel();
      }
      const prefix = state.tool === "draw-screening" ? "screening-draft" : "draft";
      draw.begin(`${prefix}-${Date.now()}`);
      // Ensure pan is available after a stuck vertex-drag (project/view switches).
      if (!map.dragPan.isEnabled()) map.dragPan.enable();
      canvas.style.cursor = "";
      redraw();
      return;
    }
    if (state.tool === "place-point") {
      // Leave inspector edits alone; clear stray drafts so marker clicks work.
      if (draw.editingSiteId === null && draw.state.mode !== "idle") {
        draw.cancel();
      }
      if (!map.dragPan.isEnabled()) map.dragPan.enable();
      canvas.style.cursor = "";
      redraw();
      return;
    }
    // Drop in-progress drafts when leaving the polygon tool. Keep editing when
    // the inspector opened an existing site boundary (editingSiteId set).
    if (
      draw.state.mode === "drawing" ||
      (draw.state.mode === "editing" && draw.editingSiteId === null)
    ) {
      draw.cancel();
      redraw();
    }
    if (!map.dragPan.isEnabled()) map.dragPan.enable();
    canvas.style.cursor = "";
  });

  map.on("click", onClick);
  map.on("mousemove", onMouseMove);
  map.on("mousedown", onMouseDown);
  map.on("mouseup", onMouseUp);
  map.on("dblclick", onDoubleClick);
  window.addEventListener("keydown", onKeyDown);

  return () => {
    map.off("click", onClick);
    map.off("mousemove", onMouseMove);
    map.off("mousedown", onMouseDown);
    map.off("mouseup", onMouseUp);
    map.off("dblclick", onDoubleClick);
    window.removeEventListener("keydown", onKeyDown);
    unsubscribeTool();
  };
}

/** Exposed for the vertex inspector panel. */
export function hitTest(point: LngLat, excludeSiteId: string | null) {
  const state = useDrawStore.getState().state;
  const config = configFor(excludeSiteId);
  return { vertex: vertexAt(state, point, config), midpoint: midpointAt(state, point, config) };
}
