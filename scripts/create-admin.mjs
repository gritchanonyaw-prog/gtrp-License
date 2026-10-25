#!/usr/bin/env node
// Creates (or promotes) an administrator account.
// Usage:
//   node scripts/create-admin.mjs <email> [--env staging|production] [--local]
// The password is read from the GTRP_ADMIN_PASSWORD environment variable or prompted for,
// never passed on the command line (it would end up in shell history).
// The password hash uses the same PBKDF2-SHA256 format as the Worker.
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
const envIdx = args.indexOf("--env");
const targetEnv = envIdx >= 0 ? args[envIdx + 1] : null;
const local = args.includes("--local") || !targetEnv;

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: node scripts/create-admin.mjs <email> [--env staging|production] [--local]");
  process.exit(1);
}

async function readPassword() {
  if (process.env.GTRP_ADMIN_PASSWORD) return process.env.GTRP_ADMIN_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const pw = await new Promise((res) => rl.question("Admin password (min 12 chars): ", res));
  rl.close();
  return pw;
}

const password = (await readPassword()).normalize("NFKC");
if (password.length < 12) {
  console.error("Password must be at least 12 characters for administrators.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
const passwordHash = `pbkdf2-sha256$100000$${salt.toString("base64")}$${hash.toString("base64")}`;
const now = new Date().toISOString();
const id = randomUUID();
const q = (s) => `'${s.replace(/'/g, "''")}'`;

const sql = `
INSERT INTO users (id, email, password_hash, role, status, created_at, updated_at)
VALUES (${q(id)}, ${q(email)}, ${q(passwordHash)}, 'admin', 'active', ${q(now)}, ${q(now)})
ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = excluded.password_hash, status = 'active', updated_at = excluded.updated_at;
INSERT INTO license_events (id, actor_type, target_user_id, event_type, details_json, created_at)
SELECT ${q(randomUUID())}, 'system', id, 'user.status_changed', '{"to":"admin","via":"create-admin script"}', ${q(now)} FROM users WHERE email = ${q(email)};
`;

const dir = mkdtempSync(join(tmpdir(), "gtrp-admin-"));
const file = join(dir, "admin.sql");
writeFileSync(file, sql, { mode: 0o600 });
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "../apps/api");
try {
  const wranglerArgs = ["wrangler", "d1", "execute", "DB", "--file", file, local ? "--local" : "--remote"];
  if (targetEnv) wranglerArgs.push("--env", targetEnv);
  execFileSync("npx", wranglerArgs, { cwd: apiDir, stdio: "inherit" });
  console.log(`Administrator ${email} is ready. Sign in to the dashboard and enroll MFA.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
