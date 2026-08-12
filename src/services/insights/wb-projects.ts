/**
 * World Bank Projects API v3 — solar sector projects for Insights.
 *
 * Sector filter uses FY17 taxonomy only (`FY17 - Renewable Energy Solar`).
 * Legacy label alone returns 0; dual OR returns the same ~411 as FY17 alone.
 * `totalamt` server sort is lexical — we always re-sort amounts client-side.
 */

import { platform } from "@/core/platform";

const BASE = "https://search.worldbank.org/api/v3/projects";
const FL = [
  "id",
  "project_name",
  "pdo",
  "countryshortname",
  "regionname",
  "projectstatusdisplay",
  "sector1",
  "theme_list",
  "boardapprovaldate",
  "closingdate",
  "proj_last_upd_date",
  "public_disclosure_date",
  "totalamt",
  "curr_total_commitment",
  "ibrdcommamt",
  "idacommamt",
  "url",
].join(",");

/** FY17 solar sector — exact facet name; ~411 projects as of API check. */
const SECTOR_EXACT = "FY17 - Renewable Energy Solar";

const PROJECT_DETAIL_URL =
  "https://projects.worldbank.org/en/projects-operations/project-detail";

export type WbSortField = "proj_last_upd_date" | "boardapprovaldate" | "totalamt";

export interface WbProject {
  id: string;
  projectName: string;
  country: string;
  region: string;
  status: string;
  /** Commitment / project total in USD (API amounts are USD). */
  totalAmt: number | null;
  commitmentAmt: number | null;
  boardApprovalDate: string | null;
  closingDate: string | null;
  lastUpdated: string | null;
  lastStage: string | null;
  url: string;
  pdo: string | null;
}

export async function fetchWbSolarProjects(options: {
  sort?: WbSortField;
  order?: "asc" | "desc";
  /** Cap rows requested; API returns all ~411 solar projects at rows≥411. */
  rows?: number;
  offset?: number;
  country?: string;
}): Promise<{ projects: WbProject[]; total: number }> {
  const sort = options.sort ?? "proj_last_upd_date";
  const order = options.order ?? "desc";
  // Prefer date sorts from the API; amount sort is lexical there so we re-sort below.
  const apiSort = sort === "totalamt" ? "proj_last_upd_date" : sort;

  const params = new URLSearchParams({
    format: "json",
    fl: FL,
    fct: "status_exact,regionname_exact,countryshortname_exact,sector_exact",
    sector_exact: SECTOR_EXACT,
    srt: apiSort,
    order,
    rows: String(options.rows ?? 500),
    os: String(options.offset ?? 0),
  });
  if (options.country) params.set("countryshortname_exact", options.country);

  const url = `${BASE}?${params.toString()}`;
  const response = await platform().http.fetchText({ url });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `World Bank Projects API ${response.status}: ${response.body?.slice(0, 200) ?? ""}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("World Bank Projects API returned non-JSON");
  }

  const root = parsed as Record<string, unknown>;
  const projectsRaw = (root.projects ?? root.project ?? []) as unknown;
  const list = Array.isArray(projectsRaw)
    ? projectsRaw
    : projectsRaw && typeof projectsRaw === "object"
      ? Object.values(projectsRaw as Record<string, unknown>)
      : [];

  let projects = list.map(normalizeProject).filter((p): p is WbProject => p !== null);
  projects = sortProjects(projects, sort, order);
  const total = Number(root.total ?? root.rows ?? projects.length) || projects.length;
  return { projects, total };
}

function sortProjects(
  projects: WbProject[],
  sort: WbSortField,
  order: "asc" | "desc",
): WbProject[] {
  const dir = order === "asc" ? 1 : -1;
  const copy = [...projects];
  copy.sort((a, b) => {
    if (sort === "totalamt") {
      const av = a.totalAmt ?? -1;
      const bv = b.totalAmt ?? -1;
      return (av - bv) * dir;
    }
    if (sort === "boardapprovaldate") {
      return (a.boardApprovalDate ?? "").localeCompare(b.boardApprovalDate ?? "") * dir;
    }
    return (a.lastUpdated ?? "").localeCompare(b.lastUpdated ?? "") * dir;
  });
  return copy;
}

function projectUrl(id: string, apiUrl: string | null): string {
  if (apiUrl) return apiUrl;
  return `${PROJECT_DETAIL_URL}/${encodeURIComponent(id)}`;
}

function normalizeProject(raw: unknown): WbProject | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    projectName: String(row.project_name ?? "Untitled"),
    country: String(row.countryshortname ?? "—"),
    region: String(row.regionname ?? "—"),
    status: String(row.projectstatusdisplay ?? "—"),
    totalAmt: parseAmount(row.totalamt),
    commitmentAmt: parseAmount(row.curr_total_commitment),
    boardApprovalDate: strOrNull(row.boardapprovaldate),
    closingDate: strOrNull(row.closingdate),
    lastUpdated: strOrNull(row.proj_last_upd_date),
    lastStage: strOrNull(row.sector1) ?? strOrNull(row.theme_list),
    url: projectUrl(id, strOrNull(row.url)),
    pdo: strOrNull(row.pdo),
  };
}

function strOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[,$]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function formatUsd(amount: number | null): string {
  if (amount === null) return "—";
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD`;
}
