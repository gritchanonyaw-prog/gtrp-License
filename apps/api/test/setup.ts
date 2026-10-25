import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: applies migrations once per test worker against the isolated local D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
