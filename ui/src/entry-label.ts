import type { TranslateFn } from "./i18n/index.js";

/**
 * Translate a raw entry identifier — either the host's `channel` field
 * (always "webchat" for internal entries) or the technical source id the
 * aggregator produces ("openai-api" / "control-ui" / "channel:telegram" /
 * "internal:heartbeat") — into a human-friendly label.
 *
 * Used by Channels / Sources / Conversations pages so an operator sees
 * "OpenAI API" rather than "openai-api" or "webchat". The raw value is
 * preserved as a tooltip on the row for debugging.
 *
 * Why this lives in /ui rather than the backend: i18n is a UI concern;
 * REST responses keep the stable technical ids so external API
 * consumers can correlate without parsing labels.
 */
export function friendlyEntryLabel(t: TranslateFn, rawKey: string): string {
  if (rawKey === "openai-api") return t("entryLabel.openaiApi");
  if (rawKey === "control-ui") return t("entryLabel.controlUi");
  if (rawKey === "webchat") return t("entryLabel.webchatGeneric");
  if (rawKey.startsWith("internal:")) {
    const trigger = rawKey.slice("internal:".length);
    return t("entryLabel.internalWithTrigger", { trigger });
  }
  if (rawKey.startsWith("webchat:")) {
    const trigger = rawKey.slice("webchat:".length);
    return t("entryLabel.webchatWithTrigger", { trigger });
  }
  if (rawKey.startsWith("channel:")) {
    const name = rawKey.slice("channel:".length);
    return t("entryLabel.channelPlugin", { name });
  }
  return rawKey;
}

/**
 * Like extractSource on the backend but applied at the UI layer when we
 * only have the raw channel + trigger + runId (e.g. on a conversation
 * row, where the source dimension isn't pre-computed). Mirrors
 * src/pipeline/extractors.ts: extractSource so the two stay aligned.
 */
export function inferEntryKey(
  channelId: string | undefined,
  trigger: string | undefined,
  runId: string | undefined,
): string | undefined {
  if (!channelId) return undefined;
  if (channelId !== "webchat") return `channel:${channelId}`;
  if (runId?.startsWith("ctrl_")) return "control-ui";
  if (runId?.startsWith("chatcmpl_")) return "openai-api";
  if (trigger === "channel-message") return "control-ui";
  if (trigger === "heartbeat" || trigger === "cron" || trigger === "webhook") {
    return `internal:${trigger}`;
  }
  if (trigger === "user") return "openai-api";
  return trigger ? `webchat:${trigger}` : "webchat";
}
