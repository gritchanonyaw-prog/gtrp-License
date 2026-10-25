import { canAccessFeature, computeEffectiveStatus, ERROR_CODES } from "@gtrp/shared";
import type { MiddlewareHandler } from "hono";
import { clock } from "../clock.js";
import type { AppEnv, Env } from "../env.js";
import { AppError } from "../errors/index.js";
import { requireSession } from "../middleware/auth.js";
import { findActivationByIdentity } from "../repositories/activations.js";
import { listLicensesForUser } from "../repositories/licenses.js";
import { parseEntitlements } from "../repositories/plans.js";
import { keyedHash } from "../security/crypto.js";

export const WEB_ACTIVATION_HEADER = "X-GTRP-Activation-Id";

/** Union of Web App entitlements across the user's currently usable licenses (computed from the database on every call). */
export async function userEntitlements(env: Env, userId: string) {
  const nowMs = clock.nowMs();
  const licenses = (await listLicensesForUser(env.DB, userId)).filter((l) => computeEffectiveStatus(l, nowMs).status === "active");
  const features = new Set<string>();
  let webAccess = false;
  for (const l of licenses) {
    const e = parseEntitlements(l.plan_features_json);
    if (!e.web_access) continue;
    webAccess = true;
    for (const f of e.features) features.add(f);
  }
  return { web_access: webAccess, features: [...features].sort(), license_ids: licenses.map((l) => l.id) };
}

/**
 * Authorizes one Web App feature for the current request. Requires:
 *  1. an authenticated, active user,
 *  2. a usable license whose plan includes the feature,
 *  3. an active web activation for this browser on that license (enforces the web device limit).
 * Nothing is cached, so suspensions, expiry and plan downgrades apply on the very next request.
 */
export async function authorizeFeature(env: Env, userId: string, feature: string, webActivationId: string | undefined) {
  const nowMs = clock.nowMs();
  const licenses = (await listLicensesForUser(env.DB, userId)).filter(
    (l) => computeEffectiveStatus(l, nowMs).status === "active" && canAccessFeature(parseEntitlements(l.plan_features_json), feature),
  );
  if (licenses.length === 0) throw new AppError(403, ERROR_CODES.FEATURE_NOT_ENTITLED, "Your plan does not include this feature.");
  if (!webActivationId || !/^[A-Za-z0-9_-]{16,128}$/.test(webActivationId)) {
    throw new AppError(403, ERROR_CODES.ACTIVATION_NOT_FOUND, "This browser is not activated for your license.");
  }
  const deviceHash = await keyedHash(env.LICENSE_KEY_PEPPER, "device", `web:${webActivationId}`);
  for (const l of licenses) {
    const a = await findActivationByIdentity(env.DB, l.id, "web", deviceHash);
    if (a?.status === "active") return { license_id: l.id, activation_id: a.id };
  }
  throw new AppError(403, ERROR_CODES.ACTIVATION_NOT_FOUND, "This browser is not activated for your license.");
}

/** Route middleware for protected Web App data endpoints. */
export function requireFeature(feature: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = requireSession(c);
    await authorizeFeature(c.env, s.user.id, feature, c.req.header(WEB_ACTIVATION_HEADER));
    await next();
  };
}
