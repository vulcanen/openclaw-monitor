import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { AlertEngine } from "./engine.js";

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

export function createAlertsRulesHandler(engine: AlertEngine): OpenClawPluginHttpRouteHandler {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      running: engine.isRunning(),
      rules: engine.rules(),
    });
    return true;
  };
}

export function createAlertsActiveHandler(engine: AlertEngine): OpenClawPluginHttpRouteHandler {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      active: engine.active(),
    });
    return true;
  };
}

export function createAlertsHistoryHandler(engine: AlertEngine): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const params = parseQuery(req.url);
    const limitRaw = Number.parseInt(params.get("limit") ?? "100", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      count: engine.history.size(),
      entries: engine.history.list(limit),
    });
    return true;
  };
}
