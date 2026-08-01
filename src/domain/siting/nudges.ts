/**
 * Site-selection soft rules ("Phase A" of the site-selection review).
 *
 * This is deliberately not a suitability model. It is the vocabulary of hard
 * exclusions and soft criteria applied to a site the user has already drawn, so
 * that obvious problems surface immediately: too steep, facing the wrong way, not
 * enough sun, inside a protected area, far from the grid.
 *
 * Three severities, and the difference matters:
 *
 * - `blocking`  — a hard exclusion. The site is not developable as drawn.
 * - `caution`   — feasible but materially worse or costlier.
 * - `note`      — context worth knowing, no judgement implied.
 *
 * Nothing here is a substitute for geotechnical survey, cadastral research,
 * environmental assessment or a grid hosting-capacity study, and the exported
 * report says so.
 */

import { m2ToHectares, slopeDegreesToPercent } from "../units";
import { MIN_UTILITY_SITE_M2 } from "../packing/priors";

export type NudgeSeverity = "blocking" | "caution" | "note";

export type TechnologyProfile = "pv_fixed" | "pv_tracker" | "csp" | "rooftop";

export interface Nudge {
  id: string;
  severity: NudgeSeverity;
  title: string;
  detail: string;
  /** What the user can do about it. Empty for pure context. */
  action?: string;
  /** Where the threshold comes from, so a professional can argue with it. */
  basis: string;
}

export interface SiteFacts {
  areaM2: number;
  latitude: number;
  technology: TechnologyProfile;
  /** Mean terrain slope in degrees, when a DEM has been sampled. */
  meanSlopeDegrees?: number;
  maxSlopeDegrees?: number;
  /** Dominant aspect in degrees from north, when known. */
  aspectDegrees?: number;
  /** Annual global horizontal irradiation, kWh/m²/year. */
  ghiKwhM2Year?: number;
  /** Annual direct normal irradiation, kWh/m²/year. Decisive for CSP. */
  dniKwhM2Year?: number;
  /** Distance to the nearest mapped transmission line or substation, km. */
  gridDistanceKm?: number;
  /** Whether the site intersects a protected area (WDPA or equivalent). */
  inProtectedArea?: boolean;
  /** Dominant land cover class, when a LULC layer is loaded. */
  landCover?: "cropland" | "grassland" | "barren" | "forest" | "wetland" | "urban" | "water";
  /** Distance to the nearest known solar plant, km — brownfield context. */
  nearestPlantKm?: number;
  /** True when the drawn ring self-intersects; area is then meaningless. */
  invalidGeometry?: boolean;
}

/**
 * Slope limits as terrain slope in percent.
 *
 * Utility PV is commonly screened at 3-5%; grading beyond that costs real money
 * and single-axis trackers are less tolerant than fixed racks because a torque
 * tube must stay straight. CSP needs near-flat ground, around 2%, because
 * heliostat fields are surveyed to a plane.
 */
const SLOPE_LIMITS_PERCENT: Record<TechnologyProfile, { caution: number; blocking: number }> = {
  pv_fixed: { caution: 5, blocking: 15 },
  pv_tracker: { caution: 3, blocking: 10 },
  csp: { caution: 2.1, blocking: 4 },
  // A rooftop's pitch is a design input, not a screening constraint.
  rooftop: { caution: Number.POSITIVE_INFINITY, blocking: Number.POSITIVE_INFINITY },
};

/**
 * Resource floors, kWh/m²/year.
 *
 * These are economic screening thresholds rather than physical limits: PV works
 * at 900 kWh/m², it just competes badly against sites with 1,600. CSP is
 * different in kind — below roughly 1,800 kWh/m² of DNI a tower plant is not
 * built anywhere in the world.
 */
const RESOURCE_FLOORS = {
  pvGhiCaution: 1100,
  pvGhiNote: 1400,
  cspDniBlocking: 1600,
  cspDniCaution: 1800,
} as const;

/** Grid proximity bands, km. Distance only — never hosting capacity. */
const GRID_BANDS = { comfortable: 10, caution: 25, far: 50 } as const;

/**
 * Evaluates a drawn site and returns every applicable nudge, most severe first.
 */
export function evaluateSite(facts: SiteFacts): Nudge[] {
  const nudges: Nudge[] = [];

  if (facts.invalidGeometry) {
    nudges.push({
      id: "geometry-invalid",
      severity: "blocking",
      title: "Site boundary crosses itself",
      detail:
        "A self-intersecting outline has no well-defined area, so every figure derived " +
        "from it would be meaningless.",
      action: "Move or delete the crossing vertices until the outline is simple.",
      basis: "Simple-polygon requirement of the OGC geometry model",
    });
    // Nothing else can be trusted, so stop here.
    return nudges;
  }

  nudges.push(...areaNudges(facts));
  nudges.push(...slopeNudges(facts));
  nudges.push(...aspectNudges(facts));
  nudges.push(...resourceNudges(facts));
  nudges.push(...landNudges(facts));
  nudges.push(...gridNudges(facts));
  nudges.push(...contextNudges(facts));

  const order: Record<NudgeSeverity, number> = { blocking: 0, caution: 1, note: 2 };
  return nudges.sort((a, b) => order[a.severity] - order[b.severity]);
}

function areaNudges(facts: SiteFacts): Nudge[] {
  if (facts.areaM2 <= 0) {
    return [
      {
        id: "area-zero",
        severity: "blocking",
        title: "Site has no area",
        detail: "The outline encloses no ground, so no capacity can be placed.",
        action: "Draw a closed boundary with at least three distinct corners.",
        basis: "Geometric requirement",
      },
    ];
  }

  const isUtility = facts.technology !== "rooftop";
  if (isUtility && facts.areaM2 < MIN_UTILITY_SITE_M2) {
    return [
      {
        id: "area-small-for-utility",
        severity: "caution",
        title: "Small for a utility-scale project",
        detail:
          `At ${m2ToHectares(facts.areaM2).toFixed(1)} ha this site is below the ` +
          `${m2ToHectares(MIN_UTILITY_SITE_M2).toFixed(0)} ha minimum that industrial siting ` +
          "studies typically use, so fixed development costs will dominate.",
        action: "Extend the boundary, or design it as a distributed rather than utility system.",
        basis: "Minimum contiguous parcel size in published PV siting studies",
      },
    ];
  }
  return [];
}

function slopeNudges(facts: SiteFacts): Nudge[] {
  const slopeDegrees = facts.meanSlopeDegrees;
  if (slopeDegrees === undefined) {
    return [
      {
        id: "slope-unknown",
        severity: "note",
        title: "Terrain slope not sampled",
        detail:
          "No elevation model has been queried for this site, so grading risk is unassessed. " +
          "DEM slope sampling is not wired yet — toggling Terrain slope only flips the catalogue; " +
          "MapTiler terrain basemap is visual relief, not a site mean slope.",
        action:
          "Use a MapTiler terrain basemap for context, or wait for DEM zonal sampling (see terrain-analysis notes).",
        basis: "Missing input",
      },
    ];
  }

  const percent = slopeDegreesToPercent(slopeDegrees);
  const limits = SLOPE_LIMITS_PERCENT[facts.technology];
  const label = facts.technology === "csp" ? "heliostat field" : "array";

  if (percent >= limits.blocking) {
    return [
      {
        id: "slope-blocking",
        severity: "blocking",
        title: "Terrain too steep",
        detail:
          `Mean slope of ${percent.toFixed(1)}% exceeds the ${limits.blocking}% practical ` +
          `limit for a ${label}. Earthworks at this gradient change the project's character.`,
        action: "Choose flatter ground, or reduce the boundary to the gentler part of the site.",
        basis: "Slope thresholds from published PV and CSP siting literature",
      },
    ];
  }
  if (percent >= limits.caution) {
    return [
      {
        id: "slope-caution",
        severity: "caution",
        title: "Grading cost likely",
        detail:
          `Mean slope of ${percent.toFixed(1)}% is above the ${limits.caution}% screening ` +
          `threshold for a ${label}, so expect earthworks and higher foundation cost.`,
        action:
          facts.technology === "pv_tracker"
            ? "A fixed-tilt rack tolerates this gradient better than a tracker."
            : "Budget for grading, or look for flatter ground nearby.",
        basis: "Slope thresholds from published PV and CSP siting literature",
      },
    ];
  }
  return [];
}

function aspectNudges(facts: SiteFacts): Nudge[] {
  if (facts.aspectDegrees === undefined || facts.meanSlopeDegrees === undefined) return [];
  // On nearly flat ground aspect is noise, not information.
  if (slopeDegreesToPercent(facts.meanSlopeDegrees) < 2) return [];

  const northernHemisphere = facts.latitude >= 0;
  const aspect = ((facts.aspectDegrees % 360) + 360) % 360;
  // Poleward-facing slopes lose sun: north-facing in the north, south in the south.
  const facesPoleward = northernHemisphere ? aspect > 292.5 || aspect < 67.5 : aspect > 112.5 && aspect < 247.5;

  if (!facesPoleward) return [];
  return [
    {
      id: "aspect-poleward",
      severity: "caution",
      title: "Slope faces away from the sun",
      detail:
        `The site slopes towards ${aspect.toFixed(0)}°, away from the equator, which reduces ` +
        "incident irradiance and forces steeper racking to compensate.",
      action: "Prefer an equator-facing or level part of the site.",
      basis: "Aspect criterion in GIS-MCDA solar siting studies",
    },
  ];
}

function resourceNudges(facts: SiteFacts): Nudge[] {
  const nudges: Nudge[] = [];

  if (facts.technology === "csp") {
    if (facts.dniKwhM2Year === undefined) {
      nudges.push({
        id: "dni-unknown",
        severity: "note",
        title: "Direct normal irradiation unknown",
        detail:
          "CSP output depends almost entirely on DNI, and no DNI value has been sampled here.",
        action: "Load a DNI raster or fetch a resource report for this location.",
        basis: "Missing input",
      });
    } else if (facts.dniKwhM2Year < RESOURCE_FLOORS.cspDniBlocking) {
      nudges.push({
        id: "dni-too-low",
        severity: "blocking",
        title: "Direct sunlight too weak for CSP",
        detail:
          `DNI of ${facts.dniKwhM2Year.toFixed(0)} kWh/m²/year is far below the ` +
          `${RESOURCE_FLOORS.cspDniCaution} kWh/m²/year floor of operating tower plants. ` +
          "Concentrating optics cannot use diffuse light.",
        action: "Consider photovoltaics here, which do use diffuse light.",
        basis: "DNI range of operating CSP plants",
      });
    } else if (facts.dniKwhM2Year < RESOURCE_FLOORS.cspDniCaution) {
      nudges.push({
        id: "dni-marginal",
        severity: "caution",
        title: "Marginal direct sunlight for CSP",
        detail:
          `DNI of ${facts.dniKwhM2Year.toFixed(0)} kWh/m²/year is below the ` +
          `${RESOURCE_FLOORS.cspDniCaution} kWh/m²/year typical of built CSP.`,
        action: "Compare against a photovoltaic design for the same site.",
        basis: "DNI range of operating CSP plants",
      });
    }
    return nudges;
  }

  if (facts.ghiKwhM2Year === undefined) {
    nudges.push({
      id: "ghi-unknown",
      severity: "note",
      title: "Solar resource not sampled",
      detail:
        "No irradiation value has been read for this site, so yield is unconstrained. " +
        "Layer toggles do not sample rasters — use Fetch resource, or Sample site from Solargis COG in Design.",
      action: "Fetch resource in the inspector, or sample a Solargis COG from Design (Settings → raster path).",
      basis: "Missing input",
    });
    return nudges;
  }

  if (facts.ghiKwhM2Year < RESOURCE_FLOORS.pvGhiCaution) {
    nudges.push({
      id: "ghi-low",
      severity: "caution",
      title: "Weak solar resource",
      detail:
        `GHI of ${facts.ghiKwhM2Year.toFixed(0)} kWh/m²/year is below the ` +
        `${RESOURCE_FLOORS.pvGhiCaution} kWh/m²/year screening floor commonly applied to ` +
        "utility PV. The project can still work, but it competes poorly on cost.",
      action: "Compare the levelised cost against a sunnier candidate site.",
      basis: "GHI screening floors in published utility PV siting studies",
    });
  } else if (facts.ghiKwhM2Year >= RESOURCE_FLOORS.pvGhiNote) {
    nudges.push({
      id: "ghi-strong",
      severity: "note",
      title: "Strong solar resource",
      detail: `GHI of ${facts.ghiKwhM2Year.toFixed(0)} kWh/m²/year is well above the screening floor.`,
      basis: "GHI screening floors in published utility PV siting studies",
    });
  }
  return nudges;
}

function landNudges(facts: SiteFacts): Nudge[] {
  const nudges: Nudge[] = [];

  if (facts.inProtectedArea) {
    nudges.push({
      id: "protected-area",
      severity: "blocking",
      title: "Inside a protected area",
      detail:
        "The boundary intersects a designated protected area. These are a hard exclusion in " +
        "every siting framework, and consent is normally unobtainable.",
      action: "Move the site outside the designation, or confirm its category and rules.",
      basis: "WDPA-based hard exclusion, standard in siting practice",
    });
  }

  switch (facts.landCover) {
    case "water":
      nudges.push({
        id: "land-water",
        severity: "blocking",
        title: "Site is on water",
        detail: "Ground-mount construction is not possible here.",
        action: "Move the boundary onto land, or treat this as a floating PV study.",
        basis: "Land-cover hard exclusion",
      });
      break;
    case "wetland":
      nudges.push({
        id: "land-wetland",
        severity: "blocking",
        title: "Site is wetland",
        detail:
          "Wetlands are excluded in standard siting frameworks on both permitting and " +
          "geotechnical grounds.",
        action: "Move the boundary to drier ground.",
        basis: "Land-cover hard exclusion",
      });
      break;
    case "urban":
      nudges.push({
        id: "land-urban",
        severity: "caution",
        title: "Built-up land",
        detail:
          "Urban land is normally excluded for ground mount on cost and availability grounds.",
        action: "Consider rooftop or building-integrated PV for this location instead.",
        basis: "Land-cover exclusion with an urban buffer",
      });
      break;
    case "forest":
      nudges.push({
        id: "land-forest",
        severity: "caution",
        title: "Forested land",
        detail:
          "Clearing forest carries a carbon and permitting cost that can undo the project's " +
          "climate case.",
        action: "Prefer barren, grassland or already-disturbed ground.",
        basis: "Land-cover exclusion, stricter under an environmental weighting preset",
      });
      break;
    case "cropland":
      nudges.push({
        id: "land-cropland",
        severity: "note",
        title: "Agricultural land",
        detail:
          "Cropland is the most common location for PV installations by count, so this is " +
          "normal — but it raises a food-versus-energy land-use question and may need an " +
          "agrivoltaic design.",
        action: "Consider an agrivoltaic layout, which raises the rack and widens row spacing.",
        basis: "Land-cover distribution of PV installations in the reviewed inventories",
      });
      break;
    case "barren":
      nudges.push({
        id: "land-barren",
        severity: "note",
        title: "Barren or open land",
        detail: "The land-cover class with the fewest competing uses, and the one that dominates large PV.",
        basis: "Land-cover distribution of PV installations in the reviewed inventories",
      });
      break;
    default:
      break;
  }
  return nudges;
}

function gridNudges(facts: SiteFacts): Nudge[] {
  if (facts.gridDistanceKm === undefined) return [];

  const distance = facts.gridDistanceKm;
  // The disclaimer is attached to every grid nudge, without exception: OSM
  // distance says nothing about whether the network can accept the power.
  const disclaimer =
    "Distance to mapped infrastructure only. It is not a hosting-capacity or " +
    "interconnection assessment, and mapped coverage is incomplete.";

  if (distance > GRID_BANDS.far) {
    return [
      {
        id: "grid-very-far",
        severity: "caution",
        title: "Far from mapped grid infrastructure",
        detail: `Nearest mapped line or substation is ${distance.toFixed(1)} km away. ${disclaimer}`,
        action: "Check for unmapped local infrastructure, and price the connection route.",
        basis: "OpenStreetMap power infrastructure proximity",
      },
    ];
  }
  if (distance > GRID_BANDS.caution) {
    return [
      {
        id: "grid-far",
        severity: "caution",
        title: "Connection distance is material",
        detail: `Nearest mapped line or substation is ${distance.toFixed(1)} km away. ${disclaimer}`,
        action: "Include the connection in the cost estimate.",
        basis: "OpenStreetMap power infrastructure proximity",
      },
    ];
  }
  if (distance <= GRID_BANDS.comfortable) {
    return [
      {
        id: "grid-close",
        severity: "note",
        title: "Close to mapped grid infrastructure",
        detail: `Nearest mapped line or substation is ${distance.toFixed(1)} km away. ${disclaimer}`,
        basis: "OpenStreetMap power infrastructure proximity",
      },
    ];
  }
  return [];
}

function contextNudges(facts: SiteFacts): Nudge[] {
  if (facts.nearestPlantKm === undefined || facts.nearestPlantKm > 15) return [];
  return [
    {
      id: "existing-plant-nearby",
      severity: "note",
      title: "Existing solar plant nearby",
      detail:
        `A known plant sits ${facts.nearestPlantKm.toFixed(1)} km away. That is useful ` +
        "precedent for permitting and grid access, and a possible brownfield or expansion " +
        "opportunity.",
      basis: "Global Energy Monitor Global Solar Power Tracker",
    },
  ];
}

/** Whether any hard exclusion applies. */
export function hasBlockingNudge(nudges: Nudge[]): boolean {
  return nudges.some((nudge) => nudge.severity === "blocking");
}

export interface NudgeSummary {
  blocking: number;
  caution: number;
  note: number;
  verdict: "not_developable" | "proceed_with_care" | "no_obstacles_found";
  /** The standing disclaimer that must accompany any screening output. */
  disclaimer: string;
}

export function summariseNudges(nudges: Nudge[]): NudgeSummary {
  const blocking = nudges.filter((n) => n.severity === "blocking").length;
  const caution = nudges.filter((n) => n.severity === "caution").length;
  const note = nudges.filter((n) => n.severity === "note").length;

  return {
    blocking,
    caution,
    note,
    verdict:
      blocking > 0 ? "not_developable" : caution > 0 ? "proceed_with_care" : "no_obstacles_found",
    disclaimer:
      "Screening only. These checks do not replace geotechnical survey, cadastral and land " +
      "tenure research, environmental impact assessment, or a grid hosting-capacity study.",
  };
}
