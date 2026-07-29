/**
 * Application root: the fixed shell and the view router.
 *
 * The map view stays mounted for the whole session even when another view is on
 * top of it. Re-creating a MapLibre instance on every tab change would throw away
 * the tile cache and the camera, which is the kind of small carelessness that
 * makes a desktop app feel slow.
 */

import { useEffect } from "react";
import { platform } from "@/core/platform";
import { useSettingsStore } from "@/core/store/settingsStore";
import { useUiStore } from "@/core/store/uiStore";
import { AnalyticsView } from "@/features/analytics/AnalyticsView";
import { DesignView } from "@/features/design/DesignView";
import { HelpView } from "@/features/help/HelpView";
import { MapWorkspace } from "@/features/map-workspace/MapWorkspace";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { ReportView } from "@/features/site-report/ReportView";
import { SettingsView } from "@/features/settings/SettingsView";
import { StatusBar } from "@/shell/StatusBar";
import { Toasts } from "@/shell/Toasts";
import { TopBar } from "@/shell/TopBar";
import "@/shell/shell.css";

export function App() {
  const view = useUiStore((state) => state.view);
  const modal = useUiStore((state) => state.modal);
  const openModal = useUiStore((state) => state.openModal);
  const notify = useUiStore((state) => state.notify);

  const loadSettings = useSettingsStore((state) => state.load);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const onboardingComplete = useSettingsStore((state) => state.onboardingComplete);

  // Load settings once, then decide whether this is a first run.
  useEffect(() => {
    loadSettings().catch((error) => {
      notify({
        tone: "error",
        message: "Could not read settings",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }, [loadSettings, notify]);

  useEffect(() => {
    if (settingsLoaded && !onboardingComplete) openModal("onboarding");
  }, [settingsLoaded, onboardingComplete, openModal]);

  // Warn before losing unsaved work. The browser build only; Tauri handles this
  // through the window close event.
  useEffect(() => {
    if (platform().kind === "tauri") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Read lazily so the listener never holds a stale value.
      const dirty = window.__sundayProjectDirty;
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <div className="app-shell">
      <TopBar />

      {/* The map is always mounted; other views cover it. */}
      <div style={{ display: view === "map" ? "contents" : "none" }}>
        <MapWorkspace />
      </div>

      {view === "design" && <DesignView />}
      {view === "report" && <ReportView />}
      {view === "analytics" && <AnalyticsView />}
      {view === "settings" && <SettingsView />}
      {view === "help" && <HelpView />}

      <StatusBar />
      <Toasts />

      {modal === "onboarding" && <OnboardingWizard />}
    </div>
  );
}
