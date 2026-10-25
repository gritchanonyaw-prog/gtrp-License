import { bytesToBase64Url, utf8 } from "@gtrp/shared";

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(randomBytes(bytes));
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", utf8(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacKeyCache.set(secret, k);
  }
  return k;
}

/** HMAC-SHA256 hex digest. Used as a keyed hash for lookups so a leaked database alone cannot be brute-forced offline. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(message) as BufferSource);
  return toHex(sig);
}

/** Domain-separated keyed hash: hmac(pepper, "<purpose>:<value>"). */
export function keyedHash(pepper: string, purpose: "license_key" | "device" | "account" | "nonce" | "ip" | "email", value: string) {
  if (!pepper || pepper.length < 32) throw new Error("LICENSE_KEY_PEPPER is not configured");
  return hmacHex(pepper, `${purpose}:${value}`);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = utf8(a);
  const bb = utf8(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
