import { PROTOCOL_VERSION } from "@gtrp/shared";
import { Hono } from "hono";
import { nowIso } from "../clock.js";
import type { AppEnv } from "../env.js";
import { log } from "../security/redact.js";
import type { Env } from "../env.js";
import { base64ToBytes } from "../security/crypto.js";
import { leasePublicKeys } from "../security/lease.js";

/** Verifies required secrets are present and parseable, without revealing anything about them. */
async function configCheck(env: Env): Promise<"ok" | "misconfigured"> {
  try {
    if (!env.LICENSE_KEY_PEPPER || env.LICENSE_KEY_PEPPER.length < 32) throw new Error("LICENSE_KEY_PEPPER missing or too short");
    if (base64ToBytes(env.MFA_ENCRYPTION_KEY ?? "").length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 32 bytes base64");
    await leasePublicKeys(env);
    return "ok";
  } catch (e) {
    log("error", "health_config_check_failed", { reason: (e as Error).message });
    return "misconfigured";
  }
}

export const APP_VERSION = "1.0.0";

export const healthRoutes = new Hono<AppEnv>()
  /** Liveness + database readiness. Reveals no configuration or error details. */
  .get("/health", async (c) => {
    let database: "ok" | "unavailable" = "ok";
    try {
      await c.env.DB.prepare("SELECT 1 AS ok").first();
    } catch (e) {
      database = "unavailable";
      log("error", "health_db_check_failed", { request_id: c.get("requestId"), message: (e as Error).message });
    }
    const config = await configCheck(c.env);
    const ok = database === "ok" && config === "ok";
    return c.json(
      {
        status: ok ? "ok" : "degraded",
        version: APP_VERSION,
        environment: c.env.ENVIRONMENT,
        protocol_versions: [PROTOCOL_VERSION],
        server_time: nowIso(),
        checks: { database, config },
      },
      ok ? 200 : 503,
    );
  })
  /** Ed25519 public keys for verifying License Leases (JWKS-style). Public by design. */
  .get("/lease/public-keys", async (c) => {
    const keys = await leasePublicKeys(c.env);
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ keys: keys.map((k) => ({ kid: k.kid, ...k.jwk, alg: "EdDSA", use: "sig" })) });
  });
