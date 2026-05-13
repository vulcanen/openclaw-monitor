import { useMemo } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import type { DimensionRow, OverviewSnapshot } from "../api.js";
import { StatCard } from "../components/StatCard.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { friendlyEntryLabel } from "../entry-label.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import type { TranslateFn, StringKey } from "../i18n/index.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";
import type { TimeWindow } from "../time-window.js";

/**
 * Map the global TimeWindow value onto the WindowSnapshot keys the
 * aggregator actually computes (1m / 5m / 15m / 1h). 6h and 24h are
 * not aggregator buckets — they fall back to "1h" since that's the
 * widest snapshot available. Subtitle copy reflects this fallback so
 * operators understand why the number didn't change.
 */
function mapToSnapshotWindow(w: TimeWindow): "1m" | "5m" | "15m" | "1h" {
  if (w === "1m" || w === "5m" || w === "15m" || w === "1h") return w;
  return "1h";
}

function fmtMs(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "0%";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function fmtRelative(t: TranslateFn, iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const deltaMin = Math.max(0, Math.round((now - ts) / 60_000));
  if (deltaMin < 60) return t("overview.lifecycle.relativeMin", { n: deltaMin });
  const deltaHour = Math.round(deltaMin / 60);
  if (deltaHour < 48) return t("overview.lifecycle.relativeHour", { n: deltaHour });
  return t("overview.lifecycle.relativeDay", { n: Math.round(deltaHour / 24) });
}

type HealthTone = "ok" | "warn" | "error";

/**
 * Synthesize a single health tone from the overview snapshot. Order of
 * severity (most-severe wins):
 *   1. recentErrors > 0 in last few minutes → error
 *   2. sessionsAlerted > 0 OR errorRate5m > 5% → warn
 *   3. otherwise → ok
 *
 * Thresholds are intentionally generous so the banner only goes red on a
 * real incident, not on a single stray error.
 */
function computeHealth(data: OverviewSnapshot): {
  tone: HealthTone;
  errorRate5m: number;
  recentErrors: number;
  sessionsAlerted: number;
} {
  const fiveMin = data.windows["5m"];
  const fifteen = data.windows["15m"];
  const errorRate5m =
    fiveMin.modelCalls === 0 ? 0 : (fiveMin.modelErrors / fiveMin.modelCalls) * 100;
  const recentErrors = data.recentErrors.length;
  const sessionsAlerted = fifteen.sessionsAlerted;
  let tone: HealthTone = "ok";
  if (recentErrors > 5 || errorRate5m >= 20) {
    tone = "error";
  } else if (recentErrors > 0 || sessionsAlerted > 0 || errorRate5m >= 5) {
    tone = "warn";
  }
  return { tone, errorRate5m, recentErrors, sessionsAlerted };
}

function HealthBanner({ data, t }: { data: OverviewSnapshot; t: TranslateFn }) {
  const { tone, errorRate5m, recentErrors, sessionsAlerted } = computeHealth(data);
  const headline = (() => {
    if (tone === "ok") return t("overview.health.ok");
    if (tone === "warn") {
      const count = recentErrors + sessionsAlerted;
      return t("overview.health.warn", { count });
    }
    return t("overview.health.error", { count: recentErrors });
  })();
  const detail =
    tone === "ok"
      ? t("overview.health.detailCalm")
      : t("overview.health.detailIssues", {
          errorRate: errorRate5m.toFixed(1),
          sessionsAlerted,
          recentErrors,
        });
  return (
    <div
      className={`health-banner ${tone === "ok" ? "" : tone === "warn" ? "health-warn" : "health-error"}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="health-label">{t("overview.health.label")}</span>
      <span className="health-headline">{headline}</span>
      <span className="health-detail">{detail}</span>
    </div>
  );
}

/**
 * Compute lifecycle stat-card values from the overview snapshot's
 * countsByType + buffer-derived signals. We deliberately stay out of the
 * /api/monitor/events endpoint here — countsByType is already on the
 * snapshot and covers the cumulative-since-process-start case for all
 * event types we care about. Page-relative figures (active sessions /
 * compactions today) need richer queries which we'll add later; for now
 * we surface the cumulative buffer counts, which is still a useful
 * "is this happening at all" signal.
 */
function lifecycleStats(data: OverviewSnapshot) {
  const counts = data.countsByType;
  const started = counts["session.lifecycle.started"] ?? 0;
  const ended = counts["session.lifecycle.ended"] ?? 0;
  const activeSessions = Math.max(0, started - ended);
  const compactionsCompleted = counts["agent.compaction.completed"] ?? 0;
  const toolPersists = counts["tool.result.persisted"] ?? 0;
  return { activeSessions, compactionsCompleted, toolPersists };
}

export function Overview() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();
  const snapshotKey = mapToSnapshotWindow(timeWindow);
  const overviewFetcher = useMemo(() => api.overview, []);
  const sourcesFetcher = useMemo(() => api.sources, []);
  const { data, error } = usePolling(overviewFetcher, 5_000);
  const { data: sourcesData } = usePolling(sourcesFetcher, 10_000);
  const now = Date.now();

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty">{t("common.loading")}</div>;

  // All four stat cards now read from the same window, picked by the
  // global selector. Pre-v0.9.7.1 each card had a different hardcoded
  // window which the time picker couldn't influence at all.
  const snap = data.windows[snapshotKey];
  const lifecycle = lifecycleStats(data);
  const topSources: DimensionRow[] = (sourcesData?.rows ?? []).slice(0, 5);
  // Series charts: the host series buckets are 10s wide for up to 1h.
  // For windows <= 1h we ask for exactly that. For 6h/24h we cap to 1h
  // (the maximum the series ring stores) and the chart subtitle calls
  // out the cap.
  const chartWindowSec = Math.min(WINDOW_TO_SECONDS[timeWindow], 3600);
  const chartLabelKey: StringKey =
    timeWindow === "6h" || timeWindow === "24h" ? "chart.eventsCapped" : "chart.events";

  // Synthesize the "last gateway start" timestamp from the most recent
  // gateway.lifecycle.started event in the recent-errors stream. The
  // buffer doesn't expose this cleanly via /overview yet, so for now we
  // look for it in the buffered events; if not found, show "never".
  const lastRestart = data.recentErrors.find(
    (e) => e.type === "gateway.lifecycle.started",
  )?.capturedAt;

  return (
    <div>
      <h2 className="page-title">{t("overview.title")}</h2>
      <div className="subtitle">
        {t("overview.subtitle", {
          time: new Date(data.generatedAt).toLocaleTimeString(),
          bufferedEvents: data.bufferedEvents,
        })}
      </div>

      <HealthBanner data={data} t={t} />

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatCard
          label={t("stat.modelCallsWindow", { window: t(`topbar.window.${snapshotKey}`) })}
          value={snap.modelCalls}
          delta={t("stat.errors", { count: snap.modelErrors })}
          tone={snap.modelErrors > 0 ? "bad" : "neutral"}
        />
        <StatCard
          label={t("stat.errorRateWindow", { window: t(`topbar.window.${snapshotKey}`) })}
          value={pct(snap.modelErrors, snap.modelCalls)}
          delta={t("stat.errorRateDetail", {
            errors: snap.modelErrors,
            total: snap.modelCalls,
          })}
          tone={snap.modelErrors > 0 ? "bad" : "good"}
        />
        <StatCard
          label={t("stat.modelP95Window", { window: t(`topbar.window.${snapshotKey}`) })}
          value={fmtMs(snap.modelP95Ms)}
          delta={t("stat.latency")}
          tone="neutral"
        />
        <StatCard
          label={t("stat.sessionAlertsWindow", { window: t(`topbar.window.${snapshotKey}`) })}
          value={snap.sessionsAlerted}
          tone={snap.sessionsAlerted > 0 ? "warn" : "good"}
        />
      </div>

      {/* Second row: lifecycle visibility — surfaced from the v0.9.6
          synthetic events session.lifecycle.* / agent.compaction.* /
          tool.result.persisted / gateway.lifecycle.*. These were
          previously only readable via Logs filter. */}
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatCard
          label={t("overview.lifecycle.activeSessions")}
          value={lifecycle.activeSessions}
          tone={lifecycle.activeSessions > 0 ? "neutral" : "neutral"}
        />
        <StatCard
          label={t("overview.lifecycle.compactionsToday")}
          value={lifecycle.compactionsCompleted}
          tone="neutral"
        />
        <StatCard
          label={t("overview.lifecycle.lastRestart")}
          value={lastRestart ? fmtRelative(t, lastRestart, now) : t("overview.lifecycle.never")}
          tone="neutral"
        />
        <StatCard
          label={t("overview.lifecycle.toolPersists")}
          value={lifecycle.toolPersists}
          tone="neutral"
        />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>
            {t(chartLabelKey, {
              window: t(`topbar.window.${timeWindow}`),
              metric: t("chart.metric.events"),
            })}
          </h3>
          <TimeSeriesChart metric="events.total" windowSec={chartWindowSec} />
        </div>
        <div className="panel">
          <h3>
            {t(chartLabelKey, {
              window: t(`topbar.window.${timeWindow}`),
              metric: t("chart.metric.modelCalls"),
            })}
          </h3>
          <TimeSeriesChart metric="model.calls" windowSec={chartWindowSec} />
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
          <h3>
            {t("overview.section.topSources")}{" "}
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
              {t("overview.section.topSourcesSub")}
            </span>
          </h3>
          {topSources.length === 0 ? (
            <div className="empty">{t("common.noData")}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("sources.col.source")}</th>
                  <th className="num">{t("overview.col.count")}</th>
                  <th className="num">{t("alerts.col.value")}</th>
                </tr>
              </thead>
              <tbody>
                {topSources.map((row) => {
                  const errRate = row.total === 0 ? 0 : (row.errors / row.total) * 100;
                  return (
                    <tr key={row.key}>
                      <td>
                        <Link to="/sources" title={row.key}>
                          {friendlyEntryLabel(t, row.key)}
                        </Link>
                      </td>
                      <td className="num">{row.total}</td>
                      <td
                        className="num"
                        style={{ color: errRate > 0 ? "var(--error)" : undefined }}
                      >
                        {errRate.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
