# OpenClaw Monitor

OpenClaw 实时监控插件。订阅 OpenClaw 内部诊断事件总线，做指标聚合、对话内容审计与日志记录；通过 SSE 提供实时事件流，并内置一个 React 仪表板（中英文）开箱即用——不依赖任何外部 Grafana / Prometheus / OTel Collector。

## 功能

- **总览**：1m / 5m / 15m / 1h 滑动窗口的模型调用量、错误率、P95 延迟、会话告警
- **维度统计**：按 channel、provider × model、tool 维度的调用计数、错误率、token 用量、耗时分位
- **运行追踪**：harness 运行列表 + 单次运行完整事件 trace 下钻
- **日志**：脱敏后的诊断日志，可按 level / component 过滤
- **对话内容审计** *(可选)*：抓取一次对话的四段：项目 → OpenClaw → LLM → OpenClaw → 项目；支持多跳 LLM 调用；通过 OpenClaw 标准 hook 接入，对 Control UI 和 OpenAI 兼容 API 路径都生效
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
            "enabled": true,                 // 默认开（v0.4.0+）
            "contentMaxBytes": 16384,        // 单条文本超过即截断
            "retainDays": 3,                 // 对话 JSONL 保留天数
            "captureSystemPrompt": true
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
| `GET /api/monitor/channels` | 每通道消息统计 |
| `GET /api/monitor/models` | 每 provider × model 调用统计 + token |
| `GET /api/monitor/tools` | 每 tool 执行统计 |
| `GET /api/monitor/runs?limit=` | harness 运行列表 |
| `GET /api/monitor/runs/:runId` | 单次运行详情 + 事件 trace |
| `GET /api/monitor/logs?level=&component=` | 脱敏日志记录 |
| `GET /api/monitor/series?metric=&windowSec=` | 10 秒粒度时序数据 |
| `GET /api/monitor/stream` | SSE 实时事件推送 |
| `GET /api/monitor/conversations?limit=` | 对话审计列表 |
| `GET /api/monitor/conversations/:runId` | 单次对话四段视图 |
| `GET /monitor/*` | 内置仪表板 |

## 隐私与存储

- 内容审计抓取的是原始 prompt / assistant 文本，可能含 PII / 业务密钥；落盘为明文 JSONL，请控制运维角色访问
- 单条对话约 1–50 KB，按业务流量估算容量；retention 默认 3 天可调
- 仪表板限定 `trusted-operator` 权限，**不要把 OpenClaw gateway 暴露公网**
- 不需要内容审计时，将 `config.audit.enabled` 设为 `false` 即可关闭

## 许可

UNLICENSED
