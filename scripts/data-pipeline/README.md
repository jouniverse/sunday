# Sunday data pipeline

One-shot preprocessing for optional and bundled datasets. Source files live under
`notes/datasets/` during development; the app never reads those paths directly.

## Bundled assets (ship with the app)

| Script | Input | Output |
| --- | --- | --- |
| `prepare-country-rankings.mjs` | Solargis country summary CSV | `data/bundled/country-rankings.json` and `src/assets/data/country-rankings.json` |
| `extract-gmseus-priors.mjs` | GM-SEUS documentation / notes | prints the priors already encoded in `src/domain/packing/priors.ts` for audit |

```bash
node scripts/data-pipeline/prepare-country-rankings.mjs
```

## Optional downloads (user or team installs)

| Script | Input | Output |
| --- | --- | --- |
| `import-gem.mjs` | GEM utility-scale CSV | JSONL ready for `vector.importFeatures`, or direct SQLite via Rust store |
| `convert-solargis-cog.sh` | Raw Global Solar Atlas GeoTIFFs | Cloud-Optimised GeoTIFFs for HTTP range / local zonal stats |

```bash
# GEM plant catalogue (~100k phases) → JSONL in data/derived/
node scripts/data-pipeline/import-gem.mjs \
  --input notes/datasets/gem-solar/solar-power-plants-utility-scale-2-2026.csv \
  --output data/derived/gem-solar.jsonl

# Then import into the running app's vector store from Settings, or:
# npm run tauri:dev  → Settings → Datasets → Import GEM JSONL

# Solargis rasters → COGs (requires GDAL ≥ 3.1)
./scripts/data-pipeline/convert-solargis-cog.sh \
  notes/datasets/solargis-solar-potential/World_GHI_GISdata_LTAy_AvgDailyTotals_GlobalSolarAtlas-v2_GEOTIFF \
  data/derived/cogs
```

## Rules

- Never commit raw multi-GB GeoTIFFs or the 109 MB GEM GeoJSON.
- Every derived row keeps `source`, `vintage` and `licence`.
- Inventories are never silently unioned; GEM leads as the named-plant catalogue.
