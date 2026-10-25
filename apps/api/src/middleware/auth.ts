import { ERROR_CODES } from "@gtrp/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { clock, nowIso } from "../clock.js";
import { flag, type AppEnv, type Env, type SessionContext } from "../env.js";
import { AppError, errors } from "../errors/index.js";
import { findSessionByTokenHash, touchSession } from "../repositories/sessions.js";
import { toPublicUser } from "../repositories/users.js";
import { sha256Hex } from "../security/crypto.js";

export function sessionCookieName(env: Env): string {
  return flag(env.COOKIE_SECURE) ? "__Host-gtrp_session" : "gtrp_session";
}

function bearerToken(c: Context<AppEnv>): string | null {
  const h = c.req.header("Authorization");
  if (!h) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h);
  return m ? m[1]! : null;
}

/** Resolves the session from the cookie or bearer token. Never trusts any user/role data sent by the client. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const bearer = bearerToken(c);
  const cookie = bearer ? undefined : getCookie(c, sessionCookieName(c.env));
  const token = bearer ?? cookie;
  if (token && token.length <= 200) {
    const row = await findSessionByTokenHash(c.env.DB, await sha256Hex(token));
    const now = clock.nowMs();
    if (row && row.revoked_at === null && Date.parse(row.session_expires_at) > now && row.status === "active") {
      const session: SessionContext = {
        id: row.session_id,
        user: toPublicUser(row),
        mfaVerified: row.mfa_verified === 1,
        expiresAt: row.session_expires_at,
        via: bearer ? "bearer" : "cookie",
      };
      c.set("session", session);
      // Avoid a write on every request: update last_used_at at most once per 5 minutes.
      if (now - Date.parse(row.last_used_at) > 5 * 60_000) c.executionCtx.waitUntil(touchSession(c.env.DB, row.session_id, nowIso()));
    }
  }
  await next();
};

export function requireSession(c: Context<AppEnv>): SessionContext {
  const s = c.get("session");
  if (!s) throw errors.unauthenticated();
  return s;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireSession(c);
  await next();
};

/** Server-side role check for every admin endpoint. Admin sessions must be cookie-based and MFA-verified when MFA is required. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = requireSession(c);
  if (s.user.role !== "admin") throw errors.forbidden();
  if (s.via !== "cookie") throw errors.forbidden();
  if (flag(c.env.REQUIRE_ADMIN_MFA) && !s.mfaVerified) {
    throw new AppError(403, ERROR_CODES.MFA_SETUP_REQUIRED, "Administrator accounts must enable and use MFA.");
  }
  await next();
};
