import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMonitorService } from "./service.js";

export default definePluginEntry({
  id: "openclaw-monitor",
  name: "OpenClaw Monitor",
  description:
    "Real-time monitoring console for OpenClaw: subscribes to diagnostic events, aggregates per-type counters, exposes overview / events / runs / logs REST endpoints, streams live events over SSE, optionally captures full conversation content via plugin hooks, and serves a self-contained dashboard at /monitor.",
  register(api) {
    const bundle = createMonitorService();
    api.registerService(bundle.service);
    for (const route of bundle.routes) {
      api.registerHttpRoute(route);
    }
    bundle.registerHooks(api);
  },
});
