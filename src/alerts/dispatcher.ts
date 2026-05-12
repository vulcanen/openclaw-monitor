import type {
  AlertChannelConfig,
  AlertHistoryEntry,
  AlertNotification,
} from "./types.js";
import { sendDingTalk } from "./channels/dingtalk.js";
import { sendWebhook } from "./channels/webhook.js";

export type DispatchResult = AlertHistoryEntry["notifications"];

/**
 * Fan out a single AlertNotification to every channel a rule names. Failures
 * are recorded per-channel and returned to the engine for history; we never
 * throw out of here so a flaky webhook doesn't block the engine's evaluation
 * loop or skip remaining channels.
 */
export async function dispatchNotification(params: {
  channels: Record<string, AlertChannelConfig>;
  channelIds: string[];
  payload: AlertNotification;
  logger?: { warn?: (msg: string) => void };
}): Promise<DispatchResult> {
  const results: DispatchResult = [];
  for (const channelId of params.channelIds) {
    const channel = params.channels[channelId];
    if (!channel) {
      results.push({
        channelId,
        kind: "webhook",
        ok: false,
        error: "channel not configured",
      });
      params.logger?.warn?.(`[alerts] channel "${channelId}" not configured`);
      continue;
    }
    try {
      if (channel.kind === "webhook") {
        await sendWebhook(channel, params.payload);
      } else if (channel.kind === "dingtalk") {
        await sendDingTalk(channel, params.payload);
      } else {
        throw new Error(`unknown channel kind: ${(channel as { kind: string }).kind}`);
      }
      results.push({ channelId, kind: channel.kind, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ channelId, kind: channel.kind, ok: false, error: message });
      params.logger?.warn?.(
        `[alerts] channel "${channelId}" (${channel.kind}) send failed: ${message}`,
      );
    }
  }
  return results;
}
