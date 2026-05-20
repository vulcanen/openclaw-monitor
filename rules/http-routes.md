# rules/http-routes.md —— HTTP / SSE / Static UI

`outlets/` 层职责：HTTP handler + SSE 总线 + 静态资源。**不直接读 host 事件总线**。

权限 / 安全有意分两类（数据接口锁 trusted-operator，静态 UI 允许公开浏览器导航后 UI 自管 token）。

## 关键工程决策

### 3. **HashRouter，不是 BrowserRouter**

静态 UI handler 不做 SPA fallback，客户端路由全在 hash 段（`#/overview`），后端不感知。

### 7. **HTTP 路由权限分两类**

- `/api/monitor/*`（数据接口）：`auth: "gateway"` + `gatewayRuntimeScopeSurface: "trusted-operator"`，**不要降级**。
- `/monitor/*`（静态 UI 资源）：`auth: "plugin"`（公开）。**有意为之** —— 浏览器无法在普通导航加 Authorization 头，静态文件必须公开；UI 自己处理 token（localStorage + fetch headers）。**不要改回 `gateway`**，否则浏览器永远 401。

### 11. **SSE 用 fetch reader，不用原生 EventSource**

EventSource 不支持自定义 header，加不上 Authorization。`ui/src/api.ts: openEventStream` 是 fetch + ReadableStream + 手写 SSE 解析。保留 `data:` 多行合并和 blank-line 分块语义。

### 50. **EventBus.subscribe 是 atomic check-and-add，返回 undefined 表示拒绝**（v0.9.6 修 pre-existing TOCTOU）

旧 SSE handler `if (bus.size() >= max) { 503 } else { bus.subscribe(...) }` 在并发请求下两个连接都过 size 检查、只有一个真正 subscribe，loser 拿到 no-op unsubscribe + 持续打开的连接，从此收不到任何事件 —— 浏览器看像挂起。修复 `outlets/event-bus.ts: subscribe` 改返回 `(() => void) | undefined`：到上限直接 `return undefined`，SSE handler 据此 503 + 立即 end。**不要**把 size() 分离回外面 —— 任何"先看 size，再添加"的两步都会再现 TOCTOU。配套修复 `sse-stream.ts` 的 `closed` 标志防多次 res.end()。

## HTTP handler 的硬约束

- **HTTP route handler 必须 `return true`**（`OpenClawPluginHttpRouteHandler` 契约），否则 host 继续向后路由。
- **不要在 SSE handler 同步遍历大对象** —— 会阻塞订阅总线。每个事件 JSON.stringify 一次就发，控制 payload 大小。
- 静态 UI handler 路径解析用 `path.dirname(fileURLToPath(import.meta.url))` 锚定 dist（见 [`engineering.md`](./engineering.md) 决策 #9），不写死相对路径。
