/**
 * RSS parse + feed catalogue for Insights News (and Research news tab).
 * Ported from freezer/solar-news-feeds with Tauri-safe fetching.
 */

import { platform } from "@/core/platform";

export type SolarNewsFeedId =
  | "pv-magazine"
  | "solar-power-world"
  | "pv-tech"
  | "cleantechnica-solar"
  | "solarpaces"
  | "renewables-now-solar"
  | "renewable-energy-world"
  | "solarquarter"
  | "utilitydive-solar";

export type ResearchNewsFeedId =
  | "nature-solar-cells"
  | "nature-solar-pv-tech"
  | "nature-solar-energy"
  | "nature-solar-thermal"
  | "fraunhofer-ise";

export type AnyFeedId = SolarNewsFeedId | ResearchNewsFeedId;

export interface NewsItem {
  id: string;
  feed: AnyFeedId;
  feedLabel: string;
  title: string;
  link: string | null;
  pubDate: string | null;
  description: string | null;
}

export type FeedStatus = "ok" | "empty" | "error";

export interface FeedResult {
  feed: AnyFeedId;
  status: FeedStatus;
  items: NewsItem[];
  errorMessage?: string;
}

export interface FeedMeta {
  id: AnyFeedId;
  label: string;
  url: string;
  /** When true, keep only items matching solar keywords. */
  filterSolar?: boolean;
}

export const SOLAR_NEWS_FEEDS: FeedMeta[] = [
  { id: "pv-magazine", label: "PV Magazine", url: "https://www.pv-magazine.com/feed/" },
  {
    id: "solar-power-world",
    label: "Solar Power World",
    url: "https://www.solarpowerworldonline.com/feed/",
  },
  { id: "pv-tech", label: "PV Tech", url: "https://www.pv-tech.org/feed/" },
  {
    id: "cleantechnica-solar",
    label: "CleanTechnica: Solar",
    url: "https://cleantechnica.com/category/clean-power/solar-energy/feed/",
  },
  { id: "solarpaces", label: "SolarPACES", url: "https://www.solarpaces.org/feed/" },
  {
    id: "renewables-now-solar",
    label: "Renewables Now: Solar",
    url: "https://renewablesnow.com/news/news_feed/?source=solar",
  },
  {
    id: "renewable-energy-world",
    label: "Renewable Energy World",
    url: "https://www.renewableenergyworld.com/feed/",
    filterSolar: true,
  },
  { id: "solarquarter", label: "SolarQuarter", url: "https://solarquarter.com/feed/" },
  {
    id: "utilitydive-solar",
    label: "Utility Dive: Solar",
    url: "https://www.utilitydive.com/feeds/topic/solar/",
  },
];

export const RESEARCH_NEWS_FEEDS: FeedMeta[] = [
  {
    id: "nature-solar-cells",
    label: "Nature: Solar cells",
    url: "https://www.nature.com/subjects/solar-cells.rss",
  },
  {
    id: "nature-solar-pv-tech",
    label: "Nature: PV technology",
    url: "https://www.nature.com/subjects/solar-energy-and-photovoltaic-technology.rss",
  },
  {
    id: "nature-solar-energy",
    label: "Nature: Solar energy",
    url: "https://www.nature.com/subjects/solar-energy.rss",
  },
  {
    id: "nature-solar-thermal",
    label: "Nature: Solar thermal",
    url: "https://www.nature.com/subjects/solar-thermal-energy.rss",
  },
  {
    id: "fraunhofer-ise",
    label: "Fraunhofer ISE",
    url: "https://www.ise.fraunhofer.de/en/rss/news.rss",
  },
];

const MAX_DESCRIPTION_LENGTH = 400;

export function sanitizeXml(xml: string): string {
  return xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}

export function cleanDescription(raw: string | null): string | null {
  if (!raw) return null;
  if (typeof DOMParser === "undefined") {
    const text = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return null;
    return text.length > MAX_DESCRIPTION_LENGTH
      ? `${text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()}…`
      : text;
  }
  const text = new DOMParser()
    .parseFromString(raw, "text/html")
    .body.textContent?.replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()}…`
    : text;
}

export function isSolarRelevant(title: string, description: string | null): boolean {
  return /solar|photovoltaic|\bpv\b/i.test(`${title} ${description ?? ""}`);
}

export function parseFeed(xml: string, feed: AnyFeedId, feedLabel: string): NewsItem[] {
  const sanitized = sanitizeXml(xml);
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(sanitized, "application/xml");
    if (!doc.querySelector("parsererror")) {
      return Array.from(doc.querySelectorAll("item")).map((item, i) => {
        const title = text(item.querySelector("title")) ?? "Untitled";
        const link = text(item.querySelector("link"));
        const description = cleanDescription(text(item.querySelector("description")));
        return {
          id: text(item.querySelector("guid")) ?? link ?? `${feed}-${i}`,
          feed,
          feedLabel,
          title,
          link,
          pubDate: parseDate(text(item.querySelector("pubDate"))),
          description,
        };
      });
    }
  }
  // Node / damaged XML: minimal <item> scrape so tests and offline tooling still work.
  return parseFeedRegex(sanitized, feed, feedLabel);
}

function parseFeedRegex(xml: string, feed: AnyFeedId, feedLabel: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  blocks.forEach((block, i) => {
    const title = tagText(block, "title") ?? "Untitled";
    const link = tagText(block, "link");
    const guid = tagText(block, "guid");
    const pubDate = parseDate(tagText(block, "pubDate"));
    const description = cleanDescription(tagText(block, "description"));
    items.push({
      id: guid ?? link ?? `${feed}-${i}`,
      feed,
      feedLabel,
      title,
      link,
      pubDate,
      description,
    });
  });
  return items;
}

function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  const inner = m?.[1];
  if (!inner) return null;
  return (
    inner
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function text(el: Element | null): string | null {
  const value = el?.textContent?.trim();
  return value ? value : null;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function fetchFeed(meta: FeedMeta): Promise<FeedResult> {
  try {
    const response = await platform().http.fetchText({ url: meta.url });
    if (response.status < 200 || response.status >= 300) {
      return {
        feed: meta.id,
        status: "error",
        items: [],
        errorMessage: `HTTP ${response.status}. Check the network or try Refresh later.`,
      };
    }
    let items = parseFeed(response.body, meta.id, meta.label);
    if (meta.filterSolar) {
      items = items.filter((item) => isSolarRelevant(item.title, item.description));
    }
    return {
      feed: meta.id,
      status: items.length ? "ok" : "empty",
      items,
    };
  } catch (error) {
    return {
      feed: meta.id,
      status: "error",
      items: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchAllFeeds(
  feeds: FeedMeta[],
  onResult?: (result: FeedResult) => void,
): Promise<FeedResult[]> {
  return Promise.all(
    feeds.map(async (meta) => {
      const result = await fetchFeed(meta);
      onResult?.(result);
      return result;
    }),
  );
}
