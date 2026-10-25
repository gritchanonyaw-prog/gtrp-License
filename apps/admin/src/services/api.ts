import type { Activation, LicenseSummary, PaginationMeta, Plan, PublicUser } from "../types";

/** Error returned by the API: machine code, safe message, request id for support. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(q?: Query): string {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Called when any request returns 401 so the app can return to the login screen. */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: (() => void) | null) {
  onUnauthenticated = fn;
}

export async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs(query)}`, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.", null);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // fall through with null body
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; request_id?: string; details?: { path: string; message: string }[] } } | null)?.error;
    const e = new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Request failed (${res.status}).`, err?.request_id ?? res.headers.get("X-Request-Id"), err?.details ?? []);
    if (res.status === 401 && path !== "/auth/login" && onUnauthenticated) onUnauthenticated();
    throw e;
  }
  return data as T;
}

export interface Page<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface CustomerRow {
  id: string;
  email: string;
  status: string;
  created_at: string;
  license_count: number;
  active_license_count: number;
}

export interface AdminLicenseRow {
  id: string;
  user_id: string;
  email: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  status: string;
  key_hint: string | null;
  starts_at: string;
  expires_at: string | null;
  grace_until: string | null;
  created_at: string;
}

export interface AdminActivationRow extends Activation {
  email: string;
  user_id: string;
}

export interface AuditEventRow {
  id: string;
  license_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_type: string;
  target_user_id: string | null;
  target_email: string | null;
  event_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface PaymentRowView {
  id: string;
  user_id: string;
  email?: string;
  license_id: string | null;
  plan_id: string;
  plan_code?: string;
  provider: string;
  provider_ref: string;
  amount_minor: number;
  currency: string;
  status: string;
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

export interface Metrics {
  generated_at: string;
  total_customers: number;
  active_licenses: number;
  expired_licenses: number;
  suspended_licenses: number;
  revoked_licenses: number;
  expiring_within_7_days: number;
  activation_failures_24h: number;
  active_activations: Record<string, number>;
  recent_activation_failures: { id: string; license_id: string | null; customer_email: string | null; created_at: string; code?: string; operation?: string; platform?: string }[];
}

export type LicenseDetail = {
  license: LicenseSummary & { note: string | null; user: { id: string; email: string; status: string } | null };
  activations: Activation[];
};

export const api = {
  me: () => request<{ user: PublicUser; session: { expires_at: string; mfa_verified: boolean } }>("GET", "/me"),
  login: (email: string, password: string, totp_code?: string) =>
    request<{ user: PublicUser; session: { expires_at: string; mfa_verified: boolean } }>("POST", "/auth/login", { email, password, ...(totp_code ? { totp_code } : {}) }),
  logout: () => request<void>("POST", "/auth/logout"),
  mfaSetup: () => request<{ secret: string; otpauth_uri: string }>("POST", "/auth/mfa/setup"),
  mfaEnable: (totp_code: string) => request<{ mfa_enabled: boolean }>("POST", "/auth/mfa/enable", { totp_code }),

  metrics: () => request<Metrics>("GET", "/admin/metrics"),

  customers: (q: Query) => request<Page<CustomerRow>>("GET", "/admin/customers", undefined, q),
  customer: (id: string) =>
    request<{ customer: { id: string; email: string; status: string; created_at: string; deleted_at: string | null }; licenses: LicenseSummary[]; payments: PaymentRowView[] }>(
      "GET",
      `/admin/customers/${id}`,
    ),
  setCustomerStatus: (id: string, status: "active" | "suspended", reason: string) => request("POST", `/admin/customers/${id}/status`, { status, reason }),
  deleteCustomer: (id: string, reason: string) => request<void>("POST", `/admin/customers/${id}/delete`, { reason }),

  licenses: (q: Query) => request<Page<AdminLicenseRow>>("GET", "/admin/licenses", undefined, q),
  license: (id: string) => request<LicenseDetail>("GET", `/admin/licenses/${id}`),
  createLicense: (body: Record<string, unknown>) => request<{ license: LicenseSummary; license_key: string }>("POST", "/admin/licenses", body),
  updateLicense: (id: string, body: Record<string, unknown>) => request<{ license: LicenseSummary }>("PATCH", `/admin/licenses/${id}`, body),
  licenseAction: (id: string, action: "activate" | "suspend" | "reactivate" | "revoke", reason: string) =>
    request<{ license: LicenseSummary }>("POST", `/admin/licenses/${id}/${action}`, { reason }),
  renewLicense: (id: string, body: { periods?: number; expires_at?: string; reason: string }) => request<{ license: LicenseSummary }>("POST", `/admin/licenses/${id}/renew`, body),
  reissueKey: (id: string) => request<{ license: LicenseSummary; license_key: string }>("POST", `/admin/licenses/${id}/reissue-key`),
  licenseEvents: (id: string, q: Query) => request<Page<AuditEventRow>>("GET", `/admin/licenses/${id}/events`, undefined, q),

  activations: (q: Query) => request<Page<AdminActivationRow>>("GET", "/admin/activations", undefined, q),
  revokeActivation: (id: string, reason: string) => request<{ activation: Activation }>("POST", `/admin/activations/${id}/revoke`, { reason }),

  events: (q: Query) => request<Page<AuditEventRow>>("GET", "/admin/events", undefined, q),

  plans: () => request<{ data: Plan[] }>("GET", "/admin/plans"),
  createPlan: (body: Record<string, unknown>) => request<{ plan: Plan }>("POST", "/admin/plans", body),
  updatePlan: (id: string, body: Record<string, unknown>) => request<{ plan: Plan }>("PATCH", `/admin/plans/${id}`, body),

  payments: (q: Query) => request<Page<PaymentRowView>>("GET", "/admin/payments", undefined, q),
};
