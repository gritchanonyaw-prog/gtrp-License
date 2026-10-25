import { verifyLease } from "@gtrp/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "../src/clock.js";
import {
  EA_INSTALL,
  ENT_ANALYSIS,
  ENT_AUTO,
  call,
  createLicense,
  createPlan,
  createUser,
  db,
  eaActivate,
  eaValidate,
  eventsOf,
  loginToken,
  proto,
  resetDb,
  world,
} from "./helpers.js";

beforeEach(resetDb);

async function publicKeys() {
  const r = await call("/api/v1/lease/public-keys");
  return (r.body.keys as { kid: string; kty: string; crv: string; x: string }[]).map((k) => ({ kid: k.kid, jwk: { kty: k.kty, crv: k.crv, x: k.x } }));
}

describe("license key generation and storage", () => {
  it("returns the key once, in GTRP format, and stores only its hash", async () => {
    const w = await world();
    expect(w.key).toMatch(/^GTRP(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    const row = await db().prepare("SELECT key_hash, key_hint FROM licenses WHERE id = ?").bind(w.licenseId).first<{ key_hash: string; key_hint: string }>();
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.key_hash).not.toContain(w.key);
    expect(row!.key_hint).toBe(w.key.slice(-4));
    const detail = await call(`/api/v1/admin/licenses/${w.licenseId}`, { cookie: w.admin });
    expect(detail.text).not.toContain(w.key);
    const all = await db().prepare("SELECT details_json FROM license_events").all<{ details_json: string }>();
    for (const e of all.results) expect(e.details_json).not.toContain(w.key);
  });

  it("generates distinct keys", async () => {
    const { generateLicenseKey } = await import("../src/security/licenseKey.js");
    const keys = new Set(Array.from({ length: 2000 }, () => generateLicenseKey()));
    expect(keys.size).toBe(2000);
  });
});

describe("EA activation and validation", () => {
  it("activates and validates a valid active license with a verifiable signed lease", async () => {
    const w = await world();
    const a = await eaActivate(w.key);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ result: "ok", license: { id: w.licenseId, status: "active" }, activation: { platform: "mt5", status: "active" } });
    const v = await eaValidate(w.key);
    expect(v.status).toBe(200);
    const lease = await verifyLease(v.body.lease.token, await publicKeys(), Date.now());
    expect(lease.ok).toBe(true);
    if (lease.ok) {
      expect(lease.payload).toMatchObject({ sub: w.licenseId, platform: "mt5", product: "gtrp_ea", v: 1 });
      expect(lease.payload.exp - lease.payload.iat).toBeLessThanOrEqual(86400);
    }
    expect(v.body.policy.offline_grace_until).toBe(v.body.lease.expires_at);
  });

  it("accepts lowercase / ambiguous characters in the key", async () => {
    const w = await world();
    expect((await eaActivate(w.key.toLowerCase())).status).toBe(200);
  });

  it("rejects an unknown or malformed license with a generic, non-retryable denial", async () => {
    await world();
    const unknown = await eaActivate("GTRP-0000-0000-0000-0000");
    expect(unknown.status).toBe(403);
    expect(unknown.body.error).toMatchObject({ code: "LICENSE_INVALID", retryable: false });
    const malformed = await eaActivate("not-a-key");
    expect(malformed.body.error.code).toBe("LICENSE_INVALID");
    expect(malformed.body.error.message).toBe(unknown.body.error.message);
  });

  it("rejects an expired license (including one the scheduler has not marked yet)", async () => {
    const w = await world({}, { starts_at: "2025-01-01T00:00:00.000Z", expires_at: "2025-02-01T00:00:00.000Z", grace_days: 0 });
    const r = await eaActivate(w.key);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatchObject({ code: "LICENSE_EXPIRED", retryable: false });
  });

  it("allows use during the grace period and flags it", async () => {
    const w = await world();
    await eaActivate(w.key);
    const row = await db().prepare("SELECT expires_at, grace_until FROM licenses WHERE id = ?").bind(w.licenseId).first<{ expires_at: string; grace_until: string }>();
    clock.nowMs = () => Date.parse(row!.expires_at) + 3600_000;
    const v = await eaValidate(w.key);
    expect(v.status).toBe(200);
    expect(v.body.license.in_grace).toBe(true);
    // The lease never outlives the grace period.
    expect(Date.parse(v.body.lease.expires_at)).toBeLessThanOrEqual(Date.parse(row!.grace_until));
    clock.nowMs = () => Date.parse(row!.grace_until) + 1000;
    expect((await eaValidate(w.key)).body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("rejects a license with a future start date", async () => {
    const w = await world({}, { starts_at: "2030-01-01T00:00:00.000Z" });
    expect((await eaActivate(w.key)).body.error.code).toBe("LICENSE_NOT_STARTED");
  });

  it("rejects a license still in the created state", async () => {
    const w = await world({}, { activate: false });
    expect((await eaActivate(w.key)).body.error.code).toBe("LICENSE_NOT_ACTIVE");
  });

  it("rejects suspended and revoked licenses server-side, immediately", async () => {
    const w = await world();
    expect((await eaActivate(w.key)).status).toBe(200);
    await call(`/api/v1/admin/licenses/${w.licenseId}/suspend`, { cookie: w.admin, json: { reason: "chargeback review" } });
    expect((await eaValidate(w.key)).body.error).toMatchObject({ code: "LICENSE_SUSPENDED", retryable: false });
    await call(`/api/v1/admin/licenses/${w.licenseId}/reactivate`, { cookie: w.admin, json: { reason: "resolved" } });
    expect((await eaValidate(w.key)).status).toBe(200);
    await call(`/api/v1/admin/licenses/${w.licenseId}/revoke`, { cookie: w.admin, json: { reason: "fraud" } });
    expect((await eaValidate(w.key)).body.error.code).toBe("LICENSE_REVOKED");
    const act = await db().prepare("SELECT status FROM activations WHERE license_id = ?").bind(w.licenseId).first<{ status: string }>();
    expect(act!.status).toBe("revoked");
  });

  it("rejects the wrong product, wrong platform, and web product on an EA platform", async () => {
    const w = await world({ entitlements: { ...ENT_AUTO, require_account_binding: false, ea_platforms: ["mt5"] } });
    expect((await eaActivate(w.key, { product: "other_ea" })).body.error.code).toBe("PRODUCT_NOT_ENTITLED");
    expect((await eaActivate(w.key, { platform: "mt4" })).body.error.code).toBe("PLATFORM_NOT_ENTITLED");
    expect((await eaActivate(w.key, { product: "gtrp_web" })).body.error.code).toBe("PRODUCT_NOT_ENTITLED");
  });

  it("rejects EA use on a web-only plan (invalid entitlement)", async () => {
    const w = await world({ entitlements: ENT_ANALYSIS, max_ea_activations: 0 });
    expect((await eaActivate(w.key)).body.error.code).toBe("PLATFORM_NOT_ENTITLED");
  });

  it("rejects validation for an installation that was never activated", async () => {
    const w = await world();
    const r = await eaValidate(w.key);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: "ACTIVATION_NOT_FOUND", retryable: false });
  });

  it("enforces the EA activation quota across MT4 and MT5", async () => {
    const w = await world({ max_ea_activations: 2 });
    expect((await eaActivate(w.key, { activation_id: "inst_aaaaaaaaaaaaaaaa1" })).status).toBe(200);
    expect((await eaActivate(w.key, { activation_id: "inst_aaaaaaaaaaaaaaaa2", platform: "mt4" })).status).toBe(200);
    const third = await eaActivate(w.key, { activation_id: "inst_aaaaaaaaaaaaaaaa3" });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("ACTIVATION_LIMIT_REACHED");
    // Re-activating an existing installation is idempotent and does not consume quota.
    expect((await eaActivate(w.key, { activation_id: "inst_aaaaaaaaaaaaaaaa1" })).status).toBe(200);
  });

  it("enforces quotas under concurrent activation requests", async () => {
    const w = await world({ max_ea_activations: 2 });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => eaActivate(w.key, { activation_id: `inst_concurrent_${String(i).padStart(4, "0")}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(10);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM activations WHERE license_id = ? AND status = 'active'").bind(w.licenseId).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it("duplicate concurrent activations of the same installation create one row", async () => {
    const w = await world({ max_ea_activations: 1 });
    const results = await Promise.all(Array.from({ length: 6 }, () => eaActivate(w.key)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM activations WHERE license_id = ?").bind(w.licenseId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(new Set(results.map((r) => r.body.activation.id)).size).toBe(1);
  });

  it("separates the trading-account limit from the EA activation limit", async () => {
    const w = await world({ entitlements: ENT_AUTO, max_ea_activations: 3, max_trading_accounts: 1 });
    expect((await eaActivate(w.key, { activation_id: "inst_bbbbbbbbbbbbbbbb1" })).body.error.code).toBe("ACCOUNT_REF_REQUIRED");
    expect((await eaActivate(w.key, { activation_id: "inst_bbbbbbbbbbbbbbbb1", account_ref: "Broker-Live:1001" })).status).toBe(200);
    // Second installation on the SAME account: allowed (2 EA activations, 1 account).
    expect((await eaActivate(w.key, { activation_id: "inst_bbbbbbbbbbbbbbbb2", account_ref: "Broker-Live:1001" })).status).toBe(200);
    // A different account exceeds the 1-account limit.
    const r = await eaActivate(w.key, { activation_id: "inst_bbbbbbbbbbbbbbbb3", account_ref: "Broker-Live:2002" });
    expect(r.body.error.code).toBe("ACCOUNT_LIMIT_REACHED");
    // Validation from a bound installation with another account is rejected.
    expect((await eaValidate(w.key, { activation_id: "inst_bbbbbbbbbbbbbbbb1", account_ref: "Broker-Live:2002" })).body.error.code).toBe("ACCOUNT_MISMATCH");
    const stored = await db().prepare("SELECT account_ref_hash FROM activations WHERE account_ref_hash IS NOT NULL").all<{ account_ref_hash: string }>();
    for (const s of stored.results) expect(s.account_ref_hash).not.toContain("1001");
  });

  it("does not store account references when the plan does not bind accounts", async () => {
    const w = await world();
    await eaActivate(w.key, { account_ref: "Broker-Live:1001" });
    const row = await db().prepare("SELECT account_ref_hash FROM activations").first<{ account_ref_hash: string | null }>();
    expect(row!.account_ref_hash).toBeNull();
  });

  it("deactivation frees the slot; admin reset frees it too", async () => {
    const w = await world({ max_ea_activations: 1 });
    await eaActivate(w.key);
    expect((await eaActivate(w.key, { activation_id: "inst_cccccccccccccccc2" })).status).toBe(409);
    const d = await call("/api/v1/licenses/deactivate", { json: proto({ license_key: w.key, platform: "mt5", activation_id: EA_INSTALL }) });
    expect(d.status).toBe(200);
    expect(d.body.result).toBe("deactivated");
    expect((await eaValidate(w.key)).body.error.code).toBe("ACTIVATION_REVOKED");
    const second = await eaActivate(w.key, { activation_id: "inst_cccccccccccccccc2" });
    expect(second.status).toBe(200);
    const reset = await call(`/api/v1/admin/activations/${second.body.activation.id}/revoke`, { cookie: w.admin, json: { reason: "customer changed PC" } });
    expect(reset.body.activation.status).toBe("revoked");
    expect((await eaActivate(w.key, { activation_id: "inst_cccccccccccccccc3" })).status).toBe(200);
  });

  it("refreshes a lease and rejects tampered, foreign, or expired leases", async () => {
    const w = await world();
    const a = await eaActivate(w.key);
    const token = a.body.lease.token as string;
    const ok = await call("/api/v1/licenses/refresh", { json: proto({ lease_token: token, activation_id: EA_INSTALL }) });
    expect(ok.status).toBe(200);
    expect(ok.body.lease.token).not.toBe(token);
    const [h, p, s] = token.split(".");
    const tampered = await call("/api/v1/licenses/refresh", { json: proto({ lease_token: `${h}.${p}x.${s}`, activation_id: EA_INSTALL }) });
    expect(tampered.body.error.code).toBe("LEASE_INVALID");
    const badSig = await call("/api/v1/licenses/refresh", { json: proto({ lease_token: `${h}.${p}.${s!.slice(0, -4)}AAAA`, activation_id: EA_INSTALL }) });
    expect(badSig.body.error.code).toBe("LEASE_INVALID");
    const otherInstall = await call("/api/v1/licenses/refresh", { json: proto({ lease_token: token, activation_id: "inst_somebody_else_123" }) });
    expect(otherInstall.body.error.code).toBe("LEASE_INVALID");
    clock.nowMs = () => Date.now() + 2 * 86400_000;
    const expired = await call("/api/v1/licenses/refresh", { json: proto({ lease_token: token, activation_id: EA_INSTALL }) });
    expect(expired.body.error.code).toBe("LEASE_EXPIRED");
  });

  it("refresh re-checks license status on the server", async () => {
    const w = await world();
    const a = await eaActivate(w.key);
    await call(`/api/v1/admin/licenses/${w.licenseId}/suspend`, { cookie: w.admin, json: { reason: "review" } });
    const r = await call("/api/v1/licenses/refresh", { json: proto({ lease_token: a.body.lease.token, activation_id: EA_INSTALL }) });
    expect(r.body.error.code).toBe("LICENSE_SUSPENDED");
  });

  it("records activation and failure events", async () => {
    const w = await world({ max_ea_activations: 1 });
    await eaActivate(w.key);
    await eaActivate(w.key, { activation_id: "inst_dddddddddddddddd2" });
    const types = (await eventsOf(w.licenseId)).map((e) => e.event_type);
    expect(types).toEqual(["license.created", "activation.created", "activation.failed"]);
  });
});

describe("protocol safety: replay, clock skew, versions, rate limits", () => {
  it("rejects a replayed request id", async () => {
    const w = await world();
    const body = proto({ license_key: w.key, product: "gtrp_ea", platform: "mt5", activation_id: EA_INSTALL });
    expect((await call("/api/v1/licenses/activate", { json: body })).status).toBe(200);
    const replay = await call("/api/v1/licenses/activate", { json: body });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toMatchObject({ code: "REPLAY_DETECTED" });
  });

  it("rejects excessive clock skew and returns server time", async () => {
    const w = await world();
    const r = await eaActivate(w.key, { client_time: new Date(Date.now() - 3600_000).toISOString() });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "CLOCK_SKEW", retryable: true });
    expect(Math.abs(Date.parse(r.body.error.server_time) - Date.now())).toBeLessThan(10_000);
    expect((await eaActivate(w.key, { client_time: new Date(Date.now() + 120_000).toISOString() })).status).toBe(200);
  });

  it("rejects unsupported protocol versions", async () => {
    const w = await world();
    expect((await eaActivate(w.key, { protocol_version: 2 })).body.error.code).toBe("UNSUPPORTED_PROTOCOL");
  });

  it("rate limits guessing against the validation endpoint", async () => {
    await world();
    let last: any;
    for (let i = 0; i < 31; i++) last = await eaValidate("GTRP-0000-0000-0000-0000");
    expect(last.status).toBe(429);
    expect(last.body.error.retryable).toBe(true);
    expect(Number(last.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("customer license access", () => {
  it("a customer sees only their own licenses and activations", async () => {
    const w = await world();
    await createUser("other@gtrp.test");
    const otherToken = await loginToken("other@gtrp.test");
    const mine = await loginToken("customer@gtrp.test");
    const list = await call("/api/v1/me/licenses", { bearer: mine });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: w.licenseId, effective_status: "active" });
    expect(list.body.data[0].key_hint).toMatch(/^GTRP-\*{4}-\*{4}-\*{4}-[0-9A-Z]{4}$/);
    expect((await call("/api/v1/me/licenses", { bearer: otherToken })).body.data).toHaveLength(0);
    expect((await call(`/api/v1/licenses/activations?license_id=${w.licenseId}`, { bearer: otherToken })).status).toBe(404);
    expect((await call(`/api/v1/licenses/activations?license_id=${w.licenseId}`, { bearer: mine })).status).toBe(200);
    // Guessing another customer's license id for web activation gets the generic denial.
    const steal = await call("/api/v1/licenses/activate", { bearer: otherToken, json: proto({ license_id: w.licenseId, product: "gtrp_web", platform: "web", activation_id: "browser_0123456789abcdef" }) });
    expect(steal.body.error.code).toBe("LICENSE_INVALID");
    expect((await call(`/api/v1/me/licenses/${w.licenseId}/reissue-key`, { bearer: otherToken, method: "POST" })).status).toBe(404);
  });

  it("a customer can rotate their own key; the old key stops working", async () => {
    const w = await world();
    const token = await loginToken("customer@gtrp.test");
    await eaActivate(w.key);
    const r = await call(`/api/v1/me/licenses/${w.licenseId}/reissue-key`, { bearer: token, method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.license_key).not.toBe(w.key);
    expect((await eaValidate(w.key)).body.error.code).toBe("LICENSE_INVALID");
    expect((await eaValidate(r.body.license_key)).status).toBe(200);
  });
});

describe("one license for Web App and EA", () => {
  it("the same license authorizes a web device and an EA installation per plan", async () => {
    const w = await world();
    const token = await loginToken("customer@gtrp.test");
    const web = await call("/api/v1/licenses/activate", { bearer: token, json: proto({ license_id: w.licenseId, product: "gtrp_web", platform: "web", activation_id: "browser_0123456789abcdef", label: "Chrome" }) });
    expect(web.status).toBe(200);
    expect(web.body.lease).toBeDefined();
    expect((await eaActivate(w.key)).status).toBe(200);
    const usage = (await call("/api/v1/me/licenses", { bearer: token })).body.data[0].usage;
    expect(usage).toMatchObject({ web: { used: 1, max: 2 }, ea: { used: 1, max: 1 } });
  });

  it("web device limit is separate from the EA limit", async () => {
    const w = await world({ max_web_devices: 1, max_ea_activations: 1 });
    const token = await loginToken("customer@gtrp.test");
    const act = (id: string) => call("/api/v1/licenses/activate", { bearer: token, json: proto({ license_id: w.licenseId, product: "gtrp_web", platform: "web", activation_id: id }) });
    expect((await act("browser_aaaaaaaaaaaaaaaa")).status).toBe(200);
    expect((await act("browser_bbbbbbbbbbbbbbbb")).body.error.code).toBe("ACTIVATION_LIMIT_REACHED");
    expect((await eaActivate(w.key)).status).toBe(200);
  });

  it("license_id without a session is rejected", async () => {
    const w = await world();
    const r = await call("/api/v1/licenses/activate", { json: proto({ license_id: w.licenseId, product: "gtrp_web", platform: "web", activation_id: "browser_0123456789abcdef" }) });
    expect(r.status).toBe(401);
  });
});

describe("plan with multiple customers", () => {
  it("creates a license by customer email", async () => {
    const w = await world();
    await createUser("second@gtrp.test");
    const plan = await createPlan(w.admin);
    const r = await createLicense(w.admin, { email: "SECOND@gtrp.test", plan_id: plan.id });
    expect(r.license_key).toMatch(/^GTRP-/);
  });
});
