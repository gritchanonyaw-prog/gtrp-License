import { ERROR_CODES, type LoginInput, type PublicUser } from "@gtrp/shared";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { clock, nowIso } from "../clock.js";
import { flag, intVar, type AppEnv, type Env, type SessionContext } from "../env.js";
import { AppError, errors } from "../errors/index.js";
import { sessionCookieName } from "../middleware/auth.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";
import { clientIp } from "../middleware/requestContext.js";
import { auditStatement, recordEvent } from "../repositories/events.js";
import { insertSessionStatement, revokeSession, revokeUserSessionsStatement } from "../repositories/sessions.js";
import { findUserByEmail, findUserById, insertUserStatement, recordLoginFailure, resetLoginFailures, toPublicUser } from "../repositories/users.js";
import { keyedHash, randomToken, sha256Hex } from "../security/crypto.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../security/password.js";
import { decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "../security/totp.js";

export const LOCK_THRESHOLD = 10;
export const LOCK_MINUTES = 15;

export async function register(c: Context<AppEnv>, email: string, password: string): Promise<PublicUser> {
  await enforceRateLimit(c, "register", clientIp(c.req.raw), 10, 3600);
  const db = c.env.DB;
  if (await findUserByEmail(db, email)) throw new AppError(409, ERROR_CODES.EMAIL_TAKEN, "An account with this email already exists.");
  const id = crypto.randomUUID();
  const now = nowIso();
  const passwordHash = await hashPassword(password);
  try {
    await db.batch([
      insertUserStatement(db, { id, email, passwordHash, role: "customer", now }),
      auditStatement(db, { actorUserId: id, actorType: "customer", targetUserId: id, eventType: "user.registered" }, now),
    ]);
  } catch (e) {
    if (/UNIQUE/.test((e as Error).message)) throw new AppError(409, ERROR_CODES.EMAIL_TAKEN, "An account with this email already exists.");
    throw e;
  }
  return toPublicUser((await findUserById(db, id))!);
}

export interface LoginResult {
  user: PublicUser;
  expiresAt: string;
  token: string;
  mfaVerified: boolean;
}

export async function login(c: Context<AppEnv>, input: LoginInput & { session_mode: "cookie" | "token" }): Promise<LoginResult> {
  const env = c.env;
  const db = env.DB;
  await enforceRateLimit(c, "login-ip", clientIp(c.req.raw), 30, 900);
  await enforceRateLimit(c, "login-email", await keyedHash(env.LICENSE_KEY_PEPPER, "email", input.email), 15, 900);

  const user = await findUserByEmail(db, input.email);
  // Always run the password hash so response time does not reveal whether the account exists.
  const passwordOk = await verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  const now = nowIso();

  if (!user || user.status === "deleted" || !user.password_hash) throw errors.invalidCredentials();
  if (user.locked_until && Date.parse(user.locked_until) > clock.nowMs()) {
    // Same shape as a rate-limit response, so a lock does not confirm that the account exists.
    throw errors.rateLimited(Math.ceil((Date.parse(user.locked_until) - clock.nowMs()) / 1000));
  }
  if (!passwordOk) {
    await failLogin(env, user.id, now, "bad_password");
    throw errors.invalidCredentials();
  }
  if (user.status !== "active") throw new AppError(403, ERROR_CODES.ACCOUNT_DISABLED, "This account is disabled. Contact support.");

  let mfaVerified = false;
  if (user.role === "admin") {
    if (input.session_mode === "token") throw new AppError(403, ERROR_CODES.FORBIDDEN, "Administrators must sign in to the dashboard.");
    if (user.mfa_enabled === 1) {
      if (!input.totp_code) throw new AppError(401, ERROR_CODES.MFA_REQUIRED, "Enter the 6-digit code from your authenticator app.");
      const secret = await decryptSecret(env.MFA_ENCRYPTION_KEY, user.mfa_secret_enc!);
      if (!(await verifyTotp(secret, input.totp_code, clock.nowMs()))) {
        await failLogin(env, user.id, now, "bad_totp");
        throw new AppError(401, ERROR_CODES.MFA_INVALID, "The authentication code is incorrect.");
      }
      mfaVerified = true;
    }
  }

  await resetLoginFailures(db, user.id, now);
  // Session rotation: a fresh random token on every login; any session presented with this request is revoked.
  const previous = c.get("session");
  if (previous) await revokeSession(db, previous.id, now);
  const token = randomToken(32);
  const ttlHours = intVar(env.SESSION_TTL_HOURS, 12);
  const expiresAt = new Date(clock.nowMs() + ttlHours * 3600_000).toISOString();
  await insertSessionStatement(db, { id: crypto.randomUUID(), userId: user.id, tokenHash: await sha256Hex(token), mfaVerified, expiresAt, now }).run();
  return { user: toPublicUser(user), expiresAt, token, mfaVerified };
}

async function failLogin(env: Env, userId: string, now: string, reason: string) {
  const lockUntil = new Date(clock.nowMs() + LOCK_MINUTES * 60_000).toISOString();
  const r = await recordLoginFailure(env.DB, userId, now, LOCK_THRESHOLD, lockUntil);
  await recordEvent(env.DB, { actorType: "client", targetUserId: userId, eventType: "user.login_failed", details: { reason } });
  if (r && r.failed_login_count === LOCK_THRESHOLD) {
    await recordEvent(env.DB, { actorType: "system", targetUserId: userId, eventType: "user.locked", details: { until: lockUntil } });
  }
}

export function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: string) {
  setCookie(c, sessionCookieName(c.env), token, {
    httpOnly: true,
    secure: flag(c.env.COOKIE_SECURE),
    sameSite: "Strict",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, sessionCookieName(c.env), { path: "/", secure: flag(c.env.COOKIE_SECURE) });
}

export async function changePassword(c: Context<AppEnv>, s: SessionContext, current: string, next: string) {
  const db = c.env.DB;
  const user = (await findUserById(db, s.user.id))!;
  if (!user.password_hash || !(await verifyPassword(current, user.password_hash))) throw errors.invalidCredentials();
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(next), now, user.id),
    // Invalidate every other session (e.g. a stolen one); keep the current one.
    revokeUserSessionsStatement(db, user.id, now, s.id),
    auditStatement(db, { actorUserId: user.id, actorType: s.user.role === "admin" ? "admin" : "customer", targetUserId: user.id, eventType: "user.password_changed" }, now),
  ]);
}

export async function beginMfaSetup(c: Context<AppEnv>, s: SessionContext) {
  if (s.user.role !== "admin") throw errors.forbidden();
  const user = (await findUserById(c.env.DB, s.user.id))!;
  if (user.mfa_enabled === 1) throw errors.conflict("MFA is already enabled for this account.");
  const secret = generateTotpSecret();
  await c.env.DB.prepare("UPDATE users SET mfa_secret_enc = ?, updated_at = ? WHERE id = ? AND mfa_enabled = 0")
    .bind(await encryptSecret(c.env.MFA_ENCRYPTION_KEY, secret), nowIso(), user.id)
    .run();
  const label = encodeURIComponent(`GTRP License:${user.email}`);
  return { secret, otpauth_uri: `otpauth://totp/${label}?secret=${secret}&issuer=GTRP%20License&algorithm=SHA1&digits=6&period=30` };
}

export async function enableMfa(c: Context<AppEnv>, s: SessionContext, code: string) {
  if (s.user.role !== "admin") throw errors.forbidden();
  const db = c.env.DB;
  const user = (await findUserById(db, s.user.id))!;
  if (user.mfa_enabled === 1) throw errors.conflict("MFA is already enabled for this account.");
  if (!user.mfa_secret_enc) throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, "Start MFA setup first.");
  const secret = await decryptSecret(c.env.MFA_ENCRYPTION_KEY, user.mfa_secret_enc);
  if (!(await verifyTotp(secret, code, clock.nowMs()))) throw new AppError(401, ERROR_CODES.MFA_INVALID, "The authentication code is incorrect.");
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?").bind(now, user.id),
    // Other sessions were not MFA-verified; revoke them and mark this one verified.
    revokeUserSessionsStatement(db, user.id, now, s.id),
    db.prepare("UPDATE sessions SET mfa_verified = 1 WHERE id = ?").bind(s.id),
    auditStatement(db, { actorUserId: user.id, actorType: "admin", targetUserId: user.id, eventType: "user.mfa_enabled" }, now),
  ]);
}

export async function deleteOwnAccount(c: Context<AppEnv>, s: SessionContext, password: string) {
  const user = (await findUserById(c.env.DB, s.user.id))!;
  if (user.role === "admin") throw new AppError(403, ERROR_CODES.FORBIDDEN, "Administrator accounts are removed by another administrator.");
  if (!user.password_hash || !(await verifyPassword(password, user.password_hash))) throw errors.invalidCredentials();
  await anonymizeUser(c.env, user.id, user.id, "customer");
}

/**
 * Account deletion: personal data is removed or replaced, licenses are revoked,
 * activations and sessions are revoked. Payment records and audit events are kept
 * (with the pseudonymous user id) to meet accounting / dispute retention obligations.
 * See docs/PRIVACY_AND_DATA_RETENTION.md.
 */
export async function anonymizeUser(env: Env, userId: string, actorUserId: string, actorType: "admin" | "customer", reason = "customer_request") {
  const db = env.DB;
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE users SET email = ?, password_hash = NULL, mfa_secret_enc = NULL, mfa_enabled = 0, status = 'deleted',
           deleted_at = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'`,
      )
      .bind(`deleted+${userId}@invalid.local`, now, now, userId),
    revokeUserSessionsStatement(db, userId, now),
    db
      .prepare(
        `UPDATE activations SET status = 'revoked', revoked_at = ?, revoked_reason = 'account_deleted', label = NULL, account_ref_hash = NULL
         WHERE license_id IN (SELECT id FROM licenses WHERE user_id = ?) AND status = 'active'`,
      )
      .bind(now, userId),
    db
      .prepare("UPDATE licenses SET status = 'revoked', key_hash = NULL, version = version + 1, last_op_id = ?, updated_at = ? WHERE user_id = ? AND status <> 'revoked'")
      .bind(crypto.randomUUID(), now, userId),
    auditStatement(db, { actorUserId, actorType, targetUserId: userId, eventType: "user.deleted", details: { reason } }, now),
  ]);
}
