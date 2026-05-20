# rules/cost.md —— Token + Cost 链路

`costs/` 层职责：daily-cost JSONL 持久化、pricing ref、按 model/channel/source 累计。

链路：`llm_output` hook → hook-metrics 算 cost → inject 合成事件 `llm.tokens.recorded` → fanout 分两路：(a) buffer/aggregator/SSE 走常规；(b) `dailyCostStoreRef` 额外接收做日级累计。

## 关键工程决策

### 24. **Token 数据走 `llm_output` hook，cost 在采集端预算**（v0.8.0）

`model_call_ended` event 不带 token 数（host 在 stream observer 结束时 emit，那时 assistant message 还没 parse 完）。Token + cost 来自 `api.on("llm_output", ...)`，`event.usage = {input, output, cacheRead, cacheWrite, total}`（host 类型 `PluginHookLlmOutputEvent`）。**依赖** `hooks.allowConversationAccess` 安全门（同 audit）—— 用户没开就拿不到 token，Costs 页 cost 全 0。hook-metrics 用 `pricing` ref 算好 cost 后 inject 合成事件 `llm.tokens.recorded`（见 [`host-contract.md`](./host-contract.md) 决策 #25），aggregator 按 model/channel/source 累计 token + cost。**不要**把 cost 算放到 aggregator 或 REST handler —— 那样 daily-cost JSONL 写盘还得知道 pricing。

### 26. **DimensionRow 上的 cost / cacheRead/Write 字段是可选**（v0.8.0）

v0.8 前只有 total/errors/p50/p95/tokensIn/tokensOut；新加的 cost / cacheReadTokens / cacheWriteTokens 是 optional，0 时不出现在 JSON（aggregator.ts: dimensionRows 用 conditional spread）。**不要**默认 0 写出 —— 会让 Channels / Models 页在没成本数据时多出空 `0` 列。

### 27. **Daily-cost 存储是文件-per-day 全量 JSON**（v0.8.0）

`<stateDir>/openclaw-monitor/daily-costs/daily-costs-YYYY-MM-DD.json`，每天一文件，内是当日完整累计 + byModel 分桶。写入 = 内存累加 + 1s 防抖 flush + 整文件 `writeFileSync` 覆盖。**不是 append-only** —— 成本是单调加法，每次 flush 是完整快照。`createDailyCostStore.close()` 必须在 service.stop 调，否则最近 1s 累加丢盘。retention 用 `pruneOlderThan` 按文件名日期 unlink，默认 90 天（比 events.jsonl 默认 7 天长，月度成本看完整月）。**绝对不要**改成 jsonl append-only —— 当日多次 flush 会写多行，rangeSum 重复累计。

### 28. **windows snapshot 的 totalTokens 含义**（v0.8.0）

`WindowSnapshot.totalTokens` 是 input + output + cacheRead + cacheWrite **四类合计**。`/api/monitor/costs` 把它放进 `windows[w].tokensIn`（字段名复用，没增字段），UI 直接读 `tokensIn` 当总 token 显示。分类看 byModel 表（每行单独列）。改 windows 计算时**不要**只加 input 一类，会让今日 stat card 数字偏小。

### 29. **Token 数据卡点是 host `supportsUsageInStreaming` 默认 false，不是 provider 物理限制**（v0.8.0 误判→实测修正）

曾以为是上游不返回 usage，curl 直连证伪：加 `stream_options.include_usage: true` 后最后一帧带完整 usage。真正卡点在 host `src/plugins/provider-model-compat.ts:127` —— host 对**未知 baseUrl** 的 OpenAI-compat provider 自动把 `model.compat.supportsUsageInStreaming` 写死 `false`，host 自己的 stream parser **静默丢弃**上游 usage 帧。修复：在用户 `openclaw.json` 给该 model 加 `compat: { supportsUsageInStreaming: true }` 覆盖默认。已写进 README 双语 "Known config notes / 自建 LLM 上游"。任何用自建 OpenAI-compat 网关（vLLM / SGLang / TGI / 自建 proxy）的用户都会踩。**不要**改回"上游不返回 usage"的旧解释。**不要**改成 prompt char count / 4 估算。Costs UI 仍保留 byModel.tokens=0 提示 banner 兜底真没价格表的 provider，文字应同时说明"先检查 compat.supportsUsageInStreaming"。

### 38. **`daily-store.readDay` 不能用 `cost` truthy 过滤 cached snapshot**（v0.9.3）

`cached?.cost ? cached : undefined` 会把 cost===0 但 tokens>0 的合法 day 丢成 undefined。触发场景：

(a) 1s 未 flush 窗口内的初始事件；
(b) 兜底 0 价格的 provider（决策 #29）。

正确：`return cache.get(day);`，文件不存在时只判 cached 是否存在，不再判 cost 字段。回归 `service.test.ts > "daily-cost readDay returns cached day when cost is 0 but tokens exist"`。
