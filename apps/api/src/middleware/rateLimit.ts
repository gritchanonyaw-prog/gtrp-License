import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { errors } from "../errors/index.js";
import { hitRateLimit } from "../repositories/rateLimits.js";
import { keyedHash } from "../security/crypto.js";
import { clientIp } from "./requestContext.js";

export async function enforceRateLimit(c: Context<AppEnv>, name: string, rawKey: string, limit: number, windowSeconds: number) {
  const bucket = `${name}:${(await keyedHash(c.env.LICENSE_KEY_PEPPER, "ip", rawKey)).slice(0, 32)}`;
  const r = await hitRateLimit(c.env.DB, bucket, limit, windowSeconds);
  if (!r.allowed) throw errors.rateLimited(Math.max(1, r.retryAfterSeconds));
}

/** Per-client-IP rate limit. The IP is stored only as a truncated keyed hash. */
export function ipRateLimit(name: string, limit: number, windowSeconds: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforceRateLimit(c, name, clientIp(c.req.raw), limit, windowSeconds);
    await next();
  };
}
