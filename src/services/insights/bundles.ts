/**
 * Loaders for Insights bundled indicator observations and GEM aggregates.
 */

import gemAggregates from "@/assets/data/insights/gem-country-aggregates.json";
import irenaCapacity from "@/assets/data/insights/irena-capacity.json";
import irenaExtras from "@/assets/data/insights/irena-country-extras.json";
import owidElecShare from "@/assets/data/insights/owid-electricity-share.json";
import owidPrimary from "@/assets/data/insights/owid-primary-energy.json";
import owidGeneration from "@/assets/data/insights/owid-solar-generation.json";
import type { InsightObservation } from "@/domain/insights/types";

interface BundleFile {
  source: string;
  vintage: string;
  licence: string;
  method: string;
  observations: InsightObservation[];
}

interface GemBundle {
  source: string;
  vintage: string;
  licence: string;
  method: string;
  countries: Array<{
    iso3: string;
    name: string;
    operatingGw: number;
    operatingPlants: number;
  }>;
}

export interface IrenaEmploymentEntry {
  iso3: string;
  year: string;
  technologies: Record<string, number>;
}

export interface IrenaFinanceEntry {
  iso3: string;
  series: Array<{ date: string; value: number }>;
}

export interface IrenaInnovationEntry {
  iso3: string;
  rows: Array<{ date: string; sector: string; subtechnology: string; value: number }>;
}

export interface IrenaBalanceEntry {
  iso3: string;
  year: string;
  solarPv: number | null;
  solarThermal: number | null;
}

interface IrenaExtrasBundle {
  source: string;
  vintage: string;
  licence: string;
  method: string;
  employment: IrenaEmploymentEntry[];
  finance: IrenaFinanceEntry[];
  innovation: IrenaInnovationEntry[];
  balance: IrenaBalanceEntry[];
}

function asBundle(raw: unknown): BundleFile {
  return raw as BundleFile;
}

export function loadIrenaCapacity(): BundleFile {
  return asBundle(irenaCapacity);
}

export function loadOwidPrimaryEnergy(): BundleFile {
  return asBundle(owidPrimary);
}

export function loadOwidSolarGeneration(): BundleFile {
  return asBundle(owidGeneration);
}

export function loadOwidElectricityShare(): BundleFile {
  return asBundle(owidElecShare);
}

export function loadGemCountryAggregates(): GemBundle {
  return gemAggregates as GemBundle;
}

export function loadIrenaCountryExtras(): IrenaExtrasBundle {
  return irenaExtras as IrenaExtrasBundle;
}

export function gemOperatingGw(iso3: string): number | undefined {
  const row = loadGemCountryAggregates().countries.find(
    (c) => c.iso3.toUpperCase() === iso3.toUpperCase(),
  );
  return row?.operatingGw;
}

/** Latest IRENA capacity (GW) for a country. */
export function irenaCapacityGw(iso3: string): number | undefined {
  const rows = loadIrenaCapacity().observations.filter(
    (row) => row.entityIso3.toUpperCase() === iso3.toUpperCase(),
  );
  if (!rows.length) return undefined;
  return rows.sort((a, b) => b.date.localeCompare(a.date))[0]?.value;
}

export function irenaEmploymentFor(iso3: string): IrenaEmploymentEntry | undefined {
  return loadIrenaCountryExtras().employment.find(
    (row) => row.iso3.toUpperCase() === iso3.toUpperCase(),
  );
}

export function irenaFinanceFor(iso3: string): IrenaFinanceEntry | undefined {
  return loadIrenaCountryExtras().finance.find(
    (row) => row.iso3.toUpperCase() === iso3.toUpperCase(),
  );
}

export function irenaInnovationFor(iso3: string): IrenaInnovationEntry | undefined {
  return loadIrenaCountryExtras().innovation.find(
    (row) => row.iso3.toUpperCase() === iso3.toUpperCase(),
  );
}

export function irenaBalanceFor(iso3: string): IrenaBalanceEntry | undefined {
  return loadIrenaCountryExtras().balance.find(
    (row) => row.iso3.toUpperCase() === iso3.toUpperCase(),
  );
}
