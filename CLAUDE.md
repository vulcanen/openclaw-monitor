# CLAUDE.md —— OpenClaw Monitor 插件认知文档

给 AI agent 看的项目共识文档。改动之前先读完这一页。**改动哪个层就要遵守哪个层的契约**，不要跨层猜测。

## 文档维护规则（元规则，第一条读）

每次改完代码、准备 commit 之前，先回答两个问题：

1. 本次改动是否引入了新的层职责 / 新的 host 行为发现 / 新的工程约束 / 修了一个曾经踩过的坑？
   - 是 → 把它写进本文件的「关键事实」或「关键工程决策」一节（决策块编号顺延，不要覆盖历史决策），引用具体文件路径和事件名让以后能精确定位。
2. 本次改动是否改变了功能 / 配置默认值 / HTTP 端点 / UI 用户可见行为？
   - 是 → 同步改 `README.md`。`README` 是给运维 / 用户看的纯功能说明，**不写**版本历史 / 内部决策 / 调试技巧 / 解释性废话；一行能说清楚就一行。

两份文档都改完才 commit。这条规则是用户在 v0.6.1 之后明确划下的协作红线。

## 项目定位

- **是什么**：`@vulcanen/openclaw-monitor` 是一个 OpenClaw 5.7 插件，发布到公开 npm。
- **解决什么**：OpenClaw 自身的诊断事件总线只对内可见，对运维是黑盒。这个插件把事件总线接出来，做聚合 / 持久化 / 实时推流 / 仪表板 / 内容审计。
- **不解决什么**：不替代 Prometheus / Grafana / OTel Collector。OpenClaw 已自带 `diagnostics-otel` 和 `diagnostics-prometheus` 两个导出器，本插件与它们并存。
- **不在范围**：不修改 OpenClaw core，不引入对其他 extension 私有 src/** 的依赖。
- **scope/registry**：`@vulcanen` scope（npm 个人 scope，注册账号自动持有），发布到公开 npm `https://registry.npmjs.org/`。安装 / 解析 / publish 全部走 npmjs 公网，无 mirror 依赖。

## 架构（必须按层改）

```
┌─────────────────────────────────────────────────────────────────┐
│  OpenClaw Host (不修改)                                           │
│   onDiagnosticEvent  api.on(hookName, ...)  registerHttpRoute   │
└──────────┬──────────────────┬──────────────────┬────────────────┘
           ▼                  ▼                  ▼
┌──────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ probes/      │   │ audit/          │   │ outlets/        │
│ event扇出     │   │ 4 个 hook 抓内容 │   │ HTTP 路由 + SSE  │
└──────┬───────┘   └────────┬────────┘   └────────┬────────┘
       │                    │                     ▲
       ▼                    ▼                     │
┌─────────────────────────────────────┐           │
│ pipeline/  滑动窗口 + 维度聚合 + 运行  │           │
│            状态机                    │           │
└─────────────────────┬───────────────┘           │
                      ▼                           │
┌─────────────────────────────────────┐           │
│ storage/  JSONL 持久化 + retention   │───────────┘
└─────────────────────────────────────┘
```

**层职责，不要混淆：**

| 层 | 文件 | 职责 | 禁止做的事 |
|---|---|---|---|
| `probes/` | `event-subscriber.ts` | 订阅 host 事件总线，扇出到 buffer / bus / store / pipeline | 不做聚合、不暴露 API、不持久化 |
| `audit/` | `conversation-probe.ts` 等 | 注册 4 个 hook 抓内容，按 runId 聚合，写 audit JSONL | 不订阅诊断事件总线（与 probes 解耦） |
| `pipeline/` | `aggregator.ts`、`runs-tracker.ts`、`extractors.ts` | 纯函数式聚合 + 维度抽取 + 运行状态机 | 不做 IO、不持有定时器 |
| `storage/` | `jsonl-store.ts`、`retention.ts`、`ring-buffer.ts` | 文件读写 + 内存环形缓冲 + 定期清理 | 不解析业务语义（事件结构不在这一层处理） |
| `outlets/` | `rest-routes.ts`、`sse-stream.ts`、`static-ui.ts`、`event-bus.ts` | HTTP handler + SSE 总线 + 静态资源 | 不直接读 host 事件总线 |
| `ui/` | Vite + React 子项目 | 浏览器端仪表板 | 不绕过 `/api/monitor/*` 直接读 host |

## 关键事实（绕过这些 fact 会浪费几天）

**外部插件能拿到 / 拿不到什么事件**：

| 事件来源 | 通过 `onDiagnosticEvent` 可见？ | 通过 `api.on(hook)` 可见？ |
|---|---|---|
| `emitDiagnosticEvent(...)`（非 trusted） | ✅ | n/a |
| `emitTrustedDiagnosticEvent(...)`（trusted） | ❌ **被过滤** | n/a |
| `model.call.*` / `harness.run.*` / `tool.execution.*`（trusted） | ❌ | ✅ via `model_call_started/ended` / `before_tool_call/after_tool_call` hook |
| `log.record` | ❌ 永远不通过 onDiagnosticEvent，要订 logging | n/a |
| `message.queued` / `message.processed`（非 trusted） | ✅ | 无对应 hook |
| `session.state` / `queue.lane.*` / `diagnostic.*` | ✅ | n/a |

**OpenClaw 走哪条代码路径取决于 session 类型**（看 Control UI 的 Sessions 页 `type` 字段）：

| Session type / runtime | 触发标准 agent harness？ | model.call hook fire？ | message_received/sending hook fire？ |
|---|---|---|---|
| `direct` + `pi` runtime（用户 API 项目） | ✅ via Pi embedded runner | ✅ | ❌ |
| Control UI 内置聊天 | ❌ | ❌ | ❌ |
| Channel plugin 入口 | ✅ | ✅ | ✅ |
| OpenAI compat `/v1/chat/completions` | ✅ via agentCommandFromIngress | ✅ | depends on session type |

**实操结论**：依赖 `onDiagnosticEvent` 是个**死路**。Metrics 必须从 hook 走，事件总线只能拿到运维侧信号（队列 / session 状态 / 内存 / 心跳）。

**Hook 上下文字段并非统一** —— 不同 hook 的 `ctx` 形状不一样（host 源码 `src/agents/pi-embedded-runner/run/attempt.model-diagnostic-events.ts: modelCallHookContext` vs `attempt.ts: agent_end` 块）：

| Hook | runId | sessionKey/Id | channelId | trigger | provider/model |
|---|---|---|---|---|---|
| `model_call_started/ended` | ✅ | ✅ | ❌ | ❌ | ✅ |
| `before_tool_call/after_tool_call` | ✅(event) | ❌ | ❌ | ❌ | ❌ |
| `agent_turn_prepare` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `agent_end` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `before_prompt_build` / `llm_input` / `llm_output` | ✅ | ✅ | ✅ | ✅ | varies |

任何想给 `model.call.*` / `tool.execution.*` 事件补 channel/trigger 的代码，**必须**从 `agent_turn_prepare`/`agent_end` 维护一个 `runId → {channelId, trigger}` 缓存来回查（`src/probes/hook-metrics.ts` 的 `makeRunContextRegistry`）；指望 model_call hook 的 ctx 自带 channel 永远拿不到。

**误导性事件**：`diagnostic.liveness.warning` 是**进程级**事件循环 / CPU 压力信号（host `src/logging/diagnostic.ts:380` emit；CPU 忙、GC 压力、event-loop p99 超阈值都会触发），**不是会话级**告警。不要把它当 "session stalled / stuck" 渲染（v0.6.1 已经把它从 `sessionsAlerted` 里剔掉）。真正的 per-session 注意力信号只有 `session.stalled` 和 `session.stuck`（host `diagnostic.ts:810-822`）。

## 关键工程决策（不要倒退）

1. **存储用 JSONL，不用 SQLite** —— OpenClaw 安装时强制 `--ignore-scripts`（[已验证](D:/projects/offical-openclaw/openclaw-2026.5.7/src/plugins/install.ts)），better-sqlite3 这类带 native postinstall 的包**装不上**。JSONL append-only + 按日期分文件，零原生依赖、retention 直接 `unlink` 旧文件。
2. **零运行时 npm 依赖** —— `package.json` 的 `dependencies: {}` 是空的。`openclaw` 是 devDependency（仅取类型，runtime 由 host 注入）。UI 的 React/Recharts 全部打进 `dist/ui/assets/index-*.js` 静态文件。这是为了避免 host 上任何 install-time 的依赖解析失败。
3. **HashRouter，不是 BrowserRouter** —— 静态 UI handler 不做 SPA fallback，所有客户端路由都在 hash 段（`#/overview`），后端不用感知。
4. **scope 用 `@vulcanen`，不要用 `@openclaw`** —— [install.ts:189](D:/projects/offical-openclaw/openclaw-2026.5.7/src/plugins/install.ts) 对 `@openclaw/*` 有特殊"trusted official prerelease"路径，会改变版本解析行为。`@vulcanen` 是个人 scope，与 host 无任何特殊耦合。
5. **公开 SDK 的 `onDiagnosticEvent` 单参 + trusted 事件被过滤** —— listener 签名是 `(evt) => void`，**没有 metadata**。更关键的：`onDiagnosticEvent` **故意丢弃所有 trusted 事件 + 所有 log.record**（[diagnostic-events.ts:803-810](D:/projects/offical-openclaw/openclaw-2026.5.7/src/infra/diagnostic-events.ts)）。Pi runtime / agent harness 用 `emitTrustedDiagnosticEvent` 发出 `model.call.*` / `harness.run.*` —— 这些事件**架构上外部插件永远收不到**。**正确做法**：从 plugin hook (`api.on("model_call_started", ...)` 等) 拿，hook 不受这个过滤影响。`src/probes/hook-metrics.ts` 就是为此而生。任何"为什么 onDiagnosticEvent 看不到 model.call 事件"的疑问，答案都是这一条。
6. **不直接 import `@openclaw/plugin-sdk`** —— 那个包是 host 私有的（`private: true, version: 0.0.0-private`）。外部插件依赖 `openclaw` 主包，从 `openclaw/plugin-sdk/<sub>` 子路径导入。
7. **HTTP 路由权限分两类**：
   - `/api/monitor/*`（数据接口）：`auth: "gateway"` + `gatewayRuntimeScopeSurface: "trusted-operator"`，**不要降级**。
   - `/monitor/*`（静态 UI 资源）：`auth: "plugin"`（公开）。**这是有意为之**——浏览器没法在普通导航里加 Authorization 头，所以静态文件必须公开；UI 自己处理 token（localStorage + fetch headers）。**不要把它改回 `auth: "gateway"`**，否则浏览器永远 401。
8. **M5 默认 opt-out + 条件注册** —— `audit.enabled: false` 是默认。改动 audit 模块时：
   - 不要把默认改成 true
   - 在 `conversation-probe.installHooks` 里**仅当 `audit.enabled` 与 `hooks.allowConversationAccess` 同时为真才注册** `llm_input/llm_output/agent_end` hook（避免 host 输出 "blocked" info 日志）
   - `before_prompt_build` 不在 host 的 `CONVERSATION_HOOK_NAMES` 里，可以随时注册
   - audit 关闭时即便 hook 触发也不写盘（probe state 自检）
9. **路径解析用 `import.meta.url`** —— `static-ui.ts` 用 `path.dirname(fileURLToPath(import.meta.url))` 锚定 dist 目录，不要写死相对路径。

10. **Host config 写入只有一个入口**：`src/cli/setup-command.ts` 的 `openclaw monitor setup [--audit]` —— 用户显式触发，写 plugins.allow + hooks.allowConversationAccess + config.audit.enabled。用 `runtime.config.mutateConfigFile` 配 `afterWrite: { mode: "restart", reason: ... }`。**插件 register/start 期间不要自动写 host config** —— 不仅 CLAUDE.md 规则禁止，Claude Code harness 也会独立判断为"high-severity security-gate change"并拒绝。曾经尝试在 v0.5.0 加 autoTrustHostGates 自动写盘，被 harness 多次拦截；最终决定停留在 v0.4.0 的"插件默认开 audit + 用日志提示用户跑 setup"模式。

11. **SSE 用 fetch reader，不用原生 EventSource** —— 原生 EventSource 不支持自定义 header，加不上 Authorization。`ui/src/api.ts` 里的 `openEventStream` 是 fetch + ReadableStream + 手写 SSE 解析的实现。改它的时候注意保留 `data:` 多行合并和 blank-line 分块语义。

12. **`register(api)` 可能被调用多次 — 必须 idempotent**（v0.5.2 修复，不要再回归）：OpenClaw 的 plugin loader 在不同 load profile（provider runtime / web-fetch runtime / agent-tool-result middleware / cli-registry-loader 等）会用不同的 `PluginLoadOptions` 触发独立的 `loadOpenClawPlugins`，cache miss 时会**完整重新跑** plugin entry 的 `register(api)`。
    - 含义：state（buffer / aggregator / runs-tracker / JSONL store / SSE bus / conversation probe / 去重表）**必须**在 module-level 缓存成 singleton（`src/index.ts` 的 `sharedBundle`）。如果每次 register 新建一个 bundle，hook callback 会写到第二次 bundle 的 fanout，而 HTTP/SSE handler 还指向第一次 bundle 的 buffer —— 表现就是"hook fire 但监控页面全 0"，v0.5.0/0.5.1 都是这个 bug。
    - `api.registerService` / `api.registerHttpRoute` / `api.registerCli` **只在第一次 register 调用**（用 `routesAndServiceWired` flag 锁住），后续 register 直接跳过 —— 同一 path 重复注册要么报错要么 shadow 第一个 handler，而且只有第一个 api 真正连到 gateway HTTP server。
    - `bundle.registerHooks(api)` **每次 register 都要调**，因为不同 load profile 用不同的 hook 注册表；fanout 的 `callId`/`toolCallId` dedup 表会吸收重复 inject。
    - 回归测试在 `src/service.test.ts > "plugin entry idempotency"`，改 entry 时务必跑。

13. **Channel / Source 维度必须靠 runId 缓存补全**（v0.6.0 修复）：`model_call_*` 和 `*_tool_call` hook 的 ctx 不带 `channelId` / `trigger`，所以 `src/probes/hook-metrics.ts` 用一个 module-level 的 `runId → {channelId, trigger}` Map（`makeRunContextRegistry`），在 `agent_turn_prepare` / `agent_end` 时写入，在 inject `model.call.*` / `tool.execution.*` / `harness.run.*` 之前用 `enrich(synth, runId)` 回填。**不要删掉这层缓存**，否则通道页和来源页又会归零（`/api/monitor/channels` 和 `/api/monitor/sources`）。TTL 60 秒覆盖 model.call 在 agent_end 之后才到达的边界场景。aggregator 的 channels 维度也加了 model.call 兜底累计（`src/pipeline/aggregator.ts` 里检查 `dims.channel && isModelCallEvent(...)`）—— 注意这里跟 message.delivery / message.processed 的累计是**并行而非重复**：每条事件最多进一个分支，由 `if (!isMessageDeliveryEvent && !isMessageProcessedEvent)` gate 把关。

14. **Logs 页是诊断事件流，不是 host 日志**（v0.6.0 改造）：`log.record` 事件被 host 在 `onDiagnosticEvent` 之前过滤掉了（决策 #5），外部插件**永远拿不到**真正的 host 日志。`src/outlets/rest-routes.ts: createLogsHandler` 不再去 buffer 里找 `log.record`，而是直接消费 buffer 的全部事件，按 event type 推断 level（`.error/.stuck/.stalled → error`，`.blocked/.liveness.warning → warn`，`heartbeat/memory.sample → debug`，其余 `info`）、用 `inferLogLevel` + `formatLogMessage` 拼成可读的一行。改 logs handler 时**不要**重新写成 `buffer.recent({ type: "log.record" })`——那是死路。`component` 过滤改为 substring 匹配（精确 equality 会误伤所有自动派生的 component 名）。

15. **`sessionsAlerted` 只算 `session.stalled` / `session.stuck`**（v0.6.1 修复）：`isSessionAlertEvent`（`src/pipeline/extractors.ts`）和 windows 计算（`src/pipeline/aggregator.ts: computeWindow`）只统计 host 的 per-session attention 检查输出（`diagnostic.ts:810-822`），**不要**重新把 `diagnostic.liveness.warning` 加回去 —— host 在正常 GC / CPU spike 时就会 emit liveness.warning，会让总览页 stat card 假阳性发红。原始 liveness.warning 事件仍在 buffer 里，事件页和日志页能看到。Overview stat card 也**不要**再加 "stalled / stuck" 的 delta 文案（曾经那条副标题在 stat card 数值为 0 时也显示，让人误以为有真会话卡死）。

16. **审计内容默认大放行 `contentMaxBytes`**（v0.6.0）：默认值 1 MiB（schema cap 16 MiB，类型在 `src/types.ts: DEFAULT_MONITOR_CONFIG.audit` 和 schema 在 `openclaw.plugin.json`）。原来的 16 KiB 默认会把一个普通 prompt 切成 `…[truncated]`，让 ConversationDetail 页看不到完整内容。如果之后觉得磁盘膨胀严重，**不要**降回 16K —— 优先调 `retainDays`（默认 3 天），或者引入逐字段 hash 化策略，不要用截断当压缩。`MAX_HISTORY_ITEMS = 64` 限制的是 history 数组长度，跟单段内容字节数无关。

17. **对话审计支持 `?groupBy=sessionKey`**（v0.6.0）：`/api/monitor/conversations` 默认仍返回 flat `conversations[]`（向后兼容），加 `?groupBy=sessionKey` 时改返回 `sessions[].conversations[]` 嵌套结构（`src/audit/conversation-routes.ts: groupBySession`）。每个 SessionGroup 聚合 runCount / totalTokensIn/Out / hasError / lastSeenAt。UI 默认走 groupBy 路径（`Conversations.tsx` 调 `api.conversationsBySession`），渲染可折叠面板。无 sessionKey 的旧记录归入 `_ungrouped` 桶。改 list handler 时保留两种返回 shape，**不要**默认只返回 grouped——历史 API 客户可能直接读 flat。

18. **对话 summarize 有两个孪生函数，必须同步**（v0.6.3 修复，不要再回归）：`src/audit/conversation-routes.ts: summarizeRuntime`（处理内存里的 `recentCompleted`）和 `src/audit/conversation-store.ts: summarize`（处理 jsonl 召回）做完全相同的 `ConversationRecord → ConversationSummary` 转换。**改任何一个，另一个必须同步改**。v0.6.0 加 sessionKey 字段时只补了 routes 那个，store 那边漏了，结果磁盘上每条 record 都有 sessionKey 但被召回成 summary 时丢掉，UI 全部 conversation 都进 `_ungrouped` 桶。任何给 ConversationSummary 加新字段（trigger、tokensTotal、cost、tags…）的改动都要扫这两个文件同步加。最好长期改成共享一个 helper —— 没做是因为两端代码路径差异（一个有 in-flight `state` mutation，一个纯函数读 jsonl）暂时拆着；做 helper 要保持纯函数签名。

19. **PC 端 dashboard，不做移动端**（v0.6.3 确立）：详见 UI 规则 #5。不要为 < 720px / 触屏 / 移动浏览器写代码 —— 用户场景是运维 PC，目标视口 1024px+。`styles.css` 只保留 1100px 那档（PC split-screen / 缩窗）。任何后续 UI 重构如果引入移动端布局，先回这里读一遍。

20. **告警引擎是 in-process setInterval，不持久化**（v0.7.0）：`src/alerts/engine.ts` 在 plugin 进程内跑评估循环（默认 30s），状态机（活跃告警 Map + history ring buffer）**全部在内存里**，gateway 重启后会丢。理由：告警是运营信号不是审计日志，丢了再触发一次问题不大；持久化会引入 jsonl 双写复杂度。如果未来需要"重启后继续抑制冷却中告警"再加 state file。**channels 必须从 `alerts.channels` 字典里按 id 解析**（`src/alerts/dispatcher.ts: dispatchNotification`），不要让 rule 直接内嵌 URL，因为同一通道经常被多条 rule 复用。**evaluateNow** 是给测试用的同步入口，生产路径只走 `start()` 启动的定时器。`history` 保留 24h 或 200 条（先到先除），靠 `src/alerts/history.ts`。

21. **DingTalk 签名实现位置固定**（v0.7.0）：`src/alerts/channels/dingtalk.ts: signRequest` 用 `node:crypto` 的 `createHmac("sha256", secret)`，签名格式严格按 DingTalk 文档（`timestamp + "\n" + secret` → base64-hmac-sha256 → URL encode）。任何"看起来等价"的改写（比如把 `\n` 换成空格、把 base64 换成 hex）都会让钉钉返回 errcode=310000。已经在测试里固定（`alert engine > dingtalk channel signs the request`）。DingTalk 也支持"关键词"安全模式（消息含约定关键词即可），所以 rule.name 默认就拼进 markdown title —— 不要把 name 改成 emoji-only 或纯数字。

22. **alerts 评估只读 windows snapshot，不依赖事件**（v0.7.0）：rule 的 metric 字段对应 `WindowSnapshot` 的 key（src/types.ts），engine 每次 tick 调 `aggregator.windows()` 一次性拿全部窗口，再按 rule 取值。**不要**改成订阅 fanout 或者每条事件评估一次 —— 那样会丢失窗口聚合语义，并且把 hot path 卡在评估循环上。规则评估是异步 fire-and-forget，dispatcher 内部容错每个 channel 的失败，永不向 engine.evaluate 抛错（否则 setInterval 会吞异常静默挂死）。

23. **alerts UI 是只读列表**（v0.7.0）：`ui/src/pages/Alerts.tsx` 只渲染 rules / active / history 三个表，**不做 CRUD**。规则编辑唯一入口是 `~/.openclaw/openclaw.json`，改完重启 gateway。理由：把可视化编辑做到 v0.7 会让 UI 工作量 ×3，先把数据通路打通；v0.8+ 真有用户反馈再考虑加。

24. **Token 数据走 `llm_output` hook，cost 在采集端预算**（v0.8.0）：`model_call_ended` event 不带 token 数（host 在 stream observer 结束时 emit，那时 assistant message 还没 parse 完）。Token + cost 来自 `api.on("llm_output", ...)`，事件 `event.usage = {input, output, cacheRead, cacheWrite, total}`（host 类型 `PluginHookLlmOutputEvent`）。这个 hook **依赖** `hooks.allowConversationAccess` 安全门（同 audit）—— 用户没开就拿不到 token，Costs 页 cost 全 0。在 hook-metrics 里用 `pricing` ref 算好 cost 后 inject 一个新合成事件 `llm.tokens.recorded`，aggregator 看到这个 type 时按 model/channel/source 累计 token + cost。**不要**改成把 cost 算放到 aggregator 或 REST handler —— 那样 daily-cost JSONL 写盘时还得知道 pricing 又是一个 ref 注入链。

25. **`llm.tokens.recorded` 是 plugin-private 类型**（v0.8.0）：不在 host 的 `DiagnosticEventPayload` union 里（host SDK 不知道这个 type）。需要的地方用 `(event.type as string) === "llm.tokens.recorded"` 比较（TS 否则报 union 无重叠）。fanout 接收这个事件后**额外**喂给 `dailyCostStoreRef.get()?.recordTokenEvent` 做日级累计；常规事件走完 buffer / aggregator / SSE bus 后顺带写一份 JSON 进 daily-costs JSONL。**不要**让 hook-metrics 直接调 daily store —— fanout 是唯一统一分发点，旁路绕过破坏一致性。

26. **DimensionRow 上的 cost / cacheRead/Write 字段是可选**（v0.8.0）：v0.8 之前 row 只有 total/errors/p50/p95/tokensIn/tokensOut；新加的 cost / cacheReadTokens / cacheWriteTokens 都是 optional，0 时不出现在 JSON 里（aggregator.ts: dimensionRows 用 conditional spread）。**不要**改成默认 0 写出——会让 Channels / Models 页面在没成本数据时多出一列空 `0`。

27. **Daily-cost 存储是文件-per-day 全量 JSON**（v0.8.0）：`<stateDir>/openclaw-monitor/daily-costs/daily-costs-YYYY-MM-DD.json`，每天一个文件，文件内是当日完整累计 + byModel 分桶。写入逻辑 = 内存累加 + 1s 防抖 flush + 整文件 `writeFileSync` 覆盖。不是 append-only！因为成本是单调加法，每次 flush 都是"完整快照"。`createDailyCostStore.close()` 必须在 service.stop 调，否则最近 1s 的累加丢盘。retention 用 `pruneOlderThan` 按文件名日期 unlink，默认 90 天（明显比 events.jsonl 默认 7 天长，因为月度成本需要看完整月）。**绝对不要**把这种"全量覆写"的格式改成 jsonl append-only —— 当日多次 flush 会写成多条行，rangeSum 重复累计。

28. **windows snapshot 的 totalTokens 含义**（v0.8.0）：`WindowSnapshot.totalTokens` 是 input + output + cacheRead + cacheWrite **四类合计**，不是单一 input。`/api/monitor/costs` 把它放到 `windows[w].tokensIn` 字段里（CostRangeSummary 字段名复用，没增字段），UI 直接读 `tokensIn` 当总 token 显示。这是个故意的字段名复用 —— 真要分开看四类，去 Costs 页的 byModel 表（每行单独列）。改 windows 计算时**不要**只加 input 一类，会让今日 stat card 数字偏小。

29. **Token 数据卡点是 host `supportsUsageInStreaming` 默认 false，不是 provider 物理限制**（v0.8.0 误判 → 实测验证 → 修正）：曾以为是上游不返回 usage —— curl 直连上游证伪了：加 `stream_options.include_usage: true` 后最后一帧带完整 usage。真正卡点在 host `src/plugins/provider-model-compat.ts:127`：host 对**未知 baseUrl** 的 OpenAI-compat provider 自动把 `model.compat.supportsUsageInStreaming` 写死 `false`。结果 host 自己的 stream parser **静默丢弃**上游返回的 usage 帧。修复：在 user `openclaw.json` 给该 model 加 `compat: { supportsUsageInStreaming: true }` 覆盖默认。已写进 README 双语"Known config notes / 自建 LLM 上游"段。任何用自建 OpenAI-compat 网关（vLLM / SGLang / TGI / 自建 proxy）的用户都会踩。**不要**改回"上游不返回 usage"的旧解释 —— 那是错的。**不要**改成 prompt char count / 4 估算 —— 该 fix 让 token 数精确可得，没必要估算。Costs UI 仍保留 byModel.tokens=0 时的提示 banner（对真没价格表 / 真不发 usage 的极端 provider 还是兜底），但文字应同时说明"先检查 compat.supportsUsageInStreaming"。

30. **唯一的 conversation summary 路径**（v0.9.2）：`ConversationRecord → ConversationSummary` 投影由 `src/audit/summarize.ts: summarizeConversation` **独占**。v0.6 时存在两份近重复实现（routes vs store）一度漂移让所有持久化 conversation 进 `_ungrouped` 桶——决策 #18 已禁止再分裂。**任何**给 ConversationSummary 加新字段的改动只改 summarize.ts 一处，conversation-routes.ts 和 conversation-store.ts 都从这里 import。不要再 inline 自己写一份"为这个场景定制的 summarize"。

31. **Webhook / DingTalk channel 默认拒绝私网 host**（v0.9.2）：`src/alerts/channels/url-guard.ts: assertSafeChannelUrl` 在 send 前 reject `127.x` `10.x` `172.16-31.x` `192.168.x` `169.254.x`（含 AWS / GCP metadata 169.254.169.254）`localhost` 以及 IPv6 loopback/ULA。Channel config 加 `allowPrivateNetwork: true` 即 opt-out（自建内网 incident 接收器场景）。**不要**把 guard 去掉变成"trust 操作员就行"——开源后会被静态扫描器标红，且配置文件误改的事故面增加。schema 已加 `allowPrivateNetwork` 字段，README 安全章节会提。

32. **Aggregator startup replay 必须分批 + 限量**（v0.9.2）：`src/service.ts` 的启动 replay 从今日 events.jsonl 倒灌 aggregator + buffer。两个硬约束：(a) `REPLAY_TAIL_LIMIT = 100_000` 只取最近 N 条（windows 是滚动窗口，远古事件没意义）；(b) `REPLAY_CHUNK = 1_000` 每千条 `await setImmediate` 让事件循环喘气。**不要**改成同步 for 循环吃完——曾经差点这么写，单进程几百万行 jsonl 会卡 service.start 几十秒，期间 gateway 健康检查都不响应。replay 现在是 fire-and-forget 异步（`void replay()`），live 事件来了直接走 fanout，跟 replay 的事件交错正确（同一个 aggregator 实例）。

33. **Window P95 latency 计算依赖 recent ring 上的 `durationMs` 字段**（v0.9.2 修 pre-existing bug）：v0.8 之前 `modelP95Ms` 永远是 `null`，因为 `EventTimePoint` 没记 duration，computeWindow 的 `modelDurations: number[]` 永远空。修复加在 `aggregator.ts ingest`：终态 model.call / tool.execution 事件时把 `dims.durationMs` stamp 到 recent ring 的 `point.durationMs`。computeWindow 读它 push 进 `modelDurations`。**不要**改回不存 durationMs 的旧形态——Overview 页"5m model P95"卡片会永远显示 "—"，是 visible 的功能空洞。

34. **Conversation store 维护 runId → file in-memory 索引**（v0.9.2）：`get(runId)` 之前是 O(全部 jsonl 行) 线性扫描，retention 调长（30天）时单次 ~百毫秒。v0.9.2 引入 lazy 构建的 `runIdToFile` Map + `fileMtimeAtIndex` Map：首次 `get` 时全量扫，之后 `appendCompleted` 增量更新。`pruneOlderThan` 时反向清掉 index 里指向被删文件的 entry。**不要**换成 byte-offset 索引——audit record 大小可变（捕获完整 prompt，能到 MB 级），offset 脆且对维护一致性帮助不大；file-level 索引足够，匹配文件后再做一次倒序行扫即可。

35. **UI 上所有显示 channel / source 字面值的位置必须经过 `friendlyEntryLabel`**（v0.9.2 之后强制规则）：禁止在 React 组件里直接渲染 `{r.channel}`、`{channelId}`、`{row.key}` 之类来自 backend 的原始 channel/source 字符串——那是 host 内部 token（绝大多数情况就是 `"webchat"`），运维看了无法分辨入口路径，是糟糕的 UX。**统一做法**：
    - 表格行 channel/source 列：用 `friendlyEntryLabel(t, inferEntryKey(channel, trigger, runId))` 或 `friendlyEntryLabel(t, key)`（key 是 backend `extractSource` 已经派生过的）展示
    - 原始 channel 值塞进 `title=` 作为 hover，方便排错（参见 `ui/src/pages/Conversations.tsx` 的 SessionRow / `ui/src/pages/Insights.tsx` 的 slow-calls 表）
    - **每个新加的 UI 表格**如果有 channel/source 列，第一件事是 import `friendlyEntryLabel`，不要拖到 review 阶段才补
    - Backend 的 REST 响应仍然返回**原始技术 id**（`"webchat"` / `"openai-api"` / `"channel:telegram"`）—— 不要把翻译做到后端，那是 i18n 关心的事，会让 API consumer 难以稳定 parse
    - 当前覆盖了 Conversations / Channels / Sources / Insights 四页。新增页面时如果展示 channel 字段没用 helper，**视为 review block**。

30. **`webchat` 是 host 的 INTERNAL_MESSAGE_CHANNEL 常量，不是浏览器聊天**（v0.8.3 + v0.8.4 改进）：OpenClaw `src/utils/message-channel-constants.ts:1` 把字符串 "webchat" 当作"所有非 channel-plugin 入口"的统一标识，覆盖：`/v1/chat/completions`、Control UI 内置聊天、heartbeat / cron / webhook 内部触发。**channel 字段单独无法区分这些路径**。要区分必须用：(a) runId 前缀：`chatcmpl_*` = OpenAI compat（host `openai-http.ts` 构造），`ctrl_*` = Control UI（host `server-chat.ts` 构造）；(b) trigger：`channel-message` = audit 路径（conversation-probe 合成），`user/heartbeat/cron/webhook` = host 设的。Host 实测**对 OpenAI compat 和 Control UI 都设 trigger=user**，所以**只靠 trigger 区分不可靠**，必须 runId 优先。共享逻辑：backend `src/pipeline/extractors.ts: extractSource`，UI `ui/src/entry-label.ts: inferEntryKey + friendlyEntryLabel`。**不要**让两个地方分别维护推断逻辑 — 始终走 ui/src/entry-label.ts 这个共享 helper。

31. **Channels 页几乎没有信息密度，因为 host 都标 webchat**（v0.8.4 调整）：channels 维度按 host 的 channel 字段聚合，OpenClaw 默认配置下永远只有 "webchat" 一行。监控插件已经在 Channels 页加了 host 行为解释 hint，并把上面那张 "messages.delivered" 趋势图换成了 "model.calls"（消息送达事件 trusted 且 hook 也很少 fire，永远空，换成有数据的）。**真正的运维使用场景是 Sources 页**（按 entry path 拆分）。改 Channels 时不要再加 messages 相关的 chart / 计数 —— 那些 metric 在外部插件视角下只能拿到很少甚至 0 数据。

32. **Insights 是 read-only 个案下钻，不持久化**（v0.9.0）：`src/insights/queries.ts` 用既有 buffer (ring per type, 默认 1024) + audit conversation store 算 top-N。不新建任何 ring / 文件 / index — 每次请求都重新 filter+sort buffer。window 上限 24h，limit 上限 50。下游路径 (Run Detail / Conversation Detail) 是稳定接口，可以直接 `<Link>` 跳。**不要**把 Insights 改成"自维护排行榜在 ingest 路径上算" —— 那会让 hot path 多一遍 sort overhead；现状是查询端开销，操作员 5s polling 一次完全够用。Heavy-conversations 路径合并内存 (`probe.recentCompleted`) + 磁盘 (`storeRef.list`)，跟 Conversations 页同口径。Error-clusters / Tool-failures 用 SAMPLE_RUN_IDS_PER_CLUSTER=5 保留示例 runIds（UI 点这些 link 跳 Run Detail）。windowSec 解析在 `src/insights/rest-routes.ts` 用 clampWindow / clampLimit 兜底非法值。

33. **不要再次把 `event.sessionId` 当 `sessionKey` 用**（决策 #18 的孪生回归，已第二次修复）：`PluginHookLlmInputEvent`（host `hook-types.d.ts:48`）**只有** `sessionId: string`，**没有** `sessionKey`。任何 `const sessionKey = event.sessionId ?? ctx.sessionKey;` 都是 bug——`event.sessionId` 永远非空、`??` 永远走不到 ctx，且 sessionId 是 host 内部不透明 id（如 `chatcmpl_xxx`），跟 sessionKey（channel 关联键，如 `telegram:userN`）语义完全不同。后果：`state.bySessionKey` 被 sessionId 污染，conversation grouping 把多跳 LLM 调用拆成多条 _ungrouped。唯一正确写法：`const sessionKey = ctx.sessionKey;`（事件层根本没这个字段）。同类规则适用于所有"event 里没声明 sessionKey"的 hook：`llm_output` (`hook-types.d.ts:79`) / `agent_end` (line 107) 都只有 sessionId，sessionKey 只能从 ctx 取。回归测试 `service.test.ts > "llm_input does not pollute sessionKey with sessionId"`。

34. **`agent_end.messages` 是完整对话快照，不是 outbound 回复**（v0.9.3 修复）：host `PluginHookAgentEndEvent.messages` 字段包含 system / user / assistant 全部消息（agent 流程结束时的完整 conversation state）。把它直接写进 `record.outbound.messages` 会让 ConversationDetail 第 ④ 段（"OpenClaw → 消息发送方"）显示**整段 LLM 输出 + system prompt + user 提问**，重复第 ③ 段内容并污染。`message_sending` hook 才是真正的"发回给消息发送方"信号（含单条 assistant 回复 + to/replyToId）。`src/audit/conversation-probe.ts` agent_end finalize **必须**：(a) 已有 outbound（说明 message_sending 写过干净版本）→ 只更新 success/status/error/durationMs，**不要覆盖 messages**；(b) 无 outbound（纯 direct-API 流程，没 channel hook）→ 才回退到 messages 数组。回归测试 `service.test.ts > "agent_end preserves outbound captured by message_sending"`。

35. **对话详情段名一律用"消息发送方"，不是"项目"**（v0.9.3）：插件是公开 npm 包，消息源不一定来自"项目"（可能是 Telegram / Discord / Control UI / OpenAI compat API client）。`ui/src/i18n/{zh,en}.ts` 的 conversationDetail.section.* 用 "消息发送方 → OpenClaw / OpenClaw → 消息发送方"（zh）/ "sender → OpenClaw / OpenClaw → sender"（en）。任何 UI 重构都不要回退到"项目 → OpenClaw"措辞。

36. **`url-guard` 不能只用字符串 regex 挡 IPv6 嵌入 IPv4**（v0.9.3 SSRF 修复）：WHATWG URL parser 把 `[::ffff:127.0.0.1]` 归一化成 `[::ffff:7f00:1]`、`[::127.0.0.1]` 归一成 `[::7f00:1]` —— dotted-quad 形式从 `.hostname` 完全消失。`/^127\./` / `/^10\./` 这些 IPv4 模式全部 miss。**正确做法**：`src/alerts/channels/url-guard.ts: embeddedIPv4(host)` 用 `node:net.isIPv6` 验证后，根据 `::ffff:` / `::` 前缀提取后 32 bit 还原 IPv4 dotted-quad，再用 `LITERAL_PRIVATE_HOST` 重新跑一遍。任何后续往 LITERAL_PRIVATE_HOST 加 IPv6 模式都是徒劳（hostname 已被归一化），扩展逻辑必须改 embeddedIPv4。回归测试 `service.test.ts > "url-guard rejects IPv6-mapped IPv4 loopback"`。

37. **告警 engine 的 setInterval 必须自带 reentrancy 闸门**（v0.9.3）：`src/alerts/engine.ts: start()` 的 setInterval 回调不会因为前一次 `evaluate()` 的 Promise 没 resolve 就跳过 —— 在多 rule × 多 channel × 10s timeout 的极端情况下两次 tick 可能并发执行，同时看到 `activeByRuleId.get(ruleId) === undefined`，对同一规则各发一份 "fired" 通知（违反 cooldown）。闸门变量 `let evaluating = false;` 在 setInterval 回调开头检查 / 设置，`.finally` 复位。**不要**改成"每 tick 异步 fire-and-forget evaluate 多次"——既绕开 cooldown 又会让 history ring 重复 push。

38. **`daily-store.readDay` 不能用 `cost` truthy 过滤 cached snapshot**（v0.9.3）：`cached?.cost ? cached : undefined` 会把 cost===0 但 tokens>0 的合法 day 丢成 undefined。两种触发：(a) 1 秒未 flush 窗口内的初始事件；(b) 走兜底 0 价格的 provider（决策 #29："对真没价格表 / 真不发 usage 的极端 provider 还是兜底"）。正确：`return cache.get(day);`，文件不存在时只判 cached 是否存在，不要再判 cost 字段。回归测试 `service.test.ts > "daily-cost readDay returns cached day when cost is 0 but tokens exist"`。

39. **`hook-metrics` runCtx 注册表必须有外层 max-TTL**（v0.9.3）：`src/probes/hook-metrics.ts: makeRunContextRegistry` 之前只在 `agent_end` 调 `scheduleEvict`（60s TTL）。任何走到 `agent_turn_prepare` 但**没走完** `agent_end` 的 run（host abort / crash mid-run / harness 路径绕过 finalize）会让 `ctxByRun` 条目永久驻留，每条 ~100 字节，慢但无上界的内存泄漏。修复：`set()` 内部用 `RUN_CTX_MAX_TTL_MS = 30 * 60_000` 作为兜底；正常 agent_end 路径再覆盖到 60s 短 TTL。30 分钟覆盖所有"实际有意义的 run"时长，不会误删多 turn 的活 run（因为每次 turn 的 set() 都会刷新 timer）。

42. **ConversationDetail 用时间线 + 配对卡片，不再用 4 段固定布局**（v0.9.5 重构）：4 段（sender→OpenClaw→LLM→OpenClaw→sender）的固定结构有个根本缺陷——每段独立，**没采到的事件渲染成空壳**视觉上像功能坏了；尤其 host 的 `llm_output` hook 在不少 provider / 配置下不 fire，section ③ 永久空白让人误以为是 bug。新设计在 `ui/src/pages/ConversationDetail.tsx` 用 `buildTimeline()` 把 inbound / llmHop[i] / outbound / error 按 capturedAt 排序成时间线，**只渲染有数据的卡片**。LLM 调用的 input 和 output **配对在同一张卡里**（一次 RTT 自然属于同一逻辑单元），多跳就是多张 LLM 卡。半捕获（有 input 没 output 或反之）的 LLM 卡内部用 `noOutput` / `noInput` 区块呈现，并附**诊断 hint**（三档：① host gate 没开 → `openclaw monitor setup --audit`；② 上游 stream 不返回 usage → `compat.supportsUsageInStreaming: true`；③ provider adapter 不 fire hook → 查 host 日志）。**不要**回退到固定段位布局——半捕获的诊断价值都在 noOutput hint 里，被强制布局压回空壳就丢了。所有时间线 i18n key 在 `conversationDetail.timeline.*` 命名空间。Marker 颜色映射在 `MARKER_COLOR` 常量：inbound=`--text-dim` / llmHop=`--accent` / outbound=`--accent-2` / error=`--error`，改动颜色不要乱占其他语义色。

41. **`findOrCreateRecord` 命中合成 runId 时必须 promote 到真 runId**（v0.9.4 修复 — 0.9.3 引入的回归）：channel-based flow（Control UI / Telegram 等）下事件顺序是 `message_received` → `before_prompt_build` → `llm_input` → `llm_output` → `message_sending` → `agent_end`。`message_received` 时没 runId，probe 会铸造合成 `ctrl_<sessionKey>_<ts>` 作为 placeholder。当 `before_prompt_build` 带真 runId 进来、通过 sessionKey 命中已存在记录时，**必须**把 `state.active` 里的 key 从合成 runId 换成真 runId（同步更新 `record.runId` 与 `bySessionKey`），否则后续走 runId-only lookup 的 handler（典型：`llm_output` `state.active.get(runId)`）会 miss 这条记录、静默丢弃 assistant 文本——表现就是 ConversationDetail 第 ③ 段（LLM → OpenClaw）渲染**空白**，而第 ②（OpenClaw → LLM）正常。修复位置 `src/audit/conversation-probe.ts: findOrCreateRecord` 的 sessionKey-lookup 分支：`if (runId && runId !== linked.runId && linked.runId.startsWith("ctrl_"))` 时执行 re-key。`llm_output` handler 同步加 sessionKey fallback 作为防御深度（handler 顺序异常时仍能命中）。**回归测试盲点教训**：0.9.3 的 "agent_end preserves outbound" 测试只断言 `outbound.messages` 内容，没断言 `llmOutputs.length / record.runId` 是不是真 runId——任何对 conversation 流程的新测试都要把"每段都有内容 + record.runId 是真的不是 ctrl_*"作为基线断言。

40. **每 48 小时检查上游 OpenClaw 有没有新正式版**（v0.9.3 加入工作流约束）：
    - **当前 baseline**：`package.json -> devDependencies.openclaw` 与 `openclaw.plugin.json -> openclaw.install.minHostVersion` / `openclaw.compat.pluginApi` 必须三处对齐到同一个 stable tag（当前 `2026.5.7`）。任何升级都得三处一起改。
    - **检查状态文件**：repo 根目录 `openclaw-version-check.json` 是单一真源，记录 `lastCheckedAt` / `latestStableObserved` / `assessment`。
    - **每次新对话开始**：读 `openclaw-version-check.json`，若 `lastCheckedAt` 距今 ≥ 48h（用 `currentDate` 系统时间判断），跑一次检查；否则跳过。**不要每 turn 都查**——只在新对话的第一个相关时机。
    - **检查脚本**（gh 不可用时用 curl，无需鉴权，公开 repo）：
      ```bash
      curl -s -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/openclaw/openclaw/releases?per_page=30" \
        > /tmp/oc-releases.json
      python3 -c '
      import json
      with open("/tmp/oc-releases.json") as f:
          data = json.load(f)
      stables = [r for r in data if not r.get("prerelease") and not r.get("draft")]
      if stables:
          latest = stables[0]
          print(latest["tag_name"], latest["published_at"], latest["html_url"])
      '
      ```
    - **判定与评估**：只看 stable（`prerelease=false && draft=false`），完全忽略 `*-beta.*` / `*-rc.*` / `*-alpha.*`。若最新 stable tag > baseline：WebFetch release notes，重点检查 SDK 变化——`hook-types.d.ts` 新 / 改 / 删的 hook、`PluginHookXxxEvent` schema 字段、`@openclaw/plugin-sdk/*` 子路径导出、`OpenClawPluginApi` 公开方法、host 安全门（`allowConversationAccess` 等）、HTTP 路由 auth 模式。逐项判断对本插件的影响。
    - **回写状态**：把当次 `lastCheckedAt` 写成 ISO 时间戳，`latestStableObserved` 写最新 tag，`assessment` 用枚举 `no-action` / `review-pending` / `upgrade-recommended`，`assessmentNotes` 写一两句决策依据。
    - **绝对不要自动改版本号**：升级 `package.json` / `openclaw.plugin.json` 的 baseline 是有意决策，需要用户 explicit 授权，仅做"评估 + 报告"。
    - **报告口径**：一句话告诉用户（"已是最新" / "有新 stable，影响评估：xxx"），**不要**把整篇 release notes 复述回对话——长度 + 信号比太差。详情让用户自己点 URL。

43. **`installHookMetrics` 必须用 WeakSet 防同一 api 被注册两次**（v0.9.6 修复 — pre-existing 致命 bug）：决策 #12 让 `bundle.registerHooks(api)` 每次 register 都跑；不同 load profile 给的是不同 api object，正确链路是"每个 api 上注册一次"。但若同一个 api 因为 cache 刷新 / hot reload 被传两次，`api.on("llm_output", h)` 就会叠两个 listener，host 端 `getHooksForName`（host: `src/plugins/registry.ts`）不按 plugin 去重，**单条 llm_output 触发会合成 N 条 `llm.tokens.recorded`**——决策 #25 早就标记这个事件是 plugin-private 且 fanout 只用 callId/toolCallId 做 dedup，token 事件**两个 id 都没有**，aggregator + daily-cost JSONL 直接 N 倍累计。修复 `src/probes/hook-metrics.ts: installedApis = new WeakSet<OpenClawPluginApi>()`，首行 `if (installedApis.has(api)) return; installedApis.add(api);`。同步在 `src/probes/event-subscriber.ts: dispatch` 给 `llm.tokens.recorded` 加 `tok:${runId}:${seq}` dedupeId（`buildTokenEvent` 已生成单调 seq）作为 belt-and-suspenders。回归测试 `service.test.ts > "installHookMetrics is idempotent on the same api object"` 与 `"llm.tokens.recorded with same (runId, seq) is deduped at the fanout"`。**不要**改成把 dedup 范围扩到 `harness.run.*`——那些事件没 seq 且 agent_turn_prepare 每 turn fire 一次（多 turn 合法重入）。

44. **`ring-buffer.append` 必须支持显式 capturedAt**（v0.9.6 修复 — pre-existing 致命 bug）：`service.start` 的 replay 路径（决策 #32）从 JSONL 把今日历史事件喂回 buffer + aggregator。aggregator 路径用 `captured.capturedAt` 正确；buffer 路径之前调 `buffer.append(captured.event)`，append 内部 `Date.now()` 覆盖时间戳——结果**重启后头几小时**所有 Logs / Overview `recentErrors` / Insights cutoff 都以为历史错误是"刚刚"。修复 `src/storage/ring-buffer.ts: append(event, capturedAtMs?)`，service.ts replay 与 fanout dispatch 都传 capturedAt。回归测试 `service.test.ts > "preserves an explicit capturedAt on replay-style appends"`。

45. **`computeWindow` 不能假设 `recent[]` 单调升序**（v0.9.6 修复 — pre-existing bug）：原实现倒序循环，遇 `ts < cutoffMs` 立即 `break`。决策 #32 说明 replay 是 fire-and-forget（`void replay()`）且 fanout.start 紧随其后启动；live 事件在 replay 仍在跑时已开始 push 到 `recent`，**新 ts 排在旧 ts 后面**，break 过早导致窗口短时间归零。修复改为 `continue` 整段扫满。代价：1h 窗口从早断转为全扫 ≤ 10k 元素，仍 O(10k) 单次约 0.5 ms 可接受；windows() snapshot 后续可加 1s TTL 缓存进一步降负载（见审计报告 Hot #6，未做）。**不要**回退到 break——会再次在每次重启后让 Overview 卡片几秒钟显示 0。

46. **`truncateString` 按 UTF-8 字符边界切，不要按 char index**（v0.9.6 修复 — pre-existing bug）：原实现 `Buffer.byteLength` 判超限但 `value.slice(0, max - ELLIPSIS.length)` 按 UTF-16 code unit 切。中文 / emoji 1 char = 3-4 字节，超限 1 MiB 的 prompt 实际切出来可能仍 3 MiB；更糟的是有概率切在 surrogate pair 中间。**正确做法**：`Buffer.from(value).subarray(0, budget)` 后**手动回溯**到 UTF-8 字符边界（continuation byte 高位 10xxxxxx 即 `>=0x80 && <0xC0`，遇到这种就回退一字节，直到首字节）。`Buffer.subarray.toString("utf8")` 不会自动丢弃尾部不完整字节而是替换成 U+FFFD（`�`）—— 第一次修复掉进了这个坑（测试发现），最终改成显式手动回溯。回归测试 `service.test.ts > "truncates multi-byte UTF-8 content within the byte budget"`：3×budget 的 CJK 字符串切完后必须 `byteLength <= budget + ELLIPSIS_BYTES`，且**不包含 U+FFFD**。

47. **`AlertEngine.evaluateNow` 也要 reentrancy guard**（v0.9.6 — 决策 #37 补全）：v0.9.3 只在 `start()` 的 setInterval 路径加了 `evaluating` 标志。`evaluateNow()` 是测试入口、且未来手动触发评估 REST 端点也会调它——若一个 tick 还没 resolve 时 evaluateNow 被并发调用，两路都看见 `previous=undefined`，对同一 rule 各发一份 "fired" 通知，违反 cooldown。修复 evaluateNow 复用同一 `evaluating` 变量。**不要**给 evaluateNow 单独搞一个标志——必须和 setInterval 共享，否则二者之间也能竞态。

48. **`url-guard` IPv4 patterns 只对解析成 IPv4 的 host 生效**（v0.9.6 修复 — pre-existing bug）：决策 #36 已修了 IPv6 嵌入 IPv4，但 IPv4 patterns 写成 `/^127\./` 等文字模式，会把 `127.example.com` / `10gen.net` 当 loopback / RFC1918 一起拒掉——合法外部 webhook 直接打不通。修复 `src/alerts/channels/url-guard.ts` 拆成两组：`LITERAL_PRIVATE_HOST`（localhost、IPv6 前缀）对原始 host 匹配；`IPV4_PRIVATE_PATTERN`（`/^127\./` `/^10\./` 等 + 新增的 `/^0\./` 覆盖 0.0.0.0/8）**仅当 `isIPv4(host) === true` 时**才匹配。embeddedIPv4 路径同步走 IPv4 表。回归测试 `service.test.ts > "url-guard does not over-match domains that look like IPv4 prefixes"` 与 `"url-guard rejects the entire 0.0.0.0/8 range"`。**不要**把 IPv4 patterns 改回直接 test 任意字符串——`{cdn,gateway}.10gen.net` 一类域名会被误杀。

49. **conversation-probe 必须运行 abandoned-record sweeper**（v0.9.6 修复 — pre-existing memory leak）：channel-only flow 下 host 崩溃 mid-run / sender 永不发 message_sending / 网络抖动让 agent_end 永不触发，对应 record 永留 `state.active`。决策 #16 后单条 record 可达 MB。修复 `src/audit/conversation-probe.ts`：(a) 每个 mutating handler 末尾调 `touch(runId)` 刷 `state.lastTouchedAt` 时间戳；(b) `ABANDON_TTL_MS = 30 * 60_000` + `ABANDON_SWEEP_INTERVAL_MS = 5 * 60_000` 的 setInterval 扫 `state.active`，超时 record 走 `finalize` 并标 `status = "abandoned"`、`errorMessage = "abandoned: no host update for N min"`；(c) `ConversationRecord.status` union 加 `"abandoned"` 选项（决策 #41 测试基线"每段都有内容 + 真 runId"不受影响——abandoned 只是终态多了一种）。`service.start` 调 `probe.startSweeper()`，`service.stop` 调 `stopSweeper()`。**不要**把 TTL 调短到 30 分钟以下——长 prompt + 多 turn agent run 几十分钟正常，误杀活 run 比留几个僵尸 record 损失大。回归测试 `service.test.ts > "sweeper finalizes abandoned active conversations"`。

50. **EventBus.subscribe 是 atomic check-and-add，返回 undefined 表示拒绝**（v0.9.6 修复 — pre-existing TOCTOU bug）：旧 SSE handler 的 `if (bus.size() >= max) { 503 } else { bus.subscribe(...) }` 在并发请求下两个连接都过 size 检查、只有一个真正 subscribe，loser 拿到 no-op unsubscribe + 持续打开的连接，从此收不到任何事件——浏览器看像挂起。修复 `src/outlets/event-bus.ts: subscribe` 改返回 `(() => void) | undefined`：到上限直接 `return undefined`，SSE handler 据此 503 + 立即 end。**不要**把 size() 分离回外面——任何"先看 size，再添加"的两步都会再现 TOCTOU。配套修复 sse-stream.ts 的 `closed` 标志防多次 res.end()。

52. **Lint / Prettier / CI matrix / GH templates 是工程化基线**（v0.9.7 加入）：
    - ESLint flat config 在 `eslint.config.js`，跑 `typescript-eslint` recommended-type-checked + react-hooks，重点是 `no-floating-promises` / `no-misused-promises` —— 这俩规则覆盖了决策 #22 / #37 / #41 这类异步静默挂死类历史 bug 的整片潜在面。
    - **HTTP route handler 的 `async` 关键字不要去掉**：`OpenClawPluginHttpRouteHandler` 类型要求 `Promise<boolean>`，handler 写成 `async` 即便没有 `await` 也是对的；ESLint 配置已禁用 `require-await` 规则正是为这层契约。
    - 测试文件 type-check 走 `tsconfig.eslint.json`（主 tsconfig `exclude: ["*.test.ts"]` 避免编译到 dist；ESLint 需要看见它们）。改 tsconfig 时**必须同步**改 tsconfig.eslint.json。
    - Prettier 配置锁定**既有事实风格**（双引号 + 分号 + trailingComma:all + 100 char），不要为统一去翻新历史代码 —— 一次性 `npm run format` 已经过；之后只对增量改动应用即可，CI `format:check` 卡住偏移。
    - CI 矩阵跑 `[22, 24]`，跟 `engines.node: ">=22"` 配套，Node 26 LTS 出来时再加。
    - GH PR template 与 ISSUE_TEMPLATE bug-report / host-compat 在 `.github/`，运营场景比文字 README 直觉得多。
    - 发版走 `tags v*.*.*` 触发 `.github/workflows/release.yml` 自动建 GH Release + 用 commit history 生成 release notes；**npm publish 仍是手动一步**，CI 不持 NPM_TOKEN 是有意决策（供应链攻击面控制）。

53. **测试文件按层就近放，不要堆 service.test.ts 一个**（v0.9.7 重构）：CLAUDE.md 原本"测试集中"的指导被误读成"一个文件装全部" —— 实际意图是**就近 + 集中在 src/**（不要 `__tests__/` 目录或 `test/` 顶层）。当前布局：
    - `src/test-utils.ts` 共享 `makeEvent` 等纯工具（不挂 vitest globals）
    - `src/storage/ring-buffer.test.ts` / `src/storage/jsonl-store.test.ts`
    - `src/pipeline/aggregator.test.ts`（合并 runs-tracker）
    - `src/probes/hook-metrics.test.ts`
    - `src/audit/conversation-probe.test.ts`（~600 行，体量最大）
    - `src/alerts/engine.test.ts`
    - `src/costs/daily-store.test.ts`
    - `src/insights/queries.test.ts`
    - `src/service.test.ts` 保留 **service-level 编排** 测试（plugin entry idempotency + event fanout）
    单文件 1700 行的 ergonomics 不可接受；vitest pattern `src/**/*.test.ts` 不变。**改这些**：新测试就近放到 layer 的 `*.test.ts` 里；service.test.ts 不再吃通用单测。

54. **错误抛出统一加 `code` 字段，不引入 Error 子类**（v0.9.7 决策对齐 Next.js 实际惯例）：项目原约定是裸 `throw new Error(message)`（决策 #21 隐含）。v0.9.7 给**调用方需要 catch + 分支**的位置加 `code` 属性：`url-guard` 的 `URL_GUARD_*`、`dispatcher` 的 `ALERT_CHANNEL_UNKNOWN_KIND`、`dingtalk` 的 `DINGTALK_HTTP_ERROR` / `DINGTALK_API_ERROR`、`webhook` 的 `WEBHOOK_HTTP_ERROR`。**不要**改成 `class HttpError extends Error` 一类的子类层级 —— Next.js 实际源码全用裸 `throw new Error(\`...\`)`，本项目对齐这一点。code 用 `Object.assign(new Error(msg), { code })` 而非 declared class；后续加新 code 时同样模式。

55. **UI v0.9.7 增加 Layout 顶导分组 + 全局时间窗 + 健康横幅 + Sessions 页 + 行内可视化**（编号 51 之后整体一批 UI 改造）：
    - **Layout 顶导**（`ui/src/components/Layout.tsx`）拆 4 组 (Status / Roll-ups / Drill-down / Audit) 用 `nav-divider` 分隔。`NAV_GROUPS` 是数组的数组，新加导航项加到对应组里 —— **不要**回到平铺 11 项。
    - **全局时间窗选择器** `ui/src/time-window.tsx`（TimeWindowProvider + useTimeWindow + ?window= URL hash 同步）。当前页面**没有强制订阅** —— 给页面接入时用 `useTimeWindow().window` + `WINDOW_TO_SECONDS[w]`。改 default 时不要破坏 URL fallback。
    - **Overview 健康横幅**（`Overview.tsx: HealthBanner`）合成 ok/warn/error 三档：error → `recentErrors>5 || errorRate5m>=20%`；warn → 任一阈值过半。**阈值是有意调宽**避免一次 stray error 染红首页。改阈值要改 `computeHealth`。
    - **Overview lifecycle 第二排 stat card**：消费决策 #51 的合成事件 `session.lifecycle.*` / `agent.compaction.completed` / `tool.result.persisted` / `gateway.lifecycle.started`。读 `data.countsByType` —— 是 cumulative-since-start 视角，要变成"今日"需要 backend 加日级 rollup（未做，留作 follow-up）。
    - **Sessions 页**（`ui/src/pages/Sessions.tsx` + 路由 + nav）从 `/api/monitor/events?type=session.lifecycle.*` 拉两类事件 client-side 配对成 session 表。**故意不加专门的 sessions REST 端点** —— backend 做的也只是同样的 match，重复工作没必要。需要 server-side 过滤/分页时再升级。
    - **DimensionTable inline error-rate 横条**（`ui/src/components/DimensionTable.tsx`）`.err-rate-bar` class 在 styles.css；惠及 Sources / Channels / Models / Tools 四页。**不要**改成单独的 column —— 这是 cell 内的辅助视觉。
    - **Insights HeavyConversations 行内 mag-bar** 显示 tokens 占该页 max 的比例。Recharts 没必要为这点动 BarChart。
    - **Costs byModel 上方 Recharts BarChart**（horizontal "share of cost"）。颜色硬编码 `#58a6ff` 旁边带 `// matches --accent` 注释（CLAUDE.md UI 规则 #1 允许此 token 同步注释）。
    - **api.ts 增加 ApiError 类**，`usePolling` 用 `err.friendly()` 渲染；不再把原始 stack 字符串塞进 `.error-banner`。

57. **`extractSource` / `inferEntryKey` 把 host 字面 channel 中的 internal trigger 名当 internal**（v0.9.7.3）：host 在 heartbeat / cron / webhook 触发的 agent run 里把 `ctx.channelId` 设成**字面值**（`"heartbeat"` / `"cron"` / `"webhook"`）而非 INTERNAL_MESSAGE_CHANNEL (`"webchat"`)。原本的 `extractSource` 看到非 webchat 直接 fall-through 到 `channel:<name>`，结果 Sources 页把心跳分类成"Channel: heartbeat"，UX 上像有个叫 heartbeat 的 channel 插件。修复：在两个文件里都加一个 `INTERNAL_TRIGGER_NAMES = new Set(["heartbeat", "cron", "webhook"])` 常量；channel 命中此集合时返回 `internal:<channel>`，绕过 channel:* 分支。也用同一个集合替换原本 `if (trigger === "heartbeat" || trigger === "cron" || ...)` 的写法。**两份必须同时改**（决策 #35）：`src/pipeline/extractors.ts: extractSource` 与 `ui/src/entry-label.ts: inferEntryKey`。未来添加新的 internal trigger 名（比如 `scheduled` / `queue`）只改这两个常量。回归测试 `src/pipeline/extractors.test.ts > "returns internal:<name> when the channel field is itself an internal trigger name"`。

56. **UI 新加的 i18n key 务必中英双补**（决策 #35 已强调，v0.9.7 再次踩到）：本轮加了 ~40 个新 key（`topbar.*` / `overview.health.*` / `overview.lifecycle.*` / `sessions.*` / `empty.logs.hint.*` / `empty.runs.hint.*` / `costs.notice.noTokensHint.*` / `alerts.col.ruleExpr` / `logs.filter.typePrefix` / `conversations.filter.*`），任何一处只在一边加的 i18n key，缺失 locale 会渲染 raw key 字符串。**回归手段**：新 key 落地前在 `zh.ts` 与 `en.ts` grep 一遍 key 名确保两边都在。

51. **新订阅一组 host hook 用 `*.lifecycle.*` 命名空间合成新事件**（v0.9.6 host 能力利用）：决策 #5 / #12 锁定了"hook 是真源"的路线，但项目 v0.9.5 只订阅了 11/34 个 hook。v0.9.6 在 `src/probes/hook-metrics.ts` 增订：
    - `session_start` / `session_end` → 合成 `session.lifecycle.{started,ended}`（含 `messageCount`、`durationMs`、`reason`），替代用 sessionKey 推断 session 边界的 leaky 方案。
    - `before_compaction` / `after_compaction` → 合成 `agent.compaction.{started,completed}`（含 `messageCount`、`compactedCount`、`tokenCount`），context-window 利用率信号。
    - `tool_result_persist` → 合成 `tool.result.persisted`（含 `toolName`、`isSynthetic`、`messageBytes`），补充 tool output 体积可见性。
    - `gateway_start` / `gateway_stop` → 合成 `gateway.lifecycle.{started,stopped}`（含 `port`、`reason`），清晰的 uptime / 重启历史。

    所有新事件类型是 plugin-private 字符串（host 的 `DiagnosticEventPayload` union 不知道它们）—— 与决策 #25 同样的 cast 处理（`event.type as string`）。`createLogsHandler.inferLogLevel` 给 `gateway.lifecycle.stopped` 映射成 warn（运维重要事件），其余走默认 info。**不要**给这些新事件加 aggregator dimension —— 它们目前是 Events / Logs 页 + Logs typePrefix 过滤的纯透传信号；要做 dashboard widget 再单独提决策块。新增 hook 全套**不影响**任何既有 hook 流程（hook-metrics 内每个 api.on() 是独立 listener；hook 执行顺序由 host 控制，本插件不依赖）。

## 与 OpenClaw host 的接口契约

只用 SDK 公开 barrel，不要触碰别的子路径：

```typescript
// 允许：
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";

// 禁止：
// 1. 不要从 openclaw/src/** 导入（破坏 boundary）
// 2. 不要从 @openclaw/<其他扩展>/src/** 导入（破坏 owner boundary）
// 3. 不要假设 host 内部某个事件 / 字段 / API 一定存在 —— 看 published types
```

四个用到的关键 host API：

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

// 4. 服务上下文（在 service.start 拿到）
ctx.config         // 整个 OpenClaw config，本插件配置在 config.plugins["openclaw-monitor"]
ctx.stateDir       // 推荐的存储根目录
ctx.logger         // info / warn / error
```

## 4 个内容审计触点 → hook 映射

| 触点 | Hook | runId 来源 | 关键字段 |
|---|---|---|---|
| ① 项目 → OpenClaw | `before_prompt_build` | `ctx.runId` | `event.prompt`、`event.messages` |
| ② OpenClaw → LLM | `llm_input` | `event.runId` | `event.systemPrompt`、`event.prompt`、`event.historyMessages` |
| ③ LLM → OpenClaw | `llm_output` | `event.runId` | `event.assistantTexts`、`event.usage` |
| ④ OpenClaw → 项目 | `agent_end` | `event.runId ?? ctx.runId` | `event.messages`、`event.success`、`event.error` |

注意：一次 OpenAI API 调用可能触发多次 ②③（agent 循环 + tool use + failover），代码里 `llmInputs[]` 和 `llmOutputs[]` 是数组。①④ 与外部 1:1。

## 命令清单

```bash
# 安装
npm install                         # 后端
cd ui && npm install                # UI（独立 npm 项目）

# 验证
npm run typecheck                   # 后端 tsc 类型检查
cd ui && npm run typecheck          # UI 类型检查
npm test                            # vitest 单元测试

# 构建
npm run build                       # plugin + UI 一起
npm run build:plugin                # 仅后端
npm run build:ui                    # 仅 UI（输出到 dist/ui）

# 发布前自检
npm pack --dry-run                  # 看 tarball 内容
```

**改动验收门槛（最低）：** `npm run typecheck && npm test && npm run build` 全绿。如果 UI 改了，再加 `cd ui && npm run typecheck`。

## UI 规则（dashboard 风格 + 可用性底线）

UI 是 React + Vite + Recharts 的内置仪表板（`ui/`），风格是 GitHub 风的 dark dashboard。**不要换风格** —— 在风格 token 系统内迭代。

**设计 token（来自 `ui/src/styles.css:1-15`，唯一真源）：**
- 颜色：`--bg #0e1117` / `--panel #161b22` / `--panel-2 #1c2230` / `--border #2a3142` / `--text #e6edf3` / `--text-dim #8b949e` / `--accent #58a6ff` / `--accent-2 #7ee787` / `--warn #f9b342` / `--error #ff7b72` / `--good #3fb950`
- 字体：`--font` 系统无衬线（界面），`--mono` 等宽（数字、token、id、key、code）
- 字号阶：page-title 20 / panel h3 13（uppercase + 0.04em letter-spacing）/ body 14 / table th 11 / mono code 12
- 圆角阶：panel 8 / button & input 6 / tag 4 / token-gate-card 12

**写 UI 时硬性遵守：**

1. **不要写死颜色十六进制 / 字号** —— 都从 token 走（CSS var 或 `styles.css` 既有 class）。Recharts 等第三方需要硬编码十六进制时，从 token 的 hex 复制粘贴并加注释 "// matches --accent"。

2. **不要用 emoji 当 icon**。需要图标用 inline SVG（Heroicons / Lucide 的源）。Dashboard 不靠图形传达，能用文字 + tag 表达就别加图标。

3. **i18n 是硬约束** —— 任何用户可见的字符串必须经过 `t("ns.key")`，同步更新 `ui/src/i18n/zh.ts` 和 `ui/src/i18n/en.ts`。中文 key 写完不要忘了 EN。一处忘掉，对应 locale 会渲染原 key 字符串。

4. **键盘 + 屏幕阅读器底线**（v0.6.3 加固）：
   - **所有 interactive 元素都依赖 `:focus-visible` 全局样式**（`styles.css` 顶部已有）。**不要**在新组件上加 `outline: none` 把它关掉。如果觉得难看，调 `outline-offset` 或 `outline-color`，**不要**去掉。
   - **form input 必须有 `<label>` 或 `aria-label`** —— placeholder 不算 label（WCAG 3.3.2）。可视隐藏时用 `<label className="sr-only">`。
   - **icon-only 按钮 / 状态指示**（`.dot` 一类）`aria-label` 必填；纯装饰图形加 `aria-hidden="true"`。
   - **错误提示用 `role="alert"`** 让屏幕阅读器即时播报（TokenGate 已示范）。
   - 不要用 `title=` 替代 label —— `title` 在 touch 设备和 SR 上都不可靠。

5. **PC 端 dashboard，不做移动端**。目标视口 ≥ 1024px，主战场是 1440 / 1920+ 大屏。`styles.css` 只保留一档断点 `@media (max-width: 1100px)`，覆盖 PC split-screen / 缩窗场景，把 `grid.cols-4` 折叠到 2 列。**不要**新增 `< 720px` 的特化布局，**不要**为触屏 / hamburger menu / mobile drawer 写代码 —— 用户场景是运维工程师的电脑，加这些只会膨胀代码。表格类内容靠 `.panel { overflow-x: auto }` 兜底横向滚动即可。

6. **table 行 hover 仅在整行可点时才用**。当前 styles.css `table tbody tr:hover` 会给整行变色 —— 如果你让用户以为整行可点击，就必须真的让整行可点（包 `<Link>` 或 `onClick` + `cursor: pointer` + 键盘支持）。否则视觉撒谎。新加表格优先用 td 内 `<Link>` + 去掉 row hover。

7. **颜色不是唯一指示器**（WCAG 1.4.1）。`tag.ok/error/warn` 自带文本，OK；`StatCard` 的 `delta.good/.bad/.warn` 也只是颜色 —— 真要传达严重度，加图标或前缀文字。

8. **图表统一用 Recharts**（已是 dependency）。颜色从 token 走，tooltip 背景 `#161b22` 边框 `#2a3142`（参考 `TimeSeriesChart.tsx`）。不要再引入第二个图表库 —— bundle 已经 ~600 KB，主要就是 recharts + react。

9. **新加状态色**（如 info / muted）先看 token 是否已有；扩 token 比新增 hex 好。`accent-2` 当前用于 component 字段绿色，不要乱占。

10. **不要在 UI 里跑长任务** —— 5s polling 是上限，更频繁请求会冲 API 路由。需要实时改用 SSE（`/api/monitor/stream`，已有 `openEventStream` 抽象）。

11. **`prefers-reduced-motion`**：新加 `transition` 或 `animation` 时必须包到 `@media (prefers-reduced-motion: no-preference)` 里，或在全局加 reduce 兜底（当前 styles.css 尚未加，未来加动画前补上）。

12. **改完 UI 必须 `npm run build:ui`**（决策 #5 重复强调）—— Plugin 静态 handler 读的是 `dist/ui/index.html`，不重 build 浏览器看到的还是旧版。

## 测试规约

- 单测在 `src/service.test.ts`，集中所有模块的测试，不分散到子目录。
- 测试不依赖网络、不依赖 OpenClaw host 进程。所有 host API 用 fake 对象注入（参考 conversation probe 的 `makeFakeApi`）。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-..."))`，`afterEach` 清理。
- 改 storage 层时，至少加一条 roundtrip 测试（写一条 → close → 重开 → 读回来一致）。

## 常见陷阱

1. **不要用 `createWriteStream` + `stream.end()`** 做事件追加 —— 我们之前栽过：close 是异步的，测试 close→reread 会拿到空文件。改用 `appendFileSync`，吞吐对监控场景足够。
2. **不要在 audit 模块里直接写盘**，用 `setStore(store)` 注入。store 由 `service.start(ctx)` 在拿到 `stateDir` 后才创建。
3. **不要在 `register(api)` 时读 config** —— 那时拿不到 `ServiceContext`。config 必须在 `service.start(ctx)` 里读。Hook 注册要无条件，hook handler 内部根据 `probe.config.enabled` 判断是否处理。
4. **HTTP route handler 必须 `return true`**（`OpenClawPluginHttpRouteHandler` 的契约），否则 host 会继续向后路由。
5. **UI 修改后必须重新 `npm run build:ui`**，因为 `static-ui.ts` 读的是 `dist/ui/index.html`，不是 `ui/index.html` 源文件。
6. **不要在 SSE handler 里同步遍历大对象** —— 会阻塞订阅总线。每个事件 JSON.stringify 一次就发，控制 payload 大小。
7. **不要把 token / 凭据写进 `.npmrc`** 然后提交 —— `.npmrc` 现在只有 registry URL 没有 token，token 应该走 `npm login` 写入用户级 `~/.npmrc`，或者 CI 的环境变量 `NPM_TOKEN`。

## 不要做的事

- ❌ 改默认 `audit.enabled` 为 true
- ❌ 加 native deps（better-sqlite3、sharp 之类）
- ❌ 加 OpenClaw host 私有路径的 import
- ❌ 用 `@openclaw/` scope（host 有特殊路径，会变行为）
- ❌ 把 `/api/monitor/*` 数据接口的权限放宽到 `write-default` 或更低
- ❌ 把 `/monitor/*` 静态 UI 改回 `auth: "gateway"`（会让浏览器永远 401）
- ❌ 在 `dependencies` 里加任何包（保持空）
- ❌ 修改 git config（`user.email` / `user.name` 用户级已配置，不动）
- ❌ 在 `register(api)` 或 `service.start(ctx)` 里自动写 `plugins.allow` 或 `hooks.allowConversationAccess`（Claude Code harness 拦截此类自动提权——它在我们项目契约之上有独立的 security-gate 保护逻辑）。要走 `openclaw monitor setup [--audit]` CLI，由操作者显式触发。
- ❌ 默认开启脱敏前直接捕获 prompt 内容并明文回显到外部日志

## 边界外的事

如果改动需要：
- **修改 OpenClaw host 行为** → 不在本仓库做，去 OpenClaw 官方仓库提 PR
- **加新的 host hook** → 同上，host 维护者决定
- **改 ClawHub / npm 私库设置** → 找运维 / DBA

## 参考路径

OpenClaw 官方仓库本地 checkout：`D:\projects\offical-openclaw\openclaw-2026.5.7`，验证 host 行为时去这里读源码（不要改它）。

公开 SDK 类型：`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts`、`node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts`。
