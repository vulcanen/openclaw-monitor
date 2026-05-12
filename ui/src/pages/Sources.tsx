import { api, type DimensionRow } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { friendlyEntryLabel } from "../entry-label.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

export function Sources() {
  const { t } = useI18n();
  const { data, error } = usePolling(api.sources, 5_000);

  // Same friendly-label translation as Channels.tsx — the backend keeps
  // stable technical ids ("openai-api" / "control-ui" / "channel:name")
  // for API consumers; we humanise them here for display only.
  const translatedRows: DimensionRow[] = (data?.rows ?? []).map((r) => ({
    ...r,
    key: friendlyEntryLabel(t, r.key),
  }));

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
        <h3>{t("sources.rollup")}</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">{t("common.loading")}</div>
        ) : (
          <DimensionTable rows={translatedRows} keyLabel={t("sources.col.source")} showTokens />
        )}
      </div>
    </div>
  );
}
