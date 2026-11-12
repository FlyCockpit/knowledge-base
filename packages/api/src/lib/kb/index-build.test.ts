import type { PrismaClient } from "@knowledge-base/db/client";
import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import { INDEX_TEXT_RESERVATION_BYTES, runIndexBuildDelivery } from "./index-build";
import { KB_TREE_LIMITS } from "./limits";

vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));

describe("index build delivery", () => {
  it("ignores absent or wrong-kind delivery without opening Git, a file or a database connection", async () => {
    const db = mockDeep<PrismaClient>();
    db.durableJob.findUnique.mockResolvedValue(null);
    expect(
      await runIndexBuildDelivery(db, {
        connectionString: "must-not-connect",
        reposDir: "must-not-read",
        indexDir: "must-not-write",
        masterKey: undefined,
        workerId: "test",
        durableJobId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({ skipped: true });
  });

  it("starts pass 1 with four times the largest admitted Markdown tree reserved", () => {
    expect(INDEX_TEXT_RESERVATION_BYTES).toBe(4 * KB_TREE_LIMITS.maxTreeBytes);
  });
});
