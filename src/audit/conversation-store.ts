import fs from "node:fs";
import path from "node:path";
import type { ConversationRecord, ConversationSummary } from "./types.js";

const FILE_RE = /^conversations-(\d{4}-\d{2}-\d{2})\.jsonl$/u;

export type ConversationStore = {
  appendCompleted: (record: ConversationRecord) => void;
  list: (params?: { limit?: number }) => ConversationSummary[];
  get: (runId: string) => ConversationRecord | undefined;
  pruneOlderThan: (retainDays: number) => { filesDeleted: number };
  close: () => void;
};

function dayStamp(iso: string): string {
  return iso.slice(0, 10);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadLines(file: string): string[] {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return raw.split(/\r?\n/u).filter((line) => line.length > 0);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

function listFiles(dir: string): Array<{ file: string; day: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: Array<{ file: string; day: string }> = [];
  for (const name of entries) {
    const match = name.match(FILE_RE);
    if (match?.[1]) {
      out.push({ file: path.join(dir, name), day: match[1] });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

function summarize(record: ConversationRecord): ConversationSummary {
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
    // sessionKey is load-bearing for the Conversations page's
    // groupBy=sessionKey path. Without it the UI groups every
    // persisted record under the "_ungrouped" bucket. Mirror the same
    // forwarding that conversation-routes.ts:summarizeRuntime does for
    // in-memory records.
    ...(record.sessionKey !== undefined ? { sessionKey: record.sessionKey } : {}),
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

export function createConversationStore(rootDir: string): ConversationStore {
  ensureDir(rootDir);

  const appendCompleted: ConversationStore["appendCompleted"] = (record) => {
    const day = dayStamp(record.endedAt ?? record.startedAt);
    const file = path.join(rootDir, `conversations-${day}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  };

  const list: ConversationStore["list"] = (params) => {
    const limit = Math.max(1, Math.min(params?.limit ?? 50, 500));
    const files = listFiles(rootDir).reverse();
    const out: ConversationSummary[] = [];
    for (const { file } of files) {
      const lines = safeReadLines(file);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as ConversationRecord;
          if (typeof parsed.runId !== "string") continue;
          out.push(summarize(parsed));
          if (out.length >= limit) return out;
        } catch {
          // skip corrupt
        }
      }
    }
    return out;
  };

  const get: ConversationStore["get"] = (runId) => {
    const files = listFiles(rootDir).reverse();
    for (const { file } of files) {
      const lines = safeReadLines(file);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as ConversationRecord;
          if (parsed.runId === runId) return parsed;
        } catch {
          // skip
        }
      }
    }
    return undefined;
  };

  const pruneOlderThan: ConversationStore["pruneOlderThan"] = (retainDays) => {
    const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString().slice(0, 10);
    let filesDeleted = 0;
    for (const { file, day } of listFiles(rootDir)) {
      if (day < cutoff) {
        try {
          fs.unlinkSync(file);
          filesDeleted += 1;
        } catch {
          // best-effort
        }
      }
    }
    return { filesDeleted };
  };

  return {
    appendCompleted,
    list,
    get,
    pruneOlderThan,
    close: () => {
      // sync writes; nothing to flush
    },
  };
}
