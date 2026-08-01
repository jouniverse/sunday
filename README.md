# Sunday _(preliminary README)_

> Temporary developer guide. This file will be replaced by a proper product README later.

Sunday is a **macOS desktop app** for designing solar power systems and estimating long-term yield on a geospatial map. It is built with **Tauri v2 + React 19 + MapLibre**; the authoritative plan is [`notes/plans/SUNDAY_PLAN_v1.md`](notes/plans/SUNDAY_PLAN_v1.md).

This is **not** a web product (no Next.js / Vercel). The UI can still run in a browser via Vite for faster UI work.

## Requirements

- Node.js ≥ 22
- Rust toolchain (for `tauri:dev` / `tauri:build`)
- Python 3 with the packages in [`src-python/`](src-python/) (for the pvlib solar engine)
- Optional: GDAL ≥ 3.1 for Solargis COG conversion

## Quick start

```bash
npm install

# Terminal 1 — UI (browser at http://localhost:1420)
npm run dev

# Terminal 2 — local pvlib sidecar on :8787
npm run engine:dev

# Or run the native shell (also uses the Vite server)
npm run tauri:dev
```

Useful checks:

```bash
npm run check:all   # lint + typecheck + tests
npm run test
npm run typecheck
```

## What you can do today

| Workflow | How |
| --- | --- |
| **Draw a site** | Map → Draw site → click corners → click the first corner (or Enter / double-click) to finish. The boundary becomes a site in the right inspector. Escape cancels a draft. |
| **Mark a point** | Map → Mark location → click. Works after finishing or cancelling a polygon. |
| **Fetch irradiation** | Select the site → Fetch resources (PVGIS, NASA POWER; NREL if you set a key). Browser dev uses Vite proxies to avoid CORS. |
| **Design** | With a site selected, open Design. Area sites use greenfield packing; rooftop sites use building insights when Google Solar is configured. |
| **Projects** | Save / open project files from the app chrome. |
| **GEM plants** | Prepare JSONL with `npm run data:gem`, then import from Settings. Toggle Solar power plants in the left panel. |

## Settings and keys

Open **Settings** (or onboarding) to set:

- **MapTiler** — terrain / hillshade basemaps
- **NREL / NLR** — US solar resource / PVWatts (`developer.nlr.gov`; existing keys still work)
- **Google Solar** — rooftop insights
- **Raster directory / URL** — local Solargis COGs for **zonal sampling in Design** (not yet a painted map overlay)

### Solar engine (Start / Stop)

The engine is a **local** Python process wrapping **pvlib** on `http://127.0.0.1:8787`.

- **Start solar engine** — Tauri can spawn it, or adopt one you already started with `npm run engine:dev`. In browser-only `npm run dev`, start it yourself in a terminal; StatusBar / Settings probe `/health`.
- **Stop solar engine** — stops a process Sunday started. An external `engine:dev` terminal must be interrupted there.
- Status in the bottom-right bar refreshes periodically and reflects that health probe.

Without the engine, the app still runs; physics results are labelled as reduced-capability / first-order estimates.

## Datasets (manual for now)

| Dataset | Prep | Notes |
| --- | --- | --- |
| **GEM solar plants** | `npm run data:gem` then Settings → import | Viewport-bounded map queries |
| **Country rankings** | `npm run data:rankings` | Analytics view |
| **Solargis GHI / DNI / PVOUT** | `./scripts/data-pipeline/convert-solargis-cog.sh IN OUT` | Point Settings at the COG directory. Sampler accepts **`GHI.tif` or `GHI_cog.tif`** (same for DNI/PVOUT). Layer toggles unlock when a path is set; map paint for GSA is still Wave 3. |
| **US arrays / global PV footprints / WDPA / land cover / terrain slope overlay** | — | Catalogued or partially keyed; not fully usable yet |

See also [`scripts/data-pipeline/README.md`](scripts/data-pipeline/README.md).

## Architecture sketch

```
src/design-system   primitives (no domain / stores)
src/shell           chrome, status bar, routing
src/core            map, platform, stores, project schema
src/domain          pure engineering maths
src/services        HTTP APIs, cache, export, datasets
src/features        user workflows
src-tauri/          Rust: rasters, SQLite vectors, settings, sidecar
src-python/         pvlib FastAPI sidecar
```

Platform access goes through `src/core/platform` (never call `@tauri-apps/api` from features).

## Known gaps (next waves)

- Solargis COG → layer availability + map overlay; terrain slope render; ArcGIS WDPA / land cover
- Import US ground-mounted arrays and global PV footprints
- GEM pan/zoom debounce / import streaming polish
- Full Google Solar flux map paint; OSM grid; PyInstaller sidecar packaging
- Deeper onboarding so fewer steps need terminal scripts

## Licence / data attribution

Third-party layers and APIs keep their own licences (GEM, PVGIS, NASA POWER, NREL, MapTiler, Solargis / Global Solar Atlas, etc.). Attribution appears in the UI where applicable.
