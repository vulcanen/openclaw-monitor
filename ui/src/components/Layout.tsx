import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { openEventStream, tokenStore } from "../api.js";
import { useI18n } from "../i18n/index.js";
import type { StringKey } from "../i18n/index.js";

const NAV_ITEMS: Array<{ to: string; key: StringKey }> = [
  { to: "/overview", key: "nav.overview" },
  { to: "/sources", key: "nav.sources" },
  { to: "/channels", key: "nav.channels" },
  { to: "/models", key: "nav.models" },
  { to: "/tools", key: "nav.tools" },
  { to: "/runs", key: "nav.runs" },
  { to: "/insights", key: "nav.insights" },
  { to: "/conversations", key: "nav.conversations" },
  { to: "/costs", key: "nav.costs" },
  { to: "/logs", key: "nav.logs" },
  { to: "/alerts", key: "nav.alerts" },
];

export function Layout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const [live, setLive] = useState(false);
  const [eventCount, setEventCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    let lastEventAt = Date.now();
    const close = openEventStream(() => {
      if (!mounted) return;
      lastEventAt = Date.now();
      setLive(true);
      setEventCount((c) => c + 1);
    });
    const heartbeatTimer = setInterval(() => {
      if (Date.now() - lastEventAt > 30_000) setLive(false);
    }, 5_000);
    return () => {
      mounted = false;
      clearInterval(heartbeatTimer);
      close();
    };
  }, []);

  return (
    <div className="layout">
      <header className="topbar">
        <h1>OpenClaw Monitor</h1>
        <nav>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <div
          className={`status ${live ? "live" : ""}`}
          role="status"
          aria-live="polite"
        >
          {/* The dot is a pure visual accent — the status text after it carries
              the actual signal, so we hide the dot from assistive tech. */}
          <span className="dot" aria-hidden="true" />
          {live ? t("status.live", { count: eventCount }) : t("status.idle")}
        </div>
        <button
          className="lang"
          aria-label={locale === "zh" ? "Switch to English" : "切换中文"}
          onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
        >
          {t("action.langSwitch")}
        </button>
        <button
          className="logout"
          aria-label={t("action.signOut")}
          onClick={() => {
            tokenStore.clear();
            window.location.reload();
          }}
        >
          {t("action.signOut")}
        </button>
      </header>
      <main>{children}</main>
    </div>
  );
}
