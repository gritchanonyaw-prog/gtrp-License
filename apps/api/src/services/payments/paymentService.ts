import { addBillingPeriods, ERROR_CODES, nextLicenseStatus, type CheckoutInput } from "@gtrp/shared";
import { clock, nowIso } from "../../clock.js";
import type { Env } from "../../env.js";
import { AppError, errors } from "../../errors/index.js";
import { auditStatement, type AuditEvent } from "../../repositories/events.js";
import { getLicense } from "../../repositories/licenses.js";
import { getPaymentByProviderRef, getPaymentEvent } from "../../repositories/payments.js";
import { getPlan } from "../../repositories/plans.js";
import type { PaymentRow } from "../../repositories/types.js";
import { findUserById } from "../../repositories/users.js";
import { sha256Hex } from "../../security/crypto.js";
import { log } from "../../security/redact.js";
import { computeRenewal } from "../licenseService.js";
import { checkoutProvider, getProvider, type NormalizedPaymentEvent } from "./provider.js";

/** Grace period given to licenses created by a payment (same default as admin-created licenses). */
const PAID_LICENSE_GRACE_DAYS = 3;

function paymentsDisabled(): AppError {
  return new AppError(503, ERROR_CODES.PAYMENTS_DISABLED, "Online payments are not enabled.");
}

/**
 * Starts a checkout: creates a pending payment priced from the plan (never from the client).
 * The license is created or renewed only later, by a verified provider webhook.
 */
export async function createCheckout(env: Env, userId: string, input: CheckoutInput) {
  const provider = checkoutProvider(env);
  if (!provider) throw paymentsDisabled();
  const db = env.DB;
  const user = await findUserById(db, userId);
  if (!user || user.status !== "active" || user.role !== "customer") throw errors.forbidden();
  const plan = await getPlan(db, input.plan_id);
  if (!plan || !plan.is_active) throw errors.notFound("Plan");
  if (plan.price_minor <= 0) throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "This plan cannot be purchased online.");
  if (input.license_id !== undefined) {
    const l = await getLicense(db, input.license_id);
    if (!l || l.user_id !== userId) throw errors.notFound("License");
    if (l.status === "revoked") throw errors.invalidTransition("revoked", "renew");
    if (l.plan_id !== plan.id) {
      throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "A renewal must use the license's current plan. Contact support to change plans.", [
        { path: "plan_id", message: "Must match the license plan" },
      ]);
    }
    if (plan.billing_period === "lifetime") throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Lifetime licenses do not need renewal.");
  }

  const id = crypto.randomUUID();
  const session = await provider.createCheckout(env, { id, amount_minor: plan.price_minor, currency: plan.currency });
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO payments (id, user_id, license_id, plan_id, provider, provider_ref, amount_minor, currency, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(id, userId, input.license_id ?? null, plan.id, provider.name, session.providerRef, plan.price_minor, plan.currency, now, now),
    auditStatement(
      db,
      {
        licenseId: input.license_id ?? null,
        actorUserId: userId,
        actorType: "customer",
        targetUserId: userId,
        eventType: "payment.created",
        details: { payment_id: id, provider: provider.name, plan_code: plan.code, amount_minor: plan.price_minor, currency: plan.currency, purpose: input.license_id ? "renewal" : "new_license" },
      },
      now,
    ),
  ]);
  return { payment_id: id, provider: provider.name, provider_ref: session.providerRef, amount_minor: plan.price_minor, currency: plan.currency, checkout_url: session.checkoutUrl };
}

export type WebhookResult =
  | "processed"
  | "duplicate"
  | "paid_needs_review"
  | "rejected_mismatch"
  | "ignored_unknown_payment"
  | "ignored_already_paid"
  | "ignored_status";

interface Plan {
  statements: D1PreparedStatement[];
  result: WebhookResult;
  /** SQL that must be true after the effect statements ran, or the whole batch is rolled back. */
  guard: { sql: string; args: unknown[] } | null;
}

const PROVIDER_ACTOR = { actorUserId: null, actorType: "provider" } as const;

/**
 * Handles one provider webhook delivery.
 *
 * Idempotency and atomicity: every effect of an event (payment status, license
 * renewal/creation/suspension, audit events) and the payment_events row are
 * written in ONE D1 batch (a transaction). The payment_events row is inserted
 * last and its NOT NULL `result` is only filled when the guard confirms the
 * effects really applied; otherwise the insert fails and the whole batch rolls
 * back. Consequences:
 *  - a redelivered event hits the unique (provider, provider_event_id) index
 *    and changes nothing;
 *  - an event that lost a race is not recorded, gets 409, and is processed
 *    against fresh state when the provider retries.
 */
export async function handleWebhook(env: Env, providerName: string, rawBody: string, headers: Headers) {
  const provider = getProvider(env, providerName);
  if (!provider) throw errors.notFound("Payment provider");
  const ev = await provider.parseWebhook(env, rawBody, headers, clock.nowMs());
  const db = env.DB;

  const seen = await getPaymentEvent(db, provider.name, ev.eventId);
  if (seen) return { received: true, result: "duplicate" as const, original_result: seen.result };

  const payment = await getPaymentByProviderRef(db, provider.name, ev.providerRef);
  const now = nowIso();
  const plan = await planEffects(env, ev, payment, now);
  const payloadHash = await sha256Hex(rawBody);
  const guardSql = plan.guard?.sql ?? "1";
  const insertEvent = db
    .prepare(
      `INSERT INTO payment_events (id, provider, provider_event_id, payment_id, event_type, payload_sha256, result, received_at)
       VALUES (?, ?, ?, ?, ?, ?, CASE WHEN (${guardSql}) THEN ? END, ?)`,
    )
    .bind(crypto.randomUUID(), provider.name, ev.eventId, payment?.id ?? null, ev.type, payloadHash, ...(plan.guard?.args ?? []), plan.result, now);

  try {
    await db.batch([...plan.statements, insertEvent]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("UNIQUE constraint failed: payment_events")) {
      const again = await getPaymentEvent(db, provider.name, ev.eventId);
      return { received: true, result: "duplicate" as const, original_result: again?.result ?? null };
    }
    if (msg.includes("NOT NULL constraint failed: payment_events.result")) {
      log("warn", "payment.webhook_conflict", { provider: provider.name, event_type: ev.type });
      throw errors.conflict("The payment changed while this event was processed. Retry the delivery.");
    }
    throw e;
  }

  log("info", "payment.webhook_processed", { provider: provider.name, event_type: ev.type, result: plan.result });
  if (plan.result === "rejected_mismatch") {
    throw new AppError(422, ERROR_CODES.PAYMENT_MISMATCH, "Amount or currency does not match the payment. The event was recorded for review.");
  }
  return { received: true, result: plan.result };
}

function audit(db: D1Database, e: Omit<AuditEvent, "actorType" | "actorUserId">, now: string) {
  return auditStatement(db, { ...PROVIDER_ACTOR, ...e }, now);
}

async function planEffects(env: Env, ev: NormalizedPaymentEvent, p: PaymentRow | null, now: string): Promise<Plan> {
  const db = env.DB;
  if (!p) {
    return {
      result: "ignored_unknown_payment",
      guard: null,
      statements: [audit(db, { eventType: "payment.rejected", details: { reason: "unknown_provider_ref", event_type: ev.type } }, now)],
    };
  }
  const base = { licenseId: p.license_id, targetUserId: p.user_id };

  if (ev.amountMinor !== p.amount_minor || ev.currency !== p.currency) {
    return {
      result: "rejected_mismatch",
      guard: null,
      statements: [
        audit(
          db,
          {
            ...base,
            eventType: "payment.rejected",
            details: { payment_id: p.id, reason: "amount_or_currency_mismatch", event_type: ev.type, expected: { amount_minor: p.amount_minor, currency: p.currency }, received: { amount_minor: ev.amountMinor, currency: ev.currency } },
          },
          now,
        ),
      ],
    };
  }

  switch (ev.type) {
    case "succeeded":
      return planSucceeded(env, ev, p, now);
    case "failed":
      if (p.status !== "pending") return { result: "ignored_status", guard: null, statements: [] };
      return {
        result: "processed",
        guard: { sql: "EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'failed')", args: [p.id] },
        statements: [
          db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, p.id),
          audit(db, { ...base, eventType: "payment.failed", details: { payment_id: p.id } }, now),
        ],
      };
    case "refunded":
    case "chargeback":
      return planRefund(env, ev, p, now);
  }
}

async function planSucceeded(env: Env, ev: NormalizedPaymentEvent, p: PaymentRow, now: string): Promise<Plan> {
  const db = env.DB;
  if (p.status === "paid") return { result: "ignored_already_paid", guard: null, statements: [] };
  if (p.status !== "pending" && p.status !== "failed") return { result: "ignored_status", guard: null, statements: [] };

  const opId = crypto.randomUUID();
  const paidGuard = "EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'paid' AND paid_event_id = ?)";
  const markPaid = (licenseId: string | null) =>
    db
      .prepare("UPDATE payments SET status = 'paid', paid_event_id = ?, paid_at = ?, license_id = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')")
      .bind(ev.eventId, now, licenseId, now, p.id);
  const paidAudit = (licenseId: string | null, details: Record<string, unknown>) =>
    audit(db, { licenseId, targetUserId: p.user_id, eventType: "payment.paid", details: { payment_id: p.id, amount_minor: p.amount_minor, currency: p.currency, ...details } }, now);

  // Renewal of an existing license.
  if (p.license_id) {
    const l = await getLicense(db, p.license_id);
    const to = l ? nextLicenseStatus(l.status, "renew") : null;
    if (!l || !to || l.plan_billing_period === "lifetime") {
      // Money was taken but the license cannot be renewed automatically (revoked, plan changed to lifetime, ...).
      return {
        result: "paid_needs_review",
        guard: { sql: paidGuard, args: [p.id, ev.eventId] },
        statements: [markPaid(p.license_id), paidAudit(p.license_id, { license_action: "none", review_reason: l ? `license is ${l.status}` : "license not found" })],
      };
    }
    const { expiresAt, graceUntil } = computeRenewal(l, l.plan_billing_period, { periods: 1 }, clock.nowMs());
    return {
      result: "processed",
      guard: { sql: `${paidGuard} AND EXISTS (SELECT 1 FROM licenses WHERE id = ? AND last_op_id = ?)`, args: [p.id, ev.eventId, l.id, opId] },
      statements: [
        markPaid(l.id),
        db
          .prepare("UPDATE licenses SET status = ?, expires_at = ?, grace_until = ?, version = version + 1, last_op_id = ?, updated_at = ? WHERE id = ? AND version = ?")
          .bind(to, expiresAt, graceUntil, opId, now, l.id, l.version),
        paidAudit(l.id, { license_action: "renewed" }),
        audit(
          db,
          {
            licenseId: l.id,
            targetUserId: l.user_id,
            eventType: "license.renewed",
            details: { from: l.status, to, previous_expires_at: l.expires_at, expires_at: expiresAt, grace_until: graceUntil, reason: `payment ${p.id}` },
          },
          now,
        ),
      ],
    };
  }

  // New license. It is created without a key; the customer reveals one with "reissue key" in their account.
  const plan = await getPlan(db, p.plan_id);
  if (!plan) {
    return { result: "paid_needs_review", guard: { sql: paidGuard, args: [p.id, ev.eventId] }, statements: [markPaid(null), paidAudit(null, { license_action: "none", review_reason: "plan not found" })] };
  }
  const licenseId = crypto.randomUUID();
  const expiresAt = plan.billing_period === "lifetime" ? null : addBillingPeriods(now, plan.billing_period, 1);
  const graceUntil = expiresAt === null ? null : new Date(Date.parse(expiresAt) + PAID_LICENSE_GRACE_DAYS * 86400_000).toISOString();
  return {
    result: "processed",
    guard: { sql: `${paidGuard} AND EXISTS (SELECT 1 FROM licenses WHERE id = ? AND last_op_id = ?)`, args: [p.id, ev.eventId, licenseId, opId] },
    statements: [
      db
        .prepare(
          `INSERT INTO licenses (id, user_id, plan_id, key_hash, key_hint, status, starts_at, expires_at, grace_until, note, version, last_op_id, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, 'active', ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(licenseId, p.user_id, plan.id, now, expiresAt, graceUntil, `Created by payment ${p.id}`, opId, now, now),
      markPaid(licenseId),
      audit(
        db,
        {
          licenseId,
          targetUserId: p.user_id,
          eventType: "license.created",
          details: { source: "payment", payment_id: p.id, plan_code: plan.code, status: "active", starts_at: now, expires_at: expiresAt, grace_until: graceUntil },
        },
        now,
      ),
      paidAudit(licenseId, { license_action: "created" }),
    ],
  };
}

async function planRefund(env: Env, ev: NormalizedPaymentEvent, p: PaymentRow, now: string): Promise<Plan> {
  const db = env.DB;
  if (p.status !== "paid") return { result: "ignored_status", guard: null, statements: [] };
  const refundGuard = "EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'refunded' AND refund_event_id = ?)";
  const statements = [
    db
      .prepare("UPDATE payments SET status = 'refunded', refunded_at = ?, refund_event_id = ?, updated_at = ? WHERE id = ? AND status = 'paid'")
      .bind(now, ev.eventId, now, p.id),
    audit(db, { licenseId: p.license_id, targetUserId: p.user_id, eventType: "payment.refunded", details: { payment_id: p.id, kind: ev.type } }, now),
  ];
  const l = p.license_id ? await getLicense(db, p.license_id) : null;
  const to = l ? nextLicenseStatus(l.status, "suspend") : null;
  if (!l || !to) return { result: "processed", guard: { sql: refundGuard, args: [p.id, ev.eventId] }, statements };

  // Suspend (not revoke) so an admin can review: a partial refund or a won dispute may justify reactivation.
  const opId = crypto.randomUUID();
  statements.push(
    db.prepare("UPDATE licenses SET status = ?, version = version + 1, last_op_id = ?, updated_at = ? WHERE id = ? AND version = ?").bind(to, opId, now, l.id, l.version),
    audit(db, { licenseId: l.id, targetUserId: l.user_id, eventType: "license.suspended", details: { from: l.status, to, reason: `payment ${ev.type}: admin review required (payment ${p.id})` } }, now),
  );
  return { result: "processed", guard: { sql: `${refundGuard} AND EXISTS (SELECT 1 FROM licenses WHERE id = ? AND last_op_id = ?)`, args: [p.id, ev.eventId, l.id, opId] }, statements };
}
