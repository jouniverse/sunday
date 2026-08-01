/**
 * MapLibre GL JS v6 ships the main bundle and its Web Worker as separate ESM
 * chunks that share code. Vite's dependency optimizer does not copy the worker
 * next to the optimised main module, so the auto-detected
 * `./maplibre-gl-worker.mjs` URL 404s and the map never paints.
 *
 * Point MapLibre at a Vite-emitted worker URL before any Map is constructed.
 * `?worker&url` also pulls in `maplibre-gl-shared.mjs`, which a bare `?url`
 * import would leave unresolved in production builds.
 */

import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);
