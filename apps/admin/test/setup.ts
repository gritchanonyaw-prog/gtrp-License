import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { setCurrentLang } from "../src/i18n";

afterEach(() => {
  cleanup();
  setCurrentLang("en");
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
