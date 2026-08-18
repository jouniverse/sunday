/**
 * Sites, designs and their computed results.
 *
 * A *site* is a place the user has marked: a point, or a drawn boundary. A
 * *design* is a system proposed for that site. Results are cached on the site so
 * switching between sites does not re-fetch, and every cached result carries the
 * provenance of how it was produced.
 */

import { create } from "zustand";
import type { LngLat } from "@/domain/geometry";
import {
  geodesicPerimeterM,
  geodesicPolygonAreaM2,
  isSimpleRing,
  ringCentroid,
} from "@/domain/geometry";
import type { CspParameters } from "@/domain/csp/types";
import type { MountType } from "@/domain/packing/priors";
import type { Nudge, TechnologyProfile } from "@/domain/siting/nudges";
import type { ZonalStats } from "../platform";

export type SiteKind = "point" | "area" | "rooftop";

/** Plant family for Design routing — independent of screening technology chips. */
export type SystemFamily = "pv-greenfield" | "pv-rooftop" | "csp";

export function systemFamilyOf(site: Pick<Site, "kind" | "systemFamily">): SystemFamily {
  if (site.systemFamily) return site.systemFamily;
  if (site.kind === "rooftop") return "pv-rooftop";
  return "pv-greenfield";
}

/** Screening chip — independent of Design-view systemFamily. */
export function screeningTechnologyOf(
  site: Pick<Site, "kind" | "screeningTechnology">,
): TechnologyProfile {
  if (site.screeningTechnology) return site.screeningTechnology;
  return site.kind === "rooftop" ? "rooftop" : "pv_fixed";
}

export interface SiteResource {
  /** Annual global horizontal irradiation, kWh/m²/year. */
  ghiKwhM2Year?: number;
  dniKwhM2Year?: number;
  diffuseKwhM2Year?: number;
  /** Optimal tilt reported by whichever source provided it. */
  optimalTiltDegrees?: number;
  meanAirTempC?: number;
  source: string;
  vintage?: string;
  fidelity: "measured" | "modelled" | "estimated" | "unknown";
  method: string;
}

export interface SiteTerrain {
  meanSlopeDegrees?: number;
  maxSlopeDegrees?: number;
  aspectDegrees?: number;
  meanElevationM?: number;
  source: string;
  /** Raster statistics behind the numbers, when a DEM was sampled. */
  stats?: ZonalStats;
}

export interface DesignParameters {
  moduleId: string;
  mount: MountType;
  tiltDegrees: number;
  azimuthDegrees: number;
  groundCoverageRatio: number;
  /** Fraction of the site lost to roads, pads and margins. */
  balanceOfSystemFraction: number;
  systemLosses: number;
}

/** A named design revision under a site (projects → sites → designs). */
export interface SavedDesign {
  id: string;
  name: string;
  updatedAt: string;
  kind: "greenfield" | "rooftop" | "csp-tower" | "csp-trough";
  /** PV parameters — omitted on CSP saves so they do not overwrite `site.design`. */
  parameters?: DesignParameters;
  cspParameters?: CspParameters;
  capacityKwDc?: number;
  /** CSP gross rating, MWₑ. */
  capacityMwe?: number;
  annualKwh?: number;
  /** Google Solar: how many preferred panels were taken. */
  googlePanelCount?: number;
  /** Google Solar: zero-based indices of inactive panels among the shown set. */
  inactivePanelIndices?: number[];
  /** Local rooftop packing: zero-based indices of inactive modules in the packed array. */
  inactiveLocalModuleIndices?: number[];
  /** Rooftop packer orientation; Google layouts ignore this until insights are cleared. */
  rooftopOrientation?: "portrait" | "landscape";
  rooftopSetbackM?: number;
  notes?: string;
}

export interface Site {
  id: string;
  name: string;
  kind: SiteKind;
  /** Persisted Design-view family. Independent of screening technology. */
  systemFamily?: SystemFamily;
  /** Persisted Screening-section technology chip. Independent of systemFamily. */
  screeningTechnology?: TechnologyProfile;
  /** Working CSP parameters (mirrors the active CSP saved design when selected). */
  cspDesign?: CspParameters;
  /** Boundary ring for an area or rooftop; null for a point. */
  ring: LngLat[] | null;
  /** Representative point: the marker for a point site, the centroid otherwise. */
  centre: LngLat;
  createdAt: string;
  areaM2: number;
  perimeterM: number;
  geometryValid: boolean;
  resource?: SiteResource;
  terrain?: SiteTerrain;
  /** Working design parameters (mirrors the active saved design when one is selected). */
  design?: DesignParameters;
  /** Named designs saved for this site. */
  designs?: SavedDesign[];
  activeDesignId?: string | null;
  nudges: Nudge[];
  notes: string;
}

interface SiteState {
  sites: Site[];
  selectedSiteId: string | null;

  addPointSite: (point: LngLat, name?: string) => string;
  addAreaSite: (ring: LngLat[], name?: string, kind?: SiteKind) => string;
  updateSiteRing: (id: string, ring: LngLat[]) => void;
  setKind: (id: string, kind: SiteKind) => void;
  setSystemFamily: (id: string, family: SystemFamily) => void;
  setScreeningTechnology: (id: string, technology: TechnologyProfile) => void;
  setCspDesign: (id: string, design: CspParameters) => void;
  renameSite: (id: string, name: string) => void;
  removeSite: (id: string) => void;
  selectSite: (id: string | null) => void;
  setResource: (id: string, resource: SiteResource) => void;
  setTerrain: (id: string, terrain: SiteTerrain) => void;
  setDesign: (id: string, design: DesignParameters) => void;
  patchDesign: (id: string, patch: Partial<DesignParameters>) => void;
  /** Upserts a named design and sets it active (also updates `design`). */
  saveNamedDesign: (siteId: string, design: SavedDesign) => void;
  /** Renames a saved design without changing its parameters. */
  renameDesign: (siteId: string, designId: string, name: string) => void;
  selectDesign: (siteId: string, designId: string | null) => void;
  deleteDesign: (siteId: string, designId: string) => void;
  setNudges: (id: string, nudges: Nudge[]) => void;
  setNotes: (id: string, notes: string) => void;
  replaceAll: (sites: Site[]) => void;
  clear: () => void;
  selectedSite: () => Site | null;
}

let designCounter = 0;

export function newDesignId(): string {
  designCounter += 1;
  return `design-${Date.now().toString(36)}-${designCounter}`;
}

let siteCounter = 0;

/** Derives the geometry fields that everything downstream depends on. */
function geometryOf(
  ring: LngLat[],
): Pick<Site, "areaM2" | "perimeterM" | "geometryValid" | "centre"> {
  const closed = ring.length > 0 && ring[0] !== undefined ? [...ring, ring[0] as LngLat] : ring;
  const valid = ring.length >= 3 && isSimpleRing(closed);
  return {
    // A self-intersecting ring has no meaningful area, so report zero rather than
    // a number that looks plausible and is not.
    areaM2: valid ? geodesicPolygonAreaM2([closed]) : 0,
    perimeterM: ring.length >= 2 ? geodesicPerimeterM(closed) : 0,
    geometryValid: valid,
    centre: ring.length > 0 ? ringCentroid(closed) : [0, 0],
  };
}

export const useSiteStore = create<SiteState>((set, get) => ({
  sites: [],
  selectedSiteId: null,

  addPointSite: (point, name) => {
    siteCounter += 1;
    const id = `site-${siteCounter}`;
    const site: Site = {
      id,
      name: name ?? `Location ${siteCounter}`,
      kind: "point",
      ring: null,
      centre: point,
      createdAt: new Date().toISOString(),
      areaM2: 0,
      perimeterM: 0,
      geometryValid: true,
      nudges: [],
      notes: "",
    };
    set((state) => ({ sites: [...state.sites, site], selectedSiteId: id }));
    return id;
  },

  addAreaSite: (ring, name, kind = "area") => {
    siteCounter += 1;
    const id = `site-${siteCounter}`;
    const site: Site = {
      id,
      name: name ?? `${kind === "rooftop" ? "Roof" : "Site"} ${siteCounter}`,
      kind,
      ring,
      createdAt: new Date().toISOString(),
      nudges: [],
      notes: "",
      ...geometryOf(ring),
    };
    set((state) => ({ sites: [...state.sites, site], selectedSiteId: id }));
    return id;
  },

  updateSiteRing: (id, ring) =>
    set((state) => ({
      sites: state.sites.map((site) =>
        site.id === id ? { ...site, ring, ...geometryOf(ring) } : site,
      ),
    })),

  setKind: (id, kind) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, kind } : site)),
    })),

  setSystemFamily: (id, family) =>
    set((state) => ({
      sites: state.sites.map((site) => {
        if (site.id !== id) return site;
        let kind = site.kind;
        if (family === "pv-rooftop") {
          kind = "rooftop";
        } else if (
          (family === "pv-greenfield" || family === "csp") &&
          site.kind === "rooftop" &&
          site.ring &&
          site.geometryValid
        ) {
          kind = "area";
        }
        return { ...site, systemFamily: family, kind };
      }),
    })),

  setScreeningTechnology: (id, technology) =>
    set((state) => ({
      sites: state.sites.map((site) =>
        site.id === id ? { ...site, screeningTechnology: technology } : site,
      ),
    })),

  setCspDesign: (id, design) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, cspDesign: design } : site)),
    })),

  renameSite: (id, name) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, name } : site)),
    })),

  removeSite: (id) =>
    set((state) => {
      const sites = state.sites.filter((site) => site.id !== id);
      let selectedSiteId = state.selectedSiteId;
      if (selectedSiteId === id) {
        // Prefer the neighbour that followed the deleted site, else the previous one.
        const index = state.sites.findIndex((site) => site.id === id);
        selectedSiteId = sites[Math.min(index, sites.length - 1)]?.id ?? null;
      }
      return { sites, selectedSiteId };
    }),

  selectSite: (id) => set({ selectedSiteId: id }),

  setResource: (id, resource) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, resource } : site)),
    })),

  setTerrain: (id, terrain) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, terrain } : site)),
    })),

  setDesign: (id, design) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, design } : site)),
    })),

  patchDesign: (id, patch) =>
    set((state) => ({
      sites: state.sites.map((site) =>
        site.id === id && site.design ? { ...site, design: { ...site.design, ...patch } } : site,
      ),
    })),

  saveNamedDesign: (siteId, design) =>
    set((state) => ({
      sites: state.sites.map((site) => {
        if (site.id !== siteId) return site;
        const designs = [...(site.designs ?? [])];
        const index = designs.findIndex((entry) => entry.id === design.id);
        if (index >= 0) designs[index] = design;
        else designs.push(design);
        const isCsp = design.kind === "csp-tower" || design.kind === "csp-trough";
        return {
          ...site,
          designs,
          activeDesignId: design.id,
          design: isCsp ? site.design : (design.parameters ?? site.design),
          cspDesign: isCsp ? (design.cspParameters ?? site.cspDesign) : site.cspDesign,
        };
      }),
    })),

  renameDesign: (siteId, designId, name) =>
    set((state) => ({
      sites: state.sites.map((site) => {
        if (site.id !== siteId) return site;
        const trimmed = name.trim();
        if (!trimmed) return site;
        const designs = (site.designs ?? []).map((entry) =>
          entry.id === designId ? { ...entry, name: trimmed, updatedAt: new Date().toISOString() } : entry,
        );
        return { ...site, designs };
      }),
    })),

  selectDesign: (siteId, designId) =>
    set((state) => ({
      sites: state.sites.map((site) => {
        if (site.id !== siteId) return site;
        if (!designId) return { ...site, activeDesignId: null };
        const selected = (site.designs ?? []).find((entry) => entry.id === designId);
        if (!selected) return site;
        const isCsp = selected.kind === "csp-tower" || selected.kind === "csp-trough";
        return {
          ...site,
          activeDesignId: designId,
          design: isCsp ? site.design : (selected.parameters ?? site.design),
          cspDesign: isCsp ? (selected.cspParameters ?? site.cspDesign) : site.cspDesign,
        };
      }),
    })),

  deleteDesign: (siteId, designId) =>
    set((state) => ({
      sites: state.sites.map((site) => {
        if (site.id !== siteId) return site;
        const designs = (site.designs ?? []).filter((entry) => entry.id !== designId);
        const activeDesignId =
          site.activeDesignId === designId ? (designs[0]?.id ?? null) : site.activeDesignId;
        const active = designs.find((entry) => entry.id === activeDesignId);
        return {
          ...site,
          designs,
          activeDesignId,
          design: active?.parameters ?? site.design,
        };
      }),
    })),

  setNudges: (id, nudges) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, nudges } : site)),
    })),

  setNotes: (id, notes) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, notes } : site)),
    })),

  replaceAll: (sites) => {
    // Keep the counter ahead of loaded ids so a new site cannot collide.
    for (const site of sites) {
      const parsed = Number.parseInt(site.id.replace(/\D/g, ""), 10);
      if (Number.isFinite(parsed) && parsed > siteCounter) siteCounter = parsed;
    }
    set({ sites, selectedSiteId: sites[0]?.id ?? null });
  },

  clear: () => set({ sites: [], selectedSiteId: null }),

  selectedSite: () => {
    const { sites, selectedSiteId } = get();
    return sites.find((site) => site.id === selectedSiteId) ?? null;
  },
}));
