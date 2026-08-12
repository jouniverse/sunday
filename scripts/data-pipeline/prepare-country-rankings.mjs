#!/usr/bin/env node
/**
 * Converts the Global Solar Atlas country summary CSV into the compact JSON
 * Sunday ships with the app. Daily means are multiplied by 365 so every figure
 * in the UI uses the same annual units as the site report.
 *
 * Usage:
 *   node scripts/data-pipeline/prepare-country-rankings.mjs
 *   node scripts/data-pipeline/prepare-country-rankings.mjs --input path/to.csv
 */

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
const inputPath = resolve(
  root,
  inputIdx >= 0 && args[inputIdx + 1]
    ? args[inputIdx + 1]
    : "notes/datasets/solargis-solar-potential/pv-potential-summary-statistics.csv",
);

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function num(raw) {
  const text = (raw ?? "").trim();
  if (!text || /^(null|na|n\/a)$/i.test(text)) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

async function readRows(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let headers = null;
  const rows = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (!headers) {
      headers = fields;
      continue;
    }
    const row = Object.fromEntries(headers.map((header, i) => [header, fields[i] ?? ""]));
    rows.push(row);
  }
  return rows;
}

const raw = await readRows(inputPath);
const countries = [];

for (const row of raw) {
  const iso3 = (row.ISO_A3 ?? "").trim();
  const name = (row["Country or region"] ?? "").trim();
  if (!iso3 || !name) continue;

  const ghiDay = num(row["Average (T)"]);
  const pvoutDay = num(row["Average (P)"]);
  countries.push({
    iso3,
    name,
    region: (row["World Bank Region"] ?? "").trim() || null,
    ghiKwhM2Day: ghiDay,
    ghiKwhM2Year: ghiDay === null ? null : Math.round(ghiDay * 3650) / 10,
    pvoutKwhKwpDay: pvoutDay,
    pvoutKwhKwpYear: pvoutDay === null ? null : Math.round(pvoutDay * 3650) / 10,
    ghiMedianKwhM2Day: num(row["Median (T)"]),
    pvoutMedianKwhKwpDay: num(row["Median (P)"]),
    // Spatial distribution within the country (Summary statistics T / P columns).
    ghiDistributionKwhM2Day: [
      num(row["Minimum (T)"]),
      num(row["10th percentile (T)"]),
      num(row["25th Percentile (T)"]),
      ghiDay,
      num(row["Median (T)"]),
      num(row["75th Percentile (T)"]),
      num(row["90th percentile (T)"]),
      num(row["Maximum (T)"]),
    ],
    pvoutDistributionKwhKwpDay: [
      num(row["Minimum (P)"]),
      num(row["10th percentile (P)"]),
      num(row["25th Percentile (P)"]),
      pvoutDay,
      num(row["Median (P)"]),
      num(row["75th Percentile (P)"]),
      num(row["90th percentile (P)"]),
      num(row["Maximum (P)"]),
    ],
  });
}

const byPvout = [...countries]
  .filter((c) => c.pvoutKwhKwpYear !== null)
  .sort((a, b) => b.pvoutKwhKwpYear - a.pvoutKwhKwpYear);
byPvout.forEach((c, i) => {
  c.rankPvout = i + 1;
});
const byGhi = [...countries]
  .filter((c) => c.ghiKwhM2Year !== null)
  .sort((a, b) => b.ghiKwhM2Year - a.ghiKwhM2Year);
const ghiRank = new Map(byGhi.map((c, i) => [c.iso3, i + 1]));
for (const c of countries) c.rankGhi = ghiRank.get(c.iso3) ?? null;

const payload = {
  source: "Global Solar Atlas / Solargis, World Bank ESMAP",
  vintage: "2020",
  licence: "CC BY 4.0",
  method:
    "Country averages and spatial distributions from Global Solar Atlas summary statistics (T = theoretical GHI, P = practical PVOUT); daily means × 365 for annual ranking figures.",
  units: {
    ghiKwhM2Year: "kWh/m²/year",
    pvoutKwhKwpYear: "kWh/kWp/year",
    ghiDistributionKwhM2Day: "kWh/m²/day",
    pvoutDistributionKwhKwpDay: "kWh/kWp/day",
  },
  distributionLabels: [
    "Min",
    "10%",
    "25%",
    "Avg",
    "Med",
    "75%",
    "90%",
    "Max",
  ],
  countries,
};

const outputs = [
  resolve(root, "data/bundled/country-rankings.json"),
  resolve(root, "src/assets/data/country-rankings.json"),
];

for (const out of outputs) {
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`wrote ${out} (${countries.length} countries)`);
}
