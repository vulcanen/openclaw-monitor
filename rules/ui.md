# rules/ui.md —— UI 规则 + UI 决策

UI 是 React + Vite + Recharts 内置仪表板（`ui/`），GitHub 风 dark dashboard。**不换风格**，在风格 token 系统内迭代。**PC 端 dashboard，不做移动端**（决策 #19）。

## 设计 token（来自 `ui/src/styles.css:1-15`，唯一真源）

- **颜色**：`--bg #0e1117` / `--panel #161b22` / `--panel-2 #1c2230` / `--border #2a3142` / `--text #e6edf3` / `--text-dim #8b949e` / `--accent #58a6ff` / `--accent-2 #7ee787` / `--warn #f9b342` / `--error #ff7b72` / `--good #3fb950`
- **字体**：`--font` 系统无衬线（界面），`--mono` 等宽（数字、token、id、key、code）
- **字号阶**：page-title 20 / panel h3 13（uppercase + 0.04em letter-spacing）/ body 14 / table th 11 / mono code 12
- **圆角阶**：panel 8 / button & input 6 / tag 4 / token-gate-card 12

## 写 UI 时硬性遵守

1. **不写死颜色十六进制 / 字号** —— 都从 token 走（CSS var 或 `styles.css` 既有 class）。Recharts 等第三方需硬编码十六进制时，从 token hex 复制粘贴并加注释 `// matches --accent`。

2. **不要用 emoji 当 icon**。需要图标用 inline SVG（Heroicons / Lucide 的源）。能用文字 + tag 表达就别加图标。

3. **i18n 是硬约束** —— 任何用户可见的字符串经过 `t("ns.key")`，同步更新 `ui/src/i18n/zh.ts` 和 `en.ts`。一处忘掉，对应 locale 渲染原 key 字符串。详细回归手段见决策 #56。

4. **键盘 + 屏幕阅读器底线**（v0.6.3 加固）：
   - 所有 interactive 元素依赖 `:focus-visible` 全局样式（`styles.css` 顶部已有）。**不要**加 `outline: none` 关掉。觉得难看调 `outline-offset` 或 `outline-color`。
   - form input 必须 `<label>` 或 `aria-label` —— placeholder 不算 label（WCAG 3.3.2）。可视隐藏用 `<label className="sr-only">`。
   - icon-only 按钮 / 状态指示（`.dot` 类）`aria-label` 必填；纯装饰图形加 `aria-hidden="true"`。
   - 错误提示用 `role="alert"`（TokenGate 已示范）。
   - 不要用 `title=` 替代 label —— `title` 在 touch 设备和 SR 上都不可靠。

5. **PC 端 dashboard，不做移动端**（决策 #19）。目标视口 ≥ 1024px，主战场 1440 / 1920+。`styles.css` 只保留一档断点 `@media (max-width: 1100px)`，把 `grid.cols-4` 折叠到 2 列。**不要**新增 `< 720px` 特化布局，**不要**为触屏 / hamburger menu / mobile drawer 写代码。表格类靠 `.panel { overflow-x: auto }` 兜底横向滚动。

6. **table 行 hover 仅在整行可点时才用**。`table tbody tr:hover` 给整行变色 —— 让用户以为可点就必须真可点（包 `<Link>` 或 `onClick` + `cursor: pointer` + 键盘支持）。新加表格优先用 td 内 `<Link>` + 去掉 row hover。

7. **颜色不是唯一指示器**（WCAG 1.4.1）。`tag.ok/error/warn` 自带文本 OK；`StatCard` 的 `delta.good/.bad/.warn` 只是颜色 —— 真要传达严重度，加图标或前缀文字。

8. **图表统一用 Recharts**。颜色从 token 走，tooltip 背景 `#161b22` 边框 `#2a3142`（参考 `TimeSeriesChart.tsx`）。不要再引第二个图表库 —— bundle 已 ~600 KB。

9. **新加状态色**（info / muted）先看 token 是否已有；扩 token 比新增 hex 好。`accent-2` 当前用于 component 字段绿色，不要乱占。

10. **不要在 UI 里跑长任务** —— 5s polling 是上限，更频繁会冲 API。实时改用 SSE（`/api/monitor/stream`，已有 `openEventStream` 抽象）。

11. **`prefers-reduced-motion`**：新加 `transition` 或 `animation` 时必须包到 `@media (prefers-reduced-motion: no-preference)` 里，或在全局加 reduce 兜底（当前 styles.css 尚未加）。

12. **改完 UI 必须 `npm run build:ui`** —— 静态 handler 读 `dist/ui/index.html`，不重 build 浏览器看到的还是旧版。

## 关键工程决策

### 19. **PC 端 dashboard，不做移动端**（v0.6.3 确立）

详见上方 UI 规则 #5。目标视口 1024px+，`styles.css` 只保留 1100px 一档断点。任何后续 UI 重构若引入移动端布局，先回这里读。

### 30. **`webchat` 是 host 的 INTERNAL_MESSAGE_CHANNEL 常量，不是浏览器聊天**（v0.8.3 + v0.8.4）

OpenClaw `src/utils/message-channel-constants.ts:1` 把 "webchat" 当作"所有非 channel-plugin 入口"的统一标识，覆盖：`/v1/chat/completions`、Control UI 内置聊天、heartbeat / cron / webhook 内部触发。**channel 字段单独无法区分这些路径**。要区分必须用：

(a) runId 前缀：`chatcmpl_*` = OpenAI compat（host `openai-http.ts`），`ctrl_*` = Control UI（host `server-chat.ts`）；
(b) trigger：`channel-message` = audit 路径（conversation-probe 合成），`user/heartbeat/cron/webhook` = host 设的。

Host 实测对 OpenAI compat 和 Control UI 都设 trigger=user，所以**只靠 trigger 不可靠**，必须 runId 优先。共享逻辑：backend `pipeline/extractors.ts: extractSource`，UI `ui/src/entry-label.ts: inferEntryKey + friendlyEntryLabel`。**不要**让两地分别维护推断逻辑 —— 始终走 `ui/src/entry-label.ts` 共享 helper。

### 31. **Channels 页几乎没有信息密度，因为 host 都标 webchat**（v0.8.4）

channels 维度按 host channel 字段聚合，OpenClaw 默认配置下永远只有 "webchat" 一行。Channels 页已加 host 行为解释 hint，并把 "messages.delivered" 趋势图换成 "model.calls"（前者 trusted 且 hook 也很少 fire，永远空）。**真正运维使用场景是 Sources 页**（按 entry path 拆分）。改 Channels 时不要加 messages 相关 chart / 计数 —— 外部插件视角下那些 metric 只能拿到很少甚至 0 数据。

### 32. **Insights 是 read-only 个案下钻，不持久化**（v0.9.0）

`src/insights/queries.ts` 用既有 buffer（ring per type，默认 1024）+ audit conversation store 算 top-N。不新建 ring / 文件 / index —— 每次请求重新 filter+sort buffer。window 上限 24h，limit 上限 50。下游 (Run Detail / Conversation Detail) 直接 `<Link>` 跳。**不要**改成"自维护排行榜在 ingest 路径算" —— 那会让 hot path 多一遍 sort。Heavy-conversations 合并内存（`probe.recentCompleted`）+ 磁盘（`storeRef.list`），跟 Conversations 页同口径。Error-clusters / Tool-failures 用 `SAMPLE_RUN_IDS_PER_CLUSTER=5` 保留示例 runIds（UI 点链接跳 Run Detail）。windowSec 解析在 `insights/rest-routes.ts` 用 clampWindow / clampLimit 兜底非法值。

### 35. **UI 上所有显示 channel / source 字面值的位置必须经过 `friendlyEntryLabel`**（v0.9.2 之后强制规则）

禁止在 React 组件里直接渲染 `{r.channel}`、`{channelId}`、`{row.key}` 等 backend 原始字符串 —— 那是 host 内部 token（绝大多数就是 `"webchat"`），运维分不清入口路径，糟糕 UX。**统一做法**：

- 表格行 channel/source 列：`friendlyEntryLabel(t, inferEntryKey(channel, trigger, runId))` 或 `friendlyEntryLabel(t, key)`（key 是 backend `extractSource` 已派生）
- 原始 channel 值塞进 `title=` 作为 hover（参见 `Conversations.tsx: SessionRow` / `Insights.tsx` slow-calls 表）
- 新加 UI 表格若有 channel/source 列，第一件事是 import `friendlyEntryLabel`
- Backend REST 响应仍返回**原始技术 id**（`"webchat"` / `"openai-api"` / `"channel:telegram"`） —— 不要把翻译做到后端，那是 i18n 关心的事
- 当前覆盖 Conversations / Channels / Sources / Insights 四页。新增页面若展示 channel 字段没用 helper，**视为 review block**。

### 35. **对话详情段名一律用"消息发送方"，不是"项目"**（v0.9.3，与上条同号但版本不同）

插件是公开 npm 包，消息源不一定来自"项目"（可能是 Telegram / Discord / Control UI / OpenAI compat API client）。`ui/src/i18n/{zh,en}.ts` 的 `conversationDetail.section.*` 用 "消息发送方 → OpenClaw / OpenClaw → 消息发送方"（zh）/ "sender → OpenClaw / OpenClaw → sender"（en）。任何 UI 重构都不要回退到"项目 → OpenClaw"措辞。

### 42. **ConversationDetail 用时间线 + 配对卡片，不再用 4 段固定布局**（v0.9.5 重构）

4 段（sender→OpenClaw→LLM→OpenClaw→sender）固定结构的根本缺陷：每段独立，**没采到的事件渲染成空壳**视觉上像功能坏了；尤其 host 的 `llm_output` hook 在不少 provider / 配置下不 fire，section ③ 永久空白让人误以为是 bug。新设计 `ui/src/pages/ConversationDetail.tsx` 用 `buildTimeline()` 把 inbound / llmHop[i] / outbound / error 按 capturedAt 排序成时间线，**只渲染有数据的卡片**。LLM 调用的 input 和 output **配对在同一卡里**（一次 RTT 自然属于同一逻辑单元），多跳就是多张 LLM 卡。半捕获（有 input 没 output 或反之）内部用 `noOutput` / `noInput` 区块呈现，并附**诊断 hint**（三档：① host gate 没开 → `openclaw monitor setup --audit`；② 上游 stream 不返回 usage → `compat.supportsUsageInStreaming: true`；③ provider adapter 不 fire hook → 查 host 日志）。**不要**回退到固定段位布局 —— 半捕获的诊断价值都在 noOutput hint 里，被强制布局压回空壳就丢了。i18n key 在 `conversationDetail.timeline.*`。Marker 颜色 `MARKER_COLOR` 常量：inbound=`--text-dim` / llmHop=`--accent` / outbound=`--accent-2` / error=`--error`，不要乱占其他语义色。

### 55. **UI v0.9.7 增加 Layout 顶导分组 + 全局时间窗 + 健康横幅 + Sessions 页 + 行内可视化**

- **Layout 顶导**（`ui/src/components/Layout.tsx`）拆 4 组 (Status / Roll-ups / Drill-down / Audit) 用 `nav-divider` 分隔。`NAV_GROUPS` 是数组的数组，新加导航项加到对应组 —— **不要**回到平铺 11 项。
- **全局时间窗选择器** `ui/src/time-window.tsx`（TimeWindowProvider + useTimeWindow + ?window= URL hash 同步）。当前页面**没强制订阅** —— 接入时用 `useTimeWindow().window` + `WINDOW_TO_SECONDS[w]`。改 default 不要破坏 URL fallback。
- **Overview 健康横幅**（`Overview.tsx: HealthBanner`）合成 ok/warn/error 三档：error → `recentErrors>5 || errorRate5m>=20%`；warn → 任一阈值过半。阈值有意调宽避免一次 stray error 染红首页。
- **Overview lifecycle 第二排 stat card**：消费 [`host-contract.md`](./host-contract.md) 决策 #51 的合成事件 `session.lifecycle.*` / `agent.compaction.completed` / `tool.result.persisted` / `gateway.lifecycle.started`。读 `data.countsByType` —— 是 cumulative-since-start 视角，要"今日"需 backend 加日级 rollup（未做）。
- **Sessions 页**（`ui/src/pages/Sessions.tsx` + 路由 + nav）从 `/api/monitor/events?type=session.lifecycle.*` 拉两类事件 client-side 配对成 session 表。故意不加专门 REST 端点 —— backend 做的也是同样 match。需要 server-side 过滤/分页时再升级。
- **DimensionTable inline error-rate 横条**（`components/DimensionTable.tsx`）`.err-rate-bar` class 在 styles.css；惠及 Sources / Channels / Models / Tools 四页。不要改成单独 column。
- **Insights HeavyConversations 行内 mag-bar** 显示 tokens 占该页 max 的比例。
- **Costs byModel 上方 Recharts BarChart**（horizontal "share of cost"）。颜色硬编码 `#58a6ff` 旁带注释 `// matches --accent`（UI 规则 #1 允许此 token 同步注释）。
- **api.ts 增加 ApiError 类**，`usePolling` 用 `err.friendly()` 渲染；不再把原始 stack 字符串塞进 `.error-banner`。

### 56. **UI 新加的 i18n key 务必中英双补**（决策 #35 已强调，v0.9.7 再次踩到）

本轮加了 ~40 个新 key（`topbar.*` / `overview.health.*` / `overview.lifecycle.*` / `sessions.*` / `empty.*.hint.*` / `costs.notice.noTokensHint.*` / `alerts.col.ruleExpr` / `logs.filter.typePrefix` / `conversations.filter.*`），只在一边加的 key 缺失 locale 会渲染 raw key 字符串。**回归手段**：新 key 落地前在 `zh.ts` 与 `en.ts` grep 一遍 key 名确保两边都在。

### 57. **`extractSource` / `inferEntryKey` 把 host 字面 channel 中的 internal trigger 名当 internal**（v0.9.7.3）

host 在 heartbeat / cron / webhook 触发的 agent run 里把 `ctx.channelId` 设成**字面值**（`"heartbeat"` / `"cron"` / `"webhook"`）而非 INTERNAL_MESSAGE_CHANNEL (`"webchat"`)。原本 `extractSource` 看到非 webchat 直接 fall-through 到 `channel:<name>`，Sources 页把心跳分类成"Channel: heartbeat"，UX 像有个叫 heartbeat 的 channel 插件。修复：两个文件都加 `INTERNAL_TRIGGER_NAMES = new Set(["heartbeat", "cron", "webhook"])` 常量；channel 命中此集合时返回 `internal:<channel>`，绕过 channel:* 分支。**两份必须同时改**（决策 #35）：`pipeline/extractors.ts: extractSource` 与 `ui/src/entry-label.ts: inferEntryKey`。未来加新 internal trigger 名只改这两个常量。回归 `extractors.test.ts > "returns internal:<name> when the channel field is itself an internal trigger name"`。
