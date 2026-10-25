import { ERROR_CODES } from "@gtrp/shared";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env.js";
import { AppError } from "../errors/index.js";
import { sessionCookieName } from "./auth.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function allowedOrigins(appOrigins: string, requestUrl: string): Set<string> {
  const set = new Set(
    appOrigins
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  set.add(new URL(requestUrl).origin);
  return set;
}

/**
 * CSRF / origin protection.
 * - Any request carrying a browser Origin must come from an allowed origin.
 * - Cookie-authenticated unsafe requests must prove same-site intent (allowed Origin or Sec-Fetch-Site: same-origin).
 * - Non-browser clients (EA terminals, webhooks) send no Origin and no session cookie, so they are unaffected.
 * Session cookies are also SameSite=Strict.
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE.has(c.req.method)) return next();
  const origin = c.req.header("Origin");
  const allowed = allowedOrigins(c.env.APP_ORIGINS, c.req.url);
  if (origin !== undefined && origin !== "null" && !allowed.has(origin)) {
    throw new AppError(403, ERROR_CODES.CSRF_REJECTED, "Cross-origin request rejected.");
  }
  if (origin === "null") throw new AppError(403, ERROR_CODES.CSRF_REJECTED, "Cross-origin request rejected.");
  const hasCookie = getCookie(c, sessionCookieName(c.env)) !== undefined && !c.req.header("Authorization");
  if (hasCookie && origin === undefined && c.req.header("Sec-Fetch-Site") !== "same-origin") {
    throw new AppError(403, ERROR_CODES.CSRF_REJECTED, "Cross-origin request rejected.");
  }
  await next();
};
