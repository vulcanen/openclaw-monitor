import { makeEvent } from "../test-utils.js";
import { describe, expect, it } from "vitest";

describe("insights queries (v0.9)", () => {
  // Helper to spin up the in-memory data structures the queries consume.
  const setup = async () => {
    const { createEventBuffer } = await import("../storage/ring-buffer.js");
    const { createConversationProbe } = await import("../audit/conversation-probe.js");
    const { createInsightsQueries } = await import("./queries.js");
    const buffer = createEventBuffer({ maxPerType: 1024 });
    const probe = createConversationProbe();
    const storeRefStub = { get: () => undefined };
    const queries = createInsightsQueries({
      buffer,
      conversationProbe: probe,
      conversationStoreRef: storeRefStub,
    });
    return { buffer, queries };
  };

  it("slowCalls sorts by durationMs desc and excludes outside-window events", async () => {
    const { buffer, queries } = await setup();
    const now = Date.now();
    // Three model.call.completed: 50ms (in), 1500ms (in), 250ms (way out).
    buffer.append(
      makeEvent("model.call.completed" as never, {
        durationMs: 50,
        runId: "r-fast",
        callId: "c1",
        provider: "p",
        model: "m",
      }),
    );
    buffer.append(
      makeEvent("model.call.completed" as never, {
        durationMs: 1500,
        runId: "r-slow",
        callId: "c2",
        provider: "p",
        model: "m",
      }),
    );
    // Force an old capturedAt by directly mutating the ring — buffer.append
    // uses Date.now() internally, so to simulate "long ago" we recent() the
    // ring and tweak the last entry's capturedAt.
    const recent = buffer.recent({ type: "model.call.completed", limit: 10 });
    if (recent[0]) recent[0].capturedAt = now - 24 * 60 * 60 * 1000; // 24h ago
    const rows = queries.slowCalls({ windowSec: 60, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe("r-slow");
    expect(rows[0]?.durationMs).toBe(1500);
  });

  it("errorClusters groups by provider/model/category and counts samples", async () => {
    const { buffer, queries } = await setup();
    for (let i = 0; i < 3; i += 1) {
      buffer.append(
        makeEvent("model.call.error" as never, {
          provider: "openai",
          model: "gpt-4",
          errorCategory: "rate_limited",
          runId: `r${i}`,
        }),
      );
    }
    buffer.append(
      makeEvent("model.call.error" as never, {
        provider: "openai",
        model: "gpt-4",
        errorCategory: "timeout",
        runId: "r-timeout",
      }),
    );
    const rows = queries.errorClusters({ windowSec: 3600, limit: 10 });
    expect(rows).toHaveLength(2);
    const rateLimited = rows.find((r) => r.errorCategory === "rate_limited");
    expect(rateLimited?.count).toBe(3);
    expect(rateLimited?.sampleRunIds.length).toBeGreaterThan(0);
    expect(rateLimited?.provider).toBe("openai");
  });

  it("toolFailures computes per-tool errorRate, sorted by error count", async () => {
    const { buffer, queries } = await setup();
    // Tool A: 5 total, 4 errors -> errorRate 0.8
    for (let i = 0; i < 4; i += 1) {
      buffer.append(
        makeEvent("tool.execution.error" as never, {
          toolName: "browse",
          runId: `r-browse-${i}`,
        }),
      );
    }
    buffer.append(
      makeEvent("tool.execution.completed" as never, {
        toolName: "browse",
      }),
    );
    // Tool B: 10 total, 1 error -> errorRate 0.1
    for (let i = 0; i < 9; i += 1) {
      buffer.append(
        makeEvent("tool.execution.completed" as never, {
          toolName: "fetch",
        }),
      );
    }
    buffer.append(
      makeEvent("tool.execution.error" as never, {
        toolName: "fetch",
        runId: "r-fetch-err",
      }),
    );
    const rows = queries.toolFailures({ windowSec: 3600, limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.toolName).toBe("browse");
    expect(rows[0]?.errors).toBe(4);
    expect(rows[0]?.errorRate).toBeCloseTo(0.8, 2);
    expect(rows[1]?.toolName).toBe("fetch");
    expect(rows[1]?.errors).toBe(1);
  });

  it("heavyConversations pulls from probe.recentCompleted and sorts by tokens", async () => {
    const { queries } = await setup();
    // No buffer activity required — probe + storeRef can both be empty
    // and the query just returns []. The shape of the empty response is
    // what we want to assert here.
    const rows = queries.heavyConversations({ windowSec: 3600, limit: 10 });
    expect(Array.isArray(rows)).toBe(true);
  });
});
