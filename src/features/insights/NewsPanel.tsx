/**
 * Insights News: solar industry RSS, one tab per source.
 */

import { useEffect, useState } from "react";
import { useInsightsStore } from "@/core/store/insightsStore";
import { Button } from "@/design-system/controls";
import { Callout } from "@/design-system/data";
import {
  type FeedResult,
  fetchAllFeeds,
  type NewsItem,
  SOLAR_NEWS_FEEDS,
} from "@/services/insights/rss";

export function NewsPanel() {
  const selectedNewsFeedId = useInsightsStore((s) => s.selectedNewsFeedId);
  const setSelectedNewsFeedId = useInsightsStore((s) => s.setSelectedNewsFeedId);
  const [results, setResults] = useState<Record<string, FeedResult>>({});
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const activeId = selectedNewsFeedId ?? SOLAR_NEWS_FEEDS[0]?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void tick;
    const next: Record<string, FeedResult> = {};
    void fetchAllFeeds(SOLAR_NEWS_FEEDS, (result) => {
      if (cancelled) return;
      next[result.feed] = result;
      setResults({ ...next });
    }).finally(() => {
      if (!cancelled) {
        setBusy(false);
        if (!useInsightsStore.getState().selectedNewsFeedId && SOLAR_NEWS_FEEDS[0]) {
          setSelectedNewsFeedId(SOLAR_NEWS_FEEDS[0].id);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tick, setSelectedNewsFeedId]);

  const active = activeId ? results[activeId] : undefined;
  const items: NewsItem[] = active?.items ?? [];

  return (
    <>
      <div className="insights__main-head">
        <div>
          <h2 className="insights__title">Solar news</h2>
          <p className="insights__lede">
            Industry RSS feeds. Sources are never merged — pick a tab. Refresh reloads all feeds.
          </p>
        </div>
        <div className="insights__toolbar">
          <Button onClick={() => setTick((n) => n + 1)} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="insights__tabs" role="tablist" aria-label="News sources">
        {SOLAR_NEWS_FEEDS.map((feed) => (
          <button
            key={feed.id}
            type="button"
            className="insights__tab"
            role="tab"
            aria-selected={activeId === feed.id}
            onClick={() => setSelectedNewsFeedId(feed.id)}
          >
            {feed.label}
          </button>
        ))}
      </div>

      {active?.status === "error" && (
        <Callout tone="warning">
          {active.errorMessage ?? "Could not load this feed."} Check the network connection.
        </Callout>
      )}
      {active?.status === "empty" && (
        <Callout tone="note">No items in this feed right now.</Callout>
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
