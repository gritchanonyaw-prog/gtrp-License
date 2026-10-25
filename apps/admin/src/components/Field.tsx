import type { ReactNode } from "react";

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: ReactNode }) {
  return (
    <label className={`field${error ? " field-invalid" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && !error && <small className="muted">{hint}</small>}
      {error && (
        <small className="error-text" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}

/** Maps API validation details (path -> message) for inline form errors. */
export function fieldErrors(details: { path: string; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of details) out[d.path.split(".")[0]!] ??= d.message;
  return out;
}
