import { describe, expect, it } from "vitest";
import { isBlockedEgressAddress, isPrivateIp } from "./private-ip.js";

describe("isPrivateIp (IPv4)", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
  ])("treats %s as private", (ip) => {
    expect(isPrivateIp(ip, 4)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "203.0.113.10", "198.51.100.7", "172.32.0.1"])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateIp(ip, 4)).toBe(false);
    },
  );

  it("fails closed on malformed input", () => {
    expect(isPrivateIp("not-an-ip", 4)).toBe(true);
    expect(isPrivateIp("999.1.1.1", 4)).toBe(true);
  });
});

describe("isPrivateIp (IPv6)", () => {
  it.each(["::", "::1", "fc00::1", "fd12:3456::1"])("treats %s as private", (ip) => {
    expect(isPrivateIp(ip, 6)).toBe(true);
  });

  it.each([
    "fe80::1",
    "fe90::1",
    "fea0::1",
    "feb0::1",
    "febf::1",
    "fec0::1",
    "fec1::1",
    "fed0::1",
    "feff::1",
  ])("treats the full fe80::/10 and fec0::/10 ranges (%s) as private", (ip) => {
    expect(isPrivateIp(ip, 6)).toBe(true);
  });

  it("keeps the fec0::/10 site-local boundaries exact", () => {
    // fe7f:: is below fe80::/10 — global-unicast territory, stays public.
    expect(isPrivateIp("fe7f::1", 6)).toBe(false);
    expect(isPrivateIp("fe7f:ffff::1", 6)).toBe(false);
    // Expanded spellings of fec0::1 and feff::1 must classify identically.
    expect(isPrivateIp("fec0:0:0:0:0:0:0:1", 6)).toBe(true);
    expect(isPrivateIp("fec0:0000:0000:0000:0000:0000:0000:0001", 6)).toBe(true);
    expect(isPrivateIp("feff:0000::1", 6)).toBe(true);
    expect(isPrivateIp("fe7f:0:0:0:0:0:0:1", 6)).toBe(false);
    // Leading zeros change the value, not the classification: 0x0fec is not
    // in fec0::/10, so its dotted-compressed spelling stays public.
    expect(isPrivateIp("0fec:0c00::1", 6)).toBe(false);
  });

  it.each(["::127.0.0.1", "::10.0.0.1", "::169.254.169.254", "::a9fe:a9fe", "::7f00:1", "::2"])(
    "rejects the deprecated IPv4-compatible form %s",
    (ip) => {
      expect(isPrivateIp(ip, 6)).toBe(true);
    },
  );

  it("strips a zone id before classifying", () => {
    expect(isPrivateIp("fe80::1%eth0", 6)).toBe(true);
  });

  it.each([
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:172.16.0.1",
    "::ffff:169.254.169.254",
    "::ffff:100.64.0.1",
    "::ffff:198.18.0.1",
  ])("unwraps IPv4-mapped %s and blocks it", (ip) => {
    expect(isPrivateIp(ip, 6)).toBe(true);
  });

  it("unwraps the all-hex IPv4-mapped form (::ffff:a9fe:a9fe = 169.254.169.254)", () => {
    expect(isPrivateIp("::ffff:a9fe:a9fe", 6)).toBe(true);
    expect(isPrivateIp("::ffff:ac10:0001", 6)).toBe(true);
  });

  it("classifies uncompressed dotted-tail spellings identically to compressed ones", () => {
    // A dotted IPv4 tail may close an uncompressed address too. Before the
    // tail was parsed in both forms, valid public addresses like
    // 0:0:0:0:0:ffff:8.8.8.8 failed the hextet count and were classified as
    // private — letting the client-IP walk skip a real public hop as trusted
    // infra.
    expect(isPrivateIp("0:0:0:0:0:ffff:8.8.8.8", 6)).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8", 6)).toBe(false);
    // A `::` that spells all 8 groups is not a valid literal (isIP rejects
    // it) — it must still fail closed, never classify as public.
    expect(isPrivateIp("::0:0:0:0:0:ffff:8.8.8.8", 6)).toBe(true);
    expect(isPrivateIp("0:0:0:0:0:ffff:127.0.0.1", 6)).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isPrivateIp("0:0:0:0:0:ffff:169.254.169.254", 6)).toBe(true);
    expect(isPrivateIp("0:0:0:0:0:0:0:1", 6)).toBe(true);
    // NAT64 spellings: embedded public stays public, embedded private blocks.
    expect(isPrivateIp("64:ff9b:0:0:0:0:8.8.8.8", 6)).toBe(false);
    expect(isPrivateIp("64:ff9b::8.8.8.8", 6)).toBe(false);
    expect(isPrivateIp("64:ff9b:0:0:0:0:10.0.0.1", 6)).toBe(true);
    expect(isPrivateIp("64:ff9b::10.0.0.1", 6)).toBe(true);
    // A plain global unicast closed by a dotted tail must stay public.
    expect(isPrivateIp("1:2:3:4:5:6:1.2.3.4", 6)).toBe(false);
    // A malformed dotted tail still fails closed.
    expect(isPrivateIp("0:0:0:0:0:ffff:8.8.8", 6)).toBe(true);
  });

  it.each(["2001:db8::5", "2606:4700::1111", "::ffff:8.8.8.8", "::ffff:0808:0808"])(
    "treats public address %s as public",
    (ip) => {
      expect(isPrivateIp(ip, 6)).toBe(false);
    },
  );
});

describe("isBlockedEgressAddress", () => {
  it.each([
    "127.0.0.1",
    "[::ffff:7f00:1]",
    "169.254.169.254",
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:ffff:7f00:1",
    "0:0:0:0:0:ffff:169.254.169.254",
    "fec0::1",
    "fec1::1",
    "feff::1",
    "ff02::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "::169.254.169.254",
    "::a9fe:a9fe",
    "100:0:0:1::1",
    "2001:100::1",
    "2001:1::4",
    "2001:2::1",
    "2001:10::1",
    "2001::1",
    "2001:db8::1",
    "3fff::1",
    "5f00::1",
    "64:ff9b:1::1",
    "2002:0808:0808::1",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.2",
    "198.51.100.1",
    "203.0.113.1",
    "::ffff:192.0.2.1",
    "64:ff9b::c000:201",
    "not-an-ip",
    "8.8.8.8%eth0",
  ])("blocks %s", (address) => {
    expect(isBlockedEgressAddress(address)).toBe(true);
  });
  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "0:0:0:0:0:ffff:8.8.8.8",
    "[2606:4700::1111]",
    "192.0.0.9",
    "192.0.0.10",
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "2001:1::1",
    "2001:1::2",
    "2001:1::3",
    "2001:3::1",
    "2001:4:112::1",
    "2001:20::1",
    "2001:30::1",
    "2620:4f:8000::1",
    "64:ff9b::808:808",
  ])("allows %s", (address) => {
    expect(isBlockedEgressAddress(address)).toBe(false);
  });
});

describe("isPrivateIp (unknown family)", () => {
  it("fails closed", () => {
    expect(isPrivateIp("8.8.8.8", 0)).toBe(true);
  });
});
