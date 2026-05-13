import { useMemo } from "react";
import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import type { StringKey } from "../i18n/index.js";
import { modelsFromEvents, type RawEvent } from "../lib/windowed-dimension.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

export function Models() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();

  const completedFetcher = useMemo(
    () => () => api.events({ type: "model.call.completed", limit: 1000 }),
    [],
  );
  const errorFetcher = useMemo(
    () => () => api.events({ type: "model.call.error", limit: 500 }),
    [],
  );
  const tokenFetcher = useMemo(
    () => () => api.events({ type: "llm.tokens.recorded", limit: 1000 }),
    [],
  );
  const { data: doneData, error: errDone } = usePolling(completedFetcher, 5_000);
  const { data: errData, error: errErr } = usePolling(errorFetcher, 5_000);
  const { data: tokenData, error: errTok } = usePolling(tokenFetcher, 5_000);

  const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
  const rows = useMemo(() => {
    const modelEvents: RawEvent[] = [
      ...((doneData?.events ?? []) as RawEvent[]),
      ...((errData?.events ?? []) as RawEvent[]),
    ];
    const tokenEvents = (tokenData?.events ?? []) as RawEvent[];
    return modelsFromEvents(modelEvents, tokenEvents, cutoffMs);
  }, [doneData, errData, tokenData, cutoffMs]);

  const loading = !doneData || !errData || !tokenData;
  const error = errDone ?? errErr ?? errTok;
  const chartWindowSec = Math.min(WINDOW_TO_SECONDS[timeWindow], 3600);
  const chartLabelKey: StringKey =
    timeWindow === "6h" || timeWindow === "24h" ? "chart.eventsCapped" : "chart.events";

  return (
    <div>
      <h2 className="page-title">{t("models.title")}</h2>
      <div className="subtitle">{t("models.subtitle")}</div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>
            {t(chartLabelKey, {
              window: t(`topbar.window.${timeWindow}`),
              metric: t("chart.metric.modelCalls"),
            })}
          </h3>
          <TimeSeriesChart metric="model.calls" windowSec={chartWindowSec} height={180} />
        </div>
        <div className="panel">
          <h3>
            {t(chartLabelKey, {
              window: t(`topbar.window.${timeWindow}`),
              metric: t("chart.metric.modelErrors"),
            })}
          </h3>
          <TimeSeriesChart metric="model.errors" windowSec={chartWindowSec} height={180} />
        </div>
      </div>

      <div className="panel">
        <h3>
          {t("models.rollup")}{" "}
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
          <DimensionTable rows={rows} keyLabel="provider / model" showTokens />
        )}
      </div>
    </div>
  );
}
