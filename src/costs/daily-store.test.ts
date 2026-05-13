import { makeEvent } from "../test-utils.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("cost engine (v0.8)", () => {
  it("computeCost prices input/output/cache classes against the table", async () => {
    const { computeCost } = await import("./pricing.js");
    const price = { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.003 };
    const usage = {
      inputTokens: 1500,
      outputTokens: 500,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 100,
    };
    const c = computeCost(usage, price);
    expect(c.costInput).toBeCloseTo(0.0015, 6);
    expect(c.costOutput).toBeCloseTo(0.001, 6);
    expect(c.costCacheRead).toBeCloseTo(0.001, 6);
    expect(c.costCacheWrite).toBeCloseTo(0.0003, 6);
    expect(c.cost).toBeCloseTo(0.0038, 6);
  });

  it("computeCost returns zero for unknown models", async () => {
    const { computeCost } = await import("./pricing.js");
    const c = computeCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, undefined);
    expect(c.cost).toBe(0);
  });

  it("aggregator rolls up cost + tokens per model/channel/source on llm.tokens.recorded", async () => {
    const { createAggregator } = await import("../pipeline/aggregator.js");
    const agg = createAggregator();
    agg.ingest(
      makeEvent("llm.tokens.recorded" as never, {
        provider: "qwen",
        model: "q3-5",
        channel: "webchat",
        trigger: "user",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.0015,
      }),
      Date.now(),
    );
    const models = agg.models();
    const channels = agg.channels();
    const sources = agg.sources();
    expect(models[0]?.key).toBe("qwen/q3-5");
    expect(models[0]?.cost).toBeCloseTo(0.0015, 6);
    expect(models[0]?.tokensIn).toBe(1000);
    expect(channels[0]?.key).toBe("webchat");
    expect(channels[0]?.cost).toBeCloseTo(0.0015, 6);
    expect(sources[0]?.key).toBe("openai-api");
    expect(sources[0]?.cost).toBeCloseTo(0.0015, 6);
  });

  it("daily-cost readDay returns cached day when cost is 0 but tokens exist", async () => {
    // Bug fix: readDay previously returned undefined when cached.cost was
    // falsy, dropping legitimate token-only days (providers without a
    // pricing entry, or the 1-second pre-flush window).
    const { createDailyCostStore } = await import("./daily-store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cost-zero-"));
    try {
      const store = createDailyCostStore(dir);
      const ts = Date.UTC(2026, 4, 13);
      store.recordTokenEvent({
        type: "llm.tokens.recorded",
        provider: "p",
        model: "m",
        inputTokens: 100,
        outputTokens: 50,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        cost: 0, // unknown pricing → 0 cost but tokens > 0
        currency: "CNY",
        ts,
      });
      // Do NOT flush — exercise the cache-only readDay path.
      const today = store.readDay("2026-05-13");
      expect(today).toBeDefined();
      expect(today?.cost).toBe(0);
      expect(today?.tokensIn).toBe(100);
      expect(today?.tokensOut).toBe(50);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("daily-cost store persists across reopen + rangeSum sums day range", async () => {
    const { createDailyCostStore } = await import("./daily-store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cost-"));
    try {
      const store = createDailyCostStore(dir);
      const ts1 = Date.UTC(2026, 4, 11);
      const ts2 = Date.UTC(2026, 4, 12);
      for (const ts of [ts1, ts2]) {
        store.recordTokenEvent({
          type: "llm.tokens.recorded",
          provider: "p",
          model: "m",
          inputTokens: 100,
          outputTokens: 50,
          costInput: 0,
          costOutput: 0,
          costCacheRead: 0,
          costCacheWrite: 0,
          cost: 1,
          currency: "CNY",
          ts,
        });
      }
      store.flush();
      store.close();
      // Reopen and read back via rangeSum.
      const store2 = createDailyCostStore(dir);
      const range = store2.rangeSum("2026-05-11", "2026-05-12");
      expect(range.cost).toBeCloseTo(2, 6);
      expect(range.tokensIn).toBe(200);
      expect(range.tokensOut).toBe(100);
      const day12 = store2.readDay("2026-05-12");
      expect(day12?.byModel["p/m"]?.cost).toBeCloseTo(1, 6);
      store2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
