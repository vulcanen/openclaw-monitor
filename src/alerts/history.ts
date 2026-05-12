import type { AlertHistoryEntry } from "./types.js";

const DEFAULT_LIMIT = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type AlertHistoryStore = {
  push: (entry: AlertHistoryEntry) => void;
  list: (limit?: number) => AlertHistoryEntry[];
  size: () => number;
  clear: () => void;
};

/**
 * In-memory ring buffer for alert events. By design this is *not* persisted —
 * alert history is an operational signal (recent fires, recent resolves), not
 * an audit log. For long-term retention an operator should ship the webhook
 * payload to their incident system or SIEM. Capped at 200 entries OR 24h,
 * whichever is shorter.
 */
export function createHistoryStore(limit = DEFAULT_LIMIT): AlertHistoryStore {
  const cap = Math.max(10, Math.min(limit, 2000));
  let entries: AlertHistoryEntry[] = [];

  const evictExpired = (now: number): void => {
    const cutoff = now - MAX_AGE_MS;
    while (entries.length > 0 && Date.parse(entries[0].capturedAt) < cutoff) {
      entries.shift();
    }
  };

  return {
    push(entry) {
      evictExpired(Date.now());
      entries.push(entry);
      if (entries.length > cap) {
        entries.splice(0, entries.length - cap);
      }
    },
    list(limit) {
      evictExpired(Date.now());
      const n = Math.max(1, Math.min(limit ?? cap, cap));
      return entries.slice(-n).reverse();
    },
    size() {
      evictExpired(Date.now());
      return entries.length;
    },
    clear() {
      entries = [];
    },
  };
}
