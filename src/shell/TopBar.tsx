/**
 * Top bar: brand, primary view tabs, project switcher, project actions.
 *
 * Matches the prototype chrome: a 52 px bar with the wordmark, the four primary
 * views, and the settings and help affordances pushed to the right.
 */

import { IconButton } from "@/design-system/controls";
import {
  ExportIcon,
  HelpIcon,
  LayersIcon,
  OpenIcon,
  SaveIcon,
  SettingsIcon,
  SundayLogoMark,
} from "@/design-system/icons";
import { useProjectLibraryStore } from "@/core/store/projectLibraryStore";
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
  const openModal = useUiStore((state) => state.openModal);
  const notify = useUiStore((state) => state.notify);
  const projectName = useProjectStore((state) => state.name);
  const dirty = useProjectStore((state) => state.dirty);
  const libraryId = useProjectStore((state) => state.libraryId);
  const entries = useProjectLibraryStore((state) => state.entries);
  const activeId = useProjectLibraryStore((state) => state.activeId);
  const switchProject = useProjectLibraryStore((state) => state.switchProject);
  const saveActiveToLibrary = useProjectLibraryStore((state) => state.saveActiveToLibrary);
  const createProject = useProjectLibraryStore((state) => state.createProject);

  async function handleSave() {
    try {
      if (libraryId) {
        await saveActiveToLibrary();
        notify({ tone: "success", message: `Saved ${useProjectStore.getState().name}` });
        return;
      }
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

  async function handleSwitch(id: string) {
    if (!id) return;
    if (id === "__new__") {
      try {
        await createProject("Untitled project");
        notify({ tone: "success", message: "Created a new project" });
      } catch (error) {
        notify({
          tone: "error",
          message: "Could not create a project",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    try {
      const ok = await switchProject(id);
      if (ok) notify({ tone: "success", message: `Switched to ${useProjectStore.getState().name}` });
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not switch project",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <header className="topbar">
      <div className="topbar__logo">
        <SundayLogoMark size={22} className="topbar__mark" />
        Sunday
      </div>

      <label className="topbar__project">
        <span className="topbar__project-label">Project</span>
        <select
          className="topbar__project-select"
          aria-label="Switch project"
          value={activeId ?? ""}
          onChange={(event) => void handleSwitch(event.target.value)}
        >
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
              {entry.id === activeId && dirty ? " ·" : ""}
            </option>
          ))}
          <option value="__new__">New project…</option>
        </select>
      </label>

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
        <IconButton
          label="All projects"
          active={view === "projects"}
          onClick={() => setView("projects")}
        >
          <LayersIcon />
        </IconButton>
        <IconButton label="Open project file" onClick={handleOpen}>
          <OpenIcon />
        </IconButton>
        <IconButton
          label={dirty ? `Save ${projectName} (unsaved changes)` : `Save ${projectName}`}
          onClick={handleSave}
        >
          <SaveIcon />
        </IconButton>
        <IconButton label="Export project" onClick={() => openModal("export")}>
          <ExportIcon />
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
