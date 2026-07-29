/**
 * Location search: place names via Nominatim, plus direct coordinate entry.
 *
 * Coordinate entry is first-class rather than an afterthought, because
 * professionals arrive with coordinates far more often than with place names, and
 * every reference app made them paste into a search box that then geocoded the
 * text and moved somewhere else.
 */

import { useEffect, useRef, useState } from "react";
import { requestJson } from "@/services/http/client";
import { useMapStore } from "@/core/store/mapStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { SearchBox } from "@/design-system/controls";
import "./search.css";

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  boundingbox?: [string, string, string, string];
}

/**
 * Parses direct coordinate input.
 *
 * Accepts `35.05, -118.17`, `35.05 -118.17`, and the hemisphere-suffixed forms
 * `35.05N 118.17W` that appear in reports and datasheets.
 */
export function parseCoordinates(input: string): { latitude: number; longitude: number } | null {
  const text = input.trim();
  if (!text) return null;

  // Hemisphere-suffixed decimal degrees.
  const suffixed = text.match(
    /^\s*(\d+(?:\.\d+)?)\s*°?\s*([NnSs])\s*[,\s]\s*(\d+(?:\.\d+)?)\s*°?\s*([EeWw])\s*$/,
  );
  if (suffixed) {
    const lat = Number(suffixed[1]) * (suffixed[2]?.toUpperCase() === "S" ? -1 : 1);
    const lon = Number(suffixed[3]) * (suffixed[4]?.toUpperCase() === "W" ? -1 : 1);
    return inRange(lat, lon);
  }

  // Signed decimal degrees, latitude first.
  const plain = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (plain) {
    return inRange(Number(plain[1]), Number(plain[2]));
  }
  return null;
}

function inRange(latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export function LocationSearch() {
  const [text, setText] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const flyTo = useMapStore((state) => state.flyTo);
  const fitBounds = useMapStore((state) => state.fitBounds);
  const addPointSite = useSiteStore((state) => state.addPointSite);
  const notify = useUiStore((state) => state.notify);

  // Close the results list on an outside click.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  async function search() {
    const coordinates = parseCoordinates(text);
    if (coordinates) {
      // Coordinates go straight to the map and become a site, with no geocoding.
      flyTo({ ...coordinates, zoom: 16 });
      addPointSite([coordinates.longitude, coordinates.latitude], text.trim());
      setText("");
      setOpen(false);
      return;
    }

    if (text.trim().length < 3) return;
    setSearching(true);
    try {
      const found = await requestJson<NominatimResult[]>({
        provider: "Nominatim",
        url: `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
          q: text.trim(),
          format: "json",
          limit: "6",
        })}`,
        // Nominatim's usage policy requires identification and rate limiting.
        headers: { "Accept-Language": "en" },
        attempts: 1,
        cacheTtlMs: 10 * 60 * 1000,
      });
      setResults(found);
      setOpen(true);
      if (found.length === 0) {
        notify({
          tone: "info",
          message: "No place matched that search",
          detail: "Try a coordinate pair instead, for example 35.05, -118.17.",
        });
      }
    } catch (error) {
      notify({
        tone: "error",
        message: "Place search failed",
        detail:
          error instanceof Error
            ? error.message
            : "Could not reach the geocoding service. Coordinate entry still works offline.",
      });
    } finally {
      setSearching(false);
    }
  }

  function choose(result: NominatimResult) {
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);

    if (result.boundingbox) {
      const [south, north, west, east] = result.boundingbox.map(Number) as [
        number,
        number,
        number,
        number,
      ];
      fitBounds({ minLon: west, minLat: south, maxLon: east, maxLat: north });
    } else {
      flyTo({ latitude, longitude, zoom: 14 });
    }
    setOpen(false);
    setText("");
  }

  return (
    <div className="location-search" ref={containerRef}>
      <SearchBox
        width={320}
        placeholder="Search a place, or enter 35.05, -118.17"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void search();
          }
          if (event.key === "Escape") setOpen(false);
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        aria-label="Search a place or enter coordinates"
      />

      {open && results.length > 0 && (
        <ul className="location-search__results" role="listbox">
          {results.map((result) => (
            <li key={result.place_id}>
              <button type="button" onClick={() => choose(result)}>
                <span className="location-search__name">{result.display_name}</span>
                <span className="location-search__coords mono">
                  {Number(result.lat).toFixed(4)}, {Number(result.lon).toFixed(4)}
                </span>
              </button>
            </li>
          ))}
          <li className="location-search__attribution">Search by OpenStreetMap Nominatim</li>
        </ul>
      )}

      {searching && <span className="location-search__status">Searching…</span>}
    </div>
  );
}
