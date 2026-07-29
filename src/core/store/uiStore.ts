/**
 * UI shell state: which view is showing, panel geometry, transient messages.
 *
 * Kept apart from domain state so that collapsing a panel never marks a project
 * dirty, and so a view switch cannot invalidate a computation in progress.
 */

import { create } from "zustand";

export type ViewId = "map" | "design" | "report" | "analytics" | "settings" | "help";

export type ModalId = "onboarding" | "export" | "about" | "dataset-import" | null;

export interface Toast {
  id: string;
  tone: "info" | "success" | "warning" | "error";
  message: string;
  /** Optional detail shown under the message, e.g. an error's guidance. */
  detail?: string;
}

interface UiState {
  view: ViewId;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  modal: ModalId;
  toasts: Toast[];
  /** Long-running work, keyed so several operations can report at once. */
  busy: Record<string, { label: string; progress?: number }>;

  setView: (view: ViewId) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  openModal: (modal: Exclude<ModalId, null>) => void;
  closeModal: () => void;
  notify: (toast: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
  startBusy: (key: string, label: string) => void;
  updateBusy: (key: string, progress: number) => void;
  endBusy: (key: string) => void;
}

let toastCounter = 0;

export const useUiStore = create<UiState>((set) => ({
  view: "map",
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  modal: null,
  toasts: [],
  busy: {},

  setView: (view) => set({ view }),
  toggleLeftPanel: () => set((state) => ({ leftPanelCollapsed: !state.leftPanelCollapsed })),
  toggleRightPanel: () => set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed })),
  setRightPanelCollapsed: (collapsed) => set({ rightPanelCollapsed: collapsed }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),

  notify: (toast) => {
    toastCounter += 1;
    const id = `toast-${toastCounter}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    return id;
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  startBusy: (key, label) => set((state) => ({ busy: { ...state.busy, [key]: { label } } })),
  updateBusy: (key, progress) =>
    set((state) => {
      const existing = state.busy[key];
      if (!existing) return state;
      return { busy: { ...state.busy, [key]: { ...existing, progress } } };
    }),
  endBusy: (key) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.busy;
      return { busy: rest };
    }),
}));
