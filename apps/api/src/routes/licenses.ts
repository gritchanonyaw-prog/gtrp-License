import { activateInput, activationsQuery, deactivateInput, refreshInput, validateInput } from "@gtrp/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { errors } from "../errors/index.js";
import { requireAuth, requireSession } from "../middleware/auth.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";
import { listActivationsForLicense, toActivation } from "../repositories/activations.js";
import { getLicense } from "../repositories/licenses.js";
import { listPlans, toPlan } from "../repositories/plans.js";
import { authorizeFeature, userEntitlements, WEB_ACTIVATION_HEADER } from "../services/entitlementService.js";
import { listCustomerLicenses, reissueKey } from "../services/licenseService.js";
import * as protocol from "../services/protocolService.js";
import { idParam, validate } from "../validators/index.js";

export const licenseRoutes = new Hono<AppEnv>()
  /** Public plan catalog (active plans only). */
  .get("/plans", async (c) => {
    const plans = (await listPlans(c.env.DB, true)).map(toPlan);
    return c.json({ data: plans });
  })
  .get("/me/licenses", requireAuth, async (c) => {
    return c.json({ data: await listCustomerLicenses(c.env, requireSession(c).user.id) });
  })
  /** Customer rotates (or reveals for the first time) their own key. The old key stops working immediately. */
  .post("/me/licenses/:id/reissue-key", requireAuth, validate("param", idParam), async (c) => {
    const s = requireSession(c);
    await enforceRateLimit(c, "reissue", s.user.id, 5, 3600);
    const r = await reissueKey(c.env, c.req.valid("param").id, { userId: s.user.id, type: "customer" }, s.user.id);
    return c.json(r);
  })
  .get("/me/entitlements", requireAuth, async (c) => {
    return c.json(await userEntitlements(c.env, requireSession(c).user.id));
  })
  .get("/licenses/activations", requireAuth, validate("query", activationsQuery), async (c) => {
    const s = requireSession(c);
    const l = await getLicense(c.env.DB, c.req.valid("query").license_id);
    if (!l || l.user_id !== s.user.id) throw errors.notFound("License");
    return c.json({ data: (await listActivationsForLicense(c.env.DB, l.id)).map(toActivation) });
  })
  .post("/licenses/activate", validate("json", activateInput), async (c) => c.json(await protocol.activate(c, c.req.valid("json"))))
  .post("/licenses/validate", validate("json", validateInput), async (c) => c.json(await protocol.validate(c, c.req.valid("json"))))
  .post("/licenses/refresh", validate("json", refreshInput), async (c) => c.json(await protocol.refresh(c, c.req.valid("json"))))
  .post("/licenses/deactivate", validate("json", deactivateInput), async (c) => c.json(await protocol.deactivate(c, c.req.valid("json"))))
  /**
   * Server-side feature authorization for the Web App. The Web App (or its backend) calls this
   * before serving protected data; 200 = allowed, 403 = not allowed.
   */
  .get(
    "/features/:feature/access",
    requireAuth,
    validate("param", z.object({ feature: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) })),
    async (c) => {
      const s = requireSession(c);
      const feature = c.req.valid("param").feature;
      const r = await authorizeFeature(c.env, s.user.id, feature, c.req.header(WEB_ACTIVATION_HEADER));
      return c.json({ feature, allowed: true, ...r });
    },
  );
