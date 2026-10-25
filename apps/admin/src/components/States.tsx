import type { ReactNode } from "react";
import { ApiError } from "../services/api";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "Something went wrong. Please try again.";
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
      {rid && <p className="muted small">Reference: {rid}</p>}
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
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
        <button type="button" className="btn-link" onClick={onClose} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
