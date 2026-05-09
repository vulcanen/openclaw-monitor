import type { JsonlStore } from "./jsonl-store.js";

export type RetentionScheduler = {
  start: () => void;
  stop: () => void;
};

const ONE_HOUR_MS = 60 * 60 * 1000;

export function createRetentionScheduler(params: {
  store: JsonlStore;
  eventsDays: number;
  runsDays: number;
  intervalMs?: number;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}): RetentionScheduler {
  const interval = params.intervalMs ?? ONE_HOUR_MS;
  let timer: NodeJS.Timeout | undefined;

  const runOnce = (): void => {
    try {
      const { eventFilesDeleted, runsTrimmed } = params.store.pruneOlderThan({
        eventsDays: params.eventsDays,
        runsDays: params.runsDays,
      });
      if (eventFilesDeleted > 0 || runsTrimmed > 0) {
        params.logger?.info?.(
          `[openclaw-monitor] retention: deleted ${eventFilesDeleted} event files, trimmed ${runsTrimmed} runs`,
        );
      }
    } catch (err) {
      params.logger?.warn?.(`[openclaw-monitor] retention failed: ${String(err)}`);
    }
  };

  const start: RetentionScheduler["start"] = () => {
    if (timer) return;
    runOnce();
    timer = setInterval(runOnce, interval);
    timer.unref?.();
  };

  const stop: RetentionScheduler["stop"] = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return { start, stop };
}
