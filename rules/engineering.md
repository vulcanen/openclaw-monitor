# rules/engineering.md —— 工程基线 + 测试 + 命令 + 陷阱

工程基线（依赖策略 / scope / lint / CI / 测试结构）+ 命令清单 + 常见陷阱。本插件最强约束是"零运行时依赖 + 不能加 native 包"，因为 host install 带 `--ignore-scripts`。

## 关键工程决策

### 1. **存储用 JSONL，不用 SQLite**

OpenClaw install 强制 `--ignore-scripts`（host 源码 `src/plugins/install.ts` 已验证），带 native postinstall 的包（如 better-sqlite3）**装不上**。JSONL append-only + 按日期分文件，零原生依赖，retention 直接 `unlink`。

### 2. **零运行时 npm 依赖**

`package.json` 的 `dependencies: {}` 是空的。`openclaw` 是 devDependency（仅取类型，runtime 由 host 注入）。UI 的 React/Recharts 全打进 `dist/ui/assets/index-*.js`。为避免 host install-time 依赖解析失败。

### 4. **scope 用 `@vulcanen`，不要用 `@openclaw`**

host 源码 `src/plugins/install.ts:189` 对 `@openclaw/*` 有特殊 "trusted official prerelease" 路径，会改变版本解析行为。`@vulcanen` 与 host 无特殊耦合。

### 9. **路径解析用 `import.meta.url`**

`static-ui.ts` 用 `path.dirname(fileURLToPath(import.meta.url))` 锚定 dist 目录，不写死相对路径。

### 52. **Lint / Prettier / CI matrix / GH templates 是工程化基线**（v0.9.7）

- ESLint flat config 在 `eslint.config.js`，跑 `typescript-eslint` recommended-type-checked + react-hooks，重点 `no-floating-promises` / `no-misused-promises` —— 覆盖决策 #22 / #37 / #41 类异步静默挂死的整片潜在面。
- **HTTP route handler 的 `async` 关键字不要去掉**：`OpenClawPluginHttpRouteHandler` 类型要求 `Promise<boolean>`，handler 写 `async` 即便没 `await` 也是对的；ESLint 配置已禁 `require-await` 正是为这层契约。
- 测试文件 type-check 走 `tsconfig.eslint.json`（主 tsconfig `exclude: ["*.test.ts"]` 避免编译到 dist；ESLint 需要看见它们）。改 tsconfig 必须同步改 tsconfig.eslint.json。
- Prettier 锁**既有事实风格**（双引号 + 分号 + trailingComma:all + 100 char），不要为统一翻新历史代码 —— 一次性 `npm run format` 已过；之后只对增量改动应用，CI `format:check` 卡偏移。
- CI 矩阵 `[22, 24]`，跟 `engines.node: ">=22"` 配套，Node 26 LTS 出来再加。
- GH PR template 与 ISSUE_TEMPLATE bug-report / host-compat 在 `.github/`。
- 发版走 `tags v*.*.*` 触发 `.github/workflows/release.yml` 自动建 GH Release + commit history 生成 release notes；**npm publish 仍手动**，CI 不持 NPM_TOKEN 是有意决策（供应链攻击面控制）。

### 53. **测试文件按层就近放，不要堆 service.test.ts 一个**（v0.9.7）

CLAUDE.md 原本"测试集中"被误读成"一个文件装全部" —— 实际意图是**就近 + 集中在 src/**（不要 `__tests__/` 或 `test/` 顶层）。当前布局：

- `src/test-utils.ts` 共享 `makeEvent` 等纯工具（不挂 vitest globals）
- `src/storage/ring-buffer.test.ts` / `src/storage/jsonl-store.test.ts`
- `src/pipeline/aggregator.test.ts`（合并 runs-tracker）
- `src/probes/hook-metrics.test.ts`
- `src/audit/conversation-probe.test.ts`（~600 行，体量最大）
- `src/alerts/engine.test.ts`
- `src/costs/daily-store.test.ts`
- `src/insights/queries.test.ts`
- `src/service.test.ts` 保留 **service-level 编排** 测试（plugin entry idempotency + event fanout）

单文件 1700 行 ergonomics 不可接受；vitest pattern `src/**/*.test.ts` 不变。新测试就近放层 `*.test.ts`；service.test.ts 不再吃通用单测。

### 54. **错误抛出统一加 `code` 字段，不引入 Error 子类**（v0.9.7 对齐 Next.js 实际惯例）

原约定是裸 `throw new Error(message)`（决策 #21 隐含）。v0.9.7 给**调用方需要 catch + 分支**的位置加 `code` 属性：`url-guard` 的 `URL_GUARD_*`、`dispatcher` 的 `ALERT_CHANNEL_UNKNOWN_KIND`、`dingtalk` 的 `DINGTALK_HTTP_ERROR` / `DINGTALK_API_ERROR`、`webhook` 的 `WEBHOOK_HTTP_ERROR`。**不要**改成 `class HttpError extends Error` 子类层级 —— Next.js 实际源码全用裸 `throw new Error(\`...\`)`。code 用 `Object.assign(new Error(msg), { code })` 而非 declared class；后续加新 code 同样模式。

## 测试规约

- 测试就近放层 `*.test.ts`（决策 #53）；vitest pattern `src/**/*.test.ts`。
- 测试不依赖网络、不依赖 OpenClaw host 进程。host API 用 fake 对象注入（参考 conversation probe `makeFakeApi`）。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-..."))`，`afterEach` 清理。
- 改 storage 层至少加一条 roundtrip 测试（写一条 → close → 重开 → 读回一致）。

## 命令清单

```bash
# 安装
npm install                         # 后端
cd ui && npm install                # UI（独立 npm 项目）

# 验证
npm run typecheck                   # 后端 tsc
cd ui && npm run typecheck          # UI
npm test                            # vitest
npm run lint                        # ESLint
npm run format:check                # Prettier check

# 构建
npm run build                       # plugin + UI
npm run build:plugin                # 仅后端
npm run build:ui                    # 仅 UI（输出到 dist/ui）

# 发布前自检
npm pack --dry-run
```

**改动验收门槛（最低）：** `npm run typecheck && npm test && npm run build` 全绿。UI 改了再加 `cd ui && npm run typecheck`。

## 常见陷阱

1. **不要用 `createWriteStream` + `stream.end()`** 做事件追加 —— close 是异步，测试 close→reread 会拿到空文件。改用 `appendFileSync`，吞吐对监控场景足够。
2. **不要在 audit / cost 模块里直接写盘**，用 `setStore(store)` 注入。store 由 `service.start(ctx)` 拿到 `stateDir` 后才创建。
3. **不要在 `register(api)` 时读 config** —— 那时拿不到 `ServiceContext`。config 在 `service.start(ctx)` 读。Hook 注册无条件，handler 内部按 `probe.config.enabled` 判断是否处理。
4. **HTTP route handler 必须 `return true`**（`OpenClawPluginHttpRouteHandler` 契约），否则 host 继续向后路由。
5. **UI 修改后必须 `npm run build:ui`**，`static-ui.ts` 读 `dist/ui/index.html`，不是源文件。
6. **不要在 SSE handler 同步遍历大对象** —— 会阻塞订阅总线。每个事件 JSON.stringify 一次就发，控制 payload 大小。
7. **不要把 token / 凭据写进 `.npmrc`** 然后提交 —— `.npmrc` 只放 registry URL，token 走 `npm login`（用户级 `~/.npmrc`）或 CI 环境变量 `NPM_TOKEN`。
