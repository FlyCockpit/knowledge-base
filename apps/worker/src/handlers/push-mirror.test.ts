import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import {
  claimJobAttempt,
  completeJobAttempt,
  heartbeatJobAttempt,
} from "@knowledge-base/api/lib/kb/jobs";
import prisma from "@knowledge-base/db";
import type { DurableJob, MirrorAttempt, PrismaClient } from "@knowledge-base/db/client";
import { pushMirrorJobSchema } from "@knowledge-base/queue/jobs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import { runMirrorDelivery } from "./push-mirror";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep<PrismaClient>() };
});
vi.mock("@knowledge-base/queue", () => ({}));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
vi.mock("@knowledge-base/api/lib/kb/authority-lock", () => ({ runLockedOperation: vi.fn() }));
vi.mock("@knowledge-base/api/lib/kb/jobs", () => ({
  claimJobAttempt: vi.fn(),
  completeJobAttempt: vi.fn(),
  failJobAttempt: vi.fn(),
  heartbeatJobAttempt: vi.fn(),
}));
vi.mock("@knowledge-base/api/lib/kb/deploy-key", () => ({ decryptDeployKey: vi.fn() }));
vi.mock("@knowledge-base/api/lib/kb/envelope", () => ({ requireKbMasterKey: vi.fn() }));
vi.mock("@knowledge-base/api/lib/kb/git-read", () => ({ kbBareRepoPath: vi.fn() }));
vi.mock("@knowledge-base/api/lib/kb/mirror", () => ({
  finishMirrorAttempt: vi.fn(),
  reserveMirrorAttempt: vi.fn(),
}));
vi.mock("../lib/mirror-ssh", () => ({
  MIRROR_TMPFS: "/unused",
  MirrorDrainError: class MirrorDrainError extends Error {},
  recoverMirrorScratch: vi.fn(),
  runMirrorSsh: vi.fn(),
}));

describe("mirror monitoring", () => {
  const db = vi.mocked(prisma, true);
  beforeEach(() => {
    vi.clearAllMocks();
    mockReset(db);
    vi.mocked(claimJobAttempt).mockResolvedValue(
      mockDeep<DurableJob>({
        id: "j1",
        kind: "PUSH_MIRROR",
        desired: { action: "PUSH" },
        attemptEpoch: 1,
      }),
    );
    db.mirrorAttempt.findUniqueOrThrow.mockResolvedValue(
      mockDeep<MirrorAttempt>({
        id: "j1",
        kbId: "kb1",
      }),
    );
    vi.mocked(heartbeatJobAttempt).mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips slow heartbeat ticks without replay and drains the pending monitor on cleanup", async () => {
    vi.useFakeTimers();
    let renew = (_live: boolean) => {};
    vi.mocked(heartbeatJobAttempt).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          renew = resolve;
        }),
    );
    let finish = () => {};
    vi.mocked(runLockedOperation)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    db.kbRemote.findUnique.mockResolvedValue(null);
    let settled = false;
    const pending = runMirrorDelivery(db, {
      durableJobId: "j1",
      workerId: "w1",
      connectionString: "unused",
      reposDir: "/unused",
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(1);
    renew(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(db.kbRemote.findUnique).toHaveBeenCalledTimes(1);
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(runLockedOperation).toHaveBeenCalledTimes(1);
    expect(completeJobAttempt).not.toHaveBeenCalled();
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(2);
    renew(true);
    await pending;
    expect(db.kbRemote.findUnique).toHaveBeenCalledTimes(2);
    expect(completeJobAttempt).toHaveBeenCalledTimes(1);
  });
});

import { generateDokployCompose } from "../../../../scripts/generate-dokploy-config";

describe("mirror worker wiring", () => {
  // Static policy inputs are collected before the timed assertions.
  const root = resolve(import.meta.dirname, "../../../..");
  const workerConfig = readFileSync(joinRoot(root, "apps/worker/tsdown.config.ts"), "utf8");
  const workerImage = readFileSync(joinRoot(root, "Dockerfile.worker"), "utf8");
  const deployments = [
    generateDokployCompose({
      environment: "development",
      gitRef: "main",
      url: "https://dev.example.com",
    }),
    readFileSync(joinRoot(root, "docker-compose.agent.yml"), "utf8"),
  ];

  it("queues IDs only, never private keys or a caller-selected remote", () => {
    const durableJobId = "b3c80336-2486-4ac2-8abf-04b0d7b287bc";
    expect(pushMirrorJobSchema.parse({ durableJobId })).toEqual({ durableJobId });
    expect(
      pushMirrorJobSchema.safeParse({ durableJobId, url: "ssh://evil", key: "secret" }).success,
    ).toBe(false);
  });
  it("bundles the wrapper explicitly and supplies tmpfs and the one data volume", () => {
    expect(workerConfig).toContain('"ssh-wrapper"');
    expect(workerImage).toContain("dist/ssh-wrapper.mjs");
    for (const source of deployments) {
      // The worker mounts the data volume read-write.
      const worker = source.split(/\n {2}worker(?:-dev)?:\n/)[1]!.split(/^ {2}[a-z][a-z-]*:/m)[0]!;
      expect(worker).toContain("kb-data:/var/lib/knowledge-base\n");
      expect(worker).toContain("/run/kb-mirror");
    }
  });
});
function joinRoot(root: string, file: string) {
  return resolve(root, file);
}
