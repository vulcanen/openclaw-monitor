import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createAggregator } from "./pipeline/aggregator.js";
import { createRunsTracker } from "./pipeline/runs-tracker.js";
import { createEventFanout } from "./probes/event-subscriber.js";
import { createEventBus } from "./outlets/event-bus.js";
import {
  createDimensionHandler,
  createEventsHandler,
  createHealthHandler,
  createLogsHandler,
  createOverviewHandler,
  createRunDetailHandler,
  createRunsHandler,
  createSeriesHandler,
} from "./outlets/rest-routes.js";
import { createSseStreamHandler } from "./outlets/sse-stream.js";
import { createStaticUiHandler } from "./outlets/static-ui.js";
import { createJsonlStore } from "./storage/jsonl-store.js";
import { createRetentionScheduler } from "./storage/retention.js";
import { createEventBuffer } from "./storage/ring-buffer.js";
import { createStoreRef } from "./storage/store-ref.js";
import { createConversationProbe } from "./audit/conversation-probe.js";
import { createConversationStore } from "./audit/conversation-store.js";
import {
  createConversationDetailHandler,
  createConversationsListHandler,
} from "./audit/conversation-routes.js";
import { createConversationStoreRef } from "./audit/store-ref.js";
import {
  DEFAULT_MONITOR_CONFIG,
  type HttpRouteParams,
  type MonitorConfig,
} from "./types.js";

const PLUGIN_ID = "openclaw-monitor";
const UI_BASE_PATH = "/monitor";
const ONE_HOUR_MS = 60 * 60 * 1000;

export type MonitorBundle = {
  service: OpenClawPluginService;
  routes: HttpRouteParams[];
  registerHooks: (api: OpenClawPluginApi) => void;
};

function mergeConfig(input?: Partial<MonitorConfig>): MonitorConfig {
  return {
    buffer: { ...DEFAULT_MONITOR_CONFIG.buffer, ...input?.buffer },
    storage: { ...DEFAULT_MONITOR_CONFIG.storage, ...input?.storage },
    retention: { ...DEFAULT_MONITOR_CONFIG.retention, ...input?.retention },
    ui: { ...DEFAULT_MONITOR_CONFIG.ui, ...input?.ui },
    stream: { ...DEFAULT_MONITOR_CONFIG.stream, ...input?.stream },
    audit: { ...DEFAULT_MONITOR_CONFIG.audit, ...input?.audit },
  };
}

function readPluginConfig(ctx: OpenClawPluginServiceContext): Partial<MonitorConfig> {
  // OpenClaw host expects plugin-owned config under
  // `plugins.entries.<id>.config.*`. The .hooks.* sibling is host-level
  // and isn't part of our schema.
  const config = ctx.config as unknown as {
    plugins?: { entries?: Record<string, { config?: unknown }> };
  };
  const raw = config?.plugins?.entries?.[PLUGIN_ID]?.config;
  return (raw && typeof raw === "object" ? (raw as Partial<MonitorConfig>) : {}) ?? {};
}

type HostGateState = {
  inAllow: boolean;
  allowConversationAccess: boolean;
};

function readHostGateState(ctx: OpenClawPluginServiceContext): HostGateState {
  const cfg = ctx.config as unknown as {
    plugins?: {
      allow?: string[];
      entries?: Record<string, { hooks?: { allowConversationAccess?: boolean } }>;
    };
  };
  const allow = cfg.plugins?.allow ?? [];
  const entry = cfg.plugins?.entries?.[PLUGIN_ID];
  return {
    inAllow: allow.includes(PLUGIN_ID),
    allowConversationAccess: entry?.hooks?.allowConversationAccess === true,
  };
}

export function createMonitorService(configOverride?: Partial<MonitorConfig>): MonitorBundle {
  let config = mergeConfig(configOverride);

  const buffer = createEventBuffer({ maxPerType: config.buffer.maxPerType });
  const aggregator = createAggregator();
  const runsTracker = createRunsTracker();
  const bus = createEventBus({ maxListeners: config.stream.maxSubscribers });
  const storeRef = createStoreRef();
  const conversationStoreRef = createConversationStoreRef();
  const conversationProbe = createConversationProbe();

  let retention: ReturnType<typeof createRetentionScheduler> | undefined;
  let auditRetentionTimer: NodeJS.Timeout | undefined;

  const fanout = createEventFanout({
    buffer,
    bus,
    storeRef,
    aggregator,
    runsTracker,
    conversationProbe,
  });

  const resolveStorageRoot = (ctx: OpenClawPluginServiceContext): string => {
    if (config.storage.path) return config.storage.path;
    return path.join(ctx.stateDir, PLUGIN_ID);
  };

  const resolveAuditRoot = (ctx: OpenClawPluginServiceContext): string => {
    return path.join(resolveStorageRoot(ctx), "audit");
  };

  const service: OpenClawPluginService = {
    id: PLUGIN_ID,
    start(ctx) {
      const merged = mergeConfig({ ...configOverride, ...readPluginConfig(ctx) });
      config = merged;

      if (config.storage.kind === "jsonl") {
        try {
          const store = createJsonlStore(resolveStorageRoot(ctx));
          storeRef.set(store);
          retention = createRetentionScheduler({
            store,
            eventsDays: config.retention.eventsDays,
            runsDays: config.retention.runsDays,
            ...(ctx.logger ? { logger: ctx.logger } : {}),
          });
          retention.start();
        } catch (err) {
          ctx.logger?.warn?.(
            `[${PLUGIN_ID}] failed to open jsonl store, running in-memory only: ${String(err)}`,
          );
          storeRef.set(undefined);
        }
      }

      conversationProbe.setConfig(config.audit);

      // Read-only hint: when audit is enabled in plugin config but the host
      // hasn't granted the matching security gate, log the exact command to
      // run. The plugin intentionally does NOT auto-write host config (see
      // project CLAUDE.md — auto-elevation is forbidden).
      if (config.audit.enabled && ctx.logger) {
        const gateState = readHostGateState(ctx);
        if (!gateState.inAllow || !gateState.allowConversationAccess) {
          const missing: string[] = [];
          if (!gateState.inAllow) missing.push("plugins.allow");
          if (!gateState.allowConversationAccess) {
            missing.push(`plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`);
          }
          ctx.logger.warn?.(
            `[${PLUGIN_ID}] audit enabled but host gate(s) missing: ${missing.join(", ")}. ` +
              `Channel-side audit (Control UI, message_received/sending) already works. ` +
              `To also capture LLM input/output content, run: ` +
              `\`openclaw monitor setup --audit && openclaw gateway restart\`.`,
          );
        }
      }

      if (config.audit.enabled) {
        try {
          const auditStore = createConversationStore(resolveAuditRoot(ctx));
          conversationStoreRef.set(auditStore);
          const tickAuditRetention = (): void => {
            try {
              const { filesDeleted } = auditStore.pruneOlderThan(config.audit.retainDays);
              if (filesDeleted > 0) {
                ctx.logger?.info?.(
                  `[${PLUGIN_ID}] audit retention: deleted ${filesDeleted} conversation files`,
                );
              }
            } catch (err) {
              ctx.logger?.warn?.(`[${PLUGIN_ID}] audit retention failed: ${String(err)}`);
            }
          };
          tickAuditRetention();
          auditRetentionTimer = setInterval(tickAuditRetention, ONE_HOUR_MS);
          auditRetentionTimer.unref?.();
          conversationProbe.setStore(auditStore);
        } catch (err) {
          ctx.logger?.warn?.(
            `[${PLUGIN_ID}] failed to open audit store, content audit will be in-memory only: ${String(err)}`,
          );
          conversationProbe.setStore(undefined);
        }
      }

      fanout.start();
    },
    stop() {
      fanout.stop();
      retention?.stop();
      retention = undefined;
      if (auditRetentionTimer) {
        clearInterval(auditRetentionTimer);
        auditRetentionTimer = undefined;
      }
      const store = storeRef.get();
      store?.close();
      storeRef.set(undefined);
      const auditStore = conversationStoreRef.get();
      auditStore?.close();
      conversationStoreRef.set(undefined);
      conversationProbe.setStore(undefined);
      bus.reset();
    },
  };

  const routes: HttpRouteParams[] = [
    {
      path: "/api/monitor/overview",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createOverviewHandler({ buffer, aggregator }),
    },
    {
      path: "/api/monitor/events",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createEventsHandler(buffer),
    },
    {
      path: "/api/monitor/health",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createHealthHandler(),
    },
    {
      path: "/api/monitor/channels",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createDimensionHandler(() => aggregator.channels()),
    },
    {
      path: "/api/monitor/models",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createDimensionHandler(() => aggregator.models()),
    },
    {
      path: "/api/monitor/tools",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createDimensionHandler(() => aggregator.tools()),
    },
    {
      path: "/api/monitor/runs",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createRunsHandler({ tracker: runsTracker, storeRef }),
    },
    {
      path: "/api/monitor/runs/",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createRunDetailHandler({ tracker: runsTracker, storeRef, buffer }),
    },
    {
      path: "/api/monitor/logs",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createLogsHandler(buffer),
    },
    {
      path: "/api/monitor/series",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createSeriesHandler(aggregator),
    },
    {
      path: "/api/monitor/stream",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createSseStreamHandler({
        bus,
        maxSubscribers: config.stream.maxSubscribers,
        heartbeatMs: config.stream.heartbeatMs,
      }),
    },
    {
      path: "/api/monitor/conversations",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createConversationsListHandler({
        probe: conversationProbe,
        storeRef: conversationStoreRef,
      }),
    },
    {
      path: "/api/monitor/conversations/",
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: createConversationDetailHandler({
        probe: conversationProbe,
        storeRef: conversationStoreRef,
      }),
    },
  ];

  if (config.ui.enabled) {
    // Static UI assets are intentionally public so a browser can load the
    // HTML/CSS/JS bundle without an Authorization header. The bundle by itself
    // exposes no data — every API call still goes through the gateway-auth
    // routes above. The UI handles the gateway token client-side
    // (localStorage + Authorization header on every fetch).
    routes.push({
      path: UI_BASE_PATH,
      auth: "plugin",
      match: "prefix",
      handler: createStaticUiHandler({ basePath: UI_BASE_PATH }),
    });
  }

  return {
    service,
    routes,
    registerHooks: (api) => {
      conversationProbe.installHooks(api);
    },
  };
}
