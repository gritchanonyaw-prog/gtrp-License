import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://api.test${path}`, init));

describe("health endpoint", () => {
  it("reports ok with database check", async () => {
    const res = await call("/api/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", environment: "test", checks: { database: "ok" }, protocol_versions: [1] });
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("publishes only the public lease key", async () => {
    const res = await call("/api/v1/lease/public-keys");
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("returns a uniform JSON 404 for unknown endpoints", async () => {
    const res = await call("/api/v1/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.request_id).toBe(res.headers.get("X-Request-Id"));
  });
});
