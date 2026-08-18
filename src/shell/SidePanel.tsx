/**
 * Collapsible side panel shell.
 *
 * The left panel collapses to a 48 px rail that keeps its icons visible; the
 * right panel collapses to nothing, because an inspector with no room is worse
 * than no inspector. Both behaviours come from the prototypes.
 */

import type { ReactNode } from "react";
import { IconButton } from "@/design-system/controls";
import { ChevronLeftIcon, ChevronRightIcon } from "@/design-system/icons";

export interface SidePanelProps {
  side: "left" | "right";
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Shown in the header when expanded, e.g. a count or an action. */
  headerAction?: ReactNode;
}

export function SidePanel({
  side,
  title,
  collapsed,
  onToggle,
  children,
  headerAction,
}: SidePanelProps) {
  const className = [
    "panel",
    side === "left" ? "panel--left" : "panel--right",
    collapsed ? "panel--collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Chevron points the way the panel will move, which is the only convention
  // users read correctly without thinking.
  const Chevron = side === "left" ? (collapsed ? ChevronRightIcon : ChevronLeftIcon) : ChevronRightIcon;

  return (
    <aside className={className} aria-label={title}>
      <div className="panel__head">
        <span className="panel__title">{title}</span>
        <span className="panel__spacer" />
        {!collapsed && headerAction}
        <IconButton
          label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          size="sm"
          onClick={onToggle}
        >
          <Chevron size={14} />
        </IconButton>
      </div>
      <div className="panel__body">{children}</div>
    </aside>
  );
}

/**
 * The right panel needs a reopen affordance once it has collapsed to zero width.
 * Positioned by the Project canvas overlay column, not by this component.
 */
export function RightPanelReopen({ onClick }: { onClick: () => void }) {
  return (
    <div className="canvas__overlay">
      <IconButton label="Show the inspector" onClick={onClick}>
        <ChevronLeftIcon />
      </IconButton>
    </div>
  );
}
