import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

export function RunDetail() {
  const { t } = useI18n();
  const params = useParams();
  const runId = params["runId"] ?? "";
  const { data, error } = usePolling(() => api.runDetail(runId), 5_000);

  return (
    <div>
      <Link to="/runs">{t("runDetail.backToRuns")}</Link>
      <h2 className="page-title" style={{ marginTop: 12 }}>
        {t("runDetail.title", { runId: "" })}
        <code>{runId}</code>
      </h2>

      {error ? <div className="error-banner">{error}</div> : null}
      {!data ? <div className="empty">{t("common.loading")}</div> : null}

      {data ? (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>{t("runDetail.summary")}</h3>
            <table>
              <tbody>
                <tr>
                  <td>{t("runDetail.row.status")}</td>
                  <td>{data.run.status}</td>
                </tr>
                <tr>
                  <td>{t("runDetail.row.channel")}</td>
                  <td>{data.run.channel ?? "—"}</td>
                </tr>
                <tr>
                  <td>{t("runDetail.row.session")}</td>
                  <td>{data.run.sessionId ?? data.run.sessionKey ?? "—"}</td>
                </tr>
                <tr>
                  <td>{t("runDetail.row.started")}</td>
                  <td>{new Date(data.run.startedAt).toLocaleString()}</td>
                </tr>
                <tr>
                  <td>{t("runDetail.row.ended")}</td>
                  <td>{data.run.endedAt ? new Date(data.run.endedAt).toLocaleString() : "—"}</td>
                </tr>
                <tr>
                  <td>{t("runDetail.row.durationMs")}</td>
                  <td>{data.run.durationMs ?? "—"}</td>
                </tr>
                <tr>
                  <td>{t("runDetail.row.modelCalls")}</td>
                  <td>{data.run.modelCalls}</td>
                </tr>
                <tr>
                  <td>{t("runDetail.row.toolExecs")}</td>
                  <td>{data.run.toolExecs}</td>
                </tr>
                {data.run.errorMessage ? (
                  <tr>
                    <td>{t("runDetail.row.error")}</td>
                    <td className="err">{data.run.errorMessage}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>{t("runDetail.trace", { count: data.events.length })}</h3>
            {data.events.length === 0 ? (
              <div className="empty">{t("runDetail.empty")}</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t("runDetail.col.time")}</th>
                    <th>{t("runDetail.col.type")}</th>
                    <th>{t("runDetail.col.payload")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((evt, idx) => {
                    const fullJson = JSON.stringify(evt.payload, null, 2);
                    const preview = JSON.stringify(evt.payload);
                    return (
                      <tr key={`${evt.capturedAt}-${idx}`}>
                        <td>{new Date(evt.capturedAt).toLocaleTimeString()}</td>
                        <td>{evt.type}</td>
                        <td>
                          <details>
                            <summary
                              style={{
                                cursor: "pointer",
                                fontFamily: "var(--mono)",
                                fontSize: 11,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                maxWidth: 480,
                              }}
                            >
                              {preview.length > 240 ? `${preview.slice(0, 240)}…` : preview}
                            </summary>
                            <pre
                              style={{
                                marginTop: 6,
                                fontSize: 11,
                                maxHeight: 360,
                                overflow: "auto",
                              }}
                            >
                              {fullJson}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
