import fs from "node:fs";
import path from "node:path";
import { summarizeConversation } from "./summarize.js";
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

export function createConversationStore(rootDir: string): ConversationStore {
  ensureDir(rootDir);

  // runId → file path index. Lets `get(runId)` skip the O(N×M) scan
  // through every persisted file. Built lazily on first lookup, kept
  // in memory after that, and updated incrementally by appendCompleted.
  // We index *file*, not (file, byteOffset), because:
  //   - records can have variable length (audit captures full prompts,
  //     can be MB-scale per record) → byte offsets are fragile;
  //   - a single-day file has at most a few hundred records in typical
  //     deployments — re-scanning the matching day is fast enough;
  //   - file-only indexes invalidate cleanly on retention prune.
  let indexBuilt = false;
  const runIdToFile = new Map<string, string>();
  // Track which files are *known to be fully indexed* so a partial
  // build (or a file that grew after indexing) can be re-scanned.
  const fileMtimeAtIndex = new Map<string, number>();

  const indexFile = (file: string): void => {
    const lines = safeReadLines(file);
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ConversationRecord;
        if (typeof parsed.runId === "string") {
          runIdToFile.set(parsed.runId, file);
        }
      } catch {
        // skip corrupt
      }
    }
    try {
      fileMtimeAtIndex.set(file, fs.statSync(file).mtimeMs);
    } catch {
      // best-effort
    }
  };

  const buildIndex = (): void => {
    if (indexBuilt) return;
    for (const { file } of listFiles(rootDir)) {
      indexFile(file);
    }
    indexBuilt = true;
  };

  const appendCompleted: ConversationStore["appendCompleted"] = (record) => {
    const day = dayStamp(record.endedAt ?? record.startedAt);
    const file = path.join(rootDir, `conversations-${day}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    // Keep the index incrementally consistent so subsequent get(runId)
    // calls hit the cache without rebuilding.
    runIdToFile.set(record.runId, file);
    try {
      fileMtimeAtIndex.set(file, fs.statSync(file).mtimeMs);
    } catch {
      // best-effort
    }
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
          out.push(summarizeConversation(parsed));
          if (out.length >= limit) return out;
        } catch {
          // skip corrupt
        }
      }
    }
    return out;
  };

  const get: ConversationStore["get"] = (runId) => {
    if (!indexBuilt) buildIndex();
    const file = runIdToFile.get(runId);
    if (file && fs.existsSync(file)) {
      // Re-scan only the candidate file (records are appended in order
      // and we don't know byte offset).
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
    // Index miss: either the runId never existed, or a file grew after
    // index build (rare — appendCompleted updates the index). Fall back
    // to a full scan once and refresh the index along the way.
    for (const { file } of listFiles(rootDir).reverse()) {
      const mtime = (() => {
        try {
          return fs.statSync(file).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (fileMtimeAtIndex.get(file) === mtime) continue; // unchanged since indexed
      indexFile(file);
      const refound = runIdToFile.get(runId);
      if (refound === file) {
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
          fileMtimeAtIndex.delete(file);
          // Cheap purge: walk the runId index and drop entries pointing
          // at the just-deleted file. The index is bounded by the
          // retention window, so this is small.
          for (const [runId, indexedFile] of runIdToFile) {
            if (indexedFile === file) runIdToFile.delete(runId);
          }
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
