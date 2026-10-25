import type { ReactNode } from "react";
import { ApiError } from "../services/api";
import { currentLang, t } from "../i18n";

export function Loading({ label }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label ?? t("Loading…")}
    </div>
  );
}

/** Server messages are English; in Thai, known error codes get a Thai message and anything else falls back to the server text. */
function translateError(e: ApiError): string {
  if (currentLang() === "en") return e.message;
  const key = `error.${e.code}`;
  const msg = t(key);
  return msg === key ? e.message : msg;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return translateError(e);
  return t("Something went wrong. Please try again.");
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const rid = error instanceof ApiError ? error.requestId : null;
  return (
    <div className="state state-error" role="alert">
      <p>{errorMessage(error)}</p>
      {error instanceof ApiError && error.details.length > 0 && (
        <ul className="details">
          {error.details.map((d) => (
            <li key={d.path}>
              <code>{d.path}</code>: {d.message}
            </li>
          ))}
        </ul>
      )}
      {rid && <p className="muted small">{t("Reference: {id}", { id: rid })}</p>}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          {t("Try again")}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="state state-empty">{children}</div>;
}

export function Alert({ kind, children, onClose }: { kind: "success" | "error" | "info"; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <div>{children}</div>
      {onClose && (
        <button type="button" className="btn-link" onClick={onClose} aria-label={t("Dismiss")}>
          ×
        </button>
      )}
    </div>
  );
}
