import { describe, expect, it } from "vitest";
import { extractSource } from "./extractors.js";

describe("extractSource", () => {
  // Common shape — host stamps OpenAI-compat HTTP runs with runId
  // "chatcmpl_*" inside the INTERNAL_MESSAGE_CHANNEL ("webchat").
  it("returns openai-api for webchat + chatcmpl_ runId", () => {
    expect(extractSource({ channel: "webchat", runId: "chatcmpl_abc123" })).toBe("openai-api");
  });

  it("returns control-ui for webchat + ctrl_ runId", () => {
    expect(extractSource({ channel: "webchat", runId: "ctrl_xyz" })).toBe("control-ui");
  });

  it("returns control-ui for webchat + trigger=channel-message", () => {
    expect(extractSource({ channel: "webchat", trigger: "channel-message" })).toBe("control-ui");
  });

  it("returns internal:<trigger> for webchat + trigger=heartbeat/cron/webhook", () => {
    expect(extractSource({ channel: "webchat", trigger: "heartbeat" })).toBe("internal:heartbeat");
    expect(extractSource({ channel: "webchat", trigger: "cron" })).toBe("internal:cron");
    expect(extractSource({ channel: "webchat", trigger: "webhook" })).toBe("internal:webhook");
  });

  it("returns openai-api for webchat + trigger=user", () => {
    expect(extractSource({ channel: "webchat", trigger: "user" })).toBe("openai-api");
  });

  it("returns channel:<name> for any non-webchat external channel plugin", () => {
    expect(extractSource({ channel: "telegram" })).toBe("channel:telegram");
    expect(extractSource({ channel: "discord" })).toBe("channel:discord");
  });

  // Regression for v0.9.7.3: the host occasionally sets ctx.channelId to
  // the literal trigger name ("heartbeat") instead of INTERNAL_MESSAGE_CHANNEL
  // ("webchat") for internal agent runs. Without this special case the
  // Sources page would show "channel:heartbeat" (and friendlyEntryLabel
  // would render it as "Channel: heartbeat") — misleading, since heartbeat
  // is an internal trigger, not a channel plugin.
  it("returns internal:<name> when the channel field is itself an internal trigger name", () => {
    expect(extractSource({ channel: "heartbeat" })).toBe("internal:heartbeat");
    expect(extractSource({ channel: "cron" })).toBe("internal:cron");
    expect(extractSource({ channel: "webhook" })).toBe("internal:webhook");
    // Trigger field, if present, doesn't override the channel-driven mapping.
    expect(extractSource({ channel: "heartbeat", trigger: "user" })).toBe("internal:heartbeat");
  });

  it("returns undefined when no channel info is present", () => {
    expect(extractSource({})).toBeUndefined();
  });
});
