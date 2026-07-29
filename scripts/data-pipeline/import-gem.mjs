#!/usr/bin/env node
/**
 * Converts the GEM Global Solar Power Tracker CSV into JSONL features matching
 * Sunday's vector store schema. The map never loads the raw CSV; it queries the
 * SQLite store by viewport after import.
 *
 * Usage:
 *   node scripts/data-pipeline/import-gem.mjs \
 *     --input notes/datasets/gem-solar/solar-power-plants-utility-scale-2-2026.csv \
 *     --output data/derived/gem-solar.jsonl
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const inputPath = resolve(
  root,
  arg("input", "notes/datasets/gem-solar/solar-power-plants-utility-scale-2-2026.csv"),
);
const outputPath = resolve(root, arg("output", "data/derived/gem-solar.jsonl"));

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
  if (!text) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

await mkdir(dirname(outputPath), { recursive: true });
const rl = createInterface({
  input: createReadStream(inputPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
const out = createWriteStream(outputPath, { encoding: "utf8" });

let headers = null;
let written = 0;
let skipped = 0;

for await (const line of rl) {
  if (!line.trim()) continue;
  const fields = parseCsvLine(line);
  if (!headers) {
    headers = fields;
    continue;
  }
  const row = Object.fromEntries(headers.map((header, i) => [header, fields[i] ?? ""]));
  const lon = num(row.Longitude);
  const lat = num(row.Latitude);
  const id = (row["GEM phase ID"] || row["GEM location ID"] || "").trim();
  if (lon === null || lat === null || !id || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    skipped += 1;
    continue;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    skipped += 1;
    continue;
  }

  const status = (row.Status || "").trim() || null;
  const technology = (row["Technology Type"] || "").trim() || null;
  const capacityMw = num(row["Capacity (MW)"]);
  const feature = {
    id,
    dataset: "gem-solar",
    lon,
    lat,
    capacityMw,
    status,
    technology,
    country: (row["Country/Area"] || "").trim() || null,
    name: (row["Project Name"] || "").trim() || null,
    source: "Global Energy Monitor, Global Solar Power Tracker",
    vintage: "2026-02",
    properties: {
      phaseName: (row["Phase Name"] || "").trim() || null,
      capacityRating: (row["Capacity Rating"] || "").trim() || null,
      locationId: (row["GEM location ID"] || "").trim() || null,
      locationAccuracy: (row["Location accuracy"] || "").trim() || null,
      operator: (row.Operator || "").trim() || null,
      owner: (row.Owner || "").trim() || null,
      startYear: num(row["Start year"]),
      wikiUrl: (row["Wiki URL"] || "").trim() || null,
      otherIds: (row["Other IDs (location)"] || "").trim() || null,
      associatedStorage: (row["Associated Storage"] || "").trim() || null,
      hydrogen: (row.Hydrogen || "").trim() || null,
      // TZ: cross-references are BY-NC; the UI surfaces this in the trust badge.
      hasTzCrossRef:
        /TZ:/i.test(row["Other IDs (location)"] || "") ||
        /TZ:/i.test(row["Other IDs (unit/phase)"] || ""),
    },
    geometry: { type: "Point", coordinates: [lon, lat] },
  };

  if (!out.write(`${JSON.stringify(feature)}\n`)) {
    await new Promise((resolveWrite) => out.once("drain", resolveWrite));
  }
  written += 1;
}

out.end();
await finished(out);
console.log(`wrote ${written} features to ${outputPath} (skipped ${skipped})`);
console.log(
  "Import into the app: Settings → Datasets → Import GEM JSONL, or platform.vector.importFeatures.",
);
