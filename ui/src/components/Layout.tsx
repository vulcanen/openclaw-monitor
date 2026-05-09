import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { openEventStream, tokenStore } from "../api.js";

const NAV_ITEMS: Array<{ to: string; label: string }> = [
  { to: "/overview", label: "Overview" },
  { to: "/channels", label: "Channels" },
  { to: "/models", label: "Models" },
  { to: "/tools", label: "Tools" },
  { to: "/runs", label: "Runs" },
  { to: "/conversations", label: "Conversations" },
  { to: "/logs", label: "Logs" },
];

export function Layout({ children }: { children: ReactNode }) {
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
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <div className={`status ${live ? "live" : ""}`}>
          <span className="dot" />
          {live ? `live · ${eventCount} events seen` : "idle"}
        </div>
        <button
          className="logout"
          title="clear token and re-enter"
          onClick={() => {
            tokenStore.clear();
            window.location.reload();
          }}
        >
          sign out
        </button>
      </header>
      <main>{children}</main>
    </div>
  );
}
