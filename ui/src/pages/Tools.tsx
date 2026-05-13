import { useMemo } from "react";
import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import type { StringKey } from "../i18n/index.js";
import { toolsFromEvents, type RawEvent } from "../lib/windowed-dimension.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

export function Tools() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();

  // Client-side aggregation from raw events so the global window picker
  // affects this page (v0.9.7.2). See lib/windowed-dimension.ts for why.
  const completedFetcher = useMemo(
    () => () => api.events({ type: "tool.execution.completed", limit: 1000 }),
    [],
  );
  const errorFetcher = useMemo(
    () => () => api.events({ type: "tool.execution.error", limit: 1000 }),
    [],
  );
  const blockedFetcher = useMemo(
    () => () => api.events({ type: "tool.execution.blocked", limit: 500 }),
    [],
  );
  const { data: doneData, error: errDone } = usePolling(completedFetcher, 5_000);
  const { data: errData, error: errErr } = usePolling(errorFetcher, 5_000);
  const { data: blockedData, error: errBlocked } = usePolling(blockedFetcher, 5_000);

  const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
  const rows = useMemo(() => {
    const events: RawEvent[] = [
      ...((doneData?.events ?? []) as RawEvent[]),
      ...((errData?.events ?? []) as RawEvent[]),
      ...((blockedData?.events ?? []) as RawEvent[]),
    ];
    return toolsFromEvents(events, cutoffMs);
  }, [doneData, errData, blockedData, cutoffMs]);

  const loading = !doneData || !errData || !blockedData;
  const error = errDone ?? errErr ?? errBlocked;
  // Series charts cap at 1h (host series ring max). Match Overview's cap-aware
  // labelling so operators understand a 24h window shows 1h of data here.
  const chartWindowSec = Math.min(WINDOW_TO_SECONDS[timeWindow], 3600);
  const chartLabelKey: StringKey =
    timeWindow === "6h" || timeWindow === "24h" ? "chart.eventsCapped" : "chart.events";

  return (
    <div>
      <h2 className="page-title">{t("tools.title")}</h2>
      <div className="subtitle">{t("tools.subtitle")}</div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>
            {t(chartLabelKey, {
              window: t(`topbar.window.${timeWindow}`),
              metric: t("chart.metric.toolExecs"),
            })}
          </h3>
          <TimeSeriesChart metric="tool.execs" windowSec={chartWindowSec} height={180} />
        </div>
        <div className="panel">
          <h3>
            {t(chartLabelKey, {
              window: t(`topbar.window.${timeWindow}`),
              metric: t("chart.metric.toolErrors"),
            })}
          </h3>
          <TimeSeriesChart metric="tool.errors" windowSec={chartWindowSec} height={180} />
        </div>
      </div>

      <div className="panel">
        <h3>
          {t("tools.rollup")}{" "}
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
            · {t(`topbar.window.${timeWindow}`)}
          </span>
        </h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : loading ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={rows} keyLabel={t("nav.tools")} />
        )}
      </div>
    </div>
  );
}
