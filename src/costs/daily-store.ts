import fs from "node:fs";
import path from "node:path";
import type { CostRangeSummary, TokenRecordedEvent } from "./types.js";

const FILENAME_RE = /^daily-costs-(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Per-day cost aggregate persisted to disk so today's / this-week's /
 * this-month's totals survive process restarts.
 *
 * Storage layout: one file per UTC day,
 *   <root>/daily-costs-YYYY-MM-DD.json
 * with a single JSON object representing the entire day's rollup:
 *   { day, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, cost,
 *     byModel: { "qwen/q3-5": {tokensIn, tokensOut, ..., cost}, ... } }
 *
 * We rewrite the file each flush (small object, single writeFileSync) rather
 * than append-and-replay; cost rollups are pure addition so the file is
 * always a complete snapshot of the day-to-date totals. This trades a few
 * I/O ops for a tiny, easy-to-debug on-disk format and trivial retention.
 *
 * `events*.jsonl` already preserves every llm.tokens.recorded event in
 * the host event store, so this file is *secondary* — losing it just
 * costs you the persistent today/week/month numbers; replay-from-events
 * is a future feature, not a hard dependency.
 */

export type DailyCostFile = {
  day: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  /** Per `provider/model` key, same shape used by the Models page. */
  byModel: Record<
    string,
    {
      tokensIn: number;
      tokensOut: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      cost: number;
    }
  >;
};

export type DailyCostStore = {
  recordTokenEvent: (event: TokenRecordedEvent) => void;
  flush: () => void;
  /** Read raw rollup for one day (UTC YYYY-MM-DD). undefined when missing. */
  readDay: (day: string) => DailyCostFile | undefined;
  /** Iterate the most recent `n` days back from today (UTC), oldest first. */
  recentDays: (n: number) => DailyCostFile[];
  /** Sum a closed UTC day range [fromDay, toDay], inclusive. */
  rangeSum: (fromDay: string, toDay: string) => CostRangeSummary;
  /** Drop files older than `retainDays` days. */
  pruneOlderThan: (retainDays: number) => { filesDeleted: number };
  close: () => void;
};

const dayStampUTC = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const emptySummary = (): CostRangeSummary => ({
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
});

const emptyDay = (day: string): DailyCostFile => ({
  day,
  ...emptySummary(),
  byModel: {},
});

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
}

export function createDailyCostStore(rootDir: string): DailyCostStore {
  ensureDir(rootDir);

  // In-memory cache keyed by day. Reads pull from here first; writes mark
  // a day dirty for the next flush.
  const cache = new Map<string, DailyCostFile>();
  const dirty = new Set<string>();
  // Auto-flush debounce: every recordTokenEvent schedules a flush 1s out.
  // The plugin's stop() path calls flush() synchronously to drain.
  let flushTimer: NodeJS.Timeout | undefined;

  const filePath = (day: string): string => path.join(rootDir, `daily-costs-${day}.json`);

  const load = (day: string): DailyCostFile => {
    const cached = cache.get(day);
    if (cached) return cached;
    const file = filePath(day);
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8");
        const parsed = JSON.parse(raw) as DailyCostFile;
        cache.set(day, parsed);
        return parsed;
      }
    } catch {
      // Corrupt file — start fresh for the day rather than crash the
      // engine. The lost numbers will be regenerated as new events arrive.
    }
    const fresh = emptyDay(day);
    cache.set(day, fresh);
    return fresh;
  };

  const flushDay = (day: string): void => {
    const data = cache.get(day);
    if (!data) return;
    try {
      fs.writeFileSync(filePath(day), JSON.stringify(data));
    } catch {
      // best-effort persistence; in-memory data still serves reads until
      // the next successful write
    }
  };

  const flush: DailyCostStore["flush"] = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    for (const day of dirty) flushDay(day);
    dirty.clear();
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flush();
    }, 1000);
    flushTimer.unref?.();
  };

  const recordTokenEvent: DailyCostStore["recordTokenEvent"] = (event) => {
    const day = dayStampUTC(event.ts ?? Date.now());
    const data = load(day);
    data.tokensIn += event.inputTokens;
    data.tokensOut += event.outputTokens;
    data.cacheReadTokens += event.cacheReadTokens ?? 0;
    data.cacheWriteTokens += event.cacheWriteTokens ?? 0;
    data.cost += event.cost;
    const modelKey = `${event.provider ?? "unknown"}/${event.model ?? "unknown"}`;
    const m = data.byModel[modelKey] ?? {
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    };
    m.tokensIn += event.inputTokens;
    m.tokensOut += event.outputTokens;
    m.cacheReadTokens += event.cacheReadTokens ?? 0;
    m.cacheWriteTokens += event.cacheWriteTokens ?? 0;
    m.cost += event.cost;
    data.byModel[modelKey] = m;
    dirty.add(day);
    scheduleFlush();
  };

  const readDay: DailyCostStore["readDay"] = (day) => {
    const file = filePath(day);
    if (!fs.existsSync(file)) {
      // In-memory days before the 1s flush, OR providers with no pricing
      // entry (tokens > 0 but cost === 0). Returning by truthiness of `cost`
      // would drop legitimate token-only days; return the cached snapshot
      // whenever it exists.
      return cache.get(day);
    }
    return load(day);
  };

  const listDayFiles = (): string[] => {
    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      const out: string[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = FILENAME_RE.exec(entry.name);
        if (!match) continue;
        out.push(match[1]);
      }
      // Folded any in-memory day not yet flushed.
      for (const day of cache.keys()) {
        if (!out.includes(day)) out.push(day);
      }
      out.sort();
      return out;
    } catch {
      return Array.from(cache.keys()).sort();
    }
  };

  const recentDays: DailyCostStore["recentDays"] = (n) => {
    const days = listDayFiles();
    const tail = days.slice(-Math.max(0, n));
    return tail.map((day) => load(day));
  };

  const rangeSum: DailyCostStore["rangeSum"] = (fromDay, toDay) => {
    const summary = emptySummary();
    for (const day of listDayFiles()) {
      if (day < fromDay || day > toDay) continue;
      const data = load(day);
      summary.tokensIn += data.tokensIn;
      summary.tokensOut += data.tokensOut;
      summary.cacheReadTokens += data.cacheReadTokens;
      summary.cacheWriteTokens += data.cacheWriteTokens;
      summary.cost += data.cost;
    }
    return summary;
  };

  const pruneOlderThan: DailyCostStore["pruneOlderThan"] = (retainDays) => {
    const cutoff = Date.now() - retainDays * 86_400_000;
    const cutoffDay = dayStampUTC(cutoff);
    let filesDeleted = 0;
    for (const day of listDayFiles()) {
      if (day >= cutoffDay) continue;
      try {
        fs.unlinkSync(filePath(day));
        filesDeleted += 1;
        cache.delete(day);
        dirty.delete(day);
      } catch {
        // best-effort
      }
    }
    return { filesDeleted };
  };

  const close: DailyCostStore["close"] = () => {
    flush();
  };

  return {
    recordTokenEvent,
    flush,
    readDay,
    recentDays,
    rangeSum,
    pruneOlderThan,
    close,
  };
}

/** Helpers exported for the costs handler + tests. */
export const dailyCostHelpers = {
  dayStampUTC,
  weekStartUTC(now: Date): string {
    // ISO-ish: week starts on Monday in UTC. Simple Date math: get
    // the UTC weekday (0=Sun..6=Sat), shift back to Monday.
    const d = new Date(now);
    const weekday = d.getUTCDay(); // Sun=0
    const offset = weekday === 0 ? 6 : weekday - 1;
    d.setUTCDate(d.getUTCDate() - offset);
    return dayStampUTC(d.getTime());
  },
  monthStartUTC(now: Date): string {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  },
};
