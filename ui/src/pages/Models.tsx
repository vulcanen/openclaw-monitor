import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

export function Models() {
  const { t } = useI18n();
  const { data, error } = usePolling(api.models, 5_000);

  return (
    <div>
      <h2 className="page-title">{t("models.title")}</h2>
      <div className="subtitle">{t("models.subtitle")}</div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>{t("chart.modelCallsLast15m")}</h3>
          <TimeSeriesChart metric="model.calls" windowSec={900} height={180} />
        </div>
        <div className="panel">
          <h3>{t("chart.modelErrorsLast15m")}</h3>
          <TimeSeriesChart metric="model.errors" windowSec={900} height={180} />
        </div>
      </div>

      <div className="panel">
        <h3>{t("models.rollup")}</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={data.rows} keyLabel="provider / model" showTokens />
        )}
      </div>
    </div>
  );
}
