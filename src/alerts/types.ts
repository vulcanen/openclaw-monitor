// Alert engine type system.
//
// Configuration is loaded from `plugins.entries.openclaw-monitor.config.alerts`
// in the host config (i.e. ~/.openclaw/openclaw.json). The shape mirrors the
// JSON schema published in openclaw.plugin.json, so see that file for the
// authoritative defaults and the operator-facing description of each field.

import type { WindowSnapshot, WindowedMetrics } from "../types.js";

/**
 * The subset of WindowSnapshot we expose as alert-rule metric names. Every
 * field below is computed by the aggregator already; the engine just reads
 * the requested key out of the matching window snapshot.
 */
export type AlertMetric = keyof WindowSnapshot;

export const ALERT_METRICS: readonly AlertMetric[] = [
  "modelCalls",
  "modelErrors",
  "modelP95Ms",
  "toolExecs",
  "toolErrors",
  "toolBlocked",
  "messagesDelivered",
  "messageErrors",
  "webhookEvents",
  "webhookErrors",
  "sessionsAlerted",
] as const;

export type AlertWindow = keyof WindowedMetrics; // "1m" | "5m" | "15m" | "1h"

export type AlertOp = ">" | ">=" | "<" | "<=" | "==";

export type AlertSeverity = "info" | "warn" | "error";

export type AlertRuleConfig = {
  /** Stable identifier used for state and history correlation. */
  id: string;
  /** Human-readable name shown in notifications and the Alerts page. */
  name: string;
  /** Optional longer description; rendered in the notification body. */
  description?: string;
  metric: AlertMetric;
  window: AlertWindow;
  op: AlertOp;
  threshold: number;
  severity?: AlertSeverity;
  /**
   * Minimum seconds between repeated firing notifications for the same rule.
   * The engine still re-evaluates every cycle and updates the active alert's
   * `lastValue`, but it only re-notifies once per cooldown.
   * Default: 300s.
   */
  cooldownSec?: number;
  /** Channel IDs (keys from `alerts.channels`) to notify when this fires. */
  channels: string[];
  /**
   * When true (default) a resolved notification is sent the first cycle the
   * condition no longer holds. Set false for "fire only, never recover" rules.
   */
  notifyOnResolve?: boolean;
};

export type WebhookChannelConfig = {
  kind: "webhook";
  url: string;
  /** Extra headers to attach (auth token, custom JSON shape signal, …). */
  headers?: Record<string, string>;
};

export type DingTalkChannelConfig = {
  kind: "dingtalk";
  /** Full webhook URL incl. access_token, e.g.
   *  `https://oapi.dingtalk.com/robot/send?access_token=xxx`. */
  url: string;
  /**
   * Optional HMAC-SHA256 secret. When present we sign every request with a
   * `timestamp` + `sign` query parameter per DingTalk custom-robot docs.
   */
  secret?: string;
  /**
   * Optional mention list. Phone numbers get @-mentioned via `atMobiles`;
   * setting `atAll: true` mentions everyone in the group.
   */
  atMobiles?: string[];
  atAll?: boolean;
};

export type AlertChannelConfig = WebhookChannelConfig | DingTalkChannelConfig;

export type AlertsConfig = {
  enabled: boolean;
  /**
   * How often the engine re-evaluates rules against the current window
   * snapshot, in seconds. Lower = faster detection but more CPU; higher =
   * smoother but laggier. Default 30.
   */
  evaluationIntervalSec: number;
  channels: Record<string, AlertChannelConfig>;
  rules: AlertRuleConfig[];
};

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  enabled: false,
  evaluationIntervalSec: 30,
  channels: {},
  rules: [],
};

/**
 * Runtime state for one rule. Held in memory; recreated on plugin restart.
 * History is persisted via the in-memory ring buffer (see history.ts) and is
 * not durable — by design, alerts are an operational view, not an audit log.
 */
export type ActiveAlert = {
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: AlertMetric;
  window: AlertWindow;
  op: AlertOp;
  threshold: number;
  /** The most recent value observed for the rule's metric. */
  lastValue: number | null;
  /** When the rule first crossed the threshold this firing episode. */
  firedAt: string;
  /** Last time we actually pushed a notification for this firing. */
  lastNotifiedAt: string;
};

export type AlertEventType = "fired" | "renotified" | "resolved";

export type AlertHistoryEntry = {
  capturedAt: string;
  type: AlertEventType;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: AlertMetric;
  window: AlertWindow;
  op: AlertOp;
  threshold: number;
  value: number | null;
  /** Channels we tried to notify, with per-channel result. Empty for resolve
   *  events that don't trigger notifications. */
  notifications: Array<{
    channelId: string;
    kind: AlertChannelConfig["kind"];
    ok: boolean;
    error?: string;
  }>;
};

/**
 * Payload shape POSTed to webhook channels. Same shape is rendered into a
 * markdown card by the DingTalk channel adapter.
 */
export type AlertNotification = {
  type: AlertEventType;
  rule: {
    id: string;
    name: string;
    description?: string;
    severity: AlertSeverity;
  };
  metric: {
    name: AlertMetric;
    window: AlertWindow;
    op: AlertOp;
    threshold: number;
    value: number | null;
  };
  firedAt: string;
  capturedAt: string;
};
