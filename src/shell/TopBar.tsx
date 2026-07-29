/**
 * Top bar: brand, primary view tabs, project actions.
 *
 * Matches the prototype chrome: a 52 px bar with the wordmark, the four primary
 * views, and the settings and help affordances pushed to the right.
 */

import { IconButton } from "@/design-system/controls";
import { HelpIcon, OpenIcon, SaveIcon, SettingsIcon, SunIcon } from "@/design-system/icons";
import { useProjectStore } from "@/core/store/projectStore";
import { useUiStore } from "@/core/store/uiStore";
import type { ViewId } from "@/core/store/uiStore";

const TABS: Array<{ id: ViewId; label: string }> = [
  { id: "map", label: "Project" },
  { id: "design", label: "Design" },
  { id: "report", label: "Report" },
  { id: "analytics", label: "Analyze" },
];

export function TopBar() {
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);
  const notify = useUiStore((state) => state.notify);
  const projectName = useProjectStore((state) => state.name);
  const dirty = useProjectStore((state) => state.dirty);

  async function handleSave() {
    try {
      const path = await useProjectStore.getState().save();
      if (path) notify({ tone: "success", message: `Saved to ${path}` });
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not save the project",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleOpen() {
    try {
      const opened = await useProjectStore.getState().open();
      if (opened) {
        notify({ tone: "success", message: `Opened ${useProjectStore.getState().name}` });
        if (useProjectStore.getState().loadedFromNewerSchema) {
          notify({
            tone: "warning",
            message: "This project was written by a newer version of Sunday",
            detail:
              "Fields this build does not understand were kept intact and will be written back unchanged.",
          });
        }
      }
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not open the project",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <header className="topbar">
      <div className="topbar__logo">
        <SunIcon size={20} className="topbar__mark" />
        Sunday
      </div>

      <nav className="topbar__tabs" aria-label="Primary views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`topbar__tab${view === tab.id ? " topbar__tab--active" : ""}`}
            aria-current={view === tab.id ? "page" : undefined}
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="topbar__spacer" />

      <div className="topbar__actions">
        <IconButton label="Open project" onClick={handleOpen}>
          <OpenIcon />
        </IconButton>
        <IconButton
          label={dirty ? `Save ${projectName} (unsaved changes)` : `Save ${projectName}`}
          onClick={handleSave}
        >
          <SaveIcon />
        </IconButton>
        <IconButton
          label="Settings"
          active={view === "settings"}
          onClick={() => setView("settings")}
        >
          <SettingsIcon />
        </IconButton>
        <IconButton label="Help and documentation" active={view === "help"} onClick={() => setView("help")}>
          <HelpIcon />
        </IconButton>
      </div>
    </header>
  );
}
