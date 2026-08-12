/**
 * Insights Research: literature search + research RSS news.
 */

import { useEffect, useState } from "react";
import { useInsightsStore } from "@/core/store/insightsStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import { Button, Input, Select } from "@/design-system/controls";
import { Callout } from "@/design-system/data";
import {
  type Paper,
  RESEARCH_PRESETS,
  RESEARCH_SOURCE_LABELS,
  RESEARCH_SOURCE_ORDER,
  type ResearchSourceId,
  runResearchSearch,
  type SortMode,
  type SourceResult,
} from "@/services/insights/research";
import {
  type FeedResult,
  fetchAllFeeds,
  type NewsItem,
  RESEARCH_NEWS_FEEDS,
} from "@/services/insights/rss";

export function ResearchPanel() {
  const researchMode = useInsightsStore((s) => s.researchMode);
  const setResearchMode = useInsightsStore((s) => s.setResearchMode);

  return (
    <>
      <div className="insights__main-head">
        <div>
          <h2 className="insights__title">Research</h2>
          <p className="insights__lede">
            Scientific articles and research news. OpenAlex and CrossRef need no key; Springer,
            Zenodo and Semantic Scholar use Settings → Optional keys.
          </p>
        </div>
        <div className="insights__tabs" role="tablist" aria-label="Research mode">
          <button
            type="button"
            className="insights__tab"
            role="tab"
            aria-selected={researchMode === "search"}
            onClick={() => setResearchMode("search")}
          >
            Search
          </button>
          <button
            type="button"
            className="insights__tab"
            role="tab"
            aria-selected={researchMode === "news"}
            onClick={() => setResearchMode("news")}
          >
            News
          </button>
        </div>
      </div>
      {researchMode === "search" ? <ResearchSearch /> : <ResearchNews />}
    </>
  );
}

function ResearchSearch() {
  const revealApiKey = useSettingsStore((s) => s.useKey);
  const [query, setQuery] = useState<string>(RESEARCH_PRESETS[0]);
  const [sortMode, setSortMode] = useState<SortMode>("relevance");
  const [results, setResults] = useState<SourceResult[]>([]);
  const [activeSource, setActiveSource] = useState<ResearchSourceId>("openalex");
  const [busy, setBusy] = useState(false);

  async function search(nextQuery = query) {
    setBusy(true);
    setResults([]);
    const keys = {
      springer: await revealApiKey("springer"),
      zenodo: await revealApiKey("zenodo"),
      semanticscholar: await revealApiKey("semanticscholar"),
    };
    const settled: SourceResult[] = [];
    await runResearchSearch(nextQuery, sortMode, keys, (result) => {
      settled.push(result);
      setResults([...settled]);
      // Prefer the first source that returned papers as the active tab.
      if (
        result.status === "ok" &&
        result.papers.length > 0 &&
        settled.filter((r) => r.status === "ok" && r.papers.length > 0).length === 1
      ) {
        setActiveSource(result.source);
      }
    });
    setBusy(false);
  }

  const bySource = new Map(results.map((r) => [r.source, r]));
  const active = bySource.get(activeSource);
  const papers: Paper[] = active?.papers ?? [];

  return (
    <>
      <div className="insights__toolbar" style={{ marginBottom: 12 }}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search literature"
          style={{ minWidth: 260 }}
        />
        <Select
          value={sortMode}
          onChange={(event) => setSortMode(event.target.value as SortMode)}
          options={[
            { value: "relevance", label: "Relevance" },
            { value: "newest", label: "Newest" },
          ]}
        />
        <Button variant="primary" onClick={() => void search()} disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </div>
      <div className="insights__toolbar" style={{ marginBottom: 12 }}>
        {RESEARCH_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="insights__tab"
            onClick={() => {
              setQuery(preset);
              void search(preset);
            }}
          >
            {preset}
          </button>
        ))}
      </div>

      <div className="insights__tabs" role="tablist" aria-label="Literature sources">
        {RESEARCH_SOURCE_ORDER.map((sourceId) => {
          const result = bySource.get(sourceId);
          const label = RESEARCH_SOURCE_LABELS[sourceId];
          const count =
            result?.status === "ok"
              ? ` (${result.papers.length})`
              : result
                ? ` · ${result.status}`
                : busy
                  ? " …"
                  : "";
          return (
            <button
              key={sourceId}
              type="button"
              className="insights__tab"
              role="tab"
              aria-selected={activeSource === sourceId}
              onClick={() => setActiveSource(sourceId)}
            >
              {label}
              {count}
            </button>
          );
        })}
      </div>

      {results.some((r) => r.status === "disabled") && (
        <Callout tone="note">
          Some sources are disabled until you add API keys under Settings → Optional keys.
        </Callout>
      )}
      {active?.status === "error" && (
        <Callout tone="warning">{active.errorMessage ?? "This source failed."}</Callout>
      )}
      {active?.status === "disabled" && (
        <Callout tone="note">{active.errorMessage ?? "Source disabled."}</Callout>
      )}
      {active?.status === "empty" && (
        <Callout tone="info">No papers returned for this source.</Callout>
      )}

      <div className="insights__feed-list">
        {papers.map((paper) => (
          <article key={`${paper.source}-${paper.id}`} className="insights__feed-item">
            <div className="insights__feed-meta">
              {RESEARCH_SOURCE_LABELS[paper.source]}
              {paper.date ? ` · ${paper.date}` : ""}
              {paper.citationCount !== undefined ? ` · ${paper.citationCount} cites` : ""}
            </div>
            <h3>
              {paper.url ? (
                <a href={paper.url} target="_blank" rel="noreferrer">
                  {paper.title}
                </a>
              ) : (
                paper.title
              )}
            </h3>
            <p>
              {paper.authors.slice(0, 4).join(", ")}
              {paper.authors.length > 4 ? " et al." : ""}
              {paper.venue ? ` — ${paper.venue}` : ""}
            </p>
          </article>
        ))}
      </div>
    </>
  );
}

function ResearchNews() {
  const selectedResearchFeedId = useInsightsStore((s) => s.selectedResearchFeedId);
  const setSelectedResearchFeedId = useInsightsStore((s) => s.setSelectedResearchFeedId);
  const [results, setResults] = useState<Record<string, FeedResult>>({});
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const activeId = selectedResearchFeedId ?? RESEARCH_NEWS_FEEDS[0]?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void tick;
    const next: Record<string, FeedResult> = {};
    void fetchAllFeeds(RESEARCH_NEWS_FEEDS, (result) => {
      if (cancelled) return;
      next[result.feed] = result;
      setResults({ ...next });
    }).finally(() => {
      if (!cancelled) {
        setBusy(false);
        if (!useInsightsStore.getState().selectedResearchFeedId && RESEARCH_NEWS_FEEDS[0]) {
          setSelectedResearchFeedId(RESEARCH_NEWS_FEEDS[0].id);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tick, setSelectedResearchFeedId]);

  const items: NewsItem[] = (activeId && results[activeId]?.items) || [];
  const active = activeId ? results[activeId] : undefined;

  return (
    <>
      <div className="insights__toolbar" style={{ marginBottom: 12 }}>
        <Button onClick={() => setTick((n) => n + 1)} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="insights__tabs" role="tablist" aria-label="Research news sources">
        {RESEARCH_NEWS_FEEDS.map((feed) => (
          <button
            key={feed.id}
            type="button"
            className="insights__tab"
            role="tab"
            aria-selected={activeId === feed.id}
            onClick={() => setSelectedResearchFeedId(feed.id)}
          >
            {feed.label}
          </button>
        ))}
      </div>
      {active?.status === "error" && (
        <Callout tone="warning">{active.errorMessage ?? "Could not load this feed."}</Callout>
      )}
      <div className="insights__feed-list">
        {items.map((item) => (
          <article key={item.id} className="insights__feed-item">
            <div className="insights__feed-meta">
              {item.pubDate ? new Date(item.pubDate).toLocaleDateString() : "No date"}
            </div>
            <h3>
              {item.link ? (
                <a href={item.link} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
              ) : (
                item.title
              )}
            </h3>
            {item.description && <p>{item.description}</p>}
          </article>
        ))}
      </div>
    </>
  );
}
