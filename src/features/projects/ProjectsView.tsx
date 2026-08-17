/**
 * All Projects library.
 *
 * Lists persisted projects and the sites nested under the active one. Create,
 * open/switch, rename and delete live here; the TopBar dropdown is the quick
 * switcher for day-to-day work.
 */

import { useEffect, useMemo, useState } from "react";
import { platform } from "@/core/platform";
import { useMapStore } from "@/core/store/mapStore";
import { useProjectLibraryStore } from "@/core/store/projectLibraryStore";
import { useProjectStore } from "@/core/store/projectStore";
import {
  screeningRingBounds,
  useScreeningStore,
} from "@/core/store/screeningStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Field, Input } from "@/design-system/controls";
import { Callout, EmptyState, SectionLabel } from "@/design-system/data";
import { LayersIcon, OpenIcon } from "@/design-system/icons";
import "./projects.css";

export function ProjectsView() {
  const entries = useProjectLibraryStore((state) => state.entries);
  const activeId = useProjectLibraryStore((state) => state.activeId);
  const createProject = useProjectLibraryStore((state) => state.createProject);
  const switchProject = useProjectLibraryStore((state) => state.switchProject);
  const deleteProject = useProjectLibraryStore((state) => state.deleteProject);
  const renameActive = useProjectLibraryStore((state) => state.renameActive);
  const saveActiveToLibrary = useProjectLibraryStore((state) => state.saveActiveToLibrary);

  const projectName = useProjectStore((state) => state.name);
  const dirty = useProjectStore((state) => state.dirty);
  const sites = useSiteStore((state) => state.sites);
  const removeSite = useSiteStore((state) => state.removeSite);
  const selectSite = useSiteStore((state) => state.selectSite);
  const screeningAreas = useScreeningStore((state) => state.areas);
  const selectScreening = useScreeningStore((state) => state.select);
  const renameScreening = useScreeningStore((state) => state.rename);
  const removeScreening = useScreeningStore((state) => state.remove);
  const renameSite = useSiteStore((state) => state.renameSite);
  const renameDesign = useSiteStore((state) => state.renameDesign);
  const fitBounds = useMapStore((state) => state.fitBounds);
  const markDirty = useProjectStore((state) => state.markDirty);
  const setView = useUiStore((state) => state.setView);
  const notify = useUiStore((state) => state.notify);

  const [draftName, setDraftName] = useState(projectName);
  /** Inline rename target: `screening:id` | `site:id` | `design:siteId/designId`. */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  useEffect(() => {
    setDraftName(projectName);
  }, [projectName, activeId]);
  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [entries],
  );

  async function handleCreate() {
    try {
      await createProject("Untitled project");
      notify({ tone: "success", message: "Created a new project" });
      setDraftName(useProjectStore.getState().name);
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not create a project",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleOpen(id: string) {
    try {
      const ok = await switchProject(id);
      if (ok) {
        notify({ tone: "success", message: `Opened ${useProjectStore.getState().name}` });
        setDraftName(useProjectStore.getState().name);
        setView("map");
      }
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not open the project",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleDelete(id: string, name: string) {
    const ok = await platform().shell.confirm(
      `Delete project “${name}”? This cannot be undone.`,
      "Delete project",
    );
    if (!ok) return;
    try {
      await deleteProject(id);
      setDraftName(useProjectStore.getState().name);
      notify({ tone: "success", message: `Deleted ${name}` });
    } catch (error) {
      notify({
        tone: "error",
        message: "Could not delete the project",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleRename() {
    const next = draftName.trim();
    if (!next || next === projectName) return;
    try {
      await renameActive(next);
      notify({ tone: "success", message: "Project renamed" });
    } catch (error) {
      setDraftName(projectName);
      notify({
        tone: "error",
        message: "Could not rename the project",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleDeleteSite(id: string, name: string) {
    const ok = await platform().shell.confirm(
      `Remove site “${name}” from this project?`,
      "Delete site",
    );
    if (!ok) return;
    removeSite(id);
    markDirty();
    void saveActiveToLibrary().catch(() => undefined);
  }

  async function handleDeleteScreening(id: string, name: string) {
    const ok = await platform().shell.confirm(
      `Remove screening area “${name}” from this project?`,
      "Delete screening area",
    );
    if (!ok) return;
    removeScreening(id);
    markDirty();
    void saveActiveToLibrary().catch(() => undefined);
  }

  function beginEdit(key: string, currentName: string) {
    setEditingKey(key);
    setEditDraft(currentName);
  }

  function cancelEdit() {
    setEditingKey(null);
    setEditDraft("");
  }

  function commitEdit() {
    if (!editingKey) return;
    const next = editDraft.trim();
    if (!next) {
      notify({ tone: "warning", message: "Name cannot be empty" });
      return;
    }
    if (editingKey.startsWith("screening:")) {
      renameScreening(editingKey.slice("screening:".length), next);
    } else if (editingKey.startsWith("site:")) {
      renameSite(editingKey.slice("site:".length), next);
    } else if (editingKey.startsWith("design:")) {
      const rest = editingKey.slice("design:".length);
      const slash = rest.indexOf("/");
      if (slash > 0) {
        renameDesign(rest.slice(0, slash), rest.slice(slash + 1), next);
      }
    }
    markDirty();
    void saveActiveToLibrary().catch(() => undefined);
    cancelEdit();
  }

  async function handleDeleteDesign(siteId: string, designId: string, name: string) {
    const ok = await platform().shell.confirm(
      `Delete design “${name}”? This cannot be undone.`,
      "Delete design",
    );
    if (!ok) return;
    useSiteStore.getState().deleteDesign(siteId, designId);
    markDirty();
    void saveActiveToLibrary().catch(() => undefined);
    notify({ tone: "success", message: `Deleted design “${name}”` });
  }

  return (
    <div className="content-view">
      <div className="content-view__inner projects">
        <header className="projects__head">
          <div>
            <h1 className="content-view__title">All projects</h1>
            <p className="content-view__lede">
              Sunday keeps a library of projects on this machine. Switch from here or the TopBar
              dropdown; the last open project is restored on launch.
            </p>
          </div>
          <Button variant="primary" icon={<OpenIcon size={13} />} onClick={handleCreate}>
            New project
          </Button>
        </header>

        <SectionLabel>Library</SectionLabel>
        {sorted.length === 0 ? (
          <EmptyState
            icon={<LayersIcon size={28} />}
            title="No projects yet"
            body="Create a project to start drawing sites and designing systems."
            action={
              <Button variant="primary" onClick={handleCreate}>
                New project
              </Button>
            }
          />
        ) : (
          <table className="projects__table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr
                  key={entry.id}
                  className={`projects__row${entry.id === activeId ? " projects__row--active" : ""}`}
                  onClick={() => void handleOpen(entry.id)}
                >
                  <td>
                    <span className="projects__name">
                      {entry.name}
                      {entry.id === activeId && dirty ? " ·" : ""}
                    </span>
                  </td>
                  <td className="projects__meta">
                    {new Date(entry.updatedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                  <td className="projects__actions">
                    <Button
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleOpen(entry.id);
                      }}
                    >
                      Open
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDelete(entry.id, entry.name);
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <SectionLabel>Active project</SectionLabel>
        <div className="projects__active">
          <Field label="Name">
            <Input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => void handleRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRename();
              }}
            />
          </Field>
          <Callout tone="note">
            {sites.length} site{sites.length === 1 ? "" : "s"}
            {screeningAreas.length > 0
              ? ` · ${screeningAreas.length} screening area${screeningAreas.length === 1 ? "" : "s"}`
              : ""}{" "}
            in this project
            {dirty ? " · unsaved changes" : ""}.
          </Callout>
        </div>

        <SectionLabel>Screening areas in this project</SectionLabel>
        {screeningAreas.length === 0 ? (
          <Callout tone="note">
            No screening areas yet. Open the Project map → Land and terrain → Draw screening area.
          </Callout>
        ) : (
          <ul className="projects__sites">
            {screeningAreas.map((area) => {
              const key = `screening:${area.id}`;
              const editing = editingKey === key;
              return (
                <li key={area.id} className="projects__site">
                  <div className="projects__site-row">
                    {editing ? (
                      <Input
                        className="projects__edit-input"
                        value={editDraft}
                        aria-label="Screening area name"
                        autoFocus
                        onChange={(event) => setEditDraft(event.target.value)}
                        onBlur={() => commitEdit()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitEdit();
                          if (event.key === "Escape") cancelEdit();
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="projects__site-name"
                        onClick={() => {
                          selectScreening(area.id);
                          const bounds = screeningRingBounds(area.ring);
                          if (bounds) fitBounds(bounds);
                          setView("map");
                        }}
                      >
                        {area.name}
                        <span className="projects__meta">
                          {area.geometryValid && area.areaM2 > 0
                            ? ` · ${Math.round(area.areaM2 / 1e6).toLocaleString()} km²`
                            : " · invalid"}
                        </span>
                      </button>
                    )}
                    <div className="projects__item-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onMouseDown={(event) => {
                          if (editing) {
                            event.preventDefault();
                            cancelEdit();
                          }
                        }}
                        onClick={() => {
                          if (!editing) beginEdit(key, area.name);
                        }}
                      >
                        {editing ? "Cancel" : "Edit"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleDeleteScreening(area.id, area.name)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <SectionLabel>Sites in this project</SectionLabel>
        {sites.length === 0 ? (
          <Callout tone="note">
            No sites yet. Open the Project map and draw a boundary or place a point.
          </Callout>
        ) : (
          <ul className="projects__sites">
            {sites.map((site) => {
              const siteKey = `site:${site.id}`;
              const editingSite = editingKey === siteKey;
              return (
                <li key={site.id} className="projects__site">
                  <div className="projects__site-row">
                    {editingSite ? (
                      <Input
                        className="projects__edit-input"
                        value={editDraft}
                        aria-label="Site name"
                        autoFocus
                        onChange={(event) => setEditDraft(event.target.value)}
                        onBlur={() => commitEdit()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitEdit();
                          if (event.key === "Escape") cancelEdit();
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="projects__site-name"
                        onClick={() => {
                          selectSite(site.id);
                          setView("map");
                        }}
                      >
                        {site.name}
                        <span className="projects__meta">
                          {" "}
                          · {site.kind}
                          {site.areaM2 ? ` · ${Math.round(site.areaM2).toLocaleString()} m²` : ""}
                          {(site.designs?.length ?? 0) > 0
                            ? ` · ${site.designs!.length} design${site.designs!.length === 1 ? "" : "s"}`
                            : ""}
                        </span>
                      </button>
                    )}
                    <div className="projects__item-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onMouseDown={(event) => {
                          if (editingSite) {
                            event.preventDefault();
                            cancelEdit();
                          }
                        }}
                        onClick={() => {
                          if (!editingSite) beginEdit(siteKey, site.name);
                        }}
                      >
                        {editingSite ? "Cancel" : "Edit"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteSite(site.id, site.name)}
                      >
                        Delete site
                      </Button>
                    </div>
                  </div>
                  {(site.designs?.length ?? 0) > 0 && (
                    <ul className="projects__designs">
                      {site.designs!.map((design) => {
                        const designKey = `design:${site.id}/${design.id}`;
                        const editingDesign = editingKey === designKey;
                        return (
                          <li key={design.id} className="projects__design-row">
                            {editingDesign ? (
                              <Input
                                className="projects__edit-input"
                                value={editDraft}
                                aria-label="Design name"
                                autoFocus
                                onChange={(event) => setEditDraft(event.target.value)}
                                onBlur={() => commitEdit()}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") commitEdit();
                                  if (event.key === "Escape") cancelEdit();
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="projects__design-name"
                                onClick={() => {
                                  selectSite(site.id);
                                  useSiteStore.getState().selectDesign(site.id, design.id);
                                  setView("design");
                                }}
                              >
                                {design.name}
                                <span className="projects__meta">
                                  {design.capacityMwe != null
                                    ? ` · ${design.capacityMwe.toFixed(1)} MWₑ`
                                    : design.capacityKwDc != null
                                      ? ` · ${design.capacityKwDc.toFixed(1)} kW`
                                      : ""}
                                  {design.kind === "rooftop" ? " · rooftop" : ""}
                                  {design.kind === "csp-tower" ? " · CSP tower" : ""}
                                  {design.kind === "csp-trough" ? " · CSP trough" : ""}
                                </span>
                              </button>
                            )}
                            <div className="projects__item-actions">
                              <Button
                                size="sm"
                                variant="ghost"
                                onMouseDown={(event) => {
                                  if (editingDesign) {
                                    event.preventDefault();
                                    cancelEdit();
                                  }
                                }}
                                onClick={() => {
                                  if (!editingDesign) beginEdit(designKey, design.name);
                                }}
                              >
                                {editingDesign ? "Cancel" : "Edit"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  void handleDeleteDesign(site.id, design.id, design.name)
                                }
                              >
                                Delete
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
