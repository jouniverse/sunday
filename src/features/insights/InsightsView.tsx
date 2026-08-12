/**
 * Insights view (formerly Analyze): project context, rankings, statistics,
 * news, World Bank projects, and research literature.
 */

import { useState } from "react";
import { type InsightsFeature, useInsightsStore } from "@/core/store/insightsStore";
import { SidePanel } from "@/shell/SidePanel";
import { NewsPanel } from "./NewsPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { RankingsPanel } from "./RankingsPanel";
import { ResearchPanel } from "./ResearchPanel";
import { StatisticsPanel } from "./StatisticsPanel";
import { WbProjectsPanel } from "./WbProjectsPanel";
import "./insights.css";

const FEATURES: Array<{ id: InsightsFeature; label: string; hint: string }> = [
  { id: "portfolio", label: "Portfolio", hint: "Sites and country context" },
  { id: "rankings", label: "Rankings", hint: "Solargis GHI / PVOUT" },
  { id: "statistics", label: "Statistics", hint: "Capacity and generation" },
  { id: "news", label: "News", hint: "Industry RSS" },
  { id: "wb_projects", label: "WB Projects", hint: "World Bank solar" },
  { id: "research", label: "Research", hint: "Literature and feeds" },
];

export function InsightsView() {
  const feature = useInsightsStore((s) => s.feature);
  const setFeature = useInsightsStore((s) => s.setFeature);
  const [navCollapsed, setNavCollapsed] = useState(false);

  return (
    <div className="insights">
      <div className="insights__workspace">
        <SidePanel
          side="left"
          title="Insights"
          collapsed={navCollapsed}
          onToggle={() => setNavCollapsed((value) => !value)}
        >
          {!navCollapsed && (
            <nav className="insights__nav" aria-label="Insights features">
              {FEATURES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="insights__nav-btn"
                  aria-current={feature === entry.id ? "page" : undefined}
                  onClick={() => setFeature(entry.id)}
                  title={entry.hint}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          )}
        </SidePanel>

        <main className="insights__main">
          {feature === "portfolio" && <PortfolioPanel />}
          {feature === "rankings" && <RankingsPanel />}
          {feature === "statistics" && <StatisticsPanel />}
          {feature === "news" && <NewsPanel />}
          {feature === "wb_projects" && <WbProjectsPanel />}
          {feature === "research" && <ResearchPanel />}
        </main>
      </div>
    </div>
  );
}

/** Back-compat export while ViewId stays `analytics`. */
export { InsightsView as AnalyticsView };
