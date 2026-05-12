/**
 * Defensive URL validation for outbound alert channels.
 *
 * Alert channel URLs come from the host config (trusted-operator scope),
 * so this is *not* a hard-security boundary — but as a public package
 * we should still refuse the most obvious SSRF shapes by default. An
 * operator who needs to point a webhook at an internal hostname can
 * set `alerts.channels.<id>.allowPrivateNetwork: true` to opt out per
 * channel (matches the host SDK's pattern for similar guards).
 *
 * What we reject:
 *   - non-http(s) schemes (file:, gopher:, data:, javascript:, …)
 *   - hostnames that resolve to literals in private / loopback /
 *     link-local space (no DNS resolution — we only inspect the
 *     literal form to avoid blocking *all* hostname-based webhooks)
 *   - IPv6 forms that embed an IPv4 address (IPv4-mapped `::ffff:x.x.x.x`
 *     and the deprecated IPv4-compatible `::x.x.x.x`) when the embedded
 *     IPv4 falls in a private/loopback range — these were a real SSRF
 *     bypass because WHATWG URL parsers normalize them to hex form
 *     (`[::ffff:7f00:1]`, `[::7f00:1]`) that string patterns miss.
 *
 * What we do NOT do:
 *   - DNS rebinding protection (would need pinning resolved IP and
 *     opening the socket ourselves; out of scope)
 *   - HTTPS enforcement (some operators run plain-http receivers)
 */

import { isIPv6 } from "node:net";

const LITERAL_PRIVATE_HOST = [
  /^127\./, // IPv4 loopback
  /^10\./, // IPv4 RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // IPv4 RFC1918
  /^192\.168\./, // IPv4 RFC1918
  /^169\.254\./, // IPv4 link-local (incl. AWS / GCP metadata 169.254.169.254)
  /^0\.0\.0\.0$/, // any-interface
  /^localhost$/i,
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc00:/i, // IPv6 ULA
  /^fd00:/i, // IPv6 ULA
];

/**
 * If `host` is an IPv6 address that embeds an IPv4 address (either
 * IPv4-mapped `::ffff:a.b.c.d` or IPv4-compatible `::a.b.c.d`, in dotted
 * or normalized hex form), return the extracted IPv4 in dotted-quad
 * form. Otherwise return undefined.
 *
 * We need this because `new URL("http://[::ffff:127.0.0.1]/").hostname`
 * comes back as `"[::ffff:7f00:1]"` — the dotted-quad form is gone, so
 * naive `^127\.` patterns miss it entirely.
 */
function embeddedIPv4(host: string): string | undefined {
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!isIPv6(inner)) return undefined;
  const lower = inner.toLowerCase();
  // Either `::ffff:` (IPv4-mapped) or bare `::` (IPv4-compatible). Both
  // require the top 96 bits to be zero, which means everything before the
  // last 32 bits is either empty or `ffff`.
  let tail: string;
  if (lower.startsWith("::ffff:")) tail = lower.slice(7);
  else if (lower.startsWith("::")) tail = lower.slice(2);
  else return undefined;
  if (tail === "") return undefined;
  // Dotted-quad form (Node sometimes preserves this when parsing directly,
  // and we accept the literal hostname form too).
  const dotted = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(tail);
  if (dotted) {
    const [, a, b, c, d] = dotted as unknown as [string, string, string, string, string];
    return `${a}.${b}.${c}.${d}`;
  }
  // Hex form: exactly two 16-bit groups after the `::` (or `::ffff:`).
  // Anything else is a generic IPv6 address that doesn't encode IPv4.
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (hex) {
    const hi = parseInt(hex[1] as string, 16);
    const lo = parseInt(hex[2] as string, 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return undefined;
}

export type ChannelUrlGuardOptions = {
  allowPrivateNetwork?: boolean;
};

export function assertSafeChannelUrl(
  rawUrl: string,
  opts: ChannelUrlGuardOptions = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`only http/https URLs are allowed (got ${parsed.protocol})`);
  }
  if (opts.allowPrivateNetwork === true) return parsed;
  const host = parsed.hostname;
  const reject = (): never => {
    throw new Error(
      `private / loopback / link-local hosts are blocked by default (${host}). ` +
        `If this is intentional, set allowPrivateNetwork: true on the channel.`,
    );
  };
  for (const pattern of LITERAL_PRIVATE_HOST) {
    if (pattern.test(host)) reject();
  }
  // IPv6-encoded IPv4 (e.g. `::ffff:7f00:1` ← `::ffff:127.0.0.1`). Extract
  // the embedded IPv4 and re-run the IPv4 patterns against it.
  const v4 = embeddedIPv4(host);
  if (v4) {
    for (const pattern of LITERAL_PRIVATE_HOST) {
      if (pattern.test(v4)) reject();
    }
    // Any address whose top 96 bits are zero and whose embedded IPv4 is
    // 0.0.0.0/8 (CURRENT-NETWORK reserved, includes 0.0.0.0) is also
    // unsafe — reject as a defensive default.
    if (v4.startsWith("0.")) reject();
  }
  return parsed;
}

/** Exposed for tests. */
export const __testing = { LITERAL_PRIVATE_HOST };
