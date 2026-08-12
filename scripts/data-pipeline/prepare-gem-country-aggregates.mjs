#!/usr/bin/env node
/**
 * Precomputes GEM utility solar operating capacity by country (GW).
 * Maps Country/Area names → ISO3 via country-rankings.json.
 *
 * Usage:
 *   node scripts/data-pipeline/prepare-gem-country-aggregates.mjs
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
const input =
  (inputIdx >= 0 && args[inputIdx + 1] && resolve(root, args[inputIdx + 1])) ||
  resolve(root, "notes/datasets/insights-view/gem/solar-power-plants-utility-scale-2-2026.csv");

const outDir = resolve(root, "src/assets/data/insights");
const mirrorDir = resolve(root, "data/bundled/insights");

const ALIASES = {
  "united states": "USA",
  "united states of america": "USA",
  "south korea": "KOR",
  "korea, republic of": "KOR",
  "republic of korea": "KOR",
  "north korea": "PRK",
  russia: "RUS",
  "russian federation": "RUS",
  vietnam: "VNM",
  "viet nam": "VNM",
  syria: "SYR",
  iran: "IRN",
  "iran, islamic republic of": "IRN",
  bolivia: "BOL",
  tanzania: "TZA",
  "czech republic": "CZE",
  czechia: "CZE",
  "united kingdom": "GBR",
  uk: "GBR",
  "cote d'ivoire": "CIV",
  "côte d'ivoire": "CIV",
  "democratic republic of the congo": "COD",
  "congo, dem. rep.": "COD",
  "laos": "LAO",
  "lao pdr": "LAO",
  "myanmar": "MMR",
  "brunei": "BRN",
  "taiwan": "TWN",
  "palestine": "PSE",
  "venezuela": "VEN",
};

function buildNameMap() {
  const rankings = JSON.parse(
    readFileSync(resolve(root, "src/assets/data/country-rankings.json"), "utf8"),
  );
  const map = new Map();
  for (const row of rankings.countries) {
    map.set(row.name.toLowerCase(), row.iso3);
    // Strip parenthetical qualifiers: "Aruba (Neth.)"
    const bare = row.name.replace(/\s*\(.*?\)\s*/g, "").trim().toLowerCase();
    if (bare) map.set(bare, row.iso3);
  }
  for (const [alias, iso3] of Object.entries(ALIASES)) map.set(alias, iso3);
  return map;
}

/** Minimal CSV that tolerates quoted commas and multiline fields. */
async function* iterateRecords(path) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let headers = null;
  let pending = "";
  for await (const line of rl) {
    pending = pending ? `${pending}\n${line}` : line;
    const quoteCount = (pending.match(/"/g) || []).length;
    if (quoteCount % 2 === 1) continue;
    const fields = parseCsvLine(pending);
    pending = "";
    if (!headers) {
      headers = fields.map((h) => h.trim());
      continue;
    }
    yield Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ""]));
  }
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

if (!existsSync(input)) {
  const empty = {
    source: "Global Energy Monitor — Global Solar Power Tracker",
    vintage: "missing",
    licence: "CC BY 4.0 (utility); see GEM terms",
    method: "No GEM CSV found at prepare time.",
    countries: [],
  };
  await mkdir(outDir, { recursive: true });
  await mkdir(mirrorDir, { recursive: true });
  const json = JSON.stringify(empty);
  await writeFile(resolve(outDir, "gem-country-aggregates.json"), json);
  await writeFile(resolve(mirrorDir, "gem-country-aggregates.json"), json);
  console.warn("GEM CSV not found — wrote empty bundle");
  process.exit(0);
}

const nameMap = buildNameMap();
const sums = new Map();
let unmatched = 0;
for await (const row of iterateRecords(input)) {
  const status = String(row.Status ?? "").trim().toLowerCase();
  if (status !== "operating") continue;
  const country = String(row["Country/Area"] ?? "").trim();
  const iso3 = nameMap.get(country.toLowerCase());
  if (!iso3) {
    unmatched += 1;
    continue;
  }
  const mw = Number(String(row["Capacity (MW)"] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(mw)) continue;
  const prev = sums.get(iso3) ?? { iso3, name: country, mw: 0, plants: 0 };
  prev.mw += mw;
  prev.plants += 1;
  sums.set(iso3, prev);
}

const countries = [...sums.values()].map((row) => ({
  iso3: row.iso3,
  name: row.name,
  operatingGw: Math.round((row.mw / 1000) * 1000) / 1000,
  operatingPlants: row.plants,
}));

const payload = {
  source: "Global Energy Monitor — Global Solar Power Tracker",
  vintage: "utility-scale-2-2026",
  licence: "CC BY 4.0 (utility tracker)",
  method: "Sum of operating utility-scale solar capacity by country (MW→GW).",
  countries,
};

await mkdir(outDir, { recursive: true });
await mkdir(mirrorDir, { recursive: true });
const json = JSON.stringify(payload);
await writeFile(resolve(outDir, "gem-country-aggregates.json"), json);
await writeFile(resolve(mirrorDir, "gem-country-aggregates.json"), json);
console.log(
  `Wrote gem-country-aggregates.json: ${countries.length} countries (${unmatched} operating rows unmatched to ISO3)`,
);
