import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

export function Channels() {
  const { t } = useI18n();
  const { data, error } = usePolling(api.channels, 5_000);

  return (
    <div>
      <h2 className="page-title">{t("channels.title")}</h2>
      <div className="subtitle">{t("channels.subtitle")}</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>{t("chart.messagesLast15m")}</h3>
        <TimeSeriesChart metric="messages.delivered" windowSec={900} height={180} />
      </div>

      <div className="panel">
        <h3>{t("channels.rollup")}</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={data.rows} keyLabel={t("nav.channels")} />
        )}
      </div>
    </div>
  );
}
