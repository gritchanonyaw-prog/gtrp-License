import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../src/App";
import { errorMessage } from "../src/components/States";
import { AuthProvider } from "../src/hooks/useAuth";
import { I18nProvider, setCurrentLang, t } from "../src/i18n";
import { DYNAMIC_KEYS, TH } from "../src/i18n/th";
import { ApiError } from "../src/services/api";
import { meOk, mockApi } from "./mockApi";

const sources = import.meta.glob("../src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Every t("literal") in the source, unescaped the way the JS parser would. */
function literalKeys(): Set<string> {
  const keys = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/(?<![\w.])t\("((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`) as string);
  }
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  it("every UI string has a Thai translation with the same placeholders", () => {
    const keys = [...literalKeys(), ...DYNAMIC_KEYS];
    expect(keys.length).toBeGreaterThan(200);
    const missing = keys.filter((k) => !(k in TH));
    expect(missing).toEqual([]);
    const mismatched = keys.filter((k) => JSON.stringify(placeholders(k)) !== JSON.stringify(placeholders(TH[k]!)));
    expect(mismatched).toEqual([]);
  });

  it("interpolates values and falls back to English for unknown keys", () => {
    setCurrentLang("th");
    expect(t("Page {page} of {pages} · {total} total", { page: 2, pages: 5, total: 120 })).toBe("หน้า 2 จาก 5 · ทั้งหมด 120 รายการ");
    expect(t("Some future string")).toBe("Some future string");
  });

  it("shows Thai messages for known API error codes and the server text otherwise", () => {
    setCurrentLang("th");
    expect(errorMessage(new ApiError(409, "CONFLICT", "The resource was modified concurrently.", "r"))).toContain("โหลดใหม่");
    expect(errorMessage(new ApiError(400, "SOMETHING_NEW", "Server says no.", "r"))).toBe("Server says no.");
    setCurrentLang("en");
    expect(errorMessage(new ApiError(409, "CONFLICT", "The resource was modified concurrently.", "r"))).toBe("The resource was modified concurrently.");
  });
});

describe("language switcher", () => {
  it("switches the whole dashboard between English and Thai and remembers the choice", async () => {
    mockApi({
      "GET /api/v1/me": () => meOk(),
      "GET /api/v1/admin/metrics": () => ({
        json: { generated_at: "2026-10-25T00:00:00Z", total_customers: 7, active_licenses: 5, expired_licenses: 1, suspended_licenses: 1, revoked_licenses: 0, expiring_within_7_days: 2, activation_failures_24h: 0, active_activations: { web: 4, mt4: 1, mt5: 2 }, recent_activation_failures: [] },
      }),
    });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/"]}>
            <AppRoutes />
          </MemoryRouter>
        </AuthProvider>
      </I18nProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(await screen.findByText("Total customers")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "ไทย" }));
    expect(await screen.findByRole("heading", { name: "ภาพรวม" })).toBeTruthy();
    expect(screen.getByText("ลูกค้าทั้งหมด")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "เมนูหลัก" })).getByRole("link", { name: "บันทึกการตรวจสอบ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ไทย" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.lang).toBe("th");
    expect(localStorage.getItem("gtrp.admin.lang")).toBe("th");

    await user.click(screen.getByRole("button", { name: "EN" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(localStorage.getItem("gtrp.admin.lang")).toBe("en");
  });

  it("is available on the login page", async () => {
    mockApi({ "GET /api/v1/me": () => ({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "x", request_id: "r" } } }) });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/login"]}>
            <AppRoutes />
          </MemoryRouter>
        </AuthProvider>
      </I18nProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "ไทย" }));
    expect(await screen.findByRole("button", { name: "เข้าสู่ระบบ" })).toBeTruthy();
    expect(screen.getByLabelText("รหัสผ่าน")).toBeTruthy();
  });
});
