# Security

This page describes the threat model, the controls that are implemented and tested, the operator checklist, and the limitations that remain. Report vulnerabilities privately to the project owner; do not open public issues for them.

## Threat model (summary)

| Asset | Threats considered | Main controls |
| --- | --- | --- |
| License keys | DB leak, log leak, guessing, sharing | HMAC-SHA256 with server-side pepper at rest; shown once; never logged, never in URLs; 80-bit random keys; per-IP and per-key rate limits; activation quotas |
| Customer accounts | credential stuffing, session theft, CSRF | PBKDF2-SHA256 100k + per-user salt; lockout after 10 failures; hashed session tokens; HttpOnly + Secure + SameSite=Strict `__Host-` cookie; origin checks |
| Admin dashboard | account takeover, privilege escalation | mandatory TOTP MFA (staging/prod), cookie-only admin sessions, role never client-settable, every admin change audited with a reason |
| Lease / EA authorization | forged or replayed approvals, clock tricks | Ed25519 signature (private key only in Worker secrets), request nonces, ±300 s clock-skew check, server re-checks status on each refresh |
| Payments | forged webhooks, replays, double renewal, amount tampering | provider signature over raw body with timestamp tolerance, unique event ids, atomic idempotent processing, price taken from plan, amount/currency check |
| Audit log | tampering, secrets in logs | append-only trigger, redaction of key-like values before insert and in logs |

Out of scope: a compromised Cloudflare account, a compromised admin workstation, and anything running on the customer's own computer (see limitations).

## Implemented controls

**Input and output**
* Every input is validated by a strict zod schema; unknown fields are rejected; bodies over 64 KB get `413`.
* All SQL uses prepared statements with bound parameters (tested with injection payloads).
* Uniform error envelope; validation errors never echo submitted values; internal errors return no stack trace or DB detail.
* API responses: `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, HSTS in staging/production. Dashboard assets: strict CSP (`script-src 'self'`, no inline scripts), `frame-ancestors 'none'`.

**Secrets and sensitive data**
* Stored only as hashes: license keys, session tokens, device ids, trading-account references, nonces, rate-limit keys. Passwords use PBKDF2; TOTP secrets are AES-GCM encrypted with `MFA_ENCRYPTION_KEY`.
* Secrets live in Cloudflare secrets (`wrangler secret put`) and, for local development only, in git-ignored `apps/api/.dev.vars`. CI fails if `.dev.vars`, `.env`, `*.pem`, `*.key` or a private JWK is committed.
* The logger and audit writer redact anything that looks like a license key, bearer token or password field, and put fixed fields last so caller data cannot overwrite them.
* The EA sends no broker password, investor password or withdrawal credential. The optional account reference is `server:login` and is hashed server-side.

**Authorization**
* Customers can read and change only their own licenses, activations and payments (`404` for others, so ids cannot be probed).
* `/admin/*` rejects anonymous (`401`) and customer (`403`) requests, bearer tokens for admins, and admin sessions without MFA when `REQUIRE_ADMIN_MFA=true`.
* No endpoint lets anyone change a user's role. Admins are created only with `scripts/create-admin.mjs`.
* License state changes follow the shared state machine; revoked is terminal (also enforced by a DB trigger).

**Protocol**
* Replay: each `request_id` is accepted once. Clock skew beyond 300 s is rejected with `server_time`.
* Leases are Ed25519 compact JWS with `kid`; key rotation keeps previous public keys published (`LEASE_PREVIOUS_PUBLIC_KEYS`).
* Network failures are never treated as revocations; only the documented confirmed-denial codes stop new entries; offline grace is bounded by the lease and capped at 7 days client-side; position management is never blocked.

**Payments**
* Live payments are disabled. The only provider is a mock refused in production.
* Webhooks: signature + ±300 s timestamp, dedupe on `(provider, event id)`, all effects and the event record in one transaction with a guard that rolls back partial effects, amount and currency checked against the stored payment.

## Tests that cover these controls

`apps/api/test/security.test.ts` (SQL injection, validation, rate limits, redaction, plaintext checks, role modification), `auth.test.ts` (sessions, lockout, CSRF, MFA, admin access), `licenses.test.ts` (replay, clock skew, malformed/tampered/expired leases, quotas under concurrency), `payments.test.ts` (signatures, replays, duplicates, mismatches, refunds, concurrency), `webapp.test.ts`, `migrations.test.ts`, and the EA client tests in `ea-examples/reference-client`. Run `pnpm test`.

## Operator security checklist

Before the first production deploy:

- [ ] Generate production secrets on a trusted machine (`node scripts/generate-dev-secrets.mjs --print`), store each with `wrangler secret put … --env production`, then clear the terminal. Never reuse development or staging values.
- [ ] Keep an offline, encrypted backup of `LICENSE_KEY_PEPPER` and `MFA_ENCRYPTION_KEY`. Losing the pepper invalidates every key and device hash; losing the MFA key forces MFA re-enrollment.
- [ ] Set `APP_ORIGINS` to the exact production origins (no wildcards). Confirm `COOKIE_SECURE=true`, `REQUIRE_ADMIN_MFA=true`, `PAYMENTS_MOCK_ENABLED=false`.
- [ ] Use a custom domain with HTTPS only; disable `workers.dev` for production (already `workers_dev = false`).
- [ ] Create admins with `scripts/create-admin.mjs` and enroll MFA on first login. Keep the number of admins minimal.
- [ ] Scope the `CLOUDFLARE_API_TOKEN` used by CI to Workers Scripts:Edit and D1:Edit on this account only; protect the `production` GitHub Environment with required reviewers.
- [ ] Add a Cloudflare WAF / rate-limiting rule in front of `/api/v1/licenses/*` and `/api/v1/auth/*` (D1 counters are a second layer, not DDoS protection).
- [ ] Enable D1 Time Travel awareness and a scheduled export (see BACKUP_RECOVERY.md).
- [ ] Review `docs/PRIVACY_AND_DATA_RETENTION.md` with a lawyer before collecting customer data.

Ongoing:

- [ ] Review `license_events` for `user.locked`, `activation.failed` bursts, `payment.rejected` and unexpected admin actions.
- [ ] Rotate the lease signing key yearly or on suspicion (procedure in DEPLOYMENT.md).
- [ ] Keep dependencies updated; run `pnpm audit` before releases.

## Known limitations

1. **The EA client is not tamper-proof.** Anyone who controls the computer running MetaTrader can patch or decompile an `.ex4/.ex5` and remove the license check. Licensing raises the cost of misuse and gives server-side control (suspend, revoke, quotas, audit); it cannot prevent a determined local attacker. Keep valuable strategy logic out of reach where possible.
2. **The MQL example does not verify the Ed25519 lease signature.** MQL4/MQL5 have no native Ed25519 and DLLs are excluded by design. The example trusts the TLS channel to the license server (WebRequest validates certificates) and treats the lease as an opaque token for `refresh`. A future pure-MQL Ed25519 verifier would close the "fake local server + patched hosts file" path; it must be tested and reviewed before use.
3. **Offline grace allows up to the lease lifetime (default 24 h, client cap 7 days) of continued new entries** after a revocation if the EA cannot reach the server. This is the deliberate trade-off that keeps network failures from looking like revocations.
4. **Device and installation ids are client-generated random ids**, not hardware fingerprints. A user can copy the id file to another machine; quotas limit how many concurrent ids exist, not where they run.
5. **Rate limiting is D1-based** (fixed windows, eventually consistent across colos). It is not DDoS protection; use Cloudflare WAF / Rate Limiting rules in production.
6. **PBKDF2 at 100k iterations** is below current OWASP guidance for PBKDF2-SHA256 (600k) because Workers caps iterations at 100k. Argon2id/scrypt are not available natively. Lockout and rate limits compensate; revisit when the platform allows more.
7. **No email delivery** is configured, so there is no self-service password reset or email verification. Admins reset access manually. Add an email provider before opening registration publicly.
8. **No live payment provider** is implemented. The mock provider must never be enabled in production (the code refuses it). A real adapter needs the provider's official signature scheme, a security review and end-to-end tests in staging.
9. **Audit events are append-only in the database** but an attacker with Cloudflare account access could still drop the table. Export audit data off-platform if you need stronger guarantees.
10. **Admin data exports** are not implemented (by design, to limit bulk data exposure). If added, restrict them to MFA-verified admins and audit each export.
11. **The MQL code has not been compiled in MetaEditor in this environment.** Compile, run on a demo account and complete the checklist in EA_INTEGRATION_TH.md before distributing.
