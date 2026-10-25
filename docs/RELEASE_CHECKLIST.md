# Release checklist (V1.0)

Tick every item for each release. "Evidence" says where the item is verified automatically; items without automated evidence need a person.

## 1. Code and tests

- [ ] `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` green locally and in CI
- [ ] `pnpm --filter @gtrp/admin build && pnpm --filter @gtrp/api build` succeed
- [ ] CI secret scan passes (no `.dev.vars`, `.env`, keys or private JWKs tracked)
- [ ] `pnpm audit --prod` reviewed; no unaddressed high/critical issues
- [ ] New migrations are additive and were applied to a clean database by the test suite
- [ ] CHANGELOG / release notes written

## 2. Staging verification

- [ ] Deployed to staging with `deploy.yml` (or the manual steps in DEPLOYMENT.md)
- [ ] `/api/v1/health` → `ok` with `database: ok`, `config: ok`
- [ ] Admin login with MFA; customer account gets 403 on `/api/v1/admin/*`
- [ ] Create plan → create license → key shown once → customer sees the license in `/me/licenses`
- [ ] MT5 **and** MT4 demo account: compile the example EA in MetaEditor, add the server URL to *Allow WebRequest*, activate, refresh after `revalidate_after_seconds`
- [ ] Suspend → EA stops new entries on its next check, keeps managing positions; reactivate → resumes
- [ ] Disconnect network on the EA machine → keeps working until `offline_grace_until`, then stops new entries only
- [ ] Web App: feature access 200 when entitled, 403 after suspension / plan downgrade / feature removed
- [ ] Mock payment (staging only): checkout → signed webhook → license; redelivery → `duplicate`; refund → license suspended
- [ ] Cron run visible in logs (`maintenance_completed`)

## 3. Production readiness

- [ ] Security checklist in SECURITY.md completed (fresh secrets, offline backup of pepper and MFA key, origins, MFA, WAF rules, scoped API token, protected GitHub environment)
- [ ] `PAYMENTS_MOCK_ENABLED = "false"` in production; no `MOCK_PAYMENT_WEBHOOK_SECRET` set in production
- [ ] Custom domain bound, `workers_dev = false`, HTTPS only
- [ ] D1 Time Travel bookmark noted and a fresh export stored off-platform before migrating
- [ ] Privacy notice reviewed by a lawyer and published; retention periods decided (PRIVACY_AND_DATA_RETENTION.md Part C)
- [ ] Support contact and incident owner named
- [ ] Rollback rehearsed on staging (`wrangler rollback`)

## 4. After deploy

- [ ] Health check green on the production domain
- [ ] One real end-to-end license on an internal account (Web + EA), then revoke it
- [ ] Error rate and logs watched for 24 hours
- [ ] Release tagged in Git

## Acceptance criteria traceability

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Migrations run on a clean dev DB | `apps/api/test/migrations.test.ts`; `pnpm db:migrate:local` |
| 2 | Admin creates plans and licenses | `admin.test.ts` (plans administration, lifecycle); dashboard UI tests |
| 3 | Customer views own license | `licenses.test.ts` › customer license access |
| 4 | One license authorizes Web App and EA per plan | `licenses.test.ts` › one license for Web App and EA; `webapp.test.ts` |
| 5 | Quotas under concurrency | `licenses.test.ts` › enforces quotas under concurrent activation requests |
| 6 | Suspended / expired / revoked enforced server-side | `licenses.test.ts`, `webapp.test.ts` |
| 7 | Customer cannot access another customer's data | `licenses.test.ts`, `payments.test.ts` › own payments only |
| 8 | Admin endpoints reject non-admins | `auth.test.ts` › authorization |
| 9 | Audit events for sensitive changes | `admin.test.ts` (every lifecycle change), `payments.test.ts`, `licenses.test.ts` › records activation and failure events |
| 10 | Duplicate webhooks cannot create duplicate renewals | `payments.test.ts` › duplicate and concurrent tests |
| 11 | EA docs contain exact request/response schema | `docs/EA_INTEGRATION_TH.md`, `docs/API.md` |
| 12 | EA example handles API failures safely | `ea-examples/reference-client/test/licenseClient.test.ts`; `ea-conformance.test.ts`; manual MetaTrader demo check (§2) |
| 13 | Secrets not committed | `.gitignore`; CI secret scan |
| 14 | Tests run in CI | `.github/workflows/ci.yml` |
| 15 | Production deployment instructions | `docs/DEPLOYMENT.md` |
| 16 | No live payment provider or credential fabricated | `services/payments/provider.ts` registers only the mock; production refuses it (tested) |
| 17 | Known security limitations documented | `docs/SECURITY.md` › Known limitations |

## Known limitations and follow-up tasks

Limitations are listed in [SECURITY.md](SECURITY.md#known-limitations). Recommended follow-ups, roughly by priority:

1. Compile and run the MT4/MT5 examples in MetaEditor on demo accounts (not possible in the build environment).
2. Integrate a real payment provider adapter (signature scheme, refunds, reconciliation), with staging tests.
3. Add an email provider: password reset, email verification, expiry reminders, key delivery.
4. Customer self-service pages in the Web App (licenses, devices, payments, key reveal) using the existing `/me/*` endpoints.
5. Cloudflare WAF / Rate Limiting rules as code; alerting on 5xx and on `payment.rejected`.
6. Retention purges for audit/payment data once the legal review sets periods.
7. Evaluate a pure-MQL Ed25519 verifier so the EA can verify leases offline.
8. QR code rendering for MFA enrollment (currently secret / otpauth link).
9. Optional admin roles (support vs. owner) if more than a few admins are needed.
