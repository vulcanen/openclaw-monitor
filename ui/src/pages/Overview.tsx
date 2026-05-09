import { api } from "../api.js";
import { StatCard } from "../components/StatCard.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";

function fmtMs(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "0%";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

export function Overview() {
  const { data, error } = usePolling(api.overview, 5_000);

  if (error) return <div className="error-banner">overview load failed: {error}</div>;
  if (!data) return <div className="empty">loading…</div>;

  const fiveMin = data.windows["5m"];
  const oneMin = data.windows["1m"];

  return (
    <div>
      <h2 className="page-title">Overview</h2>
      <div className="subtitle">
        snapshot generated {new Date(data.generatedAt).toLocaleTimeString()} ·{" "}
        {data.bufferedEvents} events buffered
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatCard
          label="model calls (1m)"
          value={oneMin.modelCalls}
          delta={`${oneMin.modelErrors} errors`}
          tone={oneMin.modelErrors > 0 ? "bad" : "neutral"}
        />
        <StatCard
          label="error rate (5m)"
          value={pct(fiveMin.modelErrors, fiveMin.modelCalls)}
          delta={`${fiveMin.modelErrors}/${fiveMin.modelCalls}`}
          tone={fiveMin.modelErrors > 0 ? "bad" : "good"}
        />
        <StatCard
          label="model p95 (5m)"
          value={fmtMs(fiveMin.modelP95Ms)}
          delta="latency"
          tone="neutral"
        />
        <StatCard
          label="session alerts (15m)"
          value={data.windows["15m"].sessionsAlerted}
          delta="stalled / stuck"
          tone={data.windows["15m"].sessionsAlerted > 0 ? "warn" : "good"}
        />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>events / 10s · last 15m</h3>
          <TimeSeriesChart metric="events.total" windowSec={900} />
        </div>
        <div className="panel">
          <h3>model calls / 10s · last 15m</h3>
          <TimeSeriesChart metric="model.calls" windowSec={900} />
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <h3>recent errors</h3>
          {data.recentErrors.length === 0 ? (
            <div className="empty">no errors recorded</div>
          ) : (
            <div className="errors-list">
              {data.recentErrors.map((err, idx) => (
                <div className="error-item" key={`${err.capturedAt}-${idx}`}>
                  <div className="meta">
                    <span className="tag error">{err.type}</span>{" "}
                    {new Date(err.capturedAt).toLocaleString()}
                  </div>
                  <div className="summary">{err.summary}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <h3>events by type · live counts</h3>
          <table>
            <thead>
              <tr>
                <th>type</th>
                <th className="num">count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.countsByType)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 12)
                .map(([type, count]) => (
                  <tr key={type}>
                    <td>{type}</td>
                    <td className="num">{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
