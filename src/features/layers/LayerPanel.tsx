/**
 * Layer panel.
 *
 * Two things this must do that a plain toggle list would not: explain why an
 * unavailable layer is unavailable, and show each layer's provenance. Both come
 * from the dataset review — a layer whose vintage and licence are invisible is a
 * layer waiting to be misused.
 *
 * Icons belong on section headers only (not every layer row). When the left
 * panel collapses to a rail, only those section icons remain — sections stay
 * collapsed so the rail has no gaps between icons.
 */

import { useState } from "react";
import { Chip, Switch } from "@/design-system/controls";
import {
  LayersIcon,
  PlantIcon,
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
import { useSettingsStore } from "@/core/store/settingsStore";
import { useUiStore } from "@/core/store/uiStore";
import "./layers.css";

const GROUP_LABELS: Record<LayerDefinition["group"], string> = {
  resource: "Solar resource",
  infrastructure: "Infrastructure",
  land: "Land and terrain",
  context: "This project",
};

function iconForGroup(group: LayerDefinition["group"]) {
  switch (group) {
    case "resource":
      return <SunIcon size={16} />;
    case "infrastructure":
      return <PlantIcon size={16} />;
    case "land":
      return <TerrainIcon size={16} />;
    default:
      return <LayersIcon size={16} />;
  }
}

export function LayerPanel({ collapsed }: { collapsed: boolean }) {
  const runtime = useLayerStore((state) => state.runtime);
  const toggle = useLayerStore((state) => state.toggle);
  const setOpacity = useLayerStore((state) => state.setOpacity);
  // Re-render when settings finish loading, Install flips a chip, or NC toggles.
  useSettingsStore((state) => state.loaded);
  useSettingsStore((state) => state.datasets);
  useSettingsStore((state) => state.preferences.acceptNonCommercialLayers);
  useSettingsStore((state) => state.configuredKeys);
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
    <div className={`layer-panel${collapsed ? " layer-panel--rail" : ""}`}>
      {groups.map((group) => {
        const layers = LAYER_CATALOGUE.filter((layer) => layer.group === group);
        if (layers.length === 0) return null;
        const open = !collapsed && (openGroups[group] ?? true);
        const label = GROUP_LABELS[group];

        return (
          <section key={group} className={`layer-group layer-group--${group}`}>
            <button
              type="button"
              className="layer-group__toggle"
              aria-expanded={open}
              aria-label={label}
              title={collapsed ? label : undefined}
              onClick={() => {
                if (collapsed) return;
                setOpenGroups((prev) => ({ ...prev, [group]: !(prev[group] ?? true) }));
              }}
            >
              <span className="layer-group__icon">{iconForGroup(group)}</span>
              {!collapsed && <SectionLabel>{label}</SectionLabel>}
              {!collapsed && (
                <span className="layer-group__chevron" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
              )}
            </button>
            {open &&
              layers.map((layer) => {
                const state = runtime[layer.id] ?? { visible: false, opacity: 1 };
                const usable = isLayerUsable(layer);
                const reason = unavailableReason(layer);

                return (
                  <div
                    key={layer.id}
                    className={`layer-row${state.visible ? " layer-row--on" : ""}`}
                    title={layer.purpose}
                  >
                    <div className="layer-row__main">
                      <span className="layer-row__name">{layer.label}</span>
                      {layer.vintage && <span className="layer-row__meta">{layer.vintage}</span>}
                    </div>
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
            (layer) => {
              const opacity = runtime[layer.id]?.opacity ?? 1;
              const percent = Math.round(opacity * 100);
              return (
                <label key={layer.id} className="layer-panel__slider">
                  <span className="layer-panel__slider-label">{layer.label}</span>
                  <input
                    className="layer-panel__range"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={percent}
                    aria-label={`${layer.label} opacity`}
                    aria-valuetext={`${percent}%`}
                    onChange={(event) => setOpacity(layer.id, Number(event.target.value) / 100)}
                  />
                  <span className="layer-panel__slider-value">{percent}%</span>
                </label>
              );
            },
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
