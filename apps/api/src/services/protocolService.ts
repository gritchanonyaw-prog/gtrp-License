import {
  canUsePlatform,
  canUseProduct,
  computeEffectiveStatus,
  ERROR_CODES,
  MAX_CLOCK_SKEW_SECONDS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  verifyLease,
  WEB_PRODUCT_ID,
  type ActivationType,
  type ErrorCode,
  type LicenseProtocolResponse,
  type PlanEntitlements,
} from "@gtrp/shared";
import type { Context } from "hono";
import { clock, nowIso } from "../clock.js";
import { intVar, type AppEnv, type Env } from "../env.js";
import { AppError, errors } from "../errors/index.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";
import { clientIp } from "../middleware/requestContext.js";
import {
  findActivationByIdentity,
  getActivation,
  insertActivationWithinQuota,
  reactivateWithinQuota,
  revokeActivationStatement,
  touchActivation,
  type NewActivation,
} from "../repositories/activations.js";
import { auditStatement, recordEvent } from "../repositories/events.js";
import { getLicense, getLicenseByKeyHash, getUsage, type LicenseWithPlan } from "../repositories/licenses.js";
import { claimNonce } from "../repositories/nonces.js";
import { parseEntitlements } from "../repositories/plans.js";
import type { ActivationRow } from "../repositories/types.js";
import { findUserById } from "../repositories/users.js";
import { keyedHash } from "../security/crypto.js";
import { leasePublicKeys, signLease } from "../security/lease.js";
import { hashLicenseKey, normalizeLicenseKey } from "../security/licenseKey.js";

interface ProtocolBase {
  protocol_version: number;
  request_id: string;
  client_time: string;
}

interface LicenseRef {
  license_key?: string | undefined;
  license_id?: string | undefined;
}

const deny = (code: ErrorCode, message: string, status: 403 | 404 | 409 = 403) => errors.license(code, message, status);

/** Steps shared by every protocol request: version, clock skew, rate limits, replay protection. */
export async function protocolPreflight(c: Context<AppEnv>, b: ProtocolBase) {
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(b.protocol_version)) {
    throw new AppError(400, ERROR_CODES.UNSUPPORTED_PROTOCOL, `Protocol version ${b.protocol_version} is not supported. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`);
  }
  await enforceRateLimit(c, "proto-ip", clientIp(c.req.raw), 120, 60);
  const skew = Math.abs(Date.parse(b.client_time) - clock.nowMs()) / 1000;
  if (skew > MAX_CLOCK_SKEW_SECONDS) {
    throw new AppError(400, ERROR_CODES.CLOCK_SKEW, "The client clock differs from server time by too much. Correct the clock (see server_time) and retry.");
  }
  // Nonces are kept for twice the skew window; an older replay is rejected by the skew check above.
  const nonceHash = await keyedHash(c.env.LICENSE_KEY_PEPPER, "nonce", b.request_id);
  const expires = new Date(clock.nowMs() + 2 * MAX_CLOCK_SKEW_SECONDS * 1000).toISOString();
  if (!(await claimNonce(c.env.DB, nonceHash, expires))) {
    throw new AppError(409, ERROR_CODES.REPLAY_DETECTED, "This request id was already used. Send a new request id.");
  }
}

/** Resolves the license from a key (EA) or an owned license id (logged-in Web App). Unknown keys get one generic answer. */
async function resolveLicense(c: Context<AppEnv>, ref: LicenseRef): Promise<LicenseWithPlan> {
  const env = c.env;
  if (ref.license_key !== undefined) {
    const normalized = normalizeLicenseKey(ref.license_key);
    const keyHash = normalized ? await hashLicenseKey(env.LICENSE_KEY_PEPPER, normalized) : null;
    // Per-key limit (also applied to malformed keys) slows down guessing against one key.
    await enforceRateLimit(c, "proto-key", keyHash ?? "malformed", 30, 60);
    const l = keyHash ? await getLicenseByKeyHash(env.DB, keyHash) : null;
    if (!l) throw deny(ERROR_CODES.LICENSE_INVALID, "The license key is not valid.");
    return l;
  }
  const s = c.get("session");
  if (!s) throw errors.unauthenticated();
  const l = await getLicense(env.DB, ref.license_id!);
  // Someone else's license id is indistinguishable from a nonexistent one.
  if (!l || l.user_id !== s.user.id) throw deny(ERROR_CODES.LICENSE_INVALID, "The license is not valid.");
  return l;
}

/** Server-side status, date, owner and entitlement checks. Returns the plan entitlements. */
async function assertUsable(env: Env, l: LicenseWithPlan, product: string | null, platform: ActivationType): Promise<PlanEntitlements> {
  const owner = await findUserById(env.DB, l.user_id);
  if (!owner || owner.status !== "active") throw deny(ERROR_CODES.LICENSE_SUSPENDED, "This license is suspended.");
  const eff = computeEffectiveStatus(l, clock.nowMs());
  switch (eff.status) {
    case "active":
      break;
    case "not_started":
      throw deny(ERROR_CODES.LICENSE_NOT_STARTED, "This license is not active yet.");
    case "created":
      throw deny(ERROR_CODES.LICENSE_NOT_ACTIVE, "This license has not been activated.");
    case "expired":
      throw deny(ERROR_CODES.LICENSE_EXPIRED, "This license has expired.");
    case "suspended":
      throw deny(ERROR_CODES.LICENSE_SUSPENDED, "This license is suspended.");
    case "revoked":
      throw deny(ERROR_CODES.LICENSE_REVOKED, "This license has been revoked.");
  }
  const ent = parseEntitlements(l.plan_features_json);
  if (!canUsePlatform(ent, platform)) throw deny(ERROR_CODES.PLATFORM_NOT_ENTITLED, "This plan does not include this platform.");
  if (product !== null && !canUseProduct(ent, product, platform)) throw deny(ERROR_CODES.PRODUCT_NOT_ENTITLED, "This plan does not include this product.");
  return ent;
}

async function accountHash(env: Env, ent: PlanEntitlements, platform: ActivationType, accountRef: string | undefined): Promise<string | null> {
  // Only store a trading-account reference when the plan actually binds EAs to accounts (data minimization).
  if (platform === "web" || !ent.require_account_binding) return null;
  if (!accountRef) throw deny(ERROR_CODES.ACCOUNT_REF_REQUIRED, "This plan requires the trading account reference.");
  return keyedHash(env.LICENSE_KEY_PEPPER, "account", accountRef);
}

async function issueResponse(env: Env, b: ProtocolBase, l: LicenseWithPlan, ent: PlanEntitlements, a: ActivationRow): Promise<LicenseProtocolResponse> {
  const nowMs = clock.nowMs();
  const eff = computeEffectiveStatus(l, nowMs);
  const ttl = intVar(env.LEASE_TTL_SECONDS, 86400);
  // A lease never outlives the license's own entitlement window.
  const licenseEnd = l.grace_until ?? l.expires_at;
  const expMs = Math.min(nowMs + ttl * 1000, licenseEnd ? Date.parse(licenseEnd) : Number.POSITIVE_INFINITY);
  const exp = Math.floor(expMs / 1000);
  const { token } = await signLease(env, {
    sub: l.id,
    act: a.id,
    product: a.product,
    platform: a.activation_type,
    ent: { features: a.activation_type === "web" ? ent.features : [], ea_products: a.activation_type === "web" ? [] : ent.ea_products },
    iat: Math.floor(nowMs / 1000),
    exp,
  });
  const leaseExpires = new Date(exp * 1000).toISOString();
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: b.request_id,
    server_time: new Date(nowMs).toISOString(),
    result: "ok",
    license: { id: l.id, status: eff.status, in_grace: eff.inGrace, plan_code: l.plan_code, expires_at: l.expires_at, grace_until: l.grace_until },
    activation: { id: a.id, platform: a.activation_type, status: a.status },
    entitlements: ent,
    lease: { token, expires_at: leaseExpires },
    policy: { revalidate_after_seconds: Math.min(intVar(env.REVALIDATE_AFTER_SECONDS, 1800), ttl), offline_grace_until: leaseExpires },
  };
}

async function recordFailure(env: Env, l: LicenseWithPlan | null, operation: string, platform: string, e: unknown) {
  if (!(e instanceof AppError) || e.status >= 500 || e.code === ERROR_CODES.RATE_LIMITED) return;
  await recordEvent(env.DB, {
    licenseId: l?.id ?? null,
    actorType: "client",
    targetUserId: l?.user_id ?? null,
    eventType: "activation.failed",
    details: { operation, platform, code: e.code },
  });
}

function checkProductForPlatform(product: string, platform: ActivationType) {
  if ((platform === "web") !== (product === WEB_PRODUCT_ID)) throw deny(ERROR_CODES.PRODUCT_NOT_ENTITLED, "This product cannot be used on this platform.");
}

export interface ActivateBody extends ProtocolBase, LicenseRef {
  product: string;
  platform: ActivationType;
  activation_id: string;
  account_ref?: string | undefined;
  label?: string | undefined;
}

export async function activate(c: Context<AppEnv>, b: ActivateBody): Promise<LicenseProtocolResponse> {
  await protocolPreflight(c, b);
  const env = c.env;
  let l: LicenseWithPlan | null = null;
  try {
    l = await resolveLicense(c, b);
    checkProductForPlatform(b.product, b.platform);
    const ent = await assertUsable(env, l, b.product, b.platform);
    const accHash = await accountHash(env, ent, b.platform, b.account_ref);
    const deviceHash = await keyedHash(env.LICENSE_KEY_PEPPER, "device", `${b.platform}:${b.activation_id}`);
    const now = nowIso();
    const maxForGroup = b.platform === "web" ? l.plan_max_web_devices : l.plan_max_ea_activations;
    const req: NewActivation = {
      id: crypto.randomUUID(),
      licenseId: l.id,
      type: b.platform,
      product: b.product,
      deviceHash,
      accountRefHash: accHash,
      label: b.label ?? null,
      now,
      maxForGroup,
      maxAccounts: l.plan_max_trading_accounts,
    };

    let existing = await findActivationByIdentity(env.DB, l.id, b.platform, deviceHash);
    if (existing?.status === "active") {
      if (accHash !== null && existing.account_ref_hash !== null && existing.account_ref_hash !== accHash) {
        throw deny(ERROR_CODES.ACCOUNT_MISMATCH, "This installation is bound to a different trading account. Deactivate it first.", 409);
      }
      await touchActivation(env.DB, existing.id, now);
      return issueResponse(env, b, l, ent, existing);
    }

    const ok = existing ? await reactivateWithinQuota(env.DB, existing.id, req) : await insertActivationWithinQuota(env.DB, req);
    if (!ok) {
      // Either a quota was full, or a concurrent request for the same installation won the insert.
      existing = await findActivationByIdentity(env.DB, l.id, b.platform, deviceHash);
      if (existing?.status === "active" && (accHash === null || existing.account_ref_hash === accHash)) {
        return issueResponse(env, b, l, ent, existing);
      }
      const usage = (await getUsage(env.DB, [l.id])).get(l.id)!;
      const groupUsed = b.platform === "web" ? usage.web : usage.ea;
      if (groupUsed >= maxForGroup) {
        throw deny(ERROR_CODES.ACTIVATION_LIMIT_REACHED, b.platform === "web" ? "The web device limit for this plan has been reached." : "The EA activation limit for this plan has been reached.", 409);
      }
      throw deny(ERROR_CODES.ACCOUNT_LIMIT_REACHED, "The trading account limit for this plan has been reached.", 409);
    }
    const row = existing ? (await getActivation(env.DB, existing.id))! : (await getActivation(env.DB, req.id))!;
    await recordEvent(env.DB, {
      licenseId: l.id,
      actorType: "client",
      targetUserId: l.user_id,
      eventType: existing ? "activation.reactivated" : "activation.created",
      details: { activation_id: row.id, platform: b.platform, product: b.product },
    });
    return issueResponse(env, b, l, ent, row);
  } catch (e) {
    await recordFailure(env, l, "activate", b.platform, e);
    throw e;
  }
}

async function requireActiveActivation(env: Env, l: LicenseWithPlan, platform: ActivationType, activationId: string, accHash: string | null) {
  const deviceHash = await keyedHash(env.LICENSE_KEY_PEPPER, "device", `${platform}:${activationId}`);
  const a = await findActivationByIdentity(env.DB, l.id, platform, deviceHash);
  if (!a) throw deny(ERROR_CODES.ACTIVATION_NOT_FOUND, "This installation is not activated. Activate it first.", 404);
  if (a.status !== "active") throw deny(ERROR_CODES.ACTIVATION_REVOKED, "This activation has been revoked.");
  if (accHash !== null && a.account_ref_hash !== null && a.account_ref_hash !== accHash) {
    throw deny(ERROR_CODES.ACCOUNT_MISMATCH, "This installation is bound to a different trading account.", 409);
  }
  return a;
}

export type ValidateBody = Omit<ActivateBody, "label">;

export async function validate(c: Context<AppEnv>, b: ValidateBody): Promise<LicenseProtocolResponse> {
  await protocolPreflight(c, b);
  const env = c.env;
  let l: LicenseWithPlan | null = null;
  try {
    l = await resolveLicense(c, b);
    checkProductForPlatform(b.product, b.platform);
    const ent = await assertUsable(env, l, b.product, b.platform);
    const accHash = await accountHash(env, ent, b.platform, b.account_ref);
    const a = await requireActiveActivation(env, l, b.platform, b.activation_id, accHash);
    if (a.product !== b.product) throw deny(ERROR_CODES.PRODUCT_NOT_ENTITLED, "This activation belongs to a different product.");
    await touchActivation(env.DB, a.id, nowIso());
    return issueResponse(env, b, l, ent, a);
  } catch (e) {
    await recordFailure(env, l, "validate", b.platform, e);
    throw e;
  }
}

export interface RefreshBody extends ProtocolBase {
  lease_token: string;
  activation_id: string;
}

/** Re-issues a lease from a still-valid lease, re-checking license status and entitlements on the server. */
export async function refresh(c: Context<AppEnv>, b: RefreshBody): Promise<LicenseProtocolResponse> {
  await protocolPreflight(c, b);
  const env = c.env;
  const v = await verifyLease(b.lease_token, await leasePublicKeys(env), clock.nowMs(), 0);
  if (!v.ok) {
    if (v.reason === "expired") throw new AppError(401, ERROR_CODES.LEASE_EXPIRED, "The lease has expired. Validate with the license key.");
    throw new AppError(401, ERROR_CODES.LEASE_INVALID, "The lease is not valid. Validate with the license key.");
  }
  const a = await getActivation(env.DB, v.payload.act);
  const deviceHash = await keyedHash(env.LICENSE_KEY_PEPPER, "device", `${v.payload.platform}:${b.activation_id}`);
  // The lease is bound to the installation that received it.
  if (!a || a.license_id !== v.payload.sub || a.device_hash !== deviceHash) throw new AppError(401, ERROR_CODES.LEASE_INVALID, "The lease is not valid for this installation.");
  const l = await getLicense(env.DB, a.license_id);
  if (!l) throw deny(ERROR_CODES.LICENSE_INVALID, "The license is not valid.");
  try {
    const ent = await assertUsable(env, l, a.product, a.activation_type);
    if (a.status !== "active") throw deny(ERROR_CODES.ACTIVATION_REVOKED, "This activation has been revoked.");
    await touchActivation(env.DB, a.id, nowIso());
    return issueResponse(env, b, l, ent, a);
  } catch (e) {
    await recordFailure(env, l, "refresh", a.activation_type, e);
    throw e;
  }
}

export interface DeactivateBody extends ProtocolBase, LicenseRef {
  platform: ActivationType;
  activation_id: string;
}

/** Frees the activation slot for this installation. Allowed in any license state so customers can always clean up. */
export async function deactivate(c: Context<AppEnv>, b: DeactivateBody) {
  await protocolPreflight(c, b);
  const env = c.env;
  const l = await resolveLicense(c, b);
  const deviceHash = await keyedHash(env.LICENSE_KEY_PEPPER, "device", `${b.platform}:${b.activation_id}`);
  const a = await findActivationByIdentity(env.DB, l.id, b.platform, deviceHash);
  if (!a) throw deny(ERROR_CODES.ACTIVATION_NOT_FOUND, "This installation is not activated.", 404);
  if (a.status === "active") {
    const now = nowIso();
    const s = c.get("session");
    await env.DB.batch([
      revokeActivationStatement(env.DB, a.id, now, "deactivated_by_client"),
      auditStatement(env.DB, {
        licenseId: l.id,
        actorUserId: s?.user.id ?? null,
        actorType: s ? "customer" : "client",
        targetUserId: l.user_id,
        eventType: "activation.revoked",
        details: { activation_id: a.id, platform: a.activation_type, reason: "deactivated_by_client" },
      }, now),
    ]);
  }
  return { protocol_version: PROTOCOL_VERSION, request_id: b.request_id, server_time: nowIso(), result: "deactivated" as const };
}
