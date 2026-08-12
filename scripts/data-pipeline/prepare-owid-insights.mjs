#!/usr/bin/env node
/**
 * Bundles OWID solar CSVs for Insights Statistics (primary-energy share,
 * generation TWh fallback, electricity share fallback).
 *
 * Usage: node scripts/data-pipeline/prepare-owid-insights.mjs
 */

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = resolve(root, "src/assets/data/insights");
const mirrorDir = resolve(root, "data/bundled/insights");

async function readCsv(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let headers = null;
  const rows = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else current += ch;
    }
    fields.push(current);
    if (!headers) {
      headers = fields;
      continue;
    }
    rows.push(Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ""])));
  }
  return rows;
}

function pack(rows, { indicatorId, unit, valueKey, method }) {
  const observations = [];
  for (const row of rows) {
    const code = (row.Code ?? "").trim();
    const year = (row.Year ?? "").trim();
    const raw = (row[valueKey] ?? "").trim();
    if (!code || !year || !raw) continue;
    // Keep a modern window so the shipped JSON stays small enough for Vite.
    if (Number(year) < 2000) continue;
    // Skip non-ISO3 aggregate codes like OWID_AFR for country choropleths;
    // keep World and ISO3 (3 letters).
    const isAggregate = code.length !== 3 || code.startsWith("OWID");
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    observations.push({
      indicatorId,
      entityIso3: code,
      entityName: (row.Entity ?? "").trim() || undefined,
      date: year,
      value,
      unit,
      method,
      source: "Our World in Data",
      vintage: "grapher export",
      license: "CC BY 4.0",
      isAggregate,
    });
  }
  return {
    source: "Our World in Data",
    vintage: "grapher export",
    licence: "CC BY 4.0",
    method,
    observations,
  };
}

const primary = await readCsv(
  resolve(
    root,
    "notes/datasets/insights-view/our-world-in-data/share-of-primary-energy-from-solar/share-of-primary-energy-from-solar.csv",
  ),
);
const generation = await readCsv(
  resolve(
    root,
    "notes/datasets/insights-view/our-world-in-data/electricity-generation-solar/electricity-generation-from-solar.csv",
  ),
);
const elecShare = await readCsv(
  resolve(
    root,
    "notes/datasets/insights-view/our-world-in-data/share-of-electricity-from-solar/share-of-electricity-generation-from-solar.csv",
  ),
);

const bundles = {
  "owid-primary-energy.json": pack(primary, {
    indicatorId: "owid_primary_energy_share",
    unit: "%",
    valueKey: "Solar",
    method: "OWID share of primary energy from solar (EI / Smil / EIA).",
  }),
  "owid-solar-generation.json": pack(generation, {
    indicatorId: "solar_generation_twh",
    unit: "TWh",
    valueKey: "Solar",
    method: "OWID electricity generation from solar (Ember-based); offline fallback for Ember.",
  }),
  "owid-electricity-share.json": pack(elecShare, {
    indicatorId: "solar_electricity_share",
    unit: "%",
    valueKey: "Solar",
    method: "OWID solar share of electricity (Ember-based); offline fallback for Ember.",
  }),
};

await mkdir(outDir, { recursive: true });
await mkdir(mirrorDir, { recursive: true });
for (const [name, data] of Object.entries(bundles)) {
  const json = JSON.stringify(data);
  await writeFile(resolve(outDir, name), json);
  await writeFile(resolve(mirrorDir, name), json);
  console.log(`Wrote ${name}: ${data.observations.length} observations`);
}
