# Contributing

Thanks for taking the time to look. This is a small, focused plugin and most contributions are short, surgical, and merged quickly. Bigger changes — new pages, new persistence layers, new event types — are best discussed in an issue first.

## What changes are welcome

- **Bug fixes** for anything the dashboard mis-renders or any host-event the plugin mis-handles. Include the OpenClaw host version and a minimal repro.
- **Host compat patches** — every new OpenClaw release can introduce new hook shapes or rename fields. PRs that re-align the probe layer are always welcome.
- **New monitor signals / drill-downs** under the existing four-page layout (Overview / Sources / Channels / Models / Tools / Runs / Insights / Conversations / Costs / Logs / Alerts). Adding to an existing page is easier to land than a new top-level page.
- **Docs** — examples, gotchas, deployment notes. README is the user-facing source of truth; CLAUDE.md is for codebase-internal decisions.

## What's out of scope

- **Mobile / tablet layouts.** This is a PC dashboard, by design. See CLAUDE.md "UI 规则" #5.
- **New runtime dependencies.** The plugin ships with `"dependencies": {}` empty — anything we'd add gets bundled into `dist/ui/assets/*.js` instead. Adding a runtime npm dependency would break installs on hosts that run with `--ignore-scripts`.
- **Replacing JSONL persistence with SQLite / DuckDB / anything native.** Same install-time constraint (CLAUDE.md decision #1).
- **Modifying OpenClaw host source.** This plugin only consumes published SDK barrels (`openclaw/plugin-sdk/*`). Anything that needs new host behaviour belongs in the OpenClaw repo.

## Project layout

```
src/                Backend (TypeScript, runs inside the OpenClaw plugin host)
  probes/           Event subscribers (onDiagnosticEvent + plugin hooks)
  pipeline/         Pure-function aggregator / runs tracker / extractors
  storage/          JSONL store + ring buffer + retention
  outlets/          HTTP routes, SSE stream, static UI handler
  audit/            Conversation content audit (gated by host security door)
  alerts/           Threshold alert engine + webhook / DingTalk channels (v0.7)
  costs/            Pricing table + daily-cost JSONL + cost rollups (v0.8)
  insights/         Top-N drill-down queries (v0.9)
ui/                 React + Vite + Recharts dashboard, built into dist/ui/
openclaw.plugin.json  Plugin manifest + JSON schema for the operator config
```

CLAUDE.md at the repo root captures every load-bearing engineering decision; read it before changing layers. The file is intentionally long — it exists because we've forgotten the same gotchas more than once.

## Local development

Requires Node ≥ 22.

```bash
# Backend deps
npm install

# UI deps (separate npm project)
npm --prefix ui install

# Verification gates — these must all be green before commit
npm run typecheck             # backend tsc --noEmit
npm --prefix ui run typecheck # UI tsc --noEmit
npm test                      # vitest
npm run build                 # plugin + UI -> dist/
```

The committed `.npmrc` points at a private company mirror for the original developer's machine. If you're outside that network just override the registry on the command line: `npm install --registry=https://registry.npmjs.org/`. CI does this automatically.

## Pull request checklist

Before opening a PR, confirm:

- [ ] `npm run typecheck` passes (both backend and `ui/`)
- [ ] `npm test` passes (37+ tests today)
- [ ] `npm run build` succeeds — UI assets bundle correctly
- [ ] User-visible behaviour or config changes are reflected in **both** `README.md` and `README.zh-CN.md`
- [ ] Internal rules / new gotchas land in `CLAUDE.md` under "关键工程决策"; decision numbers append, never overwrite
- [ ] No new runtime dependencies in `package.json` (`dependencies` stays `{}`)
- [ ] If the change affects the JSONL on-disk format, include a migration note in the PR body

## Commit & PR style

We use conventional-ish prefixes — `feat(vX.Y.Z): ...`, `fix(vX.Y.Z): ...`, `docs(vX.Y.Z): ...`, `chore: ...`. Bumping the version is part of the same commit that ships the feature. One commit per published version is the norm; we prefer a clear `git log --oneline` over linear-history purity.

PR body should explain *why* the change is needed, what alternatives were considered, and how to verify it locally. If you fixed an upstream-host gotcha, please link to the host source line so the next person debugging the same symptom can find it.

## Reporting a bug

Open an issue with:

1. OpenClaw host version (`openclaw --version`)
2. Plugin version (visible on the dashboard's About / status line, or `cat ~/.openclaw/npm/node_modules/@vulcanen/openclaw-monitor/package.json | jq .version`)
3. A short reproduction — config snippet, request that triggers the issue, dashboard page that mis-renders
4. Relevant log excerpts from `/tmp/openclaw/openclaw-*.log` (the file the host writes, NOT the systemd journal — it's more structured)

For sensitive issues (auth bypass, data exfiltration, secret exposure) please follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

## License

By contributing you agree your work is published under the project's MIT license. See [LICENSE](./LICENSE).
