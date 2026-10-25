import { z } from "zod";
import { ACTIVATION_TYPES } from "./constants/index.js";
import { base64UrlToBytes, utf8 } from "./base64url.js";

export const LEASE_TYPE = "GTRP-LEASE";
export const LEASE_ISSUER = "gtrp-license";

export const leaseHeader = z.object({ alg: z.literal("EdDSA"), typ: z.literal(LEASE_TYPE), kid: z.string().min(1).max(64) });

/** Payload of a signed License Lease (compact JWS, EdDSA / Ed25519). */
export const leasePayload = z.object({
  iss: z.literal(LEASE_ISSUER),
  /** Protocol version */
  v: z.number().int(),
  /** Unique token id */
  jti: z.uuid(),
  /** License id */
  sub: z.uuid(),
  /** Activation id */
  act: z.uuid(),
  product: z.string(),
  platform: z.enum(ACTIVATION_TYPES),
  /** Permitted feature keys (web) or EA product list */
  ent: z.object({ features: z.array(z.string()), ea_products: z.array(z.string()) }),
  /** Issued-at / expiry, seconds since epoch (UTC) */
  iat: z.number().int(),
  exp: z.number().int(),
});
export type LeasePayload = z.infer<typeof leasePayload>;

export type LeaseVerifyFailure = "malformed" | "unknown_key" | "bad_signature" | "expired" | "not_yet_valid";
export type LeaseVerifyResult = { ok: true; payload: LeasePayload; kid: string } | { ok: false; reason: LeaseVerifyFailure };

/** Public verification key as an Ed25519 JWK ({ kty: "OKP", crv: "Ed25519", x }) plus its key id. */
export interface LeasePublicKey {
  kid: string;
  jwk: JsonWebKey;
}

function parseJsonPart(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

/**
 * Verifies a lease token with the server's PUBLIC key. Usable in Workers,
 * Node.js 22+ and modern browsers (WebCrypto Ed25519). Never needs a secret.
 */
export async function verifyLease(
  token: string,
  keys: LeasePublicKey[],
  nowMs: number,
  clockSkewSeconds = 60,
): Promise<LeaseVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  let header: z.infer<typeof leaseHeader>;
  let payload: LeasePayload;
  let sig: Uint8Array;
  try {
    header = leaseHeader.parse(parseJsonPart(h));
    payload = leasePayload.parse(parseJsonPart(p));
    sig = base64UrlToBytes(s);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key.jwk, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig as BufferSource, utf8(`${h}.${p}`) as BufferSource);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  const now = Math.floor(nowMs / 1000);
  if (payload.iat > now + clockSkewSeconds) return { ok: false, reason: "not_yet_valid" };
  if (payload.exp <= now - clockSkewSeconds) return { ok: false, reason: "expired" };
  return { ok: true, payload, kid: header.kid };
}
