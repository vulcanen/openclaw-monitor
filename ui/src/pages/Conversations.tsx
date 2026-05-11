import { Link } from "react-router-dom";
import { api, type ConversationSummary } from "../api.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

export function Conversations() {
  const { t } = useI18n();
  const { data, error } = usePolling(() => api.conversations(100), 5_000);

  const statusTag = (status: ConversationSummary["status"]) => {
    const cls = status === "completed" ? "ok" : status === "active" ? "active" : "error";
    return <span className={`tag ${cls}`}>{t(`runs.status.${status}` as never)}</span>;
  };

  return (
    <div>
      <h2 className="page-title">{t("conversations.title")}</h2>
      <div className="subtitle">
        {t("conversations.subtitle", { active: data?.active ?? 0 })}
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {data && data.conversations.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <div style={{ marginBottom: 12, fontSize: 14 }}>{t("conversations.empty")}</div>
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              {t("conversations.optInHint")}
            </div>
          </div>
        </div>
      ) : null}

      {data && data.conversations.length > 0 ? (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>{t("conversations.col.runId")}</th>
                <th>{t("conversations.col.status")}</th>
                <th>{t("conversations.col.channel")}</th>
                <th>{t("conversations.col.started")}</th>
                <th>{t("conversations.col.duration")}</th>
                <th className="num">{t("conversations.col.hops")}</th>
                <th className="num">{t("conversations.col.tokensIn")}</th>
                <th className="num">{t("conversations.col.tokensOut")}</th>
                <th>{t("conversations.col.preview")}</th>
              </tr>
            </thead>
            <tbody>
              {data.conversations.map((c) => (
                <tr key={c.runId}>
                  <td>
                    <Link to={`/conversations/${encodeURIComponent(c.runId)}`}>{c.runId}</Link>
                  </td>
                  <td>{statusTag(c.status)}</td>
                  <td>{c.trigger ?? c.channelId ?? "—"}</td>
                  <td>{new Date(c.startedAt).toLocaleString()}</td>
                  <td>{fmtDuration(c.durationMs)}</td>
                  <td className="num">{c.llmHops}</td>
                  <td className="num">{c.totalTokensIn}</td>
                  <td className="num">{c.totalTokensOut}</td>
                  <td
                    style={{
                      maxWidth: 360,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      fontFamily: "var(--font)",
                    }}
                  >
                    {c.promptPreview ?? c.responsePreview ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
