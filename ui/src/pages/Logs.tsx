import { useMemo, useState } from "react";
import { api } from "../api.js";
import { Pagination } from "../components/Pagination.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

export function Logs() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();
  const [level, setLevel] = useState("");
  const [component, setComponent] = useState("");
  const [typePrefix, setTypePrefix] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  // Fetch a larger window so client-side paging has data to slice. The
  // backend caps at 2000 records per response (MAX_LOGS_PAGE).
  const fetcher = useMemo(
    () => () =>
      api.logs({
        ...(level ? { level } : {}),
        ...(component ? { component } : {}),
        ...(typePrefix ? { typePrefix } : {}),
        limit: 1000,
      }),
    [level, component, typePrefix],
  );
  const { data, error, refresh } = usePolling(fetcher, 4_000);
  // Apply the global time-window selector client-side. The backend doesn't
  // have a `since=` parameter on /logs (the buffer is a ring; adding one
  // would just discard already-fetched data). Filter the fetched records
  // by capturedAt instead — cheap, immediate response on window changes,
  // no extra round-trip.
  const allRecords = useMemo(() => {
    const records = data?.records ?? [];
    const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
    return records.filter((r) => Date.parse(r.capturedAt) >= cutoffMs);
  }, [data, timeWindow]);
  // Clamp page back into range when filters / window shrink the record
  // count below the current page offset. Otherwise the table renders
  // empty after a filter change even though there are matching records
  // on page 1.
  const safePage =
    allRecords.length === 0 ? 0 : Math.min(page, Math.floor((allRecords.length - 1) / pageSize));
  const pagedRecords = allRecords.slice(safePage * pageSize, (safePage + 1) * pageSize);

  return (
    <div>
      <h2 className="page-title">{t("logs.title")}</h2>
      <div className="subtitle">{t("logs.subtitle")}</div>

      <div className="toolbar">
        <label htmlFor="logs-level">{t("logs.filter.level")}</label>
        <select
          id="logs-level"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(0);
          }}
        >
          <option value="">{t("common.any")}</option>
          <option value="trace">trace</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <label htmlFor="logs-component">{t("logs.filter.component")}</label>
        <input
          id="logs-component"
          type="text"
          value={component}
          onChange={(e) => {
            setComponent(e.target.value);
            setPage(0);
          }}
          placeholder={t("logs.filter.componentPlaceholder")}
        />
        <label htmlFor="logs-type-prefix">{t("logs.filter.typePrefix")}</label>
        <select
          id="logs-type-prefix"
          value={typePrefix}
          onChange={(e) => {
            setTypePrefix(e.target.value);
            setPage(0);
          }}
        >
          <option value="">{t("common.any")}</option>
          <option value="model.">model.*</option>
          <option value="tool.">tool.*</option>
          <option value="harness.">harness.*</option>
          <option value="session.">session.*</option>
          <option value="message.">message.*</option>
          <option value="webhook.">webhook.*</option>
          <option value="diagnostic.">diagnostic.*</option>
          <option value="queue.">queue.*</option>
        </select>
        <button onClick={refresh}>{t("common.refresh")}</button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel" style={{ padding: 0 }}>
        {!data ? (
          <div className="empty">{t("common.loading")}</div>
        ) : allRecords.length === 0 ? (
          <div className="empty" style={{ padding: 24 }}>
            <div style={{ marginBottom: 12, fontSize: 14 }}>{t("empty.logs")}</div>
            {/* Three-tier diagnostic — most likely cause first. Mirrors the
                Costs / ConversationDetail empty-state pattern (decision #42). */}
            <div style={{ fontSize: 12, lineHeight: 1.7, color: "var(--text-dim)" }}>
              <div style={{ marginBottom: 6 }}>
                <strong style={{ color: "var(--text)" }}>1.</strong> {t("empty.logs.hint.filter")}
              </div>
              <div style={{ marginBottom: 6 }}>
                <strong style={{ color: "var(--text)" }}>2.</strong> {t("empty.logs.hint.warmup")}
              </div>
              <div>
                <strong style={{ color: "var(--text)" }}>3.</strong>{" "}
                {t("empty.logs.hint.noTraffic")}
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div
              className="log-row"
              style={{
                background: "var(--panel-2)",
                fontWeight: 600,
                textTransform: "uppercase",
                fontSize: 11,
              }}
            >
              <div>{t("logs.col.time")}</div>
              <div>{t("logs.col.level")}</div>
              <div>{t("logs.col.component")}</div>
              <div>{t("logs.col.message")}</div>
            </div>
            {pagedRecords.map((rec, idx) => (
              <div className="log-row" key={`${rec.capturedAt}-${idx}`}>
                <div className="ts">{new Date(rec.capturedAt).toLocaleTimeString()}</div>
                <div className={`level ${rec.level ?? ""}`}>{rec.level ?? "—"}</div>
                <div className="component">{rec.component ?? "—"}</div>
                <div className="msg">{rec.message}</div>
              </div>
            ))}
            <div style={{ padding: "0 12px" }}>
              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={allRecords.length}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPageSize(n);
                  setPage(0);
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
