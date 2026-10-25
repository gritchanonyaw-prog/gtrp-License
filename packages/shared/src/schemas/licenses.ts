import { z } from "zod";
import { ACTIVATION_STATUSES, ACTIVATION_TYPES, LICENSE_STATUSES } from "../constants/index.js";
import { email, id, isoUtc, paginationQuery } from "./common.js";
import { planEntitlements, productId } from "./plans.js";

/** Accepts any short string; the server normalizes and checks the key format itself so that bad keys get the same generic answer as unknown ones. */
export const licenseKeyInput = z.string().min(1).max(64);

export const activationId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "16-128 characters: letters, digits, '-' or '_'");

/** Trading-account reference such as "BrokerServer-Live:12345678". Hashed server-side, never stored in clear text. */
export const accountRef = z.string().regex(/^[A-Za-z0-9._:@-]{1,96}$/);

const protocolBase = {
  protocol_version: z.number().int().min(1).max(100),
  /** Unique per request (UUID). Used for replay protection. */
  request_id: z.uuid(),
  /** Client's current UTC time. Used for clock-skew detection. */
  client_time: isoUtc,
};

const licenseRef = {
  /** EA clients authenticate with the license key. */
  license_key: licenseKeyInput.optional(),
  /** Logged-in Web App users may reference their own license by id instead (requires a session). */
  license_id: id.optional(),
};

function exactlyOneLicenseRef(v: { license_key?: string | undefined; license_id?: string | undefined }) {
  return (v.license_key === undefined) !== (v.license_id === undefined);
}
const exactlyOneMessage = { message: "Provide exactly one of license_key or license_id", path: ["license_key"] };

export const activateInput = z
  .object({
    ...protocolBase,
    ...licenseRef,
    product: productId,
    platform: z.enum(ACTIVATION_TYPES),
    activation_id: activationId,
    account_ref: accountRef.optional(),
    label: z.string().trim().max(64).optional(),
  })
  .strict()
  .refine(exactlyOneLicenseRef, exactlyOneMessage);
export type ActivateInput = z.input<typeof activateInput>;

export const validateInput = z
  .object({
    ...protocolBase,
    ...licenseRef,
    product: productId,
    platform: z.enum(ACTIVATION_TYPES),
    activation_id: activationId,
    account_ref: accountRef.optional(),
  })
  .strict()
  .refine(exactlyOneLicenseRef, exactlyOneMessage);
export type ValidateInput = z.input<typeof validateInput>;

export const deactivateInput = z
  .object({
    ...protocolBase,
    ...licenseRef,
    platform: z.enum(ACTIVATION_TYPES),
    activation_id: activationId,
  })
  .strict()
  .refine(exactlyOneLicenseRef, exactlyOneMessage);
export type DeactivateInput = z.input<typeof deactivateInput>;

export const refreshInput = z
  .object({
    ...protocolBase,
    lease_token: z.string().min(10).max(4096),
    activation_id: activationId,
  })
  .strict();
export type RefreshInput = z.input<typeof refreshInput>;

export const effectiveStatus = z.enum(["created", "active", "expired", "suspended", "revoked", "not_started"]);
export type EffectiveStatus = z.infer<typeof effectiveStatus>;

export const usageCounter = z.object({ used: z.number().int(), max: z.number().int() });

export const licenseSummary = z.object({
  id,
  status: z.enum(LICENSE_STATUSES),
  effective_status: effectiveStatus,
  in_grace: z.boolean(),
  key_hint: z.string().nullable(),
  plan: z.object({ id, code: z.string(), name: z.string() }),
  starts_at: isoUtc,
  expires_at: isoUtc.nullable(),
  grace_until: isoUtc.nullable(),
  entitlements: planEntitlements,
  usage: z.object({ web: usageCounter, ea: usageCounter, trading_accounts: usageCounter }),
  created_at: isoUtc,
});
export type LicenseSummary = z.output<typeof licenseSummary>;

export const activation = z.object({
  id,
  license_id: id,
  activation_type: z.enum(ACTIVATION_TYPES),
  product: z.string(),
  label: z.string().nullable(),
  has_account_ref: z.boolean(),
  status: z.enum(ACTIVATION_STATUSES),
  first_seen_at: isoUtc,
  last_seen_at: isoUtc,
  revoked_at: isoUtc.nullable(),
});
export type Activation = z.infer<typeof activation>;

/** Successful activate/validate/refresh response (protocol v1). */
export const licenseProtocolResponse = z.object({
  protocol_version: z.number().int(),
  request_id: z.string(),
  server_time: isoUtc,
  result: z.literal("ok"),
  license: z.object({
    id,
    status: effectiveStatus,
    in_grace: z.boolean(),
    plan_code: z.string(),
    expires_at: isoUtc.nullable(),
    grace_until: isoUtc.nullable(),
  }),
  activation: z.object({ id, platform: z.enum(ACTIVATION_TYPES), status: z.enum(ACTIVATION_STATUSES) }),
  entitlements: planEntitlements,
  lease: z.object({ token: z.string(), expires_at: isoUtc }),
  policy: z.object({
    /** Client should re-validate after this many seconds. */
    revalidate_after_seconds: z.number().int(),
    /** Last moment the client may keep allowing new entries without reaching the server. Equals lease.expires_at. */
    offline_grace_until: isoUtc,
  }),
});
export type LicenseProtocolResponse = z.output<typeof licenseProtocolResponse>;

export const deactivateResponse = z.object({
  protocol_version: z.number().int(),
  request_id: z.string(),
  server_time: isoUtc,
  result: z.literal("deactivated"),
});

export const activationsQuery = z.object({ license_id: id });

/* ---------- admin ---------- */

const reason = z.string().trim().min(3).max(500);

export const adminCreateLicenseInput = z
  .object({
    user_id: id.optional(),
    email: email.optional(),
    plan_id: id,
    starts_at: isoUtc.optional(),
    /** Omit to derive from the plan's billing period. null is only accepted for lifetime plans. */
    expires_at: isoUtc.nullable().optional(),
    grace_days: z.number().int().min(0).max(60).default(3),
    /** false creates the license in the "created" state (e.g. awaiting payment). */
    activate: z.boolean().default(true),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => (v.user_id === undefined) !== (v.email === undefined), {
    message: "Provide exactly one of user_id or email",
    path: ["user_id"],
  });
export type AdminCreateLicenseInput = z.input<typeof adminCreateLicenseInput>;

export const adminUpdateLicenseInput = z
  .object({
    plan_id: id,
    starts_at: isoUtc,
    expires_at: isoUtc.nullable(),
    grace_until: isoUtc.nullable(),
    note: z.string().trim().max(500),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "note"), "At least one field besides note is required");
export type AdminUpdateLicenseInput = z.input<typeof adminUpdateLicenseInput>;

export const adminLicenseActionInput = z.object({ reason }).strict();
export type AdminLicenseActionInput = z.input<typeof adminLicenseActionInput>;

export const adminRenewInput = z
  .object({
    /** Explicit new expiry. Mutually exclusive with periods. */
    expires_at: isoUtc.optional(),
    /** Number of plan billing periods to add (from the later of now and the current expiry). */
    periods: z.number().int().min(1).max(36).optional(),
    reason,
  })
  .strict()
  .refine((v) => (v.expires_at === undefined) !== (v.periods === undefined), {
    message: "Provide exactly one of expires_at or periods",
    path: ["periods"],
  });
export type AdminRenewInput = z.input<typeof adminRenewInput>;

export const adminLicensesQuery = paginationQuery.extend({
  status: z.enum(LICENSE_STATUSES).optional(),
  plan_id: id.optional(),
  user_id: id.optional(),
  email: z.string().trim().max(254).optional(),
  expiring_within_days: z.coerce.number().int().min(1).max(365).optional(),
});

export const adminActivationsQuery = paginationQuery.extend({
  activation_type: z.enum(ACTIVATION_TYPES).optional(),
  status: z.enum(ACTIVATION_STATUSES).optional(),
  license_id: id.optional(),
});

export const adminCustomersQuery = paginationQuery.extend({
  /** Matches email substring or exact user id. */
  q: z.string().trim().max(254).optional(),
  status: z.enum(["active", "suspended", "deleted"]).optional(),
});

export const adminCustomerStatusInput = z
  .object({ status: z.enum(["active", "suspended"]), reason })
  .strict();

export const adminEventsQuery = paginationQuery.extend({
  from: isoUtc.optional(),
  to: isoUtc.optional(),
  actor_user_id: id.optional(),
  target_user_id: id.optional(),
  license_id: id.optional(),
  event_type: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional(),
});
