import { beforeEach, describe, expect, it } from "vitest";
import { ENT_ANALYSIS, call, createPlan, db, loginToken, proto, resetDb, world } from "./helpers.js";

beforeEach(resetDb);

const BROWSER = "browser_0123456789abcdef";

async function setup(planOverrides: Record<string, unknown> = {}) {
  const w = await world(planOverrides);
  const token = await loginToken("customer@gtrp.test");
  const act = await call("/api/v1/licenses/activate", { bearer: token, json: proto({ license_id: w.licenseId, product: "gtrp_web", platform: "web", activation_id: BROWSER }) });
  expect(act.status).toBe(200);
  const access = (feature: string, activation: string | null = BROWSER) =>
    call(`/api/v1/features/${feature}/access`, { bearer: token, headers: activation ? { "X-GTRP-Activation-Id": activation } : {} });
  return { ...w, token, access };
}

describe("Web App entitlements (server-side)", () => {
  it("allows an entitled feature from an activated browser", async () => {
    const s = await setup();
    const r = await s.access("smc");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ feature: "smc", allowed: true, license_id: s.licenseId });
  });

  it("protected routes require authentication", async () => {
    await setup();
    expect((await call("/api/v1/features/smc/access", { headers: { "X-GTRP-Activation-Id": BROWSER } })).status).toBe(401);
    expect((await call("/api/v1/me/entitlements")).status).toBe(401);
  });

  it("denies a feature the plan does not include", async () => {
    const s = await setup({ entitlements: { ...ENT_ANALYSIS, features: ["smc"] } });
    const r = await s.access("volume_analysis");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FEATURE_NOT_ENTITLED");
  });

  it("denies a browser that has not been activated (device limit enforcement)", async () => {
    const s = await setup();
    expect((await s.access("smc", null)).body.error.code).toBe("ACTIVATION_NOT_FOUND");
    expect((await s.access("smc", "browser_not_activated_0001")).body.error.code).toBe("ACTIVATION_NOT_FOUND");
  });

  it("an expired subscription loses access on the next request", async () => {
    const s = await setup();
    expect((await s.access("smc")).status).toBe(200);
    // The subscription ran out (starts/expiry/grace all in the past); the browser session is still valid.
    await db()
      .prepare("UPDATE licenses SET starts_at = '2025-01-01T00:00:00.000Z', expires_at = ?, grace_until = ? WHERE id = ?")
      .bind(new Date(Date.now() - 2000).toISOString(), new Date(Date.now() - 1000).toISOString(), s.licenseId)
      .run();
    expect((await s.access("smc")).status).toBe(403);
    const ent = await call("/api/v1/me/entitlements", { bearer: s.token });
    expect(ent.body).toMatchObject({ web_access: false, features: [] });
  });

  it("a suspended license loses access on the next request", async () => {
    const s = await setup();
    await call(`/api/v1/admin/licenses/${s.licenseId}/suspend`, { cookie: s.admin, json: { reason: "review" } });
    expect((await s.access("smc")).body.error.code).toBe("FEATURE_NOT_ENTITLED");
  });

  it("a plan downgrade takes effect immediately", async () => {
    const s = await setup();
    expect((await s.access("ea_connector")).status).toBe(200);
    const analysis = await createPlan(s.admin, { entitlements: ENT_ANALYSIS, max_ea_activations: 0 });
    await call(`/api/v1/admin/licenses/${s.licenseId}`, { cookie: s.admin, method: "PATCH", body: JSON.stringify({ plan_id: analysis.id }), headers: { "Content-Type": "application/json" } });
    expect((await s.access("ea_connector")).body.error.code).toBe("FEATURE_NOT_ENTITLED");
    expect((await s.access("smc")).status).toBe(200);
  });

  it("disabling a feature on the plan takes effect immediately", async () => {
    const s = await setup();
    await call(`/api/v1/admin/plans/${s.plan.id}`, { cookie: s.admin, method: "PATCH", body: JSON.stringify({ entitlements: { ...ENT_ANALYSIS, features: ["advanced_charts"] } }), headers: { "Content-Type": "application/json" } });
    expect((await s.access("smc")).status).toBe(403);
    expect((await s.access("advanced_charts")).status).toBe(200);
  });

  it("a revoked web activation loses access", async () => {
    const s = await setup();
    const acts = await call(`/api/v1/licenses/activations?license_id=${s.licenseId}`, { bearer: s.token });
    await call(`/api/v1/admin/activations/${acts.body.data[0].id}/revoke`, { cookie: s.admin, json: { reason: "lost laptop" } });
    expect((await s.access("smc")).body.error.code).toBe("ACTIVATION_NOT_FOUND");
  });

  it("exposes the union of entitlements for UI display", async () => {
    const s = await setup();
    const r = await call("/api/v1/me/entitlements", { bearer: s.token });
    expect(r.body).toMatchObject({ web_access: true, features: ["advanced_charts", "ea_connector", "smc", "volume_analysis"], license_ids: [s.licenseId] });
  });
});
