import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const db = () => env.DB;
const now = "2026-10-25T00:00:00.000Z";

async function tableNames() {
  const r = await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  return r.results.map((x) => x.name);
}

async function seedUserAndPlan(billing: "monthly" | "lifetime" = "monthly") {
  const userId = crypto.randomUUID();
  const planId = crypto.randomUUID();
  await db().batch([
    db().prepare("INSERT INTO users (id, email, role, status, created_at, updated_at) VALUES (?, ?, 'customer', 'active', ?, ?)").bind(userId, `${userId}@example.test`, now, now),
    db()
      .prepare(
        `INSERT INTO plans (id, code, name, price_minor, currency, billing_period, max_web_devices, max_ea_activations, max_trading_accounts, features_json, created_at, updated_at)
         VALUES (?, ?, 'P', 0, 'THB', ?, 1, 1, 1, '{}', ?, ?)`,
      )
      .bind(planId, `P_${planId.slice(0, 8).toUpperCase()}`, billing, now, now),
  ]);
  return { userId, planId };
}

function insertLicense(id: string, userId: string, planId: string, expiresAt: string | null, keyHash: string | null = null) {
  return db()
    .prepare(
      "INSERT INTO licenses (id, user_id, plan_id, key_hash, status, starts_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)",
    )
    .bind(id, userId, planId, keyHash, now, expiresAt, now, now)
    .run();
}

describe("database migrations (clean database)", () => {
  it("creates every table", async () => {
    const names = await tableNames();
    for (const t of ["users", "plans", "licenses", "activations", "sessions", "payments", "payment_events", "license_events", "api_rate_limits", "request_nonces"]) {
      expect(names).toContain(t);
    }
  });

  it("records the migration as applied", async () => {
    const r = await db().prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toContain("0001_initial_schema.sql");
  });

  it("enforces unique, case-insensitive email", async () => {
    await db().prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, 'dup@example.test', ?, ?)").bind(crypto.randomUUID(), now, now).run();
    await expect(
      db().prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, 'DUP@example.test', ?, ?)").bind(crypto.randomUUID(), now, now).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("rejects invalid enum values via CHECK constraints", async () => {
    await expect(
      db().prepare("INSERT INTO users (id, email, role, created_at, updated_at) VALUES (?, 'x@example.test', 'superadmin', ?, ?)").bind(crypto.randomUUID(), now, now).run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("enforces foreign keys", async () => {
    await expect(insertLicense(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), "2027-01-01T00:00:00.000Z")).rejects.toThrow(/FOREIGN KEY/);
  });

  it("only allows a NULL expiry for lifetime plans", async () => {
    const monthly = await seedUserAndPlan("monthly");
    await expect(insertLicense(crypto.randomUUID(), monthly.userId, monthly.planId, null)).rejects.toThrow(/lifetime/);
    const lifetime = await seedUserAndPlan("lifetime");
    await expect(insertLicense(crypto.randomUUID(), lifetime.userId, lifetime.planId, null)).resolves.toBeTruthy();
  });

  it("enforces unique license key hashes", async () => {
    const { userId, planId } = await seedUserAndPlan();
    await insertLicense(crypto.randomUUID(), userId, planId, "2027-01-01T00:00:00.000Z", "hash-1");
    await expect(insertLicense(crypto.randomUUID(), userId, planId, "2027-01-01T00:00:00.000Z", "hash-1")).rejects.toThrow(/UNIQUE/);
  });

  it("makes revoked licenses terminal", async () => {
    const { userId, planId } = await seedUserAndPlan();
    const id = crypto.randomUUID();
    await insertLicense(id, userId, planId, "2027-01-01T00:00:00.000Z");
    await db().prepare("UPDATE licenses SET status = 'revoked' WHERE id = ?").bind(id).run();
    await expect(db().prepare("UPDATE licenses SET status = 'active' WHERE id = ?").bind(id).run()).rejects.toThrow(/revoked/);
  });

  it("enforces unique activation identity", async () => {
    const { userId, planId } = await seedUserAndPlan();
    const lid = crypto.randomUUID();
    await insertLicense(lid, userId, planId, "2027-01-01T00:00:00.000Z");
    const ins = () =>
      db()
        .prepare("INSERT INTO activations (id, license_id, activation_type, product, device_hash, first_seen_at, last_seen_at) VALUES (?, ?, 'mt5', 'gtrp_ea', 'dev-1', ?, ?)")
        .bind(crypto.randomUUID(), lid, now, now)
        .run();
    await ins();
    await expect(ins()).rejects.toThrow(/UNIQUE/);
  });

  it("enforces unique provider transaction ids and webhook event ids", async () => {
    const { userId, planId } = await seedUserAndPlan();
    const ins = () =>
      db()
        .prepare(
          "INSERT INTO payments (id, user_id, plan_id, provider, provider_ref, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, 'mock', 'tx-1', 100, 'THB', 'pending', ?, ?)",
        )
        .bind(crypto.randomUUID(), userId, planId, now, now)
        .run();
    await ins();
    await expect(ins()).rejects.toThrow(/UNIQUE/);
    const ev = () =>
      db()
        .prepare("INSERT INTO payment_events (id, provider, provider_event_id, event_type, payload_sha256, result, received_at) VALUES (?, 'mock', 'evt-1', 'x', 'h', 'ok', ?)")
        .bind(crypto.randomUUID(), now)
        .run();
    await ev();
    await expect(ev()).rejects.toThrow(/UNIQUE/);
  });

  it("keeps audit events append-only", async () => {
    const id = crypto.randomUUID();
    await db().prepare("INSERT INTO license_events (id, actor_type, event_type, created_at) VALUES (?, 'system', 'license.created', ?)").bind(id, now).run();
    await expect(db().prepare("UPDATE license_events SET event_type = 'x' WHERE id = ?").bind(id).run()).rejects.toThrow(/append-only/);
  });
});
