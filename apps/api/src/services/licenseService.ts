import {
  addBillingPeriods,
  computeEffectiveStatus,
  ERROR_CODES,
  nextLicenseStatus,
  type AdminCreateLicenseInput,
  type AdminRenewInput,
  type AdminUpdateLicenseInput,
  type AuditEventType,
  type LicenseAction,
  type LicenseStatus,
  type LicenseSummary,
} from "@gtrp/shared";
import { clock, nowIso } from "../clock.js";
import type { Env } from "../env.js";
import { AppError, errors } from "../errors/index.js";
import { auditIfLicenseOp, auditStatement, type AuditEvent } from "../repositories/events.js";
import { getLicense, getUsage, listLicensesForUser, type LicenseWithPlan, type Usage } from "../repositories/licenses.js";
import { getPlan, parseEntitlements } from "../repositories/plans.js";
import type { PlanRow } from "../repositories/types.js";
import { findUserByEmail, findUserById } from "../repositories/users.js";
import { generateLicenseKey, hashLicenseKey, licenseKeyHint, maskLicenseKey } from "../security/licenseKey.js";

export interface Actor {
  userId: string | null;
  type: AuditEvent["actorType"];
}

export function toLicenseSummary(l: LicenseWithPlan, usage: Usage, nowMs = clock.nowMs()): LicenseSummary {
  const eff = computeEffectiveStatus(l, nowMs);
  return {
    id: l.id,
    status: l.status,
    effective_status: eff.status,
    in_grace: eff.inGrace,
    key_hint: maskLicenseKey(l.key_hint),
    plan: { id: l.plan_id, code: l.plan_code, name: l.plan_name },
    starts_at: l.starts_at,
    expires_at: l.expires_at,
    grace_until: l.grace_until,
    entitlements: parseEntitlements(l.plan_features_json),
    usage: {
      web: { used: usage.web, max: l.plan_max_web_devices },
      ea: { used: usage.ea, max: l.plan_max_ea_activations },
      trading_accounts: { used: usage.trading_accounts, max: l.plan_max_trading_accounts },
    },
    created_at: l.created_at,
  };
}

export async function summarize(env: Env, l: LicenseWithPlan): Promise<LicenseSummary> {
  const usage = await getUsage(env.DB, [l.id]);
  return toLicenseSummary(l, usage.get(l.id)!);
}

export async function listCustomerLicenses(env: Env, userId: string): Promise<LicenseSummary[]> {
  const rows = await listLicensesForUser(env.DB, userId);
  const usage = await getUsage(env.DB, rows.map((r) => r.id));
  return rows.map((r) => toLicenseSummary(r, usage.get(r.id)!));
}

function defaultExpiry(plan: PlanRow, startsAt: string): string | null {
  return plan.billing_period === "lifetime" ? null : addBillingPeriods(startsAt, plan.billing_period, 1);
}

function graceFrom(expiresAt: string | null, graceDays: number): string | null {
  return expiresAt === null ? null : new Date(Date.parse(expiresAt) + graceDays * 86400_000).toISOString();
}

function assertDates(plan: PlanRow, startsAt: string, expiresAt: string | null, graceUntil: string | null) {
  if (expiresAt === null && plan.billing_period !== "lifetime") {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Only lifetime plans can have no expiration date.", [
      { path: "expires_at", message: "Required for non-lifetime plans" },
    ]);
  }
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Expiration must be after the start date.", [
      { path: "expires_at", message: "Must be after starts_at" },
    ]);
  }
  if (graceUntil !== null && (expiresAt === null || Date.parse(graceUntil) < Date.parse(expiresAt))) {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Grace period must end on or after the expiration date.", [
      { path: "grace_until", message: "Must be >= expires_at" },
    ]);
  }
}

/** Creates a license and returns the plaintext key exactly once. */
export async function createLicense(env: Env, input: AdminCreateLicenseInput & { grace_days: number; activate: boolean }, actor: Actor) {
  const db = env.DB;
  const user = input.user_id ? await findUserById(db, input.user_id) : await findUserByEmail(db, input.email!);
  if (!user || user.status === "deleted" || user.role !== "customer") throw errors.notFound("Customer");
  const plan = await getPlan(db, input.plan_id);
  if (!plan) throw errors.notFound("Plan");
  if (!plan.is_active) throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "This plan is disabled.");

  const now = nowIso();
  const startsAt = input.starts_at ?? now;
  const expiresAt = input.expires_at === undefined ? defaultExpiry(plan, startsAt) : input.expires_at;
  const graceUntil = graceFrom(expiresAt, input.grace_days);
  assertDates(plan, startsAt, expiresAt, graceUntil);

  const id = crypto.randomUUID();
  const key = generateLicenseKey();
  const status: LicenseStatus = input.activate ? "active" : "created";
  await db.batch([
    db
      .prepare(
        `INSERT INTO licenses (id, user_id, plan_id, key_hash, key_hint, status, starts_at, expires_at, grace_until, note, version, last_op_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(id, user.id, plan.id, await hashLicenseKey(env.LICENSE_KEY_PEPPER, key), licenseKeyHint(key), status, startsAt, expiresAt, graceUntil, input.note ?? null, crypto.randomUUID(), now, now),
    auditStatement(
      db,
      {
        licenseId: id,
        actorUserId: actor.userId,
        actorType: actor.type,
        targetUserId: user.id,
        eventType: "license.created",
        details: { plan_code: plan.code, status, starts_at: startsAt, expires_at: expiresAt, grace_until: graceUntil, note: input.note ?? null },
      },
      now,
    ),
  ]);
  const created = (await getLicense(db, id))!;
  return { license: await summarize(env, created), license_key: key };
}

async function loadOrThrow(env: Env, id: string) {
  const l = await getLicense(env.DB, id);
  if (!l) throw errors.notFound("License");
  return l;
}

/** Applies a versioned UPDATE plus its audit event atomically; throws CONFLICT if the row changed concurrently. */
async function applyVersioned(env: Env, l: LicenseWithPlan, setSql: string, args: unknown[], event: AuditEvent, extra: D1PreparedStatement[] = []) {
  const db = env.DB;
  const opId = crypto.randomUUID();
  const now = nowIso();
  const res = await db.batch([
    db
      .prepare(`UPDATE licenses SET ${setSql}, version = version + 1, last_op_id = ?, updated_at = ? WHERE id = ? AND version = ?`)
      .bind(...args, opId, now, l.id, l.version),
    auditIfLicenseOp(db, event, l.id, opId, now),
    ...extra,
  ]);
  if (res[0]!.meta.changes !== 1) throw errors.conflict();
  return (await getLicense(db, l.id))!;
}

const ACTION_EVENTS: Record<Exclude<LicenseAction, "renew" | "expire">, AuditEventType> = {
  activate: "license.activated",
  suspend: "license.suspended",
  reactivate: "license.reactivated",
  revoke: "license.revoked",
};

export async function transitionLicense(env: Env, id: string, action: "activate" | "suspend" | "reactivate" | "revoke", actor: Actor, reason: string) {
  const l = await loadOrThrow(env, id);
  const to = nextLicenseStatus(l.status, action);
  if (!to) throw errors.invalidTransition(l.status, action);
  const now = nowIso();
  // Revocation also revokes every activation in the same transaction - but only if the license update applies.
  const extra =
    action === "revoke"
      ? [
          env.DB.prepare(
            `UPDATE activations SET status = 'revoked', revoked_at = ?, revoked_reason = 'license_revoked'
             WHERE license_id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM licenses WHERE id = ? AND status = 'revoked')`,
          ).bind(now, l.id, l.id),
        ]
      : [];
  const updated = await applyVersioned(
    env,
    l,
    "status = ?",
    [to],
    { licenseId: l.id, actorUserId: actor.userId, actorType: actor.type, targetUserId: l.user_id, eventType: ACTION_EVENTS[action], details: { from: l.status, to, reason } },
    extra,
  );
  return summarize(env, updated);
}

/** Computes the renewed expiry: from the later of now and the current expiry, so early renewals never lose time. */
export function computeRenewal(l: { expires_at: string | null; grace_until: string | null }, billing: PlanRow["billing_period"], input: { expires_at?: string; periods?: number }, nowMs: number) {
  if (billing === "lifetime") throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Lifetime licenses do not need renewal.");
  const graceMs = l.expires_at && l.grace_until ? Date.parse(l.grace_until) - Date.parse(l.expires_at) : 3 * 86400_000;
  let expiresAt: string;
  if (input.expires_at) {
    expiresAt = input.expires_at;
  } else {
    const base = l.expires_at && Date.parse(l.expires_at) > nowMs ? l.expires_at : new Date(nowMs).toISOString();
    expiresAt = addBillingPeriods(base, billing, input.periods ?? 1);
  }
  if (Date.parse(expiresAt) <= nowMs) throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "The new expiration must be in the future.");
  return { expiresAt, graceUntil: new Date(Date.parse(expiresAt) + graceMs).toISOString() };
}

export async function renewLicense(env: Env, id: string, input: AdminRenewInput, actor: Actor) {
  const l = await loadOrThrow(env, id);
  const to = nextLicenseStatus(l.status, "renew");
  if (!to) throw errors.invalidTransition(l.status, "renew");
  const { expiresAt, graceUntil } = computeRenewal(l, l.plan_billing_period, input, clock.nowMs());
  if (Date.parse(expiresAt) <= Date.parse(l.starts_at)) throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Expiration must be after the start date.");
  const updated = await applyVersioned(env, l, "status = ?, expires_at = ?, grace_until = ?", [to, expiresAt, graceUntil], {
    licenseId: l.id,
    actorUserId: actor.userId,
    actorType: actor.type,
    targetUserId: l.user_id,
    eventType: "license.renewed",
    details: { from: l.status, to, previous_expires_at: l.expires_at, expires_at: expiresAt, grace_until: graceUntil, reason: input.reason },
  });
  return summarize(env, updated);
}

export async function updateLicense(env: Env, id: string, patch: AdminUpdateLicenseInput, actor: Actor) {
  const l = await loadOrThrow(env, id);
  if (l.status === "revoked") throw errors.invalidTransition("revoked", "edit");
  let plan: PlanRow | null = null;
  if (patch.plan_id !== undefined && patch.plan_id !== l.plan_id) {
    plan = await getPlan(env.DB, patch.plan_id);
    if (!plan) throw errors.notFound("Plan");
  }
  const billing = plan?.billing_period ?? l.plan_billing_period;
  const next = {
    plan_id: patch.plan_id ?? l.plan_id,
    starts_at: patch.starts_at ?? l.starts_at,
    expires_at: patch.expires_at === undefined ? l.expires_at : patch.expires_at,
    grace_until: patch.grace_until === undefined ? l.grace_until : patch.grace_until,
  };
  if (next.expires_at === null) next.grace_until = null;
  assertDates({ billing_period: billing } as PlanRow, next.starts_at, next.expires_at, next.grace_until);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] !== l[k]) changes[k] = { from: l[k], to: next[k] };
  if (Object.keys(changes).length === 0) return summarize(env, l);
  const updated = await applyVersioned(env, l, "plan_id = ?, starts_at = ?, expires_at = ?, grace_until = ?, note = COALESCE(?, note)", [next.plan_id, next.starts_at, next.expires_at, next.grace_until, patch.note ?? null], {
    licenseId: l.id,
    actorUserId: actor.userId,
    actorType: actor.type,
    targetUserId: l.user_id,
    eventType: "license.updated",
    details: { changes, note: patch.note ?? null },
  });
  return summarize(env, updated);
}

/**
 * Issues a new key and invalidates the old one. Existing activations stay
 * linked to the license; EA users must enter the new key.
 */
export async function reissueKey(env: Env, id: string, actor: Actor, ownerUserId?: string) {
  const l = await loadOrThrow(env, id);
  if (ownerUserId !== undefined && l.user_id !== ownerUserId) throw errors.notFound("License");
  if (l.status === "revoked") throw errors.invalidTransition("revoked", "reissue a key for");
  const key = generateLicenseKey();
  const updated = await applyVersioned(env, l, "key_hash = ?, key_hint = ?", [await hashLicenseKey(env.LICENSE_KEY_PEPPER, key), licenseKeyHint(key)], {
    licenseId: l.id,
    actorUserId: actor.userId,
    actorType: actor.type,
    targetUserId: l.user_id,
    eventType: "license.key_reissued",
    details: { previous_hint: l.key_hint, new_hint: licenseKeyHint(key) },
  });
  return { license: await summarize(env, updated), license_key: key };
}
