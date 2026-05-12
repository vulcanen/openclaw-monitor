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

30. **`webchat` 是 host 的 INTERNAL_MESSAGE_CHANNEL 常量，不是浏览器聊天**（v0.8.3 + v0.8.4 改进）：OpenClaw `src/utils/message-channel-constants.ts:1` 把字符串 "webchat" 当作"所有非 channel-plugin 入口"的统一标识，覆盖：`/v1/chat/completions`、Control UI 内置聊天、heartbeat / cron / webhook 内部触发。**channel 字段单独无法区分这些路径**。要区分必须用：(a) runId 前缀：`chatcmpl_*` = OpenAI compat（host `openai-http.ts` 构造），`ctrl_*` = Control UI（host `server-chat.ts` 构造）；(b) trigger：`channel-message` = audit 路径（conversation-probe 合成），`user/heartbeat/cron/webhook` = host 设的。Host 实测**对 OpenAI compat 和 Control UI 都设 trigger=user**，所以**只靠 trigger 区分不可靠**，必须 runId 优先。共享逻辑：backend `src/pipeline/extractors.ts: extractSource`，UI `ui/src/entry-label.ts: inferEntryKey + friendlyEntryLabel`。**不要**让两个地方分别维护推断逻辑 — 始终走 ui/src/entry-label.ts 这个共享 helper。

31. **Channels 页几乎没有信息密度，因为 host 都标 webchat**（v0.8.4 调整）：channels 维度按 host 的 channel 字段聚合，OpenClaw 默认配置下永远只有 "webchat" 一行。监控插件已经在 Channels 页加了 host 行为解释 hint，并把上面那张 "messages.delivered" 趋势图换成了 "model.calls"（消息送达事件 trusted 且 hook 也很少 fire，永远空，换成有数据的）。**真正的运维使用场景是 Sources 页**（按 entry path 拆分）。改 Channels 时不要再加 messages 相关的 chart / 计数 —— 那些 metric 在外部插件视角下只能拿到很少甚至 0 数据。

32. **Insights 是 read-only 个案下钻，不持久化**（v0.9.0）：`src/insights/queries.ts` 用既有 buffer (ring per type, 默认 1024) + audit conversation store 算 top-N。不新建任何 ring / 文件 / index — 每次请求都重新 filter+sort buffer。window 上限 24h，limit 上限 50。下游路径 (Run Detail / Conversation Detail) 是稳定接口，可以直接 `<Link>` 跳。**不要**把 Insights 改成"自维护排行榜在 ingest 路径上算" —— 那会让 hot path 多一遍 sort overhead；现状是查询端开销，操作员 5s polling 一次完全够用。Heavy-conversations 路径合并内存 (`probe.recentCompleted`) + 磁盘 (`storeRef.list`)，跟 Conversations 页同口径。Error-clusters / Tool-failures 用 SAMPLE_RUN_IDS_PER_CLUSTER=5 保留示例 runIds（UI 点这些 link 跳 Run Detail）。windowSec 解析在 `src/insights/rest-routes.ts` 用 clampWindow / clampLimit 兜底非法值。

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
