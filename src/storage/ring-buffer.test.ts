import { describe, expect, it } from "vitest";
import { createEventBuffer } from "./ring-buffer.js";
import { makeEvent } from "../test-utils.js";

describe("event buffer", () => {
  it("retains events up to maxPerType per type", () => {
    const buffer = createEventBuffer({ maxPerType: 3 });
    for (let i = 0; i < 10; i += 1) {
      buffer.append(makeEvent("tool.execution.completed"));
    }
    expect(buffer.size()).toBe(3);
    expect(buffer.countsByType()["tool.execution.completed"]).toBe(10);
  });

  it("filters by type when requested", () => {
    const buffer = createEventBuffer({ maxPerType: 10 });
    buffer.append(makeEvent("model.call.completed"));
    buffer.append(makeEvent("tool.execution.completed"));
    buffer.append(makeEvent("model.call.completed"));
    expect(buffer.recent({ type: "model.call.completed" })).toHaveLength(2);
    expect(buffer.recent({ type: "tool.execution.completed" })).toHaveLength(1);
  });

  // Regression for v0.9.6 critical fix: the replay path in service.start
  // feeds events back into the buffer; pre-fix `append(event)` stamped
  // `Date.now()` instead of preserving the original capturedAt, so
  // historic errors rendered as "just now" on Logs / Overview after a
  // gateway restart. The append API now accepts the timestamp explicitly.
  it("preserves an explicit capturedAt on replay-style appends", () => {
    const buffer = createEventBuffer({ maxPerType: 10 });
    const historicMs = Date.now() - 6 * 60 * 60_000; // 6 hours ago
    buffer.append(makeEvent("model.call.error"), historicMs);
    const [captured] = buffer.recent({ type: "model.call.error" });
    expect(captured?.capturedAt).toBe(historicMs);
  });
});
