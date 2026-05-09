import fs from "node:fs";
import path from "node:path";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { CapturedEvent, EventType, RunSnapshot } from "../types.js";

const EVENT_FILE_RE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/u;

export type JsonlStore = {
  appendEvent: (event: DiagnosticEventPayload, capturedAt: number) => void;
  appendRun: (run: RunSnapshot) => void;
  readEvents: (params?: { since?: number; type?: EventType; limit?: number }) => CapturedEvent[];
  readRuns: (params?: { limit?: number }) => RunSnapshot[];
  pruneOlderThan: (params: { eventsDays: number; runsDays: number }) => {
    eventFilesDeleted: number;
    runsTrimmed: number;
  };
  close: () => void;
  rootDir: () => string;
};

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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

function listEventFiles(dir: string): Array<{ file: string; day: string }> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const out: Array<{ file: string; day: string }> = [];
  for (const name of entries) {
    const match = name.match(EVENT_FILE_RE);
    if (match?.[1]) {
      out.push({ file: path.join(dir, name), day: match[1] });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export function createJsonlStore(rootDir: string): JsonlStore {
  ensureDir(rootDir);
  const runsFile = path.join(rootDir, "runs.jsonl");

  const appendEvent: JsonlStore["appendEvent"] = (event, capturedAt) => {
    const day = dayStamp(capturedAt);
    const file = path.join(rootDir, `events-${day}.jsonl`);
    const line = `${JSON.stringify({ capturedAt, event })}\n`;
    fs.appendFileSync(file, line);
  };

  const appendRun: JsonlStore["appendRun"] = (run) => {
    fs.appendFileSync(runsFile, `${JSON.stringify(run)}\n`);
  };

  const readEvents: JsonlStore["readEvents"] = (params) => {
    const limit = Math.max(1, Math.min(params?.limit ?? 200, 5_000));
    const since = params?.since ?? 0;
    const type = params?.type;
    const files = listEventFiles(rootDir).reverse();
    const out: CapturedEvent[] = [];
    for (const { file } of files) {
      const lines = safeReadLines(file);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as CapturedEvent;
          if (typeof parsed.capturedAt !== "number" || !parsed.event) continue;
          if (parsed.capturedAt < since) continue;
          if (type && parsed.event.type !== type) continue;
          out.push(parsed);
          if (out.length >= limit) {
            return out.reverse();
          }
        } catch {
          // skip corrupt lines
        }
      }
    }
    return out.reverse();
  };

  const readRuns: JsonlStore["readRuns"] = (params) => {
    const limit = Math.max(1, Math.min(params?.limit ?? 100, 1_000));
    const lines = safeReadLines(runsFile);
    const out: RunSnapshot[] = [];
    for (let index = lines.length - 1; index >= 0 && out.length < limit; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as RunSnapshot;
        if (typeof parsed.runId === "string") {
          out.push(parsed);
        }
      } catch {
        // skip corrupt lines
      }
    }
    return out;
  };

  const pruneOlderThan: JsonlStore["pruneOlderThan"] = ({ eventsDays, runsDays }) => {
    const now = Date.now();
    const eventCutoff = dayStamp(now - eventsDays * 86_400_000);
    let eventFilesDeleted = 0;
    for (const { file, day } of listEventFiles(rootDir)) {
      if (day < eventCutoff) {
        try {
          fs.unlinkSync(file);
          eventFilesDeleted += 1;
        } catch {
          // best-effort cleanup
        }
      }
    }
    const runCutoff = now - runsDays * 86_400_000;
    let runsTrimmed = 0;
    const runLines = safeReadLines(runsFile);
    if (runLines.length > 0) {
      const kept: string[] = [];
      for (const line of runLines) {
        try {
          const parsed = JSON.parse(line) as RunSnapshot;
          const startedMs = Date.parse(parsed.startedAt);
          if (Number.isFinite(startedMs) && startedMs >= runCutoff) {
            kept.push(line);
          } else {
            runsTrimmed += 1;
          }
        } catch {
          runsTrimmed += 1;
        }
      }
      if (runsTrimmed > 0) {
        fs.writeFileSync(runsFile, kept.length === 0 ? "" : `${kept.join("\n")}\n`);
      }
    }
    return { eventFilesDeleted, runsTrimmed };
  };

  const close: JsonlStore["close"] = () => {
    // sync writes have nothing to flush; provided for symmetry and future pluggability
  };

  return {
    appendEvent,
    appendRun,
    readEvents,
    readRuns,
    pruneOlderThan,
    close,
    rootDir: () => rootDir,
  };
}
