import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { Aggregator, SeriesMetric } from "../pipeline/aggregator.js";
import type { RunsTracker } from "../pipeline/runs-tracker.js";
import type { StoreRef } from "../storage/store-ref.js";
import type { EventBuffer } from "../storage/ring-buffer.js";
import type {
  CapturedEvent,
  EventType,
  LogRecord,
  OverviewSnapshot,
  RunSnapshot,
} from "../types.js";

const MAX_RECENT_ERRORS = 20;
const MAX_EVENTS_PAGE = 500;
const MAX_LOGS_PAGE = 500;
const MAX_RUNS_PAGE = 200;
const ERROR_EVENT_TYPES = new Set<EventType>([
  "model.call.error",
  "tool.execution.error",
  "tool.execution.blocked",
  "harness.run.error",
  "message.delivery.error",
  "webhook.error",
  "session.stalled",
  "session.stuck",
  "diagnostic.liveness.warning",
  "diagnostic.memory.pressure",
]);

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function summarizeErrorEvent(captured: CapturedEvent): string {
  const evt = captured.event as Record<string, unknown>;
  const candidates = [evt["errorMessage"], evt["message"], evt["reason"], evt["errorCategory"]];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) {
      return value.length > 240 ? `${value.slice(0, 240)}…` : value;
    }
  }
  return captured.event.type;
}

function parseQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const queryStart = url.indexOf("?");
  return queryStart === -1
    ? new URLSearchParams()
    : new URLSearchParams(url.slice(queryStart + 1));
}

export function createOverviewHandler(params: {
  buffer: EventBuffer;
  aggregator: Aggregator;
}): OpenClawPluginHttpRouteHandler {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    const { buffer, aggregator } = params;
    const counts = buffer.countsByType();
    const recentErrors: OverviewSnapshot["recentErrors"] = [];
    for (const type of ERROR_EVENT_TYPES) {
      const items = buffer.recent({ type, limit: MAX_RECENT_ERRORS });
      for (const item of items) {
        recentErrors.push({
          type: item.event.type,
          capturedAt: new Date(item.capturedAt).toISOString(),
          summary: summarizeErrorEvent(item),
        });
      }
    }
    recentErrors.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    const snapshot: OverviewSnapshot = {
      generatedAt: new Date().toISOString(),
      bufferedEvents: buffer.size(),
      countsByType: counts,
      recentErrors: recentErrors.slice(0, MAX_RECENT_ERRORS),
      windows: aggregator.windows(),
    };
    writeJson(res, 200, snapshot);
    return true;
  };
}

export function createEventsHandler(buffer: EventBuffer): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const params = parseQuery(req.url);
    const requestedLimit = Number.parseInt(params.get("limit") ?? "100", 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_EVENTS_PAGE)
        : 100;
    const type = params.get("type") ?? undefined;
    const items = buffer.recent({
      ...(type ? { type: type as EventType } : {}),
      limit,
    });
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      count: items.length,
      events: items.map((item) => ({
        type: item.event.type,
        capturedAt: new Date(item.capturedAt).toISOString(),
        payload: item.event,
      })),
    });
    return true;
  };
}

export function createHealthHandler(): OpenClawPluginHttpRouteHandler {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, { ok: true, generatedAt: new Date().toISOString() });
    return true;
  };
}

export function createDimensionHandler(
  rows: () => Array<{
    key: string;
    total: number;
    errors: number;
    p50Ms: number | null;
    p95Ms: number | null;
    tokensIn?: number;
    tokensOut?: number;
  }>,
): OpenClawPluginHttpRouteHandler {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      rows: rows(),
    });
    return true;
  };
}

export function createRunsHandler(params: {
  tracker: RunsTracker;
  storeRef: StoreRef;
}): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const query = parseQuery(req.url);
    const requestedLimit = Number.parseInt(query.get("limit") ?? "50", 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_RUNS_PAGE)
        : 50;
    const includePersisted = query.get("persisted") !== "false";
    const active = params.tracker.active();
    const memory = params.tracker.recent();
    const store = params.storeRef.get();
    const persisted: RunSnapshot[] =
      includePersisted && store ? store.readRuns({ limit }) : [];
    const seen = new Set<string>();
    const merged: RunSnapshot[] = [];
    for (const run of [...active, ...memory, ...persisted]) {
      if (seen.has(run.runId)) continue;
      seen.add(run.runId);
      merged.push(run);
    }
    merged.sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      active: active.length,
      runs: merged.slice(0, limit),
    });
    return true;
  };
}

export function createRunDetailHandler(params: {
  tracker: RunsTracker;
  storeRef: StoreRef;
  buffer: EventBuffer;
}): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const queryStart = url.indexOf("?");
    const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
    const id = pathname.split("/").filter(Boolean).pop();
    if (!id) {
      writeJson(res, 400, { error: "missing run id" });
      return true;
    }
    const store = params.storeRef.get();
    const fromActive = params.tracker.active().find((run) => run.runId === id);
    const fromMemory = params.tracker.recent().find((run) => run.runId === id);
    const fromStore = store?.readRuns({ limit: 1_000 }).find((run) => run.runId === id);
    const run = fromActive ?? fromMemory ?? fromStore;
    if (!run) {
      writeJson(res, 404, { error: "run not found" });
      return true;
    }
    const relevantEvents = params.buffer.recent({ limit: 500 }).filter((item) => {
      const raw = item.event as unknown as Record<string, unknown>;
      return raw["runId"] === id;
    });
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      run,
      events: relevantEvents.map((item) => ({
        type: item.event.type,
        capturedAt: new Date(item.capturedAt).toISOString(),
        payload: item.event,
      })),
    });
    return true;
  };
}

export function createLogsHandler(buffer: EventBuffer): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const query = parseQuery(req.url);
    const requestedLimit = Number.parseInt(query.get("limit") ?? "200", 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_LOGS_PAGE)
        : 200;
    const levelFilter = query.get("level") ?? undefined;
    const componentFilter = query.get("component") ?? undefined;
    const items = buffer.recent({ type: "log.record", limit: limit * 2 });
    const records: LogRecord[] = [];
    for (const item of items) {
      const raw = item.event as unknown as Record<string, unknown>;
      const level = typeof raw["level"] === "string" ? raw["level"] : undefined;
      const component = typeof raw["component"] === "string" ? raw["component"] : undefined;
      const message =
        typeof raw["message"] === "string" ? raw["message"] : item.event.type;
      if (levelFilter && level !== levelFilter) continue;
      if (componentFilter && component !== componentFilter) continue;
      records.push({
        capturedAt: new Date(item.capturedAt).toISOString(),
        ...(level ? { level } : {}),
        ...(component ? { component } : {}),
        message,
      });
      if (records.length >= limit) break;
    }
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      count: records.length,
      records,
    });
    return true;
  };
}

const VALID_SERIES_METRICS = new Set<SeriesMetric>([
  "events.total",
  "model.calls",
  "model.errors",
  "tool.execs",
  "tool.errors",
  "messages.delivered",
  "messages.errors",
]);

export function createSeriesHandler(aggregator: Aggregator): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const query = parseQuery(req.url);
    const metric = query.get("metric") ?? "events.total";
    if (!VALID_SERIES_METRICS.has(metric as SeriesMetric)) {
      writeJson(res, 400, { error: `unknown metric: ${metric}` });
      return true;
    }
    const windowSecRaw = Number.parseInt(query.get("windowSec") ?? "900", 10);
    const windowSec =
      Number.isFinite(windowSecRaw) && windowSecRaw > 0
        ? Math.min(windowSecRaw, 3_600)
        : 900;
    const result = aggregator.series({
      metric: metric as SeriesMetric,
      windowSec,
    });
    writeJson(res, 200, result);
    return true;
  };
}
