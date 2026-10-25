import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { isProductionLike } from "../env.js";

/** Assigns a server-generated request id (inbound ids are ignored to prevent log injection). */
export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const rid = crypto.randomUUID();
  c.set("requestId", rid);
  c.set("session", null);
  await next();
  c.header("X-Request-Id", rid);
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  if (isProductionLike(c.env)) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
};

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}
