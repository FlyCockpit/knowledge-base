import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import {
  AccountDeletionBlockedError,
  listAccountTeardownHandlersForTests,
  mapAccountDeletionError,
  removeUserAccount,
} from "./account-removal";
import type { LockQuery } from "./lock";
import type { KbRuntimeConfig } from "./runtime";

describe("account removal registry", () => {
  it("exposes teardown handlers for future providers and jobs", () => {
    expect(listAccountTeardownHandlersForTests().length).toBeGreaterThanOrEqual(1);
  });

  it("maps blocked deletion to domain conflict", () => {
    const mapped = mapAccountDeletionError(new AccountDeletionBlockedError());
    expect(mapped?.code).toBe("CONFLICT");
  });
});

it("account teardown shares the last-admin guard inside its default READ COMMITTED reservation before credential deletion", async () => {
  const runtime = mockDeep<KbRuntimeConfig>();
  runtime.prisma.knowledgeBase.count.mockResolvedValue(0);
  runtime.prisma.knowledgeBase.findMany.mockResolvedValue([]);
  const query = vi.fn<LockQuery>().mockImplementation(async <R>(sql: string) => ({
    rows: (sql.includes("SELECT id, role")
      ? [{ id: "target", role: "admin", emailVerified: true, banned: false }]
      : [{ count: 1 }]) as R[],
    rowCount: 1,
  }));
  runtime.coordinator.run.mockImplementation(async (options) => {
    expect(options.barrier?.isolationLevel).toBeUndefined();
    await options.barrier?.reservePublication({ query, signal: new AbortController().signal });
    throw new Error("guard should have refused before deletion");
  });
  await expect(
    removeUserAccount(runtime, "target", { actingUserId: "actor" }),
  ).rejects.toMatchObject({ data: { reason: "LAST_ACTIVE_ADMIN" } });
  expect(query.mock.calls.some(([sql]) => /^\s*(DELETE|UPDATE|INSERT)\b/.test(sql))).toBe(false);
});
