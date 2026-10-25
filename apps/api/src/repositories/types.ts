import type {
  ActivationStatus,
  ActivationType,
  BillingPeriod,
  LicenseStatus,
  PaymentStatus,
  UserRole,
  UserStatus,
} from "@gtrp/shared";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  mfa_secret_enc: string | null;
  mfa_enabled: number;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  price_minor: number;
  currency: string;
  billing_period: BillingPeriod;
  max_web_devices: number;
  max_ea_activations: number;
  max_trading_accounts: number;
  features_json: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface LicenseRow {
  id: string;
  user_id: string;
  plan_id: string;
  key_hash: string | null;
  key_hint: string | null;
  status: LicenseStatus;
  starts_at: string;
  expires_at: string | null;
  grace_until: string | null;
  note: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ActivationRow {
  id: string;
  license_id: string;
  activation_type: ActivationType;
  product: string;
  device_hash: string;
  account_ref_hash: string | null;
  label: string | null;
  status: ActivationStatus;
  first_seen_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  mfa_verified: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string;
}

export interface PaymentRow {
  id: string;
  user_id: string;
  license_id: string | null;
  plan_id: string;
  provider: string;
  provider_ref: string;
  amount_minor: number;
  currency: string;
  status: PaymentStatus;
  paid_event_id: string | null;
  refund_event_id: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  license_id: string | null;
  actor_user_id: string | null;
  actor_type: "admin" | "customer" | "system" | "client" | "provider";
  target_user_id: string | null;
  event_type: string;
  details_json: string;
  created_at: string;
}
