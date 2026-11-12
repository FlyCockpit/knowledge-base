import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isPrivateIp } from "@knowledge-base/api/lib/kb/private-ip";
import { logEvent } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/server";
import type { Context } from "hono";

/**
 * Resolve the client IP for an anonymous request. This is the rate-limit key
 * for traffic that isn't tied to a user id (sign-in, MFA, MCP, public pages).
 *
 * `X-Forwarded-For` is `<client-supplied>, <appended by hop 1>, <hop 2>, ...`.
 * Everything a client sends is forgeable; each trusted proxy APPENDS the
 * address it received the request from. The chain we read is therefore
 * `[...X-Forwarded-For, socketPeer]`, and only the rightmost entries written
 * by proxies we actually run can be trusted.
 *
 * TRUST_PROXY_HOPS = N (default 0) is the exact number of trusted reverse
 * proxies between the client and the app:
 *
 * - N = 0 (default): key on the TCP socket peer and ignore `X-Forwarded-For`
 *   entirely. Correct for direct exposure and LAN deploys. A deployment that
 *   sits behind a proxy but leaves N = 0 keys every client on the proxy's
 *   address — one shared bucket — which fails safe (over-limits) rather than
 *   letting clients choose their own key.
 * - N >= 1: the client is the entry N positions left of the socket peer. The
 *   generated Dokploy Compose sets 1 (Traefik). The app must be reachable
 *   ONLY through that chain, or a direct caller can forge the entries.
 *
 * There is no fallback to the leftmost (client-supplied) entry: when the
 * chain is shorter than N + 1, or the selected entry is not an IP literal,
 * the request did not arrive through the configured proxies and is keyed on
 * the socket peer instead.
 */
export function resolveClientIp(c: Context): string {
  const socket = getConnInfo(c).remote.address || "unknown";
  const header = c.req.header("x-forwarded-for");
  const hops = env.TRUST_PROXY_HOPS ?? 0;
  if (hops === 0) {
    if (header) warnUntrustedForwardedOnce(socket);
    return socket;
  }

  const forwarded = (header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // `forwarded[forwarded.length - hops]` is N-from-right in [...xff, socket].
  const candidate = forwarded[forwarded.length - hops];
  if (candidate === undefined || isIP(candidate) === 0) return socket;
  return candidate;
}

let warnedUntrustedForwarded = false;

/**
 * A private socket peer sending X-Forwarded-For while TRUST_PROXY_HOPS is 0 is
 * almost always a reverse proxy the operator has not counted, which collapses
 * every client into the proxy's bucket. Say so once per process; the request
 * is still keyed on the socket peer (a LAN client spoofing the header only
 * triggers this one-time record).
 */
function warnUntrustedForwardedOnce(socket: string): void {
  if (warnedUntrustedForwarded) return;
  const version = isIP(socket);
  if (version === 0 || !isPrivateIp(socket, version)) return;
  warnedUntrustedForwarded = true;
  logEvent("client-ip.proxy-hops");
}
