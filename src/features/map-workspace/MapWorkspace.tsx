/**
 * The default view: map, layer panel, site inspector and the map furniture.
 *
 * Layout follows the prototype exactly — subbar with breadcrumb, search and KPIs;
 * left layer panel; canvas with floating controls; right inspector; status bar
 * supplied by the shell.
 */

import { useMemo } from "react";
import { MapView } from "@/core/map/MapView";
import { availableBasemaps, scaleBarFor } from "@/core/map/basemaps";
import { measure } from "@/core/map/draw/engine";
import { useDrawStore } from "@/core/map/draw/store";
import { useLayerStore } from "@/core/store/layerStore";
import { useMapStore } from "@/core/store/mapStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { IconButton, Select } from "@/design-system/controls";
import {
  CrosshairIcon,
  MinusIcon,
  PinIcon,
  PlusIcon,
  PolygonIcon,
  RedoIcon,
  TerrainIcon,
  UndoIcon,
} from "@/design-system/icons";
import { Stat, StatCluster } from "@/design-system/data";
import { LayerPanel } from "../layers/LayerPanel";
import { SiteInspector } from "../site-inspector/SiteInspector";
import { LocationSearch } from "./LocationSearch";
import { RightPanelReopen, SidePanel } from "@/shell/SidePanel";
import { scaleArea, scaleEnergy } from "@/domain/units";

export function MapWorkspace() {
  const leftCollapsed = useUiStore((state) => state.leftPanelCollapsed);
  const rightCollapsed = useUiStore((state) => state.rightPanelCollapsed);
  const toggleLeft = useUiStore((state) => state.toggleLeftPanel);
  const toggleRight = useUiStore((state) => state.toggleRightPanel);
  const setRightCollapsed = useUiStore((state) => state.setRightPanelCollapsed);

  const sites = useSiteStore((state) => state.sites);
  const selectedSiteId = useSiteStore((state) => state.selectedSiteId);
  const selected = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) ?? null,
    [sites, selectedSiteId],
  );

  const visibleLayerCount = useLayerStore(
    (state) => Object.values(state.runtime).filter((entry) => entry.visible).length,
  );

  // Project-level totals for the subbar: the two numbers a planner tracks.
  const totals = useMemo(() => {
    const areaM2 = sites.reduce((sum, site) => sum + site.areaM2, 0);
    const annualKwh = sites.reduce((sum, site) => {
      const yieldPerKwp = site.resource?.ghiKwhM2Year;
      // Only count sites that have both a resource figure and a design.
      if (!yieldPerKwp || !site.design) return sum;
      return sum + yieldPerKwp * site.areaM2 * 0;
    }, 0);
    return { areaM2, annualKwh };
  }, [sites]);

  return (
    <>
      <MapSubBar totalAreaM2={totals.areaM2} totalAnnualKwh={totals.annualKwh} siteName={selected?.name} />

      <div className="workspace">
        <SidePanel
          side="left"
          title="Data layers"
          collapsed={leftCollapsed}
          onToggle={toggleLeft}
          headerAction={
            visibleLayerCount > 0 ? (
              <span className="panel__title">{visibleLayerCount} on</span>
            ) : undefined
          }
        >
          <LayerPanel collapsed={leftCollapsed} />
        </SidePanel>

        <main className="canvas">
          <MapView />
          <MapToolbelt />
          <DrawReadout />
          <MapControls />
          <ScaleBar />
          {rightCollapsed && <RightPanelReopen onClick={() => setRightCollapsed(false)} />}
        </main>

        <SidePanel
          side="right"
          title={selected ? "Site" : "Inspector"}
          collapsed={rightCollapsed}
          onToggle={toggleRight}
        >
          <SiteInspector />
        </SidePanel>
      </div>
    </>
  );
}

/* --- Subbar --------------------------------------------------------------- */

function MapSubBar({
  totalAreaM2,
  totalAnnualKwh,
  siteName,
}: {
  totalAreaM2: number;
  totalAnnualKwh: number;
  siteName?: string;
}) {
  const area = scaleArea(totalAreaM2);
  const energy = scaleEnergy(totalAnnualKwh);
  const siteCount = useSiteStore((state) => state.sites.length);

  return (
    <div className="subbar">
      <div className="breadcrumb">
        <span>Project</span>
        <span className="breadcrumb__sep">/</span>
        <span className="breadcrumb__current">{siteName ?? `${siteCount} sites`}</span>
      </div>
      <LocationSearch />
      <div className="subbar__spacer" />
      <StatCluster>
        <Stat label="Total area" value={area.value} unit={area.unit} />
        {totalAnnualKwh > 0 && (
          <Stat label="Est. annual output" value={energy.value} unit={energy.unit} tone="accent" />
        )}
      </StatCluster>
    </div>
  );
}

/* --- Map furniture -------------------------------------------------------- */

function MapToolbelt() {
  const tool = useMapStore((state) => state.tool);
  const setTool = useMapStore((state) => state.setTool);
  const basemap = useMapStore((state) => state.basemap);
  const setBasemap = useMapStore((state) => state.setBasemap);
  const terrain3d = useMapStore((state) => state.terrain3d);
  const setTerrain3d = useMapStore((state) => state.setTerrain3d);
  const configuredKeys = useSettingsStore((state) => state.configuredKeys);

  const pastLength = useDrawStore((state) => state.history.past.length);
  const futureLength = useDrawStore((state) => state.history.future.length);
  const undo = useDrawStore((state) => state.undo);
  const redo = useDrawStore((state) => state.redo);
  const drawing = useDrawStore((state) => state.state.mode !== "idle");
  const canUndo = pastLength > 0;
  const canRedo = futureLength > 0;

  const basemaps = availableBasemaps(configuredKeys);
  const terrainCapable = basemaps.find((entry) => entry.id === basemap)?.supportsTerrain ?? false;

  return (
    <div className="canvas__overlay canvas__overlay--top-left map-toolbelt" style={{ border: "none", background: "none" }}>
      <div className="canvas__overlay" style={{ position: "static", display: "flex" }}>
        <button
          type="button"
          className="tool-chip"
          aria-pressed={tool === "draw-polygon"}
          onClick={() => setTool(tool === "draw-polygon" ? "pan" : "draw-polygon")}
          title="Draw a site boundary. Click to add corners, Enter to finish, Escape to cancel."
        >
          <PolygonIcon size={12} />
          Draw site
        </button>
        <button
          type="button"
          className="tool-chip"
          aria-pressed={tool === "place-point"}
          onClick={() => setTool(tool === "place-point" ? "pan" : "place-point")}
          title="Mark a location for a resource report."
        >
          <PinIcon size={12} />
          Mark location
        </button>
      </div>

      {drawing && (
        <div className="canvas__overlay" style={{ position: "static", display: "flex" }}>
          <button
            type="button"
            className="tool-chip"
            disabled={!canUndo}
            onClick={undo}
            title="Undo (Cmd+Z)"
          >
            <UndoIcon size={12} />
            Undo
          </button>
          <button
            type="button"
            className="tool-chip"
            disabled={!canRedo}
            onClick={redo}
            title="Redo (Shift+Cmd+Z)"
          >
            <RedoIcon size={12} />
            Redo
          </button>
        </div>
      )}

      <div className="canvas__overlay" style={{ position: "static", display: "flex", alignItems: "center" }}>
        <Select
          className="tool-chip"
          style={{ height: 26, minWidth: 130, border: "none", background: "transparent" }}
          value={basemap}
          aria-label="Basemap"
          onChange={(event) => setBasemap(event.target.value as never)}
          options={basemaps.map((entry) => ({ value: entry.id, label: entry.label }))}
        />
        {terrainCapable && (
          <button
            type="button"
            className="tool-chip"
            aria-pressed={terrain3d}
            onClick={() => setTerrain3d(!terrain3d)}
            title="Tilt into a 3D terrain mesh to read slope and aspect."
          >
            <TerrainIcon size={12} />
            3D
          </button>
        )}
      </div>
    </div>
  );
}

function MapControls() {
  const viewport = useMapStore((state) => state.viewport);
  const flyTo = useMapStore((state) => state.flyTo);
  const sites = useSiteStore((state) => state.sites);
  const fitBounds = useMapStore((state) => state.fitBounds);

  const zoomBy = (delta: number) =>
    flyTo({ longitude: viewport.longitude, latitude: viewport.latitude, zoom: viewport.zoom + delta });

  const fitAll = () => {
    const points = sites.flatMap((site) => site.ring ?? [site.centre]);
    if (points.length === 0) return;
    const lons = points.map((point) => point[0]);
    const lats = points.map((point) => point[1]);
    fitBounds({
      minLon: Math.min(...lons),
      minLat: Math.min(...lats),
      maxLon: Math.max(...lons),
      maxLat: Math.max(...lats),
    });
  };

  return (
    <div className="canvas__overlay canvas__overlay--bottom-right map-controls">
      <IconButton label="Zoom in" onClick={() => zoomBy(1)}>
        <PlusIcon size={14} />
      </IconButton>
      <IconButton label="Zoom out" onClick={() => zoomBy(-1)}>
        <MinusIcon size={14} />
      </IconButton>
      <IconButton label="Zoom to all sites" onClick={fitAll} disabled={sites.length === 0}>
        <CrosshairIcon size={14} />
      </IconButton>
    </div>
  );
}

function ScaleBar() {
  const viewport = useMapStore((state) => state.viewport);
  const bar = scaleBarFor(viewport.zoom, viewport.latitude);

  return (
    <div className="canvas__overlay canvas__overlay--bottom-left scale-bar">
      <div className="scale-bar__bar" style={{ width: `${Math.round(bar.pixels)}px` }} />
      <span className="mono">{bar.label}</span>
    </div>
  );
}

/**
 * Live measurement while drawing.
 *
 * The area updates on every vertex and every drag, which is the single most
 * important feedback in the whole drawing interaction.
 */
function DrawReadout() {
  const mode = useDrawStore((state) => state.state.mode);
  // Select the shape itself — never call measurements() inside the selector.
  // A fresh object every snapshot makes React 19 treat the store as changed and
  // re-enter an infinite render loop.
  const shape = useDrawStore((state) => state.state.shape);
  const measurements = useMemo(() => measure(shape), [shape]);

  if (mode === "idle") return null;

  const area = scaleArea(measurements.areaM2);
  const perimeter =
    measurements.perimeterM >= 1000
      ? `${(measurements.perimeterM / 1000).toFixed(2)} km`
      : `${Math.round(measurements.perimeterM)} m`;

  return (
    <div className="canvas__overlay canvas__overlay--top-right draw-readout">
      <div className="draw-readout__row">
        <span>Area</span>
        <span className="draw-readout__value">
          {measurements.valid ? `${area.value} ${area.unit}` : "—"}
        </span>
      </div>
      <div className="draw-readout__row">
        <span>Perimeter</span>
        <span className="draw-readout__value">{perimeter}</span>
      </div>
      <div className="draw-readout__row">
        <span>Corners</span>
        <span className="draw-readout__value">{measurements.vertexCount}</span>
      </div>

      {measurements.invalidReason ? (
        <div className="draw-readout__invalid">{measurements.invalidReason}</div>
      ) : (
        <div className="draw-readout__hint">
          {mode === "drawing"
            ? "Click to add a corner. Enter or click the first corner to finish. Escape cancels."
            : "Drag a corner to move it, or a midpoint to add one. Backspace deletes the selected corner."}
        </div>
      )}
    </div>
  );
}
