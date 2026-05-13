import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSetupCli } from "./cli/setup-command.js";
import { createMonitorService, type MonitorBundle } from "./service.js";

// OpenClaw's plugin loader can call `register(api)` more than once per
// process. Different load profiles / runtime contexts (e.g. provider
// resolution, web-fetch runtime, agent-tool middleware) each end up calling
// loadOpenClawPlugins with different load options, and on a cache miss the
// loader re-runs the plugin entry — re-invoking our register() with whatever
// `api` belongs to that loader pass.
//
// Two things therefore have to be true:
//   (a) The plugin's underlying state — buffer, aggregator, runs tracker,
//       JSONL store, conversation probe, SSE bus, etc. — must be a per-process
//       singleton. Otherwise the second register() would build a brand-new,
//       empty bundle, the hook callbacks would inject events into THAT
//       bundle's fanout, and the REST/SSE handlers (which were wired to the
//       first bundle's buffer) would silently report zeros forever.
//   (b) The per-api wiring (registerService / registerHttpRoute / registerHooks
//       / registerSetupCli) must be safe to skip on subsequent calls. A second
//       loader pass typically just wants a registry snapshot; re-registering
//       the same routes/services on a different `api` would either error or
//       overwrite the first set. We register exactly once and ignore later
//       passes — the first `api` is the one the gateway HTTP server, SSE
//       stream and CLI all observe.
let sharedBundle: MonitorBundle | undefined;
function getBundle(): MonitorBundle {
  if (!sharedBundle) {
    sharedBundle = createMonitorService();
  }
  return sharedBundle;
}

let routesAndServiceWired = false;

/**
 * `@vulcanen/openclaw-monitor` plugin entry.
 *
 * The default export is the result of `definePluginEntry(...)` and is what
 * the OpenClaw host loads when this package is listed under
 * `plugins.allow`. The plugin itself:
 *
 * - subscribes to the host's diagnostic event bus + hook system,
 *   aggregates per-type / per-channel / per-model rollups, and persists
 *   a rolling JSONL ring;
 * - registers the monitor HTTP API under `/api/monitor/*` (trusted-
 *   operator gateway scope) and the dashboard SPA under `/monitor`
 *   (public, browser-friendly auth — see CLAUDE.md decision #7);
 * - optionally captures full conversation content via the gated hooks
 *   (`llm_input` / `llm_output` / `agent_end`), driven by the host's
 *   `allowConversationAccess` security gate;
 * - exposes an in-process alert engine that pushes to webhook /
 *   DingTalk channels on threshold rules.
 *
 * State lives in module-level singletons (see `sharedBundle`) so the
 * host's multi-load-profile re-entrancy doesn't fragment the runtime;
 * see CLAUDE.md decision #12 for the why.
 */
export default definePluginEntry({
  id: "openclaw-monitor",
  name: "OpenClaw Monitor",
  description:
    "Real-time monitoring console for OpenClaw: subscribes to diagnostic events, aggregates per-type counters, exposes overview / events / runs / logs REST endpoints, streams live events over SSE, optionally captures full conversation content via plugin hooks, and serves a self-contained dashboard at /monitor.",
  register(api) {
    const bundle = getBundle();
    // Service + HTTP routes + CLI commands are keyed by id/path inside the
    // host; registering them on a second `api` would either fail or duplicate
    // them. Register them on the first `api` only — that's the instance the
    // gateway HTTP server, SSE stream and CLI dispatcher are wired to.
    if (!routesAndServiceWired) {
      routesAndServiceWired = true;
      api.registerService(bundle.service);
      for (const route of bundle.routes) {
        api.registerHttpRoute(route);
      }
      registerSetupCli(api);
    }
    // Hook callbacks must be registered against EVERY `api` we receive, since
    // a given hook firing dispatches through whichever api/registry hosted
    // the call. The fanout's own callId/toolCallId dedup absorbs the duplicate
    // injections this produces when multiple load profiles all see the same
    // call.
    bundle.registerHooks(api);
  },
});
