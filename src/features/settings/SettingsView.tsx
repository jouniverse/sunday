/**
 * Settings: API keys, data sources, datasets, preferences.
 *
 * Keys are write-only from the UI's point of view: it can say whether one is
 * configured and it can replace it, but it never displays one. Each provider
 * explains what it unlocks and links to where a key is obtained, because the
 * bring-your-own-key model only works if getting a key is frictionless.
 */

import { useEffect, useState } from "react";
import { invalidatePlantLayerCache } from "@/core/map/plantLayers";
import type { ApiProvider, VectorFeature } from "@/core/platform";
import { platform } from "@/core/platform";
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
    url: "https://developer.nlr.gov/signup/",
  },
  {
    id: "maptiler",
    label: "MapTiler",
    unlocks: "Hillshade and 3D terrain basemaps, and the terrain slope layer.",
    free: "Free tier available.",
    url: "https://cloud.maptiler.com/account/keys/",
  },
];

export function SettingsView() {
  const settings = useSettingsStore();
  const notify = useUiStore((state) => state.notify);
  const [appInfo, setAppInfo] =
    useState<
      Awaited<ReturnType<typeof platform>["appInfo"]> extends never
        ? never
        : Awaited<ReturnType<ReturnType<typeof platform>["appInfo"]>> | null
    >(null);

  useEffect(() => {
    platform()
      .appInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);

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
            <h2 className="card__title">Solar resource rasters</h2>
          </div>
          <p className="settings__note">
            Global Solar Atlas layers are multi-gigabyte GeoTIFFs, so Sunday never bundles them.
            Point it at cloud-optimised copies over HTTP, or at a local directory holding your own
            download. Either way only the pixels inside a drawn boundary are ever read.
          </p>
          <Field
            label="Cloud-optimised raster base URL"
            hint="For example a bucket holding GHI, DNI and PVOUT as COGs."
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
            label="Local raster directory"
            hint="A folder of GeoTIFFs (GHI.tif / GHI_cog.tif, etc.)."
          >
            <Input
              mono
              placeholder="/Users/you/Documents/Sunday/rasters"
              value={settings.preferences.rasterLocalDir}
              onChange={(event) => {
                void settings.setPreferences({ rasterLocalDir: event.target.value });
                void import("@/services/datasets/raster-sample").then((m) =>
                  m.markGsaLayersFromSettings(),
                );
              }}
            />
          </Field>
        </div>

        <div className="card">
          <div className="card__head">
            <h2 className="card__title">Datasets</h2>
          </div>
          <p className="settings__note">
            Optional downloads. Sunday preprocesses each one into an indexed local store so map
            queries stay fast; see <span className="mono">scripts/data-pipeline</span> for the
            conversion steps.
          </p>
          {LAYER_CATALOGUE.filter((layer) => layer.availability.state === "needs-download").map(
            (layer) => {
              const dataset =
                layer.availability.state === "needs-download"
                  ? layer.availability.dataset
                  : layer.id;
              const state = settings.datasets[dataset];
              return (
                <div key={layer.id} className="settings__dataset">
                  <div className="settings__dataset-main">
                    <span className="settings__dataset-name">{layer.label}</span>
                    <span className="settings__dataset-meta">
                      {layer.source}
                      {layer.vintage && ` · ${layer.vintage}`}
                      {layer.licence && ` · ${layer.licence}`}
                    </span>
                  </div>
                  {layer.availability.state === "needs-download" &&
                    layer.availability.approximateMb > 0 && (
                      <Chip dot={false}>~{layer.availability.approximateMb} MB</Chip>
                    )}
                  {state?.downloaded ? (
                    <Chip tone="ok">
                      <CheckIcon size={11} /> Installed
                    </Chip>
                  ) : dataset === "gem-solar" ? (
                    <Button
                      size="sm"
                      onClick={() => void importGemJsonl(useSettingsStore.getState(), notify)}
                    >
                      Import JSONL
                    </Button>
                  ) : (
                    <Chip>Not installed</Chip>
                  )}
                </div>
              );
            },
          )}
          <Callout tone="note">
            Convert the GEM CSV with{" "}
            <span className="mono">node scripts/data-pipeline/import-gem.mjs</span>, then import the
            resulting JSONL here. Country rankings ship bundled and need no install.
          </Callout>
          <Callout tone="warning">
            TransitionZero's global footprint layer is licensed CC BY-NC 4.0. Enable it only if
            non-commercial use applies to you.
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

async function importGemJsonl(
  settings: ReturnType<typeof useSettingsStore.getState>,
  notify: ReturnType<typeof useUiStore.getState>["notify"],
): Promise<void> {
  // Browser File System Access when available; otherwise a classic file input.
  let text: string | null = null;
  const picker = (
    window as Window & {
      showOpenFilePicker?: (options: {
        types: Array<{ description: string; accept: Record<string, string[]> }>;
        multiple?: boolean;
      }) => Promise<Array<{ getFile: () => Promise<File> }>>;
    }
  ).showOpenFilePicker;

  try {
    if (picker) {
      const handles = await picker({
        multiple: false,
        types: [
          {
            description: "GEM JSONL",
            accept: { "application/x-ndjson": [".jsonl"], "application/json": [".json", ".jsonl"] },
          },
        ],
      });
      const handle = handles[0];
      if (!handle) return;
      text = await (await handle.getFile()).text();
    } else {
      text = await new Promise<string | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".jsonl,.json,application/x-ndjson";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          void file.text().then(resolve);
        };
        input.click();
      });
    }
  } catch (error) {
    // User cancelled the picker.
    if (error instanceof DOMException && error.name === "AbortError") return;
    notify({
      tone: "error",
      message: "Could not open the GEM file",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!text) return;

  const features: VectorFeature[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      features.push(JSON.parse(line) as VectorFeature);
    } catch {
      notify({
        tone: "error",
        message: "Invalid JSONL",
        detail:
          "Each line must be one GEM feature object from scripts/data-pipeline/import-gem.mjs.",
      });
      return;
    }
  }

  if (features.length === 0) {
    notify({ tone: "warning", message: "The file contained no features" });
    return;
  }

  try {
    const BATCH = 2_000;
    let imported = 0;
    for (let i = 0; i < features.length; i += BATCH) {
      const chunk = features.slice(i, i + BATCH);
      imported += await platform().vector.importFeatures({
        dataset: "gem-solar",
        source: "Global Energy Monitor, Global Solar Power Tracker",
        vintage: "2026-02",
        license: "CC BY 4.0",
        features: chunk,
      });
    }
    await settings.setDatasetState("gem-solar", {
      downloaded: true,
      sizeMb: Math.round((text.length / (1024 * 1024)) * 10) / 10,
    });
    useLayerStore.getState().markAvailable("gem-solar");
    invalidatePlantLayerCache();
    notify({
      tone: "success",
      message: `Imported ${imported.toLocaleString()} GEM plants`,
      detail: "Turn on the Solar power plants layer to see them on the map.",
    });
  } catch (error) {
    notify({
      tone: "error",
      message: "GEM import failed",
      detail: error instanceof Error ? error.message : String(error),
    });
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
