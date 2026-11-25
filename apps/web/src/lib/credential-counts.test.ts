import { describe, expect, it } from "vitest";
import { activeTokenCount, hasLiveCredentials } from "./credential-counts";

describe("hasLiveCredentials", () => {
  const none = { tokens: 0, apps: 0, apiKeys: 0, childTokens: 0 };

  it("is false with nothing live or nothing loaded", () => {
    expect(hasLiveCredentials(undefined)).toBe(false);
    expect(hasLiveCredentials(none)).toBe(false);
  });

  it("counts every family, including child tokens that outlived their API key", () => {
    expect(hasLiveCredentials({ ...none, tokens: 1 })).toBe(true);
    expect(hasLiveCredentials({ ...none, apps: 1 })).toBe(true);
    expect(hasLiveCredentials({ ...none, apiKeys: 1 })).toBe(true);
    expect(hasLiveCredentials({ ...none, childTokens: 1 })).toBe(true);
  });
});

describe("activeTokenCount", () => {
  it("adds MCP tokens minted by API keys to personal access tokens", () => {
    expect(activeTokenCount({ tokens: 2, apps: 5, apiKeys: 1, childTokens: 3 })).toBe(5);
  });
});
