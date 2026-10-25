import {
  LICENSE_KEY_ALPHABET,
  LICENSE_KEY_GROUPS,
  LICENSE_KEY_GROUP_LENGTH,
  LICENSE_KEY_PREFIX,
  LICENSE_KEY_REGEX,
} from "@gtrp/shared";
import { keyedHash } from "./crypto.js";

/**
 * Generates GTRP-XXXX-XXXX-XXXX-XXXX with 80 bits from crypto.getRandomValues.
 * The alphabet has 32 symbols, so (byte & 31) is unbiased.
 */
export function generateLicenseKey(): string {
  const n = LICENSE_KEY_GROUPS * LICENSE_KEY_GROUP_LENGTH;
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => LICENSE_KEY_ALPHABET[b & 31]!);
  const groups: string[] = [];
  for (let i = 0; i < n; i += LICENSE_KEY_GROUP_LENGTH) groups.push(chars.slice(i, i + LICENSE_KEY_GROUP_LENGTH).join(""));
  return `${LICENSE_KEY_PREFIX}-${groups.join("-")}`;
}

/** Uppercases, trims, and maps Crockford look-alikes (O->0, I/L->1). Returns null for anything not in key format. */
export function normalizeLicenseKey(input: string): string | null {
  const k = input.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  // "GTRP" itself contains no ambiguous letters, so only the random part is affected.
  return LICENSE_KEY_REGEX.test(k) ? k : null;
}

export function hashLicenseKey(pepper: string, normalizedKey: string): Promise<string> {
  return keyedHash(pepper, "license_key", normalizedKey);
}

export function licenseKeyHint(key: string): string {
  return key.slice(-4);
}

export function maskLicenseKey(hint: string | null): string | null {
  return hint ? `GTRP-****-****-****-${hint}` : null;
}
