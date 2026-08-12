/**
 * Scientific literature search for Insights Research.
 * OpenAlex + CrossRef always; Springer / Zenodo / Semantic Scholar when keyed.
 * CORE intentionally omitted (slow).
 *
 * Target ~100 hits per source where the API allows. Springer free tier caps
 * page size at 25, so we issue four parallel pages (s=1,26,51,76). Meta has no
 * sortby for newest — approximate with datefrom: one year back + client sort.
 * Semantic Scholar retries once after a 3s backoff (intermittent unresponsiveness).
 */

import { platform } from "@/core/platform";

export type ResearchSourceId = "openalex" | "crossref" | "springer" | "zenodo" | "semanticscholar";

export type SortMode = "relevance" | "newest";
export type SourceStatus = "ok" | "empty" | "error" | "disabled";

export interface Paper {
  id: string;
  source: ResearchSourceId;
  title: string;
  authors: string[];
  date: string | null;
  url: string | null;
  venue?: string;
  openAccess?: boolean;
  citationCount?: number;
}

export interface SourceResult {
  source: ResearchSourceId;
  status: SourceStatus;
  papers: Paper[];
  errorMessage?: string;
}

export interface ResearchKeys {
  springer?: string | null;
  zenodo?: string | null;
  semanticscholar?: string | null;
  mailto?: string;
}

const MAILTO_DEFAULT = "sunday-app@example.com";
const PAGE_SIZE = 100;

export const RESEARCH_SOURCE_ORDER: ResearchSourceId[] = [
  "openalex",
  "crossref",
  "springer",
  "zenodo",
  "semanticscholar",
];

export const RESEARCH_SOURCE_LABELS: Record<ResearchSourceId, string> = {
  openalex: "OpenAlex",
  crossref: "CrossRef",
  springer: "Springer",
  zenodo: "Zenodo",
  semanticscholar: "Semantic Scholar",
};

export const RESEARCH_PRESETS = [
  "utility-scale solar photovoltaic siting",
  "concentrating solar power tower heliostat",
  "solar PV ground coverage ratio bifacial",
  "agrivoltaics land use efficiency",
  "solar power plant environmental impact assessment",
] as const;

export async function runResearchSearch(
  query: string,
  sortMode: SortMode,
  keys: ResearchKeys,
  onResult?: (result: SourceResult) => void,
): Promise<SourceResult[]> {
  const mailto = keys.mailto?.trim() || MAILTO_DEFAULT;
  const jobs: Array<Promise<SourceResult>> = [
    searchOpenAlex(query, sortMode, mailto),
    searchCrossref(query, sortMode, mailto),
    keys.springer
      ? searchSpringer(query, sortMode, keys.springer)
      : Promise.resolve(disabled("springer")),
    keys.zenodo ? searchZenodo(query, sortMode, keys.zenodo) : Promise.resolve(disabled("zenodo")),
    keys.semanticscholar
      ? searchSemanticScholar(query, sortMode, keys.semanticscholar)
      : Promise.resolve(disabled("semanticscholar")),
  ];
  return Promise.all(
    jobs.map(async (job) => {
      const result = await job;
      onResult?.(result);
      return result;
    }),
  );
}

function disabled(source: ResearchSourceId): SourceResult {
  return {
    source,
    status: "disabled",
    papers: [],
    errorMessage: "Add an API key in Settings → Optional keys to enable this source.",
  };
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await platform().http.fetchText({
    url,
    headers: { Accept: "application/json", ...headers },
    timeoutMs: 30_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  return JSON.parse(response.body) as T;
}

/** One retry after 3s — Semantic Scholar is intermittently slow/unresponsive. */
async function fetchWithRetry<T>(
  url: string,
  headers?: Record<string, string>,
  retries = 1,
): Promise<T> {
  try {
    return await fetchJson<T>(url, headers);
  } catch (error) {
    if (retries <= 0) throw error;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return fetchWithRetry<T>(url, headers, retries - 1);
  }
}

function yearAgoIsoDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

async function searchOpenAlex(
  query: string,
  sortMode: SortMode,
  mailto: string,
): Promise<SourceResult> {
  try {
    const sort = sortMode === "relevance" ? "relevance_score:desc" : "publication_date:desc";
    const params = new URLSearchParams({
      search: query,
      sort,
      per_page: String(PAGE_SIZE),
      filter: "topics.field.id:13|15|16|27|30",
      select: "title,doi,publication_date,authorships,primary_location,open_access,cited_by_count",
      mailto,
    });
    const data = await fetchJson<{
      results?: Array<{
        title?: string;
        doi?: string;
        publication_date?: string;
        authorships?: Array<{ author?: { display_name?: string } }>;
        primary_location?: {
          landing_page_url?: string;
          source?: { display_name?: string };
        };
        open_access?: { is_oa?: boolean };
        cited_by_count?: number;
      }>;
    }>(`https://api.openalex.org/works?${params}`);
    const papers: Paper[] = (data.results ?? []).map((work, i) => ({
      id: work.doi ?? `openalex-${i}`,
      source: "openalex",
      title: work.title ?? "Untitled",
      authors: (work.authorships ?? [])
        .map((a) => a.author?.display_name)
        .filter((n): n is string => Boolean(n)),
      date: work.publication_date ?? null,
      url: work.doi ?? work.primary_location?.landing_page_url ?? null,
      venue: work.primary_location?.source?.display_name,
      openAccess: work.open_access?.is_oa,
      citationCount: work.cited_by_count,
    }));
    return { source: "openalex", status: papers.length ? "ok" : "empty", papers };
  } catch (error) {
    return {
      source: "openalex",
      status: "error",
      papers: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function searchCrossref(
  query: string,
  sortMode: SortMode,
  mailto: string,
): Promise<SourceResult> {
  try {
    const params = new URLSearchParams({
      query,
      rows: String(PAGE_SIZE),
      sort: sortMode === "newest" ? "published" : "relevance",
      order: "desc",
      mailto,
    });
    const data = await fetchJson<{
      message?: {
        items?: Array<{
          DOI?: string;
          title?: string[];
          author?: Array<{ given?: string; family?: string }>;
          created?: { "date-time"?: string };
          URL?: string;
          "container-title"?: string[];
          "is-referenced-by-count"?: number;
        }>;
      };
    }>(`https://api.crossref.org/works?${params}`);
    const papers: Paper[] = (data.message?.items ?? []).map((item, i) => ({
      id: item.DOI ?? `crossref-${i}`,
      source: "crossref",
      title: item.title?.[0] ?? "Untitled",
      authors: (item.author ?? [])
        .map((a) => [a.given, a.family].filter(Boolean).join(" "))
        .filter(Boolean),
      date: item.created?.["date-time"]?.slice(0, 10) ?? null,
      url: item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : null),
      venue: item["container-title"]?.[0],
      citationCount: item["is-referenced-by-count"],
    }));
    return { source: "crossref", status: papers.length ? "ok" : "empty", papers };
  } catch (error) {
    return {
      source: "crossref",
      status: "error",
      papers: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function searchSpringer(
  query: string,
  sortMode: SortMode,
  apiKey: string,
): Promise<SourceResult> {
  try {
    // Free tier caps p at 25; four pages → up to 100 results.
    // Meta API has no reliable sortby for relevance/newest — do not send sortby=date
    // (it 4xxs). "Newest" ≈ datefrom filter (YYYY-MM-DD) one year back, then
    // client-side date sort. Overlap with relevance results is acceptable.
    const starts = [1, 26, 51, 76];
    const q =
      sortMode === "newest" ? `${query} datefrom:${yearAgoIsoDate()}` : query;

    const pages = await Promise.all(
      starts.map(async (s) => {
        const params = new URLSearchParams({
          q,
          api_key: apiKey,
          p: "25",
          s: String(s),
        });
        return fetchJson<{
          records?: Array<{
            doi?: string;
            title?: string;
            creators?: Array<{ creator?: string }>;
            publicationDate?: string;
            url?: Array<{ value?: string }>;
            publicationName?: string;
          }>;
        }>(`https://api.springernature.com/meta/v2/json?${params}`);
      }),
    );

    const seen = new Set<string>();
    const papers: Paper[] = [];
    for (const data of pages) {
      for (const rec of data.records ?? []) {
        const id = rec.doi ?? `springer-${papers.length}`;
        if (seen.has(id)) continue;
        seen.add(id);
        papers.push({
          id,
          source: "springer",
          title: rec.title ?? "Untitled",
          authors: (rec.creators ?? [])
            .map((c) => c.creator)
            .filter((n): n is string => Boolean(n)),
          date: rec.publicationDate ?? null,
          url: rec.url?.[0]?.value ?? (rec.doi ? `https://doi.org/${rec.doi}` : null),
          venue: rec.publicationName,
        });
      }
    }
    if (sortMode === "newest") {
      papers.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    }
    return { source: "springer", status: papers.length ? "ok" : "empty", papers };
  } catch (error) {
    return {
      source: "springer",
      status: "error",
      papers: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function searchZenodo(
  query: string,
  sortMode: SortMode,
  apiKey: string,
): Promise<SourceResult> {
  try {
    const params = new URLSearchParams({
      q: query,
      size: String(PAGE_SIZE),
      sort: sortMode === "newest" ? "mostrecent" : "bestmatch",
      type: "publication",
    });
    const data = await fetchJson<{
      hits?: {
        hits?: Array<{
          id?: number;
          doi?: string;
          metadata?: {
            title?: string;
            creators?: Array<{ name?: string }>;
            publication_date?: string;
          };
          links?: { html?: string };
        }>;
      };
    }>(`https://zenodo.org/api/records?${params}`, {
      Authorization: `Bearer ${apiKey}`,
    });
    const papers: Paper[] = (data.hits?.hits ?? []).map((hit, i) => ({
      id: hit.doi ?? `zenodo-${hit.id ?? i}`,
      source: "zenodo",
      title: hit.metadata?.title ?? "Untitled",
      authors: (hit.metadata?.creators ?? [])
        .map((c) => c.name)
        .filter((n): n is string => Boolean(n)),
      date: hit.metadata?.publication_date ?? null,
      url: hit.links?.html ?? (hit.doi ? `https://doi.org/${hit.doi}` : null),
    }));
    return { source: "zenodo", status: papers.length ? "ok" : "empty", papers };
  } catch (error) {
    return {
      source: "zenodo",
      status: "error",
      papers: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function searchSemanticScholar(
  query: string,
  sortMode: SortMode,
  apiKey: string,
): Promise<SourceResult> {
  try {
    const params = new URLSearchParams({
      query,
      limit: String(PAGE_SIZE),
      fields: "title,authors,year,url,venue,citationCount,isOpenAccess,externalIds",
    });
    if (sortMode === "newest") params.set("sort", "publicationDate:desc");
    const data = await fetchWithRetry<{
      data?: Array<{
        paperId?: string;
        title?: string;
        authors?: Array<{ name?: string }>;
        year?: number;
        url?: string;
        venue?: string;
        citationCount?: number;
        isOpenAccess?: boolean;
        externalIds?: { DOI?: string };
      }>;
    }>(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
      "x-api-key": apiKey,
    });
    const papers: Paper[] = (data.data ?? []).map((p, i) => ({
      id: p.externalIds?.DOI ?? p.paperId ?? `s2-${i}`,
      source: "semanticscholar",
      title: p.title ?? "Untitled",
      authors: (p.authors ?? []).map((a) => a.name).filter((n): n is string => Boolean(n)),
      date: p.year ? String(p.year) : null,
      url: p.url ?? (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : null),
      venue: p.venue,
      openAccess: p.isOpenAccess,
      citationCount: p.citationCount,
    }));
    return { source: "semanticscholar", status: papers.length ? "ok" : "empty", papers };
  } catch (error) {
    return {
      source: "semanticscholar",
      status: "error",
      papers: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
