import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { Aggregator } from "../pipeline/aggregator.js";
import type { DailyCostStoreRef } from "./store-ref.js";
import { dailyCostHelpers } from "./daily-store.js";
import type {
  CostDimensionRow,
  CostRangeSummary,
  CostSnapshot,
  PricingConfig,
} from "./types.js";

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

const emptyRange = (): CostRangeSummary => ({
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
});

/**
 * GET /api/monitor/costs
 *
 * Returns the unified cost snapshot used by the Costs page:
 *   sinceStart  — process-start cumulative (in memory, lost on restart)
 *   windows     — 1m/5m/15m/1h rolling-window cost (in memory)
 *   today       — calendar today (UTC), from daily-cost JSONL
 *   thisWeek    — Monday→today (UTC), from daily-cost JSONL
 *   thisMonth   — 1st→today (UTC), from daily-cost JSONL
 *   daily       — last 30 days, day buckets, for the trend chart
 *   byModel     — process-start per provider/model breakdown
 *   byChannel   — process-start per channel breakdown
 *   bySource    — process-start per source breakdown
 *
 * No `?from=&to=` query yet — the operator-visible ranges (today/week/month)
 * cover the obvious billing periods and the trend chart shows the last 30
 * days. Custom-range slicing is a later UI feature.
 */
export function createCostsHandler(params: {
  aggregator: Aggregator;
  pricing: () => PricingConfig;
  dailyStoreRef: DailyCostStoreRef;
}): OpenClawPluginHttpRouteHandler {
  return async (_req: IncomingMessage, res: ServerResponse) => {
    const pricing = params.pricing();
    const dailyStore = params.dailyStoreRef.get();
    const nowDate = new Date();
    const today = dailyCostHelpers.dayStampUTC(nowDate.getTime());
    const weekStart = dailyCostHelpers.weekStartUTC(nowDate);
    const monthStart = dailyCostHelpers.monthStartUTC(nowDate);

    // Convert the aggregator's DimensionRow snapshot to CostDimensionRow.
    // Models / channels / sources accumulators carry the same fields after
    // v0.8.0 so this is a 1:1 map plus a token-bearing call count.
    const aggregatorModels = params.aggregator.models();
    const aggregatorChannels = params.aggregator.channels();
    const aggregatorSources = params.aggregator.sources();

    const byModel: CostDimensionRow[] = aggregatorModels.map((r) => ({
      key: r.key,
      calls: r.total,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      cacheReadTokens: 0, // not exposed by DimensionRow yet
      cacheWriteTokens: 0,
      cost: (r as { cost?: number }).cost ?? 0,
    }));
    const byChannel: CostDimensionRow[] = aggregatorChannels.map((r) => ({
      key: r.key,
      calls: r.total,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: (r as { cost?: number }).cost ?? 0,
    }));
    const bySource: CostDimensionRow[] = aggregatorSources.map((r) => ({
      key: r.key,
      calls: r.total,
      tokensIn: r.tokensIn ?? 0,
      tokensOut: r.tokensOut ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: (r as { cost?: number }).cost ?? 0,
    }));

    // sinceStart = sum across models (any of the three dimensions would do;
    // models is the most reliable because every priced event lands there).
    const sinceStart: CostRangeSummary = byModel.reduce(
      (acc, row) => ({
        tokensIn: acc.tokensIn + row.tokensIn,
        tokensOut: acc.tokensOut + row.tokensOut,
        cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
        cost: acc.cost + row.cost,
      }),
      emptyRange(),
    );

    const windowSnap = params.aggregator.windows();
    const windowsRanges: CostSnapshot["windows"] = {
      "1m": {
        ...emptyRange(),
        cost: windowSnap["1m"].totalCost,
        tokensIn: windowSnap["1m"].totalTokens,
      },
      "5m": {
        ...emptyRange(),
        cost: windowSnap["5m"].totalCost,
        tokensIn: windowSnap["5m"].totalTokens,
      },
      "15m": {
        ...emptyRange(),
        cost: windowSnap["15m"].totalCost,
        tokensIn: windowSnap["15m"].totalTokens,
      },
      "1h": {
        ...emptyRange(),
        cost: windowSnap["1h"].totalCost,
        tokensIn: windowSnap["1h"].totalTokens,
      },
    };
    // Note: windows snap.totalTokens is the *sum across all four token
    // classes* (input/output/cacheRead/cacheWrite); we just put the sum in
    // tokensIn to keep CostRangeSummary type-stable. The Costs page reads
    // totalCost out of these and shows tokensIn as the combined token
    // figure where useful.

    let todayRange: CostRangeSummary = emptyRange();
    let weekRange: CostRangeSummary = emptyRange();
    let monthRange: CostRangeSummary = emptyRange();
    let daily: CostSnapshot["daily"] = [];
    if (dailyStore) {
      todayRange = dailyStore.rangeSum(today, today);
      weekRange = dailyStore.rangeSum(weekStart, today);
      monthRange = dailyStore.rangeSum(monthStart, today);
      daily = dailyStore.recentDays(30).map((d) => ({
        day: d.day,
        tokensIn: d.tokensIn,
        tokensOut: d.tokensOut,
        cacheReadTokens: d.cacheReadTokens,
        cacheWriteTokens: d.cacheWriteTokens,
        cost: d.cost,
      }));
    }

    const snapshot: CostSnapshot = {
      generatedAt: nowDate.toISOString(),
      currency: pricing.currency,
      sinceStart,
      windows: windowsRanges,
      today: todayRange,
      thisWeek: weekRange,
      thisMonth: monthRange,
      daily,
      byModel: byModel.sort((a, b) => b.cost - a.cost),
      byChannel: byChannel.sort((a, b) => b.cost - a.cost),
      bySource: bySource.sort((a, b) => b.cost - a.cost),
    };

    writeJson(res, 200, snapshot);
    return true;
  };
}
