import type { AlertNotification, WebhookChannelConfig } from "../types.js";
import { assertSafeChannelUrl } from "./url-guard.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Generic webhook channel: POSTs the AlertNotification payload as JSON.
 *
 * The receiver gets a stable, documented shape (see AlertNotification in
 * `../types.ts`); this is the lowest-common-denominator integration for any
 * incident system that can accept a generic JSON webhook (Slack via
 * `chat.postMessage`, custom incident bots, n8n, Zapier, etc.).
 */
export async function sendWebhook(
  config: WebhookChannelConfig,
  payload: AlertNotification,
): Promise<void> {
  assertSafeChannelUrl(config.url, {
    ...(config.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`webhook ${config.url} responded ${res.status}`) as Error & {
        code: string;
        httpStatus: number;
      };
      err.code = "WEBHOOK_HTTP_ERROR";
      err.httpStatus = res.status;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}
