import { LicenseClient, type Transport } from "@gtrp/ea-reference-client";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "../src/clock.js";
import { ENT_AUTO, call, resetDb, world } from "./helpers.js";

beforeEach(resetDb);

/** Runs the reference EA client (the same logic as the MQL include) against the real Worker. */
const workerTransport: Transport = async (url, body) => {
  const res = await exports.default.fetch(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" }, body }));
  return { status: res.status, body: await res.text() };
};

function eaClient(key: string, activationId = "mt5_inst_0123456789ab") {
  return new LicenseClient(
    { baseUrl: "https://api.test", licenseKey: key, product: "gtrp_ea", platform: "mt5", activationId, accountRef: "Broker-Live:5550001", label: "VPS-1" },
    workerTransport,
    () => clock.nowMs(),
  );
}

describe("EA protocol conformance (reference client <-> real API)", () => {
  it("activates, refreshes on schedule, and is denied after suspension", async () => {
    const w = await world();
    const c = eaClient(w.key);
    await c.start();
    expect(c.state).toBe("valid");
    expect(c.canOpenNewPositions()).toBe(true);
    const base = Date.now();
    clock.nowMs = () => base + 1801_000;
    await c.onTimer();
    expect(c.state).toBe("valid");
    await call(`/api/v1/admin/licenses/${w.licenseId}/suspend`, { cookie: w.admin, json: { reason: "conformance" } });
    clock.nowMs = () => base + 3700_000;
    await c.onTimer();
    expect(c.state).toBe("denied");
    expect(c.lastCode).toBe("LICENSE_SUSPENDED");
    expect(c.canOpenNewPositions()).toBe(false);
    expect(c.canManagePositions()).toBe(true);
  });

  it("discovers account binding from the server and sends the account reference", async () => {
    const w = await world({ entitlements: ENT_AUTO });
    const c = eaClient(w.key);
    await c.start();
    expect(c.state).toBe("valid");
    expect(c.requireAccountBinding).toBe(true);
  });

  it("enforces the activation quota for a second installation", async () => {
    const w = await world({ max_ea_activations: 1 });
    await eaClient(w.key, "mt5_inst_aaaaaaaaaaaa").start();
    const second = eaClient(w.key, "mt5_inst_bbbbbbbbbbbb");
    await second.start();
    expect(second.state).toBe("denied");
    expect(second.lastCode).toBe("ACTIVATION_LIMIT_REACHED");
  });

  it("deactivation frees the slot for another installation", async () => {
    const w = await world({ max_ea_activations: 1 });
    const first = eaClient(w.key, "mt5_inst_aaaaaaaaaaaa");
    await first.start();
    expect(await first.deactivate()).toBe(true);
    const second = eaClient(w.key, "mt5_inst_bbbbbbbbbbbb");
    await second.start();
    expect(second.state).toBe("valid");
  });
});
