/**
 * Status bar: coordinates, camera, basemap attribution, engine health.
 *
 * The engine indicator lives here rather than in a dialog because the whole
 * point of graceful degradation is that the user can see, at a glance and at all
 * times, which fidelity of result they are currently getting.
 */

import { useEffect, useState } from "react";
import { platform } from "@/core/platform";
import type { EngineStatus } from "@/core/platform";
import { basemapById } from "@/core/map/basemaps";
import { useMapStore } from "@/core/store/mapStore";
import { useProjectStore } from "@/core/store/projectStore";
import { useUiStore } from "@/core/store/uiStore";
import { Spinner } from "@/design-system/controls";
import { formatCoordinates } from "@/domain/units";

export function StatusBar() {
  const cursor = useMapStore((state) => state.cursor);
  const viewport = useMapStore((state) => state.viewport);
  const basemap = useMapStore((state) => state.basemap);
  const dirty = useProjectStore((state) => state.dirty);
  const busy = useUiStore((state) => state.busy);
  const setView = useUiStore((state) => state.setView);

  const [engine, setEngine] = useState<EngineStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    platform()
      .engine.status()
      .then((status) => {
        if (!cancelled) setEngine(status);
      })
      .catch(() => setEngine(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const busyEntries = Object.entries(busy);
  const definition = basemapById(basemap);

  return (
    <footer className="statusbar">
      <span className="statusbar__item mono">
        {cursor
          ? formatCoordinates(cursor.latitude, cursor.longitude)
          : formatCoordinates(viewport.latitude, viewport.longitude)}
      </span>
      <span className="statusbar__item mono">Zoom {viewport.zoom.toFixed(1)}</span>
      {definition.attribution && (
        <span
          className="statusbar__item"
          // Provider attribution is a licence condition, not decoration.
          dangerouslySetInnerHTML={{ __html: definition.attribution }}
        />
      )}

      <div className="statusbar__spacer" />

      {busyEntries.length > 0 && (
        <span className="statusbar__item">
          <Spinner label="Working" />
          {busyEntries[0]?.[1].label}
          {busyEntries.length > 1 && ` (+${busyEntries.length - 1})`}
        </span>
      )}

      <span className="statusbar__item">{dirty ? "Unsaved changes" : "Saved"}</span>

      <button
        type="button"
        className="statusbar__button statusbar__item"
        onClick={() => setView("settings")}
        title={engineTitle(engine)}
      >
        <span className={`statusbar__dot statusbar__dot--${engineTone(engine)}`} />
        {engineLabel(engine)}
      </button>
    </footer>
  );
}

function engineTone(engine: EngineStatus | null): "ok" | "warn" | "error" | "idle" {
  if (!engine) return "idle";
  switch (engine.state) {
    case "ready":
      return "ok";
    case "starting":
      return "warn";
    case "unavailable":
      return "error";
    default:
      return "idle";
  }
}

function engineLabel(engine: EngineStatus | null): string {
  if (!engine) return "Solar engine: unknown";
  switch (engine.state) {
    case "ready":
      return engine.pvlibVersion ? `pvlib ${engine.pvlibVersion}` : "Solar engine ready";
    case "starting":
      return "Solar engine starting";
    case "unavailable":
      return "Solar engine unavailable";
    default:
      return "Solar engine stopped";
  }
}

function engineTitle(engine: EngineStatus | null): string {
  if (!engine) return "The solar engine status is unknown.";
  if (engine.state === "ready") {
    return `pvlib-backed modelling is available at ${engine.baseUrl}.`;
  }
  return (
    (engine.detail ?? "The solar engine is not running.") +
    " Results will fall back to labelled first-order estimates."
  );
}
