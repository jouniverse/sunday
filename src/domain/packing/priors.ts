/**
 * Empirical design priors.
 *
 * These numbers are what the automation uses to propose a feasible envelope
 * before the user touches anything. They come from the reviewed literature and
 * datasets rather than from intuition, and each one records its source. An
 * unsourced constant in an engineering tool is a liability.
 */

export type MountType = "fixed_tilt" | "single_axis" | "dual_axis";

export interface GcrPrior {
  /** Hard feasible bounds. Outside these the layout is not buildable. */
  min: number;
  max: number;
  /** Recommended band; the envelope the designer is nudged to stay inside. */
  recommendedMin: number;
  recommendedMax: number;
  typical: number;
  source: string;
}

/**
 * Ground coverage ratio: collector width (module face up-slope) divided by row
 * pitch — the PVWatts / SAM convention, not module area ÷ whole site area.
 *
 * Ranges follow the distribution of GCR1/GCR2 observed across ~19,000 US
 * ground-mounted arrays in GM-SEUS v2.0, which is the largest measured sample
 * available to us. Fixed-tilt arrays pack more densely than trackers because a
 * tracker needs clearance to rotate without shading its neighbour.
 */
export const GCR_PRIORS: Record<MountType, GcrPrior> = {
  fixed_tilt: {
    min: 0.2,
    max: 0.75,
    recommendedMin: 0.4,
    recommendedMax: 0.55,
    typical: 0.47,
    source: "GM-SEUS v2.0 fixed-tilt array distribution",
  },
  single_axis: {
    min: 0.15,
    max: 0.6,
    recommendedMin: 0.28,
    recommendedMax: 0.4,
    typical: 0.33,
    source: "GM-SEUS v2.0 single-axis tracker array distribution",
  },
  dual_axis: {
    min: 0.1,
    max: 0.4,
    recommendedMin: 0.15,
    recommendedMax: 0.25,
    typical: 0.2,
    source: "GM-SEUS v2.0 dual-axis array distribution (small sample)",
  },
};

/**
 * Land use per kW of DC capacity, m²/kW.
 *
 * Two different areas get called "land use" and conflating them is a classic
 * source of wrong numbers, so both are kept explicit:
 *
 * - **Direct impact area** is the array block itself — the rows, their spacing
 *   and immediate margins. This is what a drawn site polygon approximates, and
 *   it is what Sunday computes.
 * - **Total project area** additionally includes access roads, substation and
 *   inverter pads, perimeter setbacks and undeveloped land inside the fence. It
 *   is roughly 2 to 3 times the direct impact area, and it is what the familiar
 *   5–10 acres/MW rule of thumb actually refers to (20–40 m²/kW).
 *
 * The direct-impact range below is wider at the low end than older surveys
 * suggest because module efficiency has risen: a 200 W/m² module at a coverage
 * ratio of 0.45 reaches roughly 12 m²/kW, where a 150 W/m² module of a decade
 * ago needed about 16.
 */
export const LAND_USE_M2_PER_KW = {
  /** Direct impact (array block) area, which is what Sunday computes. */
  directMin: 8,
  directTypical: 13,
  directMax: 20,
  /** Total project area, for reporting alongside. */
  totalMin: 20,
  totalMax: 45,
  /** Total project area divided by direct impact area, fixed-tilt PV. */
  totalToDirectRatio: 2.5,
  source: "NREL land-use surveys of operating US PV plants; 5–10 acres/MW industry rule",
} as const;

/**
 * Minimum practical site area for a utility-scale project, m².
 * Industrial screening studies commonly discard contiguous parcels below 20 ha.
 */
export const MIN_UTILITY_SITE_M2 = 200_000;

export interface ModuleSpec {
  id: string;
  name: string;
  /** Rated DC power at standard test conditions, W. */
  ratedPowerW: number;
  /** Long edge, m. */
  lengthM: number;
  /** Short edge, m. */
  widthM: number;
  /** Module conversion efficiency at STC, as a fraction. */
  efficiency: number;
  /** Power temperature coefficient, fraction per °C. Always negative. */
  gammaPdc: number;
  bifacial: boolean;
  technology: "mono_perc" | "topcon" | "hjt" | "thin_film";
}

/**
 * A small, representative module library.
 *
 * These are generic classes rather than specific manufacturer parts, sized from
 * current mainstream product dimensions. The user supplies real datasheet values
 * for real work; these exist so a first estimate is never blocked on data entry.
 */
export const MODULE_LIBRARY: ModuleSpec[] = [
  {
    id: "mono-450",
    name: "Monocrystalline 450 W",
    ratedPowerW: 450,
    lengthM: 2.1,
    widthM: 1.05,
    efficiency: 0.204,
    gammaPdc: -0.0035,
    bifacial: false,
    technology: "mono_perc",
  },
  {
    id: "bifacial-500",
    name: "Bifacial 500 W",
    ratedPowerW: 500,
    lengthM: 2.28,
    widthM: 1.13,
    efficiency: 0.194,
    gammaPdc: -0.003,
    bifacial: true,
    technology: "topcon",
  },
  {
    id: "topcon-620",
    name: "TOPCon 620 W (utility)",
    ratedPowerW: 620,
    lengthM: 2.38,
    widthM: 1.3,
    efficiency: 0.2,
    gammaPdc: -0.0029,
    bifacial: true,
    technology: "topcon",
  },
  {
    id: "thin-film-380",
    name: "Thin-film 380 W",
    ratedPowerW: 380,
    lengthM: 2.0,
    widthM: 1.23,
    efficiency: 0.154,
    gammaPdc: -0.0028,
    bifacial: false,
    technology: "thin_film",
  },
];

export function moduleById(id: string): ModuleSpec | undefined {
  return MODULE_LIBRARY.find((module) => module.id === id);
}

/**
 * Rooftop packing constraints, metres.
 *
 * Fire-service setbacks and access pathways vary by jurisdiction; these defaults
 * follow the widely adopted IFC/NFPA pattern of a perimeter setback plus ridge
 * clearance, and are exposed in the UI precisely because they are local rules.
 */
export const ROOFTOP_DEFAULTS = {
  perimeterSetbackM: 0.5,
  ridgeSetbackM: 0.45,
  obstacleClearanceM: 0.3,
  /** Gap between modules for mounting hardware and thermal expansion. */
  moduleGapM: 0.02,
  source: "IFC 1204 / NFPA 1 rooftop access and setback pattern",
} as const;

/**
 * Total system losses beyond the DC/AC conversion chain, as fractions.
 *
 * Broken out because a single opaque "14% losses" figure hides which assumption
 * a user should challenge for their own site.
 */
export const SYSTEM_LOSS_DEFAULTS = {
  soiling: 0.02,
  mismatch: 0.02,
  wiringDc: 0.015,
  wiringAc: 0.01,
  transformer: 0.01,
  availability: 0.03,
  source: "NREL PVWatts v8 default loss stack",
} as const;

/** Sum of the default loss stack, as a single derate fraction. */
export function defaultSystemLosses(): number {
  const { soiling, mismatch, wiringDc, wiringAc, transformer, availability } =
    SYSTEM_LOSS_DEFAULTS;
  // Losses compound rather than add: 2% then 2% is 3.96%, not 4%.
  const retained = [soiling, mismatch, wiringDc, wiringAc, transformer, availability].reduce(
    (product, loss) => product * (1 - loss),
    1,
  );
  return 1 - retained;
}
