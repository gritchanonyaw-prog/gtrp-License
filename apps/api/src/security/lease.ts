import { LEASE_ISSUER, LEASE_TYPE, PROTOCOL_VERSION, bytesToBase64Url, utf8, type LeasePayload, type LeasePublicKey } from "@gtrp/shared";
import type { Env } from "../env.js";

interface SigningKey {
  kid: string;
  key: CryptoKey;
  publicJwk: JsonWebKey;
}

let cached: { source: string; value: Promise<SigningKey> } | null = null;

function loadSigningKey(env: Env): Promise<SigningKey> {
  const source = `${env.LEASE_SIGNING_KEY_ID}|${env.LEASE_SIGNING_PRIVATE_JWK}`;
  if (cached?.source === source) return cached.value;
  const value = (async () => {
    if (!env.LEASE_SIGNING_PRIVATE_JWK) throw new Error("LEASE_SIGNING_PRIVATE_JWK is not configured");
    const jwk = JSON.parse(env.LEASE_SIGNING_PRIVATE_JWK) as JsonWebKey;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) throw new Error("LEASE_SIGNING_PRIVATE_JWK must be an Ed25519 private JWK");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
    return { kid: env.LEASE_SIGNING_KEY_ID, key, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x } };
  })();
  cached = { source, value };
  return value;
}

export async function signLease(env: Env, payload: Omit<LeasePayload, "iss" | "v" | "jti">): Promise<{ token: string; jti: string }> {
  const sk = await loadSigningKey(env);
  const jti = crypto.randomUUID();
  const full: LeasePayload = { iss: LEASE_ISSUER, v: PROTOCOL_VERSION, jti, ...payload };
  const h = bytesToBase64Url(utf8(JSON.stringify({ alg: "EdDSA", typ: LEASE_TYPE, kid: sk.kid })));
  const p = bytesToBase64Url(utf8(JSON.stringify(full)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, sk.key, utf8(`${h}.${p}`) as BufferSource));
  return { token: `${h}.${p}.${bytesToBase64Url(sig)}`, jti };
}

/** Current public key plus any previous keys still accepted during rotation. Safe to publish. */
export async function leasePublicKeys(env: Env): Promise<LeasePublicKey[]> {
  const sk = await loadSigningKey(env);
  const keys: LeasePublicKey[] = [{ kid: sk.kid, jwk: sk.publicJwk }];
  if (env.LEASE_PREVIOUS_PUBLIC_KEYS) {
    try {
      const prev = JSON.parse(env.LEASE_PREVIOUS_PUBLIC_KEYS) as LeasePublicKey[];
      for (const k of prev) if (k.kid && k.jwk && !k.jwk.d) keys.push({ kid: k.kid, jwk: { kty: "OKP", crv: "Ed25519", x: k.jwk.x } });
    } catch {
      // ignore a malformed optional variable rather than breaking validation
    }
  }
  return keys;
}
