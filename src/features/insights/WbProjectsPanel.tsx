/**
 * Insights WB Projects: World Bank Projects API v3 solar list.
 */

import { useEffect, useState } from "react";
import { Button, Select } from "@/design-system/controls";
import { Callout, DataGrid } from "@/design-system/data";
import {
  fetchWbSolarProjects,
  formatUsd,
  type WbProject,
  type WbSortField,
} from "@/services/insights/wb-projects";

export function WbProjectsPanel() {
  const [sort, setSort] = useState<WbSortField>("proj_last_upd_date");
  const [projects, setProjects] = useState<WbProject[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    // reloadToken forces a manual refresh without changing sort.
    void reloadToken;
    void fetchWbSolarProjects({ sort, rows: 500 })
      .then((result) => {
        if (cancelled) return;
        setProjects(result.projects);
        setTotal(result.total);
        setSelectedId((prev) => {
          if (prev && result.projects.some((p) => p.id === prev)) return prev;
          return result.projects[0]?.id ?? null;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setProjects([]);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sort, reloadToken]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <>
      <div className="insights__main-head">
        <div>
          <h2 className="insights__title">World Bank projects</h2>
          <p className="insights__lede">
            Solar-sector projects from the World Bank Projects API v3 (no API key). Amounts are USD.
            Sector filter: FY17 — Renewable Energy Solar.
          </p>
        </div>
        <div className="insights__toolbar">
          <Select
            value={sort}
            onChange={(event) => setSort(event.target.value as WbSortField)}
            options={[
              { value: "proj_last_upd_date", label: "Last updated" },
              { value: "boardapprovaldate", label: "Approval date" },
              { value: "totalamt", label: "Total amount" },
            ]}
          />
          <Button onClick={() => setReloadToken((n) => n + 1)} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <Callout tone="warning">
          {error}. Check the network, then Refresh. Offline, this list cannot load.
        </Callout>
      )}

      {selected && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card__head">
            <h2 className="card__title">{selected.projectName}</h2>
          </div>
          <dl className="insights__wb-detail">
            <dt>Project ID</dt>
            <dd className="mono">{selected.id}</dd>
            <dt>Country / region</dt>
            <dd>
              {selected.country} · {selected.region}
            </dd>
            <dt>Status</dt>
            <dd>{selected.status}</dd>
            <dt>Total amount</dt>
            <dd>{formatUsd(selected.totalAmt)}</dd>
            <dt>Commitment</dt>
            <dd>{formatUsd(selected.commitmentAmt)}</dd>
            <dt>Board approval</dt>
            <dd>{selected.boardApprovalDate ?? "—"}</dd>
            <dt>Closing</dt>
            <dd>{selected.closingDate ?? "—"}</dd>
            <dt>Last updated</dt>
            <dd>{selected.lastUpdated ?? "—"}</dd>
            {selected.pdo && (
              <>
                <dt>Development objective</dt>
                <dd>{selected.pdo}</dd>
              </>
            )}
            <dt>Link</dt>
            <dd>
              <a href={selected.url} target="_blank" rel="noreferrer">
                Open on World Bank
              </a>
            </dd>
          </dl>
        </div>
      )}

      <DataGrid
        caption={`Solar projects (${projects.length}${total ? ` of ${total}` : ""})`}
        columns={[
          { key: "name", header: "Title", render: (row) => row.projectName },
          { key: "country", header: "Country", render: (row) => row.country },
          { key: "status", header: "Status", render: (row) => row.status },
          {
            key: "amount",
            header: "Total (USD)",
            numeric: true,
            render: (row) => formatUsd(row.totalAmt),
          },
          {
            key: "updated",
            header: "Updated",
            render: (row) => row.lastUpdated?.slice(0, 10) ?? "—",
          },
        ]}
        rows={projects}
        rowKey={(row) => row.id}
        onRowClick={(row) => setSelectedId(row.id)}
      />
    </>
  );
}
