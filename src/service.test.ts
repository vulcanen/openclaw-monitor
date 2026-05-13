import { describe, expect, it, vi } from "vitest";
import { createAggregator } from "./pipeline/aggregator.js";
import { createRunsTracker } from "./pipeline/runs-tracker.js";
import { createEventBus } from "./outlets/event-bus.js";
import { createEventFanout } from "./probes/event-subscriber.js";
import { createStoreRef } from "./storage/store-ref.js";
import { createEventBuffer } from "./storage/ring-buffer.js";
import { makeEvent } from "./test-utils.js";

// Top-level service / plugin-entry tests only. Layer-specific tests
// (storage, pipeline, probes, audit, alerts, costs, insights) each live
// next to the layer they cover — see `src/<layer>/*.test.ts`.

describe("plugin entry idempotency", () => {
  // Regression: OpenClaw's plugin loader can re-enter `register(api)` more
  // than once per process (different load profiles trigger fresh loads with
  // the cache miss path). When it does, the underlying state must stay
  // shared — otherwise the second pass builds its own empty bundle, hook
  // callbacks land there, and the HTTP handlers (still pointing at the first
  // bundle) see no metrics. This was the v0.5.0 → v0.5.1 silent-monitor bug.
  it("multiple register(api) calls share one bundle and don't double-register routes", async () => {
    type Registered = {
      services: unknown[];
      routes: unknown[];
      hooks: string[];
    };
    const makeFakeApi = (reg: Registered) => ({
      registerService: (svc: unknown) => {
        reg.services.push(svc);
      },
      registerHttpRoute: (route: unknown) => {
        reg.routes.push(route);
      },
      on: (name: string) => {
        reg.hooks.push(name);
      },
      registerCommand: () => {},
      registerCli: () => {},
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "openclaw-monitor": {
                  hooks: { allowConversationAccess: true },
                  config: { audit: { enabled: true } },
                },
              },
              allow: ["openclaw-monitor"],
            },
          }),
        },
      },
    });
    // Force a fresh import so the module-level singletons start clean.
    vi.resetModules();
    const entryModule = await import("./index.js");
    const entry = entryModule.default;
    const apiA: Registered = { services: [], routes: [], hooks: [] };
    const apiB: Registered = { services: [], routes: [], hooks: [] };
    entry.register(makeFakeApi(apiA));
    entry.register(makeFakeApi(apiB));
    // Service + HTTP routes + CLI commands are wired exactly once (against
    // the first api). Re-registering them on the second api would either
    // fail at runtime or duplicate paths under the host's route table.
    expect(apiA.services.length).toBe(1);
    expect(apiA.routes.length).toBeGreaterThan(0);
    expect(apiB.services.length).toBe(0);
    expect(apiB.routes.length).toBe(0);
    // Hook callbacks ARE registered on every api. The host's hook dispatcher
    // for the second-pass load profile only sees handlers attached to its
    // own api instance; we let the fanout's callId/toolCallId dedup absorb
    // the resulting duplicate injections.
    expect(apiA.hooks.length).toBeGreaterThan(0);
    expect(apiB.hooks).toEqual(apiA.hooks);
  });
});

describe("event fanout", () => {
  it("propagates an injected event to buffer + aggregator + bus + store", async () => {
    const buffer = createEventBuffer({ maxPerType: 64 });
    const aggregator = createAggregator();
    const runsTracker = createRunsTracker();
    const bus = createEventBus({ maxListeners: 4 });
    const storeRef = createStoreRef();
    const probe = (await import("./audit/conversation-probe.js")).createConversationProbe();
    const fanout = createEventFanout({
      buffer,
      bus,
      storeRef,
      aggregator,
      runsTracker,
      conversationProbe: probe,
    });

    let busHits = 0;
    bus.subscribe(() => {
      busHits += 1;
    });

    fanout.inject(
      makeEvent("model.call.completed", { provider: "openai", model: "gpt-4", durationMs: 50 }),
    );
    expect(buffer.size()).toBe(1);
    expect(aggregator.models()[0]?.total).toBe(1);
    expect(busHits).toBe(1);
  });
});
