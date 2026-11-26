/**
 * Loopback redirect URI rules for native OAuth clients (RFC 8252), shared by
 * dynamic registration (mcp-plugins.ts) and the consent check (mcp-consent.ts).
 * Pure: no IO.
 */

const NATIVE_HTTP_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * An `http` redirect on an exact loopback host (`localhost`, `127.0.0.1`, `[::1]`),
 * with an optional port and path. Fails closed on anything ambiguous: userinfo
 * (`@`), backslashes, percent-encoding or whitespace in the authority, and any
 * disagreement between this literal reading and WHATWG URL parsing (which is what
 * Better Auth and the browser use). Both must name the same loopback host.
 */
export function isStrictLoopbackHttpRedirect(uri: string): boolean {
  if (/[\\\s]/.test(uri)) return false;
  const literal = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?:[/?][^#]*)?$/i.exec(
    uri,
  );
  if (!literal) return false;
  const host = literal[1]!.toLowerCase();
  const port = literal[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hostname.toLowerCase() === host &&
    NATIVE_HTTP_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) &&
    // WHATWG drops a default/explicit port identically; any other rewrite is a disagreement.
    (port === undefined || parsed.port === "" || parsed.port === String(Number(port)))
  );
}

/** A strict loopback http redirect with its port removed; null for anything else. */
function loopbackWithoutPort(uri: string): string | null {
  if (!isStrictLoopbackHttpRedirect(uri)) return null;
  const parts =
    /^(http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?((?:[/?][^#]*)?)$/i.exec(uri);
  return parts ? `${parts[1]}${parts[2]}` : null;
}

/**
 * Whether `requested` is one of the client's registered redirect URIs, by the
 * rule Better Auth's authorize endpoint applies before it signs the request
 * (RFC 8252 §7.3 and §8.3): an exact match, or, for an http redirect on an
 * exact loopback host, a match on every character except the port. A native
 * client registers `http://127.0.0.1/callback` and listens on any free port.
 * Both sides must pass the strict loopback parsing, so a look-alike host or a
 * parser disagreement never matches.
 */
export function isRegisteredRedirectUri(registered: readonly string[], requested: string): boolean {
  // Refused before any comparison, as Better Auth does: a fragment (even an
  // empty one), userinfo, or a URI that doesn't parse.
  if (requested.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (registered.includes(requested)) return true;
  const portless = loopbackWithoutPort(requested);
  return portless !== null && registered.some((uri) => loopbackWithoutPort(uri) === portless);
}
