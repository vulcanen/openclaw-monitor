import { makeEvent } from "../test-utils.js";
import { describe, expect, it, vi } from "vitest";

describe("alert engine (v0.7)", () => {
  const setup = async () => {
    const { createAggregator } = await import("../pipeline/aggregator.js");
    const { createAlertEngine } = await import("./engine.js");
    const { DEFAULT_ALERTS_CONFIG } = await import("./types.js");
    const aggregator = createAggregator();
    return { aggregator, createAlertEngine, DEFAULT_ALERTS_CONFIG };
  };

  // Replace global fetch with a recorder so dispatcher integration runs end-
  // to-end without actually hitting the network. We assert the rule lifecycle
  // through the recorded call list.
  const installFetchRecorder = () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const original = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      return new Response("{}", { status: 200 });
    };
    return {
      calls,
      restore: () => {
        (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
      },
    };
  };

  it("fires once when a metric crosses the threshold and stays quiet during cooldown", async () => {
    const { aggregator, createAlertEngine } = await setup();
    // Force the aggregator into "10 model errors in 5m": ingest 10 error events.
    for (let i = 0; i < 10; i += 1) {
      aggregator.ingest(makeEvent("model.call.error", { errorCategory: "rate-limit" }), Date.now());
    }
    const recorder = installFetchRecorder();
    const engine = createAlertEngine({
      aggregator,
      initialConfig: {
        enabled: true,
        evaluationIntervalSec: 30,
        channels: { hook: { kind: "webhook", url: "https://example.test/hook" } },
        rules: [
          {
            id: "r1",
            name: "errors high",
            metric: "modelErrors",
            window: "5m",
            op: ">",
            threshold: 5,
            channels: ["hook"],
            cooldownSec: 600,
          },
        ],
      },
    });
    try {
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(1);
      expect(recorder.calls).toHaveLength(1);
      const first = recorder.calls[0]?.body as { type: string };
      expect(first?.type).toBe("fired");

      // Second cycle within cooldown: re-evaluation must NOT re-notify.
      await engine.evaluateNow();
      expect(recorder.calls).toHaveLength(1);
    } finally {
      recorder.restore();
    }
  });

  it("emits a resolved event when the metric goes back under threshold", async () => {
    const { aggregator, createAlertEngine } = await setup();
    for (let i = 0; i < 10; i += 1) {
      aggregator.ingest(makeEvent("model.call.error"), Date.now());
    }
    const recorder = installFetchRecorder();
    const engine = createAlertEngine({
      aggregator,
      initialConfig: {
        enabled: true,
        evaluationIntervalSec: 30,
        channels: { hook: { kind: "webhook", url: "https://example.test/hook" } },
        rules: [
          {
            id: "r1",
            name: "errors high",
            metric: "modelErrors",
            window: "1h",
            op: ">",
            threshold: 5,
            channels: ["hook"],
            cooldownSec: 600,
          },
        ],
      },
    });
    try {
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(1);
      // Reset aggregator state so the metric drops to 0.
      aggregator.reset();
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(0);
      const types = recorder.calls.map((c) => (c.body as { type: string }).type);
      expect(types).toEqual(["fired", "resolved"]);
      const hist = engine.history.list();
      const histTypes = hist.map((h) => h.type);
      expect(histTypes).toContain("fired");
      expect(histTypes).toContain("resolved");
    } finally {
      recorder.restore();
    }
  });

  it("webhook channel rejects private-network URLs by default (v0.9.2)", async () => {
    const { sendWebhook } = await import("./channels/webhook.js");
    for (const bad of [
      "http://127.0.0.1/hook",
      "http://10.0.0.5/hook",
      "http://192.168.1.1/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost:9090/hook",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      let thrown: unknown;
      try {
        await sendWebhook({ kind: "webhook", url: bad }, {
          type: "fired",
          rule: { id: "x", name: "x", severity: "info" },
          metric: { name: "modelCalls", window: "1m", op: ">", threshold: 0, value: 1 },
          firedAt: "",
          capturedAt: "",
        } as never);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
    }
    // allowPrivateNetwork opt-in should NOT reject the URL on the guard.
    // We use a fetch recorder so the request itself stays in-process.
    const original = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
      new Response("{}", { status: 200 });
    try {
      await sendWebhook(
        { kind: "webhook", url: "http://127.0.0.1/hook", allowPrivateNetwork: true },
        {
          type: "fired",
          rule: { id: "x", name: "x", severity: "info" },
          metric: { name: "modelCalls", window: "1m", op: ">", threshold: 0, value: 1 },
          firedAt: "",
          capturedAt: "",
        } as never,
      );
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
    }
  });

  // Regression for v0.9.6 high-priority fix: the previous textual regex
  // patterns over-matched any hostname *starting* with the IPv4 octet
  // string. `127.example.com` and `10gen.net` would be rejected as
  // private, breaking legitimate webhook endpoints. The guard now only
  // applies IPv4 patterns when the hostname actually parses as IPv4.
  it("url-guard does not over-match domains that look like IPv4 prefixes", async () => {
    const { assertSafeChannelUrl } = await import("./channels/url-guard.js");
    for (const good of [
      "https://127.example.com/hook",
      "https://10gen.net/hook",
      "https://172.18.foo.bar/hook",
      "https://192.168.example.org/hook",
    ]) {
      expect(() => assertSafeChannelUrl(good), `expected ${good} to be allowed`).not.toThrow();
    }
  });

  // Regression for v0.9.6 high-priority fix: 0.0.0.0/8 is the
  // "CURRENT-NETWORK" reserved block; Linux routes any address in this
  // range to localhost. The previous guard only matched the literal
  // `0.0.0.0` so `0.1.2.3` slipped through.
  it("url-guard rejects the entire 0.0.0.0/8 range", async () => {
    const { assertSafeChannelUrl } = await import("./channels/url-guard.js");
    for (const bad of ["http://0.0.0.0/hook", "http://0.1.2.3/hook"]) {
      expect(() => assertSafeChannelUrl(bad), `expected ${bad} to be rejected`).toThrow();
    }
  });

  it("url-guard rejects IPv6-mapped IPv4 loopback (SSRF bypass fix)", async () => {
    // Bug fix: literal regex list previously missed `::ffff:x.x.x.x` which
    // WHATWG URL parsers do NOT normalize back to dotted-quad. Without an
    // explicit pattern http://[::ffff:127.0.0.1]/ bypassed the IPv4 rules.
    const { assertSafeChannelUrl } = await import("./channels/url-guard.js");
    for (const bad of [
      "http://[::ffff:127.0.0.1]/hook",
      "http://[::ffff:10.0.0.1]/hook",
      "http://[::ffff:169.254.169.254]/latest/meta-data",
      "http://[::127.0.0.1]/hook", // IPv4-compatible IPv6
    ]) {
      let thrown: unknown;
      try {
        assertSafeChannelUrl(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `expected ${bad} to be rejected`).toBeDefined();
    }
    // opt-in still works
    expect(() =>
      assertSafeChannelUrl("http://[::ffff:127.0.0.1]/hook", { allowPrivateNetwork: true }),
    ).not.toThrow();
  });

  it("dingtalk channel signs the request when a secret is configured", async () => {
    const { __testing } = await import("./channels/dingtalk.js");
    const url = "https://oapi.dingtalk.com/robot/send?access_token=abc";
    const signed = __testing.signRequest(url, "SEC_test_secret");
    expect(signed).toMatch(/&timestamp=\d+/);
    expect(signed).toMatch(/&sign=/);
    // sign is URL-encoded base64; can't be empty.
    const signValue = new URL(signed).searchParams.get("sign");
    expect(signValue && signValue.length > 0).toBe(true);
  });

  it("does not fire when the engine is disabled even with crossing metrics", async () => {
    const { aggregator, createAlertEngine } = await setup();
    for (let i = 0; i < 10; i += 1) {
      aggregator.ingest(makeEvent("model.call.error"), Date.now());
    }
    const recorder = installFetchRecorder();
    const engine = createAlertEngine({
      aggregator,
      initialConfig: {
        enabled: false,
        evaluationIntervalSec: 30,
        channels: { hook: { kind: "webhook", url: "https://example.test/hook" } },
        rules: [
          {
            id: "r1",
            name: "errors high",
            metric: "modelErrors",
            window: "5m",
            op: ">",
            threshold: 5,
            channels: ["hook"],
          },
        ],
      },
    });
    try {
      await engine.evaluateNow();
      expect(engine.active()).toHaveLength(0);
      expect(recorder.calls).toHaveLength(0);
    } finally {
      recorder.restore();
    }
  });
});
