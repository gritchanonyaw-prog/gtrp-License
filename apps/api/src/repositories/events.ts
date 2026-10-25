import type { AuditEventType } from "@gtrp/shared";
import { nowIso } from "../clock.js";
import { redact } from "../security/redact.js";
import type { EventRow } from "./types.js";

export interface AuditEvent {
  licenseId?: string | null;
  actorUserId?: string | null;
  actorType: EventRow["actor_type"];
  targetUserId?: string | null;
  eventType: AuditEventType;
  details?: Record<string, unknown>;
}

/** Builds the INSERT for an audit event so callers can include it in an atomic batch. */
export function auditStatement(db: D1Database, e: AuditEvent, createdAt = nowIso()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO license_events (id, license_id, actor_user_id, actor_type, target_user_id, event_type, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      e.licenseId ?? null,
      e.actorUserId ?? null,
      e.actorType,
      e.targetUserId ?? null,
      e.eventType,
      JSON.stringify(redact(e.details ?? {})),
      createdAt,
    );
}

export async function recordEvent(db: D1Database, e: AuditEvent): Promise<void> {
  await auditStatement(db, e).run();
}

export interface EventFilters {
  from?: string | undefined;
  to?: string | undefined;
  actor_user_id?: string | undefined;
  target_user_id?: string | undefined;
  license_id?: string | undefined;
  event_type?: string | undefined;
}

export async function listEvents(db: D1Database, f: EventFilters, page: number, pageSize: number) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.from) (where.push("e.created_at >= ?"), args.push(f.from));
  if (f.to) (where.push("e.created_at <= ?"), args.push(f.to));
  if (f.actor_user_id) (where.push("e.actor_user_id = ?"), args.push(f.actor_user_id));
  if (f.target_user_id) (where.push("e.target_user_id = ?"), args.push(f.target_user_id));
  if (f.license_id) (where.push("e.license_id = ?"), args.push(f.license_id));
  if (f.event_type) (where.push("e.event_type = ?"), args.push(f.event_type));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT e.*, a.email AS actor_email, t.email AS target_email
         FROM license_events e
         LEFT JOIN users a ON a.id = e.actor_user_id
         LEFT JOIN users t ON t.id = e.target_user_id
         ${w} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...args, pageSize, (page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS n FROM license_events e ${w}`).bind(...args),
  ]);
  return {
    rows: (rows!.results as (EventRow & { actor_email: string | null; target_email: string | null })[]).map((r) => ({
      id: r.id,
      license_id: r.license_id,
      actor_user_id: r.actor_user_id,
      actor_email: r.actor_email,
      actor_type: r.actor_type,
      target_user_id: r.target_user_id,
      target_email: r.target_email,
      event_type: r.event_type,
      details: JSON.parse(r.details_json) as Record<string, unknown>,
      created_at: r.created_at,
    })),
    total: (total!.results[0] as { n: number }).n,
  };
}

/**
 * Audit INSERT that only runs if the license row's last_op_id equals `opId`.
 * Put it in the same db.batch() (one transaction) after an UPDATE that sets
 * last_op_id = opId, so the event is written if and only if that UPDATE applied.
 */
export function auditIfLicenseOp(db: D1Database, e: AuditEvent, licenseId: string, opId: string, createdAt = nowIso()) {
  return db
    .prepare(
      `INSERT INTO license_events (id, license_id, actor_user_id, actor_type, target_user_id, event_type, details_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM licenses WHERE id = ? AND last_op_id = ?)`,
    )
    .bind(
      crypto.randomUUID(),
      e.licenseId ?? null,
      e.actorUserId ?? null,
      e.actorType,
      e.targetUserId ?? null,
      e.eventType,
      JSON.stringify(redact(e.details ?? {})),
      createdAt,
      licenseId,
      opId,
    );
}
