import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "../src/clock.js";
import { totpAt } from "../src/security/totp.js";
import { BASE, PASSWORD, call, createUser, db, loginCookie, loginToken, resetDb, sessionCookieFrom } from "./helpers.js";

beforeEach(resetDb);

describe("registration", () => {
  it("registers a customer and never accepts a client-supplied role", async () => {
    const r = await call("/api/v1/auth/register", { json: { email: "New@Example.test", password: PASSWORD } });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: "new@example.test", role: "customer", status: "active" });
    expect(r.body.user).not.toHaveProperty("password_hash");
    const evil = await call("/api/v1/auth/register", { json: { email: "evil@example.test", password: PASSWORD, role: "admin" } });
    expect(evil.status).toBe(400);
    expect(evil.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects duplicate emails and short passwords", async () => {
    await call("/api/v1/auth/register", { json: { email: "a@example.test", password: PASSWORD } });
    const dup = await call("/api/v1/auth/register", { json: { email: "A@example.test", password: PASSWORD } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
    const short = await call("/api/v1/auth/register", { json: { email: "b@example.test", password: "short" } });
    expect(short.status).toBe(400);
  });

  it("stores only a password hash", async () => {
    await call("/api/v1/auth/register", { json: { email: "h@example.test", password: PASSWORD } });
    const row = await db().prepare("SELECT password_hash FROM users WHERE email = 'h@example.test'").first<{ password_hash: string }>();
    expect(row!.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(row!.password_hash).not.toContain(PASSWORD);
  });
});

describe("login and sessions", () => {
  it("valid login sets an HttpOnly SameSite=Strict cookie and /me works", async () => {
    await createUser("c@example.test");
    const r = await call("/api/v1/auth/login", { json: { email: "c@example.test", password: PASSWORD } });
    expect(r.status).toBe(200);
    const set = r.headers.get("Set-Cookie")!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(r.body).not.toHaveProperty("token");
    const me = await call("/api/v1/me", { cookie: sessionCookieFrom(r) });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("c@example.test");
  });

  it("stores only the session token hash", async () => {
    await createUser("c@example.test");
    const token = await loginToken("c@example.test");
    const rows = await db().prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.token_hash).not.toBe(token);
    expect(rows.results[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("invalid login returns a generic error for wrong password and unknown email", async () => {
    await createUser("c@example.test");
    const wrong = await call("/api/v1/auth/login", { json: { email: "c@example.test", password: "wrong-password" } });
    const unknown = await call("/api/v1/auth/login", { json: { email: "nobody@example.test", password: "wrong-password" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it("locks the account after repeated failures", async () => {
    await createUser("c@example.test");
    for (let i = 0; i < 10; i++) await call("/api/v1/auth/login", { json: { email: "c@example.test", password: "nope-nope" }, ip: `198.51.100.${i}` });
    const r = await call("/api/v1/auth/login", { json: { email: "c@example.test", password: PASSWORD }, ip: "198.51.100.200" });
    expect(r.status).toBe(429);
    const ev = await db().prepare("SELECT COUNT(*) AS n FROM license_events WHERE event_type = 'user.locked'").first<{ n: number }>();
    expect(ev!.n).toBe(1);
  });

  it("rate limits login attempts per IP", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call("/api/v1/auth/login", { json: { email: `u${i}@example.test`, password: "whatever1" } })).status;
    expect(last).toBe(429);
  });

  it("rejects an expired session", async () => {
    await createUser("c@example.test");
    const token = await loginToken("c@example.test");
    clock.nowMs = () => Date.now() + 13 * 3600_000;
    const r = await call("/api/v1/me", { bearer: token });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a revoked session after logout", async () => {
    await createUser("c@example.test");
    const cookie = await loginCookie("c@example.test");
    expect((await call("/api/v1/auth/logout", { cookie, method: "POST" })).status).toBe(204);
    expect((await call("/api/v1/me", { cookie })).status).toBe(401);
  });

  it("rotates the session on login (old session presented is revoked)", async () => {
    await createUser("c@example.test");
    const first = await loginCookie("c@example.test");
    const r = await call("/api/v1/auth/login", { cookie: first, json: { email: "c@example.test", password: PASSWORD } });
    const second = sessionCookieFrom(r);
    expect(second).not.toBe(first);
    expect((await call("/api/v1/me", { cookie: first })).status).toBe(401);
    expect((await call("/api/v1/me", { cookie: second })).status).toBe(200);
  });

  it("suspended users lose access immediately", async () => {
    const id = await createUser("c@example.test");
    const token = await loginToken("c@example.test");
    await db().prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(id).run();
    expect((await call("/api/v1/me", { bearer: token })).status).toBe(401);
  });

  it("change password revokes other sessions", async () => {
    await createUser("c@example.test");
    const a = await loginToken("c@example.test");
    const b = await loginToken("c@example.test");
    const r = await call("/api/v1/auth/change-password", { bearer: a, json: { current_password: PASSWORD, new_password: "a brand new password" } });
    expect(r.status).toBe(204);
    expect((await call("/api/v1/me", { bearer: a })).status).toBe(200);
    expect((await call("/api/v1/me", { bearer: b })).status).toBe(401);
  });
});

describe("authorization", () => {
  it("customer attempting admin access gets 403; anonymous gets 401", async () => {
    await createUser("c@example.test");
    const cookie = await loginCookie("c@example.test");
    for (const path of ["/api/v1/admin/metrics", "/api/v1/admin/customers", "/api/v1/admin/licenses", "/api/v1/admin/events", "/api/v1/admin/plans"]) {
      expect((await call(path, { cookie })).status, path).toBe(403);
      expect((await call(path)).status, path).toBe(401);
    }
    const create = await call("/api/v1/admin/plans", { cookie, json: { code: "X" } });
    expect(create.status).toBe(403);
  });

  it("admins cannot use bearer tokens", async () => {
    await createUser("a@example.test", "admin");
    const r = await call("/api/v1/auth/login", { json: { email: "a@example.test", password: PASSWORD, session_mode: "token" } });
    expect(r.status).toBe(403);
  });

  it("there is no endpoint for a customer to change their role", async () => {
    await createUser("c@example.test");
    const cookie = await loginCookie("c@example.test");
    for (const method of ["PATCH", "POST", "PUT"]) {
      const r = await call("/api/v1/me", { cookie, method, body: JSON.stringify({ role: "admin" }), headers: { "Content-Type": "application/json" } });
      expect(r.status).toBe(404);
    }
    const me = await call("/api/v1/me", { cookie });
    expect(me.body.user.role).toBe("customer");
  });
});

describe("CSRF / origin protection", () => {
  it("rejects cookie-authenticated POSTs from a foreign origin or without origin evidence", async () => {
    await createUser("c@example.test");
    const cookie = await loginCookie("c@example.test");
    const foreign = await call("/api/v1/auth/logout", { cookie, method: "POST", origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe("CSRF_REJECTED");
    const noOrigin = await call("/api/v1/auth/logout", { cookie, method: "POST", origin: null });
    expect(noOrigin.status).toBe(403);
    const sameOrigin = await call("/api/v1/auth/logout", { cookie, method: "POST", origin: BASE });
    expect(sameOrigin.status).toBe(204);
  });

  it("allows configured Web App origins with CORS for bearer clients", async () => {
    const r = await call("/api/v1/plans", { headers: { Origin: "https://webapp.test" } });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://webapp.test");
    const evil = await call("/api/v1/plans", { headers: { Origin: "https://evil.example" } });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("admin MFA", () => {
  it("enrolls TOTP, then requires it at login", async () => {
    await createUser("a@example.test", "admin");
    const cookie = await loginCookie("a@example.test");
    const setup = await call("/api/v1/auth/mfa/setup", { cookie, method: "POST" });
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    const stored = await db().prepare("SELECT mfa_secret_enc FROM users WHERE email = 'a@example.test'").first<{ mfa_secret_enc: string }>();
    expect(stored!.mfa_secret_enc).not.toContain(secret);
    const code = await totpAt(secret, Math.floor(Date.now() / 1000));
    expect((await call("/api/v1/auth/mfa/enable", { cookie, json: { totp_code: code } })).status).toBe(200);

    const noCode = await call("/api/v1/auth/login", { json: { email: "a@example.test", password: PASSWORD } });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe("MFA_REQUIRED");
    const bad = await call("/api/v1/auth/login", { json: { email: "a@example.test", password: PASSWORD, totp_code: code === "000000" ? "111111" : "000000" } });
    expect(bad.body.error.code).toBe("MFA_INVALID");
    const ok = await call("/api/v1/auth/login", { json: { email: "a@example.test", password: PASSWORD, totp_code: await totpAt(secret, Math.floor(Date.now() / 1000)) } });
    expect(ok.status).toBe(200);
    expect(ok.body.session.mfa_verified).toBe(true);
  });
});
