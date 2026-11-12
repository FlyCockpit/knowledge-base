import { describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({
  env: {
    DATABASE_URL: new Secret("fixture"),
    KB_DATA_ROOT: "/data-root-fixture",
    KB_MASTER_KEY: undefined,
  },
}));
vi.mock("@knowledge-base/api/lib/kb/index-build", () => ({
  runIndexBuildDelivery: vi.fn(async () => ({ skipped: true })),
}));

import { runIndexBuildDelivery } from "@knowledge-base/api/lib/kb/index-build";
import { handleIndexKbJob } from "./index-kb";

describe("index worker boundary", () => {
  it("rejects queued credentials and source overrides; forwards only the durable ID", async () => {
    const durableJobId = "00000000-0000-4000-8000-000000000001";
    expect(() =>
      handleIndexKbJob({ data: { durableJobId, providerId: "override" } } as never),
    ).toThrow();
    expect(runIndexBuildDelivery).not.toHaveBeenCalled();
    await handleIndexKbJob({ data: { durableJobId } } as never);
    expect(runIndexBuildDelivery).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        durableJobId,
        connectionString: "fixture",
        reposDir: "/data-root-fixture/repos",
        indexDir: "/data-root-fixture/index",
        workerId: expect.stringMatching(/^index-kb:/),
      }),
    );
    expect(runIndexBuildDelivery).not.toHaveBeenCalledWith(
      {},
      expect.objectContaining({ builderConnectionString: expect.anything() }),
    );
  });

  it("forwards the worker-owned Qwen embedder so SYSTEM_BUILTIN builds run in the child", async () => {
    const durableJobId = "00000000-0000-4000-8000-000000000002";
    const qwenEmbedder = { embed: vi.fn() };
    await handleIndexKbJob({ data: { durableJobId } } as never, qwenEmbedder);
    expect(runIndexBuildDelivery).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ durableJobId, qwenEmbedder }),
    );
    expect(qwenEmbedder.embed).not.toHaveBeenCalled();
  });
});
