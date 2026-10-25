import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "../src/clock.js";
import { mockProvider, mockSignature } from "../src/services/payments/mockProvider.js";
import { adminSession, call, createLicense, createPlan, createUser, db, eaActivate, eventsOf, loginToken, resetDb } from "./helpers.js";

beforeEach(resetDb);

const SECRET = () => env.MOCK_PAYMENT_WEBHOOK_SECRET!;
let seq = 0;

function mockEvent(type: string, providerRef: string, amount = 99000, currency = "THB", id = `evt_${++seq}_${crypto.randomUUID().slice(0, 8)}`) {
  return { id, type, created: Math.floor(clock.nowMs() / 1000), data: { provider_ref: providerRef, amount_minor: amount, currency } };
}

async function deliver(event: unknown, o: { signWith?: string; at?: number; tamper?: (body: string) => string; header?: string } = {}) {
  const body = JSON.stringify(event);
  const t = o.at ?? Math.floor(clock.nowMs() / 1000);
  const sig = o.header ?? (await mockSignature(o.signWith ?? SECRET(), body, t));
  return call("/api/v1/webhooks/payments/mock", { body: o.tamper ? o.tamper(body) : body, headers: { "Content-Type": "application/json", "X-Mock-Signature": sig } });
}

async function setup() {
  const admin = await adminSession();
  const plan = await createPlan(admin);
  const customerId = await createUser("buyer@gtrp.test");
  const token = await loginToken("buyer@gtrp.test");
  const checkout = async (body: Record<string, unknown> = {}) => call("/api/v1/payments/checkout", { bearer: token, json: { plan_id: plan.id, ...body } });
  return { admin, plan, customerId, token, checkout };
}

const payment = (id: string) => db().prepare("SELECT * FROM payments WHERE id = ?").bind(id).first<Record<string, any>>();
const license = (id: string) => db().prepare("SELECT * FROM licenses WHERE id = ?").bind(id).first<Record<string, any>>();
const licensesOf = (userId: string) => db().prepare("SELECT * FROM licenses WHERE user_id = ?").bind(userId).all<Record<string, any>>();
const eventCount = () => db().prepare("SELECT COUNT(*) AS n FROM payment_events").first<{ n: number }>();

describe("checkout", () => {
  it("creates a pending payment priced from the plan, not the client", async () => {
    const s = await setup();
    const r = await s.checkout({ amount_minor: 1 });
    expect(r.status).toBe(400); // unknown field rejected
    const ok = await s.checkout();
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ provider: "mock", amount_minor: 99000, currency: "THB", checkout_url: null });
    const p = await payment(ok.body.payment_id);
    expect(p).toMatchObject({ status: "pending", user_id: s.customerId, license_id: null, amount_minor: 99000 });
    // No license until a verified webhook arrives.
    expect((await licensesOf(s.customerId)).results).toHaveLength(0);
  });

  it("requires authentication and rejects free, disabled, or foreign targets", async () => {
    const s = await setup();
    expect((await call("/api/v1/payments/checkout", { json: { plan_id: s.plan.id } })).status).toBe(401);
    const free = await createPlan(s.admin, { price_minor: 0 });
    expect((await s.checkout({ plan_id: free.id })).status).toBe(400);
    const other = await createUser("other@gtrp.test");
    const { license } = await createLicense(s.admin, { user_id: other, plan_id: s.plan.id });
    expect((await s.checkout({ license_id: license.id })).status).toBe(404);
  });

  it("is refused when payments are disabled, and the mock is never enabled in production", async () => {
    expect(mockProvider.enabled({ ...env, ENVIRONMENT: "production", PAYMENTS_MOCK_ENABLED: "true" } as never)).toBe(false);
    expect(mockProvider.enabled({ ...env, PAYMENTS_MOCK_ENABLED: "false" } as never)).toBe(false);
    expect(mockProvider.enabled({ ...env, MOCK_PAYMENT_WEBHOOK_SECRET: "short" } as never)).toBe(false);
    expect(mockProvider.enabled(env as never)).toBe(true);
  });
});

describe("payment webhooks", () => {
  it("valid payment creates an active license without a key; the customer reveals it once", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    const r = await deliver(mockEvent("payment.succeeded", co.provider_ref));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: true, result: "processed" });
    const p = await payment(co.payment_id);
    expect(p!.status).toBe("paid");
    const l = await license(p!.license_id);
    expect(l).toMatchObject({ status: "active", user_id: s.customerId, key_hash: null });
    expect(Date.parse(l!.expires_at) - Date.parse(l!.starts_at)).toBeGreaterThan(27 * 86400_000);
    const types = (await eventsOf(l!.id)).map((e) => `${e.event_type}:${e.actor_type}`);
    expect(types).toEqual(["license.created:provider", "payment.paid:provider"]);

    const reveal = await call(`/api/v1/me/licenses/${l!.id}/reissue-key`, { bearer: s.token, method: "POST" });
    expect(reveal.status).toBe(200);
    expect((await eaActivate(reveal.body.license_key)).status).toBe(200);
  });

  it("renewal extends the existing license from its current expiry", async () => {
    const s = await setup();
    const { license: lic } = await createLicense(s.admin, { user_id: s.customerId, plan_id: s.plan.id });
    const before = (await license(lic.id))!;
    const co = (await s.checkout({ license_id: lic.id })).body;
    expect((await deliver(mockEvent("payment.succeeded", co.provider_ref))).status).toBe(200);
    const after = (await license(lic.id))!;
    expect(Date.parse(after.expires_at)).toBeGreaterThan(Date.parse(before.expires_at) + 27 * 86400_000);
    expect(after.version).toBe(before.version + 1);
    expect((await eventsOf(lic.id)).map((e) => e.event_type)).toContain("license.renewed");
  });

  it("rejects an invalid signature, a tampered body, a wrong secret, and a missing header without side effects", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    const ev = mockEvent("payment.succeeded", co.provider_ref);
    const cases = [
      await deliver(ev, { signWith: "f".repeat(64) }),
      await deliver(ev, { tamper: (b) => b.replace("99000", "99001") }),
      await deliver(ev, { header: "" }),
      await deliver(ev, { header: "t=abc,v1=zz" }),
    ];
    for (const r of cases) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    }
    expect((await payment(co.payment_id))!.status).toBe("pending");
    expect((await eventCount())!.n).toBe(0);
  });

  it("rejects replayed deliveries with an old or future timestamp", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    const ev = mockEvent("payment.succeeded", co.provider_ref);
    const nowS = Math.floor(clock.nowMs() / 1000);
    expect((await deliver(ev, { at: nowS - 301 })).body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect((await deliver(ev, { at: nowS + 301 })).body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect((await payment(co.payment_id))!.status).toBe("pending");
    expect((await deliver(ev, { at: nowS - 200 })).status).toBe(200);
  });

  it("a duplicate event is acknowledged but applied once", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    const ev = mockEvent("payment.succeeded", co.provider_ref);
    expect((await deliver(ev)).body.result).toBe("processed");
    const dup = await deliver(ev);
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ result: "duplicate", original_result: "processed" });
    expect((await licensesOf(s.customerId)).results).toHaveLength(1);
    expect((await eventCount())!.n).toBe(1);
  });

  it("concurrent duplicate deliveries create exactly one license", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    const ev = mockEvent("payment.succeeded", co.provider_ref);
    const rs = await Promise.all(Array.from({ length: 5 }, () => deliver(ev)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.result === "processed")).toHaveLength(1);
    expect((await licensesOf(s.customerId)).results).toHaveLength(1);
    expect((await eventCount())!.n).toBe(1);
  });

  it("concurrent different success events for one renewal extend the license once", async () => {
    const s = await setup();
    const { license: lic } = await createLicense(s.admin, { user_id: s.customerId, plan_id: s.plan.id });
    const before = (await license(lic.id))!;
    const co = (await s.checkout({ license_id: lic.id })).body;
    const rs = await Promise.all([1, 2, 3].map(() => deliver(mockEvent("payment.succeeded", co.provider_ref))));
    // Losers either see the payment as already paid or get a retryable 409; none applies twice.
    for (const r of rs) expect([200, 409]).toContain(r.status);
    expect(rs.filter((r) => r.body.result === "processed")).toHaveLength(1);
    const after = (await license(lic.id))!;
    expect(after.version).toBe(before.version + 1);
    expect((await eventsOf(lic.id)).filter((e) => e.event_type === "license.renewed")).toHaveLength(1);
  });

  it("an event whose effects did not fully apply is rolled back, not recorded, and succeeds on retry", async () => {
    const s = await setup();
    const { license: lic } = await createLicense(s.admin, { user_id: s.customerId, plan_id: s.plan.id });
    const before = (await license(lic.id))!;
    const co = (await s.checkout({ license_id: lic.id })).body;
    const ev = mockEvent("payment.succeeded", co.provider_ref);
    // Simulate a concurrent admin edit landing between our read and our write: the license version moves.
    await db().prepare("CREATE TRIGGER test_race AFTER UPDATE OF status ON payments BEGIN UPDATE licenses SET version = version + 1 WHERE id = NEW.license_id; END").run();
    try {
      const r = await deliver(ev);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("CONFLICT");
    } finally {
      await db().prepare("DROP TRIGGER test_race").run();
    }
    expect((await payment(co.payment_id))!.status).toBe("pending");
    expect((await license(lic.id))!.expires_at).toBe(before.expires_at);
    expect((await eventCount())!.n).toBe(0);
    expect((await eventsOf(lic.id)).map((e) => e.event_type)).not.toContain("payment.paid");
    // Provider retries the same event: now it applies.
    expect((await deliver(ev)).body.result).toBe("processed");
    expect((await payment(co.payment_id))!.status).toBe("paid");
  });

  it("an amount mismatch is recorded for review and changes nothing", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    const r = await deliver(mockEvent("payment.succeeded", co.provider_ref, 100));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("PAYMENT_MISMATCH");
    expect((await payment(co.payment_id))!.status).toBe("pending");
    expect((await licensesOf(s.customerId)).results).toHaveLength(0);
    const rejected = await db().prepare("SELECT details_json FROM license_events WHERE event_type = 'payment.rejected'").all<{ details_json: string }>();
    expect(JSON.parse(rejected.results[0]!.details_json).reason).toBe("amount_or_currency_mismatch");
  });

  it("a currency mismatch is rejected", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    const r = await deliver(mockEvent("payment.succeeded", co.provider_ref, 99000, "USD"));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("PAYMENT_MISMATCH");
    expect((await payment(co.payment_id))!.status).toBe("pending");
  });

  it("a refund marks the payment refunded and suspends the license for admin review", async () => {
    const s = await setup();
    const co = (await s.checkout()).body;
    await deliver(mockEvent("payment.succeeded", co.provider_ref));
    const licId = (await payment(co.payment_id))!.license_id;
    const r = await deliver(mockEvent("payment.refunded", co.provider_ref));
    expect(r.body.result).toBe("processed");
    expect((await payment(co.payment_id))!).toMatchObject({ status: "refunded" });
    expect((await license(licId))!.status).toBe("suspended");
    const susp = (await eventsOf(licId)).find((e) => e.event_type === "license.suspended")!;
    expect(susp.actor_type).toBe("provider");
    expect(JSON.parse(susp.details_json).reason).toContain("admin review");
    // A second refund/chargeback for the same payment changes nothing more.
    expect((await deliver(mockEvent("payment.chargeback", co.provider_ref))).body.result).toBe("ignored_status");
  });

  it("a chargeback on a renewal suspends the license; failure events mark pending payments failed", async () => {
    const s = await setup();
    const { license: lic } = await createLicense(s.admin, { user_id: s.customerId, plan_id: s.plan.id });
    const co = (await s.checkout({ license_id: lic.id })).body;
    await deliver(mockEvent("payment.succeeded", co.provider_ref));
    await deliver(mockEvent("payment.chargeback", co.provider_ref));
    expect((await license(lic.id))!.status).toBe("suspended");

    const co2 = (await s.checkout()).body;
    expect((await deliver(mockEvent("payment.failed", co2.provider_ref))).body.result).toBe("processed");
    expect((await payment(co2.payment_id))!.status).toBe("failed");
    // A later success for the same payment (customer retried) still goes through.
    expect((await deliver(mockEvent("payment.succeeded", co2.provider_ref))).body.result).toBe("processed");
    expect((await payment(co2.payment_id))!.status).toBe("paid");
  });

  it("a payment for a license revoked after checkout is marked paid and flagged for review", async () => {
    const s = await setup();
    const { license: lic } = await createLicense(s.admin, { user_id: s.customerId, plan_id: s.plan.id });
    const co = (await s.checkout({ license_id: lic.id })).body;
    await call(`/api/v1/admin/licenses/${lic.id}/revoke`, { cookie: s.admin, json: { reason: "fraud check" } });
    const r = await deliver(mockEvent("payment.succeeded", co.provider_ref));
    expect(r.body.result).toBe("paid_needs_review");
    expect((await license(lic.id))!.status).toBe("revoked");
  });

  it("unknown providers, unknown payments, and malformed events are handled safely", async () => {
    await setup();
    const nope = await call("/api/v1/webhooks/payments/stripe", { body: "{}", headers: { "Content-Type": "application/json" } });
    expect(nope.status).toBe(404);
    expect((await deliver(mockEvent("payment.succeeded", "mock_does_not_exist"))).body.result).toBe("ignored_unknown_payment");
    const bad = await deliver({ id: "evt_x", type: "payment.stolen", created: 1, data: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("customers can list their own payments only", async () => {
    const s = await setup();
    await s.checkout();
    const mine = await call("/api/v1/me/payments", { bearer: s.token });
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).not.toHaveProperty("provider_ref");
    await createUser("other@gtrp.test");
    const other = await call("/api/v1/me/payments", { bearer: await loginToken("other@gtrp.test") });
    expect(other.body.data).toHaveLength(0);
  });
});
