/**
 * Layer panel.
 *
 * Two things this must do that a plain toggle list would not: explain why an
 * unavailable layer is unavailable, and show each layer's provenance. Both come
 * from the dataset review — a layer whose vintage and licence are invisible is a
 * layer waiting to be misused.
 */

import { useState } from "react";
import { Chip, Switch } from "@/design-system/controls";
import {
  BoltIcon,
  LayersIcon,
  PlantIcon,
  SatelliteIcon,
  SunIcon,
  TerrainIcon,
} from "@/design-system/icons";
import { Callout, ProvenanceBadge, SectionLabel } from "@/design-system/data";
import {
  LAYER_CATALOGUE,
  isLayerUsable,
  unavailableReason,
  useLayerStore,
} from "@/core/store/layerStore";
import type { LayerDefinition } from "@/core/store/layerStore";
import { useUiStore } from "@/core/store/uiStore";
import "./layers.css";

const GROUP_LABELS: Record<LayerDefinition["group"], string> = {
  resource: "Solar resource",
  infrastructure: "Infrastructure",
  land: "Land and terrain",
  context: "This project",
};

function iconFor(layer: LayerDefinition) {
  switch (layer.group) {
    case "resource":
      return <SunIcon size={16} />;
    case "infrastructure":
      return layer.id === "osm-power" ? <BoltIcon size={16} /> : <PlantIcon size={16} />;
    case "land":
      return <TerrainIcon size={16} />;
    default:
      return layer.id === "sites" ? <LayersIcon size={16} /> : <SatelliteIcon size={16} />;
  }
}

export function LayerPanel({ collapsed }: { collapsed: boolean }) {
  const runtime = useLayerStore((state) => state.runtime);
  const toggle = useLayerStore((state) => state.toggle);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  const setView = useUiStore((state) => state.setView);
  const notify = useUiStore((state) => state.notify);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    context: true,
    resource: true,
    infrastructure: true,
    land: true,
  });

  const groups: Array<LayerDefinition["group"]> = ["context", "resource", "infrastructure", "land"];

  return (
    <div className="layer-panel">
      {groups.map((group) => {
        const layers = LAYER_CATALOGUE.filter((layer) => layer.group === group);
        if (layers.length === 0) return null;
        const open = openGroups[group] ?? true;

        return (
          <section key={group} className="layer-group">
            {!collapsed && (
              <button
                type="button"
                className="layer-group__toggle"
                aria-expanded={open}
                onClick={() =>
                  setOpenGroups((prev) => ({ ...prev, [group]: !(prev[group] ?? true) }))
                }
              >
                <SectionLabel>{GROUP_LABELS[group]}</SectionLabel>
                <span className="layer-group__chevron" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
              </button>
            )}
            {(collapsed || open) &&
              layers.map((layer) => {
                const state = runtime[layer.id] ?? { visible: false, opacity: 1 };
                const usable = isLayerUsable(layer);
                const reason = unavailableReason(layer);

                return (
                  <div
                    key={layer.id}
                    className={`layer-row${state.visible ? " layer-row--on" : ""}`}
                    title={collapsed ? layer.label : layer.purpose}
                  >
                    <span className="layer-row__icon">{iconFor(layer)}</span>
                    {!collapsed && (
                      <div className="layer-row__main">
                        <span className="layer-row__name">{layer.label}</span>
                        {layer.vintage && <span className="layer-row__meta">{layer.vintage}</span>}
                      </div>
                    )}
                    {!collapsed && (
                      <Switch
                        checked={state.visible}
                        label={`Show ${layer.label}`}
                        disabled={!usable}
                        onChange={() => {
                          if (!usable) {
                            // Never fail silently: say what is missing and where to fix it.
                            notify({
                              tone: "info",
                              message: `${layer.label} is not available yet`,
                              detail: reason ?? undefined,
                            });
                            setView("settings");
                            return;
                          }
                          toggle(layer.id);
                        }}
                      />
                    )}
                  </div>
                );
              })}
          </section>
        );
      })}

      {!collapsed && <LayerDetail />}

      {!collapsed && (
        <div className="layer-panel__opacity">
          <SectionLabel>Visible layer opacity</SectionLabel>
          {LAYER_CATALOGUE.filter((layer) => runtime[layer.id]?.visible && layer.id !== "sites").map(
            (layer) => (
              <label key={layer.id} className="layer-panel__slider">
                <span>{layer.label}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={runtime[layer.id]?.opacity ?? 1}
                  aria-label={`${layer.label} opacity`}
                  onChange={(event) => setOpacity(layer.id, Number(event.target.value))}
                />
              </label>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Provenance and legend for whichever layers are currently on. */
function LayerDetail() {
  const runtime = useLayerStore((state) => state.runtime);
  const visible = LAYER_CATALOGUE.filter(
    (layer) => runtime[layer.id]?.visible && layer.id !== "sites",
  );

  if (visible.length === 0) {
    return (
      <Callout tone="note">
        No data layers are on. Turn one on above to see it here with its source, vintage and licence.
      </Callout>
    );
  }

  return (
    <div className="layer-detail">
      {visible.map((layer) => (
        <div key={layer.id} className="layer-detail__card">
          <span className="layer-detail__title">{layer.label}</span>
          <ProvenanceBadge
            fidelity={layer.kind === "derived" ? "estimated" : "modelled"}
            source={layer.source}
            vintage={layer.vintage}
          />
          {layer.licence && <Chip dot={false}>{layer.licence}</Chip>}
          {layer.legend && (
            <div className="layer-detail__legend">
              {layer.legend.map((entry) => (
                <div key={entry.label} className="map-legend__item">
                  <span className="map-legend__swatch" style={{ background: entry.colour }} />
                  {entry.label}
                </div>
              ))}
              {layer.units && <div className="map-legend__units">{layer.units}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
