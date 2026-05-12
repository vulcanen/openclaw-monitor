import type { ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { createInsightsQueries } from "./queries.js";
import {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_SEC,
  MAX_LIMIT,
  MAX_WINDOW_SEC,
  MIN_WINDOW_SEC,
} from "./types.js";

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function parseQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const idx = url.indexOf("?");
  return idx === -1 ? new URLSearchParams() : new URLSearchParams(url.slice(idx + 1));
}

function clampWindow(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_SEC;
  return Math.max(MIN_WINDOW_SEC, Math.min(parsed, MAX_WINDOW_SEC));
}

function clampLimit(raw: string | null): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function createInsightsRoutes(deps: Parameters<typeof createInsightsQueries>[0]): {
  slowCallsHandler: OpenClawPluginHttpRouteHandler;
  heavyConversationsHandler: OpenClawPluginHttpRouteHandler;
  errorClustersHandler: OpenClawPluginHttpRouteHandler;
  toolFailuresHandler: OpenClawPluginHttpRouteHandler;
} {
  const queries = createInsightsQueries(deps);

  const slowCallsHandler: OpenClawPluginHttpRouteHandler = async (req, res) => {
    const q = parseQuery(req.url);
    const windowSec = clampWindow(q.get("windowSec"));
    const limit = clampLimit(q.get("limit"));
    const rows = queries.slowCalls({ windowSec, limit });
    writeJson(res, 200, { generatedAt: new Date().toISOString(), windowSec, rows });
    return true;
  };

  const heavyConversationsHandler: OpenClawPluginHttpRouteHandler = async (req, res) => {
    const q = parseQuery(req.url);
    const windowSec = clampWindow(q.get("windowSec"));
    const limit = clampLimit(q.get("limit"));
    const rows = queries.heavyConversations({ windowSec, limit });
    writeJson(res, 200, { generatedAt: new Date().toISOString(), windowSec, rows });
    return true;
  };

  const errorClustersHandler: OpenClawPluginHttpRouteHandler = async (req, res) => {
    const q = parseQuery(req.url);
    const windowSec = clampWindow(q.get("windowSec"));
    const limit = clampLimit(q.get("limit"));
    const rows = queries.errorClusters({ windowSec, limit });
    writeJson(res, 200, { generatedAt: new Date().toISOString(), windowSec, rows });
    return true;
  };

  const toolFailuresHandler: OpenClawPluginHttpRouteHandler = async (req, res) => {
    const q = parseQuery(req.url);
    const windowSec = clampWindow(q.get("windowSec"));
    const limit = clampLimit(q.get("limit"));
    const rows = queries.toolFailures({ windowSec, limit });
    writeJson(res, 200, { generatedAt: new Date().toISOString(), windowSec, rows });
    return true;
  };

  return {
    slowCallsHandler,
    heavyConversationsHandler,
    errorClustersHandler,
    toolFailuresHandler,
  };
}
