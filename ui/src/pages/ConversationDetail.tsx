import { Link, useParams } from "react-router-dom";
import { api, type ConversationRecord } from "../api.js";
import { usePolling } from "../hooks.js";

function Section({
  title,
  index,
  capturedAt,
  truncated,
  children,
}: {
  title: string;
  index: number;
  capturedAt?: string;
  truncated?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h3>
        <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", marginRight: 8 }}>
          {index}
        </span>
        {title}
        {capturedAt ? (
          <span
            style={{
              float: "right",
              color: "var(--text-dim)",
              fontFamily: "var(--mono)",
              fontWeight: 400,
              fontSize: 11,
            }}
          >
            {new Date(capturedAt).toLocaleTimeString()}
            {truncated ? <span className="tag warn" style={{ marginLeft: 8 }}>truncated</span> : null}
          </span>
        ) : null}
      </h3>
      {children}
    </div>
  );
}

function MessageBox({ label, content }: { label: string; content?: string }) {
  if (content === undefined) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          textTransform: "uppercase",
          letterSpacing: 0.04,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <pre style={{ whiteSpace: "pre-wrap" }}>{content}</pre>
    </div>
  );
}

function HistoryView({ messages, count }: { messages: unknown[]; count?: number }) {
  if (!messages || messages.length === 0) {
    return <div className="empty" style={{ padding: 16 }}>(no history captured)</div>;
  }
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 8,
        }}
      >
        showing {messages.length} of {count ?? messages.length} messages
      </div>
      {messages.map((msg, idx) => (
        <pre key={idx} style={{ whiteSpace: "pre-wrap", marginBottom: 6, fontSize: 11 }}>
          {JSON.stringify(msg, null, 2)}
        </pre>
      ))}
    </div>
  );
}

function Inbound({ record }: { record: ConversationRecord }) {
  if (!record.inbound) {
    return (
      <Section title="project → OpenClaw" index={1}>
        <div className="empty" style={{ padding: 16 }}>
          (no inbound captured · before_prompt_build hook did not fire for this run)
        </div>
      </Section>
    );
  }
  return (
    <Section
      title="project → OpenClaw"
      index={1}
      capturedAt={record.inbound.capturedAt}
      truncated={record.inbound.truncated}
    >
      <MessageBox label="prompt" content={record.inbound.prompt} />
      <details>
        <summary style={{ cursor: "pointer", color: "var(--accent)", fontSize: 12 }}>
          session history ({record.inbound.historyCount})
        </summary>
        <div style={{ marginTop: 8 }}>
          <HistoryView
            messages={record.inbound.history}
            count={record.inbound.historyCount}
          />
        </div>
      </details>
    </Section>
  );
}

function LlmExchanges({ record }: { record: ConversationRecord }) {
  const pairs: Array<{ input?: ConversationRecord["llmInputs"][number]; output?: ConversationRecord["llmOutputs"][number] }> = [];
  const max = Math.max(record.llmInputs.length, record.llmOutputs.length);
  for (let i = 0; i < max; i += 1) {
    pairs.push({ input: record.llmInputs[i], output: record.llmOutputs[i] });
  }
  if (pairs.length === 0) {
    return (
      <Section title="OpenClaw ↔ LLM" index={2}>
        <div className="empty" style={{ padding: 16 }}>(no llm_input / llm_output captured)</div>
      </Section>
    );
  }
  return (
    <>
      {pairs.map((pair, idx) => (
        <div key={idx} className="grid cols-2" style={{ marginBottom: 16 }}>
          <Section
            title={pairs.length > 1 ? `OpenClaw → LLM (hop ${idx + 1})` : "OpenClaw → LLM"}
            index={2}
            capturedAt={pair.input?.capturedAt}
            truncated={pair.input?.truncated}
          >
            {pair.input ? (
              <>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-dim)",
                    marginBottom: 8,
                  }}
                >
                  <span className="tag">{pair.input.provider}</span>{" "}
                  <code>{pair.input.model}</code>
                  {pair.input.imagesCount > 0 ? (
                    <span style={{ marginLeft: 8 }}>· {pair.input.imagesCount} images</span>
                  ) : null}
                </div>
                {pair.input.systemPrompt ? (
                  <MessageBox label="system" content={pair.input.systemPrompt} />
                ) : null}
                <MessageBox label="prompt" content={pair.input.prompt} />
                {pair.input.historyMessages.length > 0 ? (
                  <details>
                    <summary
                      style={{ cursor: "pointer", color: "var(--accent)", fontSize: 12 }}
                    >
                      history ({pair.input.historyMessages.length})
                    </summary>
                    <div style={{ marginTop: 8 }}>
                      <HistoryView messages={pair.input.historyMessages} />
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
              <div className="empty" style={{ padding: 16 }}>(no input)</div>
            )}
          </Section>
          <Section
            title={pairs.length > 1 ? `LLM → OpenClaw (hop ${idx + 1})` : "LLM → OpenClaw"}
            index={3}
            capturedAt={pair.output?.capturedAt}
            truncated={pair.output?.truncated}
          >
            {pair.output ? (
              <>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-dim)",
                    marginBottom: 8,
                  }}
                >
                  <span className="tag">{pair.output.provider}</span>{" "}
                  <code>{pair.output.model}</code>
                  {pair.output.usage ? (
                    <span style={{ marginLeft: 8 }}>
                      · in {pair.output.usage.input ?? 0} / out {pair.output.usage.output ?? 0}
                    </span>
                  ) : null}
                </div>
                {pair.output.assistantTexts.map((text, ti) => (
                  <MessageBox key={ti} label={`assistant text ${ti + 1}`} content={text} />
                ))}
              </>
            ) : (
              <div className="empty" style={{ padding: 16 }}>(no output)</div>
            )}
          </Section>
        </div>
      ))}
    </>
  );
}

function Outbound({ record }: { record: ConversationRecord }) {
  if (!record.outbound) {
    return (
      <Section title="OpenClaw → project" index={4}>
        <div className="empty" style={{ padding: 16 }}>
          (no outbound captured · agent_end hook did not fire — likely abort/timeout)
        </div>
      </Section>
    );
  }
  return (
    <Section
      title="OpenClaw → project"
      index={4}
      capturedAt={record.outbound.capturedAt}
      truncated={record.outbound.truncated}
    >
      <div
        style={{
          marginBottom: 12,
          fontSize: 11,
          color: "var(--text-dim)",
        }}
      >
        success: <span className={record.outbound.success ? "tag ok" : "tag error"}>
          {String(record.outbound.success)}
        </span>
        {record.errorMessage ? (
          <span style={{ marginLeft: 8 }} className="err">
            {record.errorMessage}
          </span>
        ) : null}
      </div>
      <HistoryView messages={record.outbound.messages} />
    </Section>
  );
}

export function ConversationDetail() {
  const params = useParams();
  const runId = params["runId"] ?? "";
  const { data, error } = usePolling(() => api.conversationDetail(runId), 10_000);

  return (
    <div>
      <Link to="/conversations">← back to conversations</Link>
      <h2 className="page-title" style={{ marginTop: 12 }}>
        conversation <code>{runId}</code>
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
                  <td>{data.conversation.status}</td>
                </tr>
                <tr>
                  <td>channel / trigger</td>
                  <td>
                    {data.conversation.trigger ?? data.conversation.channelId ?? "—"}
                  </td>
                </tr>
                <tr>
                  <td>started</td>
                  <td>{new Date(data.conversation.startedAt).toLocaleString()}</td>
                </tr>
                <tr>
                  <td>ended</td>
                  <td>
                    {data.conversation.endedAt
                      ? new Date(data.conversation.endedAt).toLocaleString()
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td>duration ms</td>
                  <td>{data.conversation.durationMs ?? "—"}</td>
                </tr>
                <tr>
                  <td>llm hops</td>
                  <td>{data.conversation.llmInputs.length}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <Inbound record={data.conversation} />
          <LlmExchanges record={data.conversation} />
          <Outbound record={data.conversation} />
        </>
      ) : null}
    </div>
  );
}
