-- MANUAL rollback for 0001_initial_schema.sql. DESTROYS ALL DATA.
-- D1 has no automatic down-migrations. Prefer D1 Time Travel restore
-- (see docs/BACKUP_RECOVERY.md). Use this only on a development database.
DROP TABLE IF EXISTS request_nonces;
DROP TABLE IF EXISTS api_rate_limits;
DROP TRIGGER IF EXISTS license_events_no_update;
DROP TABLE IF EXISTS license_events;
DROP TABLE IF EXISTS payment_events;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS activations;
DROP TRIGGER IF EXISTS licenses_revoked_is_terminal;
DROP TRIGGER IF EXISTS licenses_lifetime_only_update;
DROP TRIGGER IF EXISTS licenses_lifetime_only_insert;
DROP TABLE IF EXISTS licenses;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS users;
DELETE FROM d1_migrations WHERE name = '0001_initial_schema.sql';
