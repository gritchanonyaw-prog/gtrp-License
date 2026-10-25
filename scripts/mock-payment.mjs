#!/usr/bin/env node
// DEVELOPMENT ONLY: sends a signed webhook from the mock payment provider to a local API,
// so you can exercise checkout -> paid -> license without a real provider.
// Usage:
//   node scripts/mock-payment.mjs <provider_ref> <amount_minor> [--type succeeded|failed|refunded|chargeback]
//                                 [--currency THB] [--url http://127.0.0.1:8787]
// The secret is read from apps/api/.dev.vars (MOCK_PAYMENT_WEBHOOK_SECRET). Refuses non-local URLs.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const [ref, amount] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const type = opt("type", "succeeded");
const currency = opt("currency", "THB");
const url = new URL(opt("url", "http://127.0.0.1:8787"));

if (!ref || !/^\d+$/.test(amount ?? "") || !["succeeded", "failed", "refunded", "chargeback"].includes(type)) {
  console.error("Usage: node scripts/mock-payment.mjs <provider_ref> <amount_minor> [--type succeeded|failed|refunded|chargeback] [--currency THB] [--url http://127.0.0.1:8787]");
  process.exit(1);
}
if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
  console.error("Refusing to send mock payments to a non-local server.");
  process.exit(1);
}

const devVars = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../apps/api/.dev.vars"), "utf8");
const secret = /^MOCK_PAYMENT_WEBHOOK_SECRET=['"]?([^'"\n]+)/m.exec(devVars)?.[1];
if (!secret) {
  console.error("MOCK_PAYMENT_WEBHOOK_SECRET not found in apps/api/.dev.vars (run pnpm secrets:dev).");
  process.exit(1);
}

const t = Math.floor(Date.now() / 1000);
const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: `payment.${type}`, created: t, data: { provider_ref: ref, amount_minor: Number(amount), currency } });
const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const res = await fetch(new URL("/api/v1/webhooks/payments/mock", url), {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Mock-Signature": `t=${t},v1=${sig}` },
  body,
});
console.log(res.status, await res.text());
