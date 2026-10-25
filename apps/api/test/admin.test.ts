import { createScheduledController, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "../src/clock.js";
import worker from "../src/index.js";
import { ENT_ANALYSIS, call, createLicense, createPlan, createUser, db, eaActivate, eventsOf, resetDb, world } from "./helpers.js";

beforeEach(resetDb);

describe("license lifecycle through the admin API", () => {
  it("follows the state machine and audits every change", async () => {
    const w = await world({}, { activate: false });
    const act = (action: string, json: Record<string, unknown> = { reason: "ops test" }) => call(`/api/v1/admin/licenses/${w.licenseId}/${action}`, { cookie: w.admin, json });
    expect((await act("suspend")).body.error.code).toBe("INVALID_TRANSITION");
    expect((await act("activate")).body.license.status).toBe("active");
    expect((await act("reactivate")).status).toBe(409);
    expect((await act("suspend")).body.license.status).toBe("suspended");
    expect((await act("reactivate")).body.license.status).toBe("active");
    const renewed = await act("renew", { periods: 2, reason: "paid offline" });
    expect(renewed.status).toBe(200);
    expect((await act("revoke")).body.license.status).toBe("revoked");
    for (const a of ["reactivate", "activate", "suspend"]) expect((await act(a)).body.error.code).toBe("INVALID_TRANSITION");
    expect((await act("renew", { periods: 1, reason: "x-renew" })).body.error.code).toBe("INVALID_TRANSITION");
    const events = await eventsOf(w.licenseId);
    expect(events.map((e) => e.event_type)).toEqual([
      "license.created",
      "license.activated",
      "license.suspended",
      "license.reactivated",
      "license.renewed",
      "license.revoked",
    ]);
    expect(events.every((e) => e.actor_type === "admin")).toBe(true);
    expect(JSON.parse(events[2]!.details_json)).toMatchObject({ from: "active", to: "suspended", reason: "ops test" });
  });

  it("renews expired licenses from now and active ones from their current expiry", async () => {
    const w = await world({}, { starts_at: "2025-01-01T00:00:00.000Z", expires_at: "2025-02-01T00:00:00.000Z" });
    await env.DB.prepare("UPDATE licenses SET status = 'expired' WHERE id = ?").bind(w.licenseId).run();
    const r = await call(`/api/v1/admin/licenses/${w.licenseId}/renew`, { cookie: w.admin, json: { periods: 1, reason: "renewal" } });
    expect(r.body.license.status).toBe("active");
    expect(Date.parse(r.body.license.expires_at)).toBeGreaterThan(Date.now() + 27 * 86400_000);
    const before = r.body.license.expires_at as string;
    const again = await call(`/api/v1/admin/licenses/${w.licenseId}/renew`, { cookie: w.admin, json: { periods: 1, reason: "renewal 2" } });
    expect(Date.parse(again.body.license.expires_at)).toBeGreaterThan(Date.parse(before) + 27 * 86400_000);
    expect((await eaActivate(w.key)).status).toBe(200);
  });

  it("validates dates and lifetime rules", async () => {
    const w = await world();
    const bad = await call(`/api/v1/admin/licenses/${w.licenseId}`, { cookie: w.admin, method: "PATCH", body: JSON.stringify({ expires_at: null }), headers: { "Content-Type": "application/json" } });
    expect(bad.status).toBe(400);
    const lifetime = await createPlan(w.admin, { billing_period: "lifetime" });
    const lic = await createLicense(w.admin, { user_id: w.customerId, plan_id: lifetime.id });
    const detail = await call(`/api/v1/admin/licenses/${lic.license.id}`, { cookie: w.admin });
    expect(detail.body.license.expires_at).toBeNull();
    const before = await call(`/api/v1/admin/licenses/${w.licenseId}`, { cookie: w.admin, method: "PATCH", body: JSON.stringify({ expires_at: "2020-01-01T00:00:00.000Z" }), headers: { "Content-Type": "application/json" } });
    expect(before.status).toBe(400);
  });

  it("edits a license (assign plan) and records the diff", async () => {
    const w = await world();
    const analysis = await createPlan(w.admin, { entitlements: ENT_ANALYSIS, max_ea_activations: 0 });
    const r = await call(`/api/v1/admin/licenses/${w.licenseId}`, { cookie: w.admin, method: "PATCH", body: JSON.stringify({ plan_id: analysis.id, note: "downgrade" }), headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(200);
    expect(r.body.license.plan.id).toBe(analysis.id);
    const ev = (await eventsOf(w.licenseId)).find((e) => e.event_type === "license.updated")!;
    expect(JSON.parse(ev.details_json).changes.plan_id.to).toBe(analysis.id);
    expect((await eaActivate(w.key)).body.error.code).toBe("PLATFORM_NOT_ENTITLED");
  });

  it("reissues a key: old key stops working and the event never contains the key", async () => {
    const w = await world();
    const r = await call(`/api/v1/admin/licenses/${w.licenseId}/reissue-key`, { cookie: w.admin, method: "POST" });
    expect(r.body.license_key).toMatch(/^GTRP-/);
    expect((await eaActivate(w.key)).body.error.code).toBe("LICENSE_INVALID");
    const all = JSON.stringify(await eventsOf(w.licenseId));
    expect(all).not.toContain(r.body.license_key);
    expect(all).not.toContain(w.key);
  });

  it("detects concurrent conflicting state changes", async () => {
    const w = await world();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(`/api/v1/admin/licenses/${w.licenseId}/suspend`, { cookie: w.admin, json: { reason: "parallel" } })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const types = (await eventsOf(w.licenseId)).map((e) => e.event_type);
    expect(types.filter((t) => t === "license.suspended")).toHaveLength(1);
  });

  it("the hourly job expires overdue licenses and audits it", async () => {
    const w = await world({}, { starts_at: "2025-01-01T00:00:00.000Z", expires_at: "2025-02-01T00:00:00.000Z" });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    const row = await db().prepare("SELECT status FROM licenses WHERE id = ?").bind(w.licenseId).first<{ status: string }>();
    expect(row!.status).toBe("expired");
    const last = (await eventsOf(w.licenseId)).at(-1)!;
    expect(last).toMatchObject({ event_type: "license.expired", actor_type: "system" });
  });
});

describe("plans administration", () => {
  it("creates, edits, disables plans; duplicate codes are rejected", async () => {
    const admin = (await world()).admin;
    const p = await createPlan(admin, { code: "QUANT_AUTO", max_trading_accounts: 2 });
    expect((await call("/api/v1/admin/plans", { cookie: admin, json: { code: "QUANT_AUTO", name: "x", price_minor: 1, currency: "THB", billing_period: "monthly", max_web_devices: 1, max_ea_activations: 1, max_trading_accounts: 1, entitlements: ENT_ANALYSIS } })).status).toBe(409);
    const upd = await call(`/api/v1/admin/plans/${p.id}`, { cookie: admin, method: "PATCH", body: JSON.stringify({ max_trading_accounts: 5, is_active: false, entitlements: { ...ENT_ANALYSIS, features: ["smc"] } }), headers: { "Content-Type": "application/json" } });
    expect(upd.body.plan).toMatchObject({ max_trading_accounts: 5, is_active: false, entitlements: { features: ["smc"] } });
    const pub = await call("/api/v1/plans");
    expect(pub.body.data.find((x: { id: string }) => x.id === p.id)).toBeUndefined();
    const types = await db().prepare("SELECT event_type FROM license_events WHERE event_type LIKE 'plan.%'").all<{ event_type: string }>();
    expect(types.results.map((t) => t.event_type)).toEqual(expect.arrayContaining(["plan.created", "plan.updated"]));
  });

  it("rejects unknown entitlement fields and invalid limits", async () => {
    const admin = (await world()).admin;
    const r = await call("/api/v1/admin/plans", { cookie: admin, json: { code: "BAD", name: "x", price_minor: -1, currency: "thb", billing_period: "weekly", max_web_devices: 1, max_ea_activations: 1, max_trading_accounts: 1, entitlements: { ...ENT_ANALYSIS, admin: true } } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["price_minor", "currency", "billing_period"]));
  });
});

describe("customers, activations, audit, metrics", () => {
  it("searches customers by email and id, paginates, shows history", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) await createUser(`bulk${i}@example.test`);
    const p1 = await call("/api/v1/admin/customers?page=1&page_size=10", { cookie: w.admin });
    expect(p1.body.data).toHaveLength(10);
    expect(p1.body.pagination.total).toBe(31);
    const p4 = await call("/api/v1/admin/customers?page=4&page_size=10", { cookie: w.admin });
    expect(p4.body.data).toHaveLength(1);
    const byEmail = await call("/api/v1/admin/customers?q=customer%40gtrp", { cookie: w.admin });
    expect(byEmail.body.data).toHaveLength(1);
    const byId = await call(`/api/v1/admin/customers?q=${w.customerId}`, { cookie: w.admin });
    expect(byId.body.data[0].id).toBe(w.customerId);
    const detail = await call(`/api/v1/admin/customers/${w.customerId}`, { cookie: w.admin });
    expect(detail.body.licenses).toHaveLength(1);
    expect(detail.body.customer).not.toHaveProperty("password_hash");
  });

  it("suspends a customer (revoking sessions and blocking licenses) and deletes with anonymization", async () => {
    const w = await world();
    expect((await eaActivate(w.key)).status).toBe(200);
    const s = await call(`/api/v1/admin/customers/${w.customerId}/status`, { cookie: w.admin, json: { status: "suspended", reason: "abuse report" } });
    expect(s.body.status).toBe("suspended");
    expect((await eaActivate(w.key)).body.error.code).toBe("LICENSE_SUSPENDED");
    await call(`/api/v1/admin/customers/${w.customerId}/delete`, { cookie: w.admin, method: "POST" });
    const u = await db().prepare("SELECT email, password_hash, status FROM users WHERE id = ?").bind(w.customerId).first<{ email: string; password_hash: string | null; status: string }>();
    expect(u).toMatchObject({ status: "deleted", password_hash: null });
    expect(u!.email).not.toContain("customer@gtrp.test");
    expect((await eaActivate(w.key)).body.error.code).toBe("LICENSE_INVALID");
  });

  it("lists activations by type and filters audit events", async () => {
    const w = await world({ max_ea_activations: 2 });
    await eaActivate(w.key);
    await eaActivate(w.key, { platform: "mt4", activation_id: "inst_mt4_000000000001" });
    const mt4 = await call("/api/v1/admin/activations?activation_type=mt4", { cookie: w.admin });
    expect(mt4.body.data).toHaveLength(1);
    expect(mt4.body.data[0]).not.toHaveProperty("device_hash");
    const evs = await call(`/api/v1/admin/events?event_type=activation.created&license_id=${w.licenseId}`, { cookie: w.admin });
    expect(evs.body.data).toHaveLength(2);
    const adminId = (await db().prepare("SELECT id FROM users WHERE role = 'admin'").first<{ id: string }>())!.id;
    const byAdmin = await call(`/api/v1/admin/events?actor_user_id=${adminId}`, { cookie: w.admin });
    expect(byAdmin.body.data.every((e: { actor_user_id: string }) => e.actor_user_id === adminId)).toBe(true);
    const range = await call(`/api/v1/admin/events?from=2000-01-01T00:00:00Z&to=2000-12-31T00:00:00Z`, { cookie: w.admin });
    expect(range.body.data).toHaveLength(0);
    const perLicense = await call(`/api/v1/admin/licenses/${w.licenseId}/events`, { cookie: w.admin });
    expect(perLicense.body.pagination.total).toBeGreaterThanOrEqual(3);
  });

  it("computes real metrics", async () => {
    const w = await world({}, {});
    await createLicense(w.admin, { user_id: w.customerId, plan_id: w.plan.id, starts_at: "2025-01-01T00:00:00.000Z", expires_at: "2025-02-01T00:00:00.000Z" });
    const soon = new Date(Date.now() + 3 * 86400_000).toISOString();
    await createLicense(w.admin, { user_id: w.customerId, plan_id: w.plan.id, expires_at: soon });
    const s = await createLicense(w.admin, { user_id: w.customerId, plan_id: w.plan.id });
    await call(`/api/v1/admin/licenses/${s.license.id}/suspend`, { cookie: w.admin, json: { reason: "metrics" } });
    await eaActivate("GTRP-0000-0000-0000-0000");
    const m = await call("/api/v1/admin/metrics", { cookie: w.admin });
    expect(m.body).toMatchObject({ total_customers: 1, active_licenses: 2, expired_licenses: 1, suspended_licenses: 1, expiring_within_7_days: 1, activation_failures_24h: 1 });
    expect(m.body.recent_activation_failures[0].code).toBe("LICENSE_INVALID");
  });
});

describe("time handling", () => {
  it("uses UTC server time, not client-provided dates, for expiry", async () => {
    const w = await world();
    clock.nowMs = () => Date.parse("2099-01-01T00:00:00Z");
    expect((await eaActivate(w.key)).body.error.code).toBe("LICENSE_EXPIRED");
  });
});
