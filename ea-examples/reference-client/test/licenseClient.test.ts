import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchTransport } from "../src/fetchTransport.js";
import { LicenseClient } from "../src/licenseClient.js";
import { MockLicenseApi } from "./mockLicenseApi.js";

let api: MockLicenseApi;
let nowMs = Date.now();
const clock = () => nowMs;

function client(extra: Record<string, unknown> = {}) {
  return new LicenseClient(
    {
      baseUrl: api.url,
      licenseKey: "GTRP-AAAA-BBBB-CCCC-DDDD",
      product: "gtrp_ea",
      platform: "mt5",
      activationId: "inst_0123456789abcdef",
      accountRef: "Broker-Live:1001",
      timeoutMs: 300,
      ...extra,
    },
    fetchTransport,
    clock,
  );
}

/** Minimal EA tick loop: position management always runs; entries only when licensed. */
class SimulatedEa {
  managed = 0;
  opened = 0;
  constructor(private readonly lic: LicenseClient) {}
  onTick() {
    if (this.lic.canManagePositions()) this.managed++; // trailing stops, stop-loss, closes
    if (this.lic.canOpenNewPositions()) this.opened++;
  }
}

beforeEach(async () => {
  nowMs = Date.now();
  api = new MockLicenseApi();
  await api.start();
});
afterEach(async () => api.stop());

describe("EA license client against the mock License API", () => {
  it("valid response: activates, stores the lease and allows new entries", async () => {
    const c = client();
    await c.start();
    expect(c.state).toBe("valid");
    expect(c.canOpenNewPositions()).toBe(true);
    expect(api.requests[0]!.path).toBe("/api/v1/licenses/activate");
    const sent = api.requests[0]!.body;
    expect(sent).toMatchObject({ protocol_version: 1, product: "gtrp_ea", platform: "mt5", activation_id: "inst_0123456789abcdef" });
    expect(sent).not.toHaveProperty("account_ref");
    expect(sent.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(sent)).not.toMatch(/password/i);
  });

  it("revalidates with the lease (refresh), not the key, when due", async () => {
    const c = client();
    await c.start();
    nowMs += 1801_000;
    await c.onTimer();
    expect(api.requests.at(-1)!.path).toBe("/api/v1/licenses/refresh");
    expect(api.requests.at(-1)!.body).not.toHaveProperty("license_key");
  });

  it("timeout: is transient, keeps trading inside the offline grace window", async () => {
    const c = client();
    await c.start();
    api.mode = "timeout";
    nowMs += 1801_000;
    await c.onTimer();
    expect(c.state).toBe("offline_grace");
    expect(c.lastCode).toBe("NETWORK");
    expect(c.canOpenNewPositions()).toBe(true);
  });

  it("offline grace is bounded by the lease: after it, new entries stop but management continues", async () => {
    const c = client();
    await c.start();
    const ea = new SimulatedEa(c);
    api.mode = "server_error";
    nowMs += 3599_000;
    await c.onTimer();
    ea.onTick();
    expect(ea.opened).toBe(1);
    nowMs += 2_000; // past offline_grace_until
    await c.onTimer();
    ea.onTick();
    expect(c.state).toBe("lapsed");
    expect(ea.opened).toBe(1);
    expect(ea.managed).toBe(2);
  });

  it("confirmed revocation: stops new entries immediately, keeps position management", async () => {
    const c = client();
    await c.start();
    const ea = new SimulatedEa(c);
    api.mode = "revoked";
    nowMs += 1801_000;
    await c.onTimer(); // refresh -> 403 LICENSE_REVOKED
    ea.onTick();
    expect(c.state).toBe("denied");
    expect(c.lastCode).toBe("LICENSE_REVOKED");
    expect(c.leaseToken).toBeNull();
    expect(ea.opened).toBe(0);
    expect(ea.managed).toBe(1);
  });

  it("recovers automatically when an admin reactivates a suspended license", async () => {
    const c = client({ deniedRetrySeconds: 60 });
    api.mode = "suspended";
    await c.start();
    expect(c.state).toBe("denied");
    api.mode = "ok";
    nowMs += 61_000;
    await c.onTimer();
    expect(c.state).toBe("valid");
  });

  it("server errors, 429 and malformed responses are never treated as a revocation", async () => {
    for (const mode of ["server_error", "rate_limited", "html", "malformed_ok", "wrong_request_id"] as const) {
      const c = client();
      await c.start();
      api.mode = mode;
      nowMs += 1801_000;
      await c.onTimer();
      expect(c.state, mode).toBe("offline_grace");
      expect(c.canOpenNewPositions(), mode).toBe(true);
      api.mode = "ok";
    }
  });

  it("first start without the server never allows new entries", async () => {
    api.mode = "timeout";
    const c = client();
    await c.start();
    expect(c.state).toBe("unknown");
    expect(c.canOpenNewPositions()).toBe(false);
    expect(c.canManagePositions()).toBe(true);
  });

  it("backs off exponentially on repeated transient failures", async () => {
    const c = client({ transientRetrySeconds: 10, maxBackoffSeconds: 40 });
    await c.start();
    api.mode = "server_error";
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      nowMs = Math.max(nowMs, c.nextCheckAtMs);
      await c.check();
      delays.push((c.nextCheckAtMs - nowMs) / 1000);
    }
    expect(delays).toEqual([10, 20, 40, 40]);
  });

  it("corrects clock skew from server_time and retries once", async () => {
    api.mode = "clock_skew_once";
    api.serverTimeOffsetMs = 3600_000;
    const c = client();
    await c.start();
    expect(c.state).toBe("valid");
    expect(Math.abs(c.clockOffsetMs - 3600_000)).toBeLessThan(5_000);
    const second = api.requests[1]!.body;
    expect(Math.abs(Date.parse(second.client_time) - (Date.now() + 3600_000))).toBeLessThan(5_000);
  });

  it("sends the trading account only when the plan requires it", async () => {
    api.mode = "account_required";
    const c = client();
    await c.start();
    expect(api.requests[0]!.body).not.toHaveProperty("account_ref");
    expect(api.requests[1]!.body.account_ref).toBe("Broker-Live:1001");
    expect(c.state).toBe("valid");
  });

  it("falls back from an invalid lease to key validation", async () => {
    const c = client();
    await c.start();
    api.mode = "lease_invalid";
    nowMs += 1801_000;
    await c.onTimer();
    expect(api.requests.slice(-2).map((r) => r.path)).toEqual(["/api/v1/licenses/refresh", "/api/v1/licenses/validate"]);
    expect(c.state).toBe("valid");
  });

  it("re-activates when the server no longer knows the installation", async () => {
    const c = client();
    await c.start();
    c.leaseToken = null;
    api.mode = "not_found_then_ok";
    await c.check();
    expect(api.requests.slice(-2).map((r) => r.path)).toEqual(["/api/v1/licenses/validate", "/api/v1/licenses/activate"]);
    expect(c.state).toBe("valid");
  });

  it("caps an unreasonably long offline grace from a response", async () => {
    api.graceSeconds = 365 * 86400;
    const c = client();
    await c.start();
    expect(c.offlineGraceUntilMs - c.serverNow()).toBeLessThanOrEqual(7 * 86400_000 + 1000);
  });

  it("deactivates the installation", async () => {
    const c = client();
    await c.start();
    expect(await c.deactivate()).toBe(true);
    expect(c.canOpenNewPositions()).toBe(false);
  });
});
