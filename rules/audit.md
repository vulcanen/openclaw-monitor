# rules/audit.md —— 内容审计（M5 / conversation probe）

`audit/` 层职责：注册 4 个 hook 抓内容（详见 [`host-contract.md`](./host-contract.md) 触点表），按 runId 聚合，写 audit JSONL。**不订阅诊断事件总线**（与 `probes/` 解耦）。

默认 **opt-out**，需用户跑 `openclaw monitor setup --audit` 才启用（见 [`host-contract.md`](./host-contract.md) 决策 #8 / #10）。

## 关键工程决策

### 16. **审计内容默认大放行 `contentMaxBytes`**（v0.6.0）

默认 1 MiB（schema cap 16 MiB，`src/types.ts: DEFAULT_MONITOR_CONFIG.audit`，schema 在 `openclaw.plugin.json`）。原 16 KiB 会把普通 prompt 切成 `…[truncated]`，让 ConversationDetail 看不到完整内容。觉得磁盘膨胀严重时**不要**降回 16K —— 优先调 `retainDays`（默认 3 天）或引入逐字段 hash，不要用截断当压缩。`MAX_HISTORY_ITEMS = 64` 是 history 数组长度限制，与单段字节数无关。

### 17. **对话审计支持 `?groupBy=sessionKey`**（v0.6.0）

`/api/monitor/conversations` 默认返回 flat `conversations[]`（向后兼容），加 `?groupBy=sessionKey` 时返回 `sessions[].conversations[]` 嵌套（`audit/conversation-routes.ts: groupBySession`）。每个 SessionGroup 聚合 runCount / totalTokensIn/Out / hasError / lastSeenAt。UI 默认走 groupBy（`Conversations.tsx: api.conversationsBySession`），无 sessionKey 的旧记录入 `_ungrouped` 桶。list handler **保留两种 shape**，不要默认只返回 grouped —— 历史 API 客户可能读 flat。

### 18. **对话 summarize 两份孪生函数曾漂移**（v0.6.3，历史教训）

`conversation-routes.ts: summarizeRuntime` 和 `conversation-store.ts: summarize` 曾分别维护。v0.6.0 加 sessionKey 时漏改一边，所有持久化 conversation 进 `_ungrouped` 桶。现已统一到 `summarize.ts`（决策 #30）。给 ConversationSummary 加新字段时只改 summarize.ts 一处。

### 30. **唯一的 conversation summary 路径**（v0.9.2）

`ConversationRecord → ConversationSummary` 投影由 `src/audit/summarize.ts: summarizeConversation` **独占**。v0.6 的两份近重复实现（routes vs store）漂移历史见决策 #18。**任何**给 ConversationSummary 加新字段（trigger、tokensTotal、cost、tags…）的改动只改 summarize.ts 一处，`conversation-routes.ts` 和 `conversation-store.ts` 从这里 import。不要再 inline 自己写一份"为这个场景定制的 summarize"。

### 34. **Conversation store 维护 runId → file in-memory 索引**（v0.9.2）

`get(runId)` 之前是 O(全部 jsonl 行) 线性扫描，retention 调长（30 天）时单次 ~百毫秒。v0.9.2 引入 lazy `runIdToFile` Map + `fileMtimeAtIndex` Map：首次 `get` 全量扫，之后 `appendCompleted` 增量更新。`pruneOlderThan` 反向清掉指向被删文件的 entry。**不要**换成 byte-offset 索引 —— audit record 大小可变（MB 级），offset 脆且帮助有限。

### 34. **`agent_end.messages` 是完整对话快照，不是 outbound 回复**（v0.9.3，与上条同号但主题不同）

host `PluginHookAgentEndEvent.messages` 包含 system / user / assistant 全部消息（流程结束时的完整 conversation state）。写进 `record.outbound.messages` 会让 ConversationDetail 第 ④ 段（"OpenClaw → 消息发送方"）显示**整段 LLM 输出 + system prompt + user 提问**，重复第 ③ 段并污染。`message_sending` hook 才是真正的"发回给消息发送方"信号（单条 assistant 回复 + to/replyToId）。`audit/conversation-probe.ts` agent_end finalize **必须**：(a) 已有 outbound → 只更新 success/status/error/durationMs，**不覆盖 messages**；(b) 无 outbound（纯 direct-API 流程，没 channel hook）→ 才回退到 messages 数组。回归 `service.test.ts > "agent_end preserves outbound captured by message_sending"`。

### 41. **`findOrCreateRecord` 命中合成 runId 时必须 promote 到真 runId**（v0.9.4 修复 — 0.9.3 引入的回归）

channel-based flow（Control UI / Telegram）事件顺序是 `message_received` → `before_prompt_build` → `llm_input` → `llm_output` → `message_sending` → `agent_end`。`message_received` 时没 runId，probe 铸造合成 `ctrl_<sessionKey>_<ts>` 作为 placeholder。当 `before_prompt_build` 带真 runId 进来通过 sessionKey 命中已存在记录时，**必须**把 `state.active` key 从合成 runId 换成真 runId（同步更新 `record.runId` 与 `bySessionKey`），否则后续走 runId-only lookup 的 handler（典型 `llm_output state.active.get(runId)`）会 miss、静默丢弃 assistant 文本 —— 表现就是 ConversationDetail 第 ③ 段渲染**空白**而第 ② 正常。修复在 `audit/conversation-probe.ts: findOrCreateRecord` sessionKey-lookup 分支：`if (runId && runId !== linked.runId && linked.runId.startsWith("ctrl_"))` 时执行 re-key。`llm_output` handler 同步加 sessionKey fallback 作为防御深度。**测试盲点教训**：0.9.3 的 "agent_end preserves outbound" 测试只断言 `outbound.messages` 内容，没断言 `llmOutputs.length / record.runId`，任何对 conversation 流程的新测试都要把"每段都有内容 + record.runId 是真的不是 ctrl_*"作为基线断言。

### 46. **`truncateString` 按 UTF-8 字符边界切，不要按 char index**（v0.9.6 修 pre-existing）

原实现 `Buffer.byteLength` 判超限但 `value.slice(0, max - ELLIPSIS.length)` 按 UTF-16 code unit 切。中文 / emoji 1 char = 3-4 字节，超限 1 MiB 的 prompt 实际切出来可能仍 3 MiB；更糟有概率切在 surrogate pair 中间。**正确做法**：`Buffer.from(value).subarray(0, budget)` 后**手动回溯**到 UTF-8 字符边界（continuation byte 高位 `10xxxxxx` 即 `>=0x80 && <0xC0`，回退一字节直到首字节）。`Buffer.subarray.toString("utf8")` 不会自动丢弃尾部不完整字节而是替换 U+FFFD（`�`） —— 第一次修复掉进过这个坑。回归 `"truncates multi-byte UTF-8 content within the byte budget"`：3×budget 的 CJK 字符串切后必须 `byteLength <= budget + ELLIPSIS_BYTES` 且**不含 U+FFFD**。

### 49. **conversation-probe 必须运行 abandoned-record sweeper**（v0.9.6 修 pre-existing memory leak）

channel-only flow 下 host 崩溃 mid-run / sender 永不发 message_sending / 网络抖动让 agent_end 永不触发，对应 record 永留 `state.active`。决策 #16 后单条 record 可达 MB。修复 `audit/conversation-probe.ts`：

(a) 每个 mutating handler 末尾调 `touch(runId)` 刷 `state.lastTouchedAt`；
(b) `ABANDON_TTL_MS = 30 * 60_000` + `ABANDON_SWEEP_INTERVAL_MS = 5 * 60_000` 的 setInterval 扫 `state.active`，超时 record 走 `finalize` 并标 `status = "abandoned"`、`errorMessage = "abandoned: no host update for N min"`；
(c) `ConversationRecord.status` union 加 `"abandoned"` 选项（决策 #41 测试基线不受影响）。

`service.start` 调 `probe.startSweeper()`，`service.stop` 调 `stopSweeper()`。**不要**把 TTL 调短到 30 分钟以下 —— 长 prompt + 多 turn agent run 几十分钟正常，误杀活 run 损失更大。回归 `"sweeper finalizes abandoned active conversations"`。
