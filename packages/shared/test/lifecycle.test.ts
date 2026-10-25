import { describe, expect, it } from "vitest";
import {
  LICENSE_STATUSES,
  LICENSE_ACTIONS,
  addBillingPeriods,
  allowedLicenseActions,
  computeEffectiveStatus,
  nextLicenseStatus,
} from "../src/index.js";

describe("license state machine", () => {
  const allowed: Record<string, string> = {
    "created:activate": "active",
    "created:renew": "active",
    "created:revoke": "revoked",
    "active:suspend": "suspended",
    "active:revoke": "revoked",
    "active:expire": "expired",
    "active:renew": "active",
    "suspended:reactivate": "active",
    "suspended:revoke": "revoked",
    "suspended:renew": "suspended",
    "expired:renew": "active",
    "expired:revoke": "revoked",
  };

  it("allows exactly the documented transitions", () => {
    for (const s of LICENSE_STATUSES) {
      for (const a of LICENSE_ACTIONS) {
        expect(nextLicenseStatus(s, a), `${s}:${a}`).toBe(allowed[`${s}:${a}`] ?? null);
      }
    }
  });

  it("never reactivates a revoked license", () => {
    expect(allowedLicenseActions("revoked")).toEqual([]);
    expect(nextLicenseStatus("revoked", "reactivate")).toBeNull();
    expect(nextLicenseStatus("revoked", "renew")).toBeNull();
  });
});

describe("computeEffectiveStatus", () => {
  const base = { status: "active" as const, starts_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-02-01T00:00:00.000Z", grace_until: "2026-02-04T00:00:00.000Z" };
  it("active inside the term", () => {
    expect(computeEffectiveStatus(base, Date.parse("2026-01-15T00:00:00Z"))).toEqual({ status: "active", inGrace: false });
  });
  it("future start date", () => {
    expect(computeEffectiveStatus(base, Date.parse("2025-12-31T23:59:59Z")).status).toBe("not_started");
  });
  it("grace period", () => {
    expect(computeEffectiveStatus(base, Date.parse("2026-02-02T00:00:00Z"))).toEqual({ status: "active", inGrace: true });
  });
  it("expired after grace even when the stored status is still active", () => {
    expect(computeEffectiveStatus(base, Date.parse("2026-02-04T00:00:00Z")).status).toBe("expired");
  });
  it("lifetime license never expires", () => {
    expect(computeEffectiveStatus({ ...base, expires_at: null, grace_until: null }, Date.parse("2099-01-01T00:00:00Z")).status).toBe("active");
  });
  it("non-active stored status wins", () => {
    expect(computeEffectiveStatus({ ...base, status: "suspended" }, Date.parse("2026-01-15T00:00:00Z")).status).toBe("suspended");
  });
});

describe("addBillingPeriods", () => {
  it("clamps month ends", () => {
    expect(addBillingPeriods("2026-01-31T10:00:00.000Z", "monthly", 1)).toBe("2026-02-28T10:00:00.000Z");
    expect(addBillingPeriods("2026-03-15T00:00:00.000Z", "yearly", 1)).toBe("2027-03-15T00:00:00.000Z");
    expect(addBillingPeriods("2028-02-29T00:00:00.000Z", "yearly", 1)).toBe("2029-02-28T00:00:00.000Z");
  });
});
