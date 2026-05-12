import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { ConversationProbe } from "./conversation-probe.js";
import type { ConversationStore } from "./conversation-store.js";
import { summarizeConversation } from "./summarize.js";
import type { ConversationSummary } from "./types.js";

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

type SessionGroup = {
  sessionKey: string;
  sessionId?: string;
  channelId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  runCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  hasError: boolean;
  conversations: ConversationSummary[];
};

const UNGROUPED_SESSION_KEY = "_ungrouped";

function groupBySession(summaries: ConversationSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const c of summaries) {
    const key = c.sessionKey ?? UNGROUPED_SESSION_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        sessionKey: key,
        ...(c.sessionId !== undefined ? { sessionId: c.sessionId } : {}),
        ...(c.channelId !== undefined ? { channelId: c.channelId } : {}),
        firstSeenAt: c.startedAt,
        lastSeenAt: c.endedAt ?? c.startedAt,
        runCount: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        hasError: false,
        conversations: [],
      };
      groups.set(key, group);
    }
    group.conversations.push(c);
    group.runCount += 1;
    group.totalTokensIn += c.totalTokensIn ?? 0;
    group.totalTokensOut += c.totalTokensOut ?? 0;
    if (c.hasError) group.hasError = true;
    if (c.startedAt.localeCompare(group.firstSeenAt) < 0) group.firstSeenAt = c.startedAt;
    const lastTs = c.endedAt ?? c.startedAt;
    if (lastTs.localeCompare(group.lastSeenAt) > 0) group.lastSeenAt = lastTs;
    if (group.channelId === undefined && c.channelId !== undefined) {
      group.channelId = c.channelId;
    }
    if (group.sessionId === undefined && c.sessionId !== undefined) {
      group.sessionId = c.sessionId;
    }
  }
  // Newest activity first within each group, and groups themselves by their
  // last-seen run.
  for (const group of groups.values()) {
    group.conversations.sort((a, b) =>
      (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt),
    );
  }
  return Array.from(groups.values()).sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
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
    const groupBy = query.get("groupBy");
    const recent = params.probe.recentCompleted();
    // When grouping by session, pull a larger persisted slice so each session
    // can show its complete run history (`limit` then applies to the
    // post-group ordering, not the underlying conversations).
    const fetchLimit = groupBy === "sessionKey" ? Math.min(limit * 10, 1000) : limit;
    const persisted = params.storeRef.get()?.list({ limit: fetchLimit }) ?? [];
    const seen = new Set<string>();
    const merged: ConversationSummary[] = [];
    for (const record of recent) {
      if (seen.has(record.runId)) continue;
      seen.add(record.runId);
      merged.push(summarizeConversation(record));
    }
    for (const summary of persisted) {
      if (seen.has(summary.runId)) continue;
      seen.add(summary.runId);
      merged.push(summary);
    }
    merged.sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
    if (groupBy === "sessionKey") {
      const sessions = groupBySession(merged);
      writeJson(res, 200, {
        generatedAt: new Date().toISOString(),
        active: params.probe.activeCount(),
        groupBy: "sessionKey",
        sessions: sessions.slice(0, limit),
      });
      return true;
    }
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
