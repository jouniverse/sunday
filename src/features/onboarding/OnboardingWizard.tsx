/**
 * First-run setup.
 *
 * The rule from the design discussion: never drop someone onto an empty map with
 * broken features. The map works immediately with no configuration; this explains
 * what each optional credential or dataset unlocks, and every step can be skipped.
 */

import { useState } from "react";
import { platform } from "@/core/platform";
import { useSettingsStore } from "@/core/store/settingsStore";
import { useUiStore } from "@/core/store/uiStore";
import { Button, Chip, Input } from "@/design-system/controls";
import { Callout } from "@/design-system/data";
import { CheckIcon, CloseIcon, SunIcon } from "@/design-system/icons";
import { IconButton } from "@/design-system/controls";
import "./onboarding.css";

interface Step {
  id: string;
  title: string;
  body: string;
  /** Null for steps that need nothing configured. */
  provider: "nrel" | "google_solar" | "maptiler" | null;
  unlocks: string[];
  keyUrl?: string;
}

const STEPS: Step[] = [
  {
    id: "map",
    title: "The map works now",
    body:
      "MapLibre basemaps, boundary drawing, area measurement and the screening checks need no " +
      "credentials at all. So do PVGIS and NASA POWER, which cover the whole world between them. " +
      "Everything below is optional.",
    provider: null,
    unlocks: [
      "Draw sites and measure them",
      "PVGIS and NASA POWER resource reports",
      "Screening checks and system design",
    ],
  },
  {
    id: "nrel",
    title: "NREL, for the Americas",
    body:
      "A free key, issued instantly, adds the National Solar Radiation Database and PVWatts. " +
      "Where it has coverage it is the highest-fidelity free source available.",
    provider: "nrel",
    unlocks: ["NSRDB measured resource", "PVWatts modelled yield"],
    keyUrl: "https://developer.nlr.gov/signup/",
  },
  {
    id: "google_solar",
    title: "Google Solar, for rooftops",
    body:
      "Per-building roof geometry and flux rasters. This is the one metered API Sunday uses, so it " +
      "is only ever called when you explicitly ask for a building.",
    provider: "google_solar",
    unlocks: ["Roof segment geometry", "Reviewable panel layouts", "Roof flux and shade rasters"],
    keyUrl: "https://developers.google.com/maps/documentation/solar/get-api-key",
  },
  {
    id: "terrain",
    title: "Terrain, for slope and aspect",
    body:
      "A MapTiler key adds hillshade and 3D terrain basemaps, and the slope layer the screening " +
      "checks read for grading risk.",
    provider: "maptiler",
    unlocks: ["Hillshade and 3D terrain", "Slope and aspect sampling"],
    keyUrl: "https://cloud.maptiler.com/account/keys/",
  },
  {
    id: "rasters",
    title: "Solar resource rasters",
    body:
      "Global Solar Atlas layers are multi-gigabyte GeoTIFFs, so Sunday never bundles them. Point " +
      "it at cloud-optimised copies or a local download later, in Settings — only the pixels inside " +
      "a drawn boundary are ever read.",
    provider: null,
    unlocks: ["Irradiation overlays on the map", "Exact statistics over a drawn boundary"],
  },
];

export function OnboardingWizard() {
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const closeModal = useUiStore((state) => state.closeModal);
  const notify = useUiStore((state) => state.notify);
  const configuredKeys = useSettingsStore((state) => state.configuredKeys);
  const setApiKey = useSettingsStore((state) => state.setApiKey);
  const completeOnboarding = useSettingsStore((state) => state.completeOnboarding);

  const step = STEPS[index] as Step;
  const isLast = index === STEPS.length - 1;
  const configured = step.provider ? configuredKeys.includes(step.provider) : true;

  async function finish() {
    await completeOnboarding();
    closeModal();
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Sunday setup">
      <div className="modal onboarding">
        <div className="modal__head">
          <h2 className="modal__title">
            <SunIcon size={16} /> Set up Sunday
          </h2>
          <IconButton label="Skip setup" onClick={finish}>
            <CloseIcon size={14} />
          </IconButton>
        </div>

        <div className="modal__body">
          <ol className="onboarding__progress">
            {STEPS.map((entry, entryIndex) => {
              const done =
                entryIndex < index ||
                (entry.provider !== null && configuredKeys.includes(entry.provider));
              return (
                <li
                  key={entry.id}
                  className={`onboarding__progress-item${entryIndex === index ? " onboarding__progress-item--current" : ""}`}
                >
                  <span className="onboarding__progress-marker">
                    {done ? <CheckIcon size={11} /> : entryIndex + 1}
                  </span>
                  {entry.title}
                </li>
              );
            })}
          </ol>

          <h3 className="onboarding__title">{step.title}</h3>
          <p className="onboarding__body">{step.body}</p>

          <div className="onboarding__unlocks">
            {step.unlocks.map((unlock) => (
              <Chip key={unlock} tone={step.provider === null || configured ? "ok" : "neutral"}>
                {unlock}
              </Chip>
            ))}
          </div>

          {step.provider && (
            <>
              {configured ? (
                <Callout tone="info">
                  A key is already configured for this provider. You can replace it in Settings at any
                  time.
                </Callout>
              ) : (
                <div className="onboarding__key">
                  <Input
                    mono
                    type="password"
                    autoComplete="off"
                    placeholder="Paste the key, or skip and add it later"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <Button
                    disabled={draft.trim().length === 0}
                    onClick={async () => {
                      if (!step.provider) return;
                      await setApiKey(step.provider, draft.trim());
                      setDraft("");
                      notify({ tone: "success", message: `${step.title} configured` });
                    }}
                  >
                    Save
                  </Button>
                  {step.keyUrl && (
                    <Button
                      variant="ghost"
                      onClick={() => void platform().shell.openExternal(step.keyUrl as string)}
                    >
                      Get a key
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal__foot">
          <Button variant="ghost" onClick={finish}>
            Skip the rest
          </Button>
          <div style={{ flex: 1 }} />
          {index > 0 && (
            <Button
              onClick={() => {
                setDraft("");
                setIndex(index - 1);
              }}
            >
              Back
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => {
              setDraft("");
              if (isLast) void finish();
              else setIndex(index + 1);
            }}
          >
            {isLast ? "Start using Sunday" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
