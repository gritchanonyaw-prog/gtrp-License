import { describe, expect, it } from "vitest";
import { activateInput, adminCreateLicenseInput, isoUtc, loginInput, registerInput } from "../src/index.js";

const base = {
  protocol_version: 1,
  request_id: "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f",
  client_time: "2026-10-25T10:00:00.000Z",
  product: "gtrp_ea",
  platform: "mt5",
  activation_id: "inst_0123456789abcdef",
};

describe("shared schemas", () => {
  it("requires exactly one license reference", () => {
    expect(activateInput.safeParse(base).success).toBe(false);
    expect(activateInput.safeParse({ ...base, license_key: "GTRP-AAAA-BBBB-CCCC-DDDD" }).success).toBe(true);
    expect(
      activateInput.safeParse({ ...base, license_key: "x", license_id: "6f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f" }).success,
    ).toBe(false);
  });
  it("rejects unknown fields (no client-supplied roles or limits)", () => {
    expect(registerInput.safeParse({ email: "a@b.co", password: "0123456789", role: "admin" }).success).toBe(false);
    expect(activateInput.safeParse({ ...base, license_key: "k", max_ea_activations: 99 }).success).toBe(false);
  });
  it("normalizes email", () => {
    expect(loginInput.parse({ email: "  Grit@Example.COM ", password: "x" }).email).toBe("grit@example.com");
  });
  it("enforces UTC timestamps", () => {
    expect(isoUtc.safeParse("2026-10-25T10:00:00+07:00").success).toBe(false);
    expect(isoUtc.safeParse("2026-10-25T10:00:00Z").success).toBe(true);
  });
  it("rejects injection-shaped identifiers", () => {
    expect(activateInput.safeParse({ ...base, license_key: "k", activation_id: "x' OR '1'='1' --________" }).success).toBe(false);
    expect(adminCreateLicenseInput.safeParse({ user_id: "1 OR 1=1", plan_id: "x" }).success).toBe(false);
  });
});
