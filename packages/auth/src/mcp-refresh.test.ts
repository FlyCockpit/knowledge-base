import { describe, expect, it, vi } from "vitest";
import {
  MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
  MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
  MCP_REFRESH_RETRY_WINDOW_SECONDS,
  refreshExpiry,
  reserveDpopProof,
} from "./mcp-refresh";

describe("consent refresh policy", () => {
  it("pins 10m access, 72h sliding refresh and upstream 30s retry", () => {
    expect(MCP_ACCESS_TOKEN_LIFETIME_SECONDS).toBe(600);
    expect(MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS).toBe(259200);
    expect(MCP_REFRESH_RETRY_WINDOW_SECONDS).toBe(30);
    const now = new Date("2026-09-26T00:00:00Z");
    expect(refreshExpiry(now).getTime() - now.getTime()).toBe(72 * 3600_000);
    expect(refreshExpiry(new Date(now.getTime() + 1000)).getTime()).toBe(
      refreshExpiry(now).getTime() + 1000,
    );
  });
  it("reserves replay through verifier expiry plus 1s, including long verifier windows", async () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const expiry = new Date(now.getTime() + 7200_000);
    const stored = new Map<string, Date>();
    const reserve = vi.fn(async (key: string, until: Date) => {
      if (stored.has(key)) return false;
      stored.set(key, until);
      return true;
    });
    await expect(reserveDpopProof("proof-digest", expiry, reserve, now)).resolves.toBeUndefined();
    expect(stored.get("proof-digest")?.getTime()).toBe(expiry.getTime() + 1000);
    await expect(reserveDpopProof("proof-digest", expiry, reserve, now)).rejects.toThrow();
    await expect(reserveDpopProof("other", new Date(0), reserve, now)).rejects.toThrow();
    expect(reserve).toHaveBeenCalledTimes(2);
  });
});
