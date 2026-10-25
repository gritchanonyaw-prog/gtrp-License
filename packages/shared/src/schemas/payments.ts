import { z } from "zod";
import { PAYMENT_STATUSES } from "../constants/index.js";
import { currency, id, isoUtc, paginationQuery } from "./common.js";

export const checkoutInput = z
  .object({
    plan_id: id,
    /** Renew this existing license (must belong to the caller). Omit to buy a new license. */
    license_id: id.optional(),
  })
  .strict();
export type CheckoutInput = z.input<typeof checkoutInput>;

export const checkoutResponse = z.object({
  payment_id: id,
  provider: z.string(),
  provider_ref: z.string(),
  amount_minor: z.number().int(),
  currency: z.string(),
  /** Provider-hosted checkout page. null for the development mock provider. */
  checkout_url: z.string().nullable(),
});

/**
 * Webhook body of the DEVELOPMENT-ONLY mock provider. Real providers have
 * their own payload formats and are normalized by their adapter.
 */
export const mockWebhookEvent = z
  .object({
    id: z.string().min(1).max(100),
    type: z.enum(["payment.succeeded", "payment.failed", "payment.refunded", "payment.chargeback"]),
    created: z.number().int(),
    data: z
      .object({
        provider_ref: z.string().min(1).max(100),
        amount_minor: z.number().int().min(0),
        currency,
      })
      .strict(),
  })
  .strict();
export type MockWebhookEvent = z.infer<typeof mockWebhookEvent>;

export const payment = z.object({
  id,
  user_id: id,
  license_id: id.nullable(),
  plan_id: id,
  provider: z.string(),
  provider_ref: z.string(),
  amount_minor: z.number().int(),
  currency: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  paid_at: isoUtc.nullable(),
  refunded_at: isoUtc.nullable(),
  created_at: isoUtc,
});
export type Payment = z.infer<typeof payment>;

export const adminPaymentsQuery = paginationQuery.extend({
  status: z.enum(PAYMENT_STATUSES).optional(),
  user_id: id.optional(),
  license_id: id.optional(),
});
