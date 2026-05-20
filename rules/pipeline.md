# rules/pipeline.md —— Aggregator / Storage / Logs

`pipeline/` 层职责：纯函数式聚合 + 维度抽取 + 运行状态机。**不做 IO，不持定时器**。
`storage/` 层职责：文件读写 + 内存环形缓冲 + 定期清理。**不解析业务语义**。
`outlets/rest-routes.ts` 的 logs handler 也在这里讲，因为它是事件流的下游消费方。

## 误导性事件（别再上当）

`diagnostic.liveness.warning` 是**进程级**事件循环 / CPU 压力信号（host `src/logging/diagnostic.ts:380`，CPU 忙 / GC 压力 / event-loop p99 超阈值都会触发），**不是会话级**告警。真正的 per-session 信号只有 `session.stalled` 和 `session.stuck`（host `src/logging/diagnostic.ts:810-822`）。v0.6.1 已把 liveness.warning 从 `sessionsAlerted` 剔掉，不要回退。

## 关键工程决策

### 14. **Logs 页是诊断事件流，不是 host 日志**（v0.6.0）

`log.record` 被 host 在 `onDiagnosticEvent` 前过滤（[`host-contract.md`](./host-contract.md) 决策 #5），外部插件**永远拿不到** host 日志。`src/outlets/rest-routes.ts: createLogsHandler` 不查 `log.record`，而是消费 buffer 全部事件，按 type 推断 level（`.error/.stuck/.stalled → error`，`.blocked/.liveness.warning → warn`，`heartbeat/memory.sample → debug`，其余 `info`），用 `inferLogLevel` + `formatLogMessage` 拼一行。改 logs handler 时**不要**写成 `buffer.recent({ type: "log.record" })` —— 死路。`component` 过滤改 substring 匹配（精确 equality 误伤自动派生 component 名）。

### 15. **`sessionsAlerted` 只算 `session.stalled` / `session.stuck`**（v0.6.1）

`isSessionAlertEvent`（`pipeline/extractors.ts`）和 windows（`pipeline/aggregator.ts: computeWindow`）只统计 host per-session attention 输出（host `src/logging/diagnostic.ts:810-822`）。**不要**把 `diagnostic.liveness.warning` 加回去 —— host 在正常 GC / CPU spike 会 emit，让总览 stat card 假阳性发红。liveness.warning 原始事件仍在 buffer，事件页 / 日志页可见。Overview stat card 也**不要**加 "stalled / stuck" 副标题文案（数值为 0 时也显示，让人误判）。

### 32. **Aggregator startup replay 必须分批 + 限量**（v0.9.2）

`src/service.ts` 启动 replay 从今日 events.jsonl 倒灌 aggregator + buffer。两个硬约束：

- `REPLAY_TAIL_LIMIT = 100_000` 只取最近 N 条（windows 是滚动窗口，远古事件没意义）
- `REPLAY_CHUNK = 1_000` 每千条 `await setImmediate` 让事件循环喘气

**不要**改成同步 for 循环吃完 —— 几百万行 jsonl 会卡 service.start 几十秒，期间 gateway 健康检查不响应。replay 是 fire-and-forget 异步（`void replay()`），live 事件直接走 fanout，跟 replay 交错正确（同一 aggregator 实例）。

### 33. **Window P95 latency 计算依赖 recent ring 上的 `durationMs`**（v0.9.2 修 pre-existing）

v0.8 前 `modelP95Ms` 永远 `null`，`EventTimePoint` 没记 duration。修复在 `aggregator.ts ingest`：终态 model.call / tool.execution 事件时把 `dims.durationMs` stamp 到 recent ring 的 `point.durationMs`。computeWindow 读它 push 进 `modelDurations`。**不要**改回不存 durationMs —— Overview 页 "5m model P95" 卡片会永远显示 "—"。

### 44. **`ring-buffer.append` 必须支持显式 capturedAt**（v0.9.6 修 pre-existing）

`service.start` replay（决策 #32）从 JSONL 把今日历史事件喂回 buffer + aggregator。aggregator 路径用 `captured.capturedAt` 正确；buffer 路径之前调 `buffer.append(captured.event)`，内部 `Date.now()` 覆盖时间戳 —— **重启后头几小时**所有 Logs / Overview `recentErrors` / Insights cutoff 都以为历史错误是"刚刚"。修复 `storage/ring-buffer.ts: append(event, capturedAtMs?)`，service.ts replay 与 fanout dispatch 都传 capturedAt。回归 `"preserves an explicit capturedAt on replay-style appends"`。

### 45. **`computeWindow` 不能假设 `recent[]` 单调升序**（v0.9.6 修 pre-existing）

原实现倒序循环，遇 `ts < cutoffMs` 立即 `break`。决策 #32 说明 replay 是 fire-and-forget 且 fanout.start 紧随其后；live 事件在 replay 仍在跑时已开始 push 到 `recent`，**新 ts 排在旧 ts 后**，break 过早导致窗口短时间归零。修复改为 `continue` 整段扫满。代价：1h 窗口从早断转全扫 ≤ 10k 元素，O(10k) 单次约 0.5 ms 可接受。**不要**回退到 break —— 会再次在重启后让 Overview 卡片几秒钟显示 0。

## Storage 写盘的硬约束

- **不要用 `createWriteStream` + `stream.end()`** 做事件追加 —— close 是异步，测试 close→reread 会拿到空文件。改用 `appendFileSync`，吞吐对监控场景足够。
- **不要在 audit / cost 模块里直接写盘**，用 `setStore(store)` 注入。store 由 `service.start(ctx)` 拿到 `stateDir` 后才创建。
- 改 storage 层至少加一条 roundtrip 测试（写一条 → close → 重开 → 读回一致）。
