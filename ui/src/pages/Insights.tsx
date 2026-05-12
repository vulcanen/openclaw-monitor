import { useMemo, useState } from "react";
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

const WINDOW_OPTIONS: Array<{ value: number; key: string }> = [
  { value: 15 * 60, key: "insights.window.15m" },
  { value: 60 * 60, key: "insights.window.1h" },
  { value: 6 * 60 * 60, key: "insights.window.6h" },
  { value: 24 * 60 * 60, key: "insights.window.24h" },
];

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

function SampleRuns({ runIds }: { runIds: string[] }) {
  if (runIds.length === 0) return <span>—</span>;
  return (
    <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
      {runIds.map((rid, idx) => (
        <span key={rid}>
          {idx > 0 ? ", " : ""}
          <Link to={`/runs/${encodeURIComponent(rid)}`}>{rid.slice(0, 12)}…</Link>
        </span>
      ))}
    </span>
  );
}

function SlowCallsPanel({
  rows,
  loading,
}: {
  rows: SlowCallRow[];
  loading: boolean;
}) {
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
                    <Link to={`/runs/${encodeURIComponent(r.runId)}`}>
                      {r.runId.slice(0, 18)}…
                    </Link>
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
            {rows.map((r, idx) => {
              const total = r.totalTokensIn + r.totalTokensOut;
              return (
                <tr key={r.runId}>
                  <td className="num">{idx + 1}</td>
                  <td className="num">{total.toLocaleString()}</td>
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
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ErrorClustersPanel({
  rows,
  loading,
}: {
  rows: ErrorClusterRow[];
  loading: boolean;
}) {
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
                  <SampleRuns runIds={r.sampleRunIds} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ToolFailuresPanel({
  rows,
  loading,
}: {
  rows: ToolFailureRow[];
  loading: boolean;
}) {
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
                  <SampleRuns runIds={r.sampleRunIds} />
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
  const [windowSec, setWindowSec] = useState<number>(15 * 60);
  const limit = 10;

  const slowFetcher = useMemo(
    () => () => api.insightsSlowCalls(windowSec, limit),
    [windowSec],
  );
  const heavyFetcher = useMemo(
    () => () => api.insightsHeavyConversations(windowSec, limit),
    [windowSec],
  );
  const errorsFetcher = useMemo(
    () => () => api.insightsErrorClusters(windowSec, limit),
    [windowSec],
  );
  const toolsFetcher = useMemo(
    () => () => api.insightsToolFailures(windowSec, limit),
    [windowSec],
  );

  const slow = usePolling(slowFetcher, 10_000);
  const heavy = usePolling(heavyFetcher, 10_000);
  const errors = usePolling(errorsFetcher, 10_000);
  const tools = usePolling(toolsFetcher, 10_000);

  return (
    <div>
      <h2 className="page-title">{t("insights.title")}</h2>
      <div className="subtitle">{t("insights.subtitle")}</div>

      <div className="toolbar">
        <label>{t("insights.window.label")}</label>
        <select
          value={windowSec}
          onChange={(e) => setWindowSec(Number.parseInt(e.target.value, 10))}
        >
          {WINDOW_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.key as never)}
            </option>
          ))}
        </select>
      </div>

      <SlowCallsPanel rows={slow.data?.rows ?? []} loading={!slow.data} />
      <HeavyConversationsPanel
        rows={heavy.data?.rows ?? []}
        loading={!heavy.data}
      />
      <ErrorClustersPanel rows={errors.data?.rows ?? []} loading={!errors.data} />
      <ToolFailuresPanel rows={tools.data?.rows ?? []} loading={!tools.data} />
    </div>
  );
}
