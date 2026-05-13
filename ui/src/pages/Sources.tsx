import { useMemo } from "react";
import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { friendlyEntryLabel } from "../entry-label.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { sourcesFromEvents, type RawEvent } from "../lib/windowed-dimension.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

export function Sources() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();

  // Same shape as Channels — Sources is just a different `keyFor`
  // function (inferEntryKey on channel + trigger + runId).
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
    return sourcesFromEvents(messageEvents, modelEvents, tokenEvents, cutoffMs).map((row) => ({
      ...row,
      key: friendlyEntryLabel(t, row.key),
    }));
  }, [r1.data, r2.data, r3.data, r4.data, r5.data, r6.data, cutoffMs, t]);

  const loading = !r1.data || !r2.data || !r3.data || !r4.data || !r5.data || !r6.data;
  const error = r1.error ?? r2.error ?? r3.error ?? r4.error ?? r5.error ?? r6.error;

  return (
    <div>
      <h2 className="page-title">{t("sources.title")}</h2>
      <div className="subtitle">{t("sources.subtitle")}</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>{t("sources.legend")}</h3>
        <table>
          <thead>
            <tr>
              <th>{t("sources.legend.id")}</th>
              <th>{t("sources.legend.meaning")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t("entryLabel.openaiApi")}</td>
              <td>{t("sources.legend.openaiApi")}</td>
            </tr>
            <tr>
              <td>{t("entryLabel.controlUi")}</td>
              <td>{t("sources.legend.controlUi")}</td>
            </tr>
            <tr>
              <td>{t("entryLabel.channelPlugin", { name: "&lt;name&gt;" })}</td>
              <td>{t("sources.legend.channelPlugin")}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>
          {t("sources.rollup")}{" "}
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
          <DimensionTable rows={rows} keyLabel={t("sources.col.source")} showTokens />
        )}
      </div>
    </div>
  );
}
