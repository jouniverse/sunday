/**
 * Help and method documentation.
 *
 * Method documentation is a product feature here, not an afterthought. A tool
 * that produces engineering numbers has to be able to say where each one comes
 * from, and a professional deciding whether to trust it needs to read that
 * without opening the source.
 */

import { platform } from "@/core/platform";
import { LAYER_CATALOGUE } from "@/core/store/layerStore";
import { useUiStore } from "@/core/store/uiStore";
import { PROVIDERS } from "@/services/solar/types";
import { GCR_PRIORS, LAND_USE_M2_PER_KW, SYSTEM_LOSS_DEFAULTS } from "@/domain/packing/priors";
import { Callout, DataGrid, SectionLabel } from "@/design-system/data";
import "./help.css";

async function openSourceUrl(url: string): Promise<void> {
  try {
    await platform().shell.openExternal(url);
  } catch (error) {
    useUiStore.getState().notify({
      tone: "error",
      message: "Could not open the link",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function HelpView() {
  return (
    <div className="content-view">
      <div className="content-view__inner">
        <h1 className="content-view__title">Help and methods</h1>
        <p className="content-view__lede">
          What Sunday computes, how, and where the numbers come from. Every figure in the app can be
          traced to something on this page.
        </p>
        <p className="help__body">
          This beta covers <strong>greenfield PV</strong>, <strong>rooftop PV</strong>, and{" "}
          <strong>concentrating solar power</strong> (power tower and parabolic trough). Screening
          technology chips (PV fixed, tracker, CSP, rooftop) are independent of the System family
          that routes Design. Solar water heating is not in this release.
        </p>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Getting started</h2>
          </div>
          <ol className="help__steps">
            <li>
              <strong>Find a location.</strong> Search a place name, or type coordinates directly as{" "}
              <span className="mono">35.05, -118.17</span>. Coordinate entry never geocodes.
            </li>
            <li>
              <strong>Mark it or draw it.</strong> Mark a location for a resource report. Draw a
              boundary when you want a system design: click to add corners, Enter to finish, Escape
              to cancel. Drag a corner to move it, drag a midpoint to add one.
            </li>
            <li>
              <strong>Fetch the resource.</strong> PVGIS and NASA POWER answer without a key. The
              report shows every source that answered, side by side.
            </li>
            <li>
              <strong>Run the screening checks.</strong> Choose a screening profile (PV fixed,
              tracker, CSP, or rooftop). Slope, aspect, resource floors, protected areas and grid
              distance each carry the basis for their threshold.
            </li>
            <li>
              <strong>Design the system.</strong> Set the System family (PV, rooftop PV, or CSP),
              then open Design. Automation proposes a feasible envelope; you adjust inside it.
              Greenfield PV packing, rooftop local packing (optional Google Solar), and CSP field
              sketches are separate workspaces.
            </li>
            <li>
              <strong>Read Report and Insights.</strong> Report is multi-source climatology, sun path
              with far-field terrain horizon, and cloud amount. Insights is portfolio, rankings,
              statistics, news, World Bank projects, and research — not a substitute for Design.
            </li>
          </ol>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Solar resource sources</h2>
          </div>
          <DataGrid
            caption="Solar data providers"
            columns={[
              { key: "label", header: "Provider", render: (row) => row.label },
              { key: "dataset", header: "Dataset", render: (row) => row.dataset },
              { key: "resolution", header: "Resolution", render: (row) => row.resolution },
              { key: "coverage", header: "Coverage", render: (row) => row.coverage },
              {
                key: "key",
                header: "Key",
                render: (row) => (row.requiresKey ? "Required" : "Not needed"),
              },
              {
                key: "docs",
                header: "Docs",
                render: (row) => (
                  <button
                    type="button"
                    className="help__link"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void openSourceUrl(row.documentation);
                    }}
                  >
                    Open
                  </button>
                ),
              },
            ]}
            rows={Object.values(PROVIDERS)}
            rowKey={(row) => row.id}
          />
          <Callout tone="note">
            Where two sources disagree by more than 10%, Sunday flags it and shows both. It never
            averages them: the difference is information about how well the location is characterised.
          </Callout>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">How yield is calculated</h2>
          </div>
          <p className="help__body">
            When the solar engine is running, annual output comes from a{" "}
            <strong>pvlib model chain</strong>: NREL's solar position algorithm, Hay-Davies
            transposition onto the array plane, the Sandia cell-temperature model, and the PVWatts DC
            and inverter models. Results are labelled <em>modelled</em> and cite the pvlib version.
          </p>
          <p className="help__body">
            Without the engine, Sunday falls back to a transparent first-order estimate: annual
            in-plane irradiation times capacity times a performance ratio, with the transposition
            factor derived geometrically. It is labelled <em>first-order</em> everywhere it appears,
            and the breakdown shows every term. It is a sanity check, not a substitute.
          </p>
          <p className="help__body">
            CSP annual energy comes from PySAM (SAM SSC) in the same sidecar when{" "}
            <span className="mono">nrel-pysam</span> is installed. Sunday does not invent a CSP
            megawatt-hour: without PySAM the plant estimate stays blank. Report sun-path traces use
            NREL SPA via pvlib; the far-field horizon overlay is AWS Terrarium terrain, not trees or
            buildings.
          </p>
          <p className="help__body">
            Rooftop Design with Google Solar can show three annual figures at once; they are
            different quantities. The top-right <strong>Annual DC</strong> is the sum of Google's
            per-panel <span className="mono">yearlyEnergyDcKwh</span> for currently active panels,
            scaled to the Module dropdown (your module watts ÷ Google's reference panel watts). The{" "}
            <strong>configuration ladder</strong> is Google's own discrete configs: DC energy at
            Google's reference panel, not scaled to your module. <strong>Last estimate</strong> is AC
            from the pvlib model chain (or the labelled first-order fallback), using the selected
            module, tilt and azimuth from the first roof segment or the site resource, and the
            current active capacity. Specific yield from that run does not depend on panel count, so
            selected and full-layout annuals are specific yield times the corresponding kW. Local
            packing has no Google DC figure: the top-right annual is the last estimate on the
            selected (active) modules.
          </p>
          <SectionLabel>Default loss stack</SectionLabel>
          <p className="help__body">
            Losses compound rather than add. The defaults follow the PVWatts loss stack:{" "}
            {Object.entries(SYSTEM_LOSS_DEFAULTS)
              .filter(([key]) => key !== "source")
              .map(([key, value]) => `${key} ${((value as number) * 100).toFixed(1)}%`)
              .join(", ")}
            . Source: {SYSTEM_LOSS_DEFAULTS.source}.
          </p>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">How layouts and fill factor are calculated</h2>
          </div>
          <p className="help__body">
            Ground coverage ratio is collector width over row pitch. Sunday derives the feasible
            range from shadow geometry — the pitch needed to clear row-to-row shading down to the
            winter solstice noon sun altitude at the site's latitude — and the recommended band from
            what built projects actually do, measured across the GM-SEUS inventory of US arrays.
          </p>
          <DataGrid
            caption="Ground coverage ratio by mount type"
            columns={[
              { key: "mount", header: "Mount", render: (row) => row.mount },
              { key: "range", header: "Feasible", render: (row) => `${row.min} – ${row.max}` },
              {
                key: "band",
                header: "Recommended",
                render: (row) => `${row.recommendedMin} – ${row.recommendedMax}`,
              },
              { key: "typical", header: "Typical", numeric: true, render: (row) => row.typical },
              { key: "source", header: "Source", render: (row) => row.source },
            ]}
            rows={Object.entries(GCR_PRIORS).map(([mount, prior]) => ({
              mount: mount.replace("_", " "),
              ...prior,
            }))}
            rowKey={(row) => row.mount}
          />
          <p className="help__body">
            Land use is reported two ways, because conflating them is a common source of wrong
            numbers. <strong>Array-block area</strong> is what a drawn boundary represents, typically{" "}
            {LAND_USE_M2_PER_KW.directMin}–{LAND_USE_M2_PER_KW.directMax} m²/kW.{" "}
            <strong>Total project area</strong> adds roads, pads and setbacks, roughly{" "}
            {LAND_USE_M2_PER_KW.totalToDirectRatio}× more, which is what the familiar 5–10 acres per
            megawatt rule of thumb refers to.
          </p>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">What the screening checks do and do not do</h2>
          </div>
          <p className="help__body">
            The checks apply the hard exclusions and soft criteria that appear across the GIS
            multi-criteria siting literature: slope and aspect, resource floors, protected areas,
            land cover, and distance to mapped grid infrastructure. Each result names the basis for
            its threshold so you can disagree with a specific number.
          </p>
          <Callout tone="warning">
            Distance to a mapped power line is not hosting capacity. Whether a network can accept a
            project is a study Sunday does not attempt, and mapped infrastructure coverage is
            incomplete. Screening is also not a substitute for geotechnical survey, land tenure
            research or environmental impact assessment.
          </Callout>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Data layers and licences</h2>
          </div>
          <p className="help__body">
            Download optional layers into one datasets folder, then Install from Settings. Filenames
            should match the layer name (for example{" "}
            <span className="mono">Global PV footprints.geojson</span>); Solargis rasters keep{" "}
            <span className="mono">GHI.tif</span> / <span className="mono">DNI.tif</span> /{" "}
            <span className="mono">PVOUT.tif</span>.
          </p>
          <DataGrid
            caption="Data layer licences"
            columns={[
              { key: "label", header: "Layer", render: (row) => row.label },
              {
                key: "source",
                header: "Source",
                render: (row) =>
                  row.sourceUrl ? (
                    <a
                      className="help__link"
                      href={row.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void openSourceUrl(row.sourceUrl!);
                      }}
                    >
                      {row.source}
                    </a>
                  ) : (
                    row.source
                  ),
              },
              { key: "vintage", header: "Vintage", render: (row) => row.vintage ?? "—" },
              { key: "licence", header: "Licence", render: (row) => row.licence ?? "—" },
            ]}
            rows={LAYER_CATALOGUE.filter((layer) => layer.id !== "sites")}
            rowKey={(row) => row.id}
          />
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Keyboard</h2>
          </div>
          <DataGrid
            caption="Keyboard shortcuts"
            columns={[
              { key: "keys", header: "Keys", render: (row) => <span className="mono">{row.keys}</span> },
              { key: "action", header: "Action", render: (row) => row.action },
            ]}
            rows={[
              { keys: "Enter", action: "Finish the boundary being drawn" },
              { keys: "Escape", action: "Cancel drawing, or clear the current tool" },
              { keys: "Backspace", action: "Remove the last corner, or the selected corner" },
              { keys: "Cmd Z", action: "Undo a drawing change" },
              { keys: "Shift Cmd Z", action: "Redo a drawing change" },
            ]}
            rowKey={(row) => row.keys}
          />
        </div>
      </div>
    </div>
  );
}
