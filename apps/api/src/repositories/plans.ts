import { planEntitlements, type Plan, type PlanEntitlements } from "@gtrp/shared";
import type { PlanRow } from "./types.js";

const NO_ENTITLEMENTS: PlanEntitlements = { web_access: false, features: [], ea_products: [], ea_platforms: [], require_account_binding: false };

/** Parses stored entitlements; a corrupt value fails closed (no entitlements). */
export function parseEntitlements(json: string): PlanEntitlements {
  try {
    const r = planEntitlements.safeParse(JSON.parse(json));
    return r.success ? r.data : NO_ENTITLEMENTS;
  } catch {
    return NO_ENTITLEMENTS;
  }
}

export function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    price_minor: r.price_minor,
    currency: r.currency,
    billing_period: r.billing_period,
    max_web_devices: r.max_web_devices,
    max_ea_activations: r.max_ea_activations,
    max_trading_accounts: r.max_trading_accounts,
    entitlements: parseEntitlements(r.features_json),
    is_active: r.is_active === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listPlans(db: D1Database, activeOnly: boolean) {
  const r = await db
    .prepare(`SELECT * FROM plans ${activeOnly ? "WHERE is_active = 1" : ""} ORDER BY price_minor, code`)
    .all<PlanRow>();
  return r.results;
}

export function getPlan(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM plans WHERE id = ?").bind(id).first<PlanRow>();
}
