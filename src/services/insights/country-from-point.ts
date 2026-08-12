/**
 * Resolve a site centre to ISO3 via Natural Earth country polygons.
 *
 * Loads `/data/countries.geojson` once and caches the FeatureCollection.
 */

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

type CountriesFc = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

let cache: CountriesFc | null = null;
let loading: Promise<CountriesFc> | null = null;

async function loadCountries(): Promise<CountriesFc> {
  if (cache) return cache;
  if (!loading) {
    loading = fetch("/data/countries.geojson")
      .then((res) => {
        if (!res.ok) throw new Error(`countries.geojson HTTP ${res.status}`);
        return res.json() as Promise<CountriesFc>;
      })
      .then((fc) => {
        cache = fc;
        return fc;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export async function iso3ForLngLat(
  lng: number,
  lat: number,
): Promise<{ iso3: string; name: string } | null> {
  const fc = await loadCountries();
  const pt = point([lng, lat]);
  for (const feature of fc.features) {
    if (!feature.geometry) continue;
    try {
      if (
        !booleanPointInPolygon(
          pt,
          feature as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
        )
      ) {
        continue;
      }
    } catch {
      continue;
    }
    const props = feature.properties ?? {};
    const iso3 = String(props.ADM0_A3 ?? props.ISO_A3 ?? "")
      .trim()
      .toUpperCase();
    const name = String(props.NAME ?? props.ADMIN ?? iso3).trim();
    if (iso3.length === 3) return { iso3, name };
  }
  return null;
}
