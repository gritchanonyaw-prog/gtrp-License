/**
 * Structured logging with redaction. Never log license keys, passwords,
 * session tokens, lease tokens, raw device ids or account references.
 */
const SENSITIVE_KEYS = /^(password|current_password|new_password|license_key|key|token|lease_token|session|cookie|authorization|totp_code|secret|account_ref|activation_id|mfa_secret.*|.*_secret|.*_jwk|pepper)$/i;
const LICENSE_KEY_PATTERN = /GTRP(-[0-9A-Z]{4}){4}/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWS_PATTERN = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

export function redactString(s: string): string {
  return s
    .replace(LICENSE_KEY_PATTERN, "GTRP-[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(JWS_PATTERN, "[REDACTED_TOKEN]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, message: redactString(message), ...(redact(fields) as object), ts: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
