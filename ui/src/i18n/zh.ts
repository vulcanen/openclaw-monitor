export const zh = {
  // Navigation
  "nav.overview": "总览",
  "nav.sources": "来源",
  "nav.channels": "通道",
  "nav.models": "模型",
  "nav.tools": "工具",
  "nav.runs": "运行",
  "nav.conversations": "对话",
  "nav.logs": "日志",

  // Sources
  "sources.title": "来源",
  "sources.subtitle": "按入口路径分类的流量统计（OpenAI API、Control UI、各 channel 插件）",
  "sources.rollup": "来源维度统计",
  "sources.col.source": "来源",
  "sources.legend": "来源标识说明",
  "sources.legend.id": "标识",
  "sources.legend.meaning": "含义",
  "sources.legend.openaiApi": "OpenAI 兼容 API（/v1/chat/completions），调用方多为外部项目",
  "sources.legend.controlUi": "OpenClaw 内置 Control UI 聊天",
  "sources.legend.channelPlugin": "channel 插件入口（如 telegram / discord / feishu），<name> 为具体通道名",

  // Top bar status / actions
  "status.idle": "空闲",
  "status.live": "实时 · 已采集 {count} 条事件",
  "action.signOut": "退出",
  "action.langSwitch": "EN",

  // Token gate
  "tokenGate.title": "OpenClaw Monitor",
  "tokenGate.lead":
    "粘贴 OpenClaw gateway operator token 进入面板。token 仅保存在浏览器 localStorage 中，每次 API 请求自动附加 Authorization: Bearer … 头。",
  "tokenGate.help": "用 `openclaw config get gateway.auth.token` 查看 token",
  "tokenGate.placeholder": "在此粘贴 gateway token",
  "tokenGate.submit": "解锁仪表板",
  "tokenGate.emptyError": "token 不能为空",
  "tokenGate.rejectedError": "token 已失效 (401) — 请重新输入",

  // Common
  "common.loading": "加载中…",
  "common.noData": "暂无数据",
  "common.refresh": "刷新",
  "common.any": "任意",
  "common.back": "← 返回",
  "common.truncated": "已截断",
  "common.preview": "预览",

  // Empty / error states
  "empty.errors": "暂无错误记录",
  "empty.dataYet": "暂未采集到数据",
  "empty.logs": "暂未缓冲日志记录",
  "empty.runs": "没有匹配的运行",
  "empty.history": "(未捕获到 history)",
  "empty.input": "(无输入)",
  "empty.output": "(无输出)",

  // Stat & chart labels
  "stat.modelCalls1m": "模型调用 (1m)",
  "stat.errorRate5m": "错误率 (5m)",
  "stat.modelP955m": "模型 P95 (5m)",
  "stat.sessionAlerts15m": "会话告警 (15m)",
  "stat.errors": "{count} 个错误",
  "stat.errorRateDetail": "{errors}/{total}",
  "stat.latency": "延迟",
  "chart.eventsLast15m": "事件 / 10s · 近 15m",
  "chart.modelCallsLast15m": "模型调用 / 10s · 近 15m",
  "chart.modelErrorsLast15m": "模型错误 / 10s · 近 15m",
  "chart.toolExecsLast15m": "工具执行 / 10s · 近 15m",
  "chart.toolErrorsLast15m": "工具错误+阻塞 / 10s · 近 15m",
  "chart.messagesLast15m": "消息送达 / 10s · 近 15m",
  "chart.loadFailed": "时序加载失败：{error}",

  // Overview
  "overview.title": "总览",
  "overview.subtitle": "快照生成于 {time} · 缓冲事件 {bufferedEvents} 条",
  "overview.recentErrors": "最近错误",
  "overview.countsByType": "事件类型计数 · 实时",
  "overview.loadFailed": "总览加载失败：{error}",
  "overview.col.type": "类型",
  "overview.col.count": "计数",

  // Channels
  "channels.title": "通道",
  "channels.subtitle": "按通道汇总的消息送达健康度",
  "channels.rollup": "通道维度统计",

  // Models
  "models.title": "模型",
  "models.subtitle": "按 provider × model 的调用分布",
  "models.rollup": "模型维度统计",

  // Tools
  "tools.title": "工具",
  "tools.subtitle": "工具执行 Top-N 与阻塞/错误次数",
  "tools.rollup": "工具维度统计",

  // Runs list
  "runs.title": "运行",
  "runs.subtitle": "harness 运行 · {active} 个进行中 · 点 runId 查看完整事件 trace",
  "runs.filter.status": "状态",
  "runs.status.all": "全部",
  "runs.status.active": "进行中",
  "runs.status.completed": "已完成",
  "runs.status.error": "出错",
  "runs.col.runId": "run id",
  "runs.col.status": "状态",
  "runs.col.channel": "通道",
  "runs.col.started": "开始时间",
  "runs.col.duration": "耗时",
  "runs.col.modelCalls": "模型调用",
  "runs.col.toolExecs": "工具执行",

  // Run detail
  "runDetail.title": "运行 {runId}",
  "runDetail.summary": "概要",
  "runDetail.trace": "事件 trace ({count})",
  "runDetail.empty": "暂无该 run 的事件缓冲——请在运行结束后立即下钻",
  "runDetail.row.status": "状态",
  "runDetail.row.channel": "通道",
  "runDetail.row.session": "session",
  "runDetail.row.started": "开始",
  "runDetail.row.ended": "结束",
  "runDetail.row.durationMs": "耗时 (ms)",
  "runDetail.row.modelCalls": "模型调用",
  "runDetail.row.toolExecs": "工具执行",
  "runDetail.row.error": "错误",
  "runDetail.col.time": "时间",
  "runDetail.col.type": "类型",
  "runDetail.col.payload": "数据",
  "runDetail.backToRuns": "← 返回运行列表",

  // Dimension table
  "dim.col.total": "总数",
  "dim.col.errors": "错误",
  "dim.col.errRate": "错误率",
  "dim.col.p50": "p50",
  "dim.col.p95": "p95",
  "dim.col.tokensIn": "输入 token",
  "dim.col.tokensOut": "输出 token",

  // Logs
  "logs.title": "日志",
  "logs.subtitle": "经过脱敏的诊断事件日志记录 · 每 4 秒刷新一次",
  "logs.filter.level": "级别",
  "logs.filter.component": "组件",
  "logs.filter.componentPlaceholder": "如 gateway",
  "logs.col.time": "时间",
  "logs.col.level": "级别",
  "logs.col.component": "组件",
  "logs.col.message": "消息",

  // Conversations list (M5)
  "conversations.title": "对话审计",
  "conversations.subtitle":
    "完整对话内容审计 · {active} 个进行中 · 点 runId 进入详情",
  "conversations.empty": "暂未捕获到对话",
  "conversations.emptyHint":
    "OpenAI API、channel 插件的对话会带完整 LLM 内容；Control UI 等内部路径只能记录会话维度信息（无原文）。",
  "conversations.optInHint":
    "如果还没启用审计：在 OpenClaw 主机执行 `openclaw monitor setup --audit` 然后重启 gateway。",
  "conversations.col.runId": "run id",
  "conversations.col.status": "状态",
  "conversations.col.channel": "通道",
  "conversations.col.started": "开始时间",
  "conversations.col.duration": "耗时",
  "conversations.col.hops": "跳数",
  "conversations.col.tokensIn": "输入 token",
  "conversations.col.tokensOut": "输出 token",
  "conversations.col.preview": "预览",
  "conversations.session.runs": "{count} 次运行",
  "conversations.session.tokens": "{input} 入 / {output} 出 token",

  // Conversation detail (M5)
  "conversationDetail.title": "对话 {runId}",
  "conversationDetail.backToList": "← 返回对话列表",
  "conversationDetail.summary": "概要",
  "conversationDetail.row.status": "状态",
  "conversationDetail.row.channelTrigger": "通道 / 触发",
  "conversationDetail.row.started": "开始",
  "conversationDetail.row.ended": "结束",
  "conversationDetail.row.durationMs": "耗时 (ms)",
  "conversationDetail.row.llmHops": "LLM 跳数",
  "conversationDetail.section.inbound": "① 项目 → OpenClaw",
  "conversationDetail.section.llmInput": "② OpenClaw → LLM",
  "conversationDetail.section.llmInputHop": "② OpenClaw → LLM (第 {n} 跳)",
  "conversationDetail.section.llmOutput": "③ LLM → OpenClaw",
  "conversationDetail.section.llmOutputHop": "③ LLM → OpenClaw (第 {n} 跳)",
  "conversationDetail.section.outbound": "④ OpenClaw → 项目",
  "conversationDetail.label.prompt": "prompt",
  "conversationDetail.label.system": "system",
  "conversationDetail.label.history": "session history ({count})",
  "conversationDetail.label.historyShort": "history ({count})",
  "conversationDetail.label.historyShowing": "显示 {shown} / {total} 条消息",
  "conversationDetail.label.assistantText": "assistant 文本 {n}",
  "conversationDetail.label.images": "{count} 张图片",
  "conversationDetail.label.tokens": "输入 {input} / 输出 {output}",
  "conversationDetail.empty.inbound":
    "(未捕获到入站 · 该 run 没触发 before_prompt_build hook)",
  "conversationDetail.empty.exchange": "(未捕获到 llm_input / llm_output)",
  "conversationDetail.empty.outbound": "(未捕获到出站 · 该 run 没触发 agent_end hook — 可能被中断或超时)",
  "conversationDetail.row.success": "成功",

  // Time series chart
  "chart.noData": "暂无数据",
};

export type StringKey = keyof typeof zh;
export type Strings = Record<StringKey, string>;
