import { describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/services/api";
import { mockApi } from "./mockApi";

describe("api client", () => {
  it("turns the error envelope into ApiError with code, message and request id", async () => {
    mockApi({
      "GET /api/v1/admin/licenses": () => ({ status: 400, json: { error: { code: "VALIDATION_FAILED", message: "The request is invalid.", request_id: "abc", details: [{ path: "page", message: "too big" }] } } }),
    });
    const e = (await api.licenses({ page: 99999 }).catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 400, code: "VALIDATION_FAILED", requestId: "abc" });
    expect(e.details[0]!.path).toBe("page");
  });

  it("reports network failures without crashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const e = (await api.metrics().catch((x) => x)) as ApiError;
    expect(e.code).toBe("NETWORK_ERROR");
  });

  it("sends JSON with same-origin credentials and never puts secrets in the URL", async () => {
    const { calls, fn } = mockApi({ "POST /api/v1/auth/login": () => ({ json: { user: {}, session: {} } }) });
    await api.login("a@b.co", "pw-123456789");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.body).toEqual({ email: "a@b.co", password: "pw-123456789" });
    expect((fn.mock.calls[0]![1] as RequestInit).credentials).toBe("same-origin");
  });
});
