import { Link } from "react-router-dom";
import { api, type ConversationSummary } from "../api.js";
import { usePolling } from "../hooks.js";

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function statusTag(status: ConversationSummary["status"]) {
  const cls = status === "completed" ? "ok" : status === "active" ? "active" : "error";
  return <span className={`tag ${cls}`}>{status}</span>;
}

export function Conversations() {
  const { data, error } = usePolling(() => api.conversations(100), 5_000);

  return (
    <div>
      <h2 className="page-title">Conversations</h2>
      <div className="subtitle">
        full content audit · {data?.active ?? 0} in flight · click a runId to drill into the four
        touchpoints (project → OpenClaw → LLM → OpenClaw → project)
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {data && data.conversations.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <div style={{ marginBottom: 12, fontSize: 14 }}>
              no conversations captured yet
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              audit is opt-in. add this to your OpenClaw config to enable:
              <pre style={{ display: "inline-block", textAlign: "left", marginTop: 8 }}>
{`plugins:
  openclaw-monitor:
    audit:
      enabled: true`}
              </pre>
            </div>
          </div>
        </div>
      ) : null}

      {data && data.conversations.length > 0 ? (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>run id</th>
                <th>status</th>
                <th>channel</th>
                <th>started</th>
                <th>duration</th>
                <th className="num">hops</th>
                <th className="num">tokens in</th>
                <th className="num">tokens out</th>
                <th>preview</th>
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
