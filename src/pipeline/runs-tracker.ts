import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { RunSnapshot } from "../types.js";
import { extractDimensions, isHarnessRunEvent } from "./extractors.js";

const MAX_ACTIVE_RUNS = 256;
const MAX_FINISHED_IN_MEMORY = 256;

export type RunsTracker = {
  ingest: (event: DiagnosticEventPayload, capturedAtMs: number) => RunSnapshot | undefined;
  active: () => RunSnapshot[];
  recent: () => RunSnapshot[];
  reset: () => void;
};

type ActiveRun = RunSnapshot & {
  startedAtMs: number;
};

export function createRunsTracker(opts?: {
  onComplete?: (snap: RunSnapshot) => void;
}): RunsTracker {
  const active = new Map<string, ActiveRun>();
  const finished: RunSnapshot[] = [];

  const ingest: RunsTracker["ingest"] = (event, capturedAtMs) => {
    const dims = extractDimensions(event);

    if (event.type.startsWith("model.call.")) {
      if (dims.runId) {
        const run = active.get(dims.runId);
        if (run) run.modelCalls += 1;
      }
      return undefined;
    }
    if (event.type.startsWith("tool.execution.")) {
      if (dims.runId) {
        const run = active.get(dims.runId);
        if (run) run.toolExecs += 1;
      }
      return undefined;
    }
    if (!isHarnessRunEvent(event) || !dims.runId) {
      return undefined;
    }

    const runId = dims.runId;

    if (event.type === "harness.run.started") {
      if (active.size >= MAX_ACTIVE_RUNS) {
        const oldest = active.keys().next().value;
        if (oldest) active.delete(oldest);
      }
      const snap: ActiveRun = {
        runId,
        ...(dims.sessionId ? { sessionId: dims.sessionId } : {}),
        ...(dims.sessionKey ? { sessionKey: dims.sessionKey } : {}),
        ...(dims.channel ? { channel: dims.channel } : {}),
        ...(dims.trigger ? { trigger: dims.trigger } : {}),
        status: "active",
        startedAt: new Date(capturedAtMs).toISOString(),
        startedAtMs: capturedAtMs,
        modelCalls: 0,
        toolExecs: 0,
      };
      active.set(runId, snap);
      return undefined;
    }

    if (
      event.type === "harness.run.completed" ||
      event.type === "harness.run.error"
    ) {
      const run = active.get(runId);
      if (!run) return undefined;
      const ended = capturedAtMs;
      const finalSnap: RunSnapshot = {
        runId: run.runId,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        ...(run.sessionKey !== undefined ? { sessionKey: run.sessionKey } : {}),
        ...(run.channel !== undefined ? { channel: run.channel } : {}),
        ...(run.trigger !== undefined ? { trigger: run.trigger } : {}),
        status: event.type === "harness.run.error" ? "error" : "completed",
        startedAt: run.startedAt,
        endedAt: new Date(ended).toISOString(),
        durationMs: ended - run.startedAtMs,
        ...(dims.errorMessage !== undefined ? { errorMessage: dims.errorMessage } : {}),
        modelCalls: run.modelCalls,
        toolExecs: run.toolExecs,
      };
      active.delete(runId);
      finished.push(finalSnap);
      if (finished.length > MAX_FINISHED_IN_MEMORY) {
        finished.shift();
      }
      opts?.onComplete?.(finalSnap);
      return finalSnap;
    }

    return undefined;
  };

  const activeList: RunsTracker["active"] = () => {
    const out: RunSnapshot[] = [];
    for (const run of active.values()) {
      const { startedAtMs: _ignore, ...rest } = run;
      void _ignore;
      out.push(rest);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  };

  const recent: RunsTracker["recent"] = () => [...finished].reverse();

  const reset: RunsTracker["reset"] = () => {
    active.clear();
    finished.length = 0;
  };

  return { ingest, active: activeList, recent, reset };
}
