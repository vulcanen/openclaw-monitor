import { api } from "../api.js";
import { StatCard } from "../components/StatCard.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

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
  const { t } = useI18n();
  const { data, error } = usePolling(api.overview, 5_000);

  if (error)
    return <div className="error-banner">{t("overview.loadFailed", { error })}</div>;
  if (!data) return <div className="empty">{t("common.loading")}</div>;

  const fiveMin = data.windows["5m"];
  const oneMin = data.windows["1m"];

  return (
    <div>
      <h2 className="page-title">{t("overview.title")}</h2>
      <div className="subtitle">
        {t("overview.subtitle", {
          time: new Date(data.generatedAt).toLocaleTimeString(),
          bufferedEvents: data.bufferedEvents,
        })}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatCard
          label={t("stat.modelCalls1m")}
          value={oneMin.modelCalls}
          delta={t("stat.errors", { count: oneMin.modelErrors })}
          tone={oneMin.modelErrors > 0 ? "bad" : "neutral"}
        />
        <StatCard
          label={t("stat.errorRate5m")}
          value={pct(fiveMin.modelErrors, fiveMin.modelCalls)}
          delta={t("stat.errorRateDetail", {
            errors: fiveMin.modelErrors,
            total: fiveMin.modelCalls,
          })}
          tone={fiveMin.modelErrors > 0 ? "bad" : "good"}
        />
        <StatCard
          label={t("stat.modelP955m")}
          value={fmtMs(fiveMin.modelP95Ms)}
          delta={t("stat.latency")}
          tone="neutral"
        />
        <StatCard
          label={t("stat.sessionAlerts15m")}
          value={data.windows["15m"].sessionsAlerted}
          tone={data.windows["15m"].sessionsAlerted > 0 ? "warn" : "good"}
        />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>{t("chart.eventsLast15m")}</h3>
          <TimeSeriesChart metric="events.total" windowSec={900} />
        </div>
        <div className="panel">
          <h3>{t("chart.modelCallsLast15m")}</h3>
          <TimeSeriesChart metric="model.calls" windowSec={900} />
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <h3>{t("overview.recentErrors")}</h3>
          {data.recentErrors.length === 0 ? (
            <div className="empty">{t("empty.errors")}</div>
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
          <h3>{t("overview.countsByType")}</h3>
          <table>
            <thead>
              <tr>
                <th>{t("overview.col.type")}</th>
                <th className="num">{t("overview.col.count")}</th>
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
