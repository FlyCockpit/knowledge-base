import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import type { Context } from "../context";

const service = vi.hoisted(() => ({ prepare: vi.fn(), review: vi.fn(), approve: vi.fn() }));
vi.mock("@knowledge-base/auth/mcp-consent", async (original) => ({
  ...(await original<typeof import("@knowledge-base/auth/mcp-consent")>()),
  createMcpConsentService: () => service,
}));
vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@knowledge-base/env/server", () => ({
  env: { BETTER_AUTH_SECRET: new Secret("router-fixture"), BETTER_AUTH_URL: "https://kb.invalid" },
}));
vi.mock("../lib/kb/runtime", () => ({
  getKbRuntime: () => ({ canonicalOrigin: "https://kb.invalid" }),
}));

import { mcpConsentRouter } from "./mcp-consent";

const session = {
  session: {
    session: { id: "session" },
    user: { id: "owner", role: "user", twoFactorEnabled: true },
  },
};
const approval = {
  referenceId: "a".repeat(64),
  nonce: "77653aab-971d-43f7-9e39-1dfb1556f212",
  oauthQuery: "signed",
  selection: { scopes: ["mcp:read" as const], toolGroups: ["read" as const], acl: [] },
  explicitConsent: true,
};
describe("consent human procedures", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects anonymous and bearer-only callers before touching consent", async () => {
    for (const context of [
      { session: null },
      { session: null, headers: new Headers({ authorization: "Bearer fixture" }) },
    ]) {
      const client = createRouterClient(mcpConsentRouter, { context: () => context as Context });
      await expect(client.prepare({ oauthQuery: "signed" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(client.approve(approval)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.review).not.toHaveBeenCalled();
    expect(service.approve).not.toHaveBeenCalled();
  });
  it("requires forced 2FA", async () => {
    const client = createRouterClient(mcpConsentRouter, {
      context: () =>
        ({
          session: {
            user: { id: "admin", role: "admin", twoFactorEnabled: false, createdAt: new Date(0) },
          },
        }) as Context,
    });
    await expect(client.approve(approval)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(service.approve).not.toHaveBeenCalled();
  });
  it("uses session identity, rejects forged top-level fields and a missing ACL", async () => {
    const client = createRouterClient(mcpConsentRouter, { context: () => session as Context });
    for (const extra of [
      { clientId: "evil" },
      { redirectUri: "https://evil.invalid" },
      { userId: "victim" },
      { acl: [] },
    ])
      await expect(client.approve({ ...approval, ...extra })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    await expect(
      client.approve({ ...approval, selection: { scopes: ["mcp:read"] } } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    service.approve.mockResolvedValue({ grantId: "generation" });
    await expect(client.approve(approval)).resolves.toMatchObject({ grantId: "generation" });
    expect(service.approve.mock.calls[0]?.[0]).toEqual({ userId: "owner", sessionId: "session" });
  });
  it("prepare returns the server-validated review projection for the session user", async () => {
    const review = {
      referenceId: "a".repeat(64),
      nonce: approval.nonce,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      client: { clientId: "client", name: "Client", uri: null },
      redirectUri: "https://client.invalid/cb",
      resource: "https://kb.invalid/mcp",
      scopes: ["mcp:read"],
      previousGrantId: null,
    };
    service.review.mockResolvedValue(review);
    const client = createRouterClient(mcpConsentRouter, { context: () => session as Context });
    await expect(client.prepare({ oauthQuery: "signed" })).resolves.toEqual(review);
    expect(service.review).toHaveBeenCalledWith(
      { userId: "owner", sessionId: "session" },
      "signed",
    );
  });
  it("maps an invalid or expired signed request to BAD_REQUEST", async () => {
    const { McpConsentError } = await import("@knowledge-base/auth/mcp-consent");
    service.review.mockRejectedValue(new McpConsentError());
    const client = createRouterClient(mcpConsentRouter, { context: () => session as Context });
    await expect(client.prepare({ oauthQuery: "signed" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
  it("a sealed request reaches the service and comes back as a typed BAD_REQUEST", async () => {
    const { McpSealedConsentError } = await import("@knowledge-base/auth/mcp-consent");
    service.approve.mockRejectedValue(new McpSealedConsentError());
    const client = createRouterClient(mcpConsentRouter, { context: () => session as Context });
    const sealed = {
      ...approval,
      selection: { ...approval.selection, recipients: [{ kbId: "x" }] },
    };
    await expect(client.approve(sealed)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Sealed values require the CLI or a personal access token.",
      data: { reason: "SEALED_VALUES_REQUIRE_CLI_OR_PAT" },
    });
    expect(service.approve.mock.calls[0]?.[1]).toMatchObject({
      selection: { recipients: [{ kbId: "x" }] },
    });
  });
});
