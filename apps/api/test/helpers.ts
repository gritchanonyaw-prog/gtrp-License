import { env, exports } from "cloudflare:workers";
import { clock } from "../src/clock.js";
import { hashPassword } from "../src/security/password.js";

export const BASE = "https://api.test";
export const db = () => env.DB;

const TABLES = ["license_events", "payment_events", "payments", "activations", "sessions", "licenses", "plans", "users", "api_rate_limits", "request_nonces"];

export async function resetDb() {
  clock.nowMs = () => Date.now();
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export interface CallOptions {
  method?: string;
  json?: unknown;
  body?: string;
  cookie?: string;
  bearer?: string;
  headers?: Record<string, string>;
  origin?: string | null;
  ip?: string;
}

export async function call(path: string, o: CallOptions = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.json !== undefined) headers["Content-Type"] = "application/json";
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
  // Browsers send Origin on cookie-authenticated POSTs; default to the API's own origin.
  if (o.origin !== null && (o.origin !== undefined || o.cookie)) headers.Origin = o.origin ?? BASE;
  headers["CF-Connecting-IP"] = o.ip ?? "203.0.113.10";
  const method = o.method ?? (o.json !== undefined || o.body !== undefined ? "POST" : "GET");
  const res = await exports.default.fetch(new Request(`${BASE}${path}`, { method, headers, body: o.body ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined) }));
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

export function sessionCookieFrom(res: { headers: Headers }): string {
  const set = res.headers.get("Set-Cookie") ?? "";
  const m = /(gtrp_session=[^;]+)/.exec(set);
  if (!m) throw new Error(`no session cookie in: ${set}`);
  return m[1]!;
}

export const PASSWORD = "correct horse battery";

export async function createUser(email: string, role: "customer" | "admin" = "customer", password = PASSWORD) {
  const id = crypto.randomUUID();
  const now = new Date(clock.nowMs()).toISOString();
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
    .bind(id, email, await hashPassword(password), role, now, now)
    .run();
  return id;
}

export async function loginCookie(email: string, password = PASSWORD, extra: Record<string, unknown> = {}) {
  const r = await call("/api/v1/auth/login", { json: { email, password, ...extra }, origin: BASE });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${r.text}`);
  return sessionCookieFrom(r);
}

export async function loginToken(email: string, password = PASSWORD) {
  const r = await call("/api/v1/auth/login", { json: { email, password, session_mode: "token" } });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${r.text}`);
  return r.body.token as string;
}

export async function adminSession() {
  await createUser("admin@gtrp.test", "admin");
  return loginCookie("admin@gtrp.test");
}

export const ENT_ANALYSIS = { web_access: true, features: ["advanced_charts", "smc", "volume_analysis"], ea_products: [], ea_platforms: [], require_account_binding: false };
export const ENT_PRO = { web_access: true, features: ["advanced_charts", "ea_connector", "smc", "volume_analysis"], ea_products: ["gtrp_ea"], ea_platforms: ["mt4", "mt5"], require_account_binding: false };
export const ENT_AUTO = { ...ENT_PRO, require_account_binding: true };

export async function createPlan(adminCookie: string, overrides: Record<string, unknown> = {}) {
  const code = (overrides.code as string) ?? `P_${crypto.randomUUID().slice(0, 6).toUpperCase().replace(/-/g, "")}`;
  const r = await call("/api/v1/admin/plans", {
    cookie: adminCookie,
    json: {
      code,
      name: code,
      price_minor: 99000,
      currency: "THB",
      billing_period: "monthly",
      max_web_devices: 2,
      max_ea_activations: 1,
      max_trading_accounts: 1,
      entitlements: ENT_PRO,
      ...overrides,
    },
  });
  if (r.status !== 201) throw new Error(`plan create failed ${r.status} ${r.text}`);
  return r.body.plan as { id: string; code: string };
}

export async function createLicense(adminCookie: string, body: Record<string, unknown>) {
  const r = await call("/api/v1/admin/licenses", { cookie: adminCookie, json: body });
  if (r.status !== 201) throw new Error(`license create failed ${r.status} ${r.text}`);
  return r.body as { license: { id: string }; license_key: string };
}

/** A fresh protocol envelope (new request id + current client time). */
export function proto(extra: Record<string, unknown> = {}) {
  return { protocol_version: 1, request_id: crypto.randomUUID(), client_time: new Date(clock.nowMs()).toISOString(), ...extra };
}

export const EA_INSTALL = "inst_7f3a9c2e5b1d4e6f8a0b";

export function eaActivate(key: string, extra: Record<string, unknown> = {}) {
  return call("/api/v1/licenses/activate", { json: proto({ license_key: key, product: "gtrp_ea", platform: "mt5", activation_id: EA_INSTALL, ...extra }) });
}

export function eaValidate(key: string, extra: Record<string, unknown> = {}) {
  return call("/api/v1/licenses/validate", { json: proto({ license_key: key, product: "gtrp_ea", platform: "mt5", activation_id: EA_INSTALL, ...extra }) });
}

/** Admin + customer + plan + license in one go. */
export async function world(planOverrides: Record<string, unknown> = {}, licenseOverrides: Record<string, unknown> = {}) {
  const admin = await adminSession();
  const plan = await createPlan(admin, planOverrides);
  const customerId = await createUser("customer@gtrp.test");
  const { license, license_key } = await createLicense(admin, { user_id: customerId, plan_id: plan.id, ...licenseOverrides });
  return { admin, plan, customerId, licenseId: license.id, key: license_key };
}

export async function eventsOf(licenseId: string) {
  const r = await env.DB.prepare("SELECT event_type, actor_type, details_json FROM license_events WHERE license_id = ? ORDER BY created_at, rowid").bind(licenseId).all<{
    event_type: string;
    actor_type: string;
    details_json: string;
  }>();
  return r.results;
}
