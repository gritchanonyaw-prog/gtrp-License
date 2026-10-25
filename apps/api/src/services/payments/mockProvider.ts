import { ERROR_CODES, mockWebhookEvent } from "@gtrp/shared";
import { flag, type Env } from "../../env.js";
import { AppError, errors } from "../../errors/index.js";
import { hmacHex, randomToken, timingSafeEqual } from "../../security/crypto.js";
import { issuesToDetails } from "../../validators/index.js";
import type { PaymentProvider } from "./provider.js";

/** Maximum age (either direction) of a signed webhook timestamp. Older deliveries are treated as replays. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const MOCK_SIGNATURE_HEADER = "X-Mock-Signature";

const TYPE_MAP = {
  "payment.succeeded": "succeeded",
  "payment.failed": "failed",
  "payment.refunded": "refunded",
  "payment.chargeback": "chargeback",
} as const;

function invalidSignature(): AppError {
  return new AppError(400, ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, "Webhook signature is invalid or expired.");
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` - the same shape as common real providers. */
export async function mockSignature(secret: string, rawBody: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex(secret, `${unixSeconds}.${rawBody}`)}`;
}

/**
 * DEVELOPMENT / TEST ONLY payment provider. It moves no money: anyone holding
 * MOCK_PAYMENT_WEBHOOK_SECRET can mark payments as paid. It is refused in
 * production regardless of configuration.
 */
export const mockProvider: PaymentProvider = {
  name: "mock",

  enabled(env: Env) {
    return env.ENVIRONMENT !== "production" && flag(env.PAYMENTS_MOCK_ENABLED) && (env.MOCK_PAYMENT_WEBHOOK_SECRET ?? "").length >= 32;
  },

  async createCheckout() {
    return { providerRef: `mock_${randomToken(12)}`, checkoutUrl: null };
  },

  async parseWebhook(env, rawBody, headers, nowMs) {
    const header = headers.get(MOCK_SIGNATURE_HEADER) ?? "";
    const parts = new Map(
      header.split(",").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
      }),
    );
    const t = parts.get("t") ?? "";
    const v1 = parts.get("v1") ?? "";
    if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) throw invalidSignature();
    if (Math.abs(nowMs / 1000 - Number(t)) > WEBHOOK_TOLERANCE_SECONDS) throw invalidSignature();
    const expected = await hmacHex(env.MOCK_PAYMENT_WEBHOOK_SECRET!, `${t}.${rawBody}`);
    if (!timingSafeEqual(expected, v1)) throw invalidSignature();

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw errors.validation([{ path: "", message: "Body must be JSON" }]);
    }
    const parsed = mockWebhookEvent.safeParse(json);
    if (!parsed.success) throw errors.validation(issuesToDetails(parsed.error.issues));
    const ev = parsed.data;
    return {
      eventId: ev.id,
      type: TYPE_MAP[ev.type],
      providerRef: ev.data.provider_ref,
      amountMinor: ev.data.amount_minor,
      currency: ev.data.currency,
    };
  },
};
