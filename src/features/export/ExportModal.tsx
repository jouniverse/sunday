/**
 * Project export dialog: sites CSV / GeoJSON and the full `.sunday` document.
 */

import { useProjectStore } from "@/core/store/projectStore";
import { useSiteStore } from "@/core/store/siteStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button } from "@/design-system/controls";
import { Callout, SectionLabel } from "@/design-system/data";
import { CloseIcon, ExportIcon } from "@/design-system/icons";
import {
  defaultMeta,
  exportSitesCsv,
  sitesToGeoJson,
  writeExport,
} from "@/services/export";
import "./export-modal.css";

export function ExportModal() {
  const closeModal = useUiStore((state) => state.closeModal);
  const notify = useUiStore((state) => state.notify);
  const projectName = useProjectStore((state) => state.name);
  const serialise = useProjectStore((state) => state.serialise);
  const sites = useSiteStore((state) => state.sites);

  async function exportCsv() {
    const path = await writeExport(
      `${projectName}-sites`,
      "csv",
      exportSitesCsv(sites, defaultMeta(projectName)),
    );
    if (path) notify({ tone: "success", message: `Exported sites CSV to ${path}` });
  }

  async function exportGeoJson() {
    const path = await writeExport(
      `${projectName}-sites`,
      "geojson",
      JSON.stringify(sitesToGeoJson(sites, defaultMeta(projectName)), null, 2),
    );
    if (path) notify({ tone: "success", message: `Exported sites GeoJSON to ${path}` });
  }

  async function exportProjectJson() {
    const path = await writeExport(
      projectName,
      "json",
      JSON.stringify(serialise(), null, 2),
    );
    if (path) notify({ tone: "success", message: `Exported project JSON to ${path}` });
  }

  return (
    <div className="export-modal" role="dialog" aria-modal="true" aria-label="Export project">
      <div className="export-modal__backdrop" onClick={closeModal} />
      <div className="export-modal__card">
        <header className="export-modal__head">
          <h2>Export</h2>
          <button type="button" className="export-modal__close" aria-label="Close" onClick={closeModal}>
            <CloseIcon size={16} />
          </button>
        </header>
        <p className="export-modal__lede">
          Export the current project’s sites or the full Sunday document. Design-specific array and
          rooftop exports live on the Design toolbar.
        </p>
        <SectionLabel>Sites ({sites.length})</SectionLabel>
        <div className="export-modal__actions">
          <Button icon={<ExportIcon size={13} />} onClick={() => void exportCsv()} disabled={sites.length === 0}>
            Sites CSV
          </Button>
          <Button icon={<ExportIcon size={13} />} onClick={() => void exportGeoJson()} disabled={sites.length === 0}>
            Sites GeoJSON
          </Button>
        </div>
        <SectionLabel>Project document</SectionLabel>
        <div className="export-modal__actions">
          <Button variant="primary" icon={<ExportIcon size={13} />} onClick={() => void exportProjectJson()}>
            Project JSON
          </Button>
        </div>
        {sites.length === 0 && (
          <Callout tone="note">Add a site on the Project map before exporting site tables.</Callout>
        )}
      </div>
    </div>
  );
}
