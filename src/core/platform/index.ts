/**
 * Platform selection.
 *
 * Import `platform()` from here and nothing else. Features must never reach for
 * `@tauri-apps/api` directly, or they stop being runnable in the browser and
 * testable in jsdom.
 */

import { tauriPlatform } from "./tauri";
import type { Platform } from "./types";
import { webPlatform } from "./web";

export * from "./types";

/**
 * Tauri injects `__TAURI_INTERNALS__` into the webview before any app script
 * runs, which makes it a reliable synchronous host check.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let resolved: Platform | null = null;

export function platform(): Platform {
  if (!resolved) {
    resolved = isTauri() ? tauriPlatform : webPlatform;
  }
  return resolved;
}

/** Test seam: lets a spec install a stub platform. */
export function setPlatformForTesting(next: Platform | null): void {
  resolved = next;
}
