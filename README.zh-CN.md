# OpenClaw Monitor

[English](./README.md) | **中文**

OpenClaw 实时监控插件。订阅 OpenClaw 内部诊断事件总线，做指标聚合、对话内容审计与日志记录；通过 SSE 提供实时事件流，并内置一个 React 仪表板（中英文）开箱即用——不依赖任何外部 Grafana / Prometheus / OTel Collector。

## 功能

- **总览**：1m / 5m / 15m / 1h 滑动窗口的模型调用量、错误率、P95 延迟、会话告警
- **维度统计**：按 channel、provider × model、tool、入口来源（OpenAI 兼容 API / Control UI / channel 插件）维度的调用计数、错误率、token 用量、耗时分位
- **运行追踪**：harness 运行列表 + 单次运行完整事件 trace 下钻
- **诊断事件流**：每条捕获事件按推断的严重度（error / warn / info / debug）展示，支持按 level、component 子串、event type 过滤
- **对话内容审计** *(可选)*：抓取一次对话的四段：项目 → OpenClaw → LLM → OpenClaw → 项目，支持多跳 LLM 调用；列表按 sessionKey 折叠分组，详情页完整展示 prompt / 响应文本（默认 1 MiB 上限）
- **告警引擎** *(可选)*：定时评估滑动窗口指标（错误率、P95 延迟、调用量等），命中阈值时推送到通用 webhook 或钉钉自定义机器人；带冷却 + 恢复通知；活跃告警 / 规则状态 / 24h 历史在 Alerts 页查看
- **成本 / Token 经济学** *(需要 audit 安全门 + 上游返回 usage)*：按 provider/model 配置价格表（input/output/cacheRead/cacheWrite per 1k tokens）；滑动窗口实时成本 + 今日 / 本周 / 本月 / 近 30 天的持久化日级累计 (UTC)；按 model / channel / source 拆分。Token 数据来自 `llm_output` hook 的 `usage` 字段——如果上游 LLM provider 在 OpenAI 兼容响应里不返回 usage（部分自建网关 / 代理会忽略），Costs 页会一直为 0（页面会自动检测并提示）
- **实时流**：SSE 推送 `/api/monitor/stream`，仪表板自动订阅
- **零外部依赖**：JSONL 文件持久化，按日期分区 + 后台 retention，无原生模块
- **i18n**：中文默认，可一键切英文

## 兼容性

| 项 | 要求 |
|---|---|
| OpenClaw host | `>=2026.5.7` |
| Plugin API | `>=2026.5.7` |
| Node | `>=22` |

## 安装

在部署 OpenClaw 的主机上：

```bash
openclaw plugins install npm:@vulcanen/openclaw-monitor
openclaw monitor setup --audit            # 信任插件 + 启用内容审计
openclaw gateway restart
```

仅启用指标 / 仪表板，不启用内容审计：

```bash
openclaw plugins install npm:@vulcanen/openclaw-monitor
openclaw monitor setup                    # 不带 --audit
openclaw gateway restart
```

随时查看状态：`openclaw monitor status`

## 配置

完整配置项及默认值（写入 OpenClaw 的 `~/.openclaw/openclaw.json`）：

```jsonc
{
  "plugins": {
    "allow": ["openclaw-monitor"],
    "entries": {
      "openclaw-monitor": {
        "hooks": {
          "allowConversationAccess": true   // host 安全门：放行 llm_input / llm_output / agent_end hook
        },
        "config": {
          "buffer": { "maxPerType": 1024 },
          "storage": {
            "kind": "jsonl",                 // 或 "memory"
            "path": null                     // 默认 <stateDir>/openclaw-monitor
          },
          "retention": {
            "eventsDays": 7,
            "runsDays": 90
          },
          "stream": {
            "maxSubscribers": 16,
            "heartbeatMs": 15000
          },
          "audit": {
            "enabled": true,                 // 默认开
            "contentMaxBytes": 1048576,      // 单条文本上限（1 MiB，cap 16 MiB）
            "retainDays": 3,                 // 对话 JSONL 保留天数
            "captureSystemPrompt": true
          },
          "pricing": {
            "currency": "CNY",               // 自由文本货币单位，不做汇率换算
            "models": {
              "qwen/qwen3-5-397b-a17b": { "input": 0.0008, "output": 0.002 },
              "openai/gpt-4":           { "input": 0.03,   "output": 0.06 },
              "anthropic/claude-3.5-sonnet": {
                "input": 0.003,
                "output": 0.015,
                "cacheRead": 0.0003,         // 可选；省略则用 input 价格
                "cacheWrite": 0.00375        // 可选；省略则用 input 价格
              }
            }
          },
          "alerts": {
            "enabled": false,                // 默认关。开启需同时配 channels 和 rules
            "evaluationIntervalSec": 30,
            "channels": {
              "ops-webhook": {
                "kind": "webhook",
                "url": "https://example.com/alert-receiver"
              },
              "ops-dingtalk": {
                "kind": "dingtalk",
                "url": "https://oapi.dingtalk.com/robot/send?access_token=XXX",
                "secret": "SEC_xxx"          // 可选，钉钉自定义机器人 HMAC-SHA256 签名密钥
              }
            },
            "rules": [
              {
                "id": "model-errors-spike",
                "name": "LLM 调用 5m 内错误数 > 5",
                "metric": "modelErrors",
                "window": "5m",
                "op": ">",
                "threshold": 5,
                "severity": "error",
                "cooldownSec": 600,
                "channels": ["ops-webhook", "ops-dingtalk"]
              },
              {
                "id": "model-p95-too-slow",
                "name": "LLM P95 延迟 > 5s",
                "metric": "modelP95Ms",
                "window": "5m",
                "op": ">",
                "threshold": 5000,
                "severity": "warn",
                "cooldownSec": 300,
                "channels": ["ops-webhook"]
              }
            ]
          }
        }
      }
    }
  }
}
```

> `openclaw monitor setup [--audit]` 命令会自动写入 `plugins.allow` 和 `hooks.allowConversationAccess`。这两个键由 OpenClaw host 安全模型管理，**不能由插件自动写盘**——必须由操作者显式触发。

## 仪表板

```
http://<gateway-host>:<port>/monitor/
```

首次进入会提示输入 OpenClaw gateway operator token（可用 `openclaw config get gateway.auth.token` 获取）。Token 仅存浏览器 localStorage，后续 API 请求自动附 `Authorization: Bearer ...` 头。右上角可切换中 / EN。

## HTTP 端点

所有 `/api/monitor/*` 路由均需 `Authorization: Bearer <gateway-operator-token>`；`/monitor/*` 静态资源公开（数据接口仍受保护）。

| 路径 | 用途 |
|---|---|
| `GET /api/monitor/overview` | 4 个滑动窗口指标 + 错误列表 + 类型计数 |
| `GET /api/monitor/events?type=&limit=` | 原始事件流 |
| `GET /api/monitor/health` | 健康检查 |
| `GET /api/monitor/channels` | 每通道调用统计 |
| `GET /api/monitor/models` | 每 provider × model 调用统计 + token |
| `GET /api/monitor/tools` | 每 tool 执行统计 |
| `GET /api/monitor/sources` | 按入口来源（openai-api / control-ui / channel:*）统计 |
| `GET /api/monitor/runs?limit=` | harness 运行列表 |
| `GET /api/monitor/runs/:runId` | 单次运行详情 + 事件 trace |
| `GET /api/monitor/logs?level=&component=&type=` | 诊断事件流（按推断 level / 子串 component / event type 过滤） |
| `GET /api/monitor/series?metric=&windowSec=` | 10 秒粒度时序数据 |
| `GET /api/monitor/stream` | SSE 实时事件推送 |
| `GET /api/monitor/conversations?limit=&groupBy=sessionKey` | 对话审计列表（加 `groupBy=sessionKey` 返回按 session 分组的嵌套结构） |
| `GET /api/monitor/conversations/:runId` | 单次对话四段完整内容 |
| `GET /api/monitor/alerts/rules` | 当前生效的告警规则列表 + 引擎运行状态 |
| `GET /api/monitor/alerts/active` | 当前正在触发的告警 |
| `GET /api/monitor/alerts/history?limit=` | 最近 24h 告警事件（fired / renotified / resolved） |
| `GET /api/monitor/costs` | 成本快照：sinceStart / windows / 今日 / 本周 / 本月 / 近 30 天每日趋势 + 按 model / channel / source 拆分 |
| `GET /monitor/*` | 内置仪表板 |

## 隐私与存储

- 内容审计抓取的是原始 prompt / assistant 文本，可能含 PII / 业务密钥；落盘为明文 JSONL，请控制运维角色访问
- 单条对话约 1–50 KB（开启全量内容后可上到 MB 级），按业务流量估算容量；retention 默认 3 天可调
- 仪表板限定 `trusted-operator` 权限，**不要把 OpenClaw gateway 暴露公网**
- 不需要内容审计时，将 `config.audit.enabled` 设为 `false` 即可关闭

## 许可

MIT — 见 [LICENSE](./LICENSE)。
