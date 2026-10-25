import { PROTOCOL_VERSION } from "@gtrp/shared";
import { Hono } from "hono";
import { nowIso } from "../clock.js";
import type { AppEnv } from "../env.js";
import { log } from "../security/redact.js";
import { leasePublicKeys } from "../security/lease.js";

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
    const ok = database === "ok";
    return c.json(
      {
        status: ok ? "ok" : "degraded",
        version: APP_VERSION,
        environment: c.env.ENVIRONMENT,
        protocol_versions: [PROTOCOL_VERSION],
        server_time: nowIso(),
        checks: { database },
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
