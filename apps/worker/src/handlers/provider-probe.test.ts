import { describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({
  env: { DATABASE_URL: new Secret("fixture-db"), KB_MASTER_KEY: new Secret("fixture-key") },
}));
vi.mock("@knowledge-base/api/lib/kb/embedder", () => ({
  runProviderProbeDelivery: vi.fn(async () => ({ skipped: true })),
}));

import { runProviderProbeDelivery } from "@knowledge-base/api/lib/kb/embedder";
import { handleProviderProbeJob } from "./provider-probe";

describe("provider worker entry", () => {
  it("accepts IDs only and passes worker-owned credentials separately", async () => {
    const durableJobId = "550e8400-e29b-41d4-a716-446655440000";
    await expect(
      handleProviderProbeJob({ data: { durableJobId, apiKey: "must-not-queue" } } as never),
    ).rejects.toThrow();
    expect(runProviderProbeDelivery).not.toHaveBeenCalled();
    expect(await handleProviderProbeJob({ data: { durableJobId } } as never)).toEqual({
      skipped: true,
    });
    expect(runProviderProbeDelivery).toHaveBeenCalledWith(
      {},
      {
        durableJobId,
        workerId: expect.stringMatching(/^provider-probe:/),
        connectionString: "fixture-db",
        masterKey: "fixture-key",
      },
    );
  });
});
