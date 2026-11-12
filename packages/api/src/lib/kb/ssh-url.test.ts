import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import type { DnsLookupFn } from "./egress";
import { assertMirrorHostEgress, parseMirrorSshUrl } from "./ssh-url";

const ok = (raw: string) => parseMirrorSshUrl(raw).url;
const rejects = (raw: string) => expect(() => parseMirrorSshUrl(raw), raw).toThrow();

describe("strict canonical mirror SSH URL", () => {
  it("accepts the canonical ssh://git@host[:port]/owner/repo.git form", () => {
    expect(ok("ssh://git@github.com/owner/repo.git")).toBe("ssh://git@github.com/owner/repo.git");
    expect(ok("ssh://git@git.example.com:2222/a/b/c.git")).toBe(
      "ssh://git@git.example.com:2222/a/b/c.git",
    );
    const parsed = parseMirrorSshUrl("ssh://git@git.example.com:2222/team/sub/repo.git");
    expect(parsed).toMatchObject({ host: "git.example.com", port: 2222, hostIsIp: false });
    expect(parsed.path).toBe("/team/sub/repo.git");
  });

  it("canonicalizes host case and the default port", () => {
    expect(ok("ssh://git@GitHub.COM/owner/repo.git")).toBe("ssh://git@github.com/owner/repo.git");
    expect(ok("ssh://git@github.com:22/owner/repo.git")).toBe(
      "ssh://git@github.com/owner/repo.git",
    );
    expect(parseMirrorSshUrl("ssh://git@github.com/o/r.git").port).toBe(22);
  });

  it("accepts canonical IDNA A-labels and rejects raw Unicode or invalid punycode", () => {
    expect(ok("ssh://git@xn--bcher-kva.example/o/r.git")).toBe(
      "ssh://git@xn--bcher-kva.example/o/r.git",
    );
    rejects("ssh://git@bücher.example/o/r.git");
    rejects("ssh://git@xn--.example/o/r.git");
    rejects("ssh://git@exa․mple.com/o/r.git");
  });

  it("requires username exactly git and no other userinfo", () => {
    rejects("ssh://root@github.com/o/r.git");
    rejects("ssh://Git@github.com/o/r.git");
    rejects("ssh://github.com/o/r.git");
    rejects("ssh://git:pw@github.com/o/r.git");
    rejects("ssh://git@evil.com@github.com/o/r.git");
    rejects("ssh://git@github.com@evil.com/o/r.git");
  });

  it("rejects SCP syntax, other schemes and shell-option lookalikes", () => {
    rejects("git@github.com:o/r.git");
    rejects("https://github.com/o/r.git");
    rejects("git+ssh://git@github.com/o/r.git");
    rejects("SSH://git@github.com/o/r.git");
    rejects("ssh://git@-oProxyCommand=sh/o/r.git");
    rejects("-oProxyCommand=touch /tmp/pwn");
    rejects("ssh://git@github.com/-o/r.git");
    rejects("ssh://git@github.com/o/--upload-pack=x.git");
    rejects("ssh://git@github.com/o/r.git ");
    rejects(" ssh://git@github.com/o/r.git");
  });

  it("rejects ports outside 1..65535 and non-canonical port spellings", () => {
    rejects("ssh://git@github.com:0/o/r.git");
    rejects("ssh://git@github.com:65536/o/r.git");
    rejects("ssh://git@github.com:0022/o/r.git");
    rejects("ssh://git@github.com:/o/r.git");
    rejects("ssh://git@github.com:+22/o/r.git");
    expect(ok("ssh://git@github.com:65535/o/r.git")).toBe("ssh://git@github.com:65535/o/r.git");
    expect(ok("ssh://git@github.com:1/o/r.git")).toBe("ssh://git@github.com:1/o/r.git");
  });

  it("enforces 2..8 path segments, 512 bytes, the segment alphabet and a .git suffix", () => {
    rejects("ssh://git@github.com/r.git");
    rejects("ssh://git@github.com/");
    rejects("ssh://git@github.com");
    rejects(`ssh://git@github.com/${"a/".repeat(8)}r.git`);
    expect(ok(`ssh://git@github.com/${"a/".repeat(7)}r.git`)).toContain("/r.git");
    rejects(`ssh://git@github.com/${"a".repeat(510)}/r.git`);
    rejects("ssh://git@github.com/o/r");
    rejects("ssh://git@github.com/o/.git");
    rejects("ssh://git@github.com/o/r.git/");
    rejects("ssh://git@github.com//r.git");
    rejects("ssh://git@github.com/./r.git");
    rejects("ssh://git@github.com/../r.git");
    rejects("ssh://git@github.com/o/../r.git");
    rejects("ssh://git@github.com/o~x/r.git");
    rejects("ssh://git@github.com/o/r$x.git");
    rejects("ssh://git@github.com/o/r`id`.git");
    rejects("ssh://git@github.com/o/r;id.git");
  });

  it("rejects percent escapes, query, fragment, quotes, backslashes and controls", () => {
    for (const bad of [
      "ssh://git@github.com/o/r%2e.git",
      "ssh://git@github.com/o/r.git?x=1",
      "ssh://git@github.com/o/r.git#frag",
      "ssh://git@github.com/o/'r'.git",
      'ssh://git@github.com/o/"r".git',
      "ssh://git@github.com/o\\r.git",
      "ssh://git@github.com/o/r\n.git",
      "ssh://git@github.com/o/r\t.git",
      "ssh://git@github.com/o/r\u0000.git",
      "ssh://git@github.com/o/r\u007f.git",
      "ssh://git@github.com/o/r .git",
    ])
      rejects(bad);
  });

  it("rejects private, loopback and IPv4-mapped host literals via the shared egress policy", () => {
    for (const bad of [
      "ssh://git@127.0.0.1/o/r.git",
      "ssh://git@10.0.0.5/o/r.git",
      "ssh://git@192.168.1.1/o/r.git",
      "ssh://git@169.254.169.254/o/r.git",
      "ssh://git@[::1]/o/r.git",
      "ssh://git@[::ffff:127.0.0.1]/o/r.git",
      "ssh://git@[::ffff:7f00:1]/o/r.git",
      "ssh://git@[fd00::1]/o/r.git",
      "ssh://git@localhost/o/r.git",
      "ssh://git@repo.localhost/o/r.git",
    ])
      rejects(bad);
  });

  it("tells private-network hosts apart from malformed URLs (R2-18)", () => {
    const reason = (raw: string) => {
      try {
        parseMirrorSshUrl(raw);
      } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason ?? null;
      }
      return "accepted";
    };
    expect(reason("ssh://git@127.0.0.1:2222/e2e/mirror.git")).toBe("PRIVATE_NETWORK_HOST");
    expect(reason("ssh://git@[fd00::1]/o/r.git")).toBe("PRIVATE_NETWORK_HOST");
    expect(reason("ssh://git@repo.localhost/o/r.git")).toBe("PRIVATE_NETWORK_HOST");
    expect(reason("ssh://git@github.com/o/r")).toBeNull();
    expect(reason("ssh://git@127.1/o/r.git")).toBeNull();
  });

  it("rejects ambiguous numeric hostnames that inet_aton would reinterpret", () => {
    rejects("ssh://git@127.1/o/r.git");
    rejects("ssh://git@0x7f000001/o/r.git");
    rejects("ssh://git@2130706433/o/r.git");
    rejects("ssh://git@010.0.0.1/o/r.git");
  });

  it("accepts public IP literals in canonical form", () => {
    expect(ok("ssh://git@93.184.216.9/o/r.git")).toBe("ssh://git@93.184.216.9/o/r.git");
    const v6 = parseMirrorSshUrl("ssh://git@[2001:4860:4860::8888]:2222/o/r.git");
    expect(v6.hostIsIp).toBe(true);
    expect(v6.url).toBe("ssh://git@[2001:4860:4860::8888]:2222/o/r.git");
    rejects("ssh://git@[2001:4860:4860:0:0:0:0:8888]/o/r.git");
    rejects("ssh://git@[fe80::1%25eth0]/o/r.git");
  });

  it("rejects labels violating LDH and length rules", () => {
    rejects("ssh://git@-bad.example/o/r.git");
    rejects("ssh://git@bad-.example/o/r.git");
    rejects("ssh://git@bad_host.example/o/r.git");
    rejects(`ssh://git@${"a".repeat(64)}.example/o/r.git`);
    rejects("ssh://git@example..com/o/r.git");
    rejects("ssh://git@example.com./o/r.git");
  });
});

function lookupReturning(addresses: string[]): DnsLookupFn {
  return ((_host: string, _opts: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) =>
    cb(
      null,
      addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    )) as unknown as DnsLookupFn;
}

describe("mirror host resolution uses the shared egress policy", () => {
  const parsed = parseMirrorSshUrl("ssh://git@git.example.com/o/r.git");
  it("rejects a DNS name resolving to any private or mapped address", async () => {
    await expect(assertMirrorHostEgress(parsed, lookupReturning(["10.1.2.3"]))).rejects.toThrow();
    await expect(
      assertMirrorHostEgress(parsed, lookupReturning(["93.184.216.4", "::ffff:127.0.0.1"])),
    ).rejects.toThrow();
    await expect(assertMirrorHostEgress(parsed, lookupReturning([]))).rejects.toThrow();
    await expect(
      assertMirrorHostEgress(parsed, lookupReturning(["10.1.2.3"])),
    ).rejects.toMatchObject({ details: { reason: "PRIVATE_NETWORK_HOST" } });
    await expect(assertMirrorHostEgress(parsed, lookupReturning([]))).rejects.toMatchObject({
      details: {},
    });
  });
  it("accepts a name resolving only to public addresses", async () => {
    await expect(
      assertMirrorHostEgress(parsed, lookupReturning(["93.184.216.4"])),
    ).resolves.toBeUndefined();
  });
  it("does not perform DNS for a validated public IP literal", async () => {
    const literal = parseMirrorSshUrl("ssh://git@93.184.216.9/o/r.git");
    const lookup = (() => {
      throw new Error("no DNS for literals");
    }) as unknown as DnsLookupFn;
    await expect(assertMirrorHostEgress(literal, lookup)).resolves.toBeUndefined();
  });
});
