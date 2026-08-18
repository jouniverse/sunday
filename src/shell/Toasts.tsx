/**
 * Transient messages.
 *
 * Errors persist until dismissed; anything else clears itself. An error that
 * vanishes before it has been read is the same as no error message at all.
 */

import { useEffect } from "react";
import { useUiStore } from "@/core/store/uiStore";
import { IconButton } from "@/design-system/controls";
import { CloseIcon } from "@/design-system/icons";
import "./toasts.css";

const AUTO_DISMISS_MS = 5000;

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Keep the first segment and the filename so long export paths fit the toast. */
function shortenPath(path: string): string {
  const sep = path.includes("\\") && !path.startsWith("/") ? "\\" : "/";
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 3) return path;
  const file = parts[parts.length - 1];
  const first = path.startsWith("/") ? `/${parts[0]}` : parts[0];
  return `${first}${sep}…${sep}${file}`;
}

function formatToastText(text: string): string {
  const marker = " to ";
  const idx = text.lastIndexOf(marker);
  if (idx !== -1) {
    const rest = text.slice(idx + marker.length);
    if (looksLikePath(rest)) return text.slice(0, idx + marker.length) + shortenPath(rest);
  }
  const trimmed = text.trim();
  if (looksLikePath(trimmed)) return shortenPath(trimmed);
  return text;
}

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
            <span className="toast__message" title={toast.message}>
              {formatToastText(toast.message)}
            </span>
            {toast.detail && (
              <span className="toast__detail" title={toast.detail}>
                {formatToastText(toast.detail)}
              </span>
            )}
          </div>
          <IconButton label="Dismiss" size="sm" onClick={() => dismiss(toast.id)}>
            <CloseIcon size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
