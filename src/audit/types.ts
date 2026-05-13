export type AuditConfig = {
  enabled: boolean;
  contentMaxBytes: number;
  retainDays: number;
  captureSystemPrompt: boolean;
};

export type LlmInputSegment = {
  capturedAt: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
  truncated: boolean;
};

export type LlmOutputSegment = {
  capturedAt: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  resolvedRef?: string;
  harnessId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  truncated: boolean;
};

export type ConversationRecord = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  channelId?: string;
  trigger?: string;
  /**
   * Lifecycle status of the conversation.
   * - `active`     — in flight; final hook (agent_end / message_sending) not yet seen.
   * - `completed`  — finalized normally.
   * - `error`      — finalized with a failure signal.
   * - `abandoned`  — sweeper finalized a stuck record after `ABANDON_TTL_MS`
   *                  of inactivity (host crashed mid-run, channel sender
   *                  never followed up, etc.). Distinguished from `error` so
   *                  operators don't confuse "we lost the run" with "the run
   *                  actually failed".
   */
  status: "active" | "completed" | "error" | "abandoned";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  inbound?: {
    capturedAt: string;
    prompt: string;
    history: unknown[];
    historyCount: number;
    truncated: boolean;
  };
  llmInputs: LlmInputSegment[];
  llmOutputs: LlmOutputSegment[];
  outbound?: {
    capturedAt: string;
    success: boolean;
    messages: unknown[];
    truncated: boolean;
  };
};

export type ConversationSummary = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  channelId?: string;
  trigger?: string;
  status: ConversationRecord["status"];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  llmHops: number;
  totalTokensIn: number;
  totalTokensOut: number;
  promptPreview?: string;
  responsePreview?: string;
  hasError: boolean;
};
