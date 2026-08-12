#!/usr/bin/env node
/**
 * Bundles IRENA Insights country-card extras: employment, finance flows,
 * innovation patents, renewable energy balance chips.
 *
 * Usage: node scripts/data-pipeline/prepare-irena-country-extras.mjs
 */

import { createReadStream, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = resolve(root, "src/assets/data/insights");
const mirrorDir = resolve(root, "data/bundled/insights");
const base = resolve(root, "notes/datasets/insights-view/irena/irena-sunday-app");

const ALIASES = {
  "united states": "USA",
  "united states of america": "USA",
  "united kingdom": "GBR",
  "south korea": "KOR",
  "korea, republic of": "KOR",
  "republic of korea": "KOR",
  russia: "RUS",
  "russian federation": "RUS",
  vietnam: "VNM",
  "viet nam": "VNM",
  iran: "IRN",
  "iran (islamic republic of)": "IRN",
  bolivia: "BOL",
  tanzania: "TZA",
  "czech republic": "CZE",
  czechia: "CZE",
  "cote d'ivoire": "CIV",
  "côte d'ivoire": "CIV",
  "democratic republic of the congo": "COD",
  "congo, dem. rep.": "COD",
  "laos": "LAO",
  "lao people's democratic republic": "LAO",
  myanmar: "MMR",
  taiwan: "TWN",
  syria: "SYR",
  venezuela: "VEN",
  "bosnia and herzegovina": "BIH",
  "north macedonia": "MKD",
  "cabo verde": "CPV",
  "cape verde": "CPV",
};

function buildNameMap() {
  const rankings = JSON.parse(
    readFileSync(resolve(root, "src/assets/data/country-rankings.json"), "utf8"),
  );
  const map = new Map();
  for (const row of rankings.countries) {
    map.set(row.name.toLowerCase(), row.iso3);
    const bare = row.name.replace(/\s*\(.*?\)\s*/g, "").trim().toLowerCase();
    if (bare) map.set(bare, row.iso3);
  }
  for (const [alias, iso3] of Object.entries(ALIASES)) map.set(alias, iso3);
  return map;
}

async function readCsv(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let headers = null;
  const rows = [];
  let pending = "";
  for await (const line of rl) {
    pending = pending ? `${pending}\n${line}` : line;
    if (((pending.match(/"/g) || []).length) % 2 === 1) continue;
    const fields = parseCsvLine(pending);
    pending = "";
    if (!headers) {
      headers = fields.map((h) => h.trim());
      continue;
    }
    rows.push(Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ""])));
  }
  return rows;
}

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
      } else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else current += ch;
  }
  fields.push(current);
  return fields;
}

function iso3For(nameMap, name) {
  const key = String(name ?? "").trim().toLowerCase();
  return nameMap.get(key) ?? null;
}

const nameMap = buildNameMap();

// --- Employment 2024 ---
const employmentRaw = await readCsv(resolve(base, "irena-solar-employment.csv"));
const employmentByIso = {};
for (const row of employmentRaw) {
  const iso3 = iso3For(nameMap, row["Country/area"]);
  if (!iso3) continue;
  const tech = String(row.Technology ?? "").trim();
  const jobsKey = Object.keys(row).find((k) => /jobs/i.test(k)) ?? " Jobs (thousand) ";
  const jobs = Number(String(row[jobsKey] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(jobs)) continue;
  const entry = employmentByIso[iso3] ?? { iso3, year: "2024", technologies: {} };
  entry.technologies[tech] = jobs;
  employmentByIso[iso3] = entry;
}

// --- Finance ---
const financeRaw = await readCsv(resolve(base, "irena-solar-finance-flows-preprocessed.csv"));
const financeByIso = {};
for (const row of financeRaw) {
  const iso3 = iso3For(nameMap, row.Country);
  if (!iso3) continue;
  const year = String(row.Year ?? "").trim();
  const amount = Number(String(row["Total Amount"] ?? "").replace(/,/g, ""));
  if (!year || !Number.isFinite(amount)) continue;
  const entry = financeByIso[iso3] ?? { iso3, series: [] };
  entry.series.push({ date: year, value: amount });
  financeByIso[iso3] = entry;
}
for (const entry of Object.values(financeByIso)) {
  entry.series.sort((a, b) => a.date.localeCompare(b.date));
}

// --- Innovation ---
const innovRaw = await readCsv(resolve(base, "irena-solar-innovation-and-technology.csv"));
const innovByIso = {};
for (const row of innovRaw) {
  if (String(row.Technology ?? "").trim() !== "Solar Energy") continue;
  const iso3 = iso3For(nameMap, row["Country/area"]);
  if (!iso3) continue;
  const year = String(row.Year ?? "").trim();
  const sector = String(row.Sector ?? "").trim();
  const sub = String(row.Subtechnology ?? "").trim();
  const patents = Number(String(row["Filed Patents"] ?? "").replace(/,/g, ""));
  if (!year || !sector || !sub || !Number.isFinite(patents)) continue;
  const entry = innovByIso[iso3] ?? { iso3, rows: [] };
  entry.rows.push({ date: year, sector, subtechnology: sub, value: patents });
  innovByIso[iso3] = entry;
}

// --- Balance chips (2023 Consumption Total) ---
const balanceRaw = await readCsv(resolve(base, "irena-solar-renewable-energy-balance.csv"));
const balanceByIso = {};
for (const row of balanceRaw) {
  if (String(row.Year ?? "").trim() !== "2023") continue;
  if (String(row["Main category"] ?? "").trim() !== "Consumption(Elect.& Heat)") continue;
  if (String(row["Sub Category"] ?? "").trim() !== "Total") continue;
  const tech = String(row["Technology/source"] ?? "").trim();
  if (tech !== "Solar PV" && tech !== "Solar Thermal") continue;
  const iso3 = iso3For(nameMap, row.Country);
  if (!iso3) continue;
  const value = Number(String(row.Value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(value)) continue;
  const entry = balanceByIso[iso3] ?? { iso3, year: "2023", solarPv: null, solarThermal: null };
  if (tech === "Solar PV") entry.solarPv = value;
  else entry.solarThermal = value;
  balanceByIso[iso3] = entry;
}

const payload = {
  source: "IRENA",
  vintage: "irena-sunday-app extracts",
  licence: "IRENA data terms",
  method:
    "Employment 2024 (thousand jobs); finance flows totals USD m (preprocessed); innovation filed patents (Solar Energy); RE balance 2023 Consumption Total for Solar PV / Solar Thermal.",
  employment: Object.values(employmentByIso),
  finance: Object.values(financeByIso),
  innovation: Object.values(innovByIso),
  balance: Object.values(balanceByIso),
};

await mkdir(outDir, { recursive: true });
await mkdir(mirrorDir, { recursive: true });
const json = JSON.stringify(payload);
await writeFile(resolve(outDir, "irena-country-extras.json"), json);
await writeFile(resolve(mirrorDir, "irena-country-extras.json"), json);
console.log(
  `Wrote irena-country-extras.json: employment=${payload.employment.length} finance=${payload.finance.length} innovation=${payload.innovation.length} balance=${payload.balance.length}`,
);
