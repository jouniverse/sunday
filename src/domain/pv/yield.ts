/**
 * First-order PV yield.
 *
 * This is the fallback path, and it says so in every result it returns. The real
 * estimate comes from `pvlib` through the solar engine, or from PVGIS/PVWatts
 * directly. What this provides is a transparent number that is available with no
 * network and no sidecar, so a drawn polygon always shows *something* the user
 * can sanity-check, clearly labelled as first-order.
 *
 * The model:
 *
 *   E = POA x A x eta x (1 - losses) x (1 - temperature derate)
 *
 * with POA obtained from horizontal insolation via a transposition factor. Every
 * term is visible in the breakdown so a user can see exactly what produced the
 * figure.
 */

import { equatorFacingAzimuth, toRadians } from "../units";
import { azimuthDifference } from "../units";

export type FidelityLabel = "first_order" | "api" | "modelled";

export interface YieldBreakdown {
  /** Horizontal insolation used as input, kWh/m²/year. */
  ghiKwhM2Year: number;
  /** Plane-of-array insolation after transposition, kWh/m²/year. */
  poaKwhM2Year: number;
  transpositionFactor: number;
  /** Fraction lost to cell temperature over the year. */
  temperatureDerate: number;
  /** Fraction lost to soiling, mismatch, wiring, availability and downtime. */
  systemLosses: number;
  /** Fraction lost to row-to-row shading, when supplied. */
  shadingLoss: number;
  /** Combined performance ratio: delivered energy over ideal STC energy. */
  performanceRatio: number;
}

export interface YieldEstimate {
  annualKwh: number;
  /** Annual energy per installed kW DC. The figure that compares sites. */
  specificYieldKwhPerKwp: number;
  capacityFactor: number;
  breakdown: YieldBreakdown;
  fidelity: FidelityLabel;
  method: string;
  caveats: string[];
}

export interface YieldInput {
  /** Annual global horizontal irradiation, kWh/m²/year. */
  ghiKwhM2Year: number;
  capacityKwDc: number;
  surfaceTiltDegrees: number;
  surfaceAzimuthDegrees: number;
  latitude: number;
  /** Mean ambient temperature over daylight hours, °C. */
  meanAmbientTempC?: number;
  /** Module power temperature coefficient, fraction per °C. Negative. */
  gammaPdc?: number;
  /** Combined non-thermal system losses as a fraction. */
  systemLosses?: number;
  /** Row shading loss as a fraction, from the packing engine. */
  shadingLoss?: number;
}

/**
 * Transposition factor: plane-of-array over horizontal insolation.
 *
 * A geometric approximation. The tilt term is the cosine projection of the
 * direct beam onto the tilted plane relative to horizontal, using the annual mean
 * solar elevation as the reference; the azimuth term penalises pointing away from
 * the equator. Real transposition needs an hourly sky model (Hay-Davies or Perez),
 * which is what `/transpose` in the engine provides.
 */
export function transpositionFactor(
  tiltDegrees: number,
  azimuthDegrees: number,
  latitude: number,
): number {
  const tilt = toRadians(Math.max(0, Math.min(90, tiltDegrees)));
  const absLatitude = Math.abs(latitude);

  // Annual mean solar noon elevation. Declination averages to zero over a year,
  // so the mean noon elevation is 90 - |latitude|. Clamped away from zero so a
  // polar site does not divide by a vanishing sine.
  const meanNoonElevation = toRadians(Math.min(89, Math.max(5, 90 - absLatitude)));

  // Beam gain on a surface tilted towards the sun's meridian:
  //   cos(incidence) / cos(zenith) = sin(elevation + tilt) / sin(elevation)
  // At the equator (elevation 90 degrees) this is cos(tilt), which correctly
  // makes flat optimal; at latitude L it peaks at tilt = L.
  const beamGain = Math.sin(meanNoonElevation + tilt) / Math.sin(meanNoonElevation);

  // Diffuse light comes from the whole sky dome, so tilting away from horizontal
  // loses some of it. The standard isotropic view factor is (1 + cos(tilt)) / 2.
  const diffuseViewFactor = (1 + Math.cos(tilt)) / 2;
  // Diffuse fraction rises with latitude as the atmosphere path lengthens.
  const diffuseFraction = Math.min(0.6, 0.2 + absLatitude / 200);

  const gain = (1 - diffuseFraction) * beamGain + diffuseFraction * diffuseViewFactor;

  // Azimuth penalty: cosine falloff away from the equator-facing direction,
  // scaled by tilt because a flat array does not care which way it points.
  const misalignment = azimuthDifference(azimuthDegrees, equatorFacingAzimuth(latitude));
  const azimuthPenalty = 1 - (1 - Math.cos(toRadians(misalignment))) * Math.sin(tilt) * 0.45;

  return Math.max(0.35, gain * azimuthPenalty);
}

/**
 * Annual mean derate from cell temperature.
 *
 * Cells run hotter than ambient in sunlight and lose power as they do. Using the
 * NOCT-style linear rise of roughly 25 °C above ambient at typical operating
 * irradiance, and the module's own power coefficient.
 */
export function temperatureDerate(meanAmbientTempC: number, gammaPdc: number): number {
  const CELL_RISE_C = 25;
  const STC_CELL_TEMP_C = 25;
  const meanCellTempC = meanAmbientTempC + CELL_RISE_C;
  // gammaPdc is negative, so a cell above 25 °C gives a positive derate.
  return Math.max(0, -gammaPdc * (meanCellTempC - STC_CELL_TEMP_C));
}

/** First-order annual yield. Always labelled `first_order`. */
export function estimateAnnualYield(input: YieldInput): YieldEstimate {
  const {
    ghiKwhM2Year,
    capacityKwDc,
    surfaceTiltDegrees,
    surfaceAzimuthDegrees,
    latitude,
    meanAmbientTempC = 15,
    gammaPdc = -0.0035,
    systemLosses = 0.14,
    shadingLoss = 0,
  } = input;

  const caveats = [
    "First-order estimate from annual irradiation and geometric transposition. " +
      "Run the solar engine for an hourly pvlib model, which accounts for the real " +
      "distribution of irradiance, temperature and incidence angle.",
  ];

  if (ghiKwhM2Year <= 0 || capacityKwDc <= 0) {
    return {
      annualKwh: 0,
      specificYieldKwhPerKwp: 0,
      capacityFactor: 0,
      breakdown: {
        ghiKwhM2Year: Math.max(0, ghiKwhM2Year),
        poaKwhM2Year: 0,
        transpositionFactor: 0,
        temperatureDerate: 0,
        systemLosses,
        shadingLoss,
        performanceRatio: 0,
      },
      fidelity: "first_order",
      method: "no yield: zero irradiation or zero capacity",
      caveats,
    };
  }

  const factor = transpositionFactor(surfaceTiltDegrees, surfaceAzimuthDegrees, latitude);
  const poaKwhM2Year = ghiKwhM2Year * factor;
  const thermal = temperatureDerate(meanAmbientTempC, gammaPdc);

  // Losses compound: two independent 10% losses retain 81%, not 80%.
  const retained = (1 - thermal) * (1 - systemLosses) * (1 - shadingLoss);

  // At STC a 1 kW array under 1 kW/m² makes 1 kWh per kWh/m² of insolation, so
  // energy is POA insolation times capacity times the retained fraction. This is
  // the same identity PVWatts uses, which is why the result is comparable to it.
  const annualKwh = poaKwhM2Year * capacityKwDc * retained;

  if (thermal > 0.12) {
    caveats.push(
      `Temperature derate of ${(thermal * 100).toFixed(1)}% is high; check the mean ambient ` +
        "temperature and consider a module with a flatter power coefficient.",
    );
  }
  if (shadingLoss > 0.05) {
    caveats.push(
      `Row shading is costing ${(shadingLoss * 100).toFixed(1)}%; a lower coverage ratio ` +
        "would trade land for yield.",
    );
  }

  return {
    annualKwh,
    specificYieldKwhPerKwp: annualKwh / capacityKwDc,
    capacityFactor: annualKwh / (capacityKwDc * 8760),
    breakdown: {
      ghiKwhM2Year,
      poaKwhM2Year,
      transpositionFactor: factor,
      temperatureDerate: thermal,
      systemLosses,
      shadingLoss,
      performanceRatio: retained,
    },
    fidelity: "first_order",
    method:
      "E = POA x capacity x (1 - thermal) x (1 - system losses) x (1 - shading), " +
      "with POA from a geometric transposition of annual GHI.",
    caveats,
  };
}

/**
 * Tilt that maximises the first-order transposition factor.
 *
 * A coarse search rather than a closed form, because the azimuth penalty makes
 * the objective non-analytic. Reports a band as well as a peak: annual insolation
 * is flat near the optimum, and claiming a single degree would overstate what this
 * model can resolve.
 */
export function optimalTiltFirstOrder(
  latitude: number,
  azimuthDegrees?: number,
): { tilt: number; bandMin: number; bandMax: number; factor: number; method: string } {
  const azimuth = azimuthDegrees ?? equatorFacingAzimuth(latitude);
  let best = { tilt: 0, factor: 0 };
  const scores: Array<{ tilt: number; factor: number }> = [];

  for (let tilt = 0; tilt <= 70; tilt += 1) {
    const factor = transpositionFactor(tilt, azimuth, latitude);
    scores.push({ tilt, factor });
    if (factor > best.factor) best = { tilt, factor };
  }

  // Within 0.5% of peak counts as equally good, matching the engine's envelope.
  const threshold = best.factor * 0.995;
  const within = scores.filter((score) => score.factor >= threshold).map((score) => score.tilt);

  return {
    tilt: best.tilt,
    bandMin: Math.min(...within),
    bandMax: Math.max(...within),
    factor: best.factor,
    method:
      "First-order geometric search over tilt. Use the solar engine's optimal-tilt " +
      "endpoint for a transposition-model result.",
  };
}
