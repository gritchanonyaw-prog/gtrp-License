import {
  adminActivationsQuery,
  adminCreateLicenseInput,
  adminCustomersQuery,
  adminCustomerStatusInput,
  adminEventsQuery,
  adminLicenseActionInput,
  adminLicensesQuery,
  adminPaymentsQuery,
  adminRenewInput,
  adminUpdateLicenseInput,
  planCreateInput,
  planUpdateInput,
} from "@gtrp/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { clock, nowIso } from "../../clock.js";
import type { AppEnv } from "../../env.js";
import { errors } from "../../errors/index.js";
import { requireAdmin, requireSession } from "../../middleware/auth.js";
import { adminListActivations } from "../../repositories/activations.js";
import { listEvents } from "../../repositories/events.js";
import { adminListLicenses, getLicense } from "../../repositories/licenses.js";
import { listAdminPayments } from "../../repositories/payments.js";
import { listPlans, toPlan } from "../../repositories/plans.js";
import { listCustomers } from "../../repositories/users.js";
import * as admin from "../../services/adminService.js";
import * as licenses from "../../services/licenseService.js";
import { idParam, validate } from "../../validators/index.js";

function actor(c: Context<AppEnv>): licenses.Actor {
  return { userId: requireSession(c).user.id, type: "admin" };
}

function page<T>(rows: T[], total: number, q: { page: number; page_size: number }) {
  return { data: rows, pagination: { page: q.page, page_size: q.page_size, total } };
}

export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireAdmin)
  .get("/metrics", async (c) => c.json(await admin.metrics(c.env)))

  // ---- customers
  .get("/customers", validate("query", adminCustomersQuery), async (c) => {
    const q = c.req.valid("query");
    const r = await listCustomers(c.env.DB, q, q.page, q.page_size);
    return c.json(page(r.rows, r.total, q));
  })
  .get("/customers/:id", validate("param", idParam), async (c) => c.json(await admin.customerDetail(c.env, c.req.valid("param").id)))
  .post("/customers/:id/status", validate("param", idParam), validate("json", adminCustomerStatusInput), async (c) => {
    const b = c.req.valid("json");
    return c.json(await admin.setCustomerStatus(c.env, c.req.valid("param").id, b.status, b.reason, actor(c)));
  })
  .post("/customers/:id/delete", validate("param", idParam), validate("json", adminLicenseActionInput), async (c) => {
    await admin.deleteCustomer(c.env, c.req.valid("param").id, c.req.valid("json").reason, actor(c));
    return c.body(null, 204);
  })

  // ---- licenses
  .get("/licenses", validate("query", adminLicensesQuery), async (c) => {
    const q = c.req.valid("query");
    const expiring = q.expiring_within_days ? new Date(clock.nowMs() + q.expiring_within_days * 86400_000).toISOString() : undefined;
    const r = await adminListLicenses(c.env.DB, { ...q, expiring_before: expiring, now: nowIso() }, q.page, q.page_size);
    return c.json(page(r.rows, r.total, q));
  })
  .post("/licenses", validate("json", adminCreateLicenseInput), async (c) => {
    return c.json(await licenses.createLicense(c.env, c.req.valid("json"), actor(c)), 201);
  })
  .get("/licenses/:id", validate("param", idParam), async (c) => {
    const l = await getLicense(c.env.DB, c.req.valid("param").id);
    if (!l) throw errors.notFound("License");
    return c.json(await admin.licenseDetail(c.env, l));
  })
  .patch("/licenses/:id", validate("param", idParam), validate("json", adminUpdateLicenseInput), async (c) => {
    return c.json({ license: await licenses.updateLicense(c.env, c.req.valid("param").id, c.req.valid("json"), actor(c)) });
  })
  .post("/licenses/:id/activate", validate("param", idParam), validate("json", adminLicenseActionInput), async (c) => {
    return c.json({ license: await licenses.transitionLicense(c.env, c.req.valid("param").id, "activate", actor(c), c.req.valid("json").reason) });
  })
  .post("/licenses/:id/suspend", validate("param", idParam), validate("json", adminLicenseActionInput), async (c) => {
    return c.json({ license: await licenses.transitionLicense(c.env, c.req.valid("param").id, "suspend", actor(c), c.req.valid("json").reason) });
  })
  .post("/licenses/:id/reactivate", validate("param", idParam), validate("json", adminLicenseActionInput), async (c) => {
    return c.json({ license: await licenses.transitionLicense(c.env, c.req.valid("param").id, "reactivate", actor(c), c.req.valid("json").reason) });
  })
  .post("/licenses/:id/revoke", validate("param", idParam), validate("json", adminLicenseActionInput), async (c) => {
    return c.json({ license: await licenses.transitionLicense(c.env, c.req.valid("param").id, "revoke", actor(c), c.req.valid("json").reason) });
  })
  .post("/licenses/:id/renew", validate("param", idParam), validate("json", adminRenewInput), async (c) => {
    return c.json({ license: await licenses.renewLicense(c.env, c.req.valid("param").id, c.req.valid("json"), actor(c)) });
  })
  .post("/licenses/:id/reissue-key", validate("param", idParam), async (c) => {
    return c.json(await licenses.reissueKey(c.env, c.req.valid("param").id, actor(c)));
  })
  .get("/licenses/:id/events", validate("param", idParam), validate("query", adminEventsQuery), async (c) => {
    const q = c.req.valid("query");
    const r = await listEvents(c.env.DB, { ...q, license_id: c.req.valid("param").id }, q.page, q.page_size);
    return c.json(page(r.rows, r.total, q));
  })

  // ---- activations
  .get("/activations", validate("query", adminActivationsQuery), async (c) => {
    const q = c.req.valid("query");
    const r = await adminListActivations(c.env.DB, q, q.page, q.page_size);
    return c.json(page(r.rows, r.total, q));
  })
  .post("/activations/:id/revoke", validate("param", idParam), validate("json", adminLicenseActionInput), async (c) => {
    return c.json({ activation: await admin.revokeActivation(c.env, c.req.valid("param").id, c.req.valid("json").reason, actor(c)) });
  })

  // ---- audit
  .get("/events", validate("query", adminEventsQuery), async (c) => {
    const q = c.req.valid("query");
    const r = await listEvents(c.env.DB, q, q.page, q.page_size);
    return c.json(page(r.rows, r.total, q));
  })

  // ---- plans
  .get("/plans", async (c) => c.json({ data: (await listPlans(c.env.DB, false)).map(toPlan) }))
  .post("/plans", validate("json", planCreateInput), async (c) => c.json({ plan: await admin.createPlan(c.env, c.req.valid("json"), actor(c)) }, 201))
  .patch("/plans/:id", validate("param", idParam), validate("json", planUpdateInput), async (c) => {
    return c.json({ plan: await admin.updatePlan(c.env, c.req.valid("param").id, c.req.valid("json"), actor(c)) });
  })

  // ---- payments (read-only; state changes only via verified webhooks)
  .get("/payments", validate("query", adminPaymentsQuery), async (c) => {
    const q = c.req.valid("query");
    const r = await listAdminPayments(c.env.DB, q, q.page, q.page_size);
    return c.json(page(r.rows, r.total, q));
  });
