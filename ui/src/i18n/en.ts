import type { Strings } from "./zh.js";

export const en: Strings = {
  // Navigation
  "nav.overview": "Overview",
  "nav.sources": "Sources",
  "nav.channels": "Channels",
  "nav.models": "Models",
  "nav.tools": "Tools",
  "nav.runs": "Runs",
  "nav.conversations": "Conversations",
  "nav.logs": "Logs",
  "nav.alerts": "Alerts",
  "nav.costs": "Costs",

  // Pagination
  "pagination.range": "{start}–{end} of {total}",
  "pagination.pageSize": "page size",
  "pagination.pageOf": "page {page} / {total}",
  "pagination.prev": "prev",
  "pagination.next": "next",

  // Costs (v0.8.0+)
  "costs.title": "Costs / Token Economics",
  "costs.subtitle": "currency: {currency} · sourced from the llm_output hook, gated by audit · refreshed {time}",
  "costs.range.today": "today (UTC)",
  "costs.range.thisWeek": "this week (UTC, since Monday)",
  "costs.range.thisMonth": "this month (UTC, since the 1st)",
  "costs.range.sinceStart": "since process start",
  "costs.stat.tokensTotal": "{value} tokens",
  "costs.chart.last30d": "daily cost · last 30 days",
  "costs.section.byModel": "by provider / model",
  "costs.section.byChannel": "by channel",
  "costs.section.bySource": "by entry source",
  "costs.col.calls": "calls",
  "costs.col.tokensIn": "tokens in",
  "costs.col.tokensOut": "tokens out",
  "costs.col.cost": "cost",
  "costs.col.model": "provider / model",
  "costs.col.channel": "channel",
  "costs.col.source": "source",
  "costs.empty.dimension": "no data yet",
  "costs.empty.daily": "no daily cost data yet — run at least one model call",
  "costs.notice.noPricing": "tokens recorded but the price table is empty — every cost is 0",
  "costs.notice.noPricingHint":
    "Add your provider/model entries to plugins.entries.openclaw-monitor.config.pricing.models (per 1k tokens) in ~/.openclaw/openclaw.json, then restart the gateway.",
  "costs.notice.noTokens": "token data is 0 — the upstream provider isn't returning `usage` in its response",
  "costs.notice.noTokensHint":
    "Cost depends on the usage block (input/output/cacheRead/cacheWrite) surfaced by the llm_output hook. If your upstream LLM provider omits `usage` from the OpenAI-compatible response (some self-hosted gateways, proxies, or specific models do), this page will stay at 0. Verify the upstream response carries non-zero usage; if it goes through a proxy, the proxy may need to forward `usage` from the underlying model.",


  // Alerts (v0.7.0+)
  "alerts.title": "Alerts",
  "alerts.subtitle": "engine: {state} · {activeCount} active · {firedCount} fired in 24h",
  "alerts.state.running": "running",
  "alerts.state.disabled": "disabled",
  "alerts.disabled": "alert engine is disabled",
  "alerts.disabledHint":
    "Set alerts.enabled=true under plugins.entries.openclaw-monitor.config.alerts in ~/.openclaw/openclaw.json, add at least one channel and one rule, then restart the gateway.",
  "alerts.section.active": "active alerts",
  "alerts.section.rules": "rules",
  "alerts.section.history": "24h history",
  "alerts.history.note": "{firedCount} fired · {resolvedCount} resolved",
  "alerts.empty.active": "no active alerts",
  "alerts.empty.rules": "no rules configured",
  "alerts.empty.history": "no alert events in the last 24h",
  "alerts.col.id": "id",
  "alerts.col.name": "name",
  "alerts.col.severity": "severity",
  "alerts.col.rule": "rule",
  "alerts.col.channels": "channels",
  "alerts.col.status": "status",
  "alerts.col.value": "value",
  "alerts.col.firedAt": "first fired",
  "alerts.col.lastNotified": "last notified",
  "alerts.col.when": "when",
  "alerts.col.event": "event",
  "alerts.col.notifyResults": "delivery",
  "alerts.status.firing": "firing",
  "alerts.status.ok": "ok",

  // Sources
  "sources.title": "Sources",
  "sources.subtitle":
    "Traffic broken down by entry path (OpenAI API, Control UI, channel plugins)",
  "sources.rollup": "per-source rollup",
  "sources.col.source": "source",
  "sources.legend": "source id key",
  "sources.legend.id": "id",
  "sources.legend.meaning": "meaning",
  "sources.legend.openaiApi": "OpenAI-compatible API (/v1/chat/completions); callers are usually external apps",
  "sources.legend.controlUi": "OpenClaw built-in Control UI chat",
  "sources.legend.channelPlugin": "channel plugin entry (telegram / discord / feishu / ...); <name> is the channel id",

  // Top bar status / actions
  "status.idle": "idle",
  "status.live": "live · {count} events seen",
  "action.signOut": "sign out",
  "action.langSwitch": "中",

  // Token gate
  "tokenGate.title": "OpenClaw Monitor",
  "tokenGate.lead":
    "Paste your OpenClaw gateway operator token to access this dashboard. The token is stored only in your browser localStorage and added as Authorization: Bearer … to every API call from this page.",
  "tokenGate.help": "Find the token with: `openclaw config get gateway.auth.token`",
  "tokenGate.placeholder": "paste gateway token here",
  "tokenGate.inputLabel": "Gateway operator token",
  "tokenGate.submit": "unlock dashboard",
  "tokenGate.emptyError": "token cannot be empty",
  "tokenGate.rejectedError": "token rejected (401) — please re-enter",

  // Common
  "common.loading": "loading…",
  "common.noData": "no data",
  "common.refresh": "refresh",
  "common.any": "any",
  "common.back": "← back",
  "common.truncated": "truncated",
  "common.preview": "preview",

  // Empty / error states
  "empty.errors": "no errors recorded",
  "empty.dataYet": "no data captured yet",
  "empty.logs": "no log records buffered",
  "empty.runs": "no runs match",
  "empty.history": "(no history captured)",
  "empty.input": "(no input)",
  "empty.output": "(no output)",

  // Stat & chart labels
  "stat.modelCalls1m": "model calls (1m)",
  "stat.errorRate5m": "error rate (5m)",
  "stat.modelP955m": "model p95 (5m)",
  "stat.sessionAlerts15m": "session alerts (15m)",
  "stat.errors": "{count} errors",
  "stat.errorRateDetail": "{errors}/{total}",
  "stat.latency": "latency",
  "chart.eventsLast15m": "events / 10s · last 15m",
  "chart.modelCallsLast15m": "model calls / 10s · last 15m",
  "chart.modelErrorsLast15m": "model errors / 10s · last 15m",
  "chart.toolExecsLast15m": "tool execs / 10s · last 15m",
  "chart.toolErrorsLast15m": "tool errors + blocks / 10s · last 15m",
  "chart.messagesLast15m": "messages delivered / 10s · last 15m",
  "chart.loadFailed": "series load failed: {error}",

  // Overview
  "overview.title": "Overview",
  "overview.subtitle": "snapshot generated {time} · {bufferedEvents} events buffered",
  "overview.recentErrors": "recent errors",
  "overview.countsByType": "events by type · live counts",
  "overview.loadFailed": "overview load failed: {error}",
  "overview.col.type": "type",
  "overview.col.count": "count",

  // Channels
  "channels.title": "Channels",
  "channels.subtitle": "message delivery health by channel",
  "channels.rollup": "per-channel rollup",

  // Models
  "models.title": "Models",
  "models.subtitle": "model call breakdown by provider × model",
  "models.rollup": "per-model rollup",

  // Tools
  "tools.title": "Tools",
  "tools.subtitle": "tool execution top-N + blocked / errored counts",
  "tools.rollup": "per-tool rollup",

  // Runs list
  "runs.title": "Runs",
  "runs.subtitle":
    "harness runs · {active} active · drill into a run for full event timeline",
  "runs.filter.status": "status",
  "runs.status.all": "all",
  "runs.status.active": "active",
  "runs.status.completed": "completed",
  "runs.status.error": "error",
  "runs.col.runId": "run id",
  "runs.col.status": "status",
  "runs.col.channel": "channel",
  "runs.col.started": "started",
  "runs.col.duration": "duration",
  "runs.col.modelCalls": "model calls",
  "runs.col.toolExecs": "tool execs",

  // Run detail
  "runDetail.title": "run {runId}",
  "runDetail.summary": "summary",
  "runDetail.trace": "event trace ({count})",
  "runDetail.empty":
    "no events still buffered for this run · try drilling soon after run completion",
  "runDetail.row.status": "status",
  "runDetail.row.channel": "channel",
  "runDetail.row.session": "session",
  "runDetail.row.started": "started",
  "runDetail.row.ended": "ended",
  "runDetail.row.durationMs": "duration ms",
  "runDetail.row.modelCalls": "model calls",
  "runDetail.row.toolExecs": "tool execs",
  "runDetail.row.error": "error",
  "runDetail.col.time": "time",
  "runDetail.col.type": "type",
  "runDetail.col.payload": "payload",
  "runDetail.backToRuns": "← back to runs",

  // Dimension table
  "dim.col.total": "total",
  "dim.col.errors": "errors",
  "dim.col.errRate": "err rate",
  "dim.col.p50": "p50",
  "dim.col.p95": "p95",
  "dim.col.tokensIn": "tokens in",
  "dim.col.tokensOut": "tokens out",

  // Logs
  "logs.title": "Logs",
  "logs.subtitle":
    "redacted log records emitted via the diagnostic event bus · refreshes every 4s",
  "logs.filter.level": "level",
  "logs.filter.component": "component",
  "logs.filter.componentPlaceholder": "e.g. gateway",
  "logs.col.time": "time",
  "logs.col.level": "level",
  "logs.col.component": "component",
  "logs.col.message": "message",

  // Conversations list (M5)
  "conversations.title": "Conversations",
  "conversations.subtitle":
    "full content audit · {active} in flight · click a runId for details",
  "conversations.empty": "no conversations captured yet",
  "conversations.emptyHint":
    "OpenAI API and channel-plugin conversations carry full LLM content; Control UI and other internal paths can only be tracked at session-level (no body).",
  "conversations.optInHint":
    "If audit is not enabled yet: run `openclaw monitor setup --audit` on the gateway host then restart.",
  "conversations.col.runId": "run id",
  "conversations.col.status": "status",
  "conversations.col.channel": "channel",
  "conversations.col.started": "started",
  "conversations.col.duration": "duration",
  "conversations.col.hops": "hops",
  "conversations.col.tokensIn": "tokens in",
  "conversations.col.tokensOut": "tokens out",
  "conversations.col.preview": "preview",
  "conversations.session.runs": "{count} runs",
  "conversations.session.tokens": "{input} in / {output} out tokens",

  // Conversation detail (M5)
  "conversationDetail.title": "conversation {runId}",
  "conversationDetail.backToList": "← back to conversations",
  "conversationDetail.summary": "summary",
  "conversationDetail.row.status": "status",
  "conversationDetail.row.channelTrigger": "channel / trigger",
  "conversationDetail.row.started": "started",
  "conversationDetail.row.ended": "ended",
  "conversationDetail.row.durationMs": "duration ms",
  "conversationDetail.row.llmHops": "llm hops",
  "conversationDetail.section.inbound": "① project → OpenClaw",
  "conversationDetail.section.llmInput": "② OpenClaw → LLM",
  "conversationDetail.section.llmInputHop": "② OpenClaw → LLM (hop {n})",
  "conversationDetail.section.llmOutput": "③ LLM → OpenClaw",
  "conversationDetail.section.llmOutputHop": "③ LLM → OpenClaw (hop {n})",
  "conversationDetail.section.outbound": "④ OpenClaw → project",
  "conversationDetail.label.prompt": "prompt",
  "conversationDetail.label.system": "system",
  "conversationDetail.label.history": "session history ({count})",
  "conversationDetail.label.historyShort": "history ({count})",
  "conversationDetail.label.historyShowing": "showing {shown} of {total} messages",
  "conversationDetail.label.assistantText": "assistant text {n}",
  "conversationDetail.label.images": "{count} images",
  "conversationDetail.label.tokens": "in {input} / out {output}",
  "conversationDetail.empty.inbound":
    "(no inbound captured · before_prompt_build hook did not fire for this run)",
  "conversationDetail.empty.exchange": "(no llm_input / llm_output captured)",
  "conversationDetail.empty.outbound":
    "(no outbound captured · agent_end hook did not fire — likely abort/timeout)",
  "conversationDetail.row.success": "success",

  // Time series chart
  "chart.noData": "no data yet",
};
