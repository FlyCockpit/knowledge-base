import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

const mocks = vi.hoisted(() => ({ exchange: vi.fn(), select: vi.fn(), budget: vi.fn() }));
vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("../lib/kb/runtime", () => ({
  getKbRuntime: () => ({ canonicalOrigin: "https://kb.invalid" }),
}));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => mocks.budget }));
vi.mock("@knowledge-base/auth/device-approval", async (original) => ({
  ...(await original<typeof import("@knowledge-base/auth/device-approval")>()),
  createDeviceApprovalService: () => ({ exchange: mocks.exchange, select: mocks.select }),
}));

import { DeviceApprovalError } from "@knowledge-base/auth/device-approval";
import { cliCredentialsRouter } from "./cli-credentials";

const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const selection = {
  userCode: "ABCD1234",
  nonce,
  selection: { scopes: ["mcp:read" as const], toolGroups: ["read" as const], acl: [] },
};
const client = (session: unknown = null) =>
  createRouterClient(cliCredentialsRouter, {
    context: () => ({ session, clientIp: "127.0.0.1" }) as Context,
  });

describe("device oRPC controls", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects anonymous/PAT selection and requires second factor policy", async () => {
    await expect(client().selectDeviceIntent(selection)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      client({
        user: { id: "admin", role: "admin", createdAt: new Date(0), twoFactorEnabled: false },
      }).selectDeviceIntent(selection),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("binds selection to the cookie user and session", async () => {
    const session = {
      user: { id: "human", role: "user", twoFactorEnabled: true },
      session: { id: "session" },
    };
    await client(session).selectDeviceIntent(selection);
    expect(mocks.select).toHaveBeenCalledWith(
      { userId: "human", sessionId: "session" },
      expect.objectContaining({ nonce }),
    );
  });
  it("accepts only code/display name and charges every exchange", async () => {
    mocks.exchange.mockResolvedValue({
      credentialId: "pat",
      secret: "once",
      resource: "https://kb.invalid/mcp",
    });
    await expect(
      client().exchangeDeviceCode({ deviceCode: "test-device", name: "Laptop" }),
    ).resolves.toMatchObject({ credentialId: "pat" });
    expect(mocks.budget).toHaveBeenCalledWith("127.0.0.1");
    for (const extra of [
      { acl: [] },
      { userId: "victim" },
      { scopes: ["mcp:write"] },
      { allowCreate: true },
    ]) {
      await expect(
        client().exchangeDeviceCode({
          deviceCode: "test-device",
          name: "Laptop",
          ...extra,
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
  });
  it.each([
    "authorization_pending",
    "slow_down",
    "access_denied",
    "expired_token",
    "invalid_grant",
  ] as const)("returns typed 400 %s without private details", async (code) => {
    mocks.exchange.mockRejectedValue(new DeviceApprovalError(code));
    await expect(
      client().exchangeDeviceCode({ deviceCode: "test-device", name: "Laptop" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400, data: { error: code } });
  });
});
