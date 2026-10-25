# Backup, restore, migrations and rollback

All persistent state is in one D1 database per environment, plus the Worker secrets. Both must be recoverable.

## What to back up

| Item | How | Frequency |
| --- | --- | --- |
| D1 database | **Time Travel** (automatic, point-in-time restore within the plan's retention window, 30 days on Workers Paid) | continuous |
| D1 database | `wrangler d1 export` to an encrypted off-platform store | daily (scheduled job) and before every migration |
| `LICENSE_KEY_PEPPER`, `MFA_ENCRYPTION_KEY` | encrypted offline copy (password manager vault or hardware-backed store), two custodians | at creation / rotation |
| `LEASE_SIGNING_PRIVATE_JWK` | optional: can be regenerated (clients re-validate), but keep a copy to avoid a forced re-validation wave | at creation / rotation |
| Code and migrations | Git | every change |

Secrets cannot be read back from Cloudflare. **If the pepper is lost, every license key, device hash and account hash becomes unverifiable** and all keys must be reissued.

## D1 Time Travel

```bash
cd apps/api
# Before any risky change, note the current bookmark
npx wrangler d1 time-travel info gtrp-license-production --env production

# Restore to a bookmark or timestamp (overwrites the current database state)
npx wrangler d1 time-travel restore gtrp-license-production --env production --bookmark <bookmark>
npx wrangler d1 time-travel restore gtrp-license-production --env production --timestamp 2026-10-25T03:00:00Z
```

A restore is destructive for everything written after the target point (new activations, payments, audit events). Put the system in maintenance (or accept the loss), restore, then reconcile payments with the provider's dashboard.

## Exports

```bash
cd apps/api
npx wrangler d1 export gtrp-license-production --remote --env production --output ../../exports/gtrp-$(date -u +%Y%m%dT%H%M%SZ).sql
```

`exports/` is git-ignored. Exports contain personal data (emails) and hashed secrets: encrypt them at rest (e.g. `age` or `gpg`), store them outside Cloudflare, restrict access to the operators listed in your data-processing records, and delete them according to the retention policy in PRIVACY_AND_DATA_RETENTION.md.

Restore an export into a **new** database (never over production without a Time Travel bookmark):

```bash
npx wrangler d1 create gtrp-license-restore-test
npx wrangler d1 execute gtrp-license-restore-test --remote --file ../../exports/<file>.sql
```

Test a restore into a scratch database at least once per quarter and after schema changes.

## Migrations

* Files: `migrations/NNNN_description.sql`, applied in order by `wrangler d1 migrations apply`. Applied migrations are tracked in the `d1_migrations` table.
* Rules: forward-only, additive (add tables/columns/indexes; do not rename or drop in the same release as code that stops using them), so the previous Worker version keeps working during a code rollback.
* Every migration is exercised by the test suite (`apps/api/test/setup.ts` applies all migrations to a clean database before tests; `migrations.test.ts` checks constraints).

Procedure:

```bash
cd apps/api
npx wrangler d1 migrations list DB --remote --env production       # what is pending
npx wrangler d1 time-travel info gtrp-license-production --env production   # note bookmark
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler deploy --env production
curl -s https://<host>/api/v1/health
```

## Rollback

**Code only** (most incidents): `npx wrangler deployments list --env production` then `npx wrangler rollback <id> --env production`. Because migrations are additive, the older code still runs.

**Schema**: `migrations/rollback/NNNN_*.down.sql` contain the manual inverse of each migration. They are **not** applied by wrangler and may destroy data (for example `0001` drops every table). Prefer, in order:

1. Roll back code only and leave the additive schema change in place.
2. Write a new forward migration that fixes the problem.
3. Time Travel restore to the bookmark taken before the migration (loses later writes).
4. Run the `.down.sql` manually after a fresh export, then remove the row for that migration from `d1_migrations` so it can be re-applied later.

## Disaster scenarios

| Scenario | Response |
| --- | --- |
| Bad deploy | `wrangler rollback` |
| Bad migration / data corruption | Time Travel restore to pre-change bookmark; reconcile payments |
| Accidental bulk admin change | Find the window in `license_events`, then targeted fix via admin API or Time Travel restore |
| Database deleted | Create a new D1, import latest export, update `database_id`, redeploy; Time Travel does not survive deletion |
| Signing key leaked | Rotate (DEPLOYMENT.md §11) **without** keeping the leaked key in `LEASE_PREVIOUS_PUBLIC_KEYS`; all EAs re-validate with their keys |
| Pepper leaked | Pepper alone does not reveal keys, but rotate: deploy a new pepper and reissue keys to all customers (plan a communication) |
| Cloudflare account compromise | Revoke API tokens, rotate all secrets, restore from off-platform export into a clean account |
