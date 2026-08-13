/**
 * Insights view (formerly Analyze): project context, rankings, statistics,
 * news, World Bank projects, and research literature.
 */

import { useState, type ComponentType } from "react";
import { type InsightsFeature, useInsightsStore } from "@/core/store/insightsStore";
import {
  BankIcon,
  NewsIcon,
  PortfolioIcon,
  RankingsIcon,
  ResearchIcon,
  StatisticsIcon,
  type IconProps,
} from "@/design-system/icons";
import { SidePanel } from "@/shell/SidePanel";
import { NewsPanel } from "./NewsPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { RankingsPanel } from "./RankingsPanel";
import { ResearchPanel } from "./ResearchPanel";
import { StatisticsPanel } from "./StatisticsPanel";
import { WbProjectsPanel } from "./WbProjectsPanel";
import "./insights.css";

const FEATURES: Array<{
  id: InsightsFeature;
  label: string;
  hint: string;
  Icon: ComponentType<IconProps>;
}> = [
  { id: "portfolio", label: "Portfolio", hint: "Sites and country context", Icon: PortfolioIcon },
  { id: "rankings", label: "Rankings", hint: "Solargis GHI / PVOUT", Icon: RankingsIcon },
  { id: "statistics", label: "Statistics", hint: "Capacity and generation", Icon: StatisticsIcon },
  { id: "news", label: "News", hint: "Industry RSS", Icon: NewsIcon },
  { id: "wb_projects", label: "WB Projects", hint: "World Bank solar", Icon: BankIcon },
  { id: "research", label: "Research", hint: "Literature and feeds", Icon: ResearchIcon },
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
          <nav
            className={`insights__nav${navCollapsed ? " insights__nav--rail" : ""}`}
            aria-label="Insights features"
          >
            {FEATURES.map(({ id, label, hint, Icon }) => (
              <button
                key={id}
                type="button"
                className="insights__nav-btn"
                aria-current={feature === id ? "page" : undefined}
                aria-label={label}
                onClick={() => setFeature(id)}
                title={navCollapsed ? `${label} — ${hint}` : hint}
              >
                <span className="insights__nav-icon">
                  <Icon size={navCollapsed ? 18 : 16} />
                </span>
                {!navCollapsed && label}
              </button>
            ))}
          </nav>
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
