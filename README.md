# OpenClaw Monitor

**English** | [中文](./README.zh-CN.md)

Real-time monitoring plugin for OpenClaw. Subscribes to the internal diagnostic event bus to roll up metrics, audit conversation content, surface a diagnostic event stream, and push threshold alerts; streams live events over SSE; ships a self-contained React dashboard (English / Chinese) — no external Grafana / Prometheus / OTel Collector required.

## Features

- **Overview**: 1m / 5m / 15m / 1h rolling windows for model calls, error rate, P95 latency, session alerts
- **Dimension rollups**: counts, error rate, token usage and latency quantiles broken down by channel, provider × model, tool, and source (OpenAI-compat API / Control UI / channel plugins)
- **Run tracking**: harness run list with full event-trace drilldown for any single run
- **Diagnostic event stream**: every captured event rendered as a log line with an inferred severity (error / warn / info / debug); filterable by level, component substring, event type
- **Conversation audit** *(optional)*: list groups by `sessionKey` with collapsible panels; detail view is a **timeline of paired cards** — inbound / each LLM call (input + output in one card) / outbound / error sorted by capture time, **only rendering cards that have data**, half-captured hops show an inline diagnostic hint (1 MiB per-segment cap by default)
- **Alert engine** *(optional)*: periodically evaluates rolling-window metrics against threshold rules; on match, pushes to a generic webhook or DingTalk custom robot; supports cooldown and resolve notifications; active alerts / rule state / 24h history visible on the Alerts page
- **Cost / token economics** *(needs audit gate + upstream usage)*: configurable price table per provider/model (per 1k tokens for input / output / cacheRead / cacheWrite); rolling-window cost figures + persistent today / this-week / this-month / last-30-days totals (UTC); per-model / per-channel / per-source breakdown on the Costs page. Token figures come from the `llm_output` hook's `usage` block — if your upstream LLM provider doesn't return `usage` in its OpenAI-compat response, this page will stay at 0 (the Costs page detects and surfaces this).
- **Insights / Top-N drill-downs**: turns rolled-up metrics into clickable individuals — slowest `model.call.completed`, top conversations by token usage, error clusters by `provider × model × errorCategory`, per-tool failure-rate ranking; each row links into the Run Detail / Conversation Detail page. Time window selectable (15m / 1h / 6h / 24h).
- **Live stream**: SSE push at `/api/monitor/stream`, the dashboard subscribes automatically
- **Zero external dependencies**: JSONL files for persistence, partitioned by date with background retention; no native modules
- **i18n**: Chinese by default, switch to English with one click

## Compatibility

| Item | Requirement |
|---|---|
| OpenClaw host | `>=2026.5.7` |
| Plugin API | `>=2026.5.7` |
| Node | `>=22` |

## Install

On the host that runs the OpenClaw gateway:

```bash
openclaw plugins install npm:@vulcanen/openclaw-monitor
openclaw monitor setup --audit            # trust the plugin + enable content audit
openclaw gateway restart
```

Metrics / dashboard only, no content audit:

```bash
openclaw plugins install npm:@vulcanen/openclaw-monitor
openclaw monitor setup                    # without --audit
openclaw gateway restart
```

Check status anytime: `openclaw monitor status`

## Configuration

Full options with defaults (written to OpenClaw's `~/.openclaw/openclaw.json`):

```jsonc
{
  "plugins": {
    "allow": ["openclaw-monitor"],
    "entries": {
      "openclaw-monitor": {
        "hooks": {
          "allowConversationAccess": true   // host security gate: opens llm_input / llm_output / agent_end hooks
        },
        "config": {
          "buffer": { "maxPerType": 1024 },
          "storage": {
            "kind": "jsonl",                 // or "memory"
            "path": null                     // defaults to <stateDir>/openclaw-monitor
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
            "enabled": true,                 // on by default
            "contentMaxBytes": 1048576,      // per-segment cap (1 MiB, max 16 MiB)
            "retainDays": 3,                 // days of conversation JSONL kept
            "captureSystemPrompt": true
          },
          "pricing": {
            "currency": "CNY",               // free-form display unit; no FX conversion
            "models": {
              "qwen/qwen3-5-397b-a17b": { "input": 0.0008, "output": 0.002 },
              "openai/gpt-4":           { "input": 0.03,   "output": 0.06 },
              "anthropic/claude-3.5-sonnet": {
                "input": 0.003,
                "output": 0.015,
                "cacheRead": 0.0003,         // optional; defaults to `input`
                "cacheWrite": 0.00375        // optional; defaults to `input`
              }
            }
          },
          "alerts": {
            "enabled": false,                // off by default; requires channels + rules to activate
            "evaluationIntervalSec": 30,
            "channels": {
              "ops-webhook": {
                "kind": "webhook",
                "url": "https://example.com/alert-receiver"
              },
              "ops-dingtalk": {
                "kind": "dingtalk",
                "url": "https://oapi.dingtalk.com/robot/send?access_token=XXX",
                "secret": "SEC_xxx"          // optional, DingTalk HMAC-SHA256 signing secret
              }
            },
            "rules": [
              {
                "id": "model-errors-spike",
                "name": "LLM errors in 5m > 5",
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
                "name": "LLM P95 latency > 5s",
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

> The `openclaw monitor setup [--audit]` command writes `plugins.allow` and `hooks.allowConversationAccess`. These keys belong to the OpenClaw host security model and **cannot be auto-written by the plugin** — they require an explicit operator action.

## Dashboard

```
http://<gateway-host>:<port>/monitor/
```

First visit prompts for an OpenClaw gateway operator token (find it with `openclaw config get gateway.auth.token`). The token lives in browser localStorage and is attached as `Authorization: Bearer ...` on every subsequent API call. The language switch button is in the top-right corner.

## HTTP endpoints

All `/api/monitor/*` routes require `Authorization: Bearer <gateway-operator-token>`. The `/monitor/*` static assets are public (data endpoints stay protected).

| Path | Purpose |
|---|---|
| `GET /api/monitor/overview` | 4 rolling-window metrics + recent errors + counts by type |
| `GET /api/monitor/events?type=&limit=` | Raw event stream |
| `GET /api/monitor/health` | Health check |
| `GET /api/monitor/channels` | Per-channel call stats |
| `GET /api/monitor/models` | Per provider × model call stats + tokens |
| `GET /api/monitor/tools` | Per-tool execution stats |
| `GET /api/monitor/sources` | Stats grouped by entry source (openai-api / control-ui / channel:*) |
| `GET /api/monitor/runs?limit=` | Harness run list |
| `GET /api/monitor/runs/:runId` | Single-run detail + event trace |
| `GET /api/monitor/logs?level=&component=&type=` | Diagnostic event stream (filter by inferred level / component substring / event type) |
| `GET /api/monitor/series?metric=&windowSec=` | 10-second-bucket time series |
| `GET /api/monitor/stream` | SSE real-time event push |
| `GET /api/monitor/conversations?limit=&groupBy=sessionKey` | Conversation audit list; `groupBy=sessionKey` returns sessions-of-runs nested shape |
| `GET /api/monitor/conversations/:runId` | Full four-segment content of one conversation |
| `GET /api/monitor/alerts/rules` | Current alert rules + engine running state |
| `GET /api/monitor/alerts/active` | Currently firing alerts |
| `GET /api/monitor/alerts/history?limit=` | Last 24h of alert events (fired / renotified / resolved) |
| `GET /api/monitor/costs` | Cost snapshot: sinceStart / windows / today / thisWeek / thisMonth / 30-day daily trend + per model / channel / source breakdown |
| `GET /api/monitor/insights/slow-calls?windowSec=&limit=` | Slowest model.call.completed inside the window |
| `GET /api/monitor/insights/heavy-conversations?windowSec=&limit=` | Conversations ordered by total token usage |
| `GET /api/monitor/insights/error-clusters?windowSec=&limit=` | model.call.error clustered by provider × model × errorCategory |
| `GET /api/monitor/insights/tool-failures?windowSec=&limit=` | Per-tool failure count + rate |
| `GET /monitor/*` | Bundled dashboard |

## Known config notes for self-hosted LLM providers

### Costs page is stuck at 0 tokens — set `compat.supportsUsageInStreaming` on the model

OpenClaw transparently asks every OpenAI-compat upstream for streamed usage
(it pins `stream_options.include_usage: true` on every request — see host
`src/agents/openai-transport-stream.ts`). The problem is on the parser side:
when an OpenAI-compat provider has a baseUrl the host doesn't recognise
(any private gateway / vLLM / SGLang / TGI deployment of yours), host
`src/plugins/provider-model-compat.ts` defaults
`model.compat.supportsUsageInStreaming` to `false` — and the stream
reader silently **drops the final usage frame** the upstream actually
sent. Tokens and cost on the Monitor's Costs page stay at 0 forever.

Override the default per-model:

```jsonc
"models": {
  "providers": {
    "qwen": {
      "baseUrl": "http://your-internal-gateway/v1",
      "apiKey": "...",
      "api": "openai-completions",
      "models": [
        {
          "id": "qwen3-5-397b-a17b",
          "name": "Qwen 3.5",
          // ...existing fields...
          "compat": {
            "supportsUsageInStreaming": true
          }
        }
      ]
    }
  }
}
```

Restart the gateway. The Costs page should start showing tokens within a
few requests. If you also want money figures, fill in
`plugins.entries.openclaw-monitor.config.pricing.models["provider/model"]`
with per-1k-token rates.

How to verify the upstream itself is OK before blaming the host:

```bash
curl -s "$BASE_URL/chat/completions" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"...", "messages":[{"role":"user","content":"hi"}],
       "stream": true,
       "stream_options": {"include_usage": true}}'
```

If the last `data:` chunk before `[DONE]` contains a non-empty `"usage"`
object, the upstream is fine and you only need the `compat` flag above.

## Privacy and storage

- Content audit captures raw prompt / assistant text and may contain PII or business secrets; stored as plain-text JSONL — restrict operator access accordingly
- A single conversation runs ~1–50 KB (megabytes when full content is enabled); size your disk against your traffic; retention defaults to 3 days and is configurable
- The dashboard is gated to `trusted-operator`; **do not expose the OpenClaw gateway to the public internet**
- To turn content audit off entirely, set `config.audit.enabled` to `false`

## License

MIT — see [LICENSE](./LICENSE).
