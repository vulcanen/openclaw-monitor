import type { Aggregator } from "../pipeline/aggregator.js";
import { dispatchNotification } from "./dispatcher.js";
import { createHistoryStore, type AlertHistoryStore } from "./history.js";
import type {
  ActiveAlert,
  AlertNotification,
  AlertOp,
  AlertRuleConfig,
  AlertsConfig,
} from "./types.js";

const DEFAULT_COOLDOWN_SEC = 300;
const DEFAULT_SEVERITY: ActiveAlert["severity"] = "warn";

export type AlertEngine = {
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
  /** Force one evaluation cycle synchronously. Used by tests. */
  evaluateNow: () => Promise<void>;
  active: () => ActiveAlert[];
  history: AlertHistoryStore;
  rules: () => AlertRuleConfig[];
  setConfig: (config: AlertsConfig) => void;
};

function compare(value: number, op: AlertOp, threshold: number): boolean {
  switch (op) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
    default:
      return false;
  }
}

function readMetric(
  windows: ReturnType<Aggregator["windows"]>,
  rule: AlertRuleConfig,
): number | null {
  const snap = windows[rule.window];
  if (!snap) return null;
  const raw = snap[rule.metric];
  if (typeof raw !== "number") return null;
  if (!Number.isFinite(raw)) return null;
  return raw;
}

export function createAlertEngine(params: {
  aggregator: Aggregator;
  initialConfig: AlertsConfig;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}): AlertEngine {
  let config = params.initialConfig;
  const history = createHistoryStore();
  /**
   * runtime state per rule id:
   *   - undefined  → rule has never fired (or has been resolved)
   *   - present    → rule is currently firing; lastNotifiedAt drives cooldown
   */
  const activeByRuleId = new Map<string, ActiveAlert>();
  let timer: NodeJS.Timeout | undefined;

  const evaluate = async (): Promise<void> => {
    if (!config.enabled) return;
    if (config.rules.length === 0) return;
    const windows = params.aggregator.windows();
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    for (const rule of config.rules) {
      const value = readMetric(windows, rule);
      const isFiring =
        value !== null && compare(value, rule.op, rule.threshold);
      const previous = activeByRuleId.get(rule.id);
      const severity = rule.severity ?? DEFAULT_SEVERITY;
      const cooldownMs = (rule.cooldownSec ?? DEFAULT_COOLDOWN_SEC) * 1000;

      if (isFiring) {
        if (!previous) {
          // ── First crossing: a fresh firing episode begins. ──
          const active: ActiveAlert = {
            ruleId: rule.id,
            ruleName: rule.name,
            severity,
            metric: rule.metric,
            window: rule.window,
            op: rule.op,
            threshold: rule.threshold,
            lastValue: value,
            firedAt: nowIso,
            lastNotifiedAt: nowIso,
          };
          activeByRuleId.set(rule.id, active);
          const payload = buildNotification("fired", rule, severity, value, nowIso, nowIso);
          const notifications = await dispatchNotification({
            channels: config.channels,
            channelIds: rule.channels,
            payload,
            ...(params.logger ? { logger: params.logger } : {}),
          });
          history.push({
            capturedAt: nowIso,
            type: "fired",
            ruleId: rule.id,
            ruleName: rule.name,
            severity,
            metric: rule.metric,
            window: rule.window,
            op: rule.op,
            threshold: rule.threshold,
            value,
            notifications,
          });
        } else {
          // ── Still firing; update lastValue, maybe re-notify after cooldown. ──
          previous.lastValue = value;
          const lastNotifiedMs = Date.parse(previous.lastNotifiedAt);
          if (Number.isFinite(lastNotifiedMs) && nowMs - lastNotifiedMs >= cooldownMs) {
            previous.lastNotifiedAt = nowIso;
            const payload = buildNotification(
              "renotified",
              rule,
              severity,
              value,
              previous.firedAt,
              nowIso,
            );
            const notifications = await dispatchNotification({
              channels: config.channels,
              channelIds: rule.channels,
              payload,
              ...(params.logger ? { logger: params.logger } : {}),
            });
            history.push({
              capturedAt: nowIso,
              type: "renotified",
              ruleId: rule.id,
              ruleName: rule.name,
              severity,
              metric: rule.metric,
              window: rule.window,
              op: rule.op,
              threshold: rule.threshold,
              value,
              notifications,
            });
          }
        }
      } else if (previous) {
        // ── Was firing, now back below threshold: send resolve and clear. ──
        activeByRuleId.delete(rule.id);
        const notifyOnResolve = rule.notifyOnResolve !== false;
        let notifications: ReturnType<typeof dispatchNotification> extends Promise<infer R>
          ? R
          : never = [];
        if (notifyOnResolve) {
          const payload = buildNotification(
            "resolved",
            rule,
            severity,
            value,
            previous.firedAt,
            nowIso,
          );
          notifications = await dispatchNotification({
            channels: config.channels,
            channelIds: rule.channels,
            payload,
            ...(params.logger ? { logger: params.logger } : {}),
          });
        }
        history.push({
          capturedAt: nowIso,
          type: "resolved",
          ruleId: rule.id,
          ruleName: rule.name,
          severity,
          metric: rule.metric,
          window: rule.window,
          op: rule.op,
          threshold: rule.threshold,
          value,
          notifications,
        });
      }
    }
    // Drop active alerts for rules that disappeared from config (silent
    // resolution — operator removed the rule, no notification needed).
    const liveIds = new Set(config.rules.map((r) => r.id));
    for (const id of Array.from(activeByRuleId.keys())) {
      if (!liveIds.has(id)) activeByRuleId.delete(id);
    }
  };

  return {
    start() {
      if (timer) return;
      const intervalMs = Math.max(5, config.evaluationIntervalSec) * 1000;
      timer = setInterval(() => {
        evaluate().catch((err) => {
          params.logger?.warn?.(`[alerts] evaluate failed: ${String(err)}`);
        });
      }, intervalMs);
      timer.unref?.();
      params.logger?.info?.(
        `[alerts] engine started: ${config.rules.length} rule(s), interval=${config.evaluationIntervalSec}s`,
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    isRunning() {
      return timer !== undefined;
    },
    async evaluateNow() {
      await evaluate();
    },
    active() {
      return Array.from(activeByRuleId.values());
    },
    history,
    rules() {
      return config.rules;
    },
    setConfig(next) {
      config = next;
    },
  };
}

function buildNotification(
  type: AlertNotification["type"],
  rule: AlertRuleConfig,
  severity: ActiveAlert["severity"],
  value: number | null,
  firedAt: string,
  capturedAt: string,
): AlertNotification {
  return {
    type,
    rule: {
      id: rule.id,
      name: rule.name,
      ...(rule.description !== undefined ? { description: rule.description } : {}),
      severity,
    },
    metric: {
      name: rule.metric,
      window: rule.window,
      op: rule.op,
      threshold: rule.threshold,
      value,
    },
    firedAt,
    capturedAt,
  };
}
