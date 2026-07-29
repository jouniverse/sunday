/**
 * Entry point.
 *
 * Style import order matters: tokens first so every later rule can reference the
 * variables, then fonts, then base document rules. Component styles are imported
 * by the components themselves.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/tokens.css";
import "@/styles/fonts.css";
import "@/styles/base.css";
import { App } from "./App";
import { useProjectStore } from "@/core/store/projectStore";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Sunday could not find its root element");
}

// Mirror the dirty flag onto the window so the unload guard can read it without
// subscribing to the store from outside React.
useProjectStore.subscribe((state) => {
  window.__sundayProjectDirty = state.dirty;
});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
