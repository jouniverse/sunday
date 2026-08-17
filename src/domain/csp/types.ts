/**
 * CSP design types — parallel to PV DesignParameters, not mixed into them.
 *
 * Tower field geometry comes from SolarPILOT/PySAM; trough row packing is
 * Sunday-owned. Every result that reaches the UI must carry a `method` string.
 */

export type CspTechnology = "tower" | "trough";
export type CspCooling = "wet" | "dry" | "hybrid";
export type CspLayoutMethod = "radial_stagger" | "cornfield";

export interface CspTowerParameters {
  technology: "tower";
  /** Gross turbine rating, MWₑ. */
  ratedMwe: number;
  /** Receiver design thermal power, MWₜ. Optional — plant module can derive from SM. */
  designThermalMwt?: number;
  solarMultiple: number;
  towerHeightM: number;
  receiverHeightM?: number;
  receiverAspect?: number;
  heliostatWidthM: number;
  heliostatHeightM: number;
  layoutMethod: CspLayoutMethod;
  /** Share of the parcel reserved for roads, pads and rims (0–0.4). */
  landUnavailableFraction: number;
  tesHours: number;
  cooling: CspCooling;
}

export interface CspTroughParameters {
  technology: "trough";
  ratedMwe: number;
  solarMultiple: number;
  /** Tracking-axis azimuth, degrees from north. Typical ~0 (N–S). */
  rowAzimuthDegrees: number;
  /** Centre-to-centre row pitch, m. */
  rowPitchM: number;
  /** Collector aperture width, m. */
  apertureM: number;
  /** Share of the parcel reserved for roads, pads and rims (0–0.4). */
  landUnavailableFraction: number;
  tesHours: number;
  cooling: CspCooling;
}

export type CspParameters = CspTowerParameters | CspTroughParameters;

export interface CspEnvelopeBand {
  min: number;
  max: number;
  recommendedMin: number;
  recommendedMax: number;
  suggested: number;
}

export interface CspDesignEnvelope {
  ratedMwe: CspEnvelopeBand;
  solarMultiple: CspEnvelopeBand;
  towerHeightM: CspEnvelopeBand;
  tesHours: CspEnvelopeBand;
  rowPitchM: CspEnvelopeBand;
  rationale: string[];
}

export interface CspLocalPoint {
  x: number;
  y: number;
}

export interface CspHeliostatLayout {
  origin: [number, number];
  positionsLocal: CspLocalPoint[];
  positionsLngLat: Array<[number, number]>;
  heliostatCount: number;
  reflectiveAreaM2: number;
  landAreaM2?: number;
  opticalEfficiency?: number;
  method: string;
}

export interface CspTroughLayout {
  origin: [number, number];
  stripsLngLat: Array<Array<[number, number]>>;
  rowCount: number;
  apertureAreaM2: number;
  pitchM: number;
  method: string;
}

export interface CspPlantInputs {
  technology: CspTechnology;
  ratedMwe: number;
  solarMultiple: number;
  tesHours: number;
  cooling: CspCooling;
  landUnavailableFraction: number;
  towerHeightM?: number;
  layoutMethod?: CspLayoutMethod;
  rowPitchM?: number;
  rowAzimuthDegrees?: number;
}

export interface CspPlantResult {
  annualEnergyKwh: number;
  capacityFactor: number;
  waterUseM3?: number;
  /** SAM Lcoefcr, USD/kWh. Null when the cost model did not return a capital cost. */
  lcoeUsdPerKwh?: number;
  lcoeMethod?: string;
  /** SAM plant `total_installed_cost`, USD. Same capital that feeds Lcoefcr. */
  totalInstalledCostUsd?: number;
  method: string;
  /** Knobs that produced this estimate — Results stay until Estimate is run again. */
  inputs: CspPlantInputs;
}
