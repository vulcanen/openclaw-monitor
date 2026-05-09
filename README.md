# OpenClaw Monitor

**`@vulcanen/openclaw-monitor`** —— 自包含的 OpenClaw 实时监控插件。把 OpenClaw 内部的诊断事件总线、可观测指标、对话内容审计统一起来，提供 REST API + SSE 实时流 + 内置 React 仪表板。

## 项目现状

- 版本：`0.2.0`
- 适配 host：OpenClaw `>=2026.5.7`（`compat.pluginApi: ">=2026.5.7"`）
- 发布目标：公开 npm `https://registry.npmjs.org/`，scope `@vulcanen`（个人 scope）
- 安装侧默认走公司代理 `https://registry.npmmirror.com/`（已镜像 npmjs 上游，`@vulcanen/...` 也能拉到）
- 测试：18 个单元测试，全部通过
- 构建产物：~200 KB packed / ~730 KB unpacked，零运行时 npm 依赖（仅 `openclaw` 作为 devDependency 取类型）

## v0.2.0 新增

- **UI 浏览器可直接访问**：`/monitor/*` 静态资源公开，UI 自己处理 token（localStorage + Authorization 头），不再被 OpenClaw 的 trusted-operator 网关阻挡
- **零脚手架**：新增 `openclaw monitor setup [--audit]` CLI 命令，一行写好 `plugins.allow` 和（可选的）`hooks.allowConversationAccess` + `audit.enabled`
- **静默默认状态**：默认不注册 `llm_input/llm_output/agent_end` hook（消除 OpenClaw 的 "blocked" info 日志），仅在 `audit.enabled` + `allowConversationAccess` 同时为真时启用 M5

## 已实现功能

### M1 — 数据采集层
- 订阅 OpenClaw `onDiagnosticEvent` 全部 ~40 种事件
- 按事件类型环形缓冲（默认 1024 条/类型，热路径）
- 暴露 `/api/monitor/overview`、`/api/monitor/events`、`/api/monitor/health`

### M2 — 持久化与保留策略
- JSONL 文件按日期分区：`events-YYYY-MM-DD.jsonl`、`runs.jsonl`、`conversations-YYYY-MM-DD.jsonl`
- 后台定时清理过期文件（events 默认 7 天，runs 90 天，audit 3 天）
- **不使用 SQLite**（详情见 [CLAUDE.md](CLAUDE.md) 决策记录），零原生依赖

### M3 — 实时流 + 自包含仪表板
- SSE 推流：`/api/monitor/stream`（支持心跳、订阅上限保护）
- 内置 React 仪表板：访问 `/monitor` 即可，无需外部 Grafana / Prometheus
- 顶部状态条订阅 SSE，事件流入时自动转为绿色 live 指示

### M4 — 多维聚合
- 滑动窗口：1m / 5m / 15m / 1h
- 维度 rollup：每 channel / 每 provider×model / 每 tool
- Harness 运行追踪（active + recent + persisted）
- 时序数据：`/api/monitor/series?metric=&windowSec=`，10 秒粒度

### M5 — 内容审计（默认关闭，opt-in）
- 通过 4 个 hook 抓取一次对话的完整四段：
  1. `before_prompt_build` —— 项目 → OpenClaw（用户 prompt + 会话历史）
  2. `llm_input` —— OpenClaw → LLM（system prompt + prompt + history + 图片数）
  3. `llm_output` —— LLM → OpenClaw（assistant texts + token usage）
  4. `agent_end` —— OpenClaw → 项目（最终 messages + 状态）
- UI 侧四段式视图，多跳 LLM 调用平铺为 `hop 1`、`hop 2` …
- 默认未启用，必须在 OpenClaw config 显式打开 `audit.enabled: true`

## 安装与使用

### 部署侧（OpenClaw 主机）

```bash
# 1. 装插件
openclaw plugins install npm:@vulcanen/openclaw-monitor

# 2. 一键 setup（把自己加进 plugins.allow，消除安装后的警告）
openclaw monitor setup
# 想启用对话内容审计就加 --audit:
# openclaw monitor setup --audit

# 3. 重启
openclaw gateway restart

# 4. 验证
openclaw monitor status   # 看三个开关状态
openclaw plugins inspect openclaw-monitor --runtime --json
```

**打开浏览器**：`http://<gateway-host>:<port>/monitor/`

第一次进会看到 token 输入页（不再被 OpenClaw 网关 401），从 `openclaw config get gateway.auth.token` 拿到 token 粘进去就能用。Token 仅存浏览器 localStorage。

### 配置示例

```yaml
# OpenClaw config.yaml
plugins:
  openclaw-monitor:
    buffer:
      maxPerType: 1024
    storage:
      kind: jsonl              # 或 "memory"（不持久化）
      # path: 自定义路径（默认 <stateDir>/openclaw-monitor）
    retention:
      eventsDays: 7
      runsDays: 90
    stream:
      maxSubscribers: 16
      heartbeatMs: 15000
    audit:                     # 内容审计，默认全关
      enabled: false
      contentMaxBytes: 16384   # 单条文本超过即截断
      retainDays: 3
      captureSystemPrompt: false
```

## 暴露的 HTTP 路由

所有路由均挂在 OpenClaw Gateway 上，权限 `gateway` + `trusted-operator`：

| 路径 | 用途 |
|---|---|
| `GET /api/monitor/overview` | 4 个窗口指标快照 + 错误列表 + 类型计数 |
| `GET /api/monitor/events?type=&limit=` | 原始事件流 |
| `GET /api/monitor/health` | 健康检查 |
| `GET /api/monitor/channels` | 每通道消息统计 |
| `GET /api/monitor/models` | 每 provider×model 调用统计 + token |
| `GET /api/monitor/tools` | 每 tool 执行统计 |
| `GET /api/monitor/runs?limit=` | Harness 运行列表 |
| `GET /api/monitor/runs/:runId` | 单次运行详情 + 事件 trace |
| `GET /api/monitor/logs?level=&component=` | 脱敏日志记录 |
| `GET /api/monitor/series?metric=&windowSec=` | 时序数据（10 秒粒度） |
| `GET /api/monitor/stream` | SSE 实时事件推送 |
| `GET /api/monitor/conversations?limit=` | 对话审计列表（M5） |
| `GET /api/monitor/conversations/:runId` | 对话详情四段视图（M5） |
| `GET /monitor/*` | 内置 React 仪表板 |

## 开发

```bash
# 安装依赖（默认走公司代理，npmrc 已配置）
npm install
cd ui && npm install && cd ..

# 后端开发
npm run typecheck
npm test                      # 单元测试
npm run build:plugin          # tsc 编译

# UI 开发
cd ui
npm run dev                   # vite dev server，代理 /api/monitor 到 localhost:7042
npm run typecheck
npm run build                 # 输出到 ../dist/ui

# 一次性全量构建（plugin + UI）
npm run build

# 模拟发布产物
npm pack --dry-run
```

## 发布

```bash
# 1. 升版本号
npm version <patch|minor|major> --no-git-tag-version

# 2. 登录公开 npm（首次）
npm login --registry=https://registry.npmjs.org/

# 3. 发布（package.json 已锁定 publishConfig.registry，自动跑 prepublishOnly: clean + build + test）
npm publish
```

> 安装侧依然走公司代理 `registry.npmmirror.com`（在 `.npmrc` 配置），公司代理镜像了公开 npmjs 上游，因此发布到公开 npm 后内网仍能正常拉取 `@vulcanen/openclaw-monitor`。

## 注意事项

- **UI 静态文件公开 ≠ 数据公开**：`/monitor/*` HTML/JS/CSS 不需要 token 即可加载，但所有 `/api/monitor/*` 数据接口仍要 `Authorization: Bearer <gateway-token>`。没 token 的人能看到登录页但看不到任何数据
- **隐私边界**：M5 内容审计抓取的是原始 prompt 和 assistant 文本，可能含 PII / 业务密钥。落盘文件是明文 JSONL。
- **存储增长**：开启 audit 后，存储增长与对话量相关。预估每对话 1-50 KB，按业务流量估算容量。
- **多跳**：单次 OpenAI API 调用可能触发多次 `llm_input`/`llm_output`（agent 内部循环、tool use、failover）。UI 会平铺显示。
- **不要把 dashboard 暴露公网**：内置 UI 是给运维看的，请走 VPN / 内网访问。

## 目录结构

```
openclaw-monitor/
├── README.md                              本文件
├── CLAUDE.md                              给 AI agent 看的项目认知文档
├── package.json
├── openclaw.plugin.json                   OpenClaw 插件清单
├── tsconfig.json
├── vitest.config.ts
├── .npmrc                                 公司代理 registry（用于安装）
├── src/                                   插件后端（5 层架构）
│   ├── index.ts                           definePluginEntry 入口
│   ├── service.ts                         装配 + 注册路由
│   ├── types.ts
│   ├── service.test.ts
│   ├── probes/                            数据采集
│   ├── storage/                           持久化
│   ├── pipeline/                          聚合
│   ├── outlets/                           对外暴露
│   └── audit/                             M5 内容审计
└── ui/                                    React 仪表板（独立 Vite 项目）
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── api.ts
        ├── styles.css
        ├── hooks.ts
        ├── components/
        └── pages/
```

## License

UNLICENSED · 内部使用
