import { useMemo, useState } from "react";
import { api } from "../api.js";
import { usePolling } from "../hooks.js";

export function Logs() {
  const [level, setLevel] = useState("");
  const [component, setComponent] = useState("");

  const fetcher = useMemo(
    () => () =>
      api.logs({
        ...(level ? { level } : {}),
        ...(component ? { component } : {}),
        limit: 300,
      }),
    [level, component],
  );
  const { data, error, refresh } = usePolling(fetcher, 4_000);

  return (
    <div>
      <h2 className="page-title">Logs</h2>
      <div className="subtitle">
        redacted log records emitted via the diagnostic event bus · refreshes every 4s
      </div>

      <div className="toolbar">
        <label>level</label>
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">any</option>
          <option value="trace">trace</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <label>component</label>
        <input
          type="text"
          value={component}
          onChange={(e) => setComponent(e.target.value)}
          placeholder="e.g. gateway"
        />
        <button onClick={refresh}>refresh</button>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel" style={{ padding: 0 }}>
        {!data ? (
          <div className="empty">loading…</div>
        ) : data.records.length === 0 ? (
          <div className="empty">no log records buffered</div>
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
              <div>time</div>
              <div>level</div>
              <div>component</div>
              <div>message</div>
            </div>
            {data.records.map((rec, idx) => (
              <div className="log-row" key={`${rec.capturedAt}-${idx}`}>
                <div className="ts">{new Date(rec.capturedAt).toLocaleTimeString()}</div>
                <div className={`level ${rec.level ?? ""}`}>{rec.level ?? "—"}</div>
                <div className="component">{rec.component ?? "—"}</div>
                <div className="msg">{rec.message}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
