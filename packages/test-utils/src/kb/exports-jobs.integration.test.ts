/**
 * Background export jobs on real PostgreSQL/Git/CAS: start returns at once,
 * the server-owned build reports progress, and every terminal path (ready,
 * failed, cancelled, interrupted, deadline) releases its file and slot.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import {
  awaitExportBuild,
  cancelExport,
  EXPORT_LIMITS,
  exportStatus,
  latestExport,
  prepareExport,
  reclaimExports,
} from "@knowledge-base/api/lib/kb/exports";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { completeExport, readTransfer } from "@knowledge-base/api/lib/kb/transfers";
import { mintPersonalToken, revokePersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { describe, expect, it, vi } from "vitest";
import {
  artifactPath,
  asset,
  commit,
  fixture,
  frames,
  gatedStore,
  prisma,
  readyExport,
  registerExportHooks,
  released,
  request,
  runtime,
  settledExport,
  user,
} from "./export-fixture";

type Bearer = (
  request: Request,
) => Promise<{ principal: TokenPrincipal; verifier: CredentialVerifier }>;
const { createBearerAdmission } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
)) as {
  createBearerAdmission(options: {
    origin: string;
    withQuery: ReturnType<typeof credentialQuery>;
  }): Bearer;
};
const { createKbExportRoutes } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/kb-export-routes.ts"))
    .href
)) as {
  createKbExportRoutes(options: {
    runtime(): KbRuntimeConfig;
    session(): Promise<{ user: { id: string } } | null>;
  }): { request(url: string, init?: RequestInit): Promise<Response> };
};

const { dispatchTool } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/tool-dispatch.ts"))
    .href
)) as {
  dispatchTool(
    name: "knowledge_export_prepare",
    input: { kbId: string; kind: "assets" | "whole"; idempotencyKey: string; rev?: string },
    base: { runtime: KbRuntimeConfig; actor: unknown; signal: AbortSignal },
  ): Promise<{ structuredContent?: { data?: { transferId: string; state: string } } }>;
};

registerExportHooks();

function barrier() {
  let release = () => {};
  const wait = new Promise<void>((done) => {
    release = done;
  });
  return { wait, release };
}

/** Wait for `promise`, but give up as soon as the build's signal aborts. */
function until(promise: Promise<void>, signal: AbortSignal) {
  return new Promise<void>((done, fail) => {
    if (signal.aborted) return fail(signal.reason);
    signal.addEventListener("abort", () => fail(signal.reason), { once: true });
    void promise.then(done);
  });
}

/** A build that serves `free` frames, then holds every later frame until `release`. */
function holdAfter(free: number) {
  const entered = barrier();
  const resume = barrier();
  let served = 0;
  const config: KbRuntimeConfig = {
    ...runtime,
    blobStore: gatedStore(runtime.blobStore, async (signal) => {
      if (served++ < free) return;
      entered.release();
      await until(resume.wait, signal);
    }),
  };
  return { config, entered: entered.wait, release: resume.release };
}

async function reservedCount(id: string) {
  const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM "quota_reservation" WHERE "opId"=$1 AND outcome='RESERVED'`,
    id,
  );
  return rows[0]!.count;
}

describe("background export jobs", () => {
  it("start returns at once, progress is reported, then ready downloads and releases", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    const held = holdAfter(1);
    const started = await prepareExport(held.config, base.actor, request(pinned, "assets"));
    try {
      expect(["pending", "building"]).toContain(started.state);
      expect(started).toMatchObject({
        size: null,
        contentHash: null,
        expiresAt: null,
        error: null,
      });
      await held.entered;
      // The heartbeat persists measured progress while the build is held.
      await vi.waitFor(
        async () => {
          const job = await exportStatus(runtime, base.actor, {
            kbId: base.kbId,
            transferId: started.transferId,
          });
          expect(job.state).toBe("building");
          expect(job.progress.totalBytes).toBe(400000);
          expect(job.progress.doneBytes).toBeGreaterThan(0);
          expect(job.progress.doneBytes).toBeLessThan(400000);
        },
        { timeout: EXPORT_LIMITS.heartbeatMs * 3, interval: 200 },
      );
      expect(await reservedCount(started.transferId)).toBe(1);
      // The page that reopens finds the same job.
      expect(await latestExport(runtime, base.actor, { kbId: base.kbId })).toMatchObject({
        transferId: started.transferId,
        state: "building",
      });
    } finally {
      held.release();
    }
    await awaitExportBuild(started.transferId);
    const ready = await exportStatus(runtime, base.actor, {
      kbId: base.kbId,
      transferId: started.transferId,
    });
    expect(ready).toMatchObject({
      state: "ready",
      progress: { doneBytes: 400000, totalBytes: 400000 },
      error: null,
    });
    expect(ready.size).toBeGreaterThan(400000);
    expect(Date.parse(ready.expiresAt!) - Date.now()).toBeGreaterThan(EXPORT_LIMITS.ttlMs - 60_000);
    expect(await reservedCount(started.transferId)).toBe(0);
    expect((await frames(base, started.transferId)).length).toBe(ready.size);
    await completeExport(runtime, base.actor, { kbId: base.kbId, transferId: started.transferId });
    await released(started.transferId, "DOWNLOADED");
    expect(
      await prisma.auditEvent.count({
        where: { opId: started.transferId, action: "export_prepare" },
      }),
    ).toBe(1);
  });

  it("a storage failure ends failed with a code, deletes the file and frees the slot", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    let fail = true;
    const broken: KbRuntimeConfig = {
      ...runtime,
      blobStore: gatedStore(runtime.blobStore, async () => {
        if (fail) throw new Error("injected storage read failure");
      }),
    };
    const job = await settledExport(broken, base.actor, request(pinned, "assets"));
    expect(job).toMatchObject({
      state: "failed",
      size: null,
      error: { code: "STORAGE_UNAVAILABLE", message: expect.any(String) },
    });
    await released(job.transferId, "FAILED");
    fail = false;
    // The slot is free again: a new start for the same scope is a new job.
    const next = await readyExport(runtime, base.actor, request(pinned, "assets"));
    expect(next.transferId).not.toBe(job.transferId);
  });

  it("cancel while building stops the build, deletes the file and frees the slot", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    const held = holdAfter(1);
    const started = await prepareExport(held.config, base.actor, request(pinned, "assets"));
    try {
      await held.entered;
      expect(existsSync(artifactPath(started.transferId))).toBe(true);
      const cancelled = await cancelExport(runtime, base.actor, {
        kbId: base.kbId,
        transferId: started.transferId,
      });
      expect(cancelled).toMatchObject({ state: "cancelled", size: null, error: null });
      await released(started.transferId, "CANCELLED");
      await expect(
        readTransfer(runtime, base.actor, {
          kbId: base.kbId,
          transferId: started.transferId,
          offset: 0,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      // Cancelling again is a no-op that reports the same state.
      expect(
        await cancelExport(runtime, base.actor, {
          kbId: base.kbId,
          transferId: started.transferId,
        }),
      ).toMatchObject({ state: "cancelled" });
      expect(
        await prisma.auditEvent.count({
          where: { opId: started.transferId, action: "export_prepare" },
        }),
      ).toBe(0);
    } finally {
      held.release();
      await awaitExportBuild(started.transferId);
    }
    const next = await prepareExport(runtime, base.actor, request(pinned, "assets"));
    expect(next.transferId).not.toBe(started.transferId);
    await awaitExportBuild(next.transferId);
  });

  it("cancel of a ready export discards it", async () => {
    const base = await fixture();
    const job = await readyExport(runtime, base.actor, request(base, "assets"));
    expect(
      await cancelExport(runtime, base.actor, { kbId: base.kbId, transferId: job.transferId }),
    ).toMatchObject({ state: "cancelled", size: null, contentHash: null });
    await released(job.transferId, "CANCELLED");
  });

  it("a replay or same-scope start while building is the same job: one row, one build, one audit", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    const held = holdAfter(0);
    const input = request(pinned);
    const started = await prepareExport(held.config, base.actor, input);
    try {
      await held.entered;
      const again = await Promise.all([
        prepareExport(runtime, base.actor, input),
        prepareExport(runtime, base.actor, request(pinned)),
        prepareExport(runtime, base.actor, { ...request(pinned), rev: pinned.rev }),
      ]);
      expect(again.map((job) => job.transferId)).toEqual(Array(3).fill(started.transferId));
      expect(again.every((job) => job.state === "building")).toBe(true);
      expect(await prisma.exportArtifact.count({ where: { kbId: base.kbId } })).toBe(1);
      // Another kind is another scope: the user's one slot is taken.
      await expect(
        prepareExport(runtime, base.actor, request(pinned, "assets")),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      held.release();
    }
    await awaitExportBuild(started.transferId);
    expect(
      await exportStatus(runtime, base.actor, { kbId: base.kbId, transferId: started.transferId }),
    ).toMatchObject({ state: "ready" });
    expect(
      await prisma.auditEvent.count({
        where: { opId: started.transferId, action: "export_prepare" },
      }),
    ).toBe(1);
  });

  it("a key reused for a live job replays that job after it is cancelled", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    const held = holdAfter(0);
    const first = request(pinned, "assets");
    const reused = request(pinned, "assets");
    expect(reused.idempotencyKey).not.toBe(first.idempotencyKey);
    const started = await prepareExport(held.config, base.actor, first);
    try {
      await held.entered;
      expect((await prepareExport(runtime, base.actor, reused)).transferId).toBe(
        started.transferId,
      );
      await cancelExport(runtime, base.actor, { kbId: base.kbId, transferId: started.transferId });
    } finally {
      held.release();
      await awaitExportBuild(started.transferId);
    }
    // Retrying the reused key returns the cancelled job, never a second build.
    expect(await prepareExport(runtime, base.actor, reused)).toMatchObject({
      transferId: started.transferId,
      state: "cancelled",
    });
    expect(await prisma.exportArtifact.count({ where: { kbId: base.kbId } })).toBe(1);
    // The key is bound to its request like any other key.
    await expect(
      prepareExport(runtime, base.actor, { ...reused, kind: "whole" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("a start never waits for another job's stuck producer to drain", async () => {
    const stuck = await fixture();
    const pinned = await commit(stuck, [await asset(stuck)]);
    // This producer ignores its abort signal until released (slow storage I/O).
    const entered = barrier();
    const resume = barrier();
    const slow: KbRuntimeConfig = {
      ...runtime,
      blobStore: gatedStore(runtime.blobStore, async () => {
        entered.release();
        await resume.wait;
      }),
    };
    const started = await prepareExport(slow, stuck.actor, request(pinned, "assets"));
    try {
      await entered.wait;
      await prisma.exportArtifact.update({
        where: { id: started.transferId },
        data: { leaseUntil: new Date(0) },
      });
      const other = await fixture();
      const at = Date.now();
      const next = await prepareExport(runtime, other.actor, request(other, "assets"));
      expect(Date.now() - at).toBeLessThan(10_000);
      expect(["pending", "building", "ready"]).toContain(next.state);
      // The admission sweep already failed the lapsed job; its producer still runs.
      expect(
        (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: started.transferId } }))
          .state,
      ).toBe("FAILED");
      await awaitExportBuild(next.transferId);
    } finally {
      resume.release();
      await awaitExportBuild(started.transferId);
    }
    await released(started.transferId, "FAILED");
  });

  it("a READY publication stalled past the build deadline rolls back and fails the job", async () => {
    const base = await fixture();
    const deadlineMs = 4_000;
    let deadline = 0;
    // Hold the READY UPDATE (inside its open authority transaction) until the
    // deadline has passed; PostgreSQL's now() still reads the transaction start.
    const stalled: KbRuntimeConfig = {
      ...runtime,
      coordinator: {
        run: (options) =>
          runtime.coordinator.run({
            ...options,
            run: (context) =>
              options.run({
                ...context,
                lease: new Proxy(context.lease, {
                  get(lease, key, receiver) {
                    if (key !== "transaction") return Reflect.get(lease, key, receiver);
                    return <T>(work: (query: LockQuery) => Promise<T>, reservation = false) =>
                      lease.transaction(
                        (query) =>
                          work(async <R>(sql: string, values?: unknown[]) => {
                            if (sql.includes("SET state='READY'"))
                              await new Promise((done) =>
                                setTimeout(done, Math.max(0, deadline - Date.now()) + 500),
                              );
                            return query<R>(sql, values);
                          }),
                        reservation,
                      );
                  },
                }),
              }),
          }),
      },
    };
    const started = await prepareExport(stalled, base.actor, request(base, "assets"), {
      deadlineMs,
    });
    deadline = Date.now() + deadlineMs;
    await awaitExportBuild(started.transferId);
    await released(started.transferId, "FAILED");
    expect(
      await exportStatus(runtime, base.actor, { kbId: base.kbId, transferId: started.transferId }),
    ).toMatchObject({ state: "failed", error: { code: "DEADLINE_EXCEEDED" } });
    expect(
      await prisma.auditEvent.count({
        where: { opId: started.transferId, action: "export_prepare" },
      }),
    ).toBe(0);
  });

  it("startup fails a building job left by a dead server process (INTERRUPTED)", async () => {
    const base = await fixture();
    const job = await readyExport(runtime, base.actor, request(base, "assets"));
    await prisma.exportArtifact.update({
      where: { id: job.transferId },
      data: {
        state: "WRITING",
        leaseOwner: "dead-host:1:previous-process",
        leaseUntil: new Date(Date.now() + 60_000),
      },
    });
    // A periodic sweep leaves a live lease alone.
    await reclaimExports(runtime);
    expect(
      (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: job.transferId } })).state,
    ).toBe("WRITING");
    await reclaimExports(runtime, { restart: true });
    await released(job.transferId, "FAILED");
    expect(
      await exportStatus(runtime, base.actor, { kbId: base.kbId, transferId: job.transferId }),
    ).toMatchObject({
      state: "failed",
      error: { code: "INTERRUPTED", message: expect.stringContaining("Start it again") },
    });
  });

  it("the stale sweep fails a lapsed lease (INTERRUPTED) and a passed deadline (DEADLINE_EXCEEDED)", async () => {
    const base = await fixture();
    const other = await fixture();
    const lapsed = await readyExport(runtime, base.actor, request(base, "assets"));
    const late = await readyExport(runtime, other.actor, request(other, "assets"));
    await prisma.exportArtifact.update({
      where: { id: lapsed.transferId },
      data: { state: "WRITING", leaseOwner: "dead-host:2:gone", leaseUntil: new Date(0) },
    });
    await prisma.exportArtifact.update({
      where: { id: late.transferId },
      data: {
        state: "WRITING",
        leaseOwner: "dead-host:3:gone",
        leaseUntil: new Date(Date.now() + 60_000),
        deadlineAt: new Date(0),
      },
    });
    await reclaimExports(runtime);
    await released(lapsed.transferId, "FAILED");
    await released(late.transferId, "FAILED");
    expect(
      await exportStatus(runtime, base.actor, { kbId: base.kbId, transferId: lapsed.transferId }),
    ).toMatchObject({ state: "failed", error: { code: "INTERRUPTED" } });
    expect(
      await exportStatus(runtime, other.actor, { kbId: other.kbId, transferId: late.transferId }),
    ).toMatchObject({ state: "failed", error: { code: "DEADLINE_EXCEEDED" } });
  });

  it("a running build whose own lease lapses is stopped and failed by the sweep", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    const held = holdAfter(1);
    const started = await prepareExport(held.config, base.actor, request(pinned, "assets"));
    try {
      await held.entered;
      await prisma.exportArtifact.update({
        where: { id: started.transferId },
        data: { leaseUntil: new Date(0) },
      });
      // The sweep stops this process's build and joins it before reclaiming.
      await reclaimExports(runtime);
      await released(started.transferId, "FAILED");
      expect(
        await exportStatus(runtime, base.actor, {
          kbId: base.kbId,
          transferId: started.transferId,
        }),
      ).toMatchObject({ state: "failed", error: { code: "INTERRUPTED" } });
    } finally {
      held.release();
      await awaitExportBuild(started.transferId);
    }
  });

  it("another user cannot read status, cancel, download or read frames; lost access hides it", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    const member = await user();
    const stranger = await user();
    await prisma.kbShare.create({ data: { kbId: base.kbId, userId: member.id, bits: ["read"] } });
    await prisma.kbShare.create({
      data: { kbId: base.kbId, userId: stranger.id, bits: ["read"] },
    });
    const memberActor = { principal: { kind: "browser" as const, userId: member.id } };
    const strangerActor = { principal: { kind: "browser" as const, userId: stranger.id } };
    const job = await readyExport(runtime, memberActor, request(pinned, "assets"));
    const ref = { kbId: base.kbId, transferId: job.transferId };
    // Read access to the KB is not access to someone else's export.
    for (const actor of [strangerActor, base.actor]) {
      await expect(exportStatus(runtime, actor, ref)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(cancelExport(runtime, actor, ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(readTransfer(runtime, actor, { ...ref, offset: 0 })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await latestExport(runtime, actor, { kbId: base.kbId })).toBeNull();
      const mounted = createKbExportRoutes({
        runtime: () => runtime,
        session: async () => ({ user: { id: actor.principal.userId } }),
      });
      const response = await mounted.request(
        `${runtime.canonicalOrigin}/kb-exports/${base.kbId}/${job.transferId}`,
      );
      expect(response.status).toBe(404);
    }
    expect(await exportStatus(runtime, memberActor, ref)).toMatchObject({ state: "ready" });
    // The requester loses read access: status and bytes are refused.
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId: base.kbId, userId: member.id } },
      data: { revokedAt: new Date() },
    });
    await expect(exportStatus(runtime, memberActor, ref)).rejects.toMatchObject({
      code: expect.stringMatching(/^(NOT_FOUND|FORBIDDEN)$/),
    });
    await expect(readTransfer(runtime, memberActor, { ...ref, offset: 0 })).rejects.toBeDefined();
    const mounted = createKbExportRoutes({
      runtime: () => runtime,
      session: async () => ({ user: { id: member.id } }),
    });
    const refused = await mounted.request(
      `${runtime.canonicalOrigin}/kb-exports/${base.kbId}/${job.transferId}`,
    );
    expect([403, 404]).toContain(refused.status);
  });

  describe("personal access token", () => {
    async function tokenActor(kbId: string, userId: string) {
      const minted = await mintPersonalToken(runtime, userId, {
        name: "export job",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId, bits: ["read"] }],
        expiresAt: null,
      });
      const bearer = createBearerAdmission({
        origin: runtime.canonicalOrigin,
        withQuery: credentialQuery(runtime.connectionString),
      });
      // The admitting request ends (its signal aborts) once prepare answers.
      const requestAbort = new AbortController();
      const actor = await bearer(
        new Request(`${runtime.canonicalOrigin}/mcp`, {
          headers: { authorization: `Bearer ${minted.secret}` },
          signal: requestAbort.signal,
        }),
      );
      return { minted, actor, bearer, endRequest: () => requestAbort.abort() };
    }

    it("a PAT-started build finishes after its prepare request has ended", async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      const { minted, actor, bearer, endRequest } = await tokenActor(
        base.kbId,
        base.actor.principal.userId,
      );
      const held = holdAfter(1);
      const started = await prepareExport(held.config, actor, request(pinned, "assets"));
      endRequest();
      try {
        await held.entered;
      } finally {
        held.release();
      }
      await awaitExportBuild(started.transferId);
      const row = await prisma.exportArtifact.findUniqueOrThrow({
        where: { id: started.transferId },
      });
      expect(row).toMatchObject({ state: "READY", failureCode: null });
      // The next MCP call re-admits the same PAT: same grant, same actor.
      const again = await bearer(
        new Request(`${runtime.canonicalOrigin}/mcp`, {
          headers: { authorization: `Bearer ${minted.secret}` },
        }),
      );
      const ref = { kbId: base.kbId, transferId: started.transferId };
      expect(await exportStatus(runtime, again, ref)).toMatchObject({ state: "ready" });
      expect((await readTransfer(runtime, again, { ...ref, offset: 0 })).offset).toBe(0);
    });

    it("an MCP prepare's build outlives its request-bound runtime", async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      const { actor, endRequest } = await tokenActor(base.kbId, base.actor.principal.userId);
      const held = holdAfter(1);
      const call = new AbortController();
      const result = await dispatchTool("knowledge_export_prepare", request(pinned, "assets"), {
        runtime: held.config,
        actor,
        signal: call.signal,
      });
      const started = result.structuredContent!.data!;
      expect(["pending", "building"]).toContain(started.state);
      // The HTTP call is over: its signal (and its request-bound coordinator) is gone.
      call.abort();
      endRequest();
      try {
        await held.entered;
      } finally {
        held.release();
      }
      await awaitExportBuild(started.transferId);
      expect(
        await prisma.exportArtifact.findUniqueOrThrow({ where: { id: started.transferId } }),
      ).toMatchObject({ state: "READY", failureCode: null });
    });

    it("a PAT revoked mid-build ends the job failed with ACCESS_DENIED", async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      const { minted, actor, endRequest } = await tokenActor(
        base.kbId,
        base.actor.principal.userId,
      );
      const held = holdAfter(1);
      const started = await prepareExport(held.config, actor, request(pinned, "assets"));
      endRequest();
      try {
        await held.entered;
        await revokePersonalToken(runtime, base.actor.principal.userId, minted.token.id);
      } finally {
        held.release();
      }
      await awaitExportBuild(started.transferId);
      await released(started.transferId, "FAILED");
      expect(
        (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: started.transferId } }))
          .failureCode,
      ).toBe("ACCESS_DENIED");
    });
  });
});
