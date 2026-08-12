/**
 * Bundled Solargis monthly PVOUT profiles (Insights / other seasonality uses).
 * Note: the Solargis country-ranking workbook's Monthly sheet is PVOUT-only;
 * Rankings GHI/PVOUT detail charts use Summary statistics T/P distributions.
 */

import monthly from "@/assets/data/country-monthly-pvout.json";

export interface CountryMonthlyProfile {
  iso3: string;
  name: string;
  region: string | null;
  yearlyKwhKwpDay: number | null;
  /** Twelve values, Jan–Dec, kWh/kWp/day. */
  monthlyKwhKwpDay: Array<number | null>;
}

export interface CountryMonthlyDataset {
  source: string;
  vintage: string;
  licence: string;
  method: string;
  unit: string;
  months: string[];
  countries: CountryMonthlyProfile[];
}

export function loadCountryMonthly(): CountryMonthlyDataset {
  return monthly as CountryMonthlyDataset;
}

export function monthlyByIso3(iso3: string): CountryMonthlyProfile | undefined {
  return loadCountryMonthly().countries.find(
    (row) => row.iso3.toUpperCase() === iso3.toUpperCase(),
  );
}
