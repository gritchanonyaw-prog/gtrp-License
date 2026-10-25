import type { PublicUser } from "@gtrp/shared";
import type { UserRow } from "./types.js";

export function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, email: u.email, role: u.role, status: u.status, mfa_enabled: u.mfa_enabled === 1, created_at: u.created_at };
}

export function findUserByEmail(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export function findUserById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export function insertUserStatement(db: D1Database, u: { id: string; email: string; passwordHash: string; role: "customer" | "admin"; now: string }) {
  return db
    .prepare("INSERT INTO users (id, email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
    .bind(u.id, u.email, u.passwordHash, u.role, u.now, u.now);
}

export async function recordLoginFailure(db: D1Database, id: string, now: string, lockThreshold: number, lockUntil: string) {
  return db
    .prepare(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= ? THEN ? ELSE locked_until END,
         updated_at = ?
       WHERE id = ? RETURNING failed_login_count, locked_until`,
    )
    .bind(lockThreshold, lockUntil, now, id)
    .first<{ failed_login_count: number; locked_until: string | null }>();
}

export async function resetLoginFailures(db: D1Database, id: string, now: string) {
  await db.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(now, id).run();
}

export interface CustomerListFilters {
  q?: string | undefined;
  status?: string | undefined;
}

export async function listCustomers(db: D1Database, f: CustomerListFilters, page: number, pageSize: number) {
  const where = ["u.role = 'customer'"];
  const args: unknown[] = [];
  if (f.q) {
    where.push("(u.id = ? OR u.email LIKE ? ESCAPE '\\')");
    args.push(f.q, `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (f.status) (where.push("u.status = ?"), args.push(f.status));
  const w = `WHERE ${where.join(" AND ")}`;
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT u.id, u.email, u.status, u.created_at,
           (SELECT COUNT(*) FROM licenses l WHERE l.user_id = u.id) AS license_count,
           (SELECT COUNT(*) FROM licenses l WHERE l.user_id = u.id AND l.status = 'active') AS active_license_count
         FROM users u ${w} ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`,
      )
      .bind(...args, pageSize, (page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS n FROM users u ${w}`).bind(...args),
  ]);
  return { rows: rows!.results, total: (total!.results[0] as { n: number }).n };
}
