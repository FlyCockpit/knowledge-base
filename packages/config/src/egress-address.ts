import { isIP } from "node:net";

type Prefix = readonly [string, number];
// IANA special-purpose registries, checked 2026-10-08:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Egress requires global unicast. Do not use this as a trusted-proxy predicate.
const blockedV4: readonly Prefix[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
];
const publicIetfV6: readonly Prefix[] = [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
];

function numeric(address: string, family: number): bigint {
  if (family === 4)
    return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  // URL normalizes dotted IPv4 tails to hextets after isIP validates syntax.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left = "", right = ""] = normalized.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const groups = normalized.includes("::")
    ? [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end]
    : start;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}
function within(value: bigint, family: number, [address, bits]: Prefix): boolean {
  const shift = BigInt((family === 4 ? 32 : 128) - bits);
  return value >> shift === numeric(address, family) >> shift;
}
function publicV4(value: bigint): boolean {
  if (value === numeric("192.0.0.9", 4) || value === numeric("192.0.0.10", 4)) return true;
  return !blockedV4.some((prefix) => within(value, 4, prefix));
}

/** Fail closed on malformed, scoped, reserved and non-global destinations. */
export function isGlobalEgressAddress(address: string): boolean {
  const literal = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(literal);
  if (family === 0 || literal.includes("%")) return false;
  const value = numeric(literal, family);
  if (family === 4) return publicV4(value);
  // IPv4-mapped and well-known NAT64 must pass the embedded IPv4 policy.
  if (within(value, 6, ["::ffff:0:0", 96]) || within(value, 6, ["64:ff9b::", 96]))
    return publicV4(value & 0xffffffffn);
  // Other translation forms, Teredo and 6to4 have no positive global bound.
  if (!within(value, 6, ["2000::", 3])) return false;
  if (within(value, 6, ["2001::", 23]))
    return publicIetfV6.some((prefix) => within(value, 6, prefix));
  return !(
    [
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ] as const
  ).some((prefix) => within(value, 6, prefix));
}
