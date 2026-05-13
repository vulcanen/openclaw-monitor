import { Link, useParams } from "react-router-dom";
import { api, type ConversationRecord } from "../api.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import type { TranslateFn } from "../i18n/index.js";

/**
 * Conversation detail — timeline-of-cards layout (v0.9.5).
 *
 * The earlier 4-section layout ("sender → OpenClaw → LLM → OpenClaw → sender")
 * had a structural defect: each section was independent and rendered an empty
 * shell whenever its data wasn't captured. Many host flows only emit a
 * subset of hooks (e.g. llm_output silently dropped by certain providers
 * or audit gate configurations), so the LLM-output section frequently
 * looked broken even when everything else worked.
 *
 * The timeline groups one LLM call's input + output into ONE card (they
 * naturally belong together), filters out events with no captured content,
 * and surfaces a diagnostic hint when a half-captured hop is detected.
 */

type Marker = "inbound" | "llmHop" | "outbound" | "error";

type TimelineItem =
  | { kind: "inbound"; at: string; data: NonNullable<ConversationRecord["inbound"]> }
  | {
      kind: "llmHop";
      at: string;
      index: number;
      total: number;
      input?: ConversationRecord["llmInputs"][number];
      output?: ConversationRecord["llmOutputs"][number];
    }
  | { kind: "outbound"; at: string; data: NonNullable<ConversationRecord["outbound"]> }
  | { kind: "error"; at: string; message: string };

const MARKER_COLOR: Record<Marker, string> = {
  inbound: "var(--text-dim)",
  llmHop: "var(--accent)",
  outbound: "var(--accent-2)",
  error: "var(--error)",
};

function buildTimeline(record: ConversationRecord): TimelineItem[] {
  const items: TimelineItem[] = [];
  if (record.inbound) {
    items.push({ kind: "inbound", at: record.inbound.capturedAt, data: record.inbound });
  }
  const hops = Math.max(record.llmInputs.length, record.llmOutputs.length);
  for (let i = 0; i < hops; i += 1) {
    const input = record.llmInputs[i];
    const output = record.llmOutputs[i];
    const at = input?.capturedAt ?? output?.capturedAt ?? record.startedAt;
    items.push({
      kind: "llmHop",
      at,
      index: i,
      total: hops,
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    });
  }
  if (record.outbound) {
    items.push({ kind: "outbound", at: record.outbound.capturedAt, data: record.outbound });
  }
  if (record.errorMessage) {
    items.push({
      kind: "error",
      at: record.endedAt ?? record.startedAt,
      message: record.errorMessage,
    });
  }
  items.sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
    return ta - tb;
  });
  return items;
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false }) +
    `.${String(new Date(ms).getMilliseconds()).padStart(3, "0")}`;
}

function Card({
  marker,
  title,
  at,
  badges,
  truncated,
  children,
  t,
}: {
  marker: Marker;
  title: string;
  at: string;
  badges?: React.ReactNode;
  truncated?: boolean;
  children: React.ReactNode;
  t: TranslateFn;
}) {
  return (
    <div
      className="panel"
      style={{
        display: "flex",
        gap: 12,
        marginBottom: 12,
        borderLeft: `3px solid ${MARKER_COLOR[marker]}`,
        paddingLeft: 16,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text)",
                textTransform: "uppercase",
                letterSpacing: 0.04,
              }}
            >
              {title}
            </span>
            {badges}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            {truncated ? (
              <span className="tag warn">{t("common.truncated")}</span>
            ) : null}
            <span
              style={{
                color: "var(--text-dim)",
                fontFamily: "var(--mono)",
                fontSize: 11,
              }}
            >
              {formatTime(at)}
            </span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function ContentBlock({
  label,
  content,
  mono,
}: {
  label?: string;
  content?: string;
  mono?: boolean;
}) {
  if (content === undefined || content === "") return null;
  return (
    <div style={{ marginBottom: 10 }}>
      {label ? (
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
      ) : null}
      <pre
        style={{
          whiteSpace: "pre-wrap",
          fontFamily: mono ? "var(--mono)" : "var(--font)",
          fontSize: mono ? 12 : 13,
          margin: 0,
        }}
      >
        {content}
      </pre>
    </div>
  );
}

function HistoryDetails({
  messages,
  count,
  label,
  t,
}: {
  messages: unknown[];
  count: number;
  label: string;
  t: TranslateFn;
}) {
  if (!messages || messages.length === 0) return null;
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", color: "var(--accent)", fontSize: 12 }}>
        {label}
      </summary>
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 6,
        }}
      >
        {t("conversationDetail.label.historyShowing", {
          shown: messages.length,
          total: count,
        })}
      </div>
      {messages.map((msg, idx) => (
        <pre
          key={idx}
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 11,
            fontFamily: "var(--mono)",
            marginBottom: 6,
          }}
        >
          {JSON.stringify(msg, null, 2)}
        </pre>
      ))}
    </details>
  );
}

function InboundCardView({ item, t }: { item: Extract<TimelineItem, { kind: "inbound" }>; t: TranslateFn }) {
  const { data } = item;
  const badges = (
    <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
      {t("conversationDetail.timeline.inboundSub")}
    </span>
  );
  return (
    <Card
      marker="inbound"
      title={t("conversationDetail.timeline.inbound")}
      at={item.at}
      badges={badges}
      truncated={data.truncated}
      t={t}
    >
      <ContentBlock content={data.prompt} />
      <HistoryDetails
        messages={data.history}
        count={data.historyCount}
        label={t("conversationDetail.label.history", { count: data.historyCount })}
        t={t}
      />
    </Card>
  );
}

function LlmHopCardView({ item, t }: { item: Extract<TimelineItem, { kind: "llmHop" }>; t: TranslateFn }) {
  const ref = item.output ?? item.input;
  const provider = ref?.provider ?? "?";
  const model = ref?.model ?? "?";
  const title =
    item.total > 1
      ? t("conversationDetail.timeline.llmHopN", { n: item.index + 1, total: item.total })
      : t("conversationDetail.timeline.llmHop");
  const usage = item.output?.usage;
  const tokenSummary =
    usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)
      ? t("conversationDetail.timeline.tokens", {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
        })
      : null;
  const truncated = Boolean(item.input?.truncated || item.output?.truncated);
  const badges = (
    <>
      <span className="tag">{provider}</span>
      <code style={{ fontSize: 12, color: "var(--text-dim)" }}>{model}</code>
      {tokenSummary ? (
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>· {tokenSummary}</span>
      ) : null}
      {item.input?.imagesCount ? (
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
          ·{" "}
          {t("conversationDetail.label.images", { count: item.input.imagesCount })}
        </span>
      ) : null}
    </>
  );
  return (
    <Card marker="llmHop" title={title} at={item.at} badges={badges} truncated={truncated} t={t}>
      {item.input ? (
        <>
          {item.input.systemPrompt ? (
            <ContentBlock
              label={t("conversationDetail.timeline.systemPrompt")}
              content={item.input.systemPrompt}
            />
          ) : null}
          <ContentBlock
            label={t("conversationDetail.timeline.userPrompt")}
            content={item.input.prompt}
          />
          {item.input.historyMessages.length > 0 ? (
            <HistoryDetails
              messages={item.input.historyMessages}
              count={item.input.historyMessages.length}
              label={t("conversationDetail.label.historyShort", {
                count: item.input.historyMessages.length,
              })}
              t={t}
            />
          ) : null}
        </>
      ) : (
        <div
          style={{
            color: "var(--warn)",
            fontSize: 12,
            padding: "6px 0",
            borderBottom: "1px dashed var(--border)",
            marginBottom: 8,
          }}
          role="status"
        >
          {t("conversationDetail.timeline.noInput")}
        </div>
      )}

      {item.output && item.output.assistantTexts.some((s) => s.length > 0) ? (
        <>
          {item.output.assistantTexts.map((text, ti) => (
            <ContentBlock
              key={ti}
              label={
                item.output!.assistantTexts.length > 1
                  ? t("conversationDetail.label.assistantText", { n: ti + 1 })
                  : t("conversationDetail.timeline.assistantReply")
              }
              content={text}
            />
          ))}
        </>
      ) : (
        <div
          style={{
            color: "var(--warn)",
            fontSize: 12,
            marginTop: 8,
            padding: 10,
            borderRadius: 6,
            background: "var(--panel-2)",
            border: "1px dashed var(--border)",
          }}
          role="status"
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t("conversationDetail.timeline.noOutput")}
          </div>
          <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
            {t("conversationDetail.timeline.noOutputHint")}
          </div>
        </div>
      )}
    </Card>
  );
}

function OutboundCardView({ item, t }: { item: Extract<TimelineItem, { kind: "outbound" }>; t: TranslateFn }) {
  const { data } = item;
  const badges = (
    <span className={data.success ? "tag ok" : "tag error"}>
      {data.success
        ? t("conversationDetail.timeline.outboundOk")
        : t("conversationDetail.timeline.outboundFail")}
    </span>
  );
  if (!data.messages || data.messages.length === 0) {
    return (
      <Card
        marker="outbound"
        title={t("conversationDetail.timeline.outbound")}
        at={item.at}
        badges={badges}
        truncated={data.truncated}
        t={t}
      >
        <div className="empty" style={{ padding: 8, fontSize: 12 }}>
          {t("conversationDetail.timeline.outboundEmpty")}
        </div>
      </Card>
    );
  }
  return (
    <Card
      marker="outbound"
      title={t("conversationDetail.timeline.outbound")}
      at={item.at}
      badges={badges}
      truncated={data.truncated}
      t={t}
    >
      {data.messages.map((msg, idx) => {
        const m = msg as { role?: string; content?: string; to?: string };
        const isAssistantText = m.role === "assistant" && typeof m.content === "string";
        if (isAssistantText) {
          return (
            <ContentBlock
              key={idx}
              label={m.to ? `to ${m.to}` : undefined}
              content={m.content as string}
            />
          );
        }
        return (
          <pre
            key={idx}
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 11,
              fontFamily: "var(--mono)",
              color: "var(--text-dim)",
              marginBottom: 6,
            }}
          >
            {JSON.stringify(msg, null, 2)}
          </pre>
        );
      })}
    </Card>
  );
}

function ErrorCardView({ item, t }: { item: Extract<TimelineItem, { kind: "error" }>; t: TranslateFn }) {
  return (
    <Card
      marker="error"
      title={t("conversationDetail.timeline.error")}
      at={item.at}
      t={t}
    >
      <pre
        style={{
          whiteSpace: "pre-wrap",
          fontSize: 12,
          color: "var(--error)",
          margin: 0,
        }}
        role="alert"
      >
        {item.message}
      </pre>
    </Card>
  );
}

function Timeline({ record, t }: { record: ConversationRecord; t: TranslateFn }) {
  const items = buildTimeline(record);
  if (items.length === 0) {
    return (
      <div className="panel">
        <div className="empty" style={{ padding: 24, textAlign: "center" }}>
          {t("conversationDetail.timeline.empty")}
        </div>
      </div>
    );
  }
  return (
    <div>
      {items.map((item, idx) => {
        if (item.kind === "inbound") return <InboundCardView key={idx} item={item} t={t} />;
        if (item.kind === "llmHop") return <LlmHopCardView key={idx} item={item} t={t} />;
        if (item.kind === "outbound") return <OutboundCardView key={idx} item={item} t={t} />;
        return <ErrorCardView key={idx} item={item} t={t} />;
      })}
    </div>
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
                  <td>
                    <span
                      className={
                        data.conversation.status === "completed"
                          ? "tag ok"
                          : data.conversation.status === "error"
                            ? "tag error"
                            : "tag"
                      }
                    >
                      {data.conversation.status}
                    </span>
                  </td>
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

          <Timeline record={data.conversation} t={t} />
        </>
      ) : null}
    </div>
  );
}
