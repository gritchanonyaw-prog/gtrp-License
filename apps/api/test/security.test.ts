import { describe, expect, it, beforeEach, vi } from "vitest";
import { redact, redactString, log } from "../src/security/redact.js";
import { call, createUser, db, eaActivate, loginCookie, PASSWORD, resetDb, world } from "./helpers.js";

beforeEach(resetDb);

const INJECTIONS = ["' OR '1'='1", "'; DROP TABLE users; --", "\" OR 1=1 --", "%' UNION SELECT password_hash FROM users --"];

describe("SQL injection attempts", () => {
  it("are inert in login, search and filters (parameterized queries)", async () => {
    const w = await world();
    for (const inj of INJECTIONS) {
      const l = await call("/api/v1/auth/login", { json: { email: `${inj}@x.test`, password: inj }, ip: `192.0.2.${INJECTIONS.indexOf(inj)}` });
      expect([400, 401]).toContain(l.status);
      const s = await call(`/api/v1/admin/customers?q=${encodeURIComponent(inj)}`, { cookie: w.admin });
      expect(s.status).toBe(200);
      expect(s.body.data).toHaveLength(0);
      const lic = await call(`/api/v1/admin/licenses?email=${encodeURIComponent(inj)}`, { cookie: w.admin });
      expect(lic.status).toBe(200);
      expect(lic.body.data).toHaveLength(0);
      expect((await eaActivate(inj)).body.error.code).toBe("LICENSE_INVALID");
    }
    // LIKE wildcards are escaped, not interpreted.
    expect((await call("/api/v1/admin/customers?q=%25", { cookie: w.admin })).body.data).toHaveLength(0);
    const tables = await db().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'users'").first<{ n: number }>();
    expect(tables!.n).toBe(1);
  });

  it("rejects injection in path ids via validation", async () => {
    const w = await world();
    const r = await call(`/api/v1/admin/licenses/${encodeURIComponent("1' OR '1'='1")}`, { cookie: w.admin });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("input validation and error hygiene", () => {
  it("rejects malformed JSON, oversized bodies and unknown fields with uniform errors", async () => {
    const bad = await call("/api/v1/auth/login", { body: "{not json", headers: { "Content-Type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toHaveProperty("request_id");
    const big = await call("/api/v1/auth/register", { body: JSON.stringify({ email: "a@b.co", password: "x".repeat(70_000) }), headers: { "Content-Type": "application/json" } });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("validation errors never echo submitted values", async () => {
    const r = await call("/api/v1/auth/register", { json: { email: "nope", password: "short-secret" } });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("short-secret");
  });

  it("internal errors return no stack trace or database detail", async () => {
    const w = await world();
    // Break the schema for this test only to force an internal error.
    await db().prepare("ALTER TABLE license_events RENAME TO license_events_tmp").run();
    try {
      const r = await call("/api/v1/admin/events", { cookie: w.admin });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatchObject({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
      expect(r.text).not.toMatch(/sqlite|D1_|no such table|at \w+ \(/i);
    } finally {
      await db().prepare("ALTER TABLE license_events_tmp RENAME TO license_events").run();
    }
  });

  it("sets security headers on API responses", async () => {
    const r = await call("/api/v1/health");
    expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    expect(r.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("secret redaction", () => {
  it("redacts keys, tokens and passwords in logs", () => {
    const key = "GTRP-AB12-CD34-EF56-GH78";
    expect(redactString(`activate ${key}`)).not.toContain("AB12");
    expect(redactString("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [REDACTED]");
    const r = redact({ password: "p", license_key: key, nested: { token: "t", note: `see ${key}` }, list: [{ account_ref: "Broker:1" }] }) as any;
    expect(r).toEqual({ password: "[REDACTED]", license_key: "[REDACTED]", nested: { token: "[REDACTED]", note: "see GTRP-[REDACTED]" }, list: [{ account_ref: "[REDACTED]" }] });
  });

  it("the logger never prints a license key", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("info", "user pasted GTRP-AB12-CD34-EF56-GH78", { license_key: "GTRP-AB12-CD34-EF56-GH78" });
    expect(spy.mock.calls[0]![0]).not.toContain("AB12");
    spy.mockRestore();
  });

  it("no license key, password or session token is stored in plaintext", async () => {
    const w = await world();
    await createUser("x@example.test");
    const cookie = await loginCookie("x@example.test");
    const token = cookie.split("=")[1]!;
    const dump: string[] = [];
    for (const t of ["users", "licenses", "sessions", "license_events", "activations"]) {
      const rows = await db().prepare(`SELECT * FROM ${t}`).all();
      dump.push(JSON.stringify(rows.results));
    }
    const all = dump.join("\n");
    expect(all).not.toContain(w.key);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(token);
  });
});

describe("unauthorized role modification", () => {
  it("admin plan or license endpoints cannot change user roles; customers cannot reach them", async () => {
    const w = await world();
    const cust = await loginCookie("customer@gtrp.test");
    const r = await call(`/api/v1/admin/customers/${w.customerId}/status`, { cookie: cust, json: { status: "active", reason: "make me admin" } });
    expect(r.status).toBe(403);
    const asAdmin = await call(`/api/v1/admin/customers/${w.customerId}/status`, { cookie: w.admin, json: { status: "active", role: "admin", reason: "try role" } });
    expect(asAdmin.status).toBe(400);
    const row = await db().prepare("SELECT role FROM users WHERE id = ?").bind(w.customerId).first<{ role: string }>();
    expect(row!.role).toBe("customer");
  });
});
