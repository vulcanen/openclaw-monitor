import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type RunSnapshot } from "../api.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

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
  const [filter, setFilter] = useState<"" | RunSnapshot["status"]>("");
  const { data, error } = usePolling(() => api.runs(100), 5_000);

  const statusTag = (status: RunSnapshot["status"]) => {
    const cls = status === "completed" ? "ok" : status === "active" ? "active" : "error";
    return <span className={`tag ${cls}`}>{t(`runs.status.${status}` as never)}</span>;
  };

  const rows = (data?.runs ?? []).filter((run) => !filter || run.status === filter);

  return (
    <div>
      <h2 className="page-title">{t("runs.title")}</h2>
      <div className="subtitle">
        {t("runs.subtitle", { active: data?.active ?? 0 })}
      </div>

      <div className="toolbar">
        <label>{t("runs.filter.status")}</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="">{t("runs.status.all")}</option>
          <option value="active">{t("runs.status.active")}</option>
          <option value="completed">{t("runs.status.completed")}</option>
          <option value="error">{t("runs.status.error")}</option>
        </select>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty">{t("empty.runs")}</div>
        ) : (
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
              {rows.map((run) => (
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
        )}
      </div>
    </div>
  );
}
