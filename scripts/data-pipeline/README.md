# Sunday data pipeline

Optional datasets are installed **in the app** from Settings: pick a datasets
folder, then use each row’s **Install** button. Sunday discovers expected
filenames under that folder (recursive), copies or converts into app data, and
marks the catalogue layer usable.

CLI scripts below remain for advanced/dev preprocessing (bundled assets, COG
batch conversion, offline GEM JSONL). Source files often live under
`notes/datasets/` during development; the app never hard-codes those paths.

## In-app Install (primary)

| Dataset id | Expected inputs (first match wins) | Installed to |
| --- | --- | --- |
| `gsa-ghi` / `gsa-dni` / `gsa-pvout` | `GHI.tif` / `GHI_cog.tif` (and DNI, PVOUT) | `{dataDir}/rasters/*_cog.tif` |
| `gem-solar` | `Solar power plants.csv` / `.jsonl` (legacy names ok) | SQLite `gem-solar` |
| `tz-sam` | `Global PV footprints.gpkg` / `.geojson` (legacy ok) | SQLite `tz-sam` |
| `gmseus-arrays` | `US ground-mounted arrays.gpkg` / `.geojson` (legacy ok) | SQLite `gmseus-arrays` |
| `wdpa` | `Protected areas.shp` (+ `.shx`/`.dbf`) or `.geojson` | `{dataDir}/vector/protected_areas.pmtiles` + SQLite `wdpa` |

- Rasters: if GDAL is on PATH and only a raw GeoTIFF is found, Install runs
  `gdal_translate` to COG; otherwise the file is copied as-is.
- Footprints: prefer GPKG via `ogr2ogr` when GDAL is available; else GeoJSON.
  If only GPKG exists and GDAL is missing, Install fails with guidance to export
  GeoJSON or install GDAL.
- TZ-SAM also requires **Allow non-commercial licensed layers** (CC BY-NC 4.0).

## Bundled assets (ship with the app)

| Script | Input | Output |
| --- | --- | --- |
| `prepare-country-rankings.mjs` | Solargis country summary CSV | `data/bundled/country-rankings.json` and `src/assets/data/country-rankings.json` |
| `extract-gmseus-priors.mjs` | GM-SEUS documentation / notes | prints the priors already encoded in `src/domain/packing/priors.ts` for audit |

```bash
node scripts/data-pipeline/prepare-country-rankings.mjs
```

## Optional CLI (advanced / offline)

| Script | Input | Output |
| --- | --- | --- |
| `import-gem.mjs` | GEM utility-scale CSV | JSONL (also importable via in-app Install if named `gem-solar.jsonl`) |
| `convert-solargis-cog.sh` | Raw Global Solar Atlas GeoTIFFs | Cloud-Optimised GeoTIFFs for HTTP range / local zonal stats |
| `convert-wdpa-pmtiles.sh` | Folder with WDPA shapefile or GeoJSON | `protected_areas.pmtiles` (backup / testing / cloud prep) |

```bash
# GEM plant catalogue (~100k phases) → JSONL in data/derived/
node scripts/data-pipeline/import-gem.mjs \
  --input notes/datasets/gem-solar/solar-power-plants-utility-scale-2-2026.csv \
  --output data/derived/gem-solar.jsonl

# Solargis rasters → COGs (requires GDAL ≥ 3.1)
./scripts/data-pipeline/convert-solargis-cog.sh \
  notes/datasets/solargis-solar-potential/World_GHI_GISdata_LTAy_AvgDailyTotals_GlobalSolarAtlas-v2_GEOTIFF \
  data/derived/cogs

# Protected areas → PMTiles (requires ogr2ogr + tippecanoe; can take many minutes)
./scripts/data-pipeline/convert-wdpa-pmtiles.sh \
  notes/datasets/app-datasets \
  data/derived
```

## Rules

- Never commit raw multi-GB GeoTIFFs or the 109 MB GEM GeoJSON.
- Every derived row keeps `source`, `vintage` and `licence`.
- Inventories are never silently unioned; GEM leads as the named-plant catalogue.
