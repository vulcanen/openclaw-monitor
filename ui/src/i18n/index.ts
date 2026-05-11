import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en } from "./en.js";
import { zh, type StringKey, type Strings } from "./zh.js";

export type Locale = "zh" | "en";

const LOCALE_KEY = "openclaw-monitor:locale";

const TABLES: Record<Locale, Strings> = { zh, en };

export type TranslateFn = (key: StringKey, vars?: Record<string, string | number>) => string;

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TranslateFn;
};

const I18nContext = createContext<Ctx | undefined>(undefined);

function readStoredLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(LOCALE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // localStorage may be unavailable (private browsing etc.)
  }
  return "zh";
}

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale());

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(LOCALE_KEY, l);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const t = useCallback<TranslateFn>(
    (key, vars) => {
      const table = TABLES[locale] ?? TABLES.zh;
      const template = table[key] ?? TABLES.en[key] ?? String(key);
      return format(template, vars);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  // Use createElement instead of JSX so this file stays .ts (no parser change).
  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("I18nProvider must wrap the component tree before useI18n()");
  return ctx;
}

export type { StringKey } from "./zh.js";
