import type { ConversationRecord, ConversationSummary } from "./types.js";

/**
 * Canonical `ConversationRecord → ConversationSummary` projection.
 *
 * Why this file exists: before v0.9.2 there were two near-identical
 * `summarize` copies — one in conversation-routes.ts (for in-memory
 * probe records) and one in conversation-store.ts (for jsonl read-back).
 * They drifted in v0.6.0 when `sessionKey` was added to the summary
 * shape: the routes copy got the new field, the store copy didn't,
 * and the Conversations page silently bucketed every persisted run
 * under the "_ungrouped" group for two minor versions until v0.6.3
 * caught it. Decision #18 in CLAUDE.md mandates one canonical
 * function; this file is it.
 *
 * Any new ConversationSummary field added in future MUST be forwarded
 * here. Callers MUST NOT inline their own projection.
 */
export function summarizeConversation(record: ConversationRecord): ConversationSummary {
  let totalIn = 0;
  let totalOut = 0;
  for (const out of record.llmOutputs) {
    totalIn += out.usage?.input ?? 0;
    totalOut += out.usage?.output ?? 0;
  }
  const lastOutput = record.llmOutputs[record.llmOutputs.length - 1];
  const responseText = lastOutput?.assistantTexts.join(" ").slice(0, 160);
  return {
    runId: record.runId,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    ...(record.sessionKey !== undefined ? { sessionKey: record.sessionKey } : {}),
    ...(record.channelId !== undefined ? { channelId: record.channelId } : {}),
    ...(record.trigger !== undefined ? { trigger: record.trigger } : {}),
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    llmHops: record.llmInputs.length,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
    ...(record.inbound?.prompt ? { promptPreview: record.inbound.prompt.slice(0, 160) } : {}),
    ...(responseText ? { responsePreview: responseText } : {}),
    hasError: record.status === "error" || Boolean(record.errorMessage),
  };
}
