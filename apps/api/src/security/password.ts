import { utf8 } from "@gtrp/shared";
import { base64ToBytes, bytesToBase64, randomBytes, timingSafeEqual } from "./crypto.js";

/**
 * PBKDF2-HMAC-SHA256. 100,000 iterations is the maximum the Workers runtime
 * allows for PBKDF2; the iteration count is stored with each hash so it can be
 * raised (or the algorithm replaced) later with rehash-on-login.
 * Format: pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
 */
export const PBKDF2_ITERATIONS = 100_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", utf8(password.normalize("NFKC")) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > PBKDF2_ITERATIONS) return false;
  const hash = await derive(password, base64ToBytes(parts[2]!), iterations);
  return timingSafeEqual(bytesToBase64(hash), parts[3]!);
}

/** Valid-format hash of a random password, used to equalize timing when the account does not exist. */
export const DUMMY_PASSWORD_HASH =
  "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
