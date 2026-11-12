import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { assertResolvedAddressesSafe, type DnsLookupFn } from "./egress";
import { KbDomainError } from "./errors";
import { isBlockedEgressAddress } from "./private-ip";

/**
 * Strict canonical mirror remote: `ssh://git@host[:port]/seg/.../repo.git`.
 * Hand-parsed (no WHATWG URL, no SCP form) so there is exactly one reading of
 * every accepted string; the canonical output is what the SSH wrapper receives.
 */
export type MirrorSshUrl = {
  url: string;
  host: string;
  port: number;
  path: string;
  hostIsIp: boolean;
};

const PREFIX = "ssh://git@";
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const DOTTED_V4 =
  /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const MAX_URL = 1024;
const MAX_PATH_BYTES = 512;

const invalid = () => new KbDomainError("INVALID_ARGUMENT", "Invalid mirror URL");
/** The browser names this reason so the form can explain the private-network egress block. */
export const MIRROR_PRIVATE_HOST_REASON = "PRIVATE_NETWORK_HOST";
const privateHost = () =>
  new KbDomainError("INVALID_ARGUMENT", "Mirror host is not public", undefined, {
    reason: MIRROR_PRIVATE_HOST_REASON,
  });

function canonicalV6(literal: string): string | null {
  if (isIP(literal) !== 6) return null;
  try {
    return new URL(`http://[${literal}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function parseHost(raw: string): { host: string; display: string; hostIsIp: boolean } {
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) throw invalid();
    const literal = raw.slice(1, -1);
    // Canonical compressed lowercase form only; zone ids are never accepted.
    if (literal.includes("%") || canonicalV6(literal) !== literal) throw invalid();
    if (isBlockedEgressAddress(literal)) throw privateHost();
    return { host: literal, display: `[${literal}]`, hostIsIp: true };
  }
  const host = raw.toLowerCase();
  if (DOTTED_V4.test(host)) {
    if (isBlockedEgressAddress(host)) throw privateHost();
    return { host, display: host, hostIsIp: true };
  }
  if (host.length === 0 || host.length > 253) throw invalid();
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) throw invalid();
  // A numeric-looking final label would be reinterpreted as an IPv4 number by
  // inet_aton-style resolvers (127.1, 0x7f000001, 010.0.0.1): refuse the ambiguity.
  const last = labels.at(-1)!;
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) throw invalid();
  if (last === "localhost") throw privateHost();
  // Canonical IDNA: every A-label must round-trip unchanged through UTS-46.
  if (domainToASCII(host) !== host) throw invalid();
  return { host, display: host, hostIsIp: false };
}

export function parseMirrorSshUrl(raw: string): MirrorSshUrl {
  if (typeof raw !== "string" || raw.length > MAX_URL) throw invalid();
  // Printable ASCII only, and none of the characters that change meaning in a
  // shell, a URL or an SSH config: controls, space, quotes, backslash, %, ?, #.
  if (!/^[\x21-\x7e]+$/.test(raw) || /["'`\\%?#]/.test(raw)) throw invalid();
  if (!raw.startsWith(PREFIX)) throw invalid();
  const rest = raw.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) throw invalid();
  const authority = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (authority.includes("@")) throw invalid();

  let hostPart = authority;
  let port = 22;
  const bracketEnd = authority.lastIndexOf("]");
  const colon = authority.lastIndexOf(":");
  if (colon > bracketEnd) {
    const portText = authority.slice(colon + 1);
    if (!PORT.test(portText)) throw invalid();
    port = Number(portText);
    if (port < 1 || port > 65535) throw invalid();
    hostPart = authority.slice(0, colon);
  }
  if (!hostPart.startsWith("[") && hostPart.includes(":")) throw invalid();
  const { host, display, hostIsIp } = parseHost(hostPart);

  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) throw invalid();
  const segments = path.slice(1).split("/");
  if (segments.length < 2 || segments.length > 8) throw invalid();
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") throw invalid();
    if (segment.startsWith("-")) throw invalid();
  }
  const repo = segments.at(-1)!;
  if (!repo.endsWith(".git") || repo.length <= 4 || repo === "..git") throw invalid();

  const portPart = port === 22 ? "" : `:${port}`;
  return { url: `ssh://git@${display}${portPart}${path}`, host, port, path, hostIsIp };
}

/**
 * Shared egress policy for the mirror host: an IP literal was already checked
 * by the parser; a DNS name must resolve only to public unicast addresses.
 * The worker re-resolves and pins the address it connects to.
 */
export async function assertMirrorHostEgress(
  parsed: MirrorSshUrl,
  lookup: DnsLookupFn = dnsLookup,
): Promise<void> {
  if (parsed.hostIsIp) return;
  let addresses: LookupAddress[];
  try {
    addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      lookup(parsed.host, { all: true, verbatim: true }, (error, result) =>
        error ? reject(error) : resolve(result),
      );
    });
  } catch {
    throw invalid();
  }
  try {
    assertResolvedAddressesSafe(addresses);
  } catch {
    // Empty answers stay a plain invalid URL; any blocked address is the egress policy.
    throw addresses.length === 0 ? invalid() : privateHost();
  }
}
