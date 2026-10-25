import { describe, expect, it } from "vitest";
import { canAccessFeature, canUsePlatform, canUseProduct, planEntitlements } from "../src/index.js";

const quantPro = planEntitlements.parse({
  web_access: true,
  features: ["smc", "advanced_charts", "smc"],
  ea_products: ["gtrp_ea"],
  ea_platforms: ["mt5"],
  require_account_binding: false,
});

describe("entitlements", () => {
  it("normalizes and de-duplicates lists", () => {
    expect(quantPro.features).toEqual(["advanced_charts", "smc"]);
  });
  it("checks features", () => {
    expect(canAccessFeature(quantPro, "smc")).toBe(true);
    expect(canAccessFeature(quantPro, "volume_analysis")).toBe(false);
    expect(canAccessFeature({ ...quantPro, web_access: false }, "smc")).toBe(false);
    expect(canAccessFeature(null, "smc")).toBe(false);
  });
  it("checks products and platforms", () => {
    expect(canUseProduct(quantPro, "gtrp_ea", "mt5")).toBe(true);
    expect(canUseProduct(quantPro, "other_ea", "mt5")).toBe(false);
    expect(canUseProduct(quantPro, "gtrp_web", "mt5")).toBe(false);
    expect(canUseProduct(quantPro, "gtrp_web", "web")).toBe(true);
    expect(canUsePlatform(quantPro, "mt4")).toBe(false);
    expect(canUsePlatform(quantPro, "mt5")).toBe(true);
  });
  it("rejects unknown entitlement fields", () => {
    expect(planEntitlements.safeParse({ ...quantPro, is_admin: true }).success).toBe(false);
  });
});
