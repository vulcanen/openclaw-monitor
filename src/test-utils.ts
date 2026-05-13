/**
 * Shared test utilities. Kept in `src/` (not `src/__tests__/`) so the
 * "tests sit beside the layer they cover" project convention holds
 * (CLAUDE.md `测试规约`).
 *
 * @vitest-environment node (default for this project; declared here so
 *   editors hint correctly when this file is opened on its own)
 */
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";

/**
 * Build a `DiagnosticEventPayload` with minimal valid fields. The host
 * type is a discriminated union over many event shapes; tests typically
 * only care about `type` + a handful of dimension fields, so we cast
 * through `unknown` rather than spell out every variant.
 */
export function makeEvent<T extends DiagnosticEventPayload["type"]>(
  type: T,
  extra: Record<string, unknown> = {},
): DiagnosticEventPayload {
  return { type, seq: 0, ts: Date.now(), ...extra } as unknown as DiagnosticEventPayload;
}
