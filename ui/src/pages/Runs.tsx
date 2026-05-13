import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type RunSnapshot } from "../api.js";
import { Pagination } from "../components/Pagination.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

export function Runs() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();
  const [filter, setFilter] = useState<"" | RunSnapshot["status"]>("");
  // Fetch a larger slice for client paging; api.runs is capped at 500.
  const fetcher = useMemo(() => () => api.runs(500), []);
  const { data, error } = usePolling(fetcher, 5_000);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const statusTag = (status: RunSnapshot["status"]) => {
    const cls = status === "completed" ? "ok" : status === "active" ? "active" : "error";
    return <span className={`tag ${cls}`}>{t(`runs.status.${status}` as never)}</span>;
  };

  // Apply global time-window filter on startedAt. A run that started outside
  // the window is hidden — same semantics as Logs / Sessions.
  const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
  const rows = (data?.runs ?? [])
    .filter((run) => !filter || run.status === filter)
    .filter((run) => Date.parse(run.startedAt) >= cutoffMs);
  const safePage = rows.length === 0 ? 0 : Math.min(page, Math.floor((rows.length - 1) / pageSize));
  const pagedRows = rows.slice(safePage * pageSize, (safePage + 1) * pageSize);

  return (
    <div>
      <h2 className="page-title">{t("runs.title")}</h2>
      <div className="subtitle">
        {t("runs.subtitle", { active: data?.active ?? 0 })} · {t(`topbar.window.${timeWindow}`)}
      </div>

      <div className="toolbar">
        <label htmlFor="runs-status-filter">{t("runs.filter.status")}</label>
        <select
          id="runs-status-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
        >
          <option value="">{t("runs.status.all")}</option>
          <option value="active">{t("runs.status.active")}</option>
          <option value="completed">{t("runs.status.completed")}</option>
          <option value="error">{t("runs.status.error")}</option>
        </select>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            <div style={{ marginBottom: 12, fontSize: 14 }}>{t("empty.runs")}</div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: "var(--text-dim)" }}>
              <div style={{ marginBottom: 6 }}>
                <strong style={{ color: "var(--text)" }}>1.</strong> {t("empty.runs.hint.filter")}
              </div>
              <div style={{ marginBottom: 6 }}>
                <strong style={{ color: "var(--text)" }}>2.</strong>{" "}
                {t("empty.runs.hint.retention")}
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>3.</strong>{" "}
                {t("empty.runs.hint.noTraffic")}
              </div>
            </div>
          </div>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>{t("runs.col.runId")}</th>
                  <th>{t("runs.col.status")}</th>
                  <th>{t("runs.col.channel")}</th>
                  <th>{t("runs.col.started")}</th>
                  <th>{t("runs.col.duration")}</th>
                  <th className="num">{t("runs.col.modelCalls")}</th>
                  <th className="num">{t("runs.col.toolExecs")}</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((run) => (
                  <tr key={run.runId}>
                    <td>
                      <Link to={`/runs/${encodeURIComponent(run.runId)}`}>{run.runId}</Link>
                    </td>
                    <td>{statusTag(run.status)}</td>
                    <td>{run.channel ?? "—"}</td>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>{fmtDuration(run.durationMs)}</td>
                    <td className="num">{run.modelCalls}</td>
                    <td className="num">{run.toolExecs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              page={safePage}
              pageSize={pageSize}
              total={rows.length}
              onPageChange={setPage}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(0);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
