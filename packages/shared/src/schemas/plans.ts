import { z } from "zod";
import { BILLING_PERIODS, EA_PLATFORMS } from "../constants/index.js";
import { currency, id, isoUtc } from "./common.js";

const featureKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "lowercase letters, digits and underscores");
export const productId = z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, "lowercase letters, digits and underscores");

/**
 * Feature-based entitlements stored in plans.features_json.
 * Limits (web devices, EA activations, trading accounts) live in dedicated columns.
 */
export const planEntitlements = z
  .object({
    web_access: z.boolean(),
    features: z.array(featureKey).max(100),
    ea_products: z.array(productId).max(50),
    ea_platforms: z.array(z.enum(EA_PLATFORMS)).max(2),
    /** When true, EA activations must send a trading-account reference and are bound to it. */
    require_account_binding: z.boolean(),
  })
  .strict()
  .transform((e) => ({
    ...e,
    features: [...new Set(e.features)].sort(),
    ea_products: [...new Set(e.ea_products)].sort(),
    ea_platforms: [...new Set(e.ea_platforms)].sort(),
  }));
export type PlanEntitlements = z.output<typeof planEntitlements>;

const planCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, "UPPER_SNAKE_CASE, e.g. QUANT_PRO");
const limit = z.number().int().min(0).max(1000);

export const planCreateInput = z
  .object({
    code: planCode,
    name: z.string().trim().min(1).max(100),
    price_minor: z.number().int().min(0).max(1_000_000_000),
    currency,
    billing_period: z.enum(BILLING_PERIODS),
    max_web_devices: limit,
    max_ea_activations: limit,
    max_trading_accounts: limit,
    entitlements: planEntitlements,
    is_active: z.boolean().default(true),
  })
  .strict();
export type PlanCreateInput = z.input<typeof planCreateInput>;

export const planUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    price_minor: z.number().int().min(0).max(1_000_000_000),
    currency,
    billing_period: z.enum(BILLING_PERIODS),
    max_web_devices: limit,
    max_ea_activations: limit,
    max_trading_accounts: limit,
    entitlements: planEntitlements,
    is_active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");
export type PlanUpdateInput = z.input<typeof planUpdateInput>;

export const plan = z.object({
  id,
  code: planCode,
  name: z.string(),
  price_minor: z.number().int(),
  currency: z.string(),
  billing_period: z.enum(BILLING_PERIODS),
  max_web_devices: z.number().int(),
  max_ea_activations: z.number().int(),
  max_trading_accounts: z.number().int(),
  entitlements: planEntitlements,
  is_active: z.boolean(),
  created_at: isoUtc,
  updated_at: isoUtc,
});
export type Plan = z.output<typeof plan>;
