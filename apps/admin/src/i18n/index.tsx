import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { TH } from "./th";

/**
 * Minimal UI translation. English source strings are the keys; `TH` maps them to Thai.
 * A missing Thai entry falls back to English (test/i18n.test.ts fails if any is missing).
 * Placeholders use {name}.
 */
export type Lang = "en" | "th";
export const LANGS: { code: Lang; label: string }[] = [
  { code: "th", label: "ไทย" },
  { code: "en", label: "EN" },
];
const STORAGE_KEY = "gtrp.admin.lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "th") return saved;
  } catch {
    // storage unavailable (private mode, blocked): fall through
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("th") ? "th" : "en";
}

let current: Lang = initialLang();

export function currentLang(): Lang {
  return current;
}

/** Sets the language used by t() without notifying React. Used by the provider and by test setup. */
export function setCurrentLang(l: Lang): void {
  current = l;
}

/** Locale for dates and numbers. Thai uses the Gregorian calendar so years match the UTC timestamps in logs and the API. */
export function currentLocale(): string | undefined {
  return current === "th" ? "th-TH-u-ca-gregory" : undefined;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = current === "th" ? (TH[key] ?? key) : key;
  return vars ? s.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: typeof t;
}

const I18nContext = createContext<I18nValue>({ lang: current, setLang: () => {}, t });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  const setLang = useCallback((l: Lang) => {
    setCurrentLang(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // not persisted; still switches for this visit
    }
    setLangState(l);
  }, []);
  // A new `t` identity per language makes every component using the hook re-render on switch.
  const value = useMemo(() => ({ lang, setLang, t: (k: string, v?: Record<string, string | number>) => t(k, v) }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function LanguageSwitcher() {
  const { lang, setLang } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t("Language")}>
      {LANGS.map((l) => (
        <button key={l.code} type="button" className={`lang-btn${lang === l.code ? " active" : ""}`} aria-pressed={lang === l.code} lang={l.code} onClick={() => setLang(l.code)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}
