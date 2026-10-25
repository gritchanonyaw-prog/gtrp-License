import type { LicenseStatus } from "./constants/index.js";
import type { EffectiveStatus } from "./schemas/licenses.js";

/** Actions that change a license's stored status. */
export const LICENSE_ACTIONS = ["activate", "suspend", "reactivate", "revoke", "expire", "renew"] as const;
export type LicenseAction = (typeof LICENSE_ACTIONS)[number];

/**
 * Explicit license state machine. A missing entry means the transition is not allowed.
 *
 * - created  -> active (activate, renew) | revoked
 * - active   -> suspended | revoked | expired (system) | active (renew extends dates)
 * - suspended-> active (reactivate) | revoked | suspended (renew extends dates, stays suspended)
 * - expired  -> active (renew) | revoked
 * - revoked  -> (terminal; never silently reactivated - issue a new license instead)
 */
export const LICENSE_TRANSITIONS: Readonly<Record<LicenseStatus, Partial<Record<LicenseAction, LicenseStatus>>>> = {
  created: { activate: "active", renew: "active", revoke: "revoked" },
  active: { suspend: "suspended", revoke: "revoked", expire: "expired", renew: "active" },
  suspended: { reactivate: "active", revoke: "revoked", renew: "suspended" },
  expired: { renew: "active", revoke: "revoked" },
  revoked: {},
};

export function nextLicenseStatus(current: LicenseStatus, action: LicenseAction): LicenseStatus | null {
  return LICENSE_TRANSITIONS[current][action] ?? null;
}

export function allowedLicenseActions(current: LicenseStatus): LicenseAction[] {
  return Object.keys(LICENSE_TRANSITIONS[current]).filter((a) => a !== "expire") as LicenseAction[];
}

export interface LicenseDates {
  status: LicenseStatus;
  starts_at: string;
  expires_at: string | null;
  grace_until: string | null;
}

/**
 * Status the server enforces right now, based on UTC server time. A stored
 * "active" license past its expiry (and grace) is treated as expired even if
 * the scheduled job has not updated the row yet.
 */
export function computeEffectiveStatus(l: LicenseDates, nowMs: number): { status: EffectiveStatus; inGrace: boolean } {
  if (l.status !== "active") return { status: l.status, inGrace: false };
  if (nowMs < Date.parse(l.starts_at)) return { status: "not_started", inGrace: false };
  if (l.expires_at === null) return { status: "active", inGrace: false };
  if (nowMs < Date.parse(l.expires_at)) return { status: "active", inGrace: false };
  if (l.grace_until !== null && nowMs < Date.parse(l.grace_until)) return { status: "active", inGrace: true };
  return { status: "expired", inGrace: false };
}

/** Adds billing periods in UTC. Month arithmetic clamps to the last day of the month. */
export function addBillingPeriods(fromIso: string, period: "monthly" | "yearly", count: number): string {
  const d = new Date(fromIso);
  const months = period === "monthly" ? count : count * 12;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}
