import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { usePolling } from "../hooks.js";

export function RunDetail() {
  const params = useParams();
  const runId = params["runId"] ?? "";
  const { data, error } = usePolling(() => api.runDetail(runId), 5_000);

  return (
    <div>
      <Link to="/runs">← back to runs</Link>
      <h2 className="page-title" style={{ marginTop: 12 }}>
        run <code>{runId}</code>
      </h2>

      {error ? <div className="error-banner">{error}</div> : null}
      {!data ? <div className="empty">loading…</div> : null}

      {data ? (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>summary</h3>
            <table>
              <tbody>
                <tr>
                  <td>status</td>
                  <td>{data.run.status}</td>
                </tr>
                <tr>
                  <td>channel</td>
                  <td>{data.run.channel ?? "—"}</td>
                </tr>
                <tr>
                  <td>session</td>
                  <td>{data.run.sessionId ?? data.run.sessionKey ?? "—"}</td>
                </tr>
                <tr>
                  <td>started</td>
                  <td>{new Date(data.run.startedAt).toLocaleString()}</td>
                </tr>
                <tr>
                  <td>ended</td>
                  <td>
                    {data.run.endedAt ? new Date(data.run.endedAt).toLocaleString() : "—"}
                  </td>
                </tr>
                <tr>
                  <td>duration ms</td>
                  <td>{data.run.durationMs ?? "—"}</td>
                </tr>
                <tr>
                  <td>model calls</td>
                  <td>{data.run.modelCalls}</td>
                </tr>
                <tr>
                  <td>tool execs</td>
                  <td>{data.run.toolExecs}</td>
                </tr>
                {data.run.errorMessage ? (
                  <tr>
                    <td>error</td>
                    <td className="err">{data.run.errorMessage}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h3>event trace ({data.events.length})</h3>
            {data.events.length === 0 ? (
              <div className="empty">
                no events still buffered for this run · try drilling soon after run completion
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>time</th>
                    <th>type</th>
                    <th>payload</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((evt, idx) => (
                    <tr key={`${evt.capturedAt}-${idx}`}>
                      <td>{new Date(evt.capturedAt).toLocaleTimeString()}</td>
                      <td>{evt.type}</td>
                      <td>
                        <code style={{ fontSize: 11 }}>
                          {JSON.stringify(evt.payload).slice(0, 240)}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
