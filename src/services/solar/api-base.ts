/**
 * Base URLs for solar HTTP APIs.
 *
 * Browser `npm run dev` uses same-origin `/api/*` Vite proxies (CORS).
 * Tauri (`tauri:dev` and packaged) uses absolute hosts and fetches through the
 * Rust HTTP bridge — WKWebView `fetch` fails on some relative API URLs with
 * "The string did not match the expected pattern", and CORS still applies when
 * the webview origin is `http://localhost:1420`.
 */

export type SolarApiHost = "pvgis" | "nasa_power" | "nlr";

function isTauriHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** True when Vite's `/api/*` proxies are the right base (browser DEV only). */
function useViteApiProxy(): boolean {
  return Boolean(import.meta.env.DEV) && !isTauriHost();
}

export function solarApiBase(host: SolarApiHost): string {
  if (useViteApiProxy()) {
    switch (host) {
      case "pvgis":
        return "/api/pvgis/api/v5_3";
      case "nasa_power":
        return "/api/nasa-power/api/temporal";
      case "nlr":
        return "/api/nlr/api";
    }
  }

  switch (host) {
    case "pvgis":
      return "https://re.jrc.ec.europa.eu/api/v5_3";
    case "nasa_power":
      return "https://power.larc.nasa.gov/api/temporal";
    case "nlr":
      // Federal developer portal. developer.nrel.gov is the former host and often fails DNS.
      return "https://developer.nlr.gov/api";
  }
}
