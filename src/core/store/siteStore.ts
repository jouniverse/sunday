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
import type { MountType } from "@/domain/packing/priors";
import type { Nudge } from "@/domain/siting/nudges";
import type { ZonalStats } from "../platform";

export type SiteKind = "point" | "area" | "rooftop";

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

export interface Site {
  id: string;
  name: string;
  kind: SiteKind;
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
  design?: DesignParameters;
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
  renameSite: (id: string, name: string) => void;
  removeSite: (id: string) => void;
  selectSite: (id: string | null) => void;
  setResource: (id: string, resource: SiteResource) => void;
  setTerrain: (id: string, terrain: SiteTerrain) => void;
  setDesign: (id: string, design: DesignParameters) => void;
  patchDesign: (id: string, patch: Partial<DesignParameters>) => void;
  setNudges: (id: string, nudges: Nudge[]) => void;
  setNotes: (id: string, notes: string) => void;
  replaceAll: (sites: Site[]) => void;
  clear: () => void;
  selectedSite: () => Site | null;
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

  renameSite: (id, name) =>
    set((state) => ({
      sites: state.sites.map((site) => (site.id === id ? { ...site, name } : site)),
    })),

  removeSite: (id) =>
    set((state) => ({
      sites: state.sites.filter((site) => site.id !== id),
      selectedSiteId: state.selectedSiteId === id ? null : state.selectedSiteId,
    })),

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
