# Bundled app data

Small datasets that ship with Sunday. Large inventories and rasters are optional
downloads — see `scripts/data-pipeline/README.md`.

| File | Source | Use |
| --- | --- | --- |
| `country-rankings.json` | Global Solar Atlas / Solargis country summary (2020), CC BY 4.0 | Analytics rankings |

Regenerate with:

```bash
npm run data:rankings
```
