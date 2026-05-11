import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { openEventStream, tokenStore } from "../api.js";
import { useI18n } from "../i18n/index.js";
import type { StringKey } from "../i18n/index.js";

const NAV_ITEMS: Array<{ to: string; key: StringKey }> = [
  { to: "/overview", key: "nav.overview" },
  { to: "/channels", key: "nav.channels" },
  { to: "/models", key: "nav.models" },
  { to: "/tools", key: "nav.tools" },
  { to: "/runs", key: "nav.runs" },
  { to: "/conversations", key: "nav.conversations" },
  { to: "/logs", key: "nav.logs" },
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
        <div className={`status ${live ? "live" : ""}`}>
          <span className="dot" />
          {live ? t("status.live", { count: eventCount }) : t("status.idle")}
        </div>
        <button
          className="lang"
          title={locale === "zh" ? "Switch to English" : "切换中文"}
          onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
        >
          {t("action.langSwitch")}
        </button>
        <button
          className="logout"
          title={t("action.signOut")}
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
