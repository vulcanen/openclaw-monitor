import { useMemo } from "react";
import {
  api,
  type ActiveAlert,
  type AlertHistoryEntry,
  type AlertRule,
  type AlertSeverity,
} from "../api.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

function severityTag(severity: AlertSeverity) {
  const cls = severity === "error" ? "error" : severity === "warn" ? "warn" : "active";
  return <span className={`tag ${cls}`}>{severity}</span>;
}

function fmtRuleExpr(rule: Pick<AlertRule, "metric" | "op" | "threshold" | "window">): string {
  return `${rule.metric} ${rule.op} ${rule.threshold} (${rule.window})`;
}

function fmtRelative(iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const deltaSec = Math.max(0, Math.round((now - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: 3,
        marginRight: 6,
        background: ok ? "var(--good)" : "var(--error)",
      }}
    />
  );
}

export function Alerts() {
  const { t } = useI18n();
  const rulesFetcher = useMemo(() => api.alertsRules, []);
  const activeFetcher = useMemo(() => api.alertsActive, []);
  const historyFetcher = useMemo(() => () => api.alertsHistory(200), []);
  const { data: rulesData, error: rulesError } = usePolling(rulesFetcher, 10_000);
  const { data: activeData } = usePolling(activeFetcher, 5_000);
  const { data: historyData } = usePolling(historyFetcher, 5_000);

  const now = Date.now();
  const rules = rulesData?.rules ?? [];
  // Wrap fallback in useMemo so the `[]` literal isn't a fresh reference on
  // every render — otherwise activeByRule below recomputes every tick.
  const active: ActiveAlert[] = useMemo(() => activeData?.active ?? [], [activeData]);
  const history: AlertHistoryEntry[] = historyData?.entries ?? [];
  const running = rulesData?.running ?? false;

  // Per-rule active map for quick lookup in the Rules table.
  const activeByRule = useMemo(() => {
    const m = new Map<string, ActiveAlert>();
    for (const a of active) m.set(a.ruleId, a);
    return m;
  }, [active]);

  const firedLast24h = history.filter((h) => h.type === "fired").length;
  const resolvedLast24h = history.filter((h) => h.type === "resolved").length;

  return (
    <div>
      <h2 className="page-title">{t("alerts.title")}</h2>
      <div className="subtitle">
        {t("alerts.subtitle", {
          state: running ? t("alerts.state.running") : t("alerts.state.disabled"),
          activeCount: active.length,
          firedCount: firedLast24h,
        })}
      </div>

      {rulesError ? <div className="error-banner">{rulesError}</div> : null}

      {!running ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="empty" style={{ padding: 24 }}>
            <div style={{ marginBottom: 12, fontSize: 14 }}>{t("alerts.disabled")}</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
              {t("alerts.disabledHint")}
            </div>
          </div>
        </div>
      ) : null}

      <div
        className="panel"
        style={{
          marginBottom: 16,
          // When alerts are firing, give the panel an unmistakable
          // left-border accent so operators glancing at the page can
          // instantly see "something is on fire" — visual weight should
          // match operational severity (UI rule "color is not the only
          // indicator" is preserved: the table content carries the signal,
          // the border is reinforcement).
          ...(active.length > 0 ? { borderLeft: "3px solid var(--error)" } : {}),
        }}
      >
        <h3>{t("alerts.section.active")}</h3>
        {active.length === 0 ? (
          <div className="empty">{t("alerts.empty.active")}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("alerts.col.severity")}</th>
                <th>{t("alerts.col.rule")}</th>
                <th>{t("alerts.col.ruleExpr")}</th>
                <th className="num">{t("alerts.col.value")}</th>
                <th>{t("alerts.col.firedAt")}</th>
                <th>{t("alerts.col.lastNotified")}</th>
              </tr>
            </thead>
            <tbody>
              {active.map((a) => (
                <tr key={a.ruleId}>
                  <td>{severityTag(a.severity)}</td>
                  <td>{a.ruleName}</td>
                  <td>{fmtRuleExpr(a)}</td>
                  <td className="num">{a.lastValue ?? "—"}</td>
                  <td>{fmtRelative(a.firedAt, now)}</td>
                  <td>{fmtRelative(a.lastNotifiedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>{t("alerts.section.rules")}</h3>
        {rules.length === 0 ? (
          <div className="empty">{t("alerts.empty.rules")}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("alerts.col.id")}</th>
                <th>{t("alerts.col.name")}</th>
                <th>{t("alerts.col.severity")}</th>
                <th>{t("alerts.col.rule")}</th>
                <th>{t("alerts.col.channels")}</th>
                <th>{t("alerts.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const isActive = activeByRule.has(rule.id);
                return (
                  <tr key={rule.id}>
                    <td>{rule.id}</td>
                    <td>{rule.name}</td>
                    <td>{severityTag(rule.severity ?? "warn")}</td>
                    <td>{fmtRuleExpr(rule)}</td>
                    <td>{rule.channels.join(", ")}</td>
                    <td>
                      <StatusDot ok={!isActive} />
                      {isActive ? t("alerts.status.firing") : t("alerts.status.ok")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>
          {t("alerts.section.history")}{" "}
          <span
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: "none",
              marginLeft: 8,
            }}
          >
            {t("alerts.history.note", {
              firedCount: firedLast24h,
              resolvedCount: resolvedLast24h,
            })}
          </span>
        </h3>
        {history.length === 0 ? (
          <div className="empty">{t("alerts.empty.history")}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("alerts.col.when")}</th>
                <th>{t("alerts.col.event")}</th>
                <th>{t("alerts.col.severity")}</th>
                <th>{t("alerts.col.rule")}</th>
                <th className="num">{t("alerts.col.value")}</th>
                <th>{t("alerts.col.notifyResults")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry, idx) => {
                const allOk =
                  entry.notifications.length === 0 || entry.notifications.every((n) => n.ok);
                return (
                  <tr key={`${entry.capturedAt}-${idx}`}>
                    <td>{fmtRelative(entry.capturedAt, now)}</td>
                    <td>
                      <span className={`tag ${entry.type === "resolved" ? "ok" : "warn"}`}>
                        {entry.type}
                      </span>
                    </td>
                    <td>{severityTag(entry.severity)}</td>
                    <td>
                      {entry.ruleName} · {fmtRuleExpr(entry)}
                    </td>
                    <td className="num">{entry.value ?? "—"}</td>
                    <td>
                      <StatusDot ok={allOk} />
                      {entry.notifications.length === 0
                        ? "—"
                        : entry.notifications
                            .map((n) => `${n.channelId}:${n.ok ? "ok" : `fail(${n.error ?? "?"})`}`)
                            .join("; ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
