import { describe, expect, it } from "vitest";
import { slopePercentToDegrees } from "../units";
import type { SiteFacts } from "./nudges";
import { evaluateSite, hasBlockingNudge, summariseNudges } from "./nudges";

/** A clean, unremarkable utility PV site: nothing should block it. */
const goodSite: SiteFacts = {
  areaM2: 800_000,
  latitude: 35,
  technology: "pv_fixed",
  meanSlopeDegrees: slopePercentToDegrees(1.5),
  aspectDegrees: 180,
  ghiKwhM2Year: 2000,
  gridDistanceKm: 4,
  inProtectedArea: false,
  landCover: "barren",
};

function ids(facts: SiteFacts): string[] {
  return evaluateSite(facts).map((nudge) => nudge.id);
}

describe("geometry", () => {
  it("blocks a self-intersecting boundary and stops there", () => {
    const nudges = evaluateSite({ ...goodSite, invalidGeometry: true });
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.id).toBe("geometry-invalid");
    expect(nudges[0]?.severity).toBe("blocking");
    // No point reporting slope or resource for a meaningless area.
    expect(nudges[0]?.action).toContain("crossing vertices");
  });

  it("blocks a site with no area", () => {
    expect(ids({ ...goodSite, areaM2: 0 })).toContain("area-zero");
  });

  it("cautions on a site too small for utility scale", () => {
    // 5 ha, well under the 20 ha screening minimum.
    expect(ids({ ...goodSite, areaM2: 50_000 })).toContain("area-small-for-utility");
  });

  it("does not apply the utility minimum to a rooftop", () => {
    expect(ids({ ...goodSite, areaM2: 120, technology: "rooftop" })).not.toContain(
      "area-small-for-utility",
    );
  });
});

describe("slope", () => {
  it("passes gentle terrain without comment", () => {
    const found = ids(goodSite);
    expect(found).not.toContain("slope-caution");
    expect(found).not.toContain("slope-blocking");
  });

  it("cautions above the fixed-tilt screening threshold", () => {
    expect(ids({ ...goodSite, meanSlopeDegrees: slopePercentToDegrees(8) })).toContain(
      "slope-caution",
    );
  });

  it("blocks genuinely steep ground", () => {
    expect(ids({ ...goodSite, meanSlopeDegrees: slopePercentToDegrees(20) })).toContain(
      "slope-blocking",
    );
  });

  it("holds trackers to a tighter limit than fixed racks", () => {
    const slope = { meanSlopeDegrees: slopePercentToDegrees(4) };
    // 4% is fine for a fixed rack but past the tracker threshold.
    expect(ids({ ...goodSite, ...slope, technology: "pv_fixed" })).not.toContain("slope-caution");
    expect(ids({ ...goodSite, ...slope, technology: "pv_tracker" })).toContain("slope-caution");
  });

  it("suggests a fixed rack when a tracker is the problem", () => {
    const nudges = evaluateSite({
      ...goodSite,
      technology: "pv_tracker",
      meanSlopeDegrees: slopePercentToDegrees(4),
    });
    const slopeNudge = nudges.find((n) => n.id === "slope-caution");
    expect(slopeNudge?.action).toContain("fixed-tilt");
  });

  it("holds CSP to the tightest limit of all", () => {
    const slope = { meanSlopeDegrees: slopePercentToDegrees(3) };
    expect(ids({ ...goodSite, ...slope, technology: "pv_fixed" })).not.toContain("slope-caution");
    expect(
      ids({ ...goodSite, ...slope, technology: "csp", dniKwhM2Year: 2400 }),
    ).toContain("slope-caution");
  });

  it("ignores slope for a rooftop, where pitch is a design input", () => {
    const found = ids({
      ...goodSite,
      technology: "rooftop",
      meanSlopeDegrees: slopePercentToDegrees(35),
    });
    expect(found).not.toContain("slope-caution");
    expect(found).not.toContain("slope-blocking");
  });

  it("says so when no elevation model has been sampled", () => {
    const facts = { ...goodSite };
    delete facts.meanSlopeDegrees;
    expect(ids(facts)).toContain("slope-unknown");
  });
});

describe("aspect", () => {
  it("cautions on a north-facing slope in the northern hemisphere", () => {
    expect(
      ids({ ...goodSite, meanSlopeDegrees: slopePercentToDegrees(6), aspectDegrees: 0 }),
    ).toContain("aspect-poleward");
  });

  it("accepts a south-facing slope in the northern hemisphere", () => {
    expect(
      ids({ ...goodSite, meanSlopeDegrees: slopePercentToDegrees(6), aspectDegrees: 180 }),
    ).not.toContain("aspect-poleward");
  });

  it("mirrors the rule in the southern hemisphere", () => {
    const southern = { ...goodSite, latitude: -33, meanSlopeDegrees: slopePercentToDegrees(6) };
    // South-facing is the bad direction below the equator.
    expect(ids({ ...southern, aspectDegrees: 180 })).toContain("aspect-poleward");
    expect(ids({ ...southern, aspectDegrees: 0 })).not.toContain("aspect-poleward");
  });

  it("ignores aspect on nearly flat ground", () => {
    // On a 1% slope the aspect is noise.
    expect(
      ids({ ...goodSite, meanSlopeDegrees: slopePercentToDegrees(1), aspectDegrees: 0 }),
    ).not.toContain("aspect-poleward");
  });
});

describe("solar resource", () => {
  it("cautions below the PV screening floor", () => {
    expect(ids({ ...goodSite, ghiKwhM2Year: 900 })).toContain("ghi-low");
  });

  it("notes a strong resource", () => {
    expect(ids({ ...goodSite, ghiKwhM2Year: 2100 })).toContain("ghi-strong");
  });

  it("says so when no resource has been sampled", () => {
    const facts = { ...goodSite };
    delete facts.ghiKwhM2Year;
    expect(ids(facts)).toContain("ghi-unknown");
  });

  it("judges CSP on direct normal irradiation, not global", () => {
    const csp: SiteFacts = {
      ...goodSite,
      technology: "csp",
      meanSlopeDegrees: slopePercentToDegrees(1),
      dniKwhM2Year: 2500,
    };
    const found = ids(csp);
    // A strong GHI note is irrelevant to a tower plant.
    expect(found).not.toContain("ghi-strong");
    expect(found).not.toContain("dni-too-low");
  });

  it("blocks CSP where direct sunlight is weak", () => {
    const nudges = evaluateSite({
      ...goodSite,
      technology: "csp",
      meanSlopeDegrees: slopePercentToDegrees(1),
      dniKwhM2Year: 1100,
    });
    const dni = nudges.find((n) => n.id === "dni-too-low");
    expect(dni?.severity).toBe("blocking");
    expect(dni?.action).toContain("photovoltaics");
  });

  it("cautions on marginal CSP resource", () => {
    expect(
      ids({
        ...goodSite,
        technology: "csp",
        meanSlopeDegrees: slopePercentToDegrees(1),
        dniKwhM2Year: 1700,
      }),
    ).toContain("dni-marginal");
  });
});

describe("land cover and designations", () => {
  it("blocks a protected area", () => {
    const nudges = evaluateSite({ ...goodSite, inProtectedArea: true });
    expect(nudges.find((n) => n.id === "protected-area")?.severity).toBe("blocking");
  });

  it("notes when protected areas data is not installed", () => {
    const nudges = evaluateSite({
      ...goodSite,
      protectedAreasAvailable: false,
      inProtectedArea: undefined,
    });
    expect(nudges.find((n) => n.id === "protected-areas-missing")?.severity).toBe("note");
    expect(nudges.find((n) => n.id === "protected-area")).toBeUndefined();
  });

  it("blocks water and wetland", () => {
    expect(ids({ ...goodSite, landCover: "water" })).toContain("land-water");
    expect(ids({ ...goodSite, landCover: "wetland" })).toContain("land-wetland");
  });

  it("cautions on forest and urban land", () => {
    expect(ids({ ...goodSite, landCover: "forest" })).toContain("land-forest");
    expect(ids({ ...goodSite, landCover: "urban" })).toContain("land-urban");
  });

  it("treats cropland as normal but flags the land-use question", () => {
    const nudges = evaluateSite({ ...goodSite, landCover: "cropland" });
    const cropland = nudges.find((n) => n.id === "land-cropland");
    expect(cropland?.severity).toBe("note");
    expect(cropland?.action).toContain("agrivoltaic");
  });

  it("suggests rooftop PV when the land is built up", () => {
    const nudges = evaluateSite({ ...goodSite, landCover: "urban" });
    expect(nudges.find((n) => n.id === "land-urban")?.action).toContain("rooftop");
  });
});

describe("grid proximity", () => {
  it("notes a close connection", () => {
    expect(ids({ ...goodSite, gridDistanceKm: 3 })).toContain("grid-close");
  });

  it("cautions at a material distance", () => {
    expect(ids({ ...goodSite, gridDistanceKm: 30 })).toContain("grid-far");
  });

  it("cautions harder when very far", () => {
    expect(ids({ ...goodSite, gridDistanceKm: 90 })).toContain("grid-very-far");
  });

  it("always disclaims hosting capacity", () => {
    // This is a hard requirement from the review: distance is not capacity.
    for (const distance of [2, 30, 90]) {
      const nudges = evaluateSite({ ...goodSite, gridDistanceKm: distance });
      const grid = nudges.find((n) => n.id.startsWith("grid-"));
      expect(grid?.detail).toContain("not a hosting-capacity");
    }
  });

  it("stays silent when no grid layer has been consulted", () => {
    const facts = { ...goodSite };
    delete facts.gridDistanceKm;
    expect(ids(facts).filter((id) => id.startsWith("grid-"))).toHaveLength(0);
  });
});

describe("brownfield context", () => {
  it("notes a nearby existing plant as precedent", () => {
    const nudges = evaluateSite({ ...goodSite, nearestPlantKm: 3 });
    const plant = nudges.find((n) => n.id === "existing-plant-nearby");
    expect(plant?.severity).toBe("note");
    expect(plant?.basis).toContain("Global Energy Monitor");
  });

  it("ignores a distant plant", () => {
    expect(ids({ ...goodSite, nearestPlantKm: 80 })).not.toContain("existing-plant-nearby");
  });
});

describe("ordering, basis and summary", () => {
  it("sorts blocking issues before cautions and notes", () => {
    const nudges = evaluateSite({
      ...goodSite,
      inProtectedArea: true,
      meanSlopeDegrees: slopePercentToDegrees(8),
      gridDistanceKm: 3,
    });
    const severities = nudges.map((n) => n.severity);
    expect(severities[0]).toBe("blocking");
    expect(severities.indexOf("caution")).toBeLessThan(severities.lastIndexOf("note"));
  });

  it("gives every nudge a stated basis", () => {
    const nudges = evaluateSite({
      ...goodSite,
      landCover: "cropland",
      meanSlopeDegrees: slopePercentToDegrees(8),
      gridDistanceKm: 40,
    });
    expect(nudges.length).toBeGreaterThan(2);
    for (const nudge of nudges) {
      expect(nudge.basis.length).toBeGreaterThan(0);
      expect(nudge.title.length).toBeGreaterThan(0);
      expect(nudge.detail.length).toBeGreaterThan(0);
    }
  });

  it("detects whether anything blocks development", () => {
    expect(hasBlockingNudge(evaluateSite(goodSite))).toBe(false);
    expect(hasBlockingNudge(evaluateSite({ ...goodSite, inProtectedArea: true }))).toBe(true);
  });

  it("summarises to a verdict and always carries the disclaimer", () => {
    const clean = summariseNudges(evaluateSite(goodSite));
    expect(clean.blocking).toBe(0);
    expect(clean.verdict).toBe("no_obstacles_found");
    expect(clean.disclaimer).toContain("Screening only");

    const careful = summariseNudges(
      evaluateSite({ ...goodSite, meanSlopeDegrees: slopePercentToDegrees(8) }),
    );
    expect(careful.verdict).toBe("proceed_with_care");

    const blocked = summariseNudges(evaluateSite({ ...goodSite, inProtectedArea: true }));
    expect(blocked.verdict).toBe("not_developable");
  });
});
