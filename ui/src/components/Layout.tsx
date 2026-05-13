import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { api, openEventStream, tokenStore } from "../api.js";
import { useI18n } from "../i18n/index.js";
import type { StringKey } from "../i18n/index.js";
import { ALL_WINDOWS, useTimeWindow } from "../time-window.js";
import type { TimeWindow } from "../time-window.js";

// Nav is grouped by functional cluster (v0.9.7). Each group is rendered as
// a contiguous run of NavLinks separated by a vertical divider. Order
// within a group reflects expected scan order.
//
//   Status   — what's the system doing right now / is anything on fire
//   Roll-ups — aggregated traffic and cost dimensions
//   Drill    — clickable individuals (runs, conversations, top-N insights)
//   Audit    — historical / forensic surfaces (cost ledger, log stream)
//
// CLAUDE.md UI rule #1 hard-bans a sidebar conversion; this stays a single
// horizontal nav, just visually clustered.
const NAV_GROUPS: ReadonlyArray<ReadonlyArray<{ to: string; key: StringKey }>> = [
  // Status
  [
    { to: "/overview", key: "nav.overview" },
    { to: "/alerts", key: "nav.alerts" },
  ],
  // Roll-ups
  [
    { to: "/sources", key: "nav.sources" },
    { to: "/channels", key: "nav.channels" },
    { to: "/models", key: "nav.models" },
    { to: "/tools", key: "nav.tools" },
  ],
  // Drill-down
  [
    { to: "/runs", key: "nav.runs" },
    { to: "/sessions", key: "nav.sessions" },
    { to: "/conversations", key: "nav.conversations" },
    { to: "/insights", key: "nav.insights" },
  ],
  // Audit / historical
  [
    { to: "/costs", key: "nav.costs" },
    { to: "/logs", key: "nav.logs" },
  ],
];

export function Layout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const { window: timeWindow, setWindow } = useTimeWindow();
  const [live, setLive] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const [firingCount, setFiringCount] = useState(0);

  // Poll the alerts/active endpoint at a relaxed cadence (15s — alerts
  // change much more slowly than gateway events) so the topbar badge
  // reflects firing-alert state even when the operator is on a page
  // other than /alerts.
  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      try {
        const data = await api.alertsActive();
        if (mounted) setFiringCount(data.active.length);
      } catch {
        // alerts not configured / network blip — leave previous count
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

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
          {NAV_GROUPS.map((group, gi) => (
            <span key={gi} className="nav-group">
              {gi > 0 ? <span className="nav-divider" aria-hidden="true" /> : null}
              {group.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => (isActive ? "active" : "")}
                >
                  {t(item.key)}
                </NavLink>
              ))}
            </span>
          ))}
        </nav>
        <div className="spacer" />
        {firingCount > 0 ? (
          <Link
            to="/alerts"
            className="alerts-firing"
            aria-label={t("topbar.alertsFiring", { count: firingCount })}
            title={t("topbar.alertsFiring", { count: firingCount })}
          >
            {t("topbar.alertsFiring", { count: firingCount })}
          </Link>
        ) : null}
        <label className="window-picker" htmlFor="global-window">
          <span className="sr-only">{t("topbar.window")}</span>
          <select
            id="global-window"
            value={timeWindow}
            onChange={(e) => setWindow(e.target.value as TimeWindow)}
            aria-label={t("topbar.window")}
          >
            {ALL_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {t(`topbar.window.${w}`)}
              </option>
            ))}
          </select>
        </label>
        <div className={`status ${live ? "live" : ""}`} role="status" aria-live="polite">
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
