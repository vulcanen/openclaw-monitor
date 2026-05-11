import { Link, useParams } from "react-router-dom";
import { api, type ConversationRecord } from "../api.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import type { TranslateFn } from "../i18n/index.js";

function Section({
  title,
  index,
  capturedAt,
  truncated,
  children,
  t,
}: {
  title: string;
  index: number;
  capturedAt?: string;
  truncated?: boolean;
  children: React.ReactNode;
  t: TranslateFn;
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
            {truncated ? (
              <span className="tag warn" style={{ marginLeft: 8 }}>
                {t("common.truncated")}
              </span>
            ) : null}
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

function HistoryView({
  messages,
  count,
  t,
}: {
  messages: unknown[];
  count?: number;
  t: TranslateFn;
}) {
  if (!messages || messages.length === 0) {
    return (
      <div className="empty" style={{ padding: 16 }}>
        {t("empty.history")}
      </div>
    );
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
        {t("conversationDetail.label.historyShowing", {
          shown: messages.length,
          total: count ?? messages.length,
        })}
      </div>
      {messages.map((msg, idx) => (
        <pre key={idx} style={{ whiteSpace: "pre-wrap", marginBottom: 6, fontSize: 11 }}>
          {JSON.stringify(msg, null, 2)}
        </pre>
      ))}
    </div>
  );
}

function Inbound({ record, t }: { record: ConversationRecord; t: TranslateFn }) {
  if (!record.inbound) {
    return (
      <Section title={t("conversationDetail.section.inbound")} index={1} t={t}>
        <div className="empty" style={{ padding: 16 }}>
          {t("conversationDetail.empty.inbound")}
        </div>
      </Section>
    );
  }
  return (
    <Section
      title={t("conversationDetail.section.inbound")}
      index={1}
      capturedAt={record.inbound.capturedAt}
      truncated={record.inbound.truncated}
      t={t}
    >
      <MessageBox label={t("conversationDetail.label.prompt")} content={record.inbound.prompt} />
      <details>
        <summary style={{ cursor: "pointer", color: "var(--accent)", fontSize: 12 }}>
          {t("conversationDetail.label.history", { count: record.inbound.historyCount })}
        </summary>
        <div style={{ marginTop: 8 }}>
          <HistoryView
            messages={record.inbound.history}
            count={record.inbound.historyCount}
            t={t}
          />
        </div>
      </details>
    </Section>
  );
}

function LlmExchanges({ record, t }: { record: ConversationRecord; t: TranslateFn }) {
  const pairs: Array<{
    input?: ConversationRecord["llmInputs"][number];
    output?: ConversationRecord["llmOutputs"][number];
  }> = [];
  const max = Math.max(record.llmInputs.length, record.llmOutputs.length);
  for (let i = 0; i < max; i += 1) {
    pairs.push({ input: record.llmInputs[i], output: record.llmOutputs[i] });
  }
  if (pairs.length === 0) {
    return (
      <Section title={t("conversationDetail.section.llmInput")} index={2} t={t}>
        <div className="empty" style={{ padding: 16 }}>
          {t("conversationDetail.empty.exchange")}
        </div>
      </Section>
    );
  }
  return (
    <>
      {pairs.map((pair, idx) => (
        <div key={idx} className="grid cols-2" style={{ marginBottom: 16 }}>
          <Section
            title={
              pairs.length > 1
                ? t("conversationDetail.section.llmInputHop", { n: idx + 1 })
                : t("conversationDetail.section.llmInput")
            }
            index={2}
            capturedAt={pair.input?.capturedAt}
            truncated={pair.input?.truncated}
            t={t}
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
                    <span style={{ marginLeft: 8 }}>
                      ·{" "}
                      {t("conversationDetail.label.images", { count: pair.input.imagesCount })}
                    </span>
                  ) : null}
                </div>
                {pair.input.systemPrompt ? (
                  <MessageBox
                    label={t("conversationDetail.label.system")}
                    content={pair.input.systemPrompt}
                  />
                ) : null}
                <MessageBox
                  label={t("conversationDetail.label.prompt")}
                  content={pair.input.prompt}
                />
                {pair.input.historyMessages.length > 0 ? (
                  <details>
                    <summary
                      style={{ cursor: "pointer", color: "var(--accent)", fontSize: 12 }}
                    >
                      {t("conversationDetail.label.historyShort", {
                        count: pair.input.historyMessages.length,
                      })}
                    </summary>
                    <div style={{ marginTop: 8 }}>
                      <HistoryView messages={pair.input.historyMessages} t={t} />
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
              <div className="empty" style={{ padding: 16 }}>
                {t("empty.input")}
              </div>
            )}
          </Section>
          <Section
            title={
              pairs.length > 1
                ? t("conversationDetail.section.llmOutputHop", { n: idx + 1 })
                : t("conversationDetail.section.llmOutput")
            }
            index={3}
            capturedAt={pair.output?.capturedAt}
            truncated={pair.output?.truncated}
            t={t}
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
                      ·{" "}
                      {t("conversationDetail.label.tokens", {
                        input: pair.output.usage.input ?? 0,
                        output: pair.output.usage.output ?? 0,
                      })}
                    </span>
                  ) : null}
                </div>
                {pair.output.assistantTexts.map((text, ti) => (
                  <MessageBox
                    key={ti}
                    label={t("conversationDetail.label.assistantText", { n: ti + 1 })}
                    content={text}
                  />
                ))}
              </>
            ) : (
              <div className="empty" style={{ padding: 16 }}>
                {t("empty.output")}
              </div>
            )}
          </Section>
        </div>
      ))}
    </>
  );
}

function Outbound({ record, t }: { record: ConversationRecord; t: TranslateFn }) {
  if (!record.outbound) {
    return (
      <Section title={t("conversationDetail.section.outbound")} index={4} t={t}>
        <div className="empty" style={{ padding: 16 }}>
          {t("conversationDetail.empty.outbound")}
        </div>
      </Section>
    );
  }
  return (
    <Section
      title={t("conversationDetail.section.outbound")}
      index={4}
      capturedAt={record.outbound.capturedAt}
      truncated={record.outbound.truncated}
      t={t}
    >
      <div
        style={{
          marginBottom: 12,
          fontSize: 11,
          color: "var(--text-dim)",
        }}
      >
        {t("conversationDetail.row.success")}:{" "}
        <span className={record.outbound.success ? "tag ok" : "tag error"}>
          {String(record.outbound.success)}
        </span>
        {record.errorMessage ? (
          <span style={{ marginLeft: 8 }} className="err">
            {record.errorMessage}
          </span>
        ) : null}
      </div>
      <HistoryView messages={record.outbound.messages} t={t} />
    </Section>
  );
}

export function ConversationDetail() {
  const { t } = useI18n();
  const params = useParams();
  const runId = params["runId"] ?? "";
  const { data, error } = usePolling(() => api.conversationDetail(runId), 10_000);

  return (
    <div>
      <Link to="/conversations">{t("conversationDetail.backToList")}</Link>
      <h2 className="page-title" style={{ marginTop: 12 }}>
        {t("conversationDetail.title", { runId: "" })}
        <code>{runId}</code>
      </h2>

      {error ? <div className="error-banner">{error}</div> : null}
      {!data ? <div className="empty">{t("common.loading")}</div> : null}

      {data ? (
        <>
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>{t("conversationDetail.summary")}</h3>
            <table>
              <tbody>
                <tr>
                  <td>{t("conversationDetail.row.status")}</td>
                  <td>{data.conversation.status}</td>
                </tr>
                <tr>
                  <td>{t("conversationDetail.row.channelTrigger")}</td>
                  <td>
                    {data.conversation.trigger ?? data.conversation.channelId ?? "—"}
                  </td>
                </tr>
                <tr>
                  <td>{t("conversationDetail.row.started")}</td>
                  <td>{new Date(data.conversation.startedAt).toLocaleString()}</td>
                </tr>
                <tr>
                  <td>{t("conversationDetail.row.ended")}</td>
                  <td>
                    {data.conversation.endedAt
                      ? new Date(data.conversation.endedAt).toLocaleString()
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td>{t("conversationDetail.row.durationMs")}</td>
                  <td>{data.conversation.durationMs ?? "—"}</td>
                </tr>
                <tr>
                  <td>{t("conversationDetail.row.llmHops")}</td>
                  <td>{data.conversation.llmInputs.length}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <Inbound record={data.conversation} t={t} />
          <LlmExchanges record={data.conversation} t={t} />
          <Outbound record={data.conversation} t={t} />
        </>
      ) : null}
    </div>
  );
}
