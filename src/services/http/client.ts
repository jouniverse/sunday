/**
 * HTTP client for the solar APIs.
 *
 * Everything the API clients need and nothing they do not: a timeout, bounded
 * retries with backoff on transient failures only, a response cache keyed by
 * request, and errors that name the provider and say what to do next.
 *
 * The retry policy matters. PVGIS and NASA POWER both rate-limit, and a client
 * that hammers a public service on failure is a client that gets blocked — a
 * specific anti-pattern the API reviews warned about.
 *
 * In Tauri, JSON/text requests go through the Rust HTTP bridge (reqwest). That
 * avoids WKWebView `fetch` failures ("The string did not match the expected
 * pattern") and CORS when the webview origin is `http://localhost:1420`.
 */

import { isTauri, platform } from "@/core/platform";

export interface RequestOptions {
  /** Provider name, used in error messages and cache keys. */
  provider: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Attempts including the first. 3 means one try plus two retries. */
  attempts?: number;
  /** Skip the cache for this request. */
  noCache?: boolean;
  /** How long a cached response stays fresh. */
  cacheTtlMs?: number;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly provider: string;
  readonly status: number | null;
  /** What the user can do about it. Always populated. */
  readonly guidance: string;
  readonly retryable: boolean;

  constructor(options: {
    provider: string;
    message: string;
    status?: number | null;
    guidance: string;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.provider = options.provider;
    this.status = options.status ?? null;
    this.guidance = options.guidance;
    this.retryable = options.retryable ?? false;
  }
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * In-memory response cache.
 *
 * Solar resource data for a location does not change between two clicks, and
 * every one of these APIs is either rate-limited or metered. An hour of freshness
 * is generous for climatology and harmless for everything else Sunday requests.
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export function cacheKey(options: RequestOptions): string {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  return `${options.provider}|${options.method ?? "GET"}|${options.url}|${body}`;
}

export function clearHttpCache(): void {
  cache.clear();
}

export function httpCacheSize(): number {
  return cache.size;
}

/** HTTP statuses worth retrying: transient server and rate-limit conditions. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function guidanceFor(provider: string, status: number | null): string {
  if (status === 401 || status === 403) {
    return `${provider} rejected the request as unauthorised. Check the API key in Settings, and that the key is enabled for this API.`;
  }
  if (status === 429) {
    return `${provider} is rate-limiting requests. Wait a moment before retrying, or reduce how many locations you query at once.`;
  }
  if (status === 404) {
    return `${provider} has no data for this request. The location may be outside the dataset's coverage.`;
  }
  if (status !== null && status >= 500) {
    return `${provider} reported a server error. This is on their side; try again shortly.`;
  }
  return `Could not reach ${provider}. Check the network connection, then retry.`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Performs a request with retry, timeout and caching. Returns parsed JSON. */
export async function requestJson<T>(options: RequestOptions): Promise<T> {
  return requestBody(options, (body) => JSON.parse(body) as T);
}

/** Same policy, but returns raw text — PVGIS can answer with CSV. */
export async function requestText(options: RequestOptions): Promise<string> {
  return requestBody(options, (body) => body);
}

/** Same policy, for binary payloads such as Google Solar GeoTIFFs. */
export async function requestBytes(options: RequestOptions): Promise<ArrayBuffer> {
  return requestViaFetch({ ...options, noCache: true }, (response) => response.arrayBuffer());
}

async function requestBody<T>(
  options: RequestOptions,
  parseBody: (body: string) => T,
): Promise<T> {
  // Tauri: native reqwest. Browser: Vite proxy / CORS-friendly fetch.
  if (isTauri()) {
    return requestViaNative(options, parseBody);
  }
  return requestViaFetch(options, async (response) => parseBody(await response.text()));
}

async function requestViaNative<T>(
  options: RequestOptions,
  parseBody: (body: string) => T,
): Promise<T> {
  const key = cacheKey(options);
  if (!options.noCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  }

  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 20_000;
  let lastError: ApiError | null = null;
  const url = resolveFetchUrl(options.url);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new ApiError({
        provider: options.provider,
        message: "Request cancelled",
        guidance: "The request was cancelled.",
      });
    }

    try {
      const result = await platform().http.fetchText({
        url,
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        timeoutMs,
      });

      if (result.status < 200 || result.status >= 300) {
        const detail = result.body.slice(0, 400);
        const error = new ApiError({
          provider: options.provider,
          status: result.status,
          message: `${options.provider} returned ${result.status}${detail ? `: ${detail}` : ""}`,
          guidance: guidanceFor(options.provider, result.status),
          retryable: isRetryableStatus(result.status),
        });
        if (!error.retryable || attempt === attempts) throw error;
        lastError = error;
      } else {
        const value = parseBody(result.body);
        if (!options.noCache) {
          cache.set(key, {
            value,
            expiresAt: Date.now() + (options.cacheTtlMs ?? DEFAULT_TTL_MS),
          });
        }
        return value;
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (!error.retryable || attempt === attempts) throw error;
        lastError = error;
      } else {
        const wrapped = new ApiError({
          provider: options.provider,
          message: `Could not reach ${options.provider}: ${error instanceof Error ? error.message : String(error)}`,
          guidance: guidanceFor(options.provider, null),
          retryable: true,
        });
        if (attempt === attempts) throw wrapped;
        lastError = wrapped;
      }
    }

    const backoff = 400 * 2 ** (attempt - 1);
    await sleep(backoff + Math.random() * 200);
  }

  throw (
    lastError ??
    new ApiError({
      provider: options.provider,
      message: `${options.provider} request failed`,
      guidance: guidanceFor(options.provider, null),
    })
  );
}

async function requestViaFetch<T>(
  options: RequestOptions,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const key = cacheKey(options);
  if (!options.noCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  }

  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 20_000;
  let lastError: ApiError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort);

    try {
      const response = await fetch(resolveFetchUrl(options.url), {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 400);
        const error = new ApiError({
          provider: options.provider,
          status: response.status,
          message: `${options.provider} returned ${response.status}${detail ? `: ${detail}` : ""}`,
          guidance: guidanceFor(options.provider, response.status),
          retryable: isRetryableStatus(response.status),
        });
        if (!error.retryable || attempt === attempts) throw error;
        lastError = error;
      } else {
        const value = await parse(response);
        if (!options.noCache) {
          cache.set(key, {
            value,
            expiresAt: Date.now() + (options.cacheTtlMs ?? DEFAULT_TTL_MS),
          });
        }
        return value;
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (!error.retryable || attempt === attempts) throw error;
        lastError = error;
      } else if (options.signal?.aborted) {
        throw new ApiError({
          provider: options.provider,
          message: "Request cancelled",
          guidance: "The request was cancelled.",
        });
      } else {
        const aborted = error instanceof Error && error.name === "AbortError";
        const wrapped = new ApiError({
          provider: options.provider,
          message: aborted
            ? `${options.provider} did not respond within ${timeoutMs / 1000} s`
            : `Could not reach ${options.provider}: ${error instanceof Error ? error.message : String(error)}`,
          guidance: guidanceFor(options.provider, null),
          retryable: true,
        });
        if (attempt === attempts) throw wrapped;
        lastError = wrapped;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }

    const backoff = 400 * 2 ** (attempt - 1);
    await sleep(backoff + Math.random() * 200);
  }

  throw (
    lastError ??
    new ApiError({
      provider: options.provider,
      message: `${options.provider} request failed`,
      guidance: guidanceFor(options.provider, null),
    })
  );
}

/** Builds a query string, dropping undefined values. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * Makes relative API paths absolute against the page origin.
 *
 * Used for browser Vite proxies. Absolute https URLs are returned unchanged
 * (Tauri native bridge and packaged builds).
 */
export function resolveFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (typeof window === "undefined" || !window.location?.origin) return url;
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}
