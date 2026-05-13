import { useMemo, useState } from "react";
import { api } from "../api.js";
import { Pagination } from "../components/Pagination.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

/**
 * Sessions page (v0.9.7, data source widened in v0.9.7.1).
 *
 * Originally read only the synthesized `session.lifecycle.started` /
 * `session.lifecycle.ended` events, which turn out to only fire on
 * **agent-harness session lifecycle** (a session file getting created /
 * deleted) — Control-UI chats and OpenAI-compat API calls don't touch
 * the harness session machinery, so the page was empty in practice.
 *
 * We now derive the session list from the universally-fired
 * `session.state` events (idle ↔ processing transitions emitted on every
 * message), keyed by sessionKey. The lifecycle.ended events, when
 * present, override status to "ended" with the host-supplied reason and
 * duration — that signal is authoritative when it does fire.
 *
 * One row per unique sessionKey. "Active" = most recent state is
 * `processing` (i.e. mid-message) AND no lifecycle.ended event was
 * recorded; otherwise "idle".
 */

type StateEvent = {
  type: string;
  capturedAt: string;
  payload: Record<string, unknown>;
};

type Session = {
  sessionKey: string;
  sessionId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  durationMs?: number;
  messageCount: number;
  /** "processing" when the most recent state.state is processing.
   *  "idle" otherwise. "ended" when a session.lifecycle.ended event
   *  superseded the state stream (host explicitly tore the session
   *  down). */
  status: "processing" | "idle" | "ended";
  endedReason?: string;
};

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function buildSessions(stateEvents: StateEvent[], lifecycleEvents: StateEvent[]): Session[] {
  const byKey = new Map<string, Session>();

  for (const evt of stateEvents) {
    const p = evt.payload as {
      sessionKey?: unknown;
      sessionId?: unknown;
      state?: unknown;
      reason?: unknown;
    };
    if (typeof p.sessionKey !== "string") continue;
    const key = p.sessionKey;
    let s = byKey.get(key);
    if (!s) {
      s = {
        sessionKey: key,
        firstSeenAt: evt.capturedAt,
        lastSeenAt: evt.capturedAt,
        messageCount: 0,
        status: "idle",
      };
      byKey.set(key, s);
    }
    if (typeof p.sessionId === "string" && !s.sessionId) s.sessionId = p.sessionId;
    if (evt.capturedAt < s.firstSeenAt) s.firstSeenAt = evt.capturedAt;
    if (evt.capturedAt > s.lastSeenAt) s.lastSeenAt = evt.capturedAt;
    if (p.reason === "message_start") s.messageCount += 1;
    if (p.state === "processing") s.status = "processing";
    else if (p.state === "idle") s.status = "idle";
  }

  // Lifecycle.ended is authoritative — overrides the state-stream view
  // when a session was explicitly torn down by the host.
  for (const evt of lifecycleEvents) {
    if (evt.type !== "session.lifecycle.ended") continue;
    const p = evt.payload as {
      sessionKey?: unknown;
      durationMs?: unknown;
      reason?: unknown;
    };
    if (typeof p.sessionKey !== "string") continue;
    const s = byKey.get(p.sessionKey);
    if (!s) continue;
    s.status = "ended";
    if (typeof p.durationMs === "number") s.durationMs = p.durationMs;
    if (typeof p.reason === "string") s.endedReason = p.reason;
  }

  // For sessions that don't have a lifecycle.ended event, synthesize a
  // duration from firstSeen/lastSeen — useful for the column even when
  // the session is mid-activity.
  for (const s of byKey.values()) {
    if (s.durationMs === undefined) {
      const a = Date.parse(s.firstSeenAt);
      const b = Date.parse(s.lastSeenAt);
      if (Number.isFinite(a) && Number.isFinite(b)) s.durationMs = Math.max(0, b - a);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function Sessions() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();
  // session.state is the universally-fired signal — every message tick
  // produces one. Pull a generous slice so the session table covers
  // recent traffic even on chatty deployments.
  const stateFetcher = useMemo(() => () => api.events({ type: "session.state", limit: 500 }), []);
  const startedFetcher = useMemo(
    () => () => api.events({ type: "session.lifecycle.started", limit: 200 }),
    [],
  );
  const endedFetcher = useMemo(
    () => () => api.events({ type: "session.lifecycle.ended", limit: 200 }),
    [],
  );
  const { data: stateData, error: errState } = usePolling(stateFetcher, 5_000);
  const { data: startedData, error: errStart } = usePolling(startedFetcher, 10_000);
  const { data: endedData, error: errEnd } = usePolling(endedFetcher, 10_000);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "idle" | "ended">("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  const sessions = useMemo(() => {
    const states = (stateData?.events ?? []) as StateEvent[];
    const lifecycle = [
      ...((startedData?.events ?? []) as StateEvent[]),
      ...((endedData?.events ?? []) as StateEvent[]),
    ];
    return buildSessions(states, lifecycle);
  }, [stateData, startedData, endedData]);

  // Apply global time-window filter on lastSeen so the dropdown change is
  // immediately visible. A session whose most recent activity is older
  // than the window is hidden — same semantics as Logs.
  const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
  const inWindow = sessions.filter((s) => Date.parse(s.lastSeenAt) >= cutoffMs);
  const filtered = inWindow.filter((s) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "active") return s.status === "processing";
    if (statusFilter === "idle") return s.status === "idle";
    return s.status === "ended";
  });
  const safePage =
    filtered.length === 0 ? 0 : Math.min(page, Math.floor((filtered.length - 1) / pageSize));
  const paged = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const error = errState ?? errStart ?? errEnd;
  const activeCount = sessions.filter((s) => s.status === "processing").length;

  return (
    <div>
      <h2 className="page-title">{t("sessions.title")}</h2>
      <div className="subtitle">
        {t("sessions.subtitle", { active: activeCount, total: sessions.length })}
      </div>

      <div className="toolbar">
        <label htmlFor="sessions-status">{t("sessions.filter.status")}</label>
        <select
          id="sessions-status"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as "all" | "active" | "idle" | "ended");
            setPage(0);
          }}
        >
          <option value="all">{t("common.any")}</option>
          <option value="active">{t("sessions.status.processing")}</option>
          <option value="idle">{t("sessions.status.idle")}</option>
          <option value="ended">{t("sessions.status.ended")}</option>
        </select>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel">
        {!stateData ? (
          <div className="empty">{t("common.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            <div style={{ marginBottom: 12, fontSize: 14 }}>{t("sessions.empty")}</div>
            <div style={{ fontSize: 12, lineHeight: 1.7, color: "var(--text-dim)" }}>
              {t("sessions.emptyHint")}
            </div>
          </div>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>{t("sessions.col.sessionKey")}</th>
                  <th>{t("sessions.col.status")}</th>
                  <th>{t("sessions.col.started")}</th>
                  <th>{t("sessions.col.ended")}</th>
                  <th>{t("sessions.col.duration")}</th>
                  <th>{t("sessions.col.reason")}</th>
                  <th className="num">{t("sessions.col.messages")}</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((s) => (
                  <tr key={s.sessionKey}>
                    <td
                      style={{ fontFamily: "var(--mono)", fontSize: 12 }}
                      title={s.sessionId ?? s.sessionKey}
                    >
                      {s.sessionKey}
                    </td>
                    <td>
                      <span
                        className={`tag ${
                          s.status === "processing" ? "active" : s.status === "idle" ? "" : "ok"
                        }`}
                      >
                        {t(`sessions.status.${s.status}` as const)}
                      </span>
                    </td>
                    <td>{new Date(s.firstSeenAt).toLocaleString()}</td>
                    <td>
                      {s.status === "ended" || s.status === "idle"
                        ? new Date(s.lastSeenAt).toLocaleString()
                        : "—"}
                    </td>
                    <td>{fmtDuration(s.durationMs)}</td>
                    <td style={{ color: "var(--text-dim)", fontSize: 12 }}>
                      {s.endedReason ?? "—"}
                    </td>
                    <td className="num">{s.messageCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              page={safePage}
              pageSize={pageSize}
              total={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(0);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
