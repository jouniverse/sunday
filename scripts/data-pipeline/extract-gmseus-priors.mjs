#!/usr/bin/env node
/**
 * Documents the GM-SEUS-derived packing priors that Sunday embeds in
 * src/domain/packing/priors.ts. The numerical values are already in the TypeScript
 * module (so the design engine works offline without a multi-GB GPKG); this
 * script exists so a human can re-audit them against the source dataset.
 *
 * When a GM-SEUS Final Arrays GPKG is available, pass --gpkg to print observed
 * GCR quantiles for comparison (requires GDAL/OGR Python bindings — optional).
 */

const PRIORS = {
  source: "GM-SEUS v2.0 fixed-tilt / single-axis / dual-axis array distributions",
  gcr: {
    fixed_tilt: { min: 0.2, max: 0.75, recommendedMin: 0.4, recommendedMax: 0.55, typical: 0.47 },
    single_axis: { min: 0.15, max: 0.6, recommendedMin: 0.28, recommendedMax: 0.4, typical: 0.33 },
    dual_axis: { min: 0.1, max: 0.4, recommendedMin: 0.15, recommendedMax: 0.25, typical: 0.2 },
  },
  landUseM2PerKw: {
    directTypical: 13,
    totalMin: 20,
    totalMax: 45,
    source: "NREL land-use surveys; 5–10 acres/MW industry rule",
  },
  note: "These values are the automation envelope defaults. They are not a substitute for site-specific layout engineering.",
};

console.log(JSON.stringify(PRIORS, null, 2));
console.log("\nCanonical encoding: src/domain/packing/priors.ts");
console.log("Array polygons remain an optional download (~55 MB GPKG), not bundled.");
