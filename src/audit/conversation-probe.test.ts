import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { makeEvent } from "../test-utils.js";

describe("conversation probe", () => {
  type CapturedHandlers = Record<string, (event: unknown, ctx: unknown) => unknown>;

  const makeFakeApi = (
    handlers: CapturedHandlers,
    hostFlags: { auditEnabled?: boolean; allowConversationAccess?: boolean } = {},
  ) => {
    const audit = hostFlags.auditEnabled ?? true;
    const allow = hostFlags.allowConversationAccess ?? true;
    return {
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[name] = handler;
      },
      runtime: {
        config: {
          current: () => ({
            plugins: {
              entries: {
                "openclaw-monitor": {
                  hooks: { allowConversationAccess: allow },
                  config: { audit: { enabled: audit } },
                },
              },
            },
          }),
        },
      },
    };
  };

  it("ignores hook calls when disabled", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);
    handlers["llm_input"]?.(
      {
        runId: "r1",
        sessionId: "s1",
        provider: "p",
        model: "m",
        prompt: "hi",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "r1" },
    );
    handlers["agent_end"]?.({ runId: "r1", messages: [], success: true }, { runId: "r1" });
    expect(probe.activeCount()).toBe(0);
    expect(probe.recentCompleted()).toHaveLength(0);
  });

  it("does not register conversation hooks when host gates are off", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers, { allowConversationAccess: false }) as never);
    // before_prompt_build is non-gated, should always register
    expect(typeof handlers["before_prompt_build"]).toBe("function");
    // gated hooks should NOT register
    expect(handlers["llm_input"]).toBeUndefined();
    expect(handlers["llm_output"]).toBeUndefined();
    expect(handlers["agent_end"]).toBeUndefined();
  });

  it("does not register conversation hooks when audit is disabled in plugin config", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers, { auditEnabled: false }) as never);
    expect(typeof handlers["before_prompt_build"]).toBe("function");
    expect(handlers["llm_input"]).toBeUndefined();
  });

  it("accumulates 4 touchpoints and finalizes on agent_end", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: true,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    handlers["before_prompt_build"]?.(
      { prompt: "hello world", messages: [{ role: "user", content: "earlier" }] },
      { runId: "r1", sessionId: "s1", channelId: "openai", trigger: "openai-compat" },
    );
    expect(probe.activeCount()).toBe(1);

    handlers["llm_input"]?.(
      {
        runId: "r1",
        sessionId: "s1",
        provider: "openai",
        model: "gpt-4",
        systemPrompt: "you are helpful",
        prompt: "hello world",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "r1" },
    );
    handlers["llm_output"]?.(
      {
        runId: "r1",
        sessionId: "s1",
        provider: "openai",
        model: "gpt-4",
        assistantTexts: ["hi there"],
        usage: { input: 10, output: 5 },
      },
      { runId: "r1" },
    );
    handlers["agent_end"]?.(
      {
        runId: "r1",
        messages: [{ role: "assistant", content: "hi there" }],
        success: true,
        durationMs: 120,
      },
      { runId: "r1" },
    );

    expect(probe.activeCount()).toBe(0);
    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    const record = completed[0];
    expect(record?.inbound?.prompt).toBe("hello world");
    expect(record?.llmInputs).toHaveLength(1);
    expect(record?.llmInputs[0]?.systemPrompt).toBe("you are helpful");
    expect(record?.llmOutputs).toHaveLength(1);
    expect(record?.llmOutputs[0]?.assistantTexts).toEqual(["hi there"]);
    expect(record?.outbound?.success).toBe(true);
    expect(record?.status).toBe("completed");
    expect(record?.durationMs).toBe(120);
  });

  it("omits system prompt when captureSystemPrompt is false", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    handlers["llm_input"]?.(
      {
        runId: "r2",
        sessionId: "s2",
        provider: "openai",
        model: "gpt-4",
        systemPrompt: "secret system",
        prompt: "ask",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "r2" },
    );
    handlers["agent_end"]?.({ runId: "r2", messages: [], success: true }, { runId: "r2" });
    const record = probe.recentCompleted()[0];
    expect(record?.llmInputs[0]?.systemPrompt).toBeUndefined();
  });

  it("truncates long content beyond contentMaxBytes", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 64,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    const big = "x".repeat(500);
    handlers["llm_input"]?.(
      {
        runId: "r3",
        sessionId: "s3",
        provider: "openai",
        model: "gpt-4",
        prompt: big,
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "r3" },
    );
    handlers["agent_end"]?.({ runId: "r3", messages: [], success: true }, { runId: "r3" });
    const record = probe.recentCompleted()[0];
    expect(record?.llmInputs[0]?.prompt.length).toBeLessThan(big.length);
    expect(record?.llmInputs[0]?.truncated).toBe(true);
  });

  // Regression for v0.9.6 critical fix: truncateString used to combine
  // byte-length budget checking with UTF-16 code-unit slicing, badly
  // over-running the budget for multi-byte characters (CJK ≈ 3 bytes,
  // emoji ≈ 4) and potentially slicing a surrogate pair down the middle.
  // The fix slices in the byte domain via Buffer.subarray which auto-
  // discards trailing partial UTF-8 sequences.
  it("truncates multi-byte UTF-8 content within the byte budget", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      // 64 bytes is enough for ~21 CJK chars; with the old slice-by-char
      // logic at the same budget the result would be ~64 chars (~192 bytes).
      contentMaxBytes: 64,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    const cjk = "测试".repeat(50); // 100 chars × 3 bytes = 300 bytes
    handlers["llm_input"]?.(
      {
        runId: "utf8-test",
        sessionId: "s-utf8",
        provider: "openai",
        model: "gpt-4",
        prompt: cjk,
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "utf8-test" },
    );
    handlers["agent_end"]?.(
      { runId: "utf8-test", messages: [], success: true },
      { runId: "utf8-test" },
    );
    const record = probe.recentCompleted()[0];
    const truncated = record?.llmInputs[0]?.prompt ?? "";
    expect(record?.llmInputs[0]?.truncated).toBe(true);
    // Within budget (+ small ellipsis allowance) — the bug had it at
    // ~3× the budget.
    expect(Buffer.byteLength(truncated, "utf-8")).toBeLessThanOrEqual(96);
    // No lone surrogates / replacement chars produced by a mid-character slice.
    expect(truncated).not.toMatch(/�/);
  });

  // Regression for v0.9.6 high-priority fix: channel-only flows can leave
  // a record in state.active indefinitely if message_sending never fires
  // (sender disconnects, host crashes mid-run). Memory grows unbounded.
  // The sweeper finalizes records that haven't been touched in
  // ABANDON_TTL_MS as status="abandoned".
  it("sweeper finalizes abandoned active conversations", async () => {
    vi.useFakeTimers();
    try {
      const { createConversationProbe } = await import("./conversation-probe.js");
      const probe = createConversationProbe();
      probe.setConfig({
        enabled: true,
        contentMaxBytes: 1024,
        retainDays: 3,
        captureSystemPrompt: false,
      });
      const handlers: CapturedHandlers = {};
      probe.installHooks(makeFakeApi(handlers) as never);
      handlers["message_received"]?.(
        { sessionKey: "stuck:user1", content: "hello" },
        { sessionKey: "stuck:user1", channelId: "telegram" },
      );
      expect(probe.activeCount()).toBe(1);
      // Advance system time past the abandoned TTL (30 minutes).
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const swept = probe.sweepAbandonedNow();
      expect(swept).toBe(1);
      expect(probe.activeCount()).toBe(0);
      const finalized = probe.recentCompleted()[0];
      expect(finalized?.status).toBe("abandoned");
      expect(finalized?.errorMessage).toMatch(/abandoned/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures Control-UI style flow via message_received + message_sending alone", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    // Simulate a Control UI message: only channel-side message_received/sending fire,
    // no before_prompt_build / llm_input / agent_end.
    handlers["message_received"]?.(
      { from: "user", content: "查一下订单", sessionKey: "s-control-1" },
      { channelId: "control-ui", sessionKey: "s-control-1" },
    );
    handlers["message_sending"]?.(
      { to: "user", content: "今天有 5 笔订单。" },
      { channelId: "control-ui", sessionKey: "s-control-1" },
    );

    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.inbound?.prompt).toBe("查一下订单");
    const out = completed[0]?.outbound?.messages?.[0] as { content?: string };
    expect(out?.content).toBe("今天有 5 笔订单。");
    expect(completed[0]?.llmInputs).toHaveLength(0);
    expect(completed[0]?.trigger).toBe("channel-message");
  });

  it("captures Control-UI-style flow from message.queued + message.processed diagnostic events", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    // Diagnostic-event path: no hooks involved — Control UI doesn't fire
    // message_received/sending nor before_prompt_build.
    const queued = makeEvent("message.queued", {
      sessionKey: "ctrl-session-1",
      channel: "dashboard",
      source: "control-ui",
    });
    const processed = makeEvent("message.processed", {
      sessionKey: "ctrl-session-1",
      channel: "dashboard",
      durationMs: 420,
      outcome: "completed",
    });
    probe.ingestDiagnosticEvent(queued, Date.now());
    probe.ingestDiagnosticEvent(processed, Date.now() + 420);
    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.channelId).toBe("dashboard");
    expect(completed[0]?.trigger).toBe("diag:control-ui");
    expect(completed[0]?.status).toBe("completed");
    expect(completed[0]?.durationMs).toBe(420);
  });

  it("does not duplicate-record sessions that already have a hook-driven conversation", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);
    // Hook fires first (channel plugin path)
    handlers["message_received"]?.(
      { from: "user", content: "hi", sessionKey: "hybrid-1" },
      { channelId: "telegram", sessionKey: "hybrid-1" },
    );
    expect(probe.activeCount()).toBe(1);
    // Now diagnostic event arrives for the same session — should be ignored
    probe.ingestDiagnosticEvent(
      makeEvent("message.queued", {
        sessionKey: "hybrid-1",
        channel: "telegram",
        source: "channel",
      }),
      Date.now(),
    );
    // Still just one record, not duplicated
    expect(probe.activeCount()).toBe(1);
  });

  it("merges message_received with later before_prompt_build/llm_input via sessionKey", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    // 1. channel message arrives (only sessionKey, no runId yet)
    handlers["message_received"]?.(
      { from: "user", content: "hi", sessionKey: "s-merge-1" },
      { channelId: "control-ui", sessionKey: "s-merge-1" },
    );
    expect(probe.activeCount()).toBe(1);

    // 2. agent harness starts with real runId, same sessionKey
    handlers["before_prompt_build"]?.(
      { prompt: "hi", messages: [] },
      { runId: "real-run-1", sessionKey: "s-merge-1" },
    );
    // Should still be 1 record (merged via sessionKey), not 2
    expect(probe.activeCount()).toBe(1);

    handlers["llm_input"]?.(
      {
        runId: "real-run-1",
        sessionId: "s-merge-1",
        provider: "openai",
        model: "gpt-4",
        prompt: "hi",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "real-run-1", sessionKey: "s-merge-1" },
    );
    handlers["agent_end"]?.(
      { runId: "real-run-1", messages: [], success: true },
      { runId: "real-run-1", sessionKey: "s-merge-1" },
    );

    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.llmInputs).toHaveLength(1);
  });

  it("llm_input does not pollute sessionKey with sessionId (decision #18 regression guard)", async () => {
    // PluginHookLlmInputEvent has only `sessionId`, not `sessionKey`. The
    // previous bug read event.sessionId into a variable named `sessionKey`,
    // which corrupted state.bySessionKey and broke conversation grouping.
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    // Channel msg arrives first with the *real* sessionKey
    handlers["message_received"]?.(
      { from: "user", content: "hello", sessionKey: "real-session-key" },
      { channelId: "ctrl", sessionKey: "real-session-key" },
    );
    // llm_input fires with sessionId that is DIFFERENT from sessionKey
    handlers["llm_input"]?.(
      {
        runId: "rk",
        sessionId: "OPAQUE_INTERNAL_ID_NOT_EQUAL_TO_SESSION_KEY",
        provider: "openai",
        model: "gpt-4",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "rk", sessionKey: "real-session-key" },
    );
    handlers["agent_end"]?.(
      { runId: "rk", messages: [], success: true },
      { runId: "rk", sessionKey: "real-session-key" },
    );

    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    // The persisted record's sessionKey must be the real key, not the
    // opaque sessionId from the event.
    expect(completed[0]?.sessionKey).toBe("real-session-key");
  });

  it("agent_end preserves outbound captured by message_sending (no LLM-output duplication)", async () => {
    // Bug fix: agent_end used to unconditionally overwrite record.outbound
    // with the full conversation snapshot, duplicating LLM-output content
    // into the OpenClaw→sender section. Now agent_end keeps the cleaner
    // message_sending reply and just updates success/status/durationMs.
    const { createConversationProbe } = await import("./conversation-probe.js");
    const probe = createConversationProbe();
    probe.setConfig({
      enabled: true,
      contentMaxBytes: 16384,
      retainDays: 3,
      captureSystemPrompt: false,
    });
    const handlers: CapturedHandlers = {};
    probe.installHooks(makeFakeApi(handlers) as never);

    handlers["message_received"]?.(
      { from: "u", content: "ask", sessionKey: "sX" },
      { channelId: "ctrl", sessionKey: "sX" },
    );
    handlers["before_prompt_build"]?.(
      { prompt: "ask", messages: [] },
      { runId: "rX", sessionKey: "sX" },
    );
    handlers["llm_input"]?.(
      {
        runId: "rX",
        sessionId: "sid",
        provider: "openai",
        model: "gpt-4",
        prompt: "ask",
        historyMessages: [],
        imagesCount: 0,
      },
      { runId: "rX", sessionKey: "sX" },
    );
    handlers["llm_output"]?.(
      {
        runId: "rX",
        sessionId: "sid",
        provider: "openai",
        model: "gpt-4",
        assistantTexts: ["FINAL_REPLY"],
      },
      { runId: "rX", sessionKey: "sX" },
    );
    handlers["message_sending"]?.(
      { content: "FINAL_REPLY", to: "u" },
      { runId: "rX", sessionKey: "sX" },
    );
    // agent_end fires AFTER message_sending and should NOT replace the
    // outbound payload with the full messages snapshot.
    handlers["agent_end"]?.(
      {
        runId: "rX",
        messages: [
          { role: "system", content: "secret system prompt" },
          { role: "user", content: "ask" },
          { role: "assistant", content: "FINAL_REPLY" },
        ],
        success: true,
        durationMs: 99,
      },
      { runId: "rX", sessionKey: "sX" },
    );

    const completed = probe.recentCompleted();
    expect(completed).toHaveLength(1);
    const rec = completed[0];
    expect(rec?.outbound?.messages).toHaveLength(1);
    expect((rec?.outbound?.messages[0] as { content?: string })?.content).toBe("FINAL_REPLY");
    expect(rec?.status).toBe("completed");
    expect(rec?.durationMs).toBe(99);
    // v0.9.4 regression: in channel-based flows the record starts with a
    // synthetic ctrl_* runId minted by message_received. Without runId
    // promotion in findOrCreateRecord, the llm_output handler's runId-only
    // lookup misses the record and llmOutputs stays empty — the LLM→OpenClaw
    // section renders blank even though the hook fired with content.
    expect(rec?.llmInputs).toHaveLength(1);
    expect(rec?.llmOutputs).toHaveLength(1);
    expect(rec?.llmOutputs[0]?.assistantTexts).toEqual(["FINAL_REPLY"]);
    // runId should be the real harness runId, not the ctrl_* placeholder.
    expect(rec?.runId).toBe("rX");
  });

  it("persists a completed conversation to the store", async () => {
    const { createConversationProbe } = await import("./conversation-probe.js");
    const { createConversationStore } = await import("./conversation-store.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-audit-test-"));
    try {
      const store = createConversationStore(dir);
      const probe = createConversationProbe();
      probe.setConfig({
        enabled: true,
        contentMaxBytes: 1024,
        retainDays: 3,
        captureSystemPrompt: false,
      });
      probe.setStore(store);
      const handlers: CapturedHandlers = {};
      probe.installHooks(makeFakeApi(handlers) as never);

      handlers["llm_input"]?.(
        {
          runId: "rp",
          sessionId: "sp",
          provider: "openai",
          model: "gpt-4",
          prompt: "hi",
          historyMessages: [],
          imagesCount: 0,
        },
        { runId: "rp" },
      );
      handlers["agent_end"]?.({ runId: "rp", messages: [], success: true }, { runId: "rp" });

      const persisted = store.list({ limit: 10 });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.runId).toBe("rp");
      const full = store.get("rp");
      expect(full?.llmInputs[0]?.prompt).toBe("hi");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
