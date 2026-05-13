import type { ModelPrice, PricingConfig, TokenRecordedEvent } from "./types.js";

/**
 * Per-token-class cost figures + their sum, given a usage block and a
 * pricing entry. Returns zero per class when the rate or token count is
 * unset. cacheRead/cacheWrite default to the input rate when the operator
 * hasn't set them explicitly (common case: Anthropic-style providers do
 * differentiate, OpenAI-compat models usually don't).
 */
export function computeCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  price: ModelPrice | undefined,
): {
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  cost: number;
} {
  if (!price) {
    return { costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, cost: 0 };
  }
  const costInput = (usage.inputTokens / 1000) * price.input;
  const costOutput = (usage.outputTokens / 1000) * price.output;
  const cacheReadRate = price.cacheRead ?? price.input;
  const cacheWriteRate = price.cacheWrite ?? price.input;
  const costCacheRead = ((usage.cacheReadTokens ?? 0) / 1000) * cacheReadRate;
  const costCacheWrite = ((usage.cacheWriteTokens ?? 0) / 1000) * cacheWriteRate;
  const cost = costInput + costOutput + costCacheRead + costCacheWrite;
  return { costInput, costOutput, costCacheRead, costCacheWrite, cost };
}

/**
 * Look up the price for a given provider/model pair. The pricing table is
 * keyed by canonical `provider/model` strings (matching what the Models
 * page shows). Returns undefined when the model isn't listed — callers
 * should treat that as zero-cost, NOT as an error: the operator may
 * intentionally not price a model yet, and we still want to count tokens.
 */
export function lookupPrice(
  pricing: PricingConfig,
  provider: string | undefined,
  model: string | undefined,
): ModelPrice | undefined {
  if (!provider || !model) return undefined;
  const key = `${provider}/${model}`;
  return pricing.models[key];
}

/**
 * Build the TokenRecordedEvent payload that hook-metrics injects into the
 * fanout for one llm_output hop. Pulled out into its own function so the
 * unit tests can exercise the price-lookup → cost-compute → payload chain
 * without spinning up the whole hook system.
 */
export function buildTokenEvent(params: {
  pricing: PricingConfig;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  channel?: string;
  trigger?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  seq?: number;
}): TokenRecordedEvent {
  const price = lookupPrice(params.pricing, params.provider, params.model);
  const cost = computeCost(params.usage, price);
  return {
    type: "llm.tokens.recorded",
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.channel !== undefined ? { channel: params.channel } : {}),
    ...(params.trigger !== undefined ? { trigger: params.trigger } : {}),
    inputTokens: params.usage.inputTokens,
    outputTokens: params.usage.outputTokens,
    ...(params.usage.cacheReadTokens !== undefined
      ? { cacheReadTokens: params.usage.cacheReadTokens }
      : {}),
    ...(params.usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: params.usage.cacheWriteTokens }
      : {}),
    costInput: cost.costInput,
    costOutput: cost.costOutput,
    costCacheRead: cost.costCacheRead,
    costCacheWrite: cost.costCacheWrite,
    cost: cost.cost,
    currency: params.pricing.currency,
    ts: Date.now(),
    ...(params.seq !== undefined ? { seq: params.seq } : {}),
  };
}
