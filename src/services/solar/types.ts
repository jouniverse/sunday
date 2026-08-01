/**
 * The shape every solar API is normalised into.
 *
 * Normalising is what lets the site report show four sources side by side and
 * flag where they disagree. The alternative — each view knowing each API's own
 * field names — is how the reference apps ended up impossible to extend.
 */

export type SolarProvider = "pvgis" | "google_solar" | "nrel" | "nasa_power";

export interface ProviderInfo {
  id: SolarProvider;
  label: string;
  /** Underlying dataset, which is what actually determines fidelity. */
  dataset: string;
  /** Spatial resolution of the source, in a form a user can judge. */
  resolution: string;
  coverage: string
  requiresKey: boolean;
  attribution: string;
  documentation: string;
}

export const PROVIDERS: Record<SolarProvider, ProviderInfo> = {
  pvgis: {
    id: "pvgis",
    label: "PVGIS",
    dataset: "PVGIS-SARAH3 / ERA5 satellite climatology",
    resolution: "about 5 km",
    coverage: "Global except high latitudes",
    requiresKey: false,
    attribution: "European Commission Joint Research Centre, PVGIS",
    documentation: "https://joint-research-centre.ec.europa.eu/pvgis-online-tool_en",
  },
  google_solar: {
    id: "google_solar",
    label: "Google Solar",
    dataset: "Aerial imagery derived roof geometry and flux",
    resolution: "0.1–0.25 m per pixel",
    coverage: "Selected urban regions",
    requiresKey: true,
    attribution: "Google Solar API",
    documentation: "https://developers.google.com/maps/documentation/solar",
  },
  nrel: {
    id: "nrel",
    label: "NREL",
    dataset: "NSRDB / PVWatts v8",
    resolution: "about 4 km",
    coverage: "United States and the Americas",
    requiresKey: true,
    attribution: "National Renewable Energy Laboratory",
    documentation: "https://developer.nlr.gov/docs/solar/",
  },
  nasa_power: {
    id: "nasa_power",
    label: "NASA POWER",
    dataset: "CERES SYN1deg solar, MERRA-2 meteorology",
    resolution: "1° solar, 0.5° × 0.625° meteorology",
    coverage: "Global",
    requiresKey: false,
    attribution: "NASA Langley Research Center POWER Project",
    documentation: "https://power.larc.nasa.gov/docs/",
  },
};

export interface MonthlyValue {
  month: number;
  value: number;
}

/**
 * A resource report, normalised.
 *
 * Fields are optional because no single provider returns all of them, and the
 * report must show what is actually available rather than a zero standing in for
 * a missing measurement.
 */
export interface ResourceReport {
  provider: SolarProvider;
  latitude: number;
  longitude: number;
  /** Annual global horizontal irradiation, kWh/m²/year. */
  ghiKwhM2Year?: number;
  /** Annual direct normal irradiation, kWh/m²/year. */
  dniKwhM2Year?: number;
  /** Annual diffuse horizontal irradiation, kWh/m²/year. */
  dhiKwhM2Year?: number;
  /** Annual in-plane irradiation at the reported tilt, kWh/m²/year. */
  poaKwhM2Year?: number;
  optimalTiltDegrees?: number;
  optimalAzimuthDegrees?: number;
  /** Annual mean air temperature near 2 m (°C), when the provider reports it. */
  meanAirTempC?: number;
  /** Specific yield for the provider's own reference system, kWh/kWp/year. */
  specificYieldKwhPerKwp?: number;
  monthlyGhi?: MonthlyValue[];
  monthlyYield?: MonthlyValue[];
  /** Monthly optimal fixed-tilt angles (°), when the provider reports them. */
  monthlyOptimalTilt?: MonthlyValue[];
  /** Monthly mean air temperature near 2 m (°C). */
  monthlyAirTempC?: MonthlyValue[];
  /** Provenance, required. The UI renders it next to every figure. */
  source: string;
  dataset: string;
  vintage?: string;
  fidelity: "measured" | "modelled" | "estimated" | "unknown";
  method: string;
  /** Anything the user should know before trusting these numbers. */
  caveats: string[];
  /** The exact request made, for reproducibility in an exported report. */
  requestUrl?: string;
}

/** One roof segment from Google Solar building insights. */
export interface RoofSegment {
  index: number;
  pitchDegrees: number;
  azimuthDegrees: number;
  areaM2: number;
  centre: [number, number];
  /** Annual plane-of-array irradiance for this segment, kWh/m²/year. */
  sunshineQuantilesKwh?: number[];
}

export interface RoofConfiguration {
  panelCount: number;
  yearlyEnergyDcKwh: number;
  /** Per-segment breakdown, so a designer can see where the panels went. */
  segments: Array<{ segmentIndex: number; panelCount: number; yearlyEnergyDcKwh: number }>;
}

/** One panel placement from Google Solar `solarPanels[]`. */
export interface GoogleSolarPanel {
  centre: [number, number];
  /** PORTRAIT or LANDSCAPE relative to the segment. */
  orientation: "PORTRAIT" | "LANDSCAPE" | string;
  segmentIndex: number;
  yearlyEnergyDcKwh: number;
}

export interface BuildingInsights {
  provider: "google_solar";
  name: string;
  centre: [number, number];
  /** Imagery capture date, which bounds how current the geometry is. */
  imageryDate?: string;
  imageryQuality?: string;
  /** Maximum panels the roof can hold at the provider's panel size. */
  maxPanelCount: number;
  panelCapacityWatts: number;
  panelHeightM: number;
  panelWidthM: number;
  roofSegments: RoofSegment[];
  configurations: RoofConfiguration[];
  /** Exact panel centres from Google — first N are the preferred layout. */
  solarPanels: GoogleSolarPanel[];
  wholeRoofAreaM2?: number;
  maxSunshineHoursPerYear?: number;
  carbonOffsetFactorKgPerMwh?: number;
  source: string;
  caveats: string[];
}

/**
 * Two reports of the same quantity, and how far apart they are.
 *
 * The plan forbids silently averaging disagreeing sources; this is the type that
 * makes disagreement a first-class result instead.
 */
export interface Comparison {
  quantity: string;
  unit: string;
  values: Array<{ provider: SolarProvider; value: number; fidelity: string }>;
  min: number;
  max: number;
  mean: number;
  /** Spread as a fraction of the mean. */
  relativeSpread: number;
  /** True when the spread is large enough to warrant the user's attention. */
  significant: boolean;
}

/** Spread above this fraction of the mean is worth flagging in the report. */
export const SIGNIFICANT_SPREAD = 0.1;

export function compareValues(
  quantity: string,
  unit: string,
  entries: Array<{ provider: SolarProvider; value: number | undefined; fidelity: string }>,
): Comparison | null {
  const values = entries.filter(
    (entry): entry is { provider: SolarProvider; value: number; fidelity: string } =>
      typeof entry.value === "number" && Number.isFinite(entry.value),
  );
  if (values.length === 0) return null;

  const numbers = values.map((entry) => entry.value);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const mean = numbers.reduce((total, value) => total + value, 0) / numbers.length;
  const relativeSpread = mean === 0 ? 0 : (max - min) / mean;

  return {
    quantity,
    unit,
    values,
    min,
    max,
    mean,
    relativeSpread,
    significant: values.length > 1 && relativeSpread > SIGNIFICANT_SPREAD,
  };
}
