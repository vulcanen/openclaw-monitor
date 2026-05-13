import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ConversationSummary, type SessionGroup } from "../api.js";
import { Pagination } from "../components/Pagination.js";
import { friendlyEntryLabel, inferEntryKey } from "../entry-label.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

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
    <div className="panel" style={{ marginBottom: 12, padding: 0 }}>
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
              const key = inferEntryKey(group.channelId, firstRun?.trigger, firstRun?.runId);
              if (!key) return null;
              return (
                <span
                  title={
                    group.channelId === "webchat"
                      ? `host channel = "webchat" (OpenClaw INTERNAL_MESSAGE_CHANNEL). Display label inferred from runId / trigger.`
                      : `host channel = "${group.channelId}"`
                  }
                >
                  · {friendlyEntryLabel(t, key)}
                </span>
              );
            })()}
            <span>
              ·{" "}
              {t("conversations.session.tokens", {
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
  // "all" | "errors" | "ok" — most common on-call workflow is "show me
  // only the failed dialogues today", so filter is first-class.
  const [errorFilter, setErrorFilter] = useState<"all" | "errors" | "ok">("all");
  // Pull a generous slice so client-side paging has room; the API tops
  // out at 500 sessions per response, plenty for a single dashboard view.
  const fetcher = useMemo(
    () => () =>
      api.conversationsBySession(500, {
        ...(errorFilter === "errors" ? { hasError: true } : {}),
        ...(errorFilter === "ok" ? { hasError: false } : {}),
      }),
    [errorFilter],
  );
  const { data, error } = usePolling(fetcher, 5_000);
  const { window: timeWindow } = useTimeWindow();
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  // Filter session groups by lastSeenAt — a session whose most recent
  // conversation ended outside the window is hidden. Per-conversation
  // filtering inside a group would feel surprising (operators usually
  // think of the session as a unit).
  const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
  const allSessions = (data?.sessions ?? []).filter((s) => Date.parse(s.lastSeenAt) >= cutoffMs);
  const safePage =
    allSessions.length === 0 ? 0 : Math.min(page, Math.floor((allSessions.length - 1) / pageSize));
  const pagedSessions = allSessions.slice(safePage * pageSize, (safePage + 1) * pageSize);

  return (
    <div>
      <h2 className="page-title">{t("conversations.title")}</h2>
      <div className="subtitle">
        {t("conversations.subtitle", { active: data?.active ?? 0 })} ·{" "}
        {t(`topbar.window.${timeWindow}`)}
      </div>

      <div className="toolbar">
        <label htmlFor="conv-error-filter">{t("conversations.filter.status")}</label>
        <select
          id="conv-error-filter"
          value={errorFilter}
          onChange={(e) => {
            setErrorFilter(e.target.value as "all" | "errors" | "ok");
            setPage(0);
          }}
        >
          <option value="all">{t("common.any")}</option>
          <option value="errors">{t("conversations.filter.errorsOnly")}</option>
          <option value="ok">{t("conversations.filter.okOnly")}</option>
        </select>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {data && allSessions.length === 0 ? (
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

      {data && allSessions.length > 0 ? (
        <div>
          {pagedSessions.map((group) => (
            <SessionRow key={group.sessionKey} group={group} />
          ))}
          <Pagination
            page={safePage}
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
