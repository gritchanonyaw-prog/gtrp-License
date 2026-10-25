import type { Env } from "../../env.js";
import type { PaymentRow } from "../../repositories/types.js";
import { mockProvider } from "./mockProvider.js";

/** A provider webhook event after signature verification, in provider-neutral form. */
export interface NormalizedPaymentEvent {
  /** Provider's unique event id (idempotency key). */
  eventId: string;
  type: "succeeded" | "failed" | "refunded" | "chargeback";
  /** The reference returned by createCheckout and stored on the payment row. */
  providerRef: string;
  amountMinor: number;
  currency: string;
}

export interface CheckoutSession {
  providerRef: string;
  /** Provider-hosted payment page; null when the provider has none (mock). */
  checkoutUrl: string | null;
}

/**
 * Adapter for one payment provider. To add a real provider (e.g. Omise, Stripe,
 * 2C2P): implement this interface with the provider's official signature scheme,
 * register it in PROVIDERS, and keep `enabled` false until its secrets are set.
 * No live provider is included or configured in this repository.
 */
export interface PaymentProvider {
  readonly name: string;
  /** True only when the provider is configured and allowed in this environment. */
  enabled(env: Env): boolean;
  createCheckout(env: Env, payment: Pick<PaymentRow, "id" | "amount_minor" | "currency">): Promise<CheckoutSession>;
  /**
   * Verifies the webhook signature over the exact raw body and returns the
   * normalized event. Must throw WEBHOOK_SIGNATURE_INVALID on any doubt.
   */
  parseWebhook(env: Env, rawBody: string, headers: Headers, nowMs: number): Promise<NormalizedPaymentEvent>;
}

const PROVIDERS: Record<string, PaymentProvider> = {
  [mockProvider.name]: mockProvider,
};

/** An enabled provider by name, or null (unknown or disabled providers look the same to callers). */
export function getProvider(env: Env, name: string): PaymentProvider | null {
  const p = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name]! : null;
  return p && p.enabled(env) ? p : null;
}

/** The provider used for new checkouts: the first enabled one, or null when online payments are off. */
export function checkoutProvider(env: Env): PaymentProvider | null {
  return Object.values(PROVIDERS).find((p) => p.enabled(env)) ?? null;
}
