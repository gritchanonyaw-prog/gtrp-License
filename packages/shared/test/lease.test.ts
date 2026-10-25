import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToBase64Url, utf8, verifyLease, type LeasePayload } from "../src/index.js";

const subtle = webcrypto.subtle;

async function makeKey() {
  const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await subtle.exportKey("jwk", kp.publicKey);
  return { kp, pub: { kid: "k1", jwk } };
}

async function sign(kp: CryptoKeyPair, payload: object, kid = "k1") {
  const h = bytesToBase64Url(utf8(JSON.stringify({ alg: "EdDSA", typ: "GTRP-LEASE", kid })));
  const p = bytesToBase64Url(utf8(JSON.stringify(payload)));
  const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, kp.privateKey, utf8(`${h}.${p}`)));
  return `${h}.${p}.${bytesToBase64Url(sig)}`;
}

const now = Date.parse("2026-10-25T00:00:00Z");
const payload: LeasePayload = {
  iss: "gtrp-license",
  v: 1,
  jti: "7b7f6d1c-4f7e-4d1a-9f55-2f1f0f9c9a11",
  sub: "0f8fad5b-d9cb-469f-a165-70867728950e",
  act: "5b2a7d4e-3c1b-4a6f-8e9d-1c2b3a4d5e6f",
  product: "gtrp_ea",
  platform: "mt5",
  ent: { features: [], ea_products: ["gtrp_ea"] },
  iat: now / 1000,
  exp: now / 1000 + 3600,
};

describe("verifyLease", () => {
  it("accepts a valid lease", async () => {
    const { kp, pub } = await makeKey();
    const r = await verifyLease(await sign(kp, payload), [pub], now);
    expect(r.ok).toBe(true);
  });
  it("rejects a malformed token", async () => {
    const { pub } = await makeKey();
    expect(await verifyLease("abc", [pub], now)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyLease("a.b.c", [pub], now)).toEqual({ ok: false, reason: "malformed" });
  });
  it("rejects an invalid signature and tampered payload", async () => {
    const { kp, pub } = await makeKey();
    const other = await makeKey();
    expect(await verifyLease(await sign(other.kp, payload), [pub], now)).toEqual({ ok: false, reason: "bad_signature" });
    const [h, , s] = (await sign(kp, payload)).split(".");
    const forged = bytesToBase64Url(utf8(JSON.stringify({ ...payload, exp: payload.exp + 999999 })));
    expect(await verifyLease(`${h}.${forged}.${s}`, [pub], now)).toEqual({ ok: false, reason: "bad_signature" });
  });
  it("rejects an expired lease and a lease issued in the future", async () => {
    const { kp, pub } = await makeKey();
    expect((await verifyLease(await sign(kp, payload), [pub], now + 2 * 3600_000)).ok).toBe(false);
    expect(await verifyLease(await sign(kp, payload), [pub], now - 3600_000)).toEqual({ ok: false, reason: "not_yet_valid" });
  });
  it("rejects an unknown key id", async () => {
    const { kp, pub } = await makeKey();
    expect(await verifyLease(await sign(kp, payload, "k2"), [pub], now)).toEqual({ ok: false, reason: "unknown_key" });
  });
});
