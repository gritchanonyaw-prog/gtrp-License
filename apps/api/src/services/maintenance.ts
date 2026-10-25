import { clock, nowIso } from "../clock.js";
import type { Env } from "../env.js";
import { auditIfLicenseOp } from "../repositories/events.js";
import { purgeNonces } from "../repositories/nonces.js";
import { purgeRateLimits } from "../repositories/rateLimits.js";
import { purgeSessions } from "../repositories/sessions.js";
import { log } from "../security/redact.js";

/**
 * Hourly job:
 *  - moves active licenses past expiry + grace to "expired" (enforcement never depends on this job;
 *    every request computes the effective status from UTC server time)
 *  - purges used nonces, old rate-limit windows and sessions expired > 30 days ago
 */
export async function runScheduledMaintenance(env: Env): Promise<{ expired: number }> {
  const now = nowIso();
  const db = env.DB;
  const due = await db
    .prepare(
      `SELECT id, user_id, version FROM licenses
       WHERE status = 'active' AND expires_at IS NOT NULL AND COALESCE(grace_until, expires_at) <= ? LIMIT 500`,
    )
    .bind(now)
    .all<{ id: string; user_id: string; version: number }>();
  let expired = 0;
  for (const l of due.results) {
    const opId = crypto.randomUUID();
    const res = await db.batch([
      db
        .prepare("UPDATE licenses SET status = 'expired', version = version + 1, last_op_id = ?, updated_at = ? WHERE id = ? AND version = ? AND status = 'active'")
        .bind(opId, now, l.id, l.version),
      auditIfLicenseOp(
        db,
        { licenseId: l.id, actorType: "system", targetUserId: l.user_id, eventType: "license.expired", details: { from: "active", to: "expired" } },
        l.id,
        opId,
        now,
      ),
    ]);
    if (res[0]!.meta.changes === 1) expired++;
  }
  await purgeNonces(db, now);
  await purgeRateLimits(db, Math.floor(clock.nowMs() / 1000) - 2 * 3600);
  await purgeSessions(db, new Date(clock.nowMs() - 30 * 86400_000).toISOString());
  log("info", "maintenance_completed", { expired });
  return { expired };
}
