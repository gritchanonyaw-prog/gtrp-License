import { checkoutInput } from "@gtrp/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { requireAuth, requireSession } from "../middleware/auth.js";
import { enforceRateLimit, ipRateLimit } from "../middleware/rateLimit.js";
import { listPaymentsForUser } from "../repositories/payments.js";
import { createCheckout, handleWebhook } from "../services/payments/paymentService.js";
import { validate } from "../validators/index.js";

export const paymentRoutes = new Hono<AppEnv>()
  .post("/payments/checkout", requireAuth, validate("json", checkoutInput), async (c) => {
    const s = requireSession(c);
    await enforceRateLimit(c, "checkout", s.user.id, 10, 3600);
    return c.json(await createCheckout(c.env, s.user.id, c.req.valid("json")), 201);
  })
  .get("/me/payments", requireAuth, async (c) => {
    return c.json({ data: await listPaymentsForUser(c.env.DB, requireSession(c).user.id) });
  })
  /**
   * Provider webhooks. No session or CSRF token: authenticity comes only from the
   * provider signature over the exact raw body, verified before anything is parsed.
   */
  .post(
    "/webhooks/payments/:provider",
    ipRateLimit("webhook", 300, 60),
    validate("param", z.object({ provider: z.string().regex(/^[a-z0-9_]{1,32}$/) })),
    async (c) => {
      const raw = await c.req.text();
      return c.json(await handleWebhook(c.env, c.req.valid("param").provider, raw, c.req.raw.headers));
    },
  );
