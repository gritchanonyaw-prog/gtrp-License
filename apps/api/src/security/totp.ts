import { utf8 } from "@gtrp/shared";
import { base64ToBytes, bytesToBase64, randomBytes, timingSafeEqual } from "./crypto.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) - the default used by authenticator apps. */
export async function totpAt(secretB32: string, unixSeconds: number): Promise<string> {
  const counter = Math.floor(unixSeconds / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const key = await crypto.subtle.importKey("raw", base32Decode(secretB32) as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = h[h.length - 1]! & 0xf;
  const code = (((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!) % 1_000_000;
  return code.toString().padStart(6, "0");
}

/** Accepts the current step and one step either side to tolerate small clock drift. */
export async function verifyTotp(secretB32: string, code: string, nowMs: number): Promise<boolean> {
  const t = Math.floor(nowMs / 1000);
  let ok = false;
  for (const d of [-30, 0, 30]) ok = timingSafeEqual(await totpAt(secretB32, t + d), code) || ok;
  return ok;
}

async function aesKey(b64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(b64);
  if (raw.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts a TOTP secret at rest: base64(iv) + "." + base64(ciphertext). */
export async function encryptSecret(keyB64: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await aesKey(keyB64), utf8(plaintext) as BufferSource);
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(keyB64: string, enc: string): Promise<string> {
  const [iv, ct] = enc.split(".");
  if (!iv || !ct) throw new Error("bad ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) as BufferSource }, await aesKey(keyB64), base64ToBytes(ct) as BufferSource);
  return new TextDecoder().decode(pt);
}
