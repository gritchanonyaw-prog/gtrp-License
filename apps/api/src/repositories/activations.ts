import type { Activation, ActivationType } from "@gtrp/shared";
import type { ActivationRow } from "./types.js";

export function toActivation(r: ActivationRow): Activation {
  return {
    id: r.id,
    license_id: r.license_id,
    activation_type: r.activation_type,
    product: r.product,
    label: r.label,
    has_account_ref: r.account_ref_hash !== null,
    status: r.status,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    revoked_at: r.revoked_at,
  };
}

export function findActivationByIdentity(db: D1Database, licenseId: string, type: ActivationType, deviceHash: string) {
  return db
    .prepare("SELECT * FROM activations WHERE license_id = ? AND activation_type = ? AND device_hash = ?")
    .bind(licenseId, type, deviceHash)
    .first<ActivationRow>();
}

export function getActivation(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM activations WHERE id = ?").bind(id).first<ActivationRow>();
}

export async function listActivationsForLicense(db: D1Database, licenseId: string) {
  const r = await db
    .prepare("SELECT * FROM activations WHERE license_id = ? ORDER BY status, last_seen_at DESC")
    .bind(licenseId)
    .all<ActivationRow>();
  return r.results;
}

function typeGroup(type: ActivationType): string {
  return type === "web" ? "('web')" : "('mt4','mt5')";
}

/**
 * Quota guard evaluated inside the same SQL statement as the write. D1
 * executes each statement atomically against a single writer, so two
 * concurrent requests can never both pass the count check.
 *
 * Bound parameters (in order): licenseId, maxForGroup, accountRefHash, accountRefHash, licenseId, licenseId, maxAccounts
 */
function quotaGuard(type: ActivationType): string {
  return `
    (SELECT COUNT(*) FROM activations WHERE license_id = ? AND status = 'active' AND activation_type IN ${typeGroup(type)}) < ?
    AND (
      ? IS NULL
      OR ? IN (SELECT account_ref_hash FROM activations WHERE license_id = ? AND status = 'active' AND account_ref_hash IS NOT NULL)
      OR (SELECT COUNT(DISTINCT account_ref_hash) FROM activations WHERE license_id = ? AND status = 'active' AND account_ref_hash IS NOT NULL) < ?
    )`;
}

export interface NewActivation {
  id: string;
  licenseId: string;
  type: ActivationType;
  product: string;
  deviceHash: string;
  accountRefHash: string | null;
  label: string | null;
  now: string;
  maxForGroup: number;
  maxAccounts: number;
}

function guardArgs(a: NewActivation) {
  return [a.licenseId, a.maxForGroup, a.accountRefHash, a.accountRefHash, a.licenseId, a.licenseId, a.maxAccounts];
}

/** Inserts a new activation only if quotas allow it. Returns true if a row was inserted. */
export async function insertActivationWithinQuota(db: D1Database, a: NewActivation): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO activations (id, license_id, activation_type, product, device_hash, account_ref_hash, label, status, first_seen_at, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
       WHERE ${quotaGuard(a.type)}
       ON CONFLICT (license_id, activation_type, device_hash) DO NOTHING`,
    )
    .bind(a.id, a.licenseId, a.type, a.product, a.deviceHash, a.accountRefHash, a.label, a.now, a.now, ...guardArgs(a))
    .run();
  return r.meta.changes === 1;
}

/** Re-activates a previously revoked activation only if quotas allow it. */
export async function reactivateWithinQuota(db: D1Database, activationId: string, a: NewActivation): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE activations SET status = 'active', revoked_at = NULL, revoked_reason = NULL,
              product = ?, account_ref_hash = ?, label = COALESCE(?, label), last_seen_at = ?
       WHERE id = ? AND status = 'revoked' AND ${quotaGuard(a.type)}`,
    )
    .bind(a.product, a.accountRefHash, a.label, a.now, activationId, ...guardArgs(a))
    .run();
  return r.meta.changes === 1;
}

export async function touchActivation(db: D1Database, id: string, now: string) {
  await db.prepare("UPDATE activations SET last_seen_at = ? WHERE id = ? AND status = 'active'").bind(now, id).run();
}

export function revokeActivationStatement(db: D1Database, id: string, now: string, reason: string) {
  return db
    .prepare("UPDATE activations SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ? AND status = 'active'")
    .bind(now, reason, id);
}

export interface AdminActivationFilters {
  activation_type?: string | undefined;
  status?: string | undefined;
  license_id?: string | undefined;
}

export async function adminListActivations(db: D1Database, f: AdminActivationFilters, page: number, pageSize: number) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.activation_type) (where.push("a.activation_type = ?"), args.push(f.activation_type));
  if (f.status) (where.push("a.status = ?"), args.push(f.status));
  if (f.license_id) (where.push("a.license_id = ?"), args.push(f.license_id));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT a.*, u.email, l.user_id FROM activations a JOIN licenses l ON l.id = a.license_id JOIN users u ON u.id = l.user_id
         ${w} ORDER BY a.last_seen_at DESC, a.id LIMIT ? OFFSET ?`,
      )
      .bind(...args, pageSize, (page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS n FROM activations a ${w}`).bind(...args),
  ]);
  return {
    rows: (rows!.results as (ActivationRow & { email: string; user_id: string })[]).map((r) => ({
      ...toActivation(r),
      email: r.email,
      user_id: r.user_id,
    })),
    total: (total!.results[0] as { n: number }).n,
  };
}
