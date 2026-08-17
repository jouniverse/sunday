/**
 * Feasible / recommended envelopes for CSP designer knobs.
 *
 * Land-use priors: tower ~2.5 ha/MWₑ, trough ~1.8 ha/MWₑ (order-of-magnitude
 * from published plants — not a substitute for SolarPILOT land_area). SM and
 * TES bands follow SAM typical molten-salt / physical-trough practice.
 */

import type {
  CspDesignEnvelope,
  CspPlantInputs,
  CspTowerParameters,
  CspTroughParameters,
} from "./types";

/** Square metres of land per MWₑ, used only to bound rated power from site area. */
const TOWER_M2_PER_MWE = 25_000;
const TROUGH_M2_PER_MWE = 18_000;

/** Roads/pads/rims share. Missing saved values fall back to the greenfield prior. */
export function clampLandUnavailableFraction(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.1;
  return Math.min(0.4, Math.max(0, value));
}

function band(
  min: number,
  max: number,
  recommendedMin: number,
  recommendedMax: number,
  suggested: number,
) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return {
    min,
    max,
    recommendedMin,
    recommendedMax,
    suggested: clamp(suggested),
  };
}

export function cspDesignEnvelope(areaM2: number): CspDesignEnvelope {
  const area = Math.max(0, areaM2);
  const towerCap = Math.max(1, area / TOWER_M2_PER_MWE);
  const troughCap = Math.max(1, area / TROUGH_M2_PER_MWE);
  const ratedMax = Math.min(150, Math.max(towerCap, troughCap) * 1.4);
  const ratedSuggested = Math.min(ratedMax, Math.max(1, towerCap));

  return {
    ratedMwe: band(1, Math.max(5, ratedMax), 1, Math.max(1, towerCap), ratedSuggested),
    solarMultiple: band(1.2, 3.2, 1.8, 2.6, 2.2),
    towerHeightM: band(80, 280, 120, 200, 150),
    tesHours: band(0, 16, 6, 12, 10),
    rowPitchM: band(12, 28, 15, 20, 17),
    rationale: [
      "Rated power is bounded by site area using ~2.5 ha/MWₑ (tower) and ~1.8 ha/MWₑ (trough) — screening priors, not a layout.",
      "Solar multiple and TES hours follow SAM typical molten-salt / physical-trough ranges. Leaving the recommended band is allowed and labelled.",
      "Tower height is a designer knob; SolarPILOT may optimize it when that flag is on. Heliostats track — there is no tilt slider.",
      "Trough rows are packed by Sunday (not SolarPILOT). Row azimuth is the tracking axis (typically north–south).",
      "Roads, pads and rims are a Sunday land-unavailable fraction: the schematic is inset from the fence line, and annual energy is derated by the same share (labelled, not a SAM land model).",
    ],
  };
}

export function defaultTowerParameters(areaM2: number): CspTowerParameters {
  const envelope = cspDesignEnvelope(areaM2);
  return {
    technology: "tower",
    ratedMwe: envelope.ratedMwe.suggested,
    solarMultiple: envelope.solarMultiple.suggested,
    towerHeightM: envelope.towerHeightM.suggested,
    heliostatWidthM: 12.2,
    heliostatHeightM: 12.2,
    layoutMethod: "radial_stagger",
    landUnavailableFraction: clampLandUnavailableFraction(0.1),
    tesHours: envelope.tesHours.suggested,
    cooling: "wet",
  };
}

export function defaultTroughParameters(areaM2: number): CspTroughParameters {
  const envelope = cspDesignEnvelope(areaM2);
  return {
    technology: "trough",
    ratedMwe: envelope.ratedMwe.suggested,
    solarMultiple: envelope.solarMultiple.suggested,
    rowAzimuthDegrees: 0,
    rowPitchM: envelope.rowPitchM.suggested,
    apertureM: 5.77,
    landUnavailableFraction: clampLandUnavailableFraction(0.1),
    tesHours: envelope.tesHours.suggested,
    cooling: "wet",
  };
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6;
}

/** True when the live knobs no longer match the last Estimate. */
export function cspPlantInputsStale(estimated: CspPlantInputs, current: CspPlantInputs): boolean {
  return (
    estimated.technology !== current.technology ||
    estimated.cooling !== current.cooling ||
    estimated.layoutMethod !== current.layoutMethod ||
    !near(estimated.ratedMwe, current.ratedMwe) ||
    !near(estimated.solarMultiple, current.solarMultiple) ||
    !near(estimated.tesHours, current.tesHours) ||
    !near(estimated.landUnavailableFraction, current.landUnavailableFraction) ||
    !near(estimated.towerHeightM ?? 0, current.towerHeightM ?? 0) ||
    !near(estimated.rowPitchM ?? 0, current.rowPitchM ?? 0) ||
    !near(estimated.rowAzimuthDegrees ?? 0, current.rowAzimuthDegrees ?? 0)
  );
}
