/**
 * Store-level coverage for the click-to-close → commit path the map adapter uses.
 * The adapter itself needs MapLibre; this verifies the state machine contract it relies on.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { LngLat } from "@/domain/geometry";
import { useSiteStore } from "../../store/siteStore";
import type { DrawConfig } from "./engine";
import { useDrawStore } from "./store";

const config: DrawConfig = { snapPixels: 10, metresPerPixel: 1 };

const A: LngLat = [-118.0, 35.0];
const B: LngLat = [-118.0, 35.009];
const C: LngLat = [-117.99, 35.009];

describe("draw store click-to-close commit contract", () => {
  beforeEach(() => {
    useDrawStore.getState().cancel();
    useSiteStore.getState().clear();
  });

  it("closes on re-click of first vertex and finish() yields a site-ready shape", () => {
    const draw = useDrawStore.getState();
    draw.begin("draft-1");
    draw.click(A, config);
    draw.click(B, config);
    draw.click(C, config);

    expect(useDrawStore.getState().state.mode).toBe("drawing");

    // Same gesture the UI advertises as finish.
    draw.click(A, config);
    const closed = useDrawStore.getState();
    expect(closed.state.mode).toBe("editing");
    expect(closed.editingSiteId).toBeNull();
    expect(closed.state.shape?.closed).toBe(true);

    const shape = useDrawStore.getState().finish();
    expect(shape).not.toBeNull();
    if (!shape) return;
    expect(shape.vertices).toHaveLength(3);

    useSiteStore.getState().addAreaSite(shape.vertices);
    useDrawStore.getState().cancel();

    const sites = useSiteStore.getState().sites;
    expect(sites).toHaveLength(1);
    expect(sites[0]?.kind).toBe("area");
    expect(sites[0]?.ring).toHaveLength(3);
    expect(useDrawStore.getState().state.mode).toBe("idle");
  });
});
