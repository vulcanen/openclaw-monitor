# rules/host-contract.md —— 与 OpenClaw host 的接口契约

外部插件能依赖的只有公开 SDK barrel。host 内部的事件流向、hook ctx、安全门都有具体表现。改 `probes/`、写新 hook、动 plugin entry 之前先读这里。

## SDK 公开 barrel —— 唯一允许的 import 路径

```typescript
// 允许：
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";

// 禁止：
// 1. openclaw/src/** 导入（破坏 boundary）
// 2. @openclaw/<其他扩展>/src/** 导入（破坏 owner boundary）
// 3. 假设 host 内部某事件 / 字段 / API 一定存在 —— 看 published types
```

## 四个关键 host API

```typescript
// 1. 订阅诊断事件（只有元数据，无内容）
api.registerService({
  start(ctx) {
    onDiagnosticEvent((evt) => { /* ... */ });
  },
});

// 2. 注册 HTTP 路由
api.registerHttpRoute({
  path: "/api/monitor/foo",
  auth: "gateway",
  match: "exact" | "prefix",
  gatewayRuntimeScopeSurface: "trusted-operator",
  handler: async (req, res) => { /* ... return true */ },
});

// 3. 注册 hook（M5 内容审计用，hook 携带原始内容）
api.on("llm_input", (event, ctx) => { /* event.prompt, event.systemPrompt, ... */ });
api.on("llm_output", (event, ctx) => { /* event.assistantTexts, event.usage */ });
api.on("before_prompt_build", (event, ctx) => { /* event.prompt, event.messages */ });
api.on("agent_end", (event, ctx) => { /* event.messages, event.success */ });

// 4. 服务上下文（service.start 拿到）
ctx.config         // OpenClaw config，插件配置在 config.plugins["openclaw-monitor"]
ctx.stateDir       // 推荐存储根目录
ctx.logger         // info / warn / error
```

## 4 个内容审计触点 → hook 映射

| 触点 | Hook | runId 来源 | 关键字段 |
|---|---|---|---|
| ① 项目 → OpenClaw | `before_prompt_build` | `ctx.runId` | `event.prompt`、`event.messages` |
| ② OpenClaw → LLM | `llm_input` | `event.runId` | `event.systemPrompt`、`event.prompt`、`event.historyMessages` |
| ③ LLM → OpenClaw | `llm_output` | `event.runId` | `event.assistantTexts`、`event.usage` |
| ④ OpenClaw → 项目 | `agent_end` | `event.runId ?? ctx.runId` | `event.messages`、`event.success`、`event.error` |

一次 OpenAI API 调用可能触发多次 ②③（agent 循环 + tool use + failover），`llmInputs[]` 和 `llmOutputs[]` 是数组。①④ 与外部 1:1。

## Hook 上下文字段并非统一

不同 hook 的 `ctx` 形状不一样（host 源码 `src/agents/pi-embedded-runner/run/attempt.model-diagnostic-events.ts: modelCallHookContext` vs `attempt.ts: agent_end`）：

| Hook | runId | sessionKey/Id | channelId | trigger | provider/model |
|---|---|---|---|---|---|
| `model_call_started/ended` | ✅ | ✅ | ❌ | ❌ | ✅ |
| `before_tool_call/after_tool_call` | ✅(event) | ❌ | ❌ | ❌ | ❌ |
| `agent_turn_prepare` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `agent_end` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `before_prompt_build` / `llm_input` / `llm_output` | ✅ | ✅ | ✅ | ✅ | varies |

补 channel/trigger：`model_call_*` / `*_tool_call` 必须用 `runId → {channelId, trigger}` 缓存回查（决策 #13），指望 model_call ctx 自带 channel 永远拿不到。

## 关键工程决策

### 5. **`onDiagnosticEvent` 单参 + trusted 事件被过滤**

listener 签名 `(evt) => void`，**无 metadata**。host **故意丢弃所有 trusted 事件 + 所有 log.record**（host 源码 `src/infra/diagnostic-events.ts:803-810`）。Pi runtime / agent harness 用 `emitTrustedDiagnosticEvent` 发出的 `model.call.*` / `harness.run.*` **架构上外部插件永远收不到**。**正确做法**：从 plugin hook (`api.on("model_call_started", ...)`) 拿，hook 不受过滤影响。实现见 `src/probes/hook-metrics.ts`。任何"为什么 onDiagnosticEvent 看不到 model.call"的疑问答案都是这条。

### 6. **不直接 import `@openclaw/plugin-sdk`**

那是 host 私有包（`private: true, version: 0.0.0-private`）。外部插件依赖 `openclaw` 主包，从 `openclaw/plugin-sdk/<sub>` 子路径导入。

### 8. **M5 默认 opt-out + 条件注册**

`audit.enabled: false` 是默认。改动 audit 时：

- 不要把默认改成 true
- `conversation-probe.installHooks` 中**仅当 `audit.enabled` 与 `hooks.allowConversationAccess` 同时为真才注册** `llm_input/llm_output/agent_end`（避免 host 输出 "blocked" info 日志）
- `before_prompt_build` 不在 host 的 `CONVERSATION_HOOK_NAMES` 里，可随时注册
- audit 关闭时即便 hook 触发也不写盘

详细审计行为见 [`audit.md`](./audit.md)。

### 10. **Host config 写入只有一个入口**

`src/cli/setup-command.ts` 的 `openclaw monitor setup [--audit]`，用户显式触发，写 `plugins.allow` + `hooks.allowConversationAccess` + `config.audit.enabled`。用 `runtime.config.mutateConfigFile` 配 `afterWrite: { mode: "restart", reason: ... }`。**register/start 期间不要自动写 host config** —— Claude Code harness 会独立判断为 high-severity security-gate change 并拒绝。v0.5.0 加 autoTrustHostGates 自动写盘的尝试被拦截多次，最终回退到"插件默认开 audit + 日志提示用户跑 setup"。

### 12. **`register(api)` 可能被调用多次 — 必须 idempotent**（v0.5.2）

OpenClaw plugin loader 在不同 load profile（provider runtime / web-fetch runtime / agent-tool-result middleware / cli-registry-loader 等）会用不同 `PluginLoadOptions` 触发独立 `loadOpenClawPlugins`，cache miss 时**完整重新跑** plugin entry。

- state（buffer / aggregator / runs-tracker / JSONL store / SSE bus / conversation probe / 去重表）**必须** module-level singleton（`src/index.ts: sharedBundle`）。否则 hook callback 写到第二次 bundle 的 fanout，而 HTTP/SSE handler 指向第一次 —— 表现："hook fire 但页面全 0"。
- `api.registerService` / `registerHttpRoute` / `registerCli` **只在第一次 register 调用**（`routesAndServiceWired` flag 锁住），重复注册要么报错要么 shadow，且只有第一个 api 真连到 gateway HTTP server。
- `bundle.registerHooks(api)` **每次 register 都调**，因为不同 load profile 用不同 hook 注册表；fanout 的 `callId`/`toolCallId` dedup 吸收重复 inject。
- 回归测试 `src/service.test.ts > "plugin entry idempotency"`。

### 13. **Channel / Source 维度必须靠 runId 缓存补全**（v0.6.0）

`model_call_*` 和 `*_tool_call` hook ctx 不带 `channelId` / `trigger`。`src/probes/hook-metrics.ts` 用 module-level `runId → {channelId, trigger}` Map（`makeRunContextRegistry`），在 `agent_turn_prepare` / `agent_end` 写入，inject `model.call.*` / `tool.execution.*` / `harness.run.*` 前用 `enrich(synth, runId)` 回填。**不要删掉这层缓存**，否则通道页和来源页归零（`/api/monitor/channels`、`/api/monitor/sources`）。TTL 60s 覆盖 model.call 在 agent_end 之后到达的边界。aggregator channels 维度也加 model.call 兜底累计（`aggregator.ts` 检查 `dims.channel && isModelCallEvent(...)`） —— 跟 message.delivery / message.processed 累计**并行不重复**，`if (!isMessageDeliveryEvent && !isMessageProcessedEvent)` gate 把关。

### 25. **`llm.tokens.recorded` 是 plugin-private 类型**（v0.8.0）

不在 host 的 `DiagnosticEventPayload` union 里。需要的地方用 `(event.type as string) === "llm.tokens.recorded"` 比较（TS 否则报 union 无重叠）。fanout 接收后**额外**喂给 `dailyCostStoreRef.get()?.recordTokenEvent` 做日级累计；常规事件走完 buffer / aggregator / SSE bus 后写一份进 daily-costs JSONL。**不要**让 hook-metrics 直接调 daily store —— fanout 是唯一统一分发点。详细 cost 链路见 [`cost.md`](./cost.md)。

### 33. **不要再次把 `event.sessionId` 当 `sessionKey` 用**（决策 #18 的孪生回归，已第二次修复）

`PluginHookLlmInputEvent`（host `hook-types.d.ts:48`）**只有** `sessionId: string`，**没有** `sessionKey`。任何 `const sessionKey = event.sessionId ?? ctx.sessionKey;` 都是 bug —— `event.sessionId` 永远非空，`??` 永远走不到 ctx，且 sessionId 是 host 内部不透明 id（如 `chatcmpl_xxx`），跟 sessionKey（channel 关联键，如 `telegram:userN`）语义完全不同。后果：`state.bySessionKey` 被 sessionId 污染，conversation grouping 把多跳 LLM 调用拆成多条 _ungrouped。**唯一正确**：`const sessionKey = ctx.sessionKey;`。同类规则适用于所有"event 里没声明 sessionKey"的 hook：`llm_output` (`hook-types.d.ts:79`) / `agent_end` (line 107) 都只有 sessionId，sessionKey 只能从 ctx 取。回归 `service.test.ts > "llm_input does not pollute sessionKey with sessionId"`。

### 39. **`hook-metrics` runCtx 注册表必须有外层 max-TTL**（v0.9.3）

`makeRunContextRegistry` 之前只在 `agent_end` 调 `scheduleEvict`（60s TTL）。任何走到 `agent_turn_prepare` 但**没走完** `agent_end` 的 run（host abort / crash mid-run / harness 绕过 finalize）会让 `ctxByRun` 永久驻留，~100 字节/条，慢但无上界内存泄漏。修复：`set()` 内部用 `RUN_CTX_MAX_TTL_MS = 30 * 60_000` 兜底；正常 agent_end 路径再覆盖到 60s 短 TTL。30 分钟覆盖所有"有意义"的 run 时长，不会误删多 turn 活 run（每 turn `set()` 刷新 timer）。

### 43. **`installHookMetrics` 必须用 WeakSet 防同一 api 被注册两次**（v0.9.6 修复 pre-existing 致命 bug）

决策 #12 让 `bundle.registerHooks(api)` 每次 register 都跑；不同 load profile 给的是不同 api object，正确链路是"每个 api 注册一次"。但同一 api 因 cache 刷新 / hot reload 被传两次时，`api.on("llm_output", h)` 会叠两个 listener，host `getHooksForName`（`src/plugins/registry.ts`）不按 plugin 去重，**单条 llm_output 触发会合成 N 条 `llm.tokens.recorded`** —— 决策 #25 标记该事件 plugin-private 且 fanout 只用 callId/toolCallId 做 dedup，token 事件**两个 id 都没**，aggregator + daily-cost JSONL 直接 N 倍累计。修复 `hook-metrics.ts: installedApis = new WeakSet<OpenClawPluginApi>()`，首行 `if (installedApis.has(api)) return; installedApis.add(api);`。配套在 `event-subscriber.ts: dispatch` 给 `llm.tokens.recorded` 加 `tok:${runId}:${seq}` dedupeId（`buildTokenEvent` 已生成单调 seq）作为 belt-and-suspenders。回归 `"installHookMetrics is idempotent on the same api object"` 与 `"llm.tokens.recorded with same (runId, seq) is deduped at the fanout"`。**不要**把 dedup 范围扩到 `harness.run.*` —— 那些事件没 seq 且 agent_turn_prepare 每 turn fire 一次（多 turn 合法重入）。

### 51. **新订阅一组 host hook 用 `*.lifecycle.*` 命名空间合成新事件**（v0.9.6）

决策 #5 / #12 锁定"hook 是真源"路线，但 v0.9.5 只订阅 11/34 个 hook。v0.9.6 在 `src/probes/hook-metrics.ts` 增订：

- `session_start` / `session_end` → 合成 `session.lifecycle.{started,ended}`（含 `messageCount`、`durationMs`、`reason`），替代用 sessionKey 推断 session 边界的 leaky 方案。
- `before_compaction` / `after_compaction` → 合成 `agent.compaction.{started,completed}`（含 `messageCount`、`compactedCount`、`tokenCount`），context-window 利用率信号。
- `tool_result_persist` → 合成 `tool.result.persisted`（含 `toolName`、`isSynthetic`、`messageBytes`），tool output 体积可见性。
- `gateway_start` / `gateway_stop` → 合成 `gateway.lifecycle.{started,stopped}`（含 `port`、`reason`），uptime / 重启历史。

所有新事件类型是 plugin-private 字符串（host `DiagnosticEventPayload` union 不知道）—— 与决策 #25 同样的 cast 处理。`createLogsHandler.inferLogLevel` 给 `gateway.lifecycle.stopped` 映射成 warn，其余 info。**不要**给这些新事件加 aggregator dimension —— 它们目前是 Events / Logs 页 + Logs typePrefix 过滤的纯透传信号。新增 hook 全套**不影响**任何既有 hook 流程。

### 58. **CLI 命令注册必须走 `cli-metadata.js`，不能只挂在主入口**（host 2026.5.18 引入）

host 2026.5.18 重写了 plugin CLI 路径，引入了**两阶段加载**：

1. **metadata 探测阶段**（`loadOpenClawPluginCliRegistry`）：host 调 `resolveCliMetadataEntrySource(rootDir)` 找 `<pluginRoot>/cli-metadata.{ts,js,mjs,cjs}`；找到就**只加载这个文件**，找不到才 fallback 到主入口（`candidate.source`）。这一阶段构造的 `api` **只把 `registerCli` 接成真 handler，其他全是 noop**（`api-builder-CnCCk5go.js:80`、`loader-CxUWY2_6.js:6020`）。
2. **full 阶段**（`loadOpenClawPlugins`，mode=`discovery`/`full`）：host 加载主入口（`candidate.source`），所有 `registerXxx` 都是真 handler。

**为什么这个改动会破坏 v0.9.7 之前的版本**：决策 #12 让主入口的 `register` 多次可调用，用 module-level `routesAndServiceWired` flag 锁住"只在第一次 register 调 `registerSetupCli` / `registerService` / `registerHttpRoute`"。host 5.18 在 fallback 路径中把**主入口当 metadata 入口加载**会触发这个 flag —— 后续 full 阶段再加载同一模块（ESM cache 命中）时 `routesAndServiceWired === true`，**跳过 CLI / 服务 / HTTP 路由注册**。表现：`openclaw monitor` 报 `unknown command`，gateway HTTP 路由表 23 条全没注册，但 hook count 看起来正常（因为 hook 在 wired 块外）。修复路径：v0.9.8 在 plugin 根加 `cli-metadata.js` shim → 编译输出 `dist/cli-metadata.js`（源码 `src/cli-metadata.ts`）。Shim 只调 `api.registerCli` + 延迟 dynamic import 真正的 builder（`buildMonitorCommands`，从 `setup-command.ts` 拆出来给两条路径共用）。

**硬约束**：

- `<pluginRoot>/cli-metadata.js` 必须存在于 npm tarball 顶层（即 `package.json` 同级），所以 `package.json` 的 `files` 必须包含 `"cli-metadata.js"`（**不**是 `"dist/cli-metadata.js"`）。
- shim 文件本身用静态 ESM `export { default } from "./dist/cli-metadata.js";` —— host 加载它会走 jiti，alias map 跨文件继续生效，dist 里的 `import "openclaw/plugin-sdk/plugin-entry"` 正常解析。
- shim 内**不要** import / 触碰主入口（`dist/index.js`）的任何 module-level state。`MONITOR_CLI_OPTIONS` 这种纯常量从 `setup-command.ts` 共用是安全的，因为 `setup-command.ts` 没有 module-level state；但绝不能从 `src/index.ts` import。
- 主入口的 `register` **保留** `registerSetupCli(api)` 调用，因为 full 阶段需要它（metadata 阶段的 registrar 函数只 stored 到 metadata-only registry，不会传给 commander）。两阶段各自的 cliRegistrars 由 host 在不同 registry 隔离，不冲突。
- 共用入口 `buildMonitorCommands(program, { api, logger })` 必须保持纯函数 + closure 拿 api/logger，**不能依赖 module-level state**。
- 回归测试盲点：本插件的测试套件覆盖不到 CLI 注册路径（没有跑 host 的 plugin loader）。**任何**改 `src/cli-metadata.ts` / `setup-command.ts` 共享部分 / 主入口 `register` 之后，必须在装好 host 的环境用 probe 脚本调一次 `loadPluginCliRegistrationEntriesWithDefaults({ primaryCommand: "monitor" })` 确认返回 entries.length === 1。

### 59. **2026.5.14 起 `llm_output` / `model_call_*` 事件带 `contextTokenBudget` / `resolvedRef` / `harnessId`**

host 2026.5.14 (#64327) 给 `PluginHookLlmOutputEvent` 和 `PluginHookModelCallBaseEvent` 加了三组字段（type 在 `node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts:42-47, 78-83, 101-119`）：

| 字段 | 含义 | monitor 可用场景 |
|---|---|---|
| `contextTokenBudget?: number` | 该 run/call 的有效 context 预算（model/config/agent caps 取最小） | 算 `usage.total / contextTokenBudget` 作为 context utilization，加 stat card 或 alert metric `contextUtilization` |
| `contextWindowSource?: "model" \| "modelsConfig" \| "agentContextTokens" \| "default"` | budget 来源 | 调试维度，能看 budget 被谁覆盖 |
| `contextWindowReferenceTokens?: number` | 原生 / 配置参考窗口（被更低的 cap 盖住时仍记） | 算 budget 利用率 vs 原生窗口 |
| `resolvedRef?: string` | 完整 `provider/model` 引用，含 provider 前缀（如 `openai-codex/gpt-5.4` vs `codex/gpt-5.4`） | Models 维度替代 raw `model` 字段，避免同名 model 跨 provider 折叠 |
| `harnessId?: string` | 跑这个 model loop 的 harness/backend id | 加 Harness 维度（区分 pi runtime / codex runtime）|

`PluginHookToolContext` 在 2026.5.18 (#83387) **新增** `channelId`, `sessionId`, `sessionKey`, `runId`, `agentId` 字段（之前是 `runId? + toolName + toolCallId? + getSessionExtension?` 那几个）—— 决策 #13 的 runId → channelId 缓存现在**可以从 ctx 直接拿**，但因为 minHostVersion 还卡在 2026.5.7，缓存路径仍要保留作为 5.7-5.17 兜底。

**v0.9.8 已接 1-4**，落点：

1. **`contextTokenBudget` → context utilization**：`hook-metrics.ts: llm_output` 把 budget 透传给 `buildTokenEvent`，最终落到 `TokenRecordedEvent.contextTokenBudget`。`aggregator.ingest` 在 `llm.tokens.recorded` 分支算 `min(100, totalTokens / budget * 100)`，分两层累加：(a) 给 recent ring 上的 `EventTimePoint.contextUtilizationPct` 字段 → `computeWindow` 算窗口级 `avgContextUtilizationPct` / `peakContextUtilizationPct`；(b) 给每个 dimension accumulator (`channelStats` / `modelStats` / `sourceStats` / `harnessStats`) 的 `contextUtilizationSum/Count` → `dimensionRows` 计算 `avgContextUtilizationPct`。`WindowSnapshot` / `DimensionRow` / `AlertMetric` union / manifest schema enum 同步扩展（决策 #22 仍成立：alerts engine 不需改，泛型读 `snap[metric]`，新 key 自动支持，null 值 = 不触发）。
2. **`resolvedRef` 用作 model 维度 key**：`aggregator.ts` 优先用 `tokenEvent.resolvedRef`，回退到 `provider/model` —— 老 host 行为不变，新 host 自动获得跨 provider 同名 model 的分离能力。
3. **`harnessId` 新维度**：`aggregator.harnesses()` + `/api/monitor/harnesses` 端点 + UI `Harnesses.tsx` 页 + `harnessesFromEvents` helper。host < 2026.5.14 时空表 — UI 渲染 `harnesses.empty.noField` info banner（非 error，因为这是预期降级而非故障）。
4. **tool ctx channelId**：`hook-metrics.ts` 的 `before_tool_call` / `after_tool_call` 优先用 `ctx.channelId / sessionId / sessionKey / agentId`（5.18+），fallback `enrich(synth, runId)` 经 runCtx 缓存（5.7-5.17）。回归测试 `hook-metrics.test.ts > "preserves channel/sessionKey/agentId from tool ctx when host >= 2026.5.18"` 和 `"falls back to runCtx registry ..."`。

**绝对不要做的事**：
- 不要把原始 `contextTokenBudget` / `resolvedRef` / `harnessId` 字段当窗口聚合值塞进 `WindowSnapshot` —— 这些是 per-event 元数据。`avgContextUtilizationPct` / `peakContextUtilizationPct` 是聚合结果，可以塞。
- 不要因为有了 `resolvedRef` 就抛弃原始 `model` 字段 —— 旧 host 没有这个字段，会让 5.7-5.13 host 上 Models 页全空。aggregator 是 `resolvedRef ?? (provider/model)` fallback，不是 hard switch。
- 不要把 5.18 起的 tool ctx channelId 当唯一来源 —— minHostVersion=2026.5.7 仍要支持，runId 缓存路径保留。新写 hook 时**先**读 ctx 字段，**再** `enrich` 兜底。
- 不要在 `Harnesses.tsx` 把 "harnessId 缺失" 渲染成 error-banner —— 那是 host 版本/audit gate 决定的 expected 降级，info-style empty state 即可。
