/**
 * Dedicated MapLibre host for Insights choropleths (not the Project canvas).
 */

import { type MapLayerMouseEvent, Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import "@/core/map/maplibre-worker";
import "maplibre-gl/dist/maplibre-gl.css";

const SOURCE = "insights-countries";
const FILL = "insights-countries-fill";
const LINE = "insights-countries-line";

export interface ChoroplethRow {
  iso3: string;
  value: number;
  name?: string;
}

function lerpColour(t: number): string {
  const clamps = Math.max(0, Math.min(1, t));
  const r = Math.round(42 + (230 - 42) * clamps);
  const g = Math.round(38 + (194 - 38) * clamps);
  const b = Math.round(32 + (122 - 32) * clamps);
  return `rgb(${r},${g},${b})`;
}

function matchExpression(rows: ChoroplethRow[]): unknown[] {
  if (!rows.length) return ["literal", "#1c1914"];
  const values = rows.map((r) => r.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const expr: unknown[] = ["match", ["get", "ADM0_A3"]];
  for (const row of rows) {
    expr.push(row.iso3.toUpperCase(), lerpColour((row.value - min) / span));
  }
  expr.push("#1c1914");
  return expr;
}

export function ChoroplethMap({
  rows,
  selectedIso3,
  onSelect,
  unit = "",
  valueFormat = (v: number) => v.toFixed(1),
}: {
  rows: ChoroplethRow[];
  selectedIso3: string | null;
  onSelect: (iso3: string) => void;
  unit?: string;
  valueFormat?: (value: number) => string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const valueFormatRef = useRef(valueFormat);
  valueFormatRef.current = valueFormat;
  const unitRef = useRef(unit);
  unitRef.current = unit;
  const byIsoRef = useRef(new Map<string, ChoroplethRow>());
  byIsoRef.current = new Map(rows.map((r) => [r.iso3.toUpperCase(), r]));

  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    name: string;
    value: string;
  } | null>(null);

  const range = useMemo(() => {
    if (!rows.length) return null;
    const values = rows.map((r) => r.value);
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [rows]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          [SOURCE]: { type: "geojson", data: "/data/countries.geojson" },
        },
        layers: [
          {
            id: "bg",
            type: "background",
            paint: { "background-color": "#141210" },
          },
          {
            id: FILL,
            type: "fill",
            source: SOURCE,
            paint: {
              "fill-color": "#2a2620",
              "fill-opacity": 0.92,
            },
          },
          {
            id: LINE,
            type: "line",
            source: SOURCE,
            paint: {
              "line-color": "#4a453c",
              "line-width": 0.6,
            },
          },
        ],
      },
      center: [10, 20],
      zoom: 1.2,
      attributionControl: false,
      dragRotate: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.setPaintProperty(FILL, "fill-color", matchExpression(rowsRef.current) as never);
      requestAnimationFrame(() => map.resize());
    });

    map.on("click", FILL, (event: MapLayerMouseEvent) => {
      const iso3 = String(event.features?.[0]?.properties?.ADM0_A3 ?? "").toUpperCase();
      if (iso3.length === 3) onSelectRef.current(iso3);
    });

    map.on("mousemove", FILL, (event: MapLayerMouseEvent) => {
      const props = event.features?.[0]?.properties ?? {};
      const iso3 = String(props.ADM0_A3 ?? "").toUpperCase();
      const row = byIsoRef.current.get(iso3);
      const name = row?.name ?? String(props.NAME ?? props.ADMIN ?? iso3);
      if (!row) {
        setTooltip(null);
        return;
      }
      setTooltip({
        x: event.point.x,
        y: event.point.y,
        name,
        value: `${valueFormatRef.current(row.value)}${unitRef.current ? ` ${unitRef.current}` : ""}`,
      });
    });

    map.on("mouseenter", FILL, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", FILL, () => {
      map.getCanvas().style.cursor = "";
      setTooltip(null);
    });

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer(FILL)) return;
    map.setPaintProperty(FILL, "fill-color", matchExpression(rows) as never);
  }, [rows]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer(LINE)) return;
    map.setPaintProperty(LINE, "line-width", [
      "case",
      ["==", ["get", "ADM0_A3"], selectedIso3 ?? ""],
      2,
      0.6,
    ]);
    map.setPaintProperty(LINE, "line-color", [
      "case",
      ["==", ["get", "ADM0_A3"], selectedIso3 ?? ""],
      "#e6c27a",
      "#4a453c",
    ]);
  }, [selectedIso3]);

  return (
    <div className="insights__map-wrap">
      <div className="insights__map-host" ref={containerRef} data-testid="insights-choropleth" />
      {range && (
        <div className="insights__map-legend" aria-hidden>
          <span className="insights__map-legend-label">
            {valueFormat(range.min)}
            {unit ? ` ${unit}` : ""}
          </span>
          <div className="insights__map-legend-bar" />
          <span className="insights__map-legend-label">
            {valueFormat(range.max)}
            {unit ? ` ${unit}` : ""}
          </span>
        </div>
      )}
      {tooltip && (
        <div
          className="insights__map-tooltip"
          style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
        >
          <strong>{tooltip.name}</strong>
          <span>{tooltip.value}</span>
        </div>
      )}
    </div>
  );
}
