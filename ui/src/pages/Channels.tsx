import { useMemo } from "react";
import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { friendlyEntryLabel } from "../entry-label.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import type { StringKey } from "../i18n/index.js";
import { channelsFromEvents, type RawEvent } from "../lib/windowed-dimension.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

export function Channels() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();

  // Channels are derived from several event types — pull each and merge.
  // The lib does the heavy lifting (decision: keep aggregation logic in
  // one shared place; pages just wire fetchers + window).
  const msgDelivered = useMemo(
    () => () => api.events({ type: "message.delivery.completed", limit: 500 }),
    [],
  );
  const msgDeliveryErr = useMemo(
    () => () => api.events({ type: "message.delivery.error", limit: 500 }),
    [],
  );
  const msgProcessed = useMemo(
    () => () => api.events({ type: "message.processed", limit: 500 }),
    [],
  );
  const modelCompleted = useMemo(
    () => () => api.events({ type: "model.call.completed", limit: 1000 }),
    [],
  );
  const modelErr = useMemo(() => () => api.events({ type: "model.call.error", limit: 500 }), []);
  const tokenFetcher = useMemo(
    () => () => api.events({ type: "llm.tokens.recorded", limit: 1000 }),
    [],
  );
  const r1 = usePolling(msgDelivered, 5_000);
  const r2 = usePolling(msgDeliveryErr, 5_000);
  const r3 = usePolling(msgProcessed, 5_000);
  const r4 = usePolling(modelCompleted, 5_000);
  const r5 = usePolling(modelErr, 5_000);
  const r6 = usePolling(tokenFetcher, 5_000);

  const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
  const rows = useMemo(() => {
    const messageEvents: RawEvent[] = [
      ...((r1.data?.events ?? []) as RawEvent[]),
      ...((r2.data?.events ?? []) as RawEvent[]),
      ...((r3.data?.events ?? []) as RawEvent[]),
    ];
    const modelEvents: RawEvent[] = [
      ...((r4.data?.events ?? []) as RawEvent[]),
      ...((r5.data?.events ?? []) as RawEvent[]),
    ];
    const tokenEvents = (r6.data?.events ?? []) as RawEvent[];
    return channelsFromEvents(messageEvents, modelEvents, tokenEvents, cutoffMs).map((row) => ({
      ...row,
      key: friendlyEntryLabel(t, row.key),
    }));
  }, [r1.data, r2.data, r3.data, r4.data, r5.data, r6.data, cutoffMs, t]);

  const loading = !r1.data || !r2.data || !r3.data || !r4.data || !r5.data || !r6.data;
  const error = r1.error ?? r2.error ?? r3.error ?? r4.error ?? r5.error ?? r6.error;
  const chartWindowSec = Math.min(WINDOW_TO_SECONDS[timeWindow], 3600);
  const chartLabelKey: StringKey =
    timeWindow === "6h" || timeWindow === "24h" ? "chart.eventsCapped" : "chart.events";

  return (
    <div>
      <h2 className="page-title">{t("channels.title")}</h2>
      <div className="subtitle">{t("channels.subtitle")}</div>

      <div className="panel" style={{ marginBottom: 16 }}>
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
          {t("channels.rollup")}{" "}
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
        <div
          style={{
            fontSize: 12,
            color: "var(--text-dim)",
            marginBottom: 12,
            lineHeight: 1.6,
          }}
        >
          {t("channels.hostHint")}
        </div>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : loading ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={rows} keyLabel={t("nav.channels")} />
        )}
      </div>
    </div>
  );
}
