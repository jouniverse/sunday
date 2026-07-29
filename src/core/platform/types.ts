/**
 * The boundary between Sunday's UI and its host.
 *
 * Features depend on this interface, never on `@tauri-apps/api` directly. Two
 * implementations satisfy it: the real Tauri core, and a browser fallback that
 * makes the entire UI runnable under `npm run dev` and testable in jsdom. That
 * is a development affordance — the shipping target is always Tauri.
 */

/* --- Errors --------------------------------------------------------------- */

/** The stable error shape the Rust core serialises. */
export interface NativeError {
  kind:
    | "io"
    | "tiff"
    | "sqlite"
    | "json"
    | "http"
    | "no_data"
    | "invalid"
    | "unsupported"
    | "engine_unavailable";
  message: string;
}

export class PlatformError extends Error {
  readonly kind: NativeError["kind"] | "unavailable";

  constructor(kind: NativeError["kind"] | "unavailable", message: string) {
    super(message);
    this.name = "PlatformError";
    this.kind = kind;
  }
}

/** Thrown when a capability needs the desktop shell and we are in a browser. */
export function unavailable(capability: string): PlatformError {
  return new PlatformError(
    "unavailable",
    `${capability} needs the Sunday desktop app. Run \`npm run tauri:dev\` instead of the browser dev server.`,
  );
}

/* --- Application info ----------------------------------------------------- */

export interface EngineStatus {
  state: "stopped" | "starting" | "ready" | "unavailable";
  baseUrl: string;
  token: string | null;
  detail: string | null;
  pvlibVersion: string | null;
  external: boolean;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  configDir: string;
  rasterDir: string;
  vectorStore: string;
  engine: EngineStatus;
}

/* --- Settings ------------------------------------------------------------- */

/** Providers that need a key. PVGIS and NASA POWER deliberately do not. */
export type ApiProvider = "google_solar" | "nrel" | "maptiler" | "stadia";

export interface SettingsView {
  configuredKeys: ApiProvider[];
  preferences: Record<string, unknown>;
  rasterSources: Record<string, unknown>;
  datasets: Record<string, unknown>;
  onboardingComplete: boolean;
  settingsPath: string;
  dataDir: string;
}

export interface SettingsApi {
  get(): Promise<SettingsView>;
  setApiKey(provider: ApiProvider, key: string | null): Promise<SettingsView>;
  /** Returns a key for a single outbound request; never used for bulk reads. */
  revealApiKey(provider: ApiProvider): Promise<string | null>;
  update(patch: {
    preferences?: Record<string, unknown>;
    rasterSources?: Record<string, unknown>;
    datasets?: Record<string, unknown>;
    onboardingComplete?: boolean;
  }): Promise<SettingsView>;
}

/* --- Projects ------------------------------------------------------------- */

export interface ProjectDocument {
  schema: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
  sites: unknown;
  designs: unknown;
  layers: unknown;
  view: unknown;
  [key: string]: unknown;
}

export interface LoadedProject {
  path: string;
  project: ProjectDocument;
  /** The file came from a newer schema; unknown fields were preserved. */
  fromNewerSchema: boolean;
}

export interface ProjectApi {
  save(path: string, project: ProjectDocument): Promise<string>;
  load(path: string): Promise<LoadedProject>;
  /** Native save dialog; resolves to null when cancelled. */
  pickSavePath(defaultName: string): Promise<string | null>;
  pickOpenPath(): Promise<string | null>;
}

/* --- Raster --------------------------------------------------------------- */

export type RasterSource =
  | { kind: "local"; path: string }
  | { kind: "http"; url: string };

export interface GeoTransform {
  originX: number;
  originY: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface RasterLevel {
  ifd: number;
  width: number;
  height: number;
  scale: number;
}

export interface RasterInfo {
  source: RasterSource;
  width: number;
  height: number;
  transform: GeoTransform;
  nodata: number | null;
  samplesPerPixel: number;
  tiled: boolean;
  chunkWidth: number;
  chunkHeight: number;
  levels: RasterLevel[];
}

export interface ZonalStats {
  method: "pixels_in_polygon" | "centroid_sample";
  count: number;
  nodataCount: number;
  min: number;
  max: number;
  mean: number;
  /** cos(latitude)-weighted mean; the right figure for geographic rasters. */
  areaWeightedMean: number;
  median: number;
  stdDev: number;
  sum: number;
  levelScale: number;
  pixelAreaKm2: number;
}

export interface ZonalResult {
  stats: ZonalStats;
  raster: RasterInfo;
}

export interface RasterApi {
  info(source: RasterSource): Promise<RasterInfo>;
  /** Rings are GeoJSON-style: outer ring first, the rest are holes. */
  zonalStats(
    source: RasterSource,
    rings: Array<Array<[number, number]>>,
    options?: { band?: number; geographic?: boolean },
  ): Promise<ZonalResult>;
}

/* --- Vector datasets ------------------------------------------------------ */

export interface VectorFeature {
  id: string;
  dataset: string;
  lon: number;
  lat: number;
  capacityMw: number | null;
  status: string | null;
  technology: string | null;
  country: string | null;
  name: string | null;
  source: string;
  vintage: string | null;
  properties: Record<string, unknown>;
  geometry: GeoJSON.Geometry | null;
}

export interface BboxQuery {
  dataset: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  limit: number;
  includeGeometry: boolean;
  statuses?: string[];
  technologies?: string[];
  minCapacityMw?: number;
}

export interface BboxResult {
  features: VectorFeature[];
  /** Matches before `limit`, so the UI can say "showing N of M". */
  total: number;
  truncated: boolean;
}

export interface DatasetSummary {
  dataset: string;
  source: string;
  vintage: string | null;
  license: string | null;
  featureCount: number;
  totalCapacityMw: number | null;
}

export interface NearbyFeature extends VectorFeature {
  distanceKm: number;
}

export interface VectorApi {
  datasets(): Promise<DatasetSummary[]>;
  queryBbox(query: BboxQuery): Promise<BboxResult>;
  getFeature(dataset: string, id: string): Promise<VectorFeature | null>;
  nearest(
    dataset: string,
    lon: number,
    lat: number,
    radiusKm: number,
    limit: number,
  ): Promise<NearbyFeature[]>;
  importFeatures(input: {
    dataset: string;
    source: string;
    vintage?: string;
    license?: string;
    features: VectorFeature[];
  }): Promise<number>;
}

/* --- Solar engine sidecar ------------------------------------------------- */

export interface EngineApi {
  status(): Promise<EngineStatus>;
  start(): Promise<EngineStatus>;
  stop(): Promise<EngineStatus>;
  /** POSTs to an engine endpoint, adding auth and translating failures. */
  call<TRequest, TResponse>(endpoint: string, body: TRequest): Promise<TResponse>;
}

/* --- Shell services ------------------------------------------------------- */

export interface ShellApi {
  /** Opens a URL in the user's default browser, not in the app webview. */
  openExternal(url: string): Promise<void>;
  /** Writes a generated file (export). Resolves to the path, or null if cancelled. */
  saveFile(
    suggestedName: string,
    contents: string | Uint8Array,
    filters?: Array<{ name: string; extensions: string[] }>,
  ): Promise<string | null>;
}

/* --- The platform --------------------------------------------------------- */

export interface Platform {
  readonly kind: "tauri" | "web";
  appInfo(): Promise<AppInfo>;
  settings: SettingsApi;
  project: ProjectApi;
  raster: RasterApi;
  vector: VectorApi;
  engine: EngineApi;
  shell: ShellApi;
}
