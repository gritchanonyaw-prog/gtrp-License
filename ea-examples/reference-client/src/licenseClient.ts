/**
 * Reference implementation of the GTRP EA license client (protocol v1).
 *
 * This file is the executable specification of the client-side state machine.
 * ea-examples/include/GTRPLicense.mqh implements the same rules in MQL4/MQL5;
 * keep the two in sync. It is deliberately written without libraries so each
 * step maps directly onto MQL.
 *
 * Safety rules:
 *  - Only a well-formed, authoritative denial from the server (CONFIRMED_DENIAL_CODES)
 *    puts the client in the "denied" state.
 *  - Network errors, timeouts, 5xx, 429 and malformed responses are TRANSIENT: the client
 *    keeps its last lease and may continue opening new positions until the lease's
 *    offline_grace_until, then stops opening new positions ("lapsed").
 *  - Position management (modify/close/stop-loss/take-profit) is never blocked by licensing.
 */

export const PROTOCOL_VERSION = 1;

export const CONFIRMED_DENIAL_CODES = [
  "LICENSE_INVALID",
  "LICENSE_NOT_STARTED",
  "LICENSE_NOT_ACTIVE",
  "LICENSE_EXPIRED",
  "LICENSE_SUSPENDED",
  "LICENSE_REVOKED",
  "PRODUCT_NOT_ENTITLED",
  "PLATFORM_NOT_ENTITLED",
  "ACTIVATION_LIMIT_REACHED",
  "ACCOUNT_LIMIT_REACHED",
  "ACCOUNT_REF_REQUIRED",
  "ACCOUNT_MISMATCH",
  "ACTIVATION_NOT_FOUND",
  "ACTIVATION_REVOKED",
] as const;

/** Never trust an offline grace window longer than this, whatever the server response says. */
export const MAX_OFFLINE_GRACE_MS = 7 * 86400_000;

export type LicenseState = "unknown" | "valid" | "offline_grace" | "lapsed" | "denied";

export interface ClientConfig {
  baseUrl: string;
  licenseKey: string;
  product: string;
  platform: "mt4" | "mt5";
  /** Random per-installation id, generated once and stored locally. Not a secret and not a hardware fingerprint. */
  activationId: string;
  /** e.g. "BrokerServer:12345678". Sent only when the plan requires account binding. */
  accountRef: string;
  label?: string;
  timeoutMs?: number;
  /** How often to re-check after a confirmed denial (so an admin reactivation is picked up). */
  deniedRetrySeconds?: number;
  /** First retry delay after a transient failure; doubles up to maxBackoffSeconds. */
  transientRetrySeconds?: number;
  maxBackoffSeconds?: number;
}

export interface TransportResponse {
  status: number;
  body: string;
}

/** Sends a JSON POST. Must reject on network failure or timeout. */
export type Transport = (url: string, jsonBody: string, timeoutMs: number) => Promise<TransportResponse>;

type Outcome =
  | { kind: "ok"; data: OkResponse }
  | { kind: "denied"; code: string; message: string }
  | { kind: "transient"; code: string; serverTime?: string };

interface OkResponse {
  leaseToken: string;
  offlineGraceUntilMs: number;
  revalidateAfterSeconds: number;
  serverTimeMs: number;
  requireAccountBinding: boolean;
  inGrace: boolean;
}

export class LicenseClient {
  state: LicenseState = "unknown";
  lastCode = "";
  lastMessage = "";
  leaseToken: string | null = null;
  offlineGraceUntilMs = 0;
  nextCheckAtMs = 0;
  clockOffsetMs = 0;
  requireAccountBinding = false;
  inGrace = false;
  private backoffSeconds: number;
  private readonly cfg: Required<ClientConfig>;

  constructor(
    cfg: ClientConfig,
    private readonly transport: Transport,
    private readonly now: () => number = () => Date.now(),
    private readonly newRequestId: () => string = () => crypto.randomUUID(),
  ) {
    this.cfg = { label: "", timeoutMs: 5000, deniedRetrySeconds: 900, transientRetrySeconds: 60, maxBackoffSeconds: 900, ...cfg };
    this.backoffSeconds = this.cfg.transientRetrySeconds;
  }

  /** Server-corrected current time. */
  serverNow(): number {
    return this.now() + this.clockOffsetMs;
  }

  /** New entries are allowed only with a lease that has not run out. */
  canOpenNewPositions(): boolean {
    return (this.state === "valid" || this.state === "offline_grace") && this.serverNow() < this.offlineGraceUntilMs;
  }

  /** Licensing never blocks risk management or closing existing positions. */
  canManagePositions(): boolean {
    return true;
  }

  /** Call on EA start. */
  async start(): Promise<void> {
    await this.apply(await this.call("/api/v1/licenses/activate", (rid) => this.activationPayload(rid, true)));
  }

  /** Call from a timer (e.g. every 60 s). Performs a check only when one is due. */
  async onTimer(): Promise<void> {
    if ((this.state === "valid" || this.state === "offline_grace") && this.serverNow() >= this.offlineGraceUntilMs) this.state = "lapsed";
    if (this.now() < this.nextCheckAtMs) return;
    await this.check();
  }

  /** One license check: refresh with the lease if we have one, otherwise validate with the key. */
  async check(): Promise<void> {
    if (this.leaseToken && this.serverNow() < this.offlineGraceUntilMs) {
      const r = await this.call("/api/v1/licenses/refresh", (rid) => ({ ...this.base(rid), lease_token: this.leaseToken, activation_id: this.cfg.activationId }));
      if (r.kind === "transient" && (r.code === "LEASE_INVALID" || r.code === "LEASE_EXPIRED")) {
        this.leaseToken = null;
        return this.check();
      }
      return this.apply(r);
    }
    const v = await this.call("/api/v1/licenses/validate", (rid) => this.activationPayload(rid, false));
    // A missing activation (e.g. an admin reset the slot) is recovered by activating again, subject to quota.
    if (v.kind === "denied" && v.code === "ACTIVATION_NOT_FOUND") return this.start();
    return this.apply(v);
  }

  async deactivate(): Promise<boolean> {
    const r = await this.call("/api/v1/licenses/deactivate", (rid) => ({ ...this.base(rid), license_key: this.cfg.licenseKey, platform: this.cfg.platform, activation_id: this.cfg.activationId }), true);
    if (r.kind === "ok" || (r.kind === "denied" && r.code === "ACTIVATION_NOT_FOUND")) {
      this.state = "unknown";
      this.leaseToken = null;
      this.offlineGraceUntilMs = 0;
      return true;
    }
    return false;
  }

  private base(requestId: string) {
    return { protocol_version: PROTOCOL_VERSION, request_id: requestId, client_time: new Date(this.serverNow()).toISOString() };
  }

  private activationPayload(requestId: string, withLabel: boolean): Record<string, unknown> {
    const p: Record<string, unknown> = {
      ...this.base(requestId),
      license_key: this.cfg.licenseKey,
      product: this.cfg.product,
      platform: this.cfg.platform,
      activation_id: this.cfg.activationId,
    };
    if (this.requireAccountBinding) p.account_ref = this.cfg.accountRef;
    if (withLabel && this.cfg.label) p.label = this.cfg.label;
    return p;
  }

  /**
   * Sends one request, with at most one automatic retry for CLOCK_SKEW (after correcting
   * the clock offset) and one for ACCOUNT_REF_REQUIRED (after enabling account binding).
   */
  private async call(path: string, build: (requestId: string) => Record<string, unknown>, isDeactivate = false): Promise<Outcome> {
    let retried = false;
    for (;;) {
      const requestId = this.newRequestId();
      const r = await this.sendOnce(path, build(requestId), requestId, isDeactivate);
      if (retried) return r;
      if (r.kind === "transient" && r.code === "CLOCK_SKEW" && r.serverTime) {
        const st = Date.parse(r.serverTime);
        if (!Number.isFinite(st)) return r;
        this.clockOffsetMs = st - this.now();
        retried = true;
        continue;
      }
      if (r.kind === "denied" && r.code === "ACCOUNT_REF_REQUIRED" && !this.requireAccountBinding) {
        this.requireAccountBinding = true;
        retried = true;
        continue;
      }
      return r;
    }
  }

  private async sendOnce(path: string, payload: Record<string, unknown>, requestId: string, isDeactivate: boolean): Promise<Outcome> {
    let res: TransportResponse;
    try {
      res = await this.transport(`${this.cfg.baseUrl}${path}`, JSON.stringify(payload), this.cfg.timeoutMs);
    } catch {
      return { kind: "transient", code: "NETWORK" };
    }
    let json: any;
    try {
      json = JSON.parse(res.body);
    } catch {
      return { kind: "transient", code: "MALFORMED" };
    }
    if (json === null || typeof json !== "object") return { kind: "transient", code: "MALFORMED" };

    if (res.status === 200) {
      if (json.protocol_version !== PROTOCOL_VERSION || json.request_id !== requestId) return { kind: "transient", code: "MALFORMED" };
      if (isDeactivate) return json.result === "deactivated" ? { kind: "ok", data: null as unknown as OkResponse } : { kind: "transient", code: "MALFORMED" };
      const token = json.lease?.token;
      const grace = Date.parse(json.policy?.offline_grace_until);
      const serverTime = Date.parse(json.server_time);
      const reval = json.policy?.revalidate_after_seconds;
      if (json.result !== "ok" || typeof token !== "string" || !Number.isFinite(grace) || !Number.isFinite(serverTime) || !Number.isInteger(reval) || reval < 30) {
        return { kind: "transient", code: "MALFORMED" };
      }
      return {
        kind: "ok",
        data: {
          leaseToken: token,
          offlineGraceUntilMs: grace,
          revalidateAfterSeconds: reval,
          serverTimeMs: serverTime,
          requireAccountBinding: json.entitlements?.require_account_binding === true,
          inGrace: json.license?.in_grace === true,
        },
      };
    }

    const code = typeof json.error?.code === "string" ? json.error.code : "HTTP_" + res.status;
    const message = typeof json.error?.message === "string" ? json.error.message : "";
    if (res.status >= 400 && res.status < 500 && (CONFIRMED_DENIAL_CODES as readonly string[]).includes(code)) {
      return { kind: "denied", code, message };
    }
    return { kind: "transient", code, ...(typeof json.error?.server_time === "string" ? { serverTime: json.error.server_time } : {}) };
  }

  private apply(r: Outcome): void {
    const now = this.now();
    if (r.kind === "ok") {
      const d = r.data;
      this.clockOffsetMs = d.serverTimeMs - now;
      this.state = "valid";
      this.lastCode = "";
      this.lastMessage = "";
      this.leaseToken = d.leaseToken;
      this.offlineGraceUntilMs = Math.min(d.offlineGraceUntilMs, d.serverTimeMs + MAX_OFFLINE_GRACE_MS);
      this.requireAccountBinding = d.requireAccountBinding;
      this.inGrace = d.inGrace;
      this.backoffSeconds = this.cfg.transientRetrySeconds;
      this.nextCheckAtMs = now + d.revalidateAfterSeconds * 1000;
      return;
    }
    this.lastCode = r.code;
    if (r.kind === "denied") {
      this.state = "denied";
      this.lastMessage = r.message;
      this.leaseToken = null;
      this.offlineGraceUntilMs = 0;
      this.nextCheckAtMs = now + this.cfg.deniedRetrySeconds * 1000;
      return;
    }
    // Transient: keep the last lease. Never treat this as a revocation.
    if (this.state !== "denied") {
      this.state = this.serverNow() < this.offlineGraceUntilMs ? "offline_grace" : this.state === "unknown" ? "unknown" : "lapsed";
    }
    this.nextCheckAtMs = now + this.backoffSeconds * 1000;
    this.backoffSeconds = Math.min(this.backoffSeconds * 2, this.cfg.maxBackoffSeconds);
  }
}
