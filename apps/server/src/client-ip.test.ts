import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable env so each test can set TRUST_PROXY_HOPS independently.
const mockEnv: { TRUST_PROXY_HOPS: number | undefined } = { TRUST_PROXY_HOPS: 0 };
vi.mock("@knowledge-base/env/server", () => ({ env: mockEnv }));

const mockLogEvent = vi.fn();
vi.mock("@knowledge-base/env/log", () => ({ logEvent: mockLogEvent }));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "10.0.0.1" } }));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: mockGetConnInfo }));

const { resolveClientIp } = await import("./client-ip.js");

function ctx(opts: { socket?: string; xff?: string }): Context {
  mockGetConnInfo.mockReturnValue({ remote: { address: opts.socket ?? "" } });
  return {
    req: {
      header: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? opts.xff : undefined),
    },
  } as unknown as Context;
}

describe("resolveClientIp (TRUST_PROXY_HOPS = 0, the default)", () => {
  beforeEach(() => {
    mockEnv.TRUST_PROXY_HOPS = 0;
  });

  it("uses the loopback socket peer in local dev (no X-Forwarded-For)", () => {
    expect(resolveClientIp(ctx({ socket: "127.0.0.1" }))).toBe("127.0.0.1");
  });

  it("ignores a spoofed X-Forwarded-For from a LAN client", () => {
    // SEC-02: a private-network caller used to pick its own bucket by sending
    // a public-looking X-Forwarded-For. With no trusted proxy it keys on the socket.
    expect(resolveClientIp(ctx({ socket: "192.168.1.20", xff: "203.0.113.9" }))).toBe(
      "192.168.1.20",
    );
    expect(
      resolveClientIp(ctx({ socket: "192.168.1.20", xff: "8.8.8.8, 10.0.0.9, 198.51.100.7" })),
    ).toBe("192.168.1.20");
  });

  it("treats an unset value like 0 (no leftmost-entry fallback)", () => {
    mockEnv.TRUST_PROXY_HOPS = undefined;
    expect(resolveClientIp(ctx({ socket: "10.0.0.5", xff: "10.0.0.9" }))).toBe("10.0.0.5");
  });

  it("keys every client on the proxy when a proxy exists but hops is 0 (shared bucket)", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }))).toBe("10.0.0.2");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.8" }))).toBe("10.0.0.2");
  });

  it("warns once when a private peer sends X-Forwarded-For (an uncounted proxy)", async () => {
    // A fresh module: the record is once per process, and earlier tests fired it.
    vi.resetModules();
    mockLogEvent.mockClear();
    const fresh = await import("./client-ip.js");
    // Public peer with a header, or a private peer without one: no record.
    fresh.resolveClientIp(ctx({ socket: "198.51.100.50", xff: "203.0.113.9" }));
    fresh.resolveClientIp(ctx({ socket: "10.0.0.2" }));
    expect(mockLogEvent).not.toHaveBeenCalled();
    fresh.resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }));
    fresh.resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.8" }));
    expect(mockLogEvent).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith("client-ip.proxy-hops");
  });

  it("returns 'unknown' when there is no socket peer", () => {
    expect(resolveClientIp(ctx({ socket: "", xff: "203.0.113.9" }))).toBe("unknown");
  });
});

describe("resolveClientIp (TRUST_PROXY_HOPS = 1, one reverse proxy)", () => {
  beforeEach(() => {
    mockEnv.TRUST_PROXY_HOPS = 1;
  });

  it("returns the client address appended by the proxy", () => {
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "198.51.100.7" }))).toBe("198.51.100.7");
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "2001:db8::5" }))).toBe("2001:db8::5");
  });

  it("is not fooled by entries the client prepended", () => {
    expect(
      resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8, 1.1.1.1 , 198.51.100.7" })),
    ).toBe("198.51.100.7");
  });

  it("keys a LAN client behind the proxy on its own address, not its spoofed header", () => {
    // LAN client 192.168.1.20 sends XFF 203.0.113.9; the proxy appends 192.168.1.20.
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9, 192.168.1.20" }))).toBe(
      "192.168.1.20",
    );
  });

  it("falls back to the socket peer, never the leftmost entry, when the chain is too short", () => {
    // A direct caller bypassing the proxy sends no header: key on its socket.
    expect(resolveClientIp(ctx({ socket: "192.168.1.20" }))).toBe("192.168.1.20");
    mockEnv.TRUST_PROXY_HOPS = 2;
    expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff: "203.0.113.9" }))).toBe("10.0.0.2");
  });

  it("falls back to the socket peer when the trusted entry is malformed", () => {
    for (const xff of ["not-an-ip", "8.8.8.8, garbage", "203.0.113.9:443", ", ,", "1.2.3.4,,"]) {
      const expected = xff === "1.2.3.4,," ? "1.2.3.4" : "10.0.0.2";
      expect(resolveClientIp(ctx({ socket: "10.0.0.2", xff })), xff).toBe(expected);
    }
  });

  it("takes exactly N from the right for a longer trusted chain", () => {
    // Cloudflare -> Traefik -> app: CF appends the client, Traefik appends CF.
    mockEnv.TRUST_PROXY_HOPS = 2;
    expect(
      resolveClientIp(ctx({ socket: "10.0.0.2", xff: "8.8.8.8, 198.51.100.7, 104.16.0.1" })),
    ).toBe("198.51.100.7");
  });
});
