# API reference (v1)

Base path: `/api/v1`. All bodies are JSON (`Content-Type: application/json`), at most 64 KB. All timestamps are ISO 8601 UTC with a trailing `Z`. Unknown fields are rejected (`VALIDATION_FAILED`). The zod schemas in `packages/shared/src/schemas` are the source of truth; this page summarizes them.

## Conventions

**Errors** always have this shape:

```json
{
  "error": {
    "code": "LICENSE_SUSPENDED",
    "message": "This license is suspended.",
    "request_id": "1b4e…",
    "retryable": false,
    "server_time": "2026-10-25T10:00:00.000Z",
    "details": [{ "path": "email", "message": "Invalid email address" }]
  }
}
```

`details` appears only on validation errors and never echoes submitted values. `retryable` tells clients whether retrying the same request later can succeed (true for 429, 5xx and `CLOCK_SKEW`). Every response has an `X-Request-Id` header.

**Pagination** (list endpoints): `?page=1&page_size=25` (max 100). Response: `{ "data": [...], "pagination": { "page", "page_size", "total" } }`.

**Authentication**

| Mode | How | Used by |
| --- | --- | --- |
| Session cookie | `POST /auth/login` (default `session_mode: "cookie"`) sets `__Host-gtrp_session` (`gtrp_session` in development) | admin dashboard; required for admins |
| Bearer token | `POST /auth/login` with `session_mode: "token"` returns `token`; send `Authorization: Bearer <token>` | customer Web App, scripts |
| License key | in the JSON body of protocol requests, never in the URL | EAs |
| Provider signature | header defined by the provider adapter | payment webhooks |

Cookie-authenticated unsafe requests must send an allowed `Origin` (or `Sec-Fetch-Site: same-origin`), otherwise `403 CSRF_REJECTED`. CORS is enabled only for the origins in `APP_ORIGINS`, without credentials, and never for `/admin/*`.

**Rate limits** (fixed windows, `429 RATE_LIMITED` with `Retry-After`):

| Scope | Limit |
| --- | --- |
| register, per IP | 10 / hour |
| login, per IP / per email | 30 / 15 min, 15 / 15 min (account lock after 10 failures for 15 min) |
| protocol (activate/validate/refresh/deactivate), per IP / per key | 120 / min, 30 / min |
| customer key reissue, per user | 5 / hour |
| checkout, per user | 10 / hour |
| payment webhooks, per IP | 300 / min |

## Health and keys

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/health` | none | `{ status: "ok"\|"degraded", version, environment, protocol_versions, server_time, checks: { database, config } }`; 503 when degraded. `config` checks the pepper, MFA key and signing key without revealing them. |
| GET | `/lease/public-keys` | none | `{ keys: [{ kid, kty: "OKP", crv: "Ed25519", x, alg: "EdDSA", use: "sig" }] }`: current and previous public keys (JWKS-style) |

## Authentication and account

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ email, password }` | password 10–128 chars. Always creates a `customer`. 201 `{ user }`. |
| POST | `/auth/login` | `{ email, password, totp_code?, session_mode? }` | 200 `{ user, session: { expires_at, mfa_verified }, token? }`. Admins: cookie only, `MFA_REQUIRED` when a code is needed. |
| POST | `/auth/logout` | – | revokes the session, 204 |
| POST | `/auth/change-password` | `{ current_password, new_password }` | revokes other sessions, 204 |
| POST | `/auth/mfa/setup` | – | `{ secret, otpauth_uri }` (shown once) |
| POST | `/auth/mfa/enable` | `{ totp_code }` | `{ mfa_enabled: true }` |
| GET | `/me` | – | `{ user, session }` |
| POST | `/me/delete` | `{ password }` | customer self-deletion: sessions revoked, licenses revoked, personal data anonymized; 204 |

## Customer licenses and entitlements

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/plans` | public catalog of active plans |
| GET | `/me/licenses` | `{ data: LicenseSummary[] }` (key shown only as a masked hint) |
| POST | `/me/licenses/:id/reissue-key` | issues a new key, returns `{ license, license_key }` **once**; the old key stops working. Also used to reveal the first key of a license created by payment. |
| GET | `/me/entitlements` | union of entitlements across usable licenses, for UI display only |
| GET | `/licenses/activations?license_id=` | own license's activations |
| GET | `/features/:feature/access` | header `X-GTRP-Activation-Id: <web activation id>`. 200 `{ feature, allowed: true, license_id, activation_id }` or 403 `FEATURE_NOT_ENTITLED` / `ACTIVATION_NOT_FOUND` / license status codes. Call it server-side before serving protected data. |

`LicenseSummary`: `{ id, status, effective_status, in_grace, key_hint, plan: { id, code, name }, starts_at, expires_at, grace_until, entitlements, usage: { web, ea, trading_accounts: { used, max } }, created_at }`.

## License protocol (EA and Web App)

All four endpoints take the envelope `{ protocol_version: 1, request_id: <uuid, new per request>, client_time: <UTC> }`.

| Path | Extra fields |
| --- | --- |
| POST `/licenses/activate` | `license_key` **or** `license_id` (license_id requires a customer session), `product`, `platform` (`web`\|`mt4`\|`mt5`), `activation_id` (16–128 chars `[A-Za-z0-9_-]`), `account_ref?`, `label?` |
| POST `/licenses/validate` | same as activate without `label`; the installation must already be activated |
| POST `/licenses/refresh` | `lease_token`, `activation_id` |
| POST `/licenses/deactivate` | `license_key` or `license_id`, `platform`, `activation_id` → `{ result: "deactivated" }` |

Success (activate / validate / refresh):

```json
{
  "protocol_version": 1,
  "request_id": "echo of the request id",
  "server_time": "2026-10-25T10:00:00.000Z",
  "result": "ok",
  "license": { "id": "…", "status": "active", "in_grace": false, "plan_code": "QUANT_PRO", "expires_at": "…", "grace_until": "…" },
  "activation": { "id": "…", "platform": "mt5", "status": "active" },
  "entitlements": { "web_access": true, "features": ["…"], "ea_products": ["gtrp_ea"], "ea_platforms": ["mt4", "mt5"], "require_account_binding": false },
  "lease": { "token": "<compact JWS>", "expires_at": "…" },
  "policy": { "revalidate_after_seconds": 1800, "offline_grace_until": "…" }
}
```

Lease JWS: header `{ alg: "EdDSA", typ: "GTRP-LEASE", kid }`, payload `{ iss: "gtrp-license", v: 1, jti, sub: <license id>, act: <activation id>, product, platform, ent: { features, ea_products }, iat, exp }`. Verify with a key from `/lease/public-keys` (`verifyLease` in `packages/shared`).

Protocol errors. Clients must treat **only** the confirmed denials as "stop opening new positions"; everything else is transient.

| Code | HTTP | Kind |
| --- | --- | --- |
| `LICENSE_INVALID`, `LICENSE_NOT_STARTED`, `LICENSE_NOT_ACTIVE`, `LICENSE_EXPIRED`, `LICENSE_SUSPENDED`, `LICENSE_REVOKED` | 403 | confirmed denial |
| `PRODUCT_NOT_ENTITLED`, `PLATFORM_NOT_ENTITLED` | 403 | confirmed denial |
| `ACTIVATION_LIMIT_REACHED`, `ACCOUNT_LIMIT_REACHED`, `ACCOUNT_REF_REQUIRED`, `ACCOUNT_MISMATCH` | 403 | confirmed denial |
| `ACTIVATION_NOT_FOUND`, `ACTIVATION_REVOKED` | 403/404 | confirmed denial (client may re-activate on NOT_FOUND) |
| `LEASE_INVALID`, `LEASE_EXPIRED` | 401 | fall back to `validate` with the key |
| `CLOCK_SKEW` | 400 | correct the clock from `error.server_time`, retry once |
| `REPLAY_DETECTED` | 409 | send a new `request_id` |
| `UNSUPPORTED_PROTOCOL`, `VALIDATION_FAILED` | 400 | client bug |
| `RATE_LIMITED`, `INTERNAL_ERROR`, network errors | 429/5xx | transient |

Detailed Thai integration guide with captured examples: [EA_INTEGRATION_TH.md](EA_INTEGRATION_TH.md).

## Payments

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/payments/checkout` | customer | `{ plan_id, license_id? }` (license_id = renewal of that license, same plan). 201 `{ payment_id, provider, provider_ref, amount_minor, currency, checkout_url }`. The amount comes from the plan. `503 PAYMENTS_DISABLED` when no provider is enabled. |
| GET | `/me/payments` | customer | own payments (no provider references) |
| POST | `/webhooks/payments/:provider` | provider signature | see below |

Webhook processing:

1. Unknown or disabled provider → 404.
2. Signature verified over the raw body; timestamp must be within ±300 s → otherwise `400 WEBHOOK_SIGNATURE_INVALID`, nothing stored.
3. Already-seen `(provider, event id)` → `200 { result: "duplicate", original_result }`.
4. Amount or currency differs from the payment → event recorded, `payment.rejected` audit, `422 PAYMENT_MISMATCH`, no state change.
5. Effects, applied atomically with the event record:
   * `succeeded` on a pending/failed payment → payment `paid`; renews the license (renewal checkout) or creates an active license **without a key** (customer reveals it via `/me/licenses/:id/reissue-key`). If the license can no longer be renewed (e.g. revoked) the result is `paid_needs_review`.
   * `failed` on a pending payment → `failed`.
   * `refunded` / `chargeback` on a paid payment → `refunded`, and the license is **suspended** for admin review.
   * anything else → `ignored_*` results, 200.
6. If a concurrent change prevented an effect from applying, nothing is stored and the response is `409 CONFLICT`, so the provider retries against fresh state.

Development-only mock provider (`:provider = mock`): body `{ id, type: "payment.succeeded"|"payment.failed"|"payment.refunded"|"payment.chargeback", created, data: { provider_ref, amount_minor, currency } }`, header `X-Mock-Signature: t=<unix>,v1=<hex HMAC-SHA256(MOCK_PAYMENT_WEBHOOK_SECRET, "<t>.<raw body>")>`. Enabled only when `PAYMENTS_MOCK_ENABLED=true`, the secret is set, and `ENVIRONMENT` is not `production`. `node scripts/mock-payment.mjs <provider_ref> <amount_minor>` sends one locally.

## Admin (`/admin/*`)

Requires an admin **cookie** session; with `REQUIRE_ADMIN_MFA=true` the session must be MFA-verified (`403 MFA_SETUP_REQUIRED` otherwise). Every state change requires a `reason` (3–500 chars) where noted and writes an audit event.

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/admin/metrics` | counts computed from live data |
| GET | `/admin/customers` | `q` (email substring or id), `status`, pagination |
| GET | `/admin/customers/:id` | profile, licenses, activations, recent events |
| POST | `/admin/customers/:id/status` | `{ status: "active"\|"suspended", reason }` (suspension revokes sessions) |
| POST | `/admin/customers/:id/delete` | `{ reason }`: anonymizes the customer, revokes sessions, licenses and activations |
| GET | `/admin/licenses` | `status`, `plan_id`, `user_id`, `email`, `expiring_within_days`, pagination |
| POST | `/admin/licenses` | `{ user_id \| email, plan_id, starts_at?, expires_at?, grace_days? (3), activate? (true), note? }` → 201 `{ license, license_key }` (key shown once) |
| GET | `/admin/licenses/:id` | license, usage, activations |
| PATCH | `/admin/licenses/:id` | `{ plan_id?, starts_at?, expires_at?, grace_until?, note? }` |
| POST | `/admin/licenses/:id/{activate,suspend,reactivate,revoke}` | `{ reason }`; invalid transitions → `409 INVALID_TRANSITION` |
| POST | `/admin/licenses/:id/renew` | `{ periods \| expires_at, reason }` |
| POST | `/admin/licenses/:id/reissue-key` | → `{ license, license_key }` once |
| GET | `/admin/licenses/:id/events` | audit trail of one license |
| GET | `/admin/activations` | `activation_type`, `status`, `license_id`, pagination |
| POST | `/admin/activations/:id/revoke` | `{ reason }` frees the slot |
| GET | `/admin/events` | `from`, `to`, `actor_user_id`, `target_user_id`, `license_id`, `event_type`, pagination |
| GET / POST | `/admin/plans` | create: `{ code, name, price_minor, currency, billing_period, max_web_devices, max_ea_activations, max_trading_accounts, entitlements, is_active? }` |
| PATCH | `/admin/plans/:id` | partial update; switching to/from lifetime is refused |
| GET | `/admin/payments` | `status`, `user_id`, `license_id`, pagination (read-only; payment state changes only through verified webhooks) |

## Audit event types

`license.created|updated|activated|suspended|reactivated|revoked|renewed|expired|key_reissued`, `activation.created|reactivated|revoked|failed`, `plan.created|updated`, `user.registered|login_failed|locked|status_changed|deleted|password_changed|mfa_enabled`, `payment.created|paid|failed|refunded|rejected`. Actor types: `admin`, `customer`, `system`, `client`, `provider`.
