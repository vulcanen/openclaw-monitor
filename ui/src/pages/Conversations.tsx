import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ConversationSummary, type SessionGroup } from "../api.js";
import { Pagination } from "../components/Pagination.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";

/**
 * Infer a human-meaningful entry-path label from the raw host fields.
 *
 * Background: OpenClaw's INTERNAL_MESSAGE_CHANNEL constant is literally
 * the string "webchat" — the host stamps that on **every** non-channel-
 * plugin entry, including `/v1/chat/completions`, the Control UI built-
 * in chat, heartbeat-triggered runs, etc. So `channelId === "webchat"`
 * by itself doesn't tell an operator which front door this conversation
 * came through.
 *
 * We disambiguate using two stable hints:
 *   - runId prefix:
 *       "chatcmpl_*" → OpenAI-compat HTTP (built by openai-http.ts)
 *       "ctrl_*"     → Control UI (built by server-chat.ts)
 *   - trigger == "channel-message" → Control UI / channel-plugin
 *     (audit's conversation-probe synthesises this tag for non-
 *     model_call paths).
 *
 * Channels other than "webchat" come from explicit channel plugins
 * (telegram / discord / feishu / ...) and pass through as-is.
 */
function inferEntryLabel(
  channelId: string | undefined,
  trigger: string | undefined,
  runId: string | undefined,
): string | undefined {
  if (!channelId) return undefined;
  if (channelId !== "webchat") return channelId;
  if (runId?.startsWith("ctrl_")) return "Control UI";
  if (runId?.startsWith("chatcmpl_")) return "OpenAI API";
  if (trigger === "channel-message") return "Control UI";
  if (trigger === "heartbeat" || trigger === "cron" || trigger === "webhook") {
    return `internal · ${trigger}`;
  }
  if (trigger === "user") return "OpenAI API";
  // Last-resort: keep the raw "webchat" so the operator still sees the
  // host's literal field rather than blank.
  return "webchat";
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function StatusTag({ status }: { status: ConversationSummary["status"] }) {
  const { t } = useI18n();
  const cls = status === "completed" ? "ok" : status === "active" ? "active" : "error";
  return <span className={`tag ${cls}`}>{t(`runs.status.${status}` as never)}</span>;
}

function SessionRow({ group }: { group: SessionGroup }) {
  const { t } = useI18n();
  // Sessions are collapsed by default. The list can grow long (dozens to
  // hundreds of session entries once retention kicks in) and an all-
  // expanded view drowns the page in tables; click a row to see its runs.
  const [open, setOpen] = useState(false);
  const sessionLabel = group.sessionKey === "_ungrouped" ? "—" : group.sessionKey;
  return (
    <div
      className="panel"
      style={{ marginBottom: 12, padding: 0 }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          width: "100%",
          padding: "12px 16px",
          background: "transparent",
          color: "inherit",
          border: "none",
          borderBottom: open ? "1px solid var(--border)" : "none",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: "inherit",
          textAlign: "left",
        }}
      >
        <span style={{ width: 16, color: "var(--text-dim)" }}>{open ? "▼" : "▶"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={sessionLabel}
          >
            {sessionLabel}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              marginTop: 2,
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>{t("conversations.session.runs", { count: group.runCount })}</span>
            {(() => {
              const firstRun = group.conversations[0];
              const label = inferEntryLabel(
                group.channelId,
                firstRun?.trigger,
                firstRun?.runId,
              );
              if (!label) return null;
              return (
                <span
                  title={
                    group.channelId === "webchat"
                      ? `host channel = "webchat" (OpenClaw INTERNAL_MESSAGE_CHANNEL). Display label inferred from runId / trigger.`
                      : `host channel = "${group.channelId}"`
                  }
                >
                  · {label}
                </span>
              );
            })()}
            <span>
              · {t("conversations.session.tokens", {
                input: group.totalTokensIn,
                output: group.totalTokensOut,
              })}
            </span>
            <span>· {new Date(group.lastSeenAt).toLocaleString()}</span>
          </div>
        </div>
        {group.hasError ? <span className="tag error">err</span> : null}
      </button>
      {open ? (
        <table style={{ marginTop: 0 }}>
          <thead>
            <tr>
              <th>{t("conversations.col.runId")}</th>
              <th>{t("conversations.col.status")}</th>
              <th>{t("conversations.col.started")}</th>
              <th>{t("conversations.col.duration")}</th>
              <th className="num">{t("conversations.col.hops")}</th>
              <th className="num">{t("conversations.col.tokensIn")}</th>
              <th className="num">{t("conversations.col.tokensOut")}</th>
              <th>{t("conversations.col.preview")}</th>
            </tr>
          </thead>
          <tbody>
            {group.conversations.map((c) => (
              <tr key={c.runId}>
                <td>
                  <Link to={`/conversations/${encodeURIComponent(c.runId)}`}>{c.runId}</Link>
                </td>
                <td>
                  <StatusTag status={c.status} />
                </td>
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
                  title={c.promptPreview ?? c.responsePreview ?? ""}
                >
                  {c.promptPreview ?? c.responsePreview ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export function Conversations() {
  const { t } = useI18n();
  // Pull a generous slice so client-side paging has room; the API tops
  // out at 500 sessions per response, plenty for a single dashboard view.
  const fetcher = useMemo(() => () => api.conversationsBySession(500), []);
  const { data, error } = usePolling(fetcher, 5_000);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const allSessions = data?.sessions ?? [];
  const pagedSessions = allSessions.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <div>
      <h2 className="page-title">{t("conversations.title")}</h2>
      <div className="subtitle">
        {t("conversations.subtitle", { active: data?.active ?? 0 })}
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {data && data.sessions.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <div style={{ marginBottom: 12, fontSize: 14 }}>{t("conversations.empty")}</div>
            <div style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 8 }}>
              {t("conversations.emptyHint")}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--text-dim)" }}>
              {t("conversations.optInHint")}
            </div>
          </div>
        </div>
      ) : null}

      {data && data.sessions.length > 0 ? (
        <div>
          {pagedSessions.map((group) => (
            <SessionRow key={group.sessionKey} group={group} />
          ))}
          <Pagination
            page={page}
            pageSize={pageSize}
            total={allSessions.length}
            onPageChange={setPage}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(0);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
