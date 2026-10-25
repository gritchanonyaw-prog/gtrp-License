export const API_VERSION = "v1" as const;

/** EA/Web license protocol version. Bump only with a documented compatibility plan. */
export const PROTOCOL_VERSION = 1 as const;
/** Protocol versions the server still accepts. */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

export const USER_ROLES = ["customer", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const LICENSE_STATUSES = ["created", "active", "expired", "suspended", "revoked"] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const BILLING_PERIODS = ["monthly", "yearly", "lifetime"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const ACTIVATION_TYPES = ["web", "mt4", "mt5"] as const;
export type ActivationType = (typeof ACTIVATION_TYPES)[number];

export const EA_PLATFORMS = ["mt4", "mt5"] as const;
export type EaPlatform = (typeof EA_PLATFORMS)[number];

export const ACTIVATION_STATUSES = ["active", "revoked"] as const;
export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Product identifier of the GTRP Quant Analysis Web App. */
export const WEB_PRODUCT_ID = "gtrp_web" as const;

/**
 * Web App feature keys known at release time. Plans may list additional
 * keys; the server treats any key it does not find in a plan as "not entitled".
 */
export const KNOWN_FEATURES = [
  "advanced_charts",
  "smc",
  "volume_analysis",
  "ea_connector",
] as const;
export type KnownFeature = (typeof KNOWN_FEATURES)[number];

/** Human-friendly license key format: GTRP- followed by four groups of four Crockford base32 characters. */
export const LICENSE_KEY_PREFIX = "GTRP";
export const LICENSE_KEY_GROUPS = 4;
export const LICENSE_KEY_GROUP_LENGTH = 4;
/** Crockford base32 alphabet (no I, L, O, U) - 5 bits per character, 16 chars = 80 bits of entropy. */
export const LICENSE_KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LICENSE_KEY_REGEX = /^GTRP(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

/** Allowed clock difference between an EA/web client and the server. */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export const ERROR_CODES = {
  // generic
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  // auth
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  FORBIDDEN: "FORBIDDEN",
  CSRF_REJECTED: "CSRF_REJECTED",
  MFA_REQUIRED: "MFA_REQUIRED",
  MFA_INVALID: "MFA_INVALID",
  MFA_SETUP_REQUIRED: "MFA_SETUP_REQUIRED",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  // license protocol
  LICENSE_INVALID: "LICENSE_INVALID",
  LICENSE_NOT_STARTED: "LICENSE_NOT_STARTED",
  LICENSE_NOT_ACTIVE: "LICENSE_NOT_ACTIVE",
  LICENSE_EXPIRED: "LICENSE_EXPIRED",
  LICENSE_SUSPENDED: "LICENSE_SUSPENDED",
  LICENSE_REVOKED: "LICENSE_REVOKED",
  PRODUCT_NOT_ENTITLED: "PRODUCT_NOT_ENTITLED",
  PLATFORM_NOT_ENTITLED: "PLATFORM_NOT_ENTITLED",
  FEATURE_NOT_ENTITLED: "FEATURE_NOT_ENTITLED",
  ACTIVATION_LIMIT_REACHED: "ACTIVATION_LIMIT_REACHED",
  ACCOUNT_LIMIT_REACHED: "ACCOUNT_LIMIT_REACHED",
  ACCOUNT_REF_REQUIRED: "ACCOUNT_REF_REQUIRED",
  ACCOUNT_MISMATCH: "ACCOUNT_MISMATCH",
  ACTIVATION_NOT_FOUND: "ACTIVATION_NOT_FOUND",
  ACTIVATION_REVOKED: "ACTIVATION_REVOKED",
  LEASE_INVALID: "LEASE_INVALID",
  LEASE_EXPIRED: "LEASE_EXPIRED",
  CLOCK_SKEW: "CLOCK_SKEW",
  REPLAY_DETECTED: "REPLAY_DETECTED",
  UNSUPPORTED_PROTOCOL: "UNSUPPORTED_PROTOCOL",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  // payments
  PAYMENTS_DISABLED: "PAYMENTS_DISABLED",
  WEBHOOK_SIGNATURE_INVALID: "WEBHOOK_SIGNATURE_INVALID",
  PAYMENT_MISMATCH: "PAYMENT_MISMATCH",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Error codes that represent a confirmed, authoritative denial from the
 * license server. EA clients must only stop opening new positions on these
 * codes - every other failure (timeouts, 5xx, 429, malformed responses) is
 * treated as a temporary failure covered by the offline grace lease.
 */
export const CONFIRMED_DENIAL_CODES: readonly ErrorCode[] = [
  ERROR_CODES.LICENSE_INVALID,
  ERROR_CODES.LICENSE_NOT_STARTED,
  ERROR_CODES.LICENSE_NOT_ACTIVE,
  ERROR_CODES.LICENSE_EXPIRED,
  ERROR_CODES.LICENSE_SUSPENDED,
  ERROR_CODES.LICENSE_REVOKED,
  ERROR_CODES.PRODUCT_NOT_ENTITLED,
  ERROR_CODES.PLATFORM_NOT_ENTITLED,
  ERROR_CODES.ACTIVATION_LIMIT_REACHED,
  ERROR_CODES.ACCOUNT_LIMIT_REACHED,
  ERROR_CODES.ACCOUNT_REF_REQUIRED,
  ERROR_CODES.ACCOUNT_MISMATCH,
  ERROR_CODES.ACTIVATION_NOT_FOUND,
  ERROR_CODES.ACTIVATION_REVOKED,
];

export const AUDIT_EVENT_TYPES = [
  "license.created",
  "license.updated",
  "license.activated",
  "license.suspended",
  "license.reactivated",
  "license.revoked",
  "license.renewed",
  "license.expired",
  "license.key_reissued",
  "activation.created",
  "activation.reactivated",
  "activation.revoked",
  "activation.failed",
  "plan.created",
  "plan.updated",
  "user.registered",
  "user.login_failed",
  "user.locked",
  "user.status_changed",
  "user.deleted",
  "user.password_changed",
  "user.mfa_enabled",
  "payment.created",
  "payment.paid",
  "payment.failed",
  "payment.refunded",
  "payment.rejected",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
