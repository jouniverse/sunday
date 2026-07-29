/**
 * Ground-mount array layout and fill factor.
 *
 * The reviews were explicit that this capability exists in none of the libraries
 * we integrate: pvlib models performance, SAM models shading, SolarPILOT does
 * CSP — none of them turn a drawn polygon into a row layout with a capacity. So
 * this is Sunday's own engine, built from published geometry rather than fitted
 * constants.
 *
 * The geometry: modules sit in rows of a given tilt, spaced by a pitch chosen so
 * that rows do not shade each other above a limiting sun elevation. Ground
 * coverage ratio (GCR) is collector width over pitch, and it is the single
 * number that trades energy per module against energy per hectare.
 */

import { toDegrees, toRadians } from "../units";
import type { GcrPrior, ModuleSpec, MountType } from "./priors";
import { GCR_PRIORS, LAND_USE_M2_PER_KW } from "./priors";

export interface RowGeometry {
  /** Slope length of the collector across the row, m. */
  collectorWidthM: number;
  /** Centre-to-centre row spacing, m. */
  pitchM: number;
  /** Clear ground between the back of one row and the front of the next, m. */
  gapM: number;
  /** Collector width over pitch. */
  gcr: number;
  /** Height of the top of the row above its base, m. */
  heightM: number;
  /** Horizontal footprint of one tilted row, m. */
  projectedWidthM: number;
}

/**
 * Row geometry from a GCR.
 *
 * `modulesInPortrait` describes module orientation on the rack, and `rowModules`
 * how many are stacked up the slope (a "2-high portrait" rack, for example).
 */
export function rowGeometryFromGcr(
  module: ModuleSpec,
  options: {
    tiltDegrees: number;
    gcr: number;
    modulesInPortrait?: boolean;
    modulesUpSlope?: number;
  },
): RowGeometry {
  const { tiltDegrees, gcr } = options;
  const portrait = options.modulesInPortrait ?? true;
  const upSlope = Math.max(1, Math.round(options.modulesUpSlope ?? 1));

  const moduleSlopeExtent = portrait ? module.lengthM : module.widthM;
  const collectorWidthM = moduleSlopeExtent * upSlope;
  const tilt = toRadians(tiltDegrees);

  const pitchM = collectorWidthM / gcr;
  const projectedWidthM = collectorWidthM * Math.cos(tilt);

  return {
    collectorWidthM,
    pitchM,
    // Gap is measured between the projected footprints, which is what a person
    // walking the site would actually pace out.
    gapM: pitchM - projectedWidthM,
    gcr,
    heightM: collectorWidthM * Math.sin(tilt),
    projectedWidthM,
  };
}

/**
 * The pitch that avoids row-to-row shading down to a limiting sun elevation.
 *
 * Standard shadow geometry for rows on level ground, with the sun in the plane
 * perpendicular to the rows (the worst case for a north-south pitch):
 *
 *   shadow length = h / tan(elevation), and the pitch must clear the projected
 *   collector plus that shadow.
 *
 * A limiting elevation near 20-25 degrees is the usual design choice; it
 * corresponds to accepting some shading only in the hours where irradiance is
 * low anyway.
 */
export function shadowLimitedPitch(
  collectorWidthM: number,
  tiltDegrees: number,
  limitingSunElevationDegrees: number,
): number {
  const tilt = toRadians(tiltDegrees);
  const elevation = toRadians(
    // Below a couple of degrees the shadow length diverges, which would demand
    // an infinite site. Clamp to a physically meaningful design limit.
    Math.max(2, Math.min(89, limitingSunElevationDegrees)),
  );
  const height = collectorWidthM * Math.sin(tilt);
  const projected = collectorWidthM * Math.cos(tilt);
  return projected + height / Math.tan(elevation);
}

/** GCR implied by a shadow-limited pitch, which is how the envelope is derived. */
export function gcrFromShadowLimit(
  collectorWidthM: number,
  tiltDegrees: number,
  limitingSunElevationDegrees: number,
): number {
  const pitch = shadowLimitedPitch(collectorWidthM, tiltDegrees, limitingSunElevationDegrees);
  return collectorWidthM / pitch;
}

/**
 * Limiting sun elevation on the winter solstice at solar noon.
 *
 * elevation = 90 - |latitude| - 23.44 in the winter hemisphere. This is the
 * conservative anchor for a fixed-tilt design: clear the shortest day and the
 * rest of the year follows.
 */
export function winterSolsticeNoonElevation(latitude: number): number {
  const declination = 23.44;
  return 90 - Math.abs(latitude) - declination;
}

export interface FillFactorInput {
  /** Usable ground area after exclusions, m². */
  usableAreaM2: number;
  module: ModuleSpec;
  mount: MountType;
  tiltDegrees: number;
  gcr: number;
  modulesInPortrait?: boolean;
  modulesUpSlope?: number;
  /** Fraction of usable area lost to roads, inverter pads and margins. */
  balanceOfSystemFraction?: number;
}

export interface FillFactorResult {
  /** Ground the array itself occupies, m². */
  arrayAreaM2: number;
  /** Module aperture area, m². */
  moduleAreaM2: number;
  /** Module area over usable site area. The headline fill factor. */
  fillFactor: number;
  gcr: number;
  moduleCount: number;
  capacityKwDc: number;
  /** Installed DC capacity per hectare of usable site area. */
  densityKwPerHectare: number;
  row: RowGeometry;
  /** Array-block (direct impact) land use, m²/kW — the figure computed here. */
  landUseM2PerKw: number;
  /** Implied total project area including roads, pads and setbacks, m²/kW. */
  totalProjectLandUseM2PerKw: number;
  /** Whether direct-impact land use falls in the range of built projects. */
  landUseWithinRuleOfThumb: boolean;
  method: string;
  notes: string[];
}

/**
 * Capacity and fill factor for a ground-mount site.
 *
 * Deliberately area-based rather than a literal row-by-row packing: a drawn
 * polygon's usable area is itself an estimate, and pretending to place
 * individual modules inside an irregular boundary would imply precision the
 * inputs do not have. The row geometry is still computed and reported, so the
 * layout is checkable and can be drawn on the map.
 */
export function computeFillFactor(input: FillFactorInput): FillFactorResult {
  const {
    usableAreaM2,
    module,
    mount,
    tiltDegrees,
    gcr,
    modulesInPortrait = true,
    modulesUpSlope = 1,
    balanceOfSystemFraction = 0.1,
  } = input;

  const notes: string[] = [];
  if (usableAreaM2 <= 0) {
    return emptyResult(module, mount, tiltDegrees, gcr, [
      "Site has no usable area, so no capacity can be placed.",
    ]);
  }

  const prior = GCR_PRIORS[mount];
  const clampedGcr = Math.min(prior.max, Math.max(prior.min, gcr));
  if (clampedGcr !== gcr) {
    notes.push(
      `Ground coverage ratio ${gcr.toFixed(2)} is outside the feasible range for a ` +
        `${mount.replace("_", "-")} mount, so ${clampedGcr.toFixed(2)} was used.`,
    );
  }

  const row = rowGeometryFromGcr(module, {
    tiltDegrees,
    gcr: clampedGcr,
    modulesInPortrait,
    modulesUpSlope,
  });

  // Roads, pads, fencing setbacks and edge losses come off before the array.
  const arrayAreaM2 = usableAreaM2 * (1 - balanceOfSystemFraction);
  const moduleAreaM2 = arrayAreaM2 * clampedGcr;
  const singleModuleAreaM2 = module.lengthM * module.widthM;
  const moduleCount = Math.floor(moduleAreaM2 / singleModuleAreaM2);
  const capacityKwDc = (moduleCount * module.ratedPowerW) / 1000;

  // Land use here is direct impact (array block) area, because that is what a
  // drawn site polygon represents. Total project area is reported separately so
  // the familiar acres-per-MW figure is available without conflating the two.
  const landUseM2PerKw = capacityKwDc > 0 ? usableAreaM2 / capacityKwDc : Number.POSITIVE_INFINITY;
  const landUseWithinRuleOfThumb =
    landUseM2PerKw >= LAND_USE_M2_PER_KW.directMin &&
    landUseM2PerKw <= LAND_USE_M2_PER_KW.directMax;

  if (!landUseWithinRuleOfThumb && Number.isFinite(landUseM2PerKw)) {
    const direction = landUseM2PerKw > LAND_USE_M2_PER_KW.directMax ? "above" : "below";
    notes.push(
      `Array-block land use of ${landUseM2PerKw.toFixed(0)} m²/kW is ${direction} the ` +
        `${LAND_USE_M2_PER_KW.directMin}–${LAND_USE_M2_PER_KW.directMax} m²/kW range of built ` +
        `projects (${LAND_USE_M2_PER_KW.source}). Check the coverage ratio and the exclusions ` +
        "applied to the site.",
    );
  }

  return {
    arrayAreaM2,
    moduleAreaM2: moduleCount * singleModuleAreaM2,
    fillFactor: (moduleCount * singleModuleAreaM2) / usableAreaM2,
    gcr: clampedGcr,
    moduleCount,
    capacityKwDc,
    densityKwPerHectare: (capacityKwDc / usableAreaM2) * 10_000,
    row,
    landUseM2PerKw,
    totalProjectLandUseM2PerKw: landUseM2PerKw * LAND_USE_M2_PER_KW.totalToDirectRatio,
    landUseWithinRuleOfThumb,
    method:
      "Area-based packing: usable area less balance-of-system share, multiplied by ground " +
      "coverage ratio, divided by module aperture area.",
    notes,
  };
}

function emptyResult(
  module: ModuleSpec,
  mount: MountType,
  tiltDegrees: number,
  gcr: number,
  notes: string[],
): FillFactorResult {
  return {
    arrayAreaM2: 0,
    moduleAreaM2: 0,
    fillFactor: 0,
    gcr,
    moduleCount: 0,
    capacityKwDc: 0,
    densityKwPerHectare: 0,
    row: rowGeometryFromGcr(module, { tiltDegrees, gcr: Math.max(gcr, GCR_PRIORS[mount].min) }),
    landUseM2PerKw: Number.POSITIVE_INFINITY,
    totalProjectLandUseM2PerKw: Number.POSITIVE_INFINITY,
    landUseWithinRuleOfThumb: false,
    method: "no capacity placed",
    notes,
  };
}

export interface DesignEnvelope {
  tilt: { min: number; max: number; recommendedMin: number; recommendedMax: number; suggested: number };
  gcr: { min: number; max: number; recommendedMin: number; recommendedMax: number; suggested: number };
  pitch: { min: number; max: number; suggested: number };
  rationale: string[];
}

/**
 * The feasible-and-recommended envelope the UI presents before any user input.
 *
 * This is the "automation provides the envelope, the designer fine-tunes inside
 * it" pattern made concrete: hard bounds from buildability, a recommended band
 * from shading geometry at this latitude and the measured GM-SEUS distribution.
 */
export function designEnvelope(
  latitude: number,
  module: ModuleSpec,
  mount: MountType,
  options: { modulesUpSlope?: number; modulesInPortrait?: boolean } = {},
): DesignEnvelope {
  const prior: GcrPrior = GCR_PRIORS[mount];
  const absLatitude = Math.abs(latitude);
  const rationale: string[] = [];

  // Fixed-tilt optimum tracks latitude closely; the standard first approximation
  // is tilt ≈ latitude, flattened at high latitude where diffuse light dominates
  // and steep racks cost more in wind loading and self-shading.
  const suggestedTilt =
    mount === "fixed_tilt"
      ? Math.round(Math.min(40, absLatitude * (absLatitude > 45 ? 0.75 : 0.9)))
      : 0;

  if (mount === "fixed_tilt") {
    rationale.push(
      `Suggested tilt of ${suggestedTilt}° follows the tilt-near-latitude rule for ` +
        `${absLatitude.toFixed(1)}° latitude, flattened at high latitude where diffuse ` +
        "irradiance dominates.",
    );
  } else {
    rationale.push("Tracker racks are mounted horizontally; tilt is set by rotation, not by the rack.");
  }

  const collectorWidthM =
    (options.modulesInPortrait ?? true ? module.lengthM : module.widthM) *
    Math.max(1, options.modulesUpSlope ?? 1);

  // Winter-solstice noon elevation gives the conservative shading anchor; a
  // 20 degree floor keeps high-latitude sites from demanding absurd pitches.
  const solsticeElevation = Math.max(15, winterSolsticeNoonElevation(latitude));
  const shadowFreeGcr = gcrFromShadowLimit(
    collectorWidthM,
    suggestedTilt || 10,
    solsticeElevation,
  );

  rationale.push(
    `Shading-limited coverage ratio of ${shadowFreeGcr.toFixed(2)} clears row-to-row ` +
      `shadows down to a ${solsticeElevation.toFixed(0)}° sun elevation, the winter ` +
      "solstice noon altitude at this latitude.",
  );
  rationale.push(
    `Recommended band ${prior.recommendedMin.toFixed(2)}–${prior.recommendedMax.toFixed(2)} ` +
      `reflects built practice (${prior.source}).`,
  );

  // The suggestion is the denser of shading geometry and measured practice,
  // bounded by the recommended band: geometry alone tends to be conservative
  // because real projects accept a little winter shading.
  const suggestedGcr = clamp(
    Math.max(shadowFreeGcr, prior.recommendedMin),
    prior.recommendedMin,
    prior.recommendedMax,
  );

  const pitchAtSuggested = collectorWidthM / suggestedGcr;

  return {
    tilt: {
      min: 0,
      max: mount === "fixed_tilt" ? 60 : 0,
      recommendedMin: mount === "fixed_tilt" ? Math.max(0, suggestedTilt - 8) : 0,
      recommendedMax: mount === "fixed_tilt" ? Math.min(60, suggestedTilt + 8) : 0,
      suggested: suggestedTilt,
    },
    gcr: {
      min: prior.min,
      max: prior.max,
      recommendedMin: prior.recommendedMin,
      recommendedMax: prior.recommendedMax,
      suggested: round2(suggestedGcr),
    },
    pitch: {
      min: round2(collectorWidthM / prior.max),
      max: round2(collectorWidthM / prior.min),
      suggested: round2(pitchAtSuggested),
    },
    rationale,
  };
}

/**
 * Relative annual energy penalty from row-to-row shading at a given GCR.
 *
 * A first-order model, and labelled as such wherever it surfaces: the loss grows
 * with coverage and with the fraction of the year the sun sits below the
 * shading-free elevation. Real shading loss needs an hourly simulation with a
 * measured weather file, which is the sidecar's job; this exists to make the
 * energy-versus-density trade visible while dragging the GCR slider.
 */
export function firstOrderShadingLoss(
  gcr: number,
  tiltDegrees: number,
  latitude: number,
): { lossFraction: number; method: string } {
  const collectorWidth = 1; // Normalised: only the ratio matters here.
  const pitch = collectorWidth / Math.max(0.05, gcr);
  const tilt = toRadians(tiltDegrees);
  const height = collectorWidth * Math.sin(tilt);
  const projected = collectorWidth * Math.cos(tilt);

  // Sun elevation at which the shadow of one row just reaches the next.
  const clearance = Math.max(0.01, pitch - projected);
  const criticalElevation = toDegrees(Math.atan(height / clearance));

  // Fraction of daylight hours below that elevation, approximated from the
  // solstice noon altitude: the lower the sun ever gets, the more of the year
  // sits under the critical angle.
  const noonSummer = 90 - Math.abs(Math.abs(latitude) - 23.44);
  const shadedShare = clamp(criticalElevation / Math.max(1, noonSummer), 0, 1);

  // Beam irradiance is weak at low elevations, so only part of the shaded share
  // translates into lost energy. 0.35 is a conservative coupling factor.
  const lossFraction = clamp(shadedShare * 0.35, 0, 0.35);

  return {
    lossFraction,
    method:
      "First-order row-shading estimate from shadow geometry and solstice sun altitude. " +
      "Run the solar engine with a measured weather file for a modelled figure.",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
