import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../src/App";
import { AuthProvider } from "../src/hooks/useAuth";
import { ADMIN, meOk, mockApi } from "./mockApi";

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const LICENSE_ID = "22222222-2222-4222-8222-222222222222";
const license = {
  id: LICENSE_ID,
  status: "active",
  effective_status: "active",
  in_grace: false,
  key_hint: "GTRP-****-****-****-AB12",
  plan: { id: "p1", code: "QUANT_PRO", name: "Quant Pro" },
  starts_at: "2026-10-01T00:00:00.000Z",
  expires_at: "2026-11-01T00:00:00.000Z",
  grace_until: "2026-11-04T00:00:00.000Z",
  entitlements: { web_access: true, features: ["smc"], ea_products: ["gtrp_ea"], ea_platforms: ["mt5"], require_account_binding: false },
  usage: { web: { used: 1, max: 2 }, ea: { used: 0, max: 1 }, trading_accounts: { used: 0, max: 1 } },
  created_at: "2026-10-01T00:00:00.000Z",
  note: null,
  user: { id: "u1", email: "cust@gtrp.test", status: "active" },
};
const emptyPage = { data: [], pagination: { page: 1, page_size: 20, total: 0 } };

describe("route guard (usability only)", () => {
  it("sends unauthenticated users to the login page", async () => {
    mockApi({ "GET /api/v1/me": () => ({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "Authentication is required.", request_id: "r" } } }) });
    renderAt("/licenses");
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("blocks non-admin users", async () => {
    mockApi({ "GET /api/v1/me": () => ({ json: { user: { ...ADMIN, role: "customer" }, session: { expires_at: "2099-01-01T00:00:00Z", mfa_verified: false } } }) });
    renderAt("/");
    expect(await screen.findByText(/administrators only/i)).toBeTruthy();
  });

  it("asks admins without MFA to enroll", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ json: { user: { ...ADMIN, mfa_enabled: false }, session: { expires_at: "2099-01-01T00:00:00Z", mfa_verified: false } } }),
      "GET /api/v1/health": () => ({ json: { environment: "production" } }),
    });
    renderAt("/");
    expect(await screen.findByText(/Set up two-factor authentication/)).toBeTruthy();
    expect(screen.queryByText(/Skip for now/)).toBeNull();
  });
});

describe("login", () => {
  it("asks for the TOTP code when the server requires MFA", async () => {
    let loggedIn = false;
    const { calls } = mockApi({
      "GET /api/v1/me": () => (loggedIn ? meOk() : { status: 401, json: { error: { code: "UNAUTHENTICATED", message: "x", request_id: "r" } } }),
      "POST /api/v1/auth/login": (body) => {
        if (!(body as { totp_code?: string }).totp_code) return { status: 401, json: { error: { code: "MFA_REQUIRED", message: "Enter code", request_id: "r" } } };
        loggedIn = true;
        return meOk();
      },
      "GET /api/v1/admin/metrics": () => ({ json: { generated_at: "2026-10-25T00:00:00Z", total_customers: 7, active_licenses: 5, expired_licenses: 1, suspended_licenses: 1, revoked_licenses: 0, expiring_within_7_days: 2, activation_failures_24h: 3, active_activations: { web: 4, mt4: 1, mt5: 2 }, recent_activation_failures: [] } }),
    });
    const user = userEvent.setup();
    renderAt("/login");
    await user.type(await screen.findByLabelText("Email"), "admin@gtrp.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const code = await screen.findByLabelText(/Authentication code/);
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Total customers")).toBeTruthy();
    // Overview shows figures from the API, not hardcoded values.
    expect(screen.getByText("7")).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/v1/auth/login").at(-1)!.body).toMatchObject({ totp_code: "123456" });
  });

  it("shows a safe error for invalid credentials", async () => {
    mockApi({
      "GET /api/v1/me": () => ({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "x", request_id: "r" } } }),
      "POST /api/v1/auth/login": () => ({ status: 401, json: { error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect.", request_id: "r" } } }),
    });
    const user = userEvent.setup();
    renderAt("/login");
    await user.type(await screen.findByLabelText("Email"), "x@y.co");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Email or password is incorrect.");
  });
});

describe("licenses list", () => {
  it("renders rows from the API and paginates", async () => {
    const rows = (page: number) => ({
      data: [{ id: LICENSE_ID, user_id: "u1", email: `page${page}@gtrp.test`, plan_id: "p1", plan_code: "QUANT_PRO", plan_name: "Quant Pro", status: "active", key_hint: "AB12", starts_at: license.starts_at, expires_at: license.expires_at, grace_until: null, created_at: license.created_at }],
      pagination: { page, page_size: 25, total: 60 },
    });
    const { calls } = mockApi({
      "GET /api/v1/me": meOk,
      "GET /api/v1/admin/plans": () => ({ json: { data: [] } }),
      "GET /api/v1/admin/licenses": (_b, url) => ({ json: rows(Number(url.searchParams.get("page") ?? 1)) }),
    });
    const user = userEvent.setup();
    renderAt("/licenses");
    expect(await screen.findByText("page1@gtrp.test")).toBeTruthy();
    expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("page2@gtrp.test")).toBeTruthy();
    expect(calls.filter((c) => c.path === "/api/v1/admin/licenses").at(-1)!.url.searchParams.get("page")).toBe("2");
  });

  it("shows empty and error states", async () => {
    let fail = true;
    mockApi({
      "GET /api/v1/me": meOk,
      "GET /api/v1/admin/plans": () => ({ json: { data: [] } }),
      "GET /api/v1/admin/licenses": () => (fail ? { status: 500, json: { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", request_id: "rid-9" } } } : { json: { data: [], pagination: { page: 1, page_size: 25, total: 0 } } }),
    });
    const user = userEvent.setup();
    renderAt("/licenses");
    expect(await screen.findByText("An unexpected error occurred.")).toBeTruthy();
    expect(screen.getByText(/rid-9/)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No licenses match/)).toBeTruthy();
  });
});

describe("destructive actions require confirmation", () => {
  it("suspends only after the operator confirms with a reason", async () => {
    const { calls } = mockApi({
      "GET /api/v1/me": meOk,
      [`GET /api/v1/admin/licenses/${LICENSE_ID}`]: () => ({ json: { license, activations: [] } }),
      [`GET /api/v1/admin/licenses/${LICENSE_ID}/events`]: () => ({ json: emptyPage }),
      [`POST /api/v1/admin/licenses/${LICENSE_ID}/suspend`]: () => ({ json: { license: { ...license, status: "suspended" } } }),
    });
    const user = userEvent.setup();
    renderAt(`/licenses/${LICENSE_ID}`);
    await user.click(await screen.findByRole("button", { name: "Suspend" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Suspend" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.type(within(dialog).getByLabelText(/Reason/), "chargeback review");
    await user.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/suspend"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/suspend"))!.body).toEqual({ reason: "chargeback review" });
  });

  it("cancel does not call the API; API errors are shown in the dialog", async () => {
    const { calls } = mockApi({
      "GET /api/v1/me": meOk,
      [`GET /api/v1/admin/licenses/${LICENSE_ID}`]: () => ({ json: { license, activations: [] } }),
      [`GET /api/v1/admin/licenses/${LICENSE_ID}/events`]: () => ({ json: emptyPage }),
      [`POST /api/v1/admin/licenses/${LICENSE_ID}/revoke`]: () => ({ status: 409, json: { error: { code: "CONFLICT", message: "The resource was modified concurrently. Reload and try again.", request_id: "r" } } }),
    });
    const user = userEvent.setup();
    renderAt(`/licenses/${LICENSE_ID}`);
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Reason/), "fraud");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("modified concurrently");
  });

  it("shows only actions allowed by the state machine", async () => {
    mockApi({
      "GET /api/v1/me": meOk,
      [`GET /api/v1/admin/licenses/${LICENSE_ID}`]: () => ({ json: { license: { ...license, status: "revoked", effective_status: "revoked" }, activations: [] } }),
      [`GET /api/v1/admin/licenses/${LICENSE_ID}/events`]: () => ({ json: emptyPage }),
    });
    renderAt(`/licenses/${LICENSE_ID}`);
    await screen.findByText(/Quant Pro license/);
    for (const name of ["Reactivate", "Suspend", "Revoke", "Renew", "Reissue key"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
});
