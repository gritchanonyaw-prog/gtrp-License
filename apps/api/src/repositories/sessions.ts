import type { SessionRow, UserRow } from "./types.js";

export function insertSessionStatement(db: D1Database, s: { id: string; userId: string; tokenHash: string; mfaVerified: boolean; expiresAt: string; now: string }) {
  return db
    .prepare(
      "INSERT INTO sessions (id, user_id, token_hash, mfa_verified, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(s.id, s.userId, s.tokenHash, s.mfaVerified ? 1 : 0, s.expiresAt, s.now, s.now);
}

export function findSessionByTokenHash(db: D1Database, tokenHash: string) {
  return db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.mfa_verified, s.expires_at AS session_expires_at, s.revoked_at, s.last_used_at,
              u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<UserRow & { session_id: string; mfa_verified: number; session_expires_at: string; revoked_at: string | null; last_used_at: string }>();
}

export async function touchSession(db: D1Database, id: string, now: string) {
  await db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

export async function revokeSession(db: D1Database, id: string, now: string) {
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
}

export function revokeUserSessionsStatement(db: D1Database, userId: string, now: string, exceptSessionId: string | null = null) {
  return db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?")
    .bind(now, userId, exceptSessionId);
}

export async function purgeSessions(db: D1Database, beforeIso: string) {
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(beforeIso).run();
}

export type { SessionRow };
