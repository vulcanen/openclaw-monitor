import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

export function Sources() {
  const { t } = useI18n();
  const { data, error } = usePolling(api.sources, 5_000);

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
              <td>
                <code>openai-api</code>
              </td>
              <td>{t("sources.legend.openaiApi")}</td>
            </tr>
            <tr>
              <td>
                <code>control-ui</code>
              </td>
              <td>{t("sources.legend.controlUi")}</td>
            </tr>
            <tr>
              <td>
                <code>channel:&lt;name&gt;</code>
              </td>
              <td>{t("sources.legend.channelPlugin")}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>{t("sources.rollup")}</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={data.rows} keyLabel={t("sources.col.source")} showTokens />
        )}
      </div>
    </div>
  );
}
