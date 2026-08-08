#!/usr/bin/env bash
# Convert a WDPA / Protected areas vector dataset into a local PMTiles archive.
#
# Mirrors the in-app Settings Install path (ogr2ogr simplify → tippecanoe), for
# offline testing, backups, and future cloud migrations. The app Install still
# writes SQLite screening geometries separately; this script only builds PMTiles.
#
# Usage:
#   ./scripts/data-pipeline/convert-wdpa-pmtiles.sh INPUT_DIR OUTPUT_DIR
#
# INPUT_DIR is searched (non-recursive first, then one level deep) for, in order:
#   Protected areas.shp  (needs .shx + .dbf beside it)
#   wdpa.shp
#   Protected areas.geojson
#   wdpa-poly.geojson
#
# OUTPUT_DIR receives protected_areas.pmtiles
#
# Requires: ogr2ogr (GDAL) and tippecanoe on PATH.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 INPUT_DIR OUTPUT_DIR" >&2
  exit 2
fi

INPUT_DIR=$1
OUTPUT_DIR=$2

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "Input folder not found: $INPUT_DIR" >&2
  exit 1
fi

if ! command -v ogr2ogr >/dev/null 2>&1; then
  echo "ogr2ogr not found. Install GDAL (e.g. brew install gdal)." >&2
  exit 1
fi

if ! command -v tippecanoe >/dev/null 2>&1; then
  echo "tippecanoe not found. Install tippecanoe (e.g. brew install tippecanoe)." >&2
  exit 1
fi

shapefile_complete() {
  local shp=$1
  [[ -f "$shp" && -f "${shp%.shp}.shx" && -f "${shp%.shp}.dbf" ]]
}

find_source() {
  local name
  for name in \
    "Protected areas.shp" \
    "wdpa.shp" \
    "Protected areas.geojson" \
    "wdpa-poly.geojson"; do
    if [[ -f "$INPUT_DIR/$name" ]]; then
      if [[ "$name" == *.shp ]] && ! shapefile_complete "$INPUT_DIR/$name"; then
        continue
      fi
      echo "$INPUT_DIR/$name"
      return 0
    fi
    # One level of subfolders (e.g. WDPA_Aug2026_Public_shp/).
    local hit
    hit=$(find "$INPUT_DIR" -maxdepth 2 -type f -name "$name" 2>/dev/null | head -n 1 || true)
    if [[ -n "$hit" ]]; then
      if [[ "$hit" == *.shp ]] && ! shapefile_complete "$hit"; then
        continue
      fi
      echo "$hit"
      return 0
    fi
  done
  return 1
}

SOURCE=$(find_source) || {
  echo "No Protected areas / WDPA source found under $INPUT_DIR" >&2
  echo "Expected: Protected areas.shp (+ .shx/.dbf), wdpa.shp, Protected areas.geojson, or wdpa-poly.geojson" >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sunday-wdpa.XXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

SIMPLIFIED="$TMP_DIR/wdpa-simplified.jsonl"
PMTILES="$OUTPUT_DIR/protected_areas.pmtiles"

echo "Source: $SOURCE"
echo "→ simplifying to GeoJSONSeq (EPSG:4326, ~0.01°)"
# WDPA exports often omit .prj; assume WGS84 like the in-app installer.
ogr2ogr \
  -f GeoJSONSeq \
  -s_srs EPSG:4326 \
  -t_srs EPSG:4326 \
  -simplify 0.01 \
  -nlt PROMOTE_TO_MULTI \
  -overwrite \
  "$SIMPLIFIED" \
  "$SOURCE"

echo "→ tippecanoe → $PMTILES"
tippecanoe \
  -o "$PMTILES" \
  -zg \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  -l protected_areas \
  -y NAME \
  -y IUCN_CAT \
  -y DESIG_ENG \
  -y STATUS \
  -y MARINE \
  -y WDPAID \
  --force \
  "$SIMPLIFIED"

SIZE=$(du -h "$PMTILES" | awk '{print $1}')
echo "Done. Wrote $PMTILES ($SIZE)."
echo "Copy into Sunday’s app data as vector/protected_areas.pmtiles, or keep for cloud/testing."
