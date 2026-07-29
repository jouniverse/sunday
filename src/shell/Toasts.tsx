/**
 * Transient messages.
 *
 * Errors persist until dismissed; anything else clears itself. An error that
 * vanishes before it has been read is the same as no error message at all.
 */

import { useEffect } from "react";
import { IconButton } from "@/design-system/controls";
import { CloseIcon } from "@/design-system/icons";
import { useUiStore } from "@/core/store/uiStore";
import "./toasts.css";

const AUTO_DISMISS_MS = 5000;

export function Toasts() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);

  useEffect(() => {
    const timers = toasts
      .filter((toast) => toast.tone !== "error")
      .map((toast) => window.setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          <div className="toast__body">
            <span className="toast__message">{toast.message}</span>
            {toast.detail && <span className="toast__detail">{toast.detail}</span>}
          </div>
          <IconButton label="Dismiss" size="sm" onClick={() => dismiss(toast.id)}>
            <CloseIcon size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
