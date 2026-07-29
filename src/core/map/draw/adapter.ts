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
import { useSiteStore } from "../../store/siteStore";
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

  const redraw = () => renderSiteLayers(map);

  const onClick = (event: MapMouseEvent) => {
    const draw = useDrawStore.getState();
    const tool = useMapStore.getState().tool;

    if (draw.state.mode === "idle") {
      if (tool === "place-point") {
        const point = asLngLat(event);
        useSiteStore.getState().addPointSite(point);
        useMapStore.getState().setTool("pan");
        redraw();
      }
      return;
    }
    draw.click(asLngLat(event), configFor(draw.editingSiteId));
    redraw();
  };

  const onMouseMove = (event: MapMouseEvent) => {
    const draw = useDrawStore.getState();
    if (draw.state.mode === "idle") return;

    draw.move(asLngLat(event), configFor(draw.editingSiteId));

    // Cursor tells the user what a click will do before they commit to it.
    const state = useDrawStore.getState().state;
    const canvas = map.getCanvas();
    if (draggingVertex) canvas.style.cursor = "grabbing";
    else if (state.hoverVertex !== null) canvas.style.cursor = "grab";
    else if (state.hoverMidpoint !== null) canvas.style.cursor = "copy";
    else if (state.mode === "drawing") canvas.style.cursor = "crosshair";
    else canvas.style.cursor = "";

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
    map.dragPan.enable();
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

  /** Closes the shape and turns it into a site, or updates the one being edited. */
  function commitShape() {
    const draw = useDrawStore.getState();
    const shape = draw.finish();
    if (!shape) return;

    const { editingSiteId } = useDrawStore.getState();
    if (editingSiteId) {
      useSiteStore.getState().updateSiteRing(editingSiteId, shape.vertices);
    } else {
      useSiteStore.getState().addAreaSite(shape.vertices);
    }
    useDrawStore.getState().cancel();
    useMapStore.getState().setTool("pan");
    redraw();
  }

  /** Starts drawing whenever the polygon tool is selected. */
  const unsubscribeTool = useMapStore.subscribe((state, previous) => {
    if (state.tool === previous.tool) return;
    const draw = useDrawStore.getState();
    if (state.tool === "draw-polygon" && draw.state.mode === "idle") {
      draw.begin(`draft-${Date.now()}`);
      map.getCanvas().style.cursor = "crosshair";
      redraw();
    } else if (state.tool !== "draw-polygon" && draw.state.mode === "drawing") {
      draw.cancel();
      map.getCanvas().style.cursor = "";
      redraw();
    }
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
