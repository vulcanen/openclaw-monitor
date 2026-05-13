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

import { isIPv4, isIPv6 } from "node:net";

// Patterns that match against the hostname *only when it parses as IPv4*.
// We split rejection into two layers so a legitimate hostname like
// `127.example.com` or `cdn.10gen.net` doesn't trigger on a leading prefix
// that happens to look like an IPv4 octet. The IPv4-shape patterns are
// applied to dotted-quad strings only; the textual patterns (`localhost`,
// IPv6 prefixes) are applied to the raw host.
const IPV4_PRIVATE_PATTERN = [
  /^127\./, // IPv4 loopback
  /^10\./, // IPv4 RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // IPv4 RFC1918
  /^192\.168\./, // IPv4 RFC1918
  /^169\.254\./, // IPv4 link-local (incl. AWS / GCP metadata 169.254.169.254)
  /^0\./, // IPv4 "this network" /8 (0.0.0.0/8) — Linux routes to localhost
];
const LITERAL_PRIVATE_HOST = [
  /^localhost$/i,
  /^::1$/, // IPv6 loopback
  /^::$/, // IPv6 unspecified
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
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return undefined;
}

export type ChannelUrlGuardOptions = {
  allowPrivateNetwork?: boolean;
};

/**
 * Stable string codes attached to Errors thrown by `assertSafeChannelUrl`.
 * Callers (dispatcher, future alert-test endpoints) branch on `code`
 * rather than parsing the message — text is for humans, code is for
 * code.
 *
 * Kept as a plain object (not enum) per project convention: union literal
 * types pair better with `instanceof` + property checks than enums do.
 */
export const URL_GUARD_ERROR_CODES = {
  INVALID_URL: "URL_GUARD_INVALID",
  BAD_SCHEME: "URL_GUARD_BAD_SCHEME",
  PRIVATE_HOST: "URL_GUARD_PRIVATE_HOST",
} as const;

export type UrlGuardErrorCode = (typeof URL_GUARD_ERROR_CODES)[keyof typeof URL_GUARD_ERROR_CODES];

function urlGuardError(code: UrlGuardErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: UrlGuardErrorCode };
  err.code = code;
  return err;
}

export function assertSafeChannelUrl(rawUrl: string, opts: ChannelUrlGuardOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw urlGuardError(URL_GUARD_ERROR_CODES.INVALID_URL, `invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw urlGuardError(
      URL_GUARD_ERROR_CODES.BAD_SCHEME,
      `only http/https URLs are allowed (got ${parsed.protocol})`,
    );
  }
  if (opts.allowPrivateNetwork === true) return parsed;
  const host = parsed.hostname;
  const reject = (): never => {
    throw urlGuardError(
      URL_GUARD_ERROR_CODES.PRIVATE_HOST,
      `private / loopback / link-local hosts are blocked by default (${host}). ` +
        `If this is intentional, set allowPrivateNetwork: true on the channel.`,
    );
  };
  // Textual / IPv6 patterns apply to the raw host string.
  for (const pattern of LITERAL_PRIVATE_HOST) {
    if (pattern.test(host)) reject();
  }
  // IPv4 patterns apply only when the host actually parses as IPv4 —
  // otherwise `cdn.10gen.net` would trip on `^10\.` and `127.example.com`
  // on `^127\.`.
  if (isIPv4(host)) {
    for (const pattern of IPV4_PRIVATE_PATTERN) {
      if (pattern.test(host)) reject();
    }
  }
  // IPv6-encoded IPv4 (e.g. `::ffff:7f00:1` ← `::ffff:127.0.0.1`). Extract
  // the embedded IPv4 and re-run the IPv4 patterns against it. Note: the
  // unwrapped string is a dotted-quad we constructed, so isIPv4 will accept
  // it; we still check explicitly to keep the contract crisp.
  const v4 = embeddedIPv4(host);
  if (v4 && isIPv4(v4)) {
    for (const pattern of IPV4_PRIVATE_PATTERN) {
      if (pattern.test(v4)) reject();
    }
  }
  return parsed;
}

/** Exposed for tests. */
export const __testing = { LITERAL_PRIVATE_HOST, IPV4_PRIVATE_PATTERN };
