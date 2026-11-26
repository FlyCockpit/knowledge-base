import { describe, expect, it } from "vitest";
import { hasConnectedClient, hasLiveCredentials } from "./credential-counts";

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

describe("hasConnectedClient", () => {
  const none = { tokens: 0, apps: 0, apiKeys: 0, childTokens: 0 };

  it("is true with any live MCP credential: token, key-minted token or connected app", () => {
    expect(hasConnectedClient({ ...none, tokens: 1 })).toBe(true);
    expect(hasConnectedClient({ ...none, childTokens: 1 })).toBe(true);
    expect(hasConnectedClient({ ...none, apps: 1 })).toBe(true);
  });

  it("is false with nothing live, or only an API key (REST, not an MCP client)", () => {
    expect(hasConnectedClient(none)).toBe(false);
    expect(hasConnectedClient({ ...none, apiKeys: 2 })).toBe(false);
  });
});
