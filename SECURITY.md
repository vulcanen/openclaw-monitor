# Security Policy

## Supported versions

This plugin tracks the latest published version on npm. Only the most recent minor (currently `0.9.x`) gets security fixes. Older minors are not maintained — please upgrade.

| Version | Supported |
|---|---|
| 0.9.x | ✅ |
| 0.8.x | ❌ — upgrade to 0.9 |
| 0.7.x | ❌ |
| < 0.7 | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue.** Report privately through GitHub Security Advisories:

> <https://github.com/vulcanen/openclaw-monitor/security/advisories/new>

This keeps the discussion private and lets us coordinate a fix before public disclosure. You should receive an acknowledgement within **3 business days**. We aim to ship a patched release within **14 days** of a credible report, faster for actively exploited issues.

## What's in scope

This plugin runs inside the OpenClaw gateway process and exposes:

- HTTP routes under `/api/monitor/*` (gateway-authenticated, `trusted-operator` scope)
- HTTP routes under `/monitor/*` (intentionally public — static SPA assets only, no data)
- SSE stream at `/api/monitor/stream`
- Outbound HTTP to operator-configured alert channels (webhook / DingTalk)
- JSONL files under the OpenClaw `stateDir`

In-scope issues include but are not limited to:
- **Authentication / authorisation bypass** on any `/api/monitor/*` route
- **Path traversal** in the static UI handler or JSONL store
- **SSRF** via the alert webhook URL or DingTalk URL parsing
- **Secret exposure** in logs, the dashboard, or REST responses (e.g. tokens leaked through error messages)
- **Conversation-audit content exposure** to non-operator scopes
- **Cross-tenant** leakage in multi-tenant OpenClaw deployments

## Out of scope

- Issues in the **OpenClaw host itself**. Please report those to the OpenClaw maintainers directly.
- **Operator misconfiguration** (e.g. you put the gateway on the public internet and disabled auth — that's a deployment issue, not a plugin vulnerability).
- **Denial-of-service via abusive log volume** — the plugin is a logger; if you flood it with events it will write them all to JSONL. That's how it's supposed to work. Set retention to taste.
- **Findings produced solely by automated SAST / DAST scanners** without a working proof-of-concept.

## Disclosure

After a fix ships on npm, we'll publish a GitHub Security Advisory describing the issue and crediting the reporter (unless you ask to remain anonymous). CVE assignment happens through GitHub's advisory flow when warranted.

## Hardening notes for operators

These aren't vulnerabilities, but they're easy to get wrong:

- **Never expose the OpenClaw gateway port (default 18789) to the public internet.** The plugin's data routes are protected by the gateway operator token, but conversation-audit content is plaintext on disk — operator-level access means full prompt visibility.
- The gateway operator token lives in `~/.openclaw/openclaw.json` (`gateway.auth.token`). Treat that file like a secret store.
- Conversation audit JSONL files at `<stateDir>/openclaw-monitor/audit/conversations-*.jsonl` may contain PII or business secrets in raw prompt text. Restrict file-system access accordingly and tune `config.audit.retainDays` (default 3) to your compliance requirements.
- Outbound alert webhooks are unsigned by default; configure DingTalk's HMAC secret or pin a webhook receiver that validates a shared secret in the request body.
