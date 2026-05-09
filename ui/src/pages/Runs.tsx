import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type RunSnapshot } from "../api.js";
import { usePolling } from "../hooks.js";

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function statusTag(status: RunSnapshot["status"]) {
  const cls = status === "completed" ? "ok" : status === "active" ? "active" : "error";
  return <span className={`tag ${cls}`}>{status}</span>;
}

export function Runs() {
  const [filter, setFilter] = useState<"" | RunSnapshot["status"]>("");
  const { data, error } = usePolling(() => api.runs(100), 5_000);

  const rows = (data?.runs ?? []).filter((run) => !filter || run.status === filter);

  return (
    <div>
      <h2 className="page-title">Runs</h2>
      <div className="subtitle">
        harness runs · {data?.active ?? 0} active · drill into a run for full event timeline
      </div>

      <div className="toolbar">
        <label>status</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="">all</option>
          <option value="active">active</option>
          <option value="completed">completed</option>
          <option value="error">error</option>
        </select>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty">no runs match</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>run id</th>
                <th>status</th>
                <th>channel</th>
                <th>started</th>
                <th>duration</th>
                <th className="num">model calls</th>
                <th className="num">tool execs</th>
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
