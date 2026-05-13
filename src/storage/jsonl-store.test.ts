import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsonlStore } from "./jsonl-store.js";
import { makeEvent } from "../test-utils.js";

describe("jsonl store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-monitor-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends and reads events back", () => {
    const store = createJsonlStore(dir);
    const now = Date.now();
    store.appendEvent(makeEvent("model.call.completed", { model: "x" }), now);
    store.appendEvent(makeEvent("model.call.error", { model: "y" }), now + 1);
    store.close();
    const reread = createJsonlStore(dir);
    const all = reread.readEvents({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all[0]?.event.type).toBe("model.call.completed");
    const errors = reread.readEvents({ limit: 10, type: "model.call.error" });
    expect(errors).toHaveLength(1);
    reread.close();
  });

  it("appends and reads runs", () => {
    const store = createJsonlStore(dir);
    store.appendRun({
      runId: "abc",
      status: "completed",
      startedAt: new Date().toISOString(),
      modelCalls: 1,
      toolExecs: 0,
    });
    const runs = store.readRuns({ limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("abc");
    store.close();
  });

  it("prunes runs older than retention window", () => {
    const store = createJsonlStore(dir);
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const fresh = new Date().toISOString();
    store.appendRun({
      runId: "old",
      status: "completed",
      startedAt: old,
      modelCalls: 0,
      toolExecs: 0,
    });
    store.appendRun({
      runId: "fresh",
      status: "completed",
      startedAt: fresh,
      modelCalls: 0,
      toolExecs: 0,
    });
    const result = store.pruneOlderThan({ eventsDays: 7, runsDays: 30 });
    expect(result.runsTrimmed).toBe(1);
    const remaining = store.readRuns({ limit: 10 });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.runId).toBe("fresh");
    store.close();
  });
});
