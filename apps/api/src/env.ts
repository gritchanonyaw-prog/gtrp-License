import type { PublicUser } from "@gtrp/shared";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  ENVIRONMENT: "development" | "test" | "staging" | "production";
  /** Comma-separated list of origins allowed to make cookie-authenticated / CORS requests. */
  APP_ORIGINS: string;
  COOKIE_SECURE: string;
  REQUIRE_ADMIN_MFA: string;
  PAYMENTS_MOCK_ENABLED: string;
  LEASE_SIGNING_KEY_ID: string;
  LEASE_TTL_SECONDS: string;
  REVALIDATE_AFTER_SECONDS: string;
  SESSION_TTL_HOURS: string;

  // ---- secrets (wrangler secret put / .dev.vars) ----
  /** >= 32 random bytes, base64. Keys the HMAC used for license keys, device ids and account refs. */
  LICENSE_KEY_PEPPER: string;
  /** Ed25519 private key as a JWK JSON string ({kty:"OKP",crv:"Ed25519",d,x}). */
  LEASE_SIGNING_PRIVATE_JWK: string;
  /** Optional JSON array of previous public JWKs ([{kid, jwk}]) still accepted during key rotation. */
  LEASE_PREVIOUS_PUBLIC_KEYS?: string;
  /** 32 random bytes, base64. AES-GCM key for TOTP secrets at rest. */
  MFA_ENCRYPTION_KEY: string;
  /** Development mock payment provider webhook secret. */
  MOCK_PAYMENT_WEBHOOK_SECRET?: string;
}

export interface SessionContext {
  id: string;
  user: PublicUser;
  mfaVerified: boolean;
  expiresAt: string;
  /** "cookie" sessions are subject to CSRF/origin checks; "bearer" sessions are not. */
  via: "cookie" | "bearer";
}

export interface AppVariables {
  requestId: string;
  session: SessionContext | null;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

export function flag(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

export function intVar(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isProductionLike(env: Env): boolean {
  return env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging";
}
