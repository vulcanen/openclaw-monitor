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
 *
 * What we do NOT do:
 *   - DNS rebinding protection (would need pinning resolved IP and
 *     opening the socket ourselves; out of scope)
 *   - HTTPS enforcement (some operators run plain-http receivers)
 */

const LITERAL_PRIVATE_HOST = [
  /^127\./, // IPv4 loopback
  /^10\./, // IPv4 RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // IPv4 RFC1918
  /^192\.168\./, // IPv4 RFC1918
  /^169\.254\./, // IPv4 link-local (incl. AWS / GCP metadata 169.254.169.254)
  /^0\.0\.0\.0$/, // any-interface
  /^localhost$/i,
  /^::1$/, // IPv6 loopback
  /^\[::1\]$/, // IPv6 loopback bracketed
  /^fe80:/i, // IPv6 link-local
  /^fc00:/i, // IPv6 ULA
  /^fd00:/i, // IPv6 ULA
];

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
  for (const pattern of LITERAL_PRIVATE_HOST) {
    if (pattern.test(host)) {
      throw new Error(
        `private / loopback / link-local hosts are blocked by default (${host}). ` +
          `If this is intentional, set allowPrivateNetwork: true on the channel.`,
      );
    }
  }
  return parsed;
}

/** Exposed for tests. */
export const __testing = { LITERAL_PRIVATE_HOST };
