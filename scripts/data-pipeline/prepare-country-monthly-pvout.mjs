#!/usr/bin/env node
/**
 * Bundles Solargis monthly PVOUT country profiles for Insights Rankings.
 *
 * Usage: node scripts/data-pipeline/prepare-country-monthly-pvout.mjs
 */

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const input = resolve(
  root,
  "notes/datasets/insights-view/solargis/pv-potential-monthly.csv",
);
const outPath = resolve(root, "src/assets/data/country-monthly-pvout.json");
const mirrorPath = resolve(root, "data/bundled/country-monthly-pvout.json");

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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

const raw = await readCsv(input);
const countries = raw.map((row) => {
  const monthly = MONTHS.map((month) => {
    const v = Number(String(row[month] ?? "").replace(/,/g, ""));
    return Number.isFinite(v) ? v : null;
  });
  const yearly = Number(String(row.Yearly ?? "").replace(/,/g, ""));
  return {
    iso3: (row.ISO_A3 ?? "").trim().toUpperCase(),
    name: (row["Country or region"] ?? "").trim(),
    region: (row["World Bank Region"] ?? "").trim() || null,
    yearlyKwhKwpDay: Number.isFinite(yearly) ? yearly : null,
    monthlyKwhKwpDay: monthly,
  };
});

const payload = {
  source: "Global Solar Atlas / Solargis, World Bank ESMAP",
  vintage: "2020",
  licence: "CC BY 4.0",
  method: "Monthly practical PVOUT (kWh/kWp/day) country averages.",
  unit: "kWh/kWp/day",
  months: MONTHS,
  countries: countries.filter((c) => c.iso3.length === 3),
};

await mkdir(dirname(outPath), { recursive: true });
await mkdir(dirname(mirrorPath), { recursive: true });
const json = JSON.stringify(payload);
await writeFile(outPath, json);
await writeFile(mirrorPath, json);
console.log(`Wrote country-monthly-pvout.json: ${payload.countries.length} countries`);
