# CLAUDE.md —— OpenClaw Monitor 插件认知文档

给 AI agent 看的项目共识文档。改动之前先读完这一页。**改动哪个层就要遵守哪个层的契约**，不要跨层猜测。

## 项目定位

- **是什么**：`@vulcanen/openclaw-monitor` 是一个 OpenClaw 5.7 插件，用 npm 私库分发。
- **解决什么**：OpenClaw 自身的诊断事件总线只对内可见，对运维是黑盒。这个插件把事件总线接出来，做聚合 / 持久化 / 实时推流 / 仪表板 / 内容审计。
- **不解决什么**：不替代 Prometheus / Grafana / OTel Collector。OpenClaw 已自带 `diagnostics-otel` 和 `diagnostics-prometheus` 两个导出器，本插件与它们并存。
- **不在范围**：不修改 OpenClaw core，不引入对其他 extension 私有 src/** 的依赖。
- **scope/registry**：`@vulcanen` scope，发布到 `https://registry.npmmirror.com/`。

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

## 关键工程决策（不要倒退）

1. **存储用 JSONL，不用 SQLite** —— OpenClaw 安装时强制 `--ignore-scripts`（[已验证](D:/projects/offical-openclaw/openclaw-2026.5.7/src/plugins/install.ts)），better-sqlite3 这类带 native postinstall 的包**装不上**。JSONL append-only + 按日期分文件，零原生依赖、retention 直接 `unlink` 旧文件。
2. **零运行时 npm 依赖** —— `package.json` 的 `dependencies: {}` 是空的。`openclaw` 是 devDependency（仅取类型，runtime 由 host 注入）。UI 的 React/Recharts 全部打进 `dist/ui/assets/index-*.js` 静态文件。这是为了避免 host 上任何 install-time 的依赖解析失败。
3. **HashRouter，不是 BrowserRouter** —— 静态 UI handler 不做 SPA fallback，所有客户端路由都在 hash 段（`#/overview`），后端不用感知。
4. **scope 用 `@vulcanen`，不要用 `@openclaw`** —— [install.ts:189](D:/projects/offical-openclaw/openclaw-2026.5.7/src/plugins/install.ts) 对 `@openclaw/*` 有特殊"trusted official prerelease"路径，会改变版本解析行为。
5. **公开 SDK 的 `onDiagnosticEvent` 单参** —— listener 签名是 `(evt) => void`，**没有 metadata**。只有 host 内部才有 `onInternalDiagnosticEvent` 的 metadata。任何想看 `trusted` 标记的代码都是错的。
6. **不直接 import `@openclaw/plugin-sdk`** —— 那个包是 host 私有的（`private: true, version: 0.0.0-private`）。外部插件依赖 `openclaw` 主包，从 `openclaw/plugin-sdk/<sub>` 子路径导入。
7. **HTTP 路由权限收敛到 `trusted-operator`** —— 所有 `/api/monitor/*` 与 `/monitor/*` 路由都用 `auth: "gateway"` + `gatewayRuntimeScopeSurface: "trusted-operator"`，不要降级。
8. **M5 默认 opt-out** —— `audit.enabled: false`。改动 audit 模块时不要把默认改成 true，也不要在 audit 关闭时仍然写盘。
9. **路径解析用 `import.meta.url`** —— `static-ui.ts` 用 `path.dirname(fileURLToPath(import.meta.url))` 锚定 dist 目录，不要写死相对路径。

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
- ❌ 用 `@openclaw/` scope
- ❌ 把 HTTP 权限放宽到 `write-default` 或更低
- ❌ 在 `dependencies` 里加任何包（保持空）
- ❌ 修改 git config（`user.email` / `user.name` 用户级已配置，不动）
- ❌ 默认开启脱敏前直接捕获 prompt 内容并明文回显到外部日志

## 边界外的事

如果改动需要：
- **修改 OpenClaw host 行为** → 不在本仓库做，去 OpenClaw 官方仓库提 PR
- **加新的 host hook** → 同上，host 维护者决定
- **改 ClawHub / npm 私库设置** → 找运维 / DBA

## 参考路径

OpenClaw 官方仓库本地 checkout：`D:\projects\offical-openclaw\openclaw-2026.5.7`，验证 host 行为时去这里读源码（不要改它）。

公开 SDK 类型：`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts`、`node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts`。
