import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { ConversationProbe } from "./conversation-probe.js";
import type { ConversationStore } from "./conversation-store.js";
import type { ConversationRecord, ConversationSummary } from "./types.js";

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

function summarizeRuntime(record: ConversationRecord): ConversationSummary {
  let totalIn = 0;
  let totalOut = 0;
  for (const out of record.llmOutputs) {
    totalIn += out.usage?.input ?? 0;
    totalOut += out.usage?.output ?? 0;
  }
  const lastOutput = record.llmOutputs[record.llmOutputs.length - 1];
  const responseText = lastOutput?.assistantTexts.join(" ").slice(0, 160);
  return {
    runId: record.runId,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.channelId !== undefined ? { channelId: record.channelId } : {}),
    ...(record.trigger !== undefined ? { trigger: record.trigger } : {}),
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    llmHops: record.llmInputs.length,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
    ...(record.inbound?.prompt
      ? { promptPreview: record.inbound.prompt.slice(0, 160) }
      : {}),
    ...(responseText ? { responsePreview: responseText } : {}),
    hasError: record.status === "error" || Boolean(record.errorMessage),
  };
}

export function createConversationsListHandler(params: {
  probe: ConversationProbe;
  storeRef: { get: () => ConversationStore | undefined };
}): OpenClawPluginHttpRouteHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const query = parseQuery(req.url);
    const limitRaw = Number.parseInt(query.get("limit") ?? "50", 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
    const recent = params.probe.recentCompleted();
    const persisted = params.storeRef.get()?.list({ limit }) ?? [];
    const seen = new Set<string>();
    const merged: ConversationSummary[] = [];
    for (const record of recent) {
      if (seen.has(record.runId)) continue;
      seen.add(record.runId);
      merged.push(summarizeRuntime(record));
    }
    for (const summary of persisted) {
      if (seen.has(summary.runId)) continue;
      seen.add(summary.runId);
      merged.push(summary);
    }
    merged.sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      active: params.probe.activeCount(),
      conversations: merged.slice(0, limit),
    });
    return true;
  };
}

export function createConversationDetailHandler(params: {
  probe: ConversationProbe;
  storeRef: { get: () => ConversationStore | undefined };
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
    const fromMemory = params.probe.recentCompleted().find((r) => r.runId === id);
    const fromStore = params.storeRef.get()?.get(id);
    const record = fromMemory ?? fromStore;
    if (!record) {
      writeJson(res, 404, { error: "conversation not found" });
      return true;
    }
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      conversation: record,
    });
    return true;
  };
}
