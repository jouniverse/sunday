/**
 * Unified design export control: pick a format, then export.
 */

import { useState } from "react";
import { Button, Select } from "@/design-system/controls";
import { ExportIcon } from "@/design-system/icons";

export type DesignExportFormat = "zip" | "geojson" | "json" | "html" | "csv";

const OPTIONS: Array<{ value: DesignExportFormat; label: string }> = [
  { value: "zip", label: "ZIP (all)" },
  { value: "geojson", label: "GeoJSON" },
  { value: "json", label: "JSON" },
  { value: "html", label: "HTML" },
  { value: "csv", label: "CSV" },
];

export function DesignExportMenu({
  onExport,
  busy = false,
}: {
  onExport: (format: DesignExportFormat) => void | Promise<void>;
  busy?: boolean;
}) {
  const [format, setFormat] = useState<DesignExportFormat>("html");

  return (
    <div className="design-export-menu">
      <Select
        aria-label="Export format"
        value={format}
        onChange={(event) => setFormat(event.target.value as DesignExportFormat)}
        options={OPTIONS}
      />
      <Button
        size="sm"
        icon={<ExportIcon size={12} />}
        disabled={busy}
        onClick={() => void onExport(format)}
      >
        Export
      </Button>
    </div>
  );
}
