import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App.js";
import "./styles.css";

// Unregister any service worker whose scope intercepts our path. The Monitor
// UI itself does not register a service worker, so anything we find is from a
// co-tenant on the same origin (typically OpenClaw's Control UI). Its fetch
// handler does not know how to serve /monitor/* and breaks our requests with
// "Failed to convert value to 'Response'". Unregistering is reversible — the
// owning SPA will re-install its own SW on its next page load.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then(async (regs) => {
      for (const reg of regs) {
        try {
          const scopePath = new URL(reg.scope).pathname;
          if (window.location.pathname.startsWith(scopePath)) {
            await reg.unregister();
          }
        } catch {
          // ignore malformed scope or unregister failures
        }
      }
    })
    .catch(() => {
      // ignore
    });
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
