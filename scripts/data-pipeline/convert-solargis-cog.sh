#!/usr/bin/env bash
# Convert Global Solar Atlas GeoTIFFs into Cloud-Optimised GeoTIFFs.
#
# COGs let Sunday read only the pixel window covering a drawn polygon — never
# the whole multi-GB file — whether the file is local or served over HTTP range
# requests.
#
# Usage:
#   ./scripts/data-pipeline/convert-solargis-cog.sh INPUT_DIR OUTPUT_DIR
#
# Requires GDAL ≥ 3.1 with the COG driver.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 INPUT_DIR OUTPUT_DIR" >&2
  exit 2
fi

INPUT_DIR=$1
OUTPUT_DIR=$2

if ! command -v gdal_translate >/dev/null 2>&1; then
  echo "gdal_translate not found. Install GDAL ≥ 3.1." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

shopt -s nullglob
files=("$INPUT_DIR"/*.tif "$INPUT_DIR"/*.tiff "$INPUT_DIR"/**/*.tif "$INPUT_DIR"/**/*.tiff)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No GeoTIFF files found under $INPUT_DIR" >&2
  exit 1
fi

for src in "${files[@]}"; do
  base=$(basename "$src")
  # Keep EPSG:4326 for zonal statistics; do not warp to Web Mercator here.
  # Overviews let large-area queries step to a coarser level under the pixel budget.
  dest="$OUTPUT_DIR/${base%.*}_cog.tif"
  echo "→ $dest"
  gdal_translate "$src" "$dest" \
    -of COG \
    -co COMPRESS=DEFLATE \
    -co PREDICTOR=2 \
    -co BLOCKSIZE=512 \
    -co OVERVIEWS=AUTO \
    -co RESAMPLING=AVERAGE \
    -co BIGTIFF=IF_SAFER
done

echo "Done. Point Settings → Solar resource rasters at $OUTPUT_DIR (local) or upload the COGs to a bucket."
