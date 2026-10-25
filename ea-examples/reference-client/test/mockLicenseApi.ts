import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Mode =
  | "ok"
  | "revoked"
  | "suspended"
  | "timeout"
  | "server_error"
  | "rate_limited"
  | "html"
  | "malformed_ok"
  | "wrong_request_id"
  | "clock_skew_once"
  | "account_required"
  | "lease_invalid"
  | "not_found_then_ok";

/**
 * Scriptable mock of the License API (protocol v1) for client tests.
 * It returns responses in the exact documented shapes.
 */
export class MockLicenseApi {
  mode: Mode = "ok";
  requests: { path: string; body: any }[] = [];
  graceSeconds = 3600;
  serverTimeOffsetMs = 0;
  private server!: Server;
  url = "";
  private skewServed = false;
  private notFoundServed = false;

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private send(res: ServerResponse, status: number, body: unknown, raw = false) {
    res.writeHead(status, { "Content-Type": raw ? "text/html" : "application/json" });
    res.end(raw ? String(body) : JSON.stringify(body));
  }

  private error(res: ServerResponse, status: number, code: string, retryable: boolean) {
    this.send(res, status, { error: { code, message: code, request_id: "srv", retryable, server_time: new Date(Date.now() + this.serverTimeOffsetMs).toISOString() } });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    this.requests.push({ path: req.url ?? "", body });
    const now = Date.now() + this.serverTimeOffsetMs;
    switch (this.mode) {
      case "timeout":
        return; // never answer
      case "server_error":
        return this.error(res, 503, "INTERNAL_ERROR", true);
      case "rate_limited":
        return this.error(res, 429, "RATE_LIMITED", true);
      case "html":
        return this.send(res, 200, "<html><body>Captive portal login</body></html>", true);
      case "revoked":
        return this.error(res, 403, "LICENSE_REVOKED", false);
      case "suspended":
        return this.error(res, 403, "LICENSE_SUSPENDED", false);
      case "lease_invalid":
        if (req.url?.endsWith("/refresh")) return this.error(res, 401, "LEASE_INVALID", false);
        break;
      case "clock_skew_once":
        if (!this.skewServed) {
          this.skewServed = true;
          return this.error(res, 400, "CLOCK_SKEW", true);
        }
        break;
      case "account_required":
        if (!body.account_ref) return this.error(res, 403, "ACCOUNT_REF_REQUIRED", false);
        break;
      case "not_found_then_ok":
        if (req.url?.endsWith("/validate") && !this.notFoundServed) {
          this.notFoundServed = true;
          return this.error(res, 404, "ACTIVATION_NOT_FOUND", false);
        }
        break;
    }
    if (req.url?.endsWith("/deactivate")) {
      return this.send(res, 200, { protocol_version: 1, request_id: body.request_id, server_time: new Date(now).toISOString(), result: "deactivated" });
    }
    const grace = new Date(now + this.graceSeconds * 1000).toISOString();
    const ok = {
      protocol_version: 1,
      request_id: this.mode === "wrong_request_id" ? "00000000-0000-4000-8000-000000000000" : body.request_id,
      server_time: new Date(now).toISOString(),
      result: "ok",
      license: { id: "0f8fad5b-d9cb-469f-a165-70867728950e", status: "active", in_grace: false, plan_code: "QUANT_PRO", expires_at: grace, grace_until: grace },
      activation: { id: "5b2a7d4e-3c1b-4a6f-8e9d-1c2b3a4d5e6f", platform: body.platform ?? "mt5", status: "active" },
      entitlements: { web_access: true, features: [], ea_products: ["gtrp_ea"], ea_platforms: ["mt5"], require_account_binding: this.mode === "account_required" },
      lease: { token: `lease-${this.requests.length}`, expires_at: grace },
      policy: { revalidate_after_seconds: 1800, offline_grace_until: grace },
    };
    if (this.mode === "malformed_ok") return this.send(res, 200, { ...ok, lease: null });
    return this.send(res, 200, ok);
  }
}
