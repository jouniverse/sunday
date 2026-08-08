/**
 * Settings: API keys, data sources, datasets, preferences.
 *
 * Keys are write-only from the UI's point of view: it can say whether one is
 * configured and it can replace it, but it never displays one. Each provider
 * explains what it unlocks and links to where a key is obtained, because the
 * bring-your-own-key model only works if getting a key is frictionless.
 */

import { useEffect, useState } from "react";
import { invalidateFootprintLayerCache } from "@/core/map/footprintLayers";
import { invalidatePlantLayerCache } from "@/core/map/plantLayers";
import { invalidateResourceRasterCache } from "@/core/map/resourceRasterLayers";
import type { ApiProvider } from "@/core/platform";
import { platform, PlatformError } from "@/core/platform";
import { LAYER_CATALOGUE, useLayerStore } from "@/core/store/layerStore";
import { useSettingsStore } from "@/core/store/settingsStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Chip, Field, Input, Select, Switch } from "@/design-system/controls";
import { Callout, ParamList } from "@/design-system/data";
import { CheckIcon, ExportIcon } from "@/design-system/icons";
import { clearHttpCache, httpCacheSize } from "@/services/http/client";
import "./settings.css";

interface ProviderCard {
  id: ApiProvider;
  label: string;
  unlocks: string;
  free: string;
  url: string;
}

const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: "google_solar",
    label: "Google Solar",
    unlocks:
      "Rooftop geometry, per-panel layouts and roof flux rasters. The only metered API Sunday uses.",
    free: "Paid per request, with a monthly free allowance.",
    url: "https://developers.google.com/maps/documentation/solar/get-api-key",
  },
  {
    id: "nrel",
    label: "NREL",
    unlocks: "NSRDB solar resource and PVWatts modelled yield across the Americas.",
    free: "Free, issued instantly.",
    url: "https://developer.nrel.gov/signup/",
  },
  {
    id: "maptiler",
    label: "MapTiler",
    unlocks: "Hillshade and 3D terrain basemaps (visual relief only — not analytical slope).",
    free: "Free tier available.",
    url: "https://cloud.maptiler.com/account/keys/",
  },
];

const RASTER_INSTALL_IDS = ["gsa-ghi", "gsa-dni", "gsa-pvout"] as const;
const VECTOR_INSTALL_IDS = ["gem-solar", "tz-sam", "gmseus-arrays", "wdpa"] as const;
/** Remote AOI / site fetches — listed for provenance; no Install. */
const STREAMED_DATASET_IDS = ["terrain-slope", "landcover", "osm-power"] as const;

/** Filenames under the datasets folder (layer-label scheme; Solargis keeps GSA abbrevs). */
const NAMING_ROWS: Array<{ label: string; files: string }> = [
  { label: "GHI / DNI / PVOUT", files: "GHI.tif, DNI.tif, PVOUT.tif (or *_cog.tif)" },
  { label: "Solar power plants", files: "Solar power plants.csv, Solar power plants.jsonl" },
  {
    label: "Global PV footprints",
    files: "Global PV footprints.geojson (preferred), .gpkg",
  },
  {
    label: "US ground-mounted arrays",
    files: "US ground-mounted arrays.geojson (preferred), .gpkg",
  },
  {
    label: "Protected areas",
    files: "Protected areas.shp (+ .shx/.dbf; .prj optional, assumed WGS84), or .geojson",
  },
];

/** Prefer measured install size; omit stale catalogue guesses when unknown. */
function sizeLabelMb(
  layerId: string,
  datasets: Record<string, { downloaded?: boolean; sizeMb?: number } | undefined>,
): string | null {
  const measured = datasets[layerId]?.sizeMb;
  if (typeof measured === "number" && measured > 0) {
    return `${measured % 1 === 0 ? measured.toFixed(0) : measured.toFixed(1)} MB`;
  }
  return null;
}

export function SettingsView() {
  const settings = useSettingsStore();
  const notify = useUiStore((state) => state.notify);
  const [appInfo, setAppInfo] =
    useState<
      Awaited<ReturnType<typeof platform>["appInfo"]> extends never
        ? never
        : Awaited<ReturnType<ReturnType<typeof platform>["appInfo"]>> | null
    >(null);
  const [gdalOk, setGdalOk] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    platform()
      .appInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
    platform()
      .datasets.gdalAvailable()
      .then(setGdalOk)
      .catch(() => setGdalOk(false));
  }, []);

  const datasetsRoot = settings.preferences.datasetsRoot;

  return (
    <div className="content-view">
      <div className="content-view__inner">
        <h1 className="content-view__title">Settings</h1>
        <p className="content-view__lede">
          Sunday runs on your own credentials and your own copies of the data. Nothing here is sent
          anywhere except to the provider you are configuring.
        </p>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">API keys</h2>
          </div>
          <Callout tone="note">
            PVGIS and NASA POWER need no key and are always available, so the app is useful before
            you configure anything. Keys are stored in{" "}
            <span className="mono">{settings.settingsPath || "the app config directory"}</span> with
            owner-only permissions and never appear in a project file or an export.
          </Callout>
          {PROVIDER_CARDS.map((card) => (
            <ApiKeyRow key={card.id} card={card} />
          ))}
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Data location</h2>
          </div>
          <p className="settings__note">
            Point Sunday at one folder of downloaded datasets (and optionally a cloud COG base URL).
            Install copies or converts into the app data directory. Download links live in Help →
            Data layers and licences.
          </p>
          <Field
            label="Cloud-optimised raster base URL"
            hint="Optional. A bucket or CDN holding GHI, DNI and PVOUT as COGs."
          >
            <Input
              mono
              placeholder="https://storage.googleapis.com/your-bucket/gsa/"
              value={settings.preferences.rasterBaseUrl}
              onChange={(event) => {
                void settings.setPreferences({ rasterBaseUrl: event.target.value });
                void import("@/services/datasets/raster-sample").then((m) =>
                  m.markGsaLayersFromSettings(),
                );
              }}
            />
          </Field>
          <Field
            label="Datasets folder"
            hint="Raw downloads. Install looks for the expected filenames recursively."
          >
            <div className="settings__path-row">
              <Input
                mono
                placeholder="/Users/you/Documents/Sunday/datasets"
                value={datasetsRoot}
                onChange={(event) =>
                  void settings.setPreferences({ datasetsRoot: event.target.value })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void pickDatasetsRoot(settings, notify)}
              >
                Choose…
              </Button>
            </div>
          </Field>
          {appInfo?.rasterDir && (
            <p className="settings__note settings__note--quiet">
              Installed Solargis rasters are stored under{" "}
              <span className="mono">{appInfo.rasterDir}</span> (not in the datasets folder).
            </p>
          )}
          <Callout tone="note">
            <strong>Expected filenames</strong> (first match wins; legacy download names also work):
            <ul className="settings__naming">
              {NAMING_ROWS.map((row) => (
                <li key={row.label}>
                  <span className="mono">{row.label}</span> — {row.files}
                </li>
              ))}
            </ul>
          </Callout>
          {gdalOk === false && (
            <Callout tone="note">
              GDAL is not on PATH. Raw GeoTIFFs will be copied as-is (no COG conversion). GPKG
              footprint installs need GeoJSON instead, or install GDAL. Protected areas also need
              tippecanoe (<span className="mono">brew install tippecanoe</span>).
            </Callout>
          )}
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Solar resource rasters</h2>
          </div>
          <p className="settings__note">
            Global Solar Atlas layers are multi-gigabyte GeoTIFFs. Install from the datasets folder
            above; only pixels inside a drawn boundary are ever read.
          </p>
          {RASTER_INSTALL_IDS.map((id) => {
            const layer = LAYER_CATALOGUE.find((row) => row.id === id);
            if (!layer) return null;
            return (
              <DatasetInstallRow
                key={id}
                label={layer.label}
                meta={`${layer.source}${layer.vintage ? ` · ${layer.vintage}` : ""}`}
                sizeLabel={sizeLabelMb(id, settings.datasets)}
                downloaded={Boolean(settings.datasets[id]?.downloaded)}
                busy={installing === id}
                disabled={!datasetsRoot.trim()}
                onInstall={() =>
                  void runInstall(id, datasetsRoot, setInstalling, settings, notify, appInfo)
                }
              />
            );
          })}
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Datasets</h2>
          </div>
          <p className="settings__note">
            Uses the same datasets folder. Install (or Reinstall) into Sunday&apos;s local vector
            store so map queries stay fast. Protected areas also build{" "}
            <span className="mono">vector/protected_areas.pmtiles</span> (needs ogr2ogr +
            tippecanoe). Terrain slope and Land cover stream from AWS Open Data inside a screening
            area; Power grid streams OpenInfraMap tiles (OSM, ODbL) around a screening area or site —
            no Install.
          </p>
          {VECTOR_INSTALL_IDS.map((id) => {
            const layer = LAYER_CATALOGUE.find((row) => row.id === id);
            if (!layer) return null;
            return (
              <DatasetInstallRow
                key={id}
                label={layer.label}
                meta={`${layer.source}${layer.vintage ? ` · ${layer.vintage}` : ""}${
                  layer.licence ? ` · ${layer.licence}` : ""
                }`}
                sizeLabel={sizeLabelMb(id, settings.datasets)}
                downloaded={Boolean(settings.datasets[id]?.downloaded)}
                busy={installing === id}
                disabled={!datasetsRoot.trim()}
                onInstall={() =>
                  void runInstall(id, datasetsRoot, setInstalling, settings, notify, appInfo)
                }
              />
            );
          })}
          {STREAMED_DATASET_IDS.map((id) => {
            const layer = LAYER_CATALOGUE.find((row) => row.id === id);
            if (!layer) return null;
            return (
              <div key={id} className="settings__dataset">
                <div className="settings__dataset-main">
                  <span className="settings__dataset-name">{layer.label}</span>
                  <span className="settings__dataset-meta">
                    {layer.source}
                    {layer.vintage ? ` · ${layer.vintage}` : ""}
                    {layer.licence ? ` · ${layer.licence}` : ""}
                    {layer.sourceUrl ? ` · ${layer.sourceUrl}` : ""}
                  </span>
                </div>
                <Chip>Streamed</Chip>
              </div>
            );
          })}
          <Callout tone="warning">
            TransitionZero footprints (CC BY-NC 4.0) and WDPA (non-commercial terms) require the
            toggle below before those layers can be turned on.
          </Callout>
          <Field label="" hint="Confirms that non-commercial licensed layers may be used here.">
            <div className="settings__switch">
              <Switch
                checked={settings.preferences.acceptNonCommercialLayers}
                label="Allow non-commercial licensed layers"
                onChange={(next) =>
                  void settings.setPreferences({ acceptNonCommercialLayers: next })
                }
              />
              <span>Allow non-commercial licensed layers</span>
            </div>
          </Field>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Preferences</h2>
          </div>
          <div className="card__grid">
            <Field label="Units">
              <Select
                value={settings.preferences.units}
                onChange={(event) =>
                  void settings.setPreferences({
                    units: event.target.value as "metric" | "imperial",
                  })
                }
                options={[
                  { value: "metric", label: "Metric (m, ha, kWh)" },
                  { value: "imperial", label: "Imperial (ft, acres, kWh)" },
                ]}
              />
            </Field>
            <Field label="Currency">
              <Select
                value={settings.preferences.currency}
                onChange={(event) => void settings.setPreferences({ currency: event.target.value })}
                options={[
                  { value: "USD", label: "US dollar" },
                  { value: "EUR", label: "Euro" },
                  { value: "GBP", label: "Pound sterling" },
                ]}
              />
            </Field>
          </div>
          <Field
            label=""
            hint="When the solar engine is unavailable, show a clearly labelled first-order estimate instead of nothing."
          >
            <div className="settings__switch">
              <Switch
                checked={settings.preferences.allowFirstOrderFallback}
                label="Allow first-order fallback estimates"
                onChange={(next) => void settings.setPreferences({ allowFirstOrderFallback: next })}
              />
              <span>Allow first-order fallback estimates</span>
            </div>
          </Field>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Solar engine</h2>
          </div>
          <p className="settings__note">
            The solar engine is a local Python sidecar (pvlib) on port 8787. Start it from here, or
            with <code>npm run engine:dev</code> in a terminal. Start/Stop only manage that local
            process — they are not a cloud service. Status reflects a live <code>/health</code>{" "}
            probe. Without the engine, Sunday still works and labels results as first-order
            estimates.
          </p>
          <ParamList
            rows={[
              {
                key: "state",
                label: "State",
                value: appInfo?.engine.state ?? "unknown",
                tone: appInfo?.engine.state === "ready" ? "accent" : "muted",
              },
              { key: "url", label: "Address", value: appInfo?.engine.baseUrl ?? "—" },
              {
                key: "pvlib",
                label: "pvlib version",
                value: appInfo?.engine.pvlibVersion ?? "—",
              },
            ]}
          />
          {appInfo?.engine.detail && <Callout tone="note">{appInfo.engine.detail}</Callout>}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <Button
              onClick={async () => {
                const status = await platform().engine.start();
                notify({
                  tone: status.state === "ready" ? "success" : "warning",
                  message: `Solar engine is ${status.state}`,
                  detail: status.detail ?? undefined,
                });
                window.dispatchEvent(new Event("sunday:engine-changed"));
                platform()
                  .appInfo()
                  .then(setAppInfo)
                  .catch(() => undefined);
              }}
            >
              Start solar engine
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                const status = await platform().engine.stop();
                notify({
                  tone: "info",
                  message: `Solar engine is ${status.state}`,
                  detail:
                    status.detail ??
                    "Only an engine Sunday started is stopped; an external `npm run engine:dev` process is left running.",
                });
                window.dispatchEvent(new Event("sunday:engine-changed"));
                platform()
                  .appInfo()
                  .then(setAppInfo)
                  .catch(() => undefined);
              }}
            >
              Stop solar engine
            </Button>
          </div>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Storage and cache</h2>
          </div>
          <ParamList
            rows={[
              { key: "data", label: "Data directory", value: appInfo?.dataDir ?? "—" },
              {
                key: "rasters",
                label: "Installed rasters",
                value: appInfo?.rasterDir ?? "—",
              },
              { key: "config", label: "Settings file", value: settings.settingsPath || "—" },
              { key: "cache", label: "Cached API responses", value: String(httpCacheSize()) },
            ]}
          />
          <Button
            icon={<ExportIcon size={13} />}
            onClick={() => {
              clearHttpCache();
              notify({ tone: "success", message: "Cached API responses cleared" });
            }}
          >
            Clear the response cache
          </Button>
        </div>
      </div>
    </div>
  );
}

function DatasetInstallRow({
  label,
  meta,
  sizeLabel,
  downloaded,
  busy,
  disabled,
  onInstall,
}: {
  label: string;
  meta: string;
  /** Measured size after Install; omitted when unknown (no stale catalogue guesses). */
  sizeLabel: string | null;
  downloaded: boolean;
  busy: boolean;
  disabled: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="settings__dataset">
      <div className="settings__dataset-main">
        <span className="settings__dataset-name">{label}</span>
        <span className="settings__dataset-meta">{meta}</span>
      </div>
      {sizeLabel && <Chip dot={false}>{sizeLabel}</Chip>}
      {downloaded && (
        <Chip tone="ok">
          <CheckIcon size={11} /> Installed
        </Chip>
      )}
      <Button size="sm" disabled={disabled || busy} onClick={onInstall}>
        {busy ? "Installing…" : downloaded ? "Reinstall" : "Install"}
      </Button>
    </div>
  );
}

async function pickDatasetsRoot(
  settings: ReturnType<typeof useSettingsStore.getState>,
  notify: ReturnType<typeof useUiStore.getState>["notify"],
): Promise<void> {
  try {
    const path = await platform().datasets.pickDirectory();
    if (!path) return;
    await settings.setPreferences({ datasetsRoot: path });
    notify({ tone: "success", message: "Datasets folder set", detail: path });
  } catch (error) {
    notify({
      tone: "error",
      message: "Could not choose a folder",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runInstall(
  datasetId: string,
  root: string,
  setInstalling: (id: string | null) => void,
  settings: ReturnType<typeof useSettingsStore.getState>,
  notify: ReturnType<typeof useUiStore.getState>["notify"],
  appInfo: Awaited<ReturnType<ReturnType<typeof platform>["appInfo"]>> | null,
): Promise<void> {
  if (!root.trim()) {
    notify({
      tone: "warning",
      message: "Choose a datasets folder first",
      detail: "Settings → Data location → Datasets folder.",
    });
    return;
  }

  const wasInstalled = Boolean(settings.datasets[datasetId]?.downloaded);
  setInstalling(datasetId);
  try {
    const found = await platform().datasets.discover(root, datasetId);
    if (!found.path) {
      notify({
        tone: "warning",
        message: `No file found for ${datasetId}`,
        detail: `Looked for: ${found.expected.join(", ")}. Place one under the datasets folder and try again.`,
      });
      return;
    }

    const result = await platform().datasets.install(datasetId, found.path);
    await settings.setDatasetState(datasetId, {
      downloaded: true,
      path: result.installedPath,
      sizeMb: Math.round(result.sizeMb * 10) / 10,
    });
    useLayerStore.getState().markAvailable(datasetId);

    if (datasetId.startsWith("gsa-")) {
      const rasterDir = appInfo?.rasterDir?.trim();
      if (rasterDir) {
        await settings.setPreferences({ rasterLocalDir: rasterDir });
      }
      if (
        datasetId === "gsa-ghi" ||
        datasetId === "gsa-dni" ||
        datasetId === "gsa-pvout"
      ) {
        invalidateResourceRasterCache(datasetId);
      }
    }

    if (datasetId === "gem-solar") {
      invalidatePlantLayerCache();
    }
    if (datasetId === "tz-sam" || datasetId === "gmseus-arrays") {
      invalidateFootprintLayerCache(datasetId);
    }

    const count =
      result.featureCount != null
        ? `${result.featureCount.toLocaleString()} features`
        : `${result.sizeMb.toFixed(1)} MB`;
    notify({
      tone: "success",
      message: `${wasInstalled ? "Reinstalled" : "Installed"} ${datasetId}`,
      detail: `${result.detail} (${count}${result.usedGdal ? "; used GDAL" : ""}).`,
    });
  } catch (error) {
    const detail =
      error instanceof PlatformError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    notify({
      tone: "error",
      message: `Install failed for ${datasetId}`,
      detail,
    });
  } finally {
    setInstalling(null);
  }
}

/** One provider's key row. Shows configured state, never the value. */
function ApiKeyRow({ card }: { card: ProviderCard }) {
  const configured = useSettingsStore((state) => state.configuredKeys.includes(card.id));
  const setApiKey = useSettingsStore((state) => state.setApiKey);
  const notify = useUiStore((state) => state.notify);
  const [draft, setDraft] = useState("");

  return (
    <div className="settings__provider">
      <div className="settings__provider-head">
        <span className="settings__provider-name">{card.label}</span>
        {configured ? (
          <Chip tone="ok">
            <CheckIcon size={11} /> Configured
          </Chip>
        ) : (
          <Chip>Not configured</Chip>
        )}
      </div>
      <p className="settings__note">{card.unlocks}</p>
      <p className="settings__note settings__note--quiet">
        {card.free}{" "}
        <button
          type="button"
          className="settings__link"
          onClick={() => void platform().shell.openExternal(card.url)}
        >
          Get a key
        </button>
      </p>
      <div className="settings__key-row">
        <Input
          mono
          type="password"
          autoComplete="off"
          placeholder={configured ? "Replace the stored key" : "Paste the key"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          disabled={draft.trim().length === 0}
          onClick={async () => {
            await setApiKey(card.id, draft.trim());
            setDraft("");
            notify({ tone: "success", message: `${card.label} key saved` });
          }}
        >
          Save
        </Button>
        {configured && (
          <Button
            variant="danger"
            onClick={async () => {
              await setApiKey(card.id, null);
              notify({ tone: "info", message: `${card.label} key removed` });
            }}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
