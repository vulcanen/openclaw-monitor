# rules/alerts.md —— 告警引擎

`alerts/` 层职责：评估循环 + 通道分发 + SSRF 保护。**不依赖事件订阅**，只读 [`pipeline.md`](./pipeline.md) 的 windows snapshot。

数据流：定时器 tick → `aggregator.windows()` → 按 rule.metric 取值比阈值 → 与 active map 对比决定 fired/resolved → dispatcher 按 channel id 查 `alerts.channels` 字典异步发送。

## 关键工程决策

### 20. **告警引擎是 in-process setInterval，不持久化**（v0.7.0）

`src/alerts/engine.ts` 在插件进程内跑评估循环（默认 30s），状态机（活跃告警 Map + history ring buffer）**全在内存**，gateway 重启会丢。告警是运营信号不是审计日志，丢了再触发一次问题不大；持久化会引入 jsonl 双写复杂度。**channels 必须从 `alerts.channels` 字典里按 id 解析**（`dispatcher.ts: dispatchNotification`），不要让 rule 内嵌 URL，同一通道经常被多条 rule 复用。**evaluateNow** 是测试用同步入口，生产路径走 `start()` 定时器。`history` 保留 24h 或 200 条先到先除（`alerts/history.ts`）。

### 21. **DingTalk 签名实现位置固定**（v0.7.0）

`src/alerts/channels/dingtalk.ts: signRequest` 用 `node:crypto` 的 `createHmac("sha256", secret)`，格式严格按 DingTalk 文档（`timestamp + "\n" + secret` → base64-hmac-sha256 → URL encode）。任何"看起来等价"的改写（`\n` 换空格、base64 换 hex）会让钉钉返回 errcode=310000。测试固定在 `alert engine > dingtalk channel signs the request`。DingTalk 也支持"关键词"安全模式，所以 rule.name 默认拼进 markdown title —— 不要把 name 改成 emoji-only 或纯数字。

### 22. **alerts 评估只读 windows snapshot，不依赖事件**（v0.7.0）

rule 的 metric 字段对应 `WindowSnapshot` key（`src/types.ts`），engine 每 tick 调 `aggregator.windows()` 一次性拿全部窗口，按 rule 取值。**不要**改成订阅 fanout 或每条事件评估一次 —— 会丢失窗口聚合语义并卡 hot path。规则评估是异步 fire-and-forget，dispatcher 内部容错每个 channel 失败，永不向 engine.evaluate 抛错（否则 setInterval 吞异常静默挂死）。

### 23. **alerts UI 是只读列表**（v0.7.0）

`ui/src/pages/Alerts.tsx` 只渲染 rules / active / history 三个表，**不做 CRUD**。规则编辑唯一入口是 `~/.openclaw/openclaw.json`，改完重启 gateway。

### 31. **Webhook / DingTalk channel 默认拒绝私网 host**（v0.9.2）

`src/alerts/channels/url-guard.ts: assertSafeChannelUrl` 在 send 前 reject `127.x` `10.x` `172.16-31.x` `192.168.x` `169.254.x`（含 AWS / GCP metadata 169.254.169.254）`localhost` 以及 IPv6 loopback/ULA。channel config 加 `allowPrivateNetwork: true` 即 opt-out（自建内网 incident 接收器）。**不要**改成"trust 操作员就行" —— 开源后会被静态扫描器标红。schema 已加 `allowPrivateNetwork` 字段，README 安全章节会提。

### 36. **`url-guard` 不能只用字符串 regex 挡 IPv6 嵌入 IPv4**（v0.9.3 SSRF）

WHATWG URL parser 把 `[::ffff:127.0.0.1]` 归一化成 `[::ffff:7f00:1]`、`[::127.0.0.1]` 归一成 `[::7f00:1]` —— dotted-quad 从 `.hostname` 完全消失。`/^127\./` / `/^10\./` 全部 miss。**正确做法**：`src/alerts/channels/url-guard.ts: embeddedIPv4(host)` 用 `node:net.isIPv6` 验证后，根据 `::ffff:` / `::` 前缀提取后 32 bit 还原 IPv4 dotted-quad，再跑 `LITERAL_PRIVATE_HOST`。后续往 LITERAL_PRIVATE_HOST 加 IPv6 模式徒劳（hostname 已归一化），扩展必须改 embeddedIPv4。回归 `service.test.ts > "url-guard rejects IPv6-mapped IPv4 loopback"`。

### 37. **告警 engine 的 setInterval 必须自带 reentrancy 闸门**（v0.9.3）

`alerts/engine.ts: start()` 的 setInterval 回调不会因前一次 `evaluate()` Promise 没 resolve 就跳过 —— 在多 rule × 多 channel × 10s timeout 极端下两次 tick 可能并发，同时看到 `activeByRuleId.get(ruleId) === undefined`，对同一规则各发一份 "fired" 通知（违反 cooldown）。闸门变量 `let evaluating = false;` 在回调开头 check/set，`.finally` 复位。**不要**改成"每 tick 异步 fire-and-forget evaluate 多次"。

### 47. **`AlertEngine.evaluateNow` 也要 reentrancy guard**（v0.9.6 — 决策 #37 补全）

v0.9.3 只在 `start()` setInterval 路径加了 `evaluating` 标志。`evaluateNow()` 是测试入口、未来手动触发评估 REST 端点也会调它 —— 若一 tick 没 resolve 时 evaluateNow 被并发调用，两路看见 `previous=undefined`，对同一 rule 各发一份 "fired"。修复 evaluateNow 复用同一 `evaluating` 变量。**不要**给 evaluateNow 单独搞一个标志 —— 必须和 setInterval 共享。

### 48. **`url-guard` IPv4 patterns 只对解析成 IPv4 的 host 生效**（v0.9.6 修 pre-existing）

决策 #36 修了 IPv6 嵌入 IPv4，但 IPv4 patterns 写成 `/^127\./` 等文字模式，会把 `127.example.com` / `10gen.net` 当 loopback / RFC1918 一起拒掉 —— 合法外部 webhook 打不通。修复 `url-guard.ts` 拆两组：

- `LITERAL_PRIVATE_HOST`（localhost、IPv6 前缀）对原始 host 匹配
- `IPV4_PRIVATE_PATTERN`（`/^127\./` `/^10\./` 等 + 新增 `/^0\./` 覆盖 0.0.0.0/8）**仅当 `isIPv4(host) === true` 时**才匹配
- embeddedIPv4 路径同步走 IPv4 表

回归 `"url-guard does not over-match domains that look like IPv4 prefixes"` 与 `"url-guard rejects the entire 0.0.0.0/8 range"`。**不要**把 IPv4 patterns 改回直接 test 任意字符串。
