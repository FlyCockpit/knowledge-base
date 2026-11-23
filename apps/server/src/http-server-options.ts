/**
 * Node HTTP server timeouts for the public listener.
 *
 * A fronting proxy reuses idle upstream connections. If the app closes an idle
 * socket first, the proxy can send the next request onto a socket the app is
 * closing and answer it with a 502 / connection reset. The app's idle timeout
 * must therefore exceed every supported proxy's idle-reuse window:
 *
 * - cloudflared `originRequest.keepAliveTimeout` defaults to 90 s;
 * - Traefik's `serversTransport` `idleConnTimeout` defaults to 90 s;
 * - nginx `keepalive_timeout` defaults to 60–75 s.
 *
 * Node's default (5 s) is far below all of them. `headersTimeout` is separate:
 * it times each request's headers from that request's first byte, not the
 * idle gap before it, so it stays at a slow-header bound below the idle window.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 95_000;
export const HEADERS_TIMEOUT_MS = 66_000;

export const httpServerOptions = {
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  headersTimeout: HEADERS_TIMEOUT_MS,
} as const;
