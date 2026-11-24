import type { LogRecord } from "@knowledge-base/env/log";
import { createRouterClient, ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const env = vi.hoisted(() => ({}) as { SETUP_KEY?: { reveal(): string }; FORCE_SSO?: boolean });
vi.mock("@knowledge-base/env/server", () => ({
  env,
  get FORCE_SSO() {
    return env.FORCE_SSO === true;
  },
}));
const claimSetupLink = vi.hoisted(() => vi.fn());
vi.mock("../lib/setup-admin", () => ({ claimSetupLink }));
const consumeBudget = vi.hoisted(() => vi.fn());
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => consumeBudget }));

const { captureLog } = await import("@knowledge-base/env/log");
const { setupRouter } = await import("./setup");

const anonymous: Context = { session: null, clientIp: "203.0.113.9" };
const client = createRouterClient(setupRouter, { context: anonymous });
const input = { token: "tok", newPassword: "a-long-new-password" };

function code(error: unknown): string | undefined {
  return error instanceof ORPCError ? error.code : undefined;
}

let records: LogRecord[];
let restoreLog: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  env.SETUP_KEY = { reveal: () => "k".repeat(32) };
  env.FORCE_SSO = false;
  consumeBudget.mockResolvedValue(undefined);
  ({ records, restore: restoreLog } = captureLog());
});

afterEach(() => restoreLog());

function audits() {
  return records
    .filter((record) => record.site === "setup.first-admin-claim")
    .map(({ reason, userId }) => (userId ? { reason, userId } : { reason }));
}

describe("setup.claimFirstAdmin", () => {
  it("does not exist while SETUP_KEY is unset, so removing the key kills unspent links", async () => {
    delete env.SETUP_KEY;
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    expect(claimSetupLink).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
  });

  it("is a 404 before any input validation while SETUP_KEY is unset", async () => {
    delete env.SETUP_KEY;
    const malformed = { token: 42 } as unknown as typeof input;
    await expect(client.claimFirstAdmin(malformed)).rejects.toSatisfy(
      (error) => code(error) === "NOT_FOUND",
    );
    expect(records).toEqual([]);
  });

  it("charges and audits a malformed call before rejecting it", async () => {
    for (const malformed of [{ token: 42 }, { token: "", newPassword: "x" }, null]) {
      await expect(client.claimFirstAdmin(malformed as unknown as typeof input)).rejects.toSatisfy(
        (error) => code(error) === "BAD_REQUEST",
      );
    }
    expect(consumeBudget).toHaveBeenCalledTimes(3);
    expect(claimSetupLink).not.toHaveBeenCalled();
    expect(audits()).toEqual(Array(3).fill({ reason: "invalid_request" }));
  });

  it("works anonymously: the link's token is the credential", async () => {
    claimSetupLink.mockResolvedValue({ kind: "claimed", userId: "u1" });
    expect(await client.claimFirstAdmin(input)).toEqual({ success: true });
    expect(claimSetupLink).toHaveBeenCalledWith(input);
    expect(audits()).toEqual([{ reason: "claimed", userId: "u1" }]);
    // Never the token or the password.
    const text = JSON.stringify(records);
    expect(text).not.toContain('"tok"');
    expect(text).not.toContain("a-long-new-password");
  });

  it("refuses under FORCE_SSO, leaving the link unspent, and audits it", async () => {
    env.FORCE_SSO = true;
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "CONFLICT",
    );
    expect(claimSetupLink).not.toHaveBeenCalled();
    expect(audits()).toEqual([{ reason: "password_signin_disabled" }]);
  });

  it("answers SETUP_LINK_INVALID for a dead link", async () => {
    claimSetupLink.mockResolvedValue({ kind: "invalid_token" });
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "SETUP_LINK_INVALID",
    );
    expect(audits()).toEqual([{ reason: "invalid_token" }]);
  });

  it("answers BAD_REQUEST for a password outside the policy", async () => {
    claimSetupLink.mockResolvedValue({ kind: "password_too_short" });
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "BAD_REQUEST",
    );
  });

  it("charges the per-IP budget before the lookup and hash, and audits a refusal", async () => {
    consumeBudget.mockRejectedValue(new ORPCError("TOO_MANY_REQUESTS"));
    await expect(client.claimFirstAdmin(input)).rejects.toSatisfy(
      (error) => code(error) === "TOO_MANY_REQUESTS",
    );
    expect(consumeBudget).toHaveBeenCalledWith("203.0.113.9");
    expect(claimSetupLink).not.toHaveBeenCalled();
    expect(audits()).toEqual([{ reason: "rate_limited" }]);
  });

  it("audits an internal failure", async () => {
    claimSetupLink.mockRejectedValue(new Error("db down"));
    await expect(client.claimFirstAdmin(input)).rejects.toThrow();
    expect(audits()).toEqual([{ reason: "error" }]);
  });
});
