# rules/workflow.md —— 工作流约束（文档维护 / 上游版本 / 边界）

CLAUDE.md 的元规则给出了"提交两份文档同步"的红线；这里展开维护流程的细节、上游版本检查的 48h 节奏、以及超出本仓库范围的事。

## 文档维护流程（元规则展开）

每次改完代码、commit 前回答两个问题：

1. **是否引入新层职责 / 新 host 行为发现 / 新工程约束 / 修了一个曾踩过的坑？**
   - 是 → 写进 `rules/` 下**对应主题文件**的「关键工程决策」一节，**编号顺延**到 `#58` `#59` …不覆盖历史决策。
   - 决策落入哪个文件，参照 CLAUDE.md 的「规则索引」表，按主题选：
     - host hook 行为、register lifecycle、SDK 契约 → `host-contract.md`
     - 内容审计 / conversation probe → `audit.md`
     - aggregator / storage / windows / logs handler → `pipeline.md`
     - token / cost / daily-cost → `cost.md`
     - 告警引擎 / channel / url-guard → `alerts.md`
     - HTTP / SSE / 路由权限 → `http-routes.md`
     - UI 风格 / 决策 / i18n → `ui.md`
     - 依赖 / lint / 测试 / 错误约定 → `engineering.md`
     - 工作流约束（如上游检查、release 流程）→ `workflow.md`
   - 写决策块时必须包含：**规则本身、why、具体文件路径、事件/字段名、回归测试名**（缺一项都不达标）。

2. **是否改变功能 / 配置默认值 / HTTP 端点 / UI 用户可见行为？**
   - 是 → 同步改 `README.md`。
   - `README.md` 是**运维向纯功能说明** —— 不写版本历史、不写内部决策、不写调试技巧；一行能说清就一行。中英双语段同步。

**两份文档都改完才 commit。** 这是 v0.6.1 之后明确划下的协作红线。

### 编号管理细节

- 决策块编号是**跨文件唯一序列**。新决策续到当前最大 + 1（截至本次拆分，已用到 `#57`，下一条用 `#58`）。
- 历史上 `#30`–`#35` 在 v0.8.x 与 v0.9.2 之间出现过**重复编号**（同号两条，主题不同）。引用时用 "决策 #30 (v0.8.3)" 或 "决策 #30 (v0.9.2)" 加版本区分。后续不要再制造重复。
- 删除决策块用"标记弃用"而非真删（保留编号 + 一句"v0.X.X 起被决策 #Y 取代"），保持引用链可追溯。

## 关键工程决策

### 40. **每 48 小时检查上游 OpenClaw 有没有新正式版**（v0.9.3 工作流约束）

- **当前 baseline**：全部在 `package.json` 的 `openclaw` 段（不是 `openclaw.plugin.json` —— `PluginManifest` schema 里**没有** install/compat 字段，那是 `PluginPackageInstall` 的事，参 host SDK `manifest.d.ts: PluginManifest` vs `PluginPackageInstall`）。需要同步的五处：
  - `devDependencies.openclaw`（纯字符串 tag，如 `"2026.5.7"`）
  - `openclaw.install.minHostVersion`（semver range，如 `">=2026.5.7"`）
  - `openclaw.compat.pluginApi`（semver range）
  - `openclaw.build.openclawVersion`（纯字符串 tag）
  - `openclaw.build.pluginSdkVersion`（纯字符串 tag）

  升级时五处一起改。bundled iMessage plugin 是真实例（`node_modules/openclaw/dist/extensions/imessage/package.json`）。v0.9.3 写决策时把这套字段误标为 `openclaw.plugin.json` 下的，v0.9.8 修正。
- **状态文件**：`openclaw-version-check.json` 记录 `lastCheckedAt` / `latestStableObserved` / `assessment`。
- **每次新对话开始**读状态文件，若 `lastCheckedAt` 距今 ≥ 48h（用 `currentDate` 系统时间），跑一次检查；否则跳过。**不要每 turn 都查**。
- **检查脚本**（gh 不可用时用 curl，无需鉴权，公开 repo）：

  ```bash
  curl -s -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/openclaw/openclaw/releases?per_page=30" \
    > /tmp/oc-releases.json
  python3 -c '
  import json
  with open("/tmp/oc-releases.json") as f:
      data = json.load(f)
  stables = [r for r in data if not r.get("prerelease") and not r.get("draft")]
  if stables:
      latest = stables[0]
      print(latest["tag_name"], latest["published_at"], latest["html_url"])
  '
  ```

- **判定**：只看 stable（`prerelease=false && draft=false`），忽略 `*-beta.*` / `*-rc.*` / `*-alpha.*`。若最新 stable > baseline：WebFetch release notes，重点检查 SDK 变化 —— `hook-types.d.ts` 增/改/删 hook、`PluginHookXxxEvent` schema 字段、`@openclaw/plugin-sdk/*` 子路径导出、`OpenClawPluginApi` 公开方法、host 安全门（`allowConversationAccess` 等）、HTTP 路由 auth 模式。
- **回写状态**：`lastCheckedAt` 写 ISO 时间戳，`latestStableObserved` 写最新 tag，`assessment` 枚举 `no-action` / `review-pending` / `upgrade-recommended`，`assessmentNotes` 写一两句决策依据。
- **绝对不要自动改版本号**：升级 baseline 需用户 explicit 授权，仅做"评估 + 报告"。
- **报告口径**：一句话告诉用户（"已是最新" / "有新 stable，影响评估：xxx"），不要把整篇 release notes 复述回对话。

## Commit 与提交约束

- **不要在 commit message 加** `Co-Authored-By: Claude <noreply@anthropic.com>` 或 `🤖 Generated with Claude Code` footer。公开 repo 的 Contributors 不应混入 AI 账户。项目历史 20 条带 trailer 的 commit 保留不 rewrite，**新 commit 一律不再追加**。Claude Code 用户应在 `~/.claude/settings.json` 设 `"includeCoAuthoredBy": false` 抑制此默认。
- **不要修改 git config**（`user.email` / `user.name` 用户级已配置，不动）。
- 验收门槛：`npm run typecheck && npm test && npm run build` 全绿（UI 改了再加 `cd ui && npm run typecheck`）。

## 边界外的事

如果改动需要：

- **修改 OpenClaw host 行为** → 不在本仓库做，去 OpenClaw 官方仓库提 PR
- **加新的 host hook** → 同上，host 维护者决定
- **改 ClawHub / npm 私库设置** → 找运维 / DBA

## 参考路径

- OpenClaw 官方仓库的本地源码 checkout（路径因人而异，由开发者自行 clone 对应 `2026.5.7` 标签到任意目录）：验证 host 行为时去读源码，不要改它。引用 host 源码用项目内相对路径（如 `src/infra/diagnostic-events.ts:803-810`），不要写绝对路径。
- 公开 SDK 类型：`node_modules/openclaw/dist/plugin-sdk/src/plugins/types.d.ts`、`node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts`。
