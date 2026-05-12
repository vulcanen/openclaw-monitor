import { api, type DimensionRow } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { friendlyEntryLabel } from "../entry-label.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

export function Channels() {
  const { t } = useI18n();
  const { data, error } = usePolling(api.channels, 5_000);

  // The host stamps "webchat" on every internal entry (OpenAI compat API
  // + Control UI + heartbeat/cron). Without translation the table would
  // be a single "webchat" row that tells you nothing. We do not modify
  // the underlying API rows — just render a friendlier key.
  const translatedRows: DimensionRow[] = (data?.rows ?? []).map((r) => ({
    ...r,
    key: friendlyEntryLabel(t, r.key),
  }));

  return (
    <div>
      <h2 className="page-title">{t("channels.title")}</h2>
      <div className="subtitle">{t("channels.subtitle")}</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>{t("channels.chartTitle")}</h3>
        <TimeSeriesChart metric="model.calls" windowSec={900} height={180} />
      </div>

      <div className="panel">
        <h3>{t("channels.rollup")}</h3>
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
        ) : !data ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={translatedRows} keyLabel={t("nav.channels")} />
        )}
      </div>
    </div>
  );
}
