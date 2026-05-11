import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

export function Tools() {
  const { t } = useI18n();
  const { data, error } = usePolling(api.tools, 5_000);

  return (
    <div>
      <h2 className="page-title">{t("tools.title")}</h2>
      <div className="subtitle">{t("tools.subtitle")}</div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>{t("chart.toolExecsLast15m")}</h3>
          <TimeSeriesChart metric="tool.execs" windowSec={900} height={180} />
        </div>
        <div className="panel">
          <h3>{t("chart.toolErrorsLast15m")}</h3>
          <TimeSeriesChart metric="tool.errors" windowSec={900} height={180} />
        </div>
      </div>

      <div className="panel">
        <h3>{t("tools.rollup")}</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={data.rows} keyLabel={t("nav.tools")} />
        )}
      </div>
    </div>
  );
}
