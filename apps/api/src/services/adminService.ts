import { ERROR_CODES, type PlanCreateInput, type PlanUpdateInput } from "@gtrp/shared";
import { planCreateInput } from "@gtrp/shared";
import type { z } from "zod";
import { clock, nowIso } from "../clock.js";
import type { Env } from "../env.js";
import { AppError, errors } from "../errors/index.js";
import { getActivation, listActivationsForLicense, revokeActivationStatement, toActivation } from "../repositories/activations.js";
import { auditStatement } from "../repositories/events.js";
import { getUsage, listLicensesForUser } from "../repositories/licenses.js";
import { getPlan, toPlan } from "../repositories/plans.js";
import { revokeUserSessionsStatement } from "../repositories/sessions.js";
import { findUserById } from "../repositories/users.js";
import { anonymizeUser } from "./authService.js";
import { toLicenseSummary, type Actor } from "./licenseService.js";

export async function metrics(env: Env) {
  const db = env.DB;
  const now = nowIso();
  const in7d = new Date(clock.nowMs() + 7 * 86400_000).toISOString();
  const dayAgo = new Date(clock.nowMs() - 86400_000).toISOString();
  const [counts, failures, recent, byType] = await db.batch([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE role = 'customer' AND status <> 'deleted') AS total_customers,
           (SELECT COUNT(*) FROM licenses WHERE status = 'active' AND starts_at <= ?1
              AND (expires_at IS NULL OR COALESCE(grace_until, expires_at) > ?1)) AS active_licenses,
           (SELECT COUNT(*) FROM licenses WHERE status = 'expired'
              OR (status = 'active' AND expires_at IS NOT NULL AND COALESCE(grace_until, expires_at) <= ?1)) AS expired_licenses,
           (SELECT COUNT(*) FROM licenses WHERE status = 'suspended') AS suspended_licenses,
           (SELECT COUNT(*) FROM licenses WHERE status = 'revoked') AS revoked_licenses,
           (SELECT COUNT(*) FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL
              AND expires_at > ?1 AND expires_at <= ?2) AS expiring_within_7_days`,
      )
      .bind(now, in7d),
    db.prepare("SELECT COUNT(*) AS n FROM license_events WHERE event_type = 'activation.failed' AND created_at >= ?").bind(dayAgo),
    db
      .prepare(
        `SELECT e.id, e.license_id, e.details_json, e.created_at, u.email
         FROM license_events e LEFT JOIN users u ON u.id = e.target_user_id
         WHERE e.event_type = 'activation.failed' ORDER BY e.created_at DESC LIMIT 10`,
      ),
    db.prepare("SELECT activation_type, COUNT(*) AS n FROM activations WHERE status = 'active' GROUP BY activation_type"),
  ]);
  const activeByType: Record<string, number> = { web: 0, mt4: 0, mt5: 0 };
  for (const r of byType!.results as { activation_type: string; n: number }[]) activeByType[r.activation_type] = r.n;
  return {
    generated_at: now,
    ...(counts!.results[0] as Record<string, number>),
    activation_failures_24h: (failures!.results[0] as { n: number }).n,
    active_activations: activeByType,
    recent_activation_failures: (recent!.results as { id: string; license_id: string | null; details_json: string; created_at: string; email: string | null }[]).map((r) => ({
      id: r.id,
      license_id: r.license_id,
      customer_email: r.email,
      created_at: r.created_at,
      ...(JSON.parse(r.details_json) as Record<string, unknown>),
    })),
  };
}

export async function customerDetail(env: Env, userId: string) {
  const user = await findUserById(env.DB, userId);
  if (!user || user.role !== "customer") throw errors.notFound("Customer");
  const licenses = await listLicensesForUser(env.DB, userId);
  const usage = await getUsage(env.DB, licenses.map((l) => l.id));
  const payments = await env.DB.prepare(
    "SELECT id, license_id, plan_id, provider, provider_ref, amount_minor, currency, status, paid_at, refunded_at, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(userId)
    .all();
  return {
    customer: { id: user.id, email: user.email, status: user.status, created_at: user.created_at, deleted_at: user.deleted_at },
    licenses: licenses.map((l) => toLicenseSummary(l, usage.get(l.id)!)),
    payments: payments.results,
  };
}

export async function setCustomerStatus(env: Env, userId: string, status: "active" | "suspended", reason: string, actor: Actor) {
  const db = env.DB;
  const user = await findUserById(db, userId);
  if (!user || user.role !== "customer" || user.status === "deleted") throw errors.notFound("Customer");
  if (user.status === status) return { id: user.id, status };
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'").bind(status, now, userId),
    ...(status === "suspended" ? [revokeUserSessionsStatement(db, userId, now)] : []),
    auditStatement(db, { actorUserId: actor.userId, actorType: actor.type, targetUserId: userId, eventType: "user.status_changed", details: { from: user.status, to: status, reason } }, now),
  ]);
  return { id: user.id, status };
}

export async function deleteCustomer(env: Env, userId: string, reason: string, actor: Actor) {
  const user = await findUserById(env.DB, userId);
  if (!user || user.role !== "customer") throw errors.notFound("Customer");
  if (user.status === "deleted") return;
  await anonymizeUser(env, userId, actor.userId!, "admin", reason);
}

export async function licenseDetail(env: Env, l: Parameters<typeof toLicenseSummary>[0]) {
  const usage = await getUsage(env.DB, [l.id]);
  const owner = await findUserById(env.DB, l.user_id);
  return {
    license: { ...toLicenseSummary(l, usage.get(l.id)!), note: l.note, user: owner ? { id: owner.id, email: owner.email, status: owner.status } : null },
    activations: (await listActivationsForLicense(env.DB, l.id)).map(toActivation),
  };
}

/** Admin "reset activation": frees the slot. The installation may activate again later if quota allows. */
export async function revokeActivation(env: Env, activationId: string, reason: string, actor: Actor) {
  const db = env.DB;
  const a = await getActivation(db, activationId);
  if (!a) throw errors.notFound("Activation");
  if (a.status !== "active") return toActivation(a);
  const lic = await db.prepare("SELECT user_id FROM licenses WHERE id = ?").bind(a.license_id).first<{ user_id: string }>();
  const now = nowIso();
  await db.batch([
    revokeActivationStatement(db, a.id, now, "revoked_by_admin"),
    auditStatement(db, {
      licenseId: a.license_id,
      actorUserId: actor.userId,
      actorType: actor.type,
      targetUserId: lic?.user_id ?? null,
      eventType: "activation.revoked",
      details: { activation_id: a.id, platform: a.activation_type, reason },
    }, now),
  ]);
  return toActivation((await getActivation(db, a.id))!);
}

type PlanCreate = z.output<typeof planCreateInput>;

export async function createPlan(env: Env, input: PlanCreateInput, actor: Actor) {
  const p = planCreateInput.parse(input) as PlanCreate;
  const db = env.DB;
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO plans (id, code, name, price_minor, currency, billing_period, max_web_devices, max_ea_activations, max_trading_accounts, features_json, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, p.code, p.name, p.price_minor, p.currency, p.billing_period, p.max_web_devices, p.max_ea_activations, p.max_trading_accounts, JSON.stringify(p.entitlements), p.is_active ? 1 : 0, now, now),
      auditStatement(db, { actorUserId: actor.userId, actorType: actor.type, eventType: "plan.created", details: { plan_id: id, ...p } }, now),
    ]);
  } catch (e) {
    if (/UNIQUE/.test((e as Error).message)) throw new AppError(409, ERROR_CODES.CONFLICT, "A plan with this code already exists.");
    throw e;
  }
  return toPlan((await getPlan(db, id))!);
}

const PLAN_COLUMNS: Record<string, string> = {
  name: "name",
  price_minor: "price_minor",
  currency: "currency",
  billing_period: "billing_period",
  max_web_devices: "max_web_devices",
  max_ea_activations: "max_ea_activations",
  max_trading_accounts: "max_trading_accounts",
  entitlements: "features_json",
  is_active: "is_active",
};

/**
 * Plan edits apply to every license on the plan from the next request on.
 * Lowering a limit does not revoke existing activations; it blocks new ones until usage drops.
 */
export async function updatePlan(env: Env, id: string, patch: PlanUpdateInput & Record<string, unknown>, actor: Actor) {
  const db = env.DB;
  const before = await getPlan(db, id);
  if (!before) throw errors.notFound("Plan");
  if (patch.billing_period === "lifetime" || (before.billing_period === "lifetime" && patch.billing_period)) {
    if (patch.billing_period !== before.billing_period) {
      throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Changing a plan to or from lifetime is not allowed; create a new plan instead.");
    }
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = PLAN_COLUMNS[k];
    if (!col || v === undefined) continue;
    sets.push(`${col} = ?`);
    args.push(k === "entitlements" ? JSON.stringify(v) : typeof v === "boolean" ? (v ? 1 : 0) : v);
  }
  const now = nowIso();
  await db.batch([
    db.prepare(`UPDATE plans SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...args, now, id),
    auditStatement(db, { actorUserId: actor.userId, actorType: actor.type, eventType: "plan.updated", details: { plan_id: id, code: before.code, before: toPlan(before), changes: patch } }, now),
  ]);
  return toPlan((await getPlan(db, id))!);
}
