import { vi } from "vitest";

export type Handler = (body: unknown, url: URL) => { status?: number; json?: unknown } | undefined;

/**
 * Minimal fetch mock: keys are "METHOD /api/v1/path" (query string ignored).
 * Records every call so tests can assert what was sent.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; url: URL; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, url, body });
    const h = routes[`${method} ${url.pathname}`];
    const r = h?.(body, url) ?? { status: 404, json: { error: { code: "NOT_FOUND", message: "not mocked", request_id: "test" } } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.json ?? {}), { status, headers: { "Content-Type": "application/json", "X-Request-Id": "rid-1" } });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

export const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "admin@gtrp.test", role: "admin", status: "active", mfa_enabled: true, created_at: "2026-10-01T00:00:00.000Z" };

export const meOk = () => ({ json: { user: ADMIN, session: { expires_at: "2099-01-01T00:00:00.000Z", mfa_verified: true } } });
