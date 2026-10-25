# Architecture

GTRP Unified License System V1.0 is one licensing backend for three clients:

| Client | How it authenticates | What it asks |
| --- | --- | --- |
| GTRP Quant Analysis **Web App** | Customer session (bearer token or cookie) + a web activation id | "May this user, on this browser, use feature X?" |
| GTRP **EA for MT4 / MT5** | License key + per-installation activation id | "May this installation open new positions?" (answered with a signed, time-limited lease) |
| **Admin dashboard** | Admin session cookie + TOTP MFA | Manage customers, plans, licenses, activations, audit, payments |

One customer account owns one or more licenses. Each license is on one plan, and the plan's entitlements decide which Web App features, EA products and EA platforms it unlocks, and how many web devices, EA installations and trading accounts it may use.

## Components

```
                    ┌──────────────────────── Cloudflare ────────────────────────┐
 Browser (admin) ──►│  Worker "gtrp-license-api"                                 │
                    │   ├─ Static assets: apps/admin/dist (SPA, strict CSP)      │
 Web App ──────────►│   ├─ /api/v1/*  Hono app                                   │
 (bearer / CORS)    │   │    middleware: request id → security headers →        │
                    │   │    body limit (64 KB) → CORS (Web App origins only) →  │
 MT4 / MT5 EA ─────►│   │    CSRF/origin check → session loader                  │
 (WebRequest, HTTPS)│   │    routes: health, auth, licenses/protocol, payments,  │
                    │   │            admin                                       │
 Payment provider ─►│   ├─ Cron "17 * * * *": expire licenses, purge nonces,    │
 (signed webhooks)  │   │    rate-limit windows, old sessions                    │
                    │   └─ D1 (SQLite) "DB"                                      │
                    │  Secrets: pepper, Ed25519 signing key, MFA key, webhook    │
                    └────────────────────────────────────────────────────────────┘
```

* **apps/api**: the Worker. TypeScript, Hono, zod validation on every input, D1 through prepared statements only.
* **apps/admin**: React + Vite dashboard. It is a client of the same `/api/v1/admin/*` endpoints. The UI hides actions an operator cannot take, but every rule is enforced by the API.
* **packages/shared**: zod schemas, constants (error codes, statuses, audit event types), the license lifecycle state machine, entitlement helpers and the lease verifier. Imported by the API, the dashboard and the reference client, so the contract cannot drift.
* **ea-examples**: `reference-client` (an executable TypeScript specification of the EA client state machine, tested against a mock server and against the real API), `include/GTRPLicense.mqh` and the MT4/MT5 example EAs.
* **migrations**: forward-only D1 migrations; manual rollback scripts in `migrations/rollback`.

The dashboard and API share one origin, so the admin session cookie is `SameSite=Strict`, `HttpOnly`, `Secure`, with the `__Host-` prefix in staging and production, and admin routes are never exposed to CORS.

## Data model (D1)

| Table | Purpose | Notes |
| --- | --- | --- |
| `users` | customers and admins | email unique, case-insensitive; PBKDF2 password hash; TOTP secret AES-GCM encrypted; `status` active/suspended/deleted |
| `plans` | sellable plans | `code` unique; price in minor units; `features_json` = entitlements (web_access, features, ea_products, ea_platforms, require_account_binding); limits |
| `licenses` | one row per license | `key_hash` = HMAC(pepper, key), unique, nullable until a key is revealed; `key_hint` = last 4 chars; `version` + `last_op_id` for optimistic concurrency |
| `activations` | web devices and EA installations | identity is (license, type, device_hash); `account_ref_hash` only when the plan binds accounts |
| `sessions` | login sessions | only SHA-256 of the token is stored |
| `payments` / `payment_events` | checkout and provider webhooks | unique (provider, provider_ref) and (provider, provider_event_id) |
| `license_events` | audit log | append-only (DB trigger blocks UPDATE/DELETE); details are redacted before insert |
| `api_rate_limits` | fixed-window counters | keys are truncated keyed hashes |
| `request_nonces` | replay protection for protocol requests | purged after expiry |

All timestamps are ISO 8601 UTC strings produced by the server clock. DB triggers enforce: only lifetime plans may have a NULL expiry, revoked licenses are terminal, and audit rows are append-only.

## License lifecycle

```
          activate                suspend
created ───────────► active ◄──────────────► suspended
   │  renew ─────────►  │  ▲     reactivate      │
   │                    │  │ renew               │ renew (stays suspended)
   │             expire │  │                     │
   │                    ▼  │                     │
   │                  expired                    │
   └──────── revoke ────┴──── revoke ────────────┘──► revoked (terminal)
```

* The table lives in `packages/shared/src/lifecycle.ts` (`LICENSE_TRANSITIONS`) and is tested exhaustively in `packages/shared/test/lifecycle.test.ts`.
* Enforcement never waits for the cron job: every request computes the **effective status** from the stored status and UTC server time (`not_started` before `starts_at`, `in_grace` between `expires_at` and `grace_until`, `expired` after). The hourly job only makes the stored status match and writes `license.expired` audit events.
* Every transition is a versioned UPDATE (`WHERE version = ?`) batched with its audit INSERT; the audit row is conditional on `last_op_id`, so an audit event exists if and only if the change applied. Concurrent conflicting changes get `409 CONFLICT`.

## Activation quotas under concurrency

An activation INSERT is a single statement of the form `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < max ON CONFLICT DO NOTHING`. SQLite executes each statement atomically, so two concurrent activations cannot both pass the count check. MT4 and MT5 installations share the EA limit; web devices have their own limit; distinct trading accounts are counted separately and only when `require_account_binding` is on. Re-activating an existing installation reuses its row.

## EA protocol (v1)

1. `activate` with the license key, product, platform and a random per-installation `activation_id` (not a hardware fingerprint).
2. The server returns an **Ed25519-signed lease** (compact JWS, `typ: GTRP-LEASE`) plus `policy.revalidate_after_seconds` and `policy.offline_grace_until`.
3. The EA calls `refresh` with the lease when due. The server re-checks license status on every refresh.
4. Only the **confirmed denial codes** (`CONFIRMED_DENIAL_CODES`) stop new entries. Timeouts, 5xx, 429 and malformed responses are transient: the EA keeps working until `offline_grace_until` (capped at 7 days by the client), then stops opening new positions.
5. Position management (modify, close, SL/TP) is never blocked by licensing.

Every protocol request carries `protocol_version`, a UUID `request_id` (stored as a nonce, replays are rejected) and `client_time` (rejected beyond ±300 s with `server_time` in the error so the client can correct). Full schemas: [EA_INTEGRATION_TH.md](EA_INTEGRATION_TH.md) and [API.md](API.md).

MQL4/MQL5 have no built-in Ed25519, so the example EA trusts the HTTPS channel and does not verify the lease signature itself; the lease is still useful to any client that can verify it (the TypeScript `verifyLease`, a future DLL-free MQL implementation). See [SECURITY.md](SECURITY.md#known-limitations).

## Web App authorization

The Web App must ask the server for every protected action: `GET /api/v1/features/:feature/access` with the customer session and the `X-GTRP-Activation-Id` header of an active web activation. Nothing is cached server-side, so suspensions, expiry, plan downgrades and disabled features apply on the next request. `GET /api/v1/me/entitlements` is for UI display only.

## Payments

`services/payments/provider.ts` defines a `PaymentProvider` adapter (create checkout, verify and normalize a webhook). The only adapter in this repository is a **development-only mock** that is refused in production. Checkout creates a pending payment priced from the plan; only a verified webhook changes state. Webhook processing writes all effects and the `payment_events` row in one D1 batch; a NOT NULL guard on that row rolls the whole batch back if any effect did not apply, and the unique event index makes redelivery a no-op. See [API.md](API.md#payments).

## Why these choices

* **D1 instead of Durable Objects**: the write rate is low (activations, admin actions), and single-statement atomic quota checks plus `db.batch` transactions are enough. If activation volume grows a lot, a per-license Durable Object would be the next step.
* **One Worker for API + dashboard**: same-origin cookies, no CORS for admin, one deployment.
* **HMAC with a server-side pepper for keys and identifiers**: a database leak alone does not reveal keys, device ids or account numbers, and lookups stay O(1).
* **PBKDF2-SHA256 (100k iterations)**: the strongest password KDF available natively in Workers WebCrypto. It needs the Workers Paid plan's CPU budget.
