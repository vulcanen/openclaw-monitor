<!--
Thanks for the PR! Most contributions are short and surgical — keep this
description focused on **why** and **how to verify**. See CONTRIBUTING.md
for project conventions.
-->

## What and why

<!-- One short paragraph: what changes, what problem this solves. Link to
related issue / host source line if applicable. -->

## How to verify

<!-- 2-5 bullets of steps so a reviewer can confirm the behaviour locally.
Include any config flags, host versions, or specific request patterns. -->

-

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes
- [ ] `npm run typecheck` passes (both backend and `ui/`)
- [ ] `npm test` passes
- [ ] `npm run build` succeeds — UI assets bundle correctly
- [ ] User-visible behaviour / config / endpoint changes are reflected in **both** `README.md` and `README.zh-CN.md`
- [ ] Internal rules / new gotchas land in `CLAUDE.md` under "关键工程决策"; decision numbers append, never overwrite
- [ ] No new runtime dependencies in `package.json` (`dependencies` stays `{}`)
- [ ] If the change affects the JSONL on-disk format, this PR body includes a migration note

## Notes for reviewers

<!-- Anything load-bearing the reviewer should know: trade-offs you
considered and rejected, alternatives, follow-up PRs queued behind this
one, areas you specifically want a second pair of eyes on. -->
