import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * Global rolling-window selector (v0.9.7).
 *
 * Before this, every page picked its own window: Overview hardcoded 1m/5m/15m,
 * Insights had its own select, Costs had today/week/month. Switching one
 * didn't propagate. The TimeWindow context provides a single shared value
 * that pages opt into; URL hash (`#/page?window=15m`) preserves the choice
 * across deep-link shares.
 *
 * Pages that don't subscribe simply ignore the context — no breaking change.
 */
export type TimeWindow = "1m" | "5m" | "15m" | "1h" | "6h" | "24h";

const ALL_WINDOWS: readonly TimeWindow[] = ["1m", "5m", "15m", "1h", "6h", "24h"];

const isTimeWindow = (value: unknown): value is TimeWindow =>
  typeof value === "string" && (ALL_WINDOWS as readonly string[]).includes(value);

export const WINDOW_TO_SECONDS: Record<TimeWindow, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
};

const DEFAULT_WINDOW: TimeWindow = "15m";
const QUERY_KEY = "window";

type TimeWindowContextValue = {
  window: TimeWindow;
  setWindow: (next: TimeWindow) => void;
};

const TimeWindowContext = createContext<TimeWindowContextValue | undefined>(undefined);

function readWindowFromUrl(): TimeWindow {
  // React Router uses HashRouter — the query string lives in window.location.hash
  // after the path (e.g. `#/overview?window=15m`). Browser-level
  // window.location.search is empty.
  if (typeof window === "undefined") return DEFAULT_WINDOW;
  const hash = window.location.hash || "";
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return DEFAULT_WINDOW;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const value = params.get(QUERY_KEY);
  return isTimeWindow(value) ? value : DEFAULT_WINDOW;
}

function writeWindowToUrl(next: TimeWindow): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash || "#/";
  const qIdx = hash.indexOf("?");
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? "" : hash.slice(qIdx + 1));
  if (next === DEFAULT_WINDOW) {
    params.delete(QUERY_KEY);
  } else {
    params.set(QUERY_KEY, next);
  }
  const qs = params.toString();
  const nextHash = qs ? `${path}?${qs}` : path;
  if (window.location.hash !== nextHash) {
    // Use replaceState so changing the window doesn't pile entries onto
    // the browser back-stack — operators flicking between windows would
    // otherwise have to mash "back" several times to leave the page.
    window.history.replaceState(null, "", nextHash);
  }
}

export function TimeWindowProvider({ children }: { children: ReactNode }) {
  const [windowValue, setWindowValue] = useState<TimeWindow>(() => readWindowFromUrl());

  // Listen for hashchange so deep-link or back/forward navigations sync the
  // selector back to the URL value.
  useEffect(() => {
    const onHashChange = () => {
      const next = readWindowFromUrl();
      setWindowValue((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const value = useMemo<TimeWindowContextValue>(
    () => ({
      window: windowValue,
      setWindow: (next) => {
        setWindowValue(next);
        writeWindowToUrl(next);
      },
    }),
    [windowValue],
  );

  return <TimeWindowContext.Provider value={value}>{children}</TimeWindowContext.Provider>;
}

export function useTimeWindow(): TimeWindowContextValue {
  const ctx = useContext(TimeWindowContext);
  if (!ctx) {
    // Pages outside the provider (token-gate, error boundaries) just get
    // the default — they don't render any windowed UI anyway.
    return { window: DEFAULT_WINDOW, setWindow: () => undefined };
  }
  return ctx;
}

export { ALL_WINDOWS, DEFAULT_WINDOW };
