#!/usr/bin/env node
/**
 * Aggregates IRENA solar capacity country CSV into annual GW observations
 * for Insights Statistics. Prefer this over live PxWeb at paint time.
 *
 * Usage: node scripts/data-pipeline/prepare-irena-capacity.mjs
 */

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const input = resolve(
  root,
  "notes/datasets/insights-view/irena/irena-sunday-app/irena-capacity-solar-country.csv",
);
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

const rows = await readCsv(input);
// Sum Electrical Capacity (MW) per ISO3 + Year across technologies.
const sums = new Map();
for (const row of rows) {
  const flow = (row.Flow ?? "").trim();
  if (!/capacity/i.test(flow)) continue;
  const iso3 = (row["ISO3 Code"] ?? "").trim().toUpperCase();
  const year = (row.Year ?? "").trim();
  const valueMw = Number(String(row.Value ?? "").replace(/,/g, ""));
  if (!iso3 || iso3.length !== 3 || !year || !Number.isFinite(valueMw)) continue;
  if (Number(year) < 2000) continue;
  const key = `${iso3}|${year}`;
  const prev = sums.get(key) ?? {
    iso3,
    year,
    name: (row.Country ?? "").trim(),
    mw: 0,
  };
  prev.mw += valueMw;
  sums.set(key, prev);
}

const observations = [...sums.values()].map((row) => ({
  indicatorId: "irena_capacity_gw",
  entityIso3: row.iso3,
  entityName: row.name || undefined,
  date: row.year,
  value: row.mw / 1000,
  unit: "GW",
  method: "IRENA electrical capacity (solar) summed across technologies; MW→GW.",
  source: "IRENA",
  vintage: "irena-sunday-app extract",
  license: "IRENA data terms",
  isAggregate: false,
}));

// Region + World aggregates for Insights "World / regions" scope.
const regionInput = resolve(
  root,
  "notes/datasets/insights-view/irena/irena-sunday-app/irena-capacity-solar-region.csv",
);
const globalInput = resolve(
  root,
  "notes/datasets/insights-view/irena/irena-sunday-app/irena-capacity-solar-global.csv",
);

function slugRegion(name) {
  return `REG_${String(name)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}`;
}

const regionRows = await readCsv(regionInput);
for (const row of regionRows) {
  const flow = (row.Flow ?? "").trim();
  if (!/capacity/i.test(flow)) continue;
  const year = (row.Year ?? "").trim();
  const valueMw = Number(String(row.Value ?? "").replace(/,/g, ""));
  const region = (row.Region ?? "").trim();
  if (!region || !year || !Number.isFinite(valueMw) || Number(year) < 2000) continue;
  observations.push({
    indicatorId: "irena_capacity_gw",
    entityIso3: slugRegion(region),
    entityName: region,
    date: year,
    value: valueMw / 1000,
    unit: "GW",
    method: "IRENA electrical capacity (solar) by region; MW→GW.",
    source: "IRENA",
    vintage: "irena-sunday-app extract",
    license: "IRENA data terms",
    isAggregate: true,
  });
}

const globalRows = await readCsv(globalInput);
for (const row of globalRows) {
  const flow = (row.Flow ?? "").trim();
  if (!/capacity/i.test(flow)) continue;
  const year = (row.Year ?? "").trim();
  const valueMw = Number(String(row.Value ?? "").replace(/,/g, ""));
  if (!year || !Number.isFinite(valueMw) || Number(year) < 2000) continue;
  observations.push({
    indicatorId: "irena_capacity_gw",
    entityIso3: "WLD",
    entityName: "World",
    date: year,
    value: valueMw / 1000,
    unit: "GW",
    method: "IRENA electrical capacity (solar) global; MW→GW.",
    source: "IRENA",
    vintage: "irena-sunday-app extract",
    license: "IRENA data terms",
    isAggregate: true,
  });
}

const payload = {
  source: "IRENA",
  vintage: "irena-sunday-app extract",
  licence: "IRENA data terms",
  method: "Annual solar electrical capacity by country, region, and world (GW).",
  observations,
};

await mkdir(outDir, { recursive: true });
await mkdir(mirrorDir, { recursive: true });
const json = JSON.stringify(payload);
await writeFile(resolve(outDir, "irena-capacity.json"), json);
await writeFile(resolve(mirrorDir, "irena-capacity.json"), json);
console.log(`Wrote irena-capacity.json: ${observations.length} observations`);
