# CLAUDE.md —— OpenClaw Monitor 插件认知文档（骨架 + 规则索引）

给 AI agent 看的项目共识文档。本文件是**骨架**：项目定位 / 元规则 / 架构 / 必读的关键事实 / 命令 / 红线。详细规则按主题拆到 [`rules/`](./rules/) 子目录，按需取阅。

**改动哪个层，就先读对应 rules/ 子文件**。骨架告诉你"去哪查"，细节在子文件里。

## 文档维护规则（元规则，第一条读）

每次改完代码、commit 前回答两个问题：

1. 是否引入新层职责 / 新 host 行为发现 / 新工程约束 / 修了一个曾踩过的坑？
   - 是 → 写进 `rules/` 下**对应主题文件**的「关键工程决策」一节（编号顺延，不覆盖历史），引用具体文件路径和事件名。新决策落到哪个文件，参照下方「规则索引」。
2. 是否改变功能 / 配置默认值 / HTTP 端点 / UI 用户可见行为？
   - 是 → 同步改 `README.md`（运维向纯功能说明，**不写**版本历史 / 内部决策 / 调试技巧；一行能说清就一行）。

两份文档都改完才 commit。这是 v0.6.1 之后明确划下的协作红线。详细维护流程见 [`rules/workflow.md`](./rules/workflow.md)。

## 项目定位

- **是什么**：`@vulcanen/openclaw-monitor`，OpenClaw 5.7 插件，发布到公开 npm。
- **解决什么**：把 OpenClaw 对内可见的诊断事件总线接出来 —— 聚合 / 持久化 / 实时推流 / 仪表板 / 内容审计。
- **不解决什么**：不替代 Prometheus / Grafana / OTel Collector。与 host 自带 `diagnostics-otel` / `diagnostics-prometheus` 并存。
- **不在范围**：不修改 OpenClaw core，不依赖其他 extension 私有 src/**。
- **scope/registry**：`@vulcanen`（npm 个人 scope）→ 公开 npm `https://registry.npmjs.org/`，无 mirror 依赖。

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

**层职责 + 改这一层应读哪个 rules 文件：**

| 层 | 文件 | 职责 | 禁止 | 读这个 |
|---|---|---|---|---|
| `probes/` | `event-subscriber.ts`、`hook-metrics.ts` | 订阅 host 事件总线 + 注册 hook，扇出到 buffer / bus / store / pipeline | 不聚合、不暴露 API、不持久化 | [`host-contract.md`](./rules/host-contract.md) |
| `audit/` | `conversation-probe.ts` 等 | 注册 4 个 hook 抓内容，按 runId 聚合，写 audit JSONL | 不订阅诊断事件总线 | [`audit.md`](./rules/audit.md) |
| `pipeline/` | `aggregator.ts`、`runs-tracker.ts`、`extractors.ts` | 纯函数聚合 + 维度抽取 + 运行状态机 | 不做 IO、不持定时器 | [`pipeline.md`](./rules/pipeline.md) |
| `storage/` | `jsonl-store.ts`、`retention.ts`、`ring-buffer.ts` | 文件读写 + 内存环形缓冲 + 定期清理 | 不解析业务语义 | [`pipeline.md`](./rules/pipeline.md) |
| `outlets/` | `rest-routes.ts`、`sse-stream.ts`、`static-ui.ts`、`event-bus.ts` | HTTP handler + SSE 总线 + 静态资源 | 不直接读 host 事件总线 | [`http-routes.md`](./rules/http-routes.md) |
| `alerts/` | `engine.ts`、`channels/*`、`url-guard.ts` | 评估循环 + 通道分发 + SSRF 保护 | 不依赖事件订阅，只读 windows snapshot | [`alerts.md`](./rules/alerts.md) |
| `costs/` | `daily-store.ts`、定价 ref | token + cost 累计、daily-cost JSONL | 不在 aggregator 算 cost | [`cost.md`](./rules/cost.md) |
| `ui/` | Vite + React 子项目 | 浏览器端仪表板 | 不绕过 `/api/monitor/*` 直接读 host | [`ui.md`](./rules/ui.md) |

## 关键事实（绕过这些会浪费几天，骨架必读）

**外部插件能拿到 / 拿不到什么事件**：

| 事件来源 | `onDiagnosticEvent` | `api.on(hook)` |
|---|---|---|
| `emitDiagnosticEvent(...)`（非 trusted） | ✅ | n/a |
| `emitTrustedDiagnosticEvent(...)`（trusted） | ❌ **被过滤** | n/a |
| `model.call.*` / `harness.run.*` / `tool.execution.*`（trusted） | ❌ | ✅ via `model_call_started/ended` / `before_tool_call/after_tool_call` |
| `log.record` | ❌ 永远过滤 | n/a |
| `message.queued` / `message.processed`（非 trusted） | ✅ | 无对应 hook |
| `session.state` / `queue.lane.*` / `diagnostic.*` | ✅ | n/a |

**OpenClaw 走哪条路径取决于 session 类型**（看 Control UI Sessions 页 `type` 字段）：

| Session type / runtime | agent harness? | model.call hook? | message_received/sending hook? |
|---|---|---|---|
| `direct` + `pi` runtime（用户 API 项目） | ✅ via Pi embedded runner | ✅ | ❌ |
| Control UI 内置聊天 | ❌ | ❌ | ❌ |
| Channel plugin 入口 | ✅ | ✅ | ✅ |
| OpenAI compat `/v1/chat/completions` | ✅ via agentCommandFromIngress | ✅ | depends |

**实操结论**：依赖 `onDiagnosticEvent` 是死路。Metrics 必须从 hook 走；事件总线只能拿运维侧信号（队列 / session 状态 / 内存 / 心跳）。详见 [`rules/host-contract.md`](./rules/host-contract.md)。

## 命令清单

```bash
# 安装
npm install                         # 后端
cd ui && npm install                # UI（独立 npm 项目）

# 验证
npm run typecheck                   # 后端 tsc
cd ui && npm run typecheck          # UI
npm test                            # vitest

# 构建
npm run build                       # plugin + UI
npm run build:plugin                # 仅后端
npm run build:ui                    # 仅 UI（输出到 dist/ui）

# 发布前自检
npm pack --dry-run
```

**改动验收门槛（最低）：** `npm run typecheck && npm test && npm run build` 全绿。UI 改了再加 `cd ui && npm run typecheck`。详见 [`rules/engineering.md`](./rules/engineering.md)。

## 不要做的事（红线，每条违反都有具体后果）

- ❌ 改默认 `audit.enabled` 为 true → 见 [`audit.md`](./rules/audit.md)
- ❌ 加 native deps（better-sqlite3、sharp 之类）→ 见 [`engineering.md`](./rules/engineering.md)
- ❌ 加 OpenClaw host 私有路径 import → 见 [`host-contract.md`](./rules/host-contract.md)
- ❌ 用 `@openclaw/` scope → 见 [`engineering.md`](./rules/engineering.md)
- ❌ 把 `/api/monitor/*` 权限放宽到 `write-default` 或更低 → 见 [`http-routes.md`](./rules/http-routes.md)
- ❌ 把 `/monitor/*` 静态 UI 改回 `auth: "gateway"`（浏览器永远 401）→ 见 [`http-routes.md`](./rules/http-routes.md)
- ❌ 在 `dependencies` 里加任何包（保持空）→ 见 [`engineering.md`](./rules/engineering.md)
- ❌ 修改 git config（用户级已配置，不动）
- ❌ commit message 加 `Co-Authored-By: Claude` 或 `🤖 Generated with Claude Code` footer → 见 [`workflow.md`](./rules/workflow.md)
- ❌ 在 `register(api)` 或 `service.start(ctx)` 自动写 `plugins.allow` 或 `hooks.allowConversationAccess` → 见 [`host-contract.md`](./rules/host-contract.md)
- ❌ 默认开启脱敏前直接捕获 prompt 内容并明文回显到外部日志

## 规则索引（按主题分文件，按需阅读）

| 文件 | 内容 | 关联决策块 |
|---|---|---|
| [`rules/host-contract.md`](./rules/host-contract.md) | 与 OpenClaw host 的接口契约：SDK barrel、hook 路线、register idempotency、runId 缓存、setup CLI、4 个内容审计触点 → hook 映射、Hook ctx 字段表 | #5 #6 #8 #10 #12 #13 #25 #33 #39 #43 #51 |
| [`rules/audit.md`](./rules/audit.md) | 内容审计 / conversation probe：opt-out、contentMaxBytes、groupBy=sessionKey、summarize 路径、findOrCreateRecord promote、UTF-8 truncate、abandoned sweeper、conversation store 索引 | #16 #17 #18 #30 #34(v0.9.3) #34(v0.9.2) #41 #46 #49 |
| [`rules/pipeline.md`](./rules/pipeline.md) | aggregator + storage + logs：sessionsAlerted 口径、replay 分批、Window P95、ring-buffer capturedAt、computeWindow 不能 break、Logs 页是事件流、误导性事件 | #14 #15 #32 #33(v0.9.2) #44 #45 |
| [`rules/cost.md`](./rules/cost.md) | token + cost：llm_output 走法、llm.tokens.recorded、daily-cost 文件 per day、totalTokens 含义、supportsUsageInStreaming 卡点、readDay cost truthy | #24 #26 #27 #28 #29 #38 |
| [`rules/alerts.md`](./rules/alerts.md) | 告警引擎：in-process setInterval、DingTalk 签名、windows snapshot 评估、UI 只读、url-guard SSRF 防护、reentrancy guard | #20 #21 #22 #23 #31 #36 #37 #47 #48 |
| [`rules/http-routes.md`](./rules/http-routes.md) | HTTP / SSE / Static UI：HashRouter、auth 两类、SSE fetch reader、EventBus atomic subscribe | #3 #7 #11 #50 |
| [`rules/ui.md`](./rules/ui.md) | UI 规则（dashboard 风格 + 可用性底线）+ UI 决策：PC 端、friendlyEntryLabel、webchat 含义、Channels 信息密度、Insights 只读、段名"消息发送方"、ConversationDetail 时间线、Layout 顶导、i18n 双补、internal trigger names | #19 #30(v0.8.3) #31(v0.8.4) #32(v0.9.0) #35(v0.9.2) #35(v0.9.3) #42 #55 #56 #57 |
| [`rules/engineering.md`](./rules/engineering.md) | 工程基线：JSONL not SQLite、零运行时依赖、scope @vulcanen、import.meta.url、Lint/Prettier/CI、测试就近放、错误加 code、测试规约、命令清单、常见陷阱 | #1 #2 #4 #9 #52 #53 #54 |
| [`rules/workflow.md`](./rules/workflow.md) | 工作流约束：48h 上游版本检查、文档维护元规则细节、边界外、参考路径 | #40 |

**约定**：决策块编号是**全局唯一序列**，跨文件不重号；新决策续到 #58、#59… 文件归属看主题。若发现历史编号重复（30-35 在 v0.8.x 与 v0.9.2 间有两批），引用时用 "决策 #30 (v0.8.3)" 加版本区分。

## 边界外的事

- **修改 OpenClaw host 行为** → 不在本仓库做，去 OpenClaw 官方仓库提 PR
- **加新的 host hook** → 同上，host 维护者决定
- **改 ClawHub / npm 私库设置** → 找运维 / DBA

## 参考路径

- OpenClaw 官方仓库的本地源码 checkout（路径因人而异，由开发者自行 clone 对应 `2026.5.7` 标签到任意目录）：验证 host 行为时去读源码，不要改它。引用 host 源码用项目内相对路径（如 `src/infra/diagnostic-events.ts:803-810`），不要写绝对路径。
- 公开 SDK 类型：`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts`、`node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts`。
