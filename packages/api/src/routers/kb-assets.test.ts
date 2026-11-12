import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => async () => {} }));

import { kbAssetsRouter } from "./kb-assets";

const kbId = "a".repeat(24);
const mutation = {
  kbId,
  baseRevision: "a".repeat(40),
  idempotencyKey: "asset-test-key-01",
  path: "media/a.png",
};
describe("asset router authentication", () => {
  it("denies all three asset entry points without browser identity", async () => {
    const client = createRouterClient(kbAssetsRouter, { context: () => ({ session: null }) });
    for (const result of [
      client.list({ kbId }),
      client.put({ ...mutation, uploadId: "00000000-0000-4000-8000-000000000000" }),
      client.import({
        ...mutation,
        source: { kbId, rev: "b".repeat(40), hash: `sha256:${"c".repeat(64)}` },
      }),
    ]) {
      await expect(result).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});
