// Client-IP proxy classification preserves its existing private-hop semantics.
// Egress is stricter: CIMD, HTTPS providers, downloads and mirror destinations
// share the positive global-address policy below. A non-global destination is
// not automatically a trusted proxy; do not use the egress policy for that walk.

import { isIP } from "node:net";
import { isGlobalEgressAddress } from "@knowledge-base/config/egress-address";

export function isPrivateIp(address: string, family: number): boolean {
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6LiteralToBytes(literal: string): Uint8Array | null {
  const zoneIndex = literal.indexOf("%");
  const addr = (zoneIndex === -1 ? literal : literal.slice(0, zoneIndex)).toLowerCase();
  if (isIP(addr) !== 6) return null;

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parseGroup = (group: string): number | null => {
    if (group.length === 0) return null;
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    return value;
  };

  const left = halves[0] ? halves[0].split(":").filter((part) => part.length > 0) : [];
  const right = halves[1] ? halves[1].split(":").filter((part) => part.length > 0) : [];

  let tailV4: number[] | null = null;
  // A dotted IPv4 tail is only valid as the FINAL group of the address: the
  // last group of `right` when a `::` is present, otherwise the last group of
  // `left` (uncompressed spellings like 0:0:0:0:0:ffff:8.8.8.8). Extract it
  // before counting hextets so expanded and compressed spellings of the same
  // address classify identically instead of failing the group-count check.
  const tailCarrier = halves.length === 2 ? right : left;
  if (tailCarrier.length > 0) {
    const last = tailCarrier[tailCarrier.length - 1];
    if (last?.includes(".")) {
      if (isIP(last) !== 4) return null;
      tailV4 = last.split(".").map((part) => Number.parseInt(part, 10));
      tailCarrier.pop();
    }
  }

  const groups: number[] = [];
  for (const group of left) {
    const value = parseGroup(group);
    if (value === null) return null;
    groups.push(value);
  }

  const tailGroups = tailV4 ? 2 : 0;
  const fixedCount = groups.length + right.length + tailGroups;
  if (halves.length === 2) {
    const missing = 8 - fixedCount;
    if (missing < 0) return null;
    for (let index = 0; index < missing; index += 1) groups.push(0);
  } else if (fixedCount !== 8) {
    return null;
  }

  for (const group of right) {
    const value = parseGroup(group);
    if (value === null) return null;
    groups.push(value);
  }

  if (tailV4) {
    if (
      tailV4.length !== 4 ||
      tailV4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }
    const [octet0, octet1, octet2, octet3] = tailV4;
    if (
      octet0 === undefined ||
      octet1 === undefined ||
      octet2 === undefined ||
      octet3 === undefined
    ) {
      return null;
    }
    const hi = (octet0 << 8) | octet1;
    const lo = (octet2 << 8) | octet3;
    groups.push(hi, lo);
  }

  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index];
    if (group === undefined) return null;
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function isPrivateIpv6FromBytes(bytes: Uint8Array): boolean {
  const isAllZero = bytes.every((byte) => byte === 0);
  if (isAllZero) return true;
  if (bytes[15] === 1 && bytes.slice(0, 15).every((byte) => byte === 0)) return true;

  const byte0 = bytes[0];
  const byte1 = bytes[1];
  if (byte0 === undefined || byte1 === undefined) return true;

  if (byte0 === 0xff) return true;

  // fe80::/10 link-local (fe80::–febf::) and fec0::/10 site-local (fec0::–feff::):
  // mask the high bits, not the equality of one hextet.
  if (byte0 === 0xfe && (byte1 & 0xc0) === 0x80) return true;
  if (byte0 === 0xfe && (byte1 & 0xc0) === 0xc0) return true;

  if ((byte0 & 0xfe) === 0xfc) return true;

  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isPrivateIpv4(embedded);
  }

  // Deprecated IPv4-compatible ::/96 — first 12 bytes zero with any nonzero
  // tail. Unroutable and gone from real networks; reject the whole prefix so
  // dotted (::169.254.169.254) and hex (::a9fe:a9fe) spellings cannot smuggle
  // an IPv4 destination past the predicate.
  const compatibleV4 =
    bytes.slice(0, 12).every((byte) => byte === 0) &&
    (bytes[12] !== 0 || bytes[13] !== 0 || bytes[14] !== 0 || bytes[15] !== 0);
  if (compatibleV4) return true;

  const nat64 =
    byte0 === 0x00 &&
    byte1 === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (nat64) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isPrivateIpv4(embedded);
  }

  if (byte0 === 0x20 && byte1 === 0x02) {
    const embedded = `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
    return isPrivateIpv4(embedded);
  }

  return false;
}

function isPrivateIpv6(address: string): boolean {
  const bytes = ipv6LiteralToBytes(address);
  if (!bytes) return true;
  return isPrivateIpv6FromBytes(bytes);
}

/** Strip IPv6 zone id and surrounding brackets for lookup classification. */
export function stripIpBrackets(address: string): string {
  const withoutZone = address.split("%")[0] ?? "";
  return withoutZone.startsWith("[") && withoutZone.endsWith("]")
    ? withoutZone.slice(1, -1)
    : withoutZone;
}

/** True when outbound HTTPS must refuse to connect to this resolved address. */
export function isBlockedEgressAddress(address: string): boolean {
  return !isGlobalEgressAddress(address);
}
