import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type ErrorClusterRow,
  type HeavyConversationRow,
  type SlowCallRow,
  type ToolFailureRow,
} from "../api.js";
import { friendlyEntryLabel, inferEntryKey } from "../entry-label.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

function fmtMs(value: number): string {
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function fmtRelative(tsMs: number, now: number): string {
  const delta = Math.max(0, Math.round((now - tsMs) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return new Date(tsMs).toLocaleString();
}

function fmtBytes(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(2)}MB`;
}

function SampleRuns({ runIds, lastSeenMs }: { runIds: string[]; lastSeenMs?: number }) {
  if (runIds.length === 0) return <span>—</span>;
  const now = Date.now();
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
      {runIds.map((rid, idx) => (
        <span key={rid}>
          {idx > 0 ? ", " : ""}
          <Link to={`/runs/${encodeURIComponent(rid)}`}>{rid.slice(0, 12)}…</Link>
        </span>
      ))}
      {lastSeenMs !== undefined ? (
        // Cluster-level "last seen" tag (v0.9.7) — helps operators triage
        // "is this cluster still active?" without reading the lastSeenAt
        // column on the far side of the row. Per-sample timestamps would
        // require a backend shape change (currently sample IDs are bare
        // strings without per-id capturedAt); that's a follow-up.
        <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>
          · {fmtRelative(lastSeenMs, now)}
        </span>
      ) : null}
    </span>
  );
}

function SlowCallsPanel({ rows, loading }: { rows: SlowCallRow[]; loading: boolean }) {
  const { t } = useI18n();
  const now = Date.now();
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h3>{t("insights.section.slow")}</h3>
      {loading ? (
        <div className="empty">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{t("insights.empty.slow")}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th className="num">{t("insights.col.duration")}</th>
              <th>{t("insights.col.providerModel")}</th>
              <th>{t("insights.col.channel")}</th>
              <th className="num">{t("insights.col.respBytes")}</th>
              <th>{t("insights.col.when")}</th>
              <th>{t("insights.col.runId")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={`${r.runId}-${r.callId}-${idx}`}>
                <td className="num">{idx + 1}</td>
                <td className="num">{fmtMs(r.durationMs)}</td>
                <td>{`${r.provider ?? "?"}/${r.model ?? "?"}`}</td>
                <td
                  title={
                    r.channel === "webchat"
                      ? `host channel = "webchat" (INTERNAL_MESSAGE_CHANNEL). Display inferred from runId / trigger.`
                      : r.channel
                        ? `host channel = "${r.channel}"`
                        : undefined
                  }
                >
                  {(() => {
                    const key = inferEntryKey(r.channel, r.trigger, r.runId);
                    return key ? friendlyEntryLabel(t, key) : "—";
                  })()}
                </td>
                <td className="num">{fmtBytes(r.responseStreamBytes)}</td>
                <td>{fmtRelative(r.capturedAt, now)}</td>
                <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                  {r.runId ? (
                    <Link to={`/runs/${encodeURIComponent(r.runId)}`}>{r.runId.slice(0, 18)}…</Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HeavyConversationsPanel({
  rows,
  loading,
}: {
  rows: HeavyConversationRow[];
  loading: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h3>{t("insights.section.heavy")}</h3>
      {loading ? (
        <div className="empty">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{t("insights.empty.heavy")}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th className="num">{t("insights.col.tokensTotal")}</th>
              <th className="num">{t("insights.col.tokensIn")}</th>
              <th className="num">{t("insights.col.tokensOut")}</th>
              <th className="num">{t("insights.col.hops")}</th>
              <th>{t("insights.col.session")}</th>
              <th>{t("insights.col.runId")}</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // Pre-compute the page-max so we can render each row's
              // tokensTotal as a relative magnitude bar. Long-tail
              // distribution becomes visible immediately — much faster
              // than comparing column digits.
              const totals = rows.map((r) => r.totalTokensIn + r.totalTokensOut);
              const maxTotal = totals.length === 0 ? 0 : Math.max(...totals);
              return rows.map((r, idx) => {
                const total = r.totalTokensIn + r.totalTokensOut;
                const pct = maxTotal === 0 ? 0 : (total / maxTotal) * 100;
                return (
                  <tr key={r.runId}>
                    <td className="num">{idx + 1}</td>
                    <td className="num">
                      {total.toLocaleString()}
                      {total > 0 ? (
                        <span
                          className="mag-bar"
                          aria-hidden="true"
                          title={`${pct.toFixed(0)}% of page max`}
                        >
                          <span style={{ width: `${pct}%` }} />
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{r.totalTokensIn.toLocaleString()}</td>
                    <td className="num">{r.totalTokensOut.toLocaleString()}</td>
                    <td className="num">{r.llmHops}</td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                      {(r.sessionKey ?? "—").slice(0, 40)}
                    </td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                      <Link to={`/conversations/${encodeURIComponent(r.runId)}`}>
                        {r.runId.slice(0, 18)}…
                      </Link>
                    </td>
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ErrorClustersPanel({ rows, loading }: { rows: ErrorClusterRow[]; loading: boolean }) {
  const { t } = useI18n();
  const now = Date.now();
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h3>{t("insights.section.errors")}</h3>
      {loading ? (
        <div className="empty">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{t("insights.empty.errors")}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="num">{t("insights.col.count")}</th>
              <th>{t("insights.col.providerModel")}</th>
              <th>{t("insights.col.errorCategory")}</th>
              <th>{t("insights.col.lastSeen")}</th>
              <th>{t("insights.col.sampleRuns")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="num err">{r.count}</td>
                <td>{`${r.provider ?? "?"}/${r.model ?? "?"}`}</td>
                <td>{r.errorCategory ?? "—"}</td>
                <td>{fmtRelative(r.lastSeenAt, now)}</td>
                <td>
                  <SampleRuns runIds={r.sampleRunIds} lastSeenMs={r.lastSeenAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ToolFailuresPanel({ rows, loading }: { rows: ToolFailureRow[]; loading: boolean }) {
  const { t } = useI18n();
  const now = Date.now();
  return (
    <div className="panel">
      <h3>{t("insights.section.toolFailures")}</h3>
      {loading ? (
        <div className="empty">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{t("insights.empty.toolFailures")}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("insights.col.tool")}</th>
              <th className="num">{t("insights.col.errors")}</th>
              <th className="num">{t("insights.col.total")}</th>
              <th className="num">{t("insights.col.errorRate")}</th>
              <th>{t("insights.col.lastFailureAt")}</th>
              <th>{t("insights.col.sampleRuns")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.toolName}>
                <td>{r.toolName}</td>
                <td className="num err">{r.errors}</td>
                <td className="num">{r.total}</td>
                <td className="num err">{(r.errorRate * 100).toFixed(1)}%</td>
                <td>{r.lastFailureAt ? fmtRelative(r.lastFailureAt, now) : "—"}</td>
                <td>
                  <SampleRuns runIds={r.sampleRunIds} lastSeenMs={r.lastFailureAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Insights() {
  const { t } = useI18n();
  // Insights honors the global window selector exclusively now (v0.9.7.1).
  // The local per-page select used to live here as a fallback before the
  // global selector existed; consolidating means operators don't have to
  // remember which page has its own time control.
  const { window: timeWindow } = useTimeWindow();
  const windowSec = WINDOW_TO_SECONDS[timeWindow];
  const limit = 10;

  const slowFetcher = useMemo(() => () => api.insightsSlowCalls(windowSec, limit), [windowSec]);
  const heavyFetcher = useMemo(
    () => () => api.insightsHeavyConversations(windowSec, limit),
    [windowSec],
  );
  const errorsFetcher = useMemo(
    () => () => api.insightsErrorClusters(windowSec, limit),
    [windowSec],
  );
  const toolsFetcher = useMemo(() => () => api.insightsToolFailures(windowSec, limit), [windowSec]);

  const slow = usePolling(slowFetcher, 10_000);
  const heavy = usePolling(heavyFetcher, 10_000);
  const errors = usePolling(errorsFetcher, 10_000);
  const tools = usePolling(toolsFetcher, 10_000);

  return (
    <div>
      <h2 className="page-title">{t("insights.title")}</h2>
      <div className="subtitle">{t("insights.subtitleGlobal")}</div>

      <SlowCallsPanel rows={slow.data?.rows ?? []} loading={!slow.data} />
      <HeavyConversationsPanel rows={heavy.data?.rows ?? []} loading={!heavy.data} />
      <ErrorClustersPanel rows={errors.data?.rows ?? []} loading={!errors.data} />
      <ToolFailuresPanel rows={tools.data?.rows ?? []} loading={!tools.data} />
    </div>
  );
}
