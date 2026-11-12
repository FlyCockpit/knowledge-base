import type { PrismaClient } from "@knowledge-base/db/client";
import { describe, expect, it, vi } from "vitest";
import { createSessionCacheVersion } from "./session-authority";

type Row = { identity: string | null; authorityVersion: number | null };

function versionOver(...rows: Row[]) {
  const $queryRaw = vi.fn();
  for (const row of rows) $queryRaw.mockResolvedValueOnce([row]);
  return {
    $queryRaw,
    version: createSessionCacheVersion({ $queryRaw } as unknown as Pick<PrismaClient, "$queryRaw">),
  };
}

const session = { token: "tok", userId: "u1" };
const user = (authorityVersion: unknown) => ({ id: "u1", authorityVersion });

describe("session cache version", () => {
  it("is the durable epoch while the snapshot is current, so the cache is reused", async () => {
    const { version, $queryRaw } = versionOver(
      { identity: null, authorityVersion: 3 },
      { identity: '{"authorityEpoch":"2"}', authorityVersion: 3 },
      { identity: '{"authorityEpoch":"2"}', authorityVersion: 3 },
    );
    expect(await version(session, user(3))).toBe("1");
    expect(await version(session, user(3))).toBe("2");
    expect(await version(session, user(3))).toBe("2");
    expect($queryRaw.mock.calls[0]).toEqual(expect.arrayContaining(["tok", "u1"]));
  });

  it.each(["{}", '{"authorityEpoch":1}', '{"authorityEpoch":"0"}', "invalid"])(
    "fails closed for malformed durable identity %s",
    async (identity) => {
      const { version } = versionOver({ identity, authorityVersion: 1 });
      await expect(version(session, user(1))).rejects.toThrow();
    },
  );

  // Race 1: the session row is deleted (reset, revoke, ban, archive) between
  // Better Auth loading the snapshot and stamping it. Race 2: the user changes
  // (demotion, ban, 2FA, grace start) in that window. Either way the stamped
  // value is a nonce no later read can reproduce.
  it.each([
    ["the session row is gone", { identity: null, authorityVersion: null }, 3],
    ["the live user moved on", { identity: null, authorityVersion: 4 }, 3],
    ["the snapshot predates the version field", { identity: null, authorityVersion: 0 }, undefined],
  ] as const)("never yields a reusable value when %s", async (_name, row, snapshot) => {
    const { version } = versionOver(row, row);
    const written = await version(session, user(snapshot));
    const read = await version(session, user(snapshot));
    expect(written).toMatch(/^stale\./);
    expect(read).not.toBe(written);
  });

  it("refuses a session snapshot that belongs to another user", async () => {
    const { version } = versionOver({ identity: null, authorityVersion: 1 });
    expect(await version({ token: "tok", userId: "u2" }, user(1))).toMatch(/^stale\./);
  });
});
