import { createHmac } from "node:crypto";
import type { AlertNotification, DingTalkChannelConfig } from "../types.js";
import { assertSafeChannelUrl } from "./url-guard.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * DingTalk custom robot adapter.
 *
 * Two security modes per DingTalk docs
 * (https://open.dingtalk.com/document/orgapp/custom-robot-access):
 *   1. "Keyword" mode — operator must include a configured keyword in the
 *      message. We embed the rule name in the title, which by convention
 *      is what most operators set as their keyword.
 *   2. "Signed" mode — when `secret` is set, we append
 *      `timestamp=<ms>&sign=<base64-hmac-sha256>` query params.
 * The third mode ("IP allowlist") needs no client-side cooperation.
 *
 * Message body is a `markdown` card so the alert renders with bold severity,
 * the metric expression and a timestamp; phone numbers in `atMobiles` get
 * @-mentioned via `at.atMobiles`.
 */

function signRequest(url: string, secret: string): string {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = createHmac("sha256", secret).update(stringToSign).digest("base64");
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

function severityEmoji(severity: AlertNotification["rule"]["severity"]): string {
  // Emoji is intentional here — DingTalk markdown cards in the mobile app
  // render plain text without color; emoji is the only severity signal that
  // shows up reliably. This is an *output to a chat tool*, not in-product UI,
  // so the "no emoji icons" CLAUDE.md rule (UI #2) doesn't apply.
  if (severity === "error") return "🔴";
  if (severity === "warn") return "🟡";
  return "🔵";
}

function renderMarkdown(payload: AlertNotification): { title: string; text: string } {
  const verb =
    payload.type === "fired"
      ? "fired"
      : payload.type === "renotified"
        ? "still firing"
        : "resolved";
  const emoji = severityEmoji(payload.rule.severity);
  const title = `[OpenClaw] ${emoji} ${payload.rule.name} ${verb}`;
  const metricExpr = `${payload.metric.name} ${payload.metric.op} ${payload.metric.threshold} (${payload.metric.window})`;
  const valueLine =
    payload.metric.value === null
      ? "current value: —"
      : `current value: **${payload.metric.value}**`;
  const lines = [
    `### ${emoji} ${payload.rule.name}`,
    "",
    `**status**: ${verb}`,
    `**severity**: ${payload.rule.severity}`,
    `**rule**: \`${metricExpr}\``,
    valueLine,
    `**fired at**: ${payload.firedAt}`,
  ];
  if (payload.rule.description) {
    lines.push("", payload.rule.description);
  }
  return { title, text: lines.join("\n") };
}

export async function sendDingTalk(
  config: DingTalkChannelConfig,
  payload: AlertNotification,
): Promise<void> {
  assertSafeChannelUrl(config.url, {
    ...(config.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
  });
  const url = config.secret ? signRequest(config.url, config.secret) : config.url;
  const { title, text } = renderMarkdown(payload);
  const body: Record<string, unknown> = {
    msgtype: "markdown",
    markdown: { title, text },
  };
  if (config.atMobiles?.length || config.atAll) {
    body.at = {
      ...(config.atMobiles?.length ? { atMobiles: config.atMobiles } : {}),
      ...(config.atAll ? { isAtAll: true } : {}),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`dingtalk ${config.url} responded ${res.status}`) as Error & {
        code: string;
        httpStatus: number;
      };
      err.code = "DINGTALK_HTTP_ERROR";
      err.httpStatus = res.status;
      throw err;
    }
    // DingTalk returns 200 even on logical failures (e.g. keyword missing).
    // The body has { errcode, errmsg }; surface non-zero errcode as a thrown
    // error so the dispatcher records the failure in alert history. The
    // `code` field is the DingTalk errcode (number-as-string) so callers
    // can match specific failure shapes — `310000` for signature
    // mismatch, `300001` for missing keyword, etc.
    const data = (await res.json().catch(() => undefined)) as
      | { errcode?: number; errmsg?: string }
      | undefined;
    if (data && typeof data.errcode === "number" && data.errcode !== 0) {
      const err = new Error(
        `dingtalk errcode=${data.errcode} errmsg=${data.errmsg ?? ""}`,
      ) as Error & { code: string; dingTalkErrCode: number };
      err.code = "DINGTALK_API_ERROR";
      err.dingTalkErrCode = data.errcode;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

// Exposed for unit testing — signature shape is otherwise hidden behind fetch.
export const __testing = { signRequest, renderMarkdown };
