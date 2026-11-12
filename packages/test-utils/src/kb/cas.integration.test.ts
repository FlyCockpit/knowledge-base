// @ts-nocheck — PG integration harness.

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hasKbLineage,
  publishCasWithCatalog,
  recoverCasPublications,
} from "@knowledge-base/api/lib/kb/asset-lineage";
import {
  casBlobPath,
  casInode,
  createDiskBlobStore,
} from "@knowledge-base/api/lib/kb/blob-store-disk";
import {
  gifWithoutImageData,
  invalidMp4References,
  minimalPng,
  minimalWav,
  pngWithHeaderField,
  sha256Buffer,
} from "@knowledge-base/api/lib/kb/fixtures/media-bytes";
import { KB_LIMITS } from "@knowledge-base/api/lib/kb/limits";
import { checkoutPinnedSession, enqueueKbOperation } from "@knowledge-base/api/lib/kb/lock";
import {
  kbRecoveryGateOpen,
  runJournalRecoverySweep,
  runStartupJournalRecovery,
} from "@knowledge-base/api/lib/kb/recovery";
import { afterAll, describe, expect, it, vi } from "vitest";
import { initKbVolumes } from "../../../../scripts/init-kb-volumes.mjs";
import { openKbPostgresClusterFromEnv } from "./index.js";

function filesystemSubject(path: string): string {
  return `fs:${execFileSync("/usr/bin/stat", ["--file-system", "--format=%t:%i", "--", path], { encoding: "utf8" }).trim()}`;
}

const ROOT = resolve(import.meta.dirname, "../../../..");
const DESCRIPTION = "cas integration knowledge base";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
const prisma = db.createPrismaClient("runtime");

afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
});

db.applyPrismaSchema();

function assetsDir() {
  const root = mkdtempSync(join(tmpdir(), "kb-cas-int-"));
  const assets = join(root, "assets");
  initKbVolumes({ KB_DATA_ROOT: root });
  return assets;
}

async function activeKb(ownerId: string) {
  return prisma.knowledgeBase.create({
    data: {
      ownerId,
      name: "CAS KB",
      slug: `cas-${crypto.randomUUID().slice(0, 8)}`,
      description: DESCRIPTION,
      state: "ACTIVE",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });
}

async function withSession(kbId, work) {
  return enqueueKbOperation(kbId, async () => {
    const session = await checkoutPinnedSession({
      connectionString: db.urls.applier,
      opId: crypto.randomUUID(),
    });
    try {
      await session.acquire([{ kind: "kb", kbId }]);
      return await work(session);
    } finally {
      await session.close();
    }
  });
}

let fixtureOrdinal = 0;
async function fixture() {
  const owner = await prisma.user.create({
    data: { name: "cas", email: `cas-${crypto.randomUUID()}@example.invalid`, emailVerified: true },
  });
  const kb = await activeKb(owner.id);
  const assets = assetsDir();
  const bytes = minimalWav();
  bytes.writeUInt16LE(++fixtureOrdinal, bytes.length - 2);
  const hash = sha256Buffer(bytes);
  const input = {
    assetsDir: assets,
    blobStore: createDiskBlobStore(assets),
    bytes,
    declaredHash: hash,
    declaredSize: bytes.length,
    declaredMime: "audio/wav",
    grantLineage: {
      kbId: kb.id,
      hash,
      actorKey: `user:${owner.id}`,
      actorUserIdSnapshot: owner.id,
      actorUserId: owner.id,
      source: "UPLOAD",
    },
  };
  const disk = { meter: { freeBytes: async () => 1n << 40n } };
  const publish = (extra = {}) =>
    withSession(kb.id, (session) =>
      publishCasWithCatalog({ ...input, quota: { session, disk }, ...extra }),
    );
  return { owner, kb, assets, bytes, hash, input, disk, publish };
}

async function accountsFor(f) {
  return prisma.quotaAccount.findMany({
    where: {
      OR: [
        { dimension: "KB_LINEAGE_BYTES", subjectId: f.kb.id },
        { dimension: "OWNER_LINEAGE_BYTES", subjectId: f.owner.id },
        { dimension: "DISK_VOLUME", subjectId: filesystemSubject(f.assets) },
      ],
    },
    orderBy: { dimension: "asc" },
  });
}

async function expectSettled(f, committed) {
  const accounts = await accountsFor(f);
  expect(accounts).toHaveLength(3);
  for (const row of accounts) {
    expect(row.reserved).toBe(0n);
    expect(row.committed).toBe(row.dimension === "DISK_VOLUME" ? 0n : BigInt(committed));
  }
}

async function tombstoneFixturesForSweep() {
  // These fixtures intentionally have no Git repository. Tombstones have no
  // canonical head to reconcile and still MUST recover held CAS reservations.
  await prisma.knowledgeBase.updateMany({
    where: { description: DESCRIPTION },
    data: { state: "TOMBSTONED" },
  });
}

async function sweep(startup = false) {
  const repos = mkdtempSync(join(tmpdir(), "kb-cas-recovery-"));
  const fence = vi.fn();
  const assets = assetsDir();
  if (startup) await runStartupJournalRecovery(prisma, repos, assets, db.urls.applier, fence);
  else await runJournalRecoverySweep(prisma, repos, assets, db.urls.applier, fence);
  expect(fence).toHaveBeenCalled();
}

describe("CAS catalog and lineage", () => {
  it("requires one quota/lineage tuple before any publication", async () => {
    const f = await fixture();
    const accountsBefore = await accountsFor(f);
    await expect(publishCasWithCatalog(f.input)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await withSession(f.kb.id, async (session) => {
      await expect(
        publishCasWithCatalog({
          ...f.input,
          quota: { session, disk: f.disk },
          grantLineage: undefined,
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(
        publishCasWithCatalog({ ...f.input, declaredSize: 0, quota: { session, disk: f.disk } }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });
    expect(await prisma.casPublication.count({ where: { kbId: f.kb.id } })).toBe(0);
    expect(await accountsFor(f)).toEqual(accountsBefore);
    expect(existsSync(casBlobPath(f.assets, f.hash))).toBe(false);
  });

  it("rejects absent/wrong operation ownership before reserving or writing", async () => {
    const f = await fixture();
    const accountsBefore = await accountsFor(f);
    const other = await activeKb(f.owner.id);
    await withSession(other.id, async (session) => {
      await expect(
        publishCasWithCatalog({ ...f.input, quota: { session, disk: f.disk } }),
      ).rejects.toMatchObject({ code: "NOT_HELD" });
    });
    // Correct in-process gate with the wrong pinned SQL lock must also fail.
    await enqueueKbOperation(f.kb.id, () =>
      withSession(other.id, async (session) => {
        await expect(
          publishCasWithCatalog({ ...f.input, quota: { session, disk: f.disk } }),
        ).rejects.toMatchObject({ code: "NOT_HELD" });
      }),
    );
    const session = await checkoutPinnedSession({
      connectionString: db.urls.applier,
      opId: crypto.randomUUID(),
    });
    try {
      await session.acquire([{ kind: "kb", kbId: f.kb.id }]);
      await expect(
        publishCasWithCatalog({ ...f.input, quota: { session, disk: f.disk } }),
      ).rejects.toMatchObject({ code: "NOT_HELD" });
    } finally {
      await session.close();
    }
    expect(await accountsFor(f)).toEqual(accountsBefore);
  });

  it("charges the current owner and rejects an unrelated grant hash", async () => {
    const f = await fixture();
    const newOwner = await prisma.user.create({
      data: { name: "recipient", email: `${crypto.randomUUID()}@example.invalid` },
    });
    await prisma.knowledgeBase.update({ where: { id: f.kb.id }, data: { ownerId: newOwner.id } });
    await expect(
      f.publish({
        grantLineage: { ...f.input.grantLineage, hash: sha256Buffer(Buffer.from("other")) },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await f.publish();
    expect(await prisma.quotaAccount.count({ where: { subjectId: f.owner.id } })).toBe(0);
    await expectSettled({ ...f, owner: newOwner }, f.bytes.length);
  });

  it("converges concurrent identical publications on one inode and one charged lineage", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.publish(), f.publish()]);
    expect([a.durability.newBytes, b.durability.newBytes].sort()).toEqual([false, true]);
    expect(casInode(casBlobPath(f.assets, a.hash))).toBe(casInode(casBlobPath(f.assets, b.hash)));
    expect(readFileSync(casBlobPath(f.assets, a.hash)).equals(f.bytes)).toBe(true);
    expect(await prisma.kbAssetLineage.count({ where: { kbId: f.kb.id, hash: f.hash } })).toBe(1);
    const attempts = await prisma.casPublication.findMany({ where: { kbId: f.kb.id } });
    expect(attempts.map((a) => a.state)).toEqual(["FINALIZED", "FINALIZED"]);
    expect(attempts.map((a) => a.reservationIds.length).sort()).toEqual([1, 3]);
    await expectSettled(f, f.bytes.length);
    // Duplicate logical lineage remains admissible even at its logical caps.
    await prisma.quotaAccount.updateMany({
      where: { subjectId: f.kb.id },
      data: { committed: KB_LIMITS.casLineageBytesPerKb },
    });
    await expect(f.publish()).resolves.toMatchObject({ durability: { newBytes: false } });
    expect((await prisma.quotaAccount.findFirst({ where: { subjectId: f.kb.id } })).committed).toBe(
      KB_LIMITS.casLineageBytesPerKb,
    );
  });

  it.each(["identical", "distinct", "finalization fault", "lost acknowledgement", "lost session"])(
    "settles overlapping publications within one held operation (%s)",
    async (scenario) => {
      const f = await fixture();
      const started = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const secondBytes = scenario === "distinct" ? minimalPng() : f.bytes;
      const secondHash = sha256Buffer(secondBytes);
      let firstId: string;
      async function* stream() {
        started.resolve(); // The first reservation transaction has committed.
        await resume.promise;
        yield f.bytes;
      }
      await withSession(f.kb.id, async (session) => {
        const pending = publishCasWithCatalog({
          ...f.input,
          bytes: stream(),
          quota: { session, disk: f.disk },
        }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          await started.promise;
          const first = await prisma.casPublication.findFirst({ where: { kbId: f.kb.id } });
          firstId = first.id;
          expect(first).toMatchObject({ state: "PENDING" });
          expect(first.reservationIds).toHaveLength(3);
          expect(await hasKbLineage(prisma, f.kb.id, f.hash)).toBe(false);
          const second = await publishCasWithCatalog({
            ...f.input,
            bytes: secondBytes,
            declaredHash: secondHash,
            declaredSize: secondBytes.length,
            declaredMime: scenario === "distinct" ? "image/png" : f.input.declaredMime,
            grantLineage: { ...f.input.grantLineage, hash: secondHash },
            quota: { session, disk: f.disk },
          });
          expect(second.durability.newBytes).toBe(true);
          const secondInode = casInode(casBlobPath(f.assets, second.hash));
          for (const account of await accountsFor(f)) {
            expect(account.reserved).toBe(BigInt(f.bytes.length));
            expect(account.committed).toBe(
              account.dimension === "DISK_VOLUME" ? 0n : BigInt(secondBytes.length),
            );
          }
          if (scenario === "finalization fault") {
            const transaction = session.transaction.bind(session);
            vi.spyOn(session, "transaction").mockImplementation((work, reservation) =>
              transaction(
                (query) =>
                  work(async (sql, params) => {
                    if (sql.startsWith('UPDATE "cas_publication"') && params[1] === "FINALIZED")
                      throw new Error("duplicate finalization fault");
                    return query(sql, params);
                  }),
                reservation,
              ),
            );
          } else if (scenario === "lost acknowledgement") {
            const transaction = session.transaction.bind(session);
            let loseReply = true;
            vi.spyOn(session, "transaction").mockImplementation(async (work, reservation) => {
              const result = await transaction(work, reservation);
              if (loseReply) {
                loseReply = false;
                throw new Error("duplicate commit acknowledgement lost");
              }
              return result;
            });
          } else if (scenario === "lost session") {
            session.markLost();
          }
          resume.resolve();
          const result = await pending;
          if (scenario === "identical" || scenario === "distinct") {
            expect(result.error).toBeUndefined();
            expect(result.value.durability.newBytes).toBe(scenario === "distinct");
            expect(readFileSync(casBlobPath(f.assets, result.value.hash)).equals(f.bytes)).toBe(
              true,
            );
          } else {
            expect(result.error).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
          }
          expect(casInode(casBlobPath(f.assets, second.hash))).toBe(secondInode);
          expect(readFileSync(casBlobPath(f.assets, second.hash)).equals(secondBytes)).toBe(true);
        } finally {
          resume.resolve();
          await pending; // Join the owned writer even if an assertion fails.
        }
      });
      if (scenario === "lost session") {
        expect(await prisma.casPublication.findUnique({ where: { id: firstId } })).toMatchObject({
          state: "PENDING",
        });
        await withSession(f.kb.id, async (session) => {
          expect(await session.transaction((query) => recoverCasPublications(query, f.kb.id))).toBe(
            true,
          );
          expect(await session.transaction((query) => recoverCasPublications(query, f.kb.id))).toBe(
            false,
          );
        });
      }
      const failed = scenario === "finalization fault" || scenario === "lost session";
      const first = await prisma.casPublication.findUnique({ where: { id: firstId } });
      expect(first.state).toBe(failed ? "ABORTED" : "FINALIZED");
      const reservations = await prisma.quotaReservation.findMany({
        where: { id: { in: first.reservationIds } },
      });
      expect(reservations).toHaveLength(3);
      expect(reservations.map((r) => r.outcome)).toEqual(
        Array(3).fill(scenario === "distinct" ? "COMMITTED" : "RELEASED"),
      );
      expect(await prisma.kbAssetLineage.count({ where: { kbId: f.kb.id } })).toBe(
        scenario === "distinct" ? 2 : 1,
      );
      const total = secondBytes.length + (scenario === "distinct" ? f.bytes.length : 0);
      await expectSettled(f, total);
      await expect(f.publish()).resolves.toMatchObject({ durability: { newBytes: false } });
      await expectSettled(f, total);
    },
  );

  it("reserves temp bytes even when a caller supplies zero physical allocation", async () => {
    const f = await fixture();
    const accountsBefore = await accountsFor(f);
    f.disk.bytes = 0n; // Excess JS input cannot override derived allocation.
    f.disk.meter.freeBytes = async () => KB_LIMITS.freeDiskFloorBytes;
    await expect(f.publish()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(existsSync(casBlobPath(f.assets, f.hash))).toBe(false);
    expect(await accountsFor(f)).toEqual(accountsBefore);
    expect(await prisma.casPublication.count({ where: { kbId: f.kb.id } })).toBe(0);
    f.disk.meter.freeBytes = async () => KB_LIMITS.freeDiskFloorBytes + BigInt(f.bytes.length);
    await f.publish();
    f.disk.meter.freeBytes = async () => KB_LIMITS.freeDiskFloorBytes;
    await expect(f.publish()).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expectSettled(f, f.bytes.length);
  });

  it("does not materialize bytes beyond the declared/reserved length", async () => {
    const f = await fixture();
    async function* overflow() {
      yield f.bytes;
      yield Buffer.from([0]);
    }
    await expect(f.publish({ bytes: overflow() })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(existsSync(casBlobPath(f.assets, f.hash))).toBe(false);
    expect(readdirSync(join(f.assets, ".private/tmp"))).toEqual([]);
    await expectSettled(f, 0);
  });

  it("leaves orphan bytes but no lineage and releases quota when catalog composition fails", async () => {
    const f = await fixture();
    await expect(
      f.publish({
        afterDurableBytes: async () => {
          throw new Error("crash before catalog");
        },
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(readFileSync(casBlobPath(f.assets, f.hash)).equals(f.bytes)).toBe(true);
    expect(await hasKbLineage(prisma, f.kb.id, f.hash)).toBe(false);
    expect(await prisma.casPublication.findFirst({ where: { kbId: f.kb.id } })).toMatchObject({
      state: "ABORTED",
    });
    await expectSettled(f, 0);
    await expect(f.publish()).resolves.toMatchObject({ durability: { newBytes: false } });
    await expectSettled(f, f.bytes.length);
  });

  it("does not grant lineage to another KB from hash knowledge alone", async () => {
    const f = await fixture();
    const kbB = await activeKb(f.owner.id);
    await f.publish();
    expect(await hasKbLineage(prisma, f.kb.id, f.hash)).toBe(true);
    expect(await hasKbLineage(prisma, kbB.id, f.hash)).toBe(false);
    // B supplies a complete upload through the same accounting boundary.
    await withSession(kbB.id, (session) =>
      publishCasWithCatalog({
        ...f.input,
        quota: { session, disk: f.disk },
        grantLineage: { ...f.input.grantLineage, kbId: kbB.id },
      }),
    );
    expect(await hasKbLineage(prisma, kbB.id, f.hash)).toBe(true);
    expect(
      (
        await prisma.quotaAccount.findFirst({
          where: { dimension: "OWNER_LINEAGE_BYTES", subjectId: f.owner.id },
        })
      ).committed,
    ).toBe(2n * BigInt(f.bytes.length));
  });

  it("RESTRICT prevents deleting catalog rows still referenced by lineage", async () => {
    const f = await fixture();
    await f.publish();
    await expect(prisma.assetBlob.delete({ where: { hash: f.hash } })).rejects.toThrow();
  });

  it("serializes disk before logical settlement across new/existing lineages on shared accounts", async () => {
    const f = await fixture();
    await f.publish();
    const secondKb = await activeKb(f.owner.id);
    const bytes = minimalPng();
    const hash = sha256Buffer(bytes);
    const arrived = Promise.withResolvers();
    const resume = Promise.withResolvers();
    let arrivalCount = 0;
    const settleProof = [];
    async function run(kb, input) {
      return withSession(kb.id, async (session) => {
        const transaction = session.transaction.bind(session);
        vi.spyOn(session, "transaction").mockImplementation((work, reservation) =>
          transaction(async (query) => {
            let volumeLocked = false;
            return work(async (sql, params) => {
              if (sql.includes('UPDATE "quota_reservation" AS r')) {
                // Check the real lock query's result, not merely its invocation.
                expect(volumeLocked).toBe(true);
                settleProof.push(kb.id);
              }
              const result = await query(sql, params);
              if (sql.includes("FOR UPDATE OF a") && result.rows.length > 0) volumeLocked = true;
              return result;
            });
          }, reservation),
        );
        return publishCasWithCatalog({
          ...input,
          quota: { session, disk: f.disk },
          afterDurableBytes: async () => {
            if (++arrivalCount === 2) arrived.resolve();
            await resume.promise;
          },
        });
      });
    }
    const both = Promise.all([
      run(f.kb, f.input),
      run(secondKb, {
        ...f.input,
        bytes,
        declaredHash: hash,
        declaredSize: bytes.length,
        declaredMime: "image/png",
        grantLineage: { ...f.input.grantLineage, kbId: secondKb.id, hash },
      }),
    ]);
    try {
      await arrived.promise;
    } finally {
      resume.resolve();
    }
    await both;
    expect(new Set(settleProof)).toEqual(new Set([f.kb.id, secondKb.id]));
    const owner = await prisma.quotaAccount.findFirst({
      where: { dimension: "OWNER_LINEAGE_BYTES", subjectId: f.owner.id },
    });
    expect(owner).toMatchObject({ reserved: 0n, committed: BigInt(f.bytes.length + bytes.length) });
  });

  it("rolls back catalog/lineage/quota together on finalization failure, then retries", async () => {
    const f = await fixture();
    await withSession(f.kb.id, async (session) => {
      const transaction = session.transaction.bind(session);
      vi.spyOn(session, "transaction").mockImplementation((work, reservation) =>
        transaction(
          (query) =>
            work(async (sql, params) => {
              if (sql.startsWith('UPDATE "cas_publication"') && params[1] === "FINALIZED")
                throw new Error("finalization fault");
              return query(sql, params);
            }),
          reservation,
        ),
      );
      await expect(
        publishCasWithCatalog({ ...f.input, quota: { session, disk: f.disk } }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    });
    expect(await prisma.assetBlob.count({ where: { hash: f.hash } })).toBe(0);
    expect(await hasKbLineage(prisma, f.kb.id, f.hash)).toBe(false);
    await expectSettled(f, 0);
    await f.publish();
    await expectSettled(f, f.bytes.length);
  });

  it("keeps an ambiguously acknowledged final commit charged and never aborts its lineage", async () => {
    const f = await fixture();
    await withSession(f.kb.id, async (session) => {
      const transaction = session.transaction.bind(session);
      let transactions = 0;
      vi.spyOn(session, "transaction").mockImplementation(async (work, reservation) => {
        const result = await transaction(work, reservation);
        if (++transactions === 2) throw new Error("lost commit acknowledgement");
        return result;
      });
      await expect(
        publishCasWithCatalog({ ...f.input, quota: { session, disk: f.disk } }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    });
    expect(await hasKbLineage(prisma, f.kb.id, f.hash)).toBe(true);
    await expectSettled(f, f.bytes.length);
    await f.publish();
    await expectSettled(f, f.bytes.length);
  });

  it.each(["deadline", "shutdown"])(
    "joins owned writes when a stalled producer outlives %s",
    async (cause) => {
      const f = await fixture();
      const started = Promise.withResolvers();
      const late = Promise.withResolvers();
      const producer = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              started.resolve();
              return late.promise;
            },
          };
        },
      };
      await withSession(f.kb.id, async (session) => {
        const pending = publishCasWithCatalog({
          ...f.input,
          bytes: producer,
          quota: { session, disk: f.disk },
        });
        const rejected = expect(pending).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        await started.promise;
        if (cause === "shutdown") session.scope.requestShutdown();
        else session.scope.cancel(new Error("mutation deadline exceeded"));
        await rejected;
        expect(readdirSync(join(f.assets, ".private/tmp"))).toEqual([]);
      });
      // The abandoned producer completes after the publisher has closed its FDs.
      late.resolve({ done: false, value: f.bytes });
      await new Promise((resolve) => setImmediate(resolve));
      expect(existsSync(casBlobPath(f.assets, f.hash))).toBe(false);
      await tombstoneFixturesForSweep();
      await sweep();
      await expectSettled(f, 0);
    },
  );

  it("does not recover a live attempt after session loss until its operation gate drains", async () => {
    const f = await fixture();
    const arrived = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const pending = withSession(f.kb.id, async (session) => {
      await expect(
        publishCasWithCatalog({
          ...f.input,
          quota: { session, disk: f.disk },
          afterDurableBytes: async () => {
            session.markLost();
            arrived.resolve();
            await resume.promise;
          },
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    });
    await arrived.promise;
    await tombstoneFixturesForSweep();
    const repos = mkdtempSync(join(tmpdir(), "kb-cas-live-recovery-"));
    const fence = vi.fn();
    const recovery = runJournalRecoverySweep(prisma, repos, assetsDir(), db.urls.applier, fence);
    // Queue a marker behind recovery on the exact same KB gate. It cannot enter
    // before the paused publisher drains, even if its SQL lease is unusable.
    let entered = false;
    const marker = enqueueKbOperation(f.kb.id, async () => {
      entered = true;
    });
    expect(entered).toBe(false);
    expect((await prisma.casPublication.findFirst({ where: { kbId: f.kb.id } })).state).toBe(
      "PENDING",
    );
    resume.resolve();
    await Promise.all([pending, recovery, marker]);
    await expectSettled(f, 0);
    expect(fence).toHaveBeenCalled();
  });

  it.each(["reserved", "durable"])(
    "startup settles a killed process at the %s boundary",
    async (boundary) => {
      const f = await fixture();
      const script = `
      import { publishCasWithCatalog } from './packages/api/src/lib/kb/asset-lineage.ts';
      import { createDiskBlobStore } from './packages/api/src/lib/kb/blob-store-disk.ts';
      import { checkoutPinnedSession, enqueueKbOperation } from './packages/api/src/lib/kb/lock.ts';
      process.once('message', async ({ input, connectionString, boundary, bytes }) => {
        const wait = async () => { process.send('paused'); await new Promise(() => {}); };
        await enqueueKbOperation(input.grantLineage.kbId, async () => {
          const session = await checkoutPinnedSession({ connectionString, opId: crypto.randomUUID() });
          await session.acquire([{ kind: 'kb', kbId: input.grantLineage.kbId }]);
          async function* stream() { if (boundary === 'reserved') await wait(); yield Buffer.from(bytes); }
          await publishCasWithCatalog({ ...input, blobStore: createDiskBlobStore(input.assetsDir), bytes: stream(),
            quota: { session, disk: { meter: { freeBytes: async () => 1n << 40n } } },
            afterDurableBytes: boundary === 'durable' ? wait : undefined,
          });
        });
      });`;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: ROOT,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: { PATH: process.env.PATH },
        },
      );
      const exited = once(child, "exit");
      try {
        const paused = once(child, "message", { signal: AbortSignal.timeout(15_000) });
        child.send({
          input: f.input,
          bytes: [...f.bytes],
          connectionString: db.urls.applier,
          boundary,
        });
        expect((await paused)[0]).toBe("paused");
        const intent = await prisma.casPublication.findFirst({ where: { kbId: f.kb.id } });
        expect(intent).toMatchObject({ state: "PENDING" });
        expect(intent.reservationIds).toHaveLength(3);
        child.kill("SIGKILL");
        await exited;
        await tombstoneFixturesForSweep();
        await sweep(true);
        await expectSettled(f, 0);
        expect(await prisma.casPublication.findUnique({ where: { id: intent.id } })).toMatchObject({
          state: "ABORTED",
        });
        expect(await prisma.assetBlob.count({ where: { hash: f.hash } })).toBe(0);
        expect(await hasKbLineage(prisma, f.kb.id, f.hash)).toBe(false);
        expect(existsSync(casBlobPath(f.assets, f.hash))).toBe(boundary === "durable");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    },
  );

  it.each([false, true])(
    "recovers lost-session reservations via the production sweep (startup=%s)",
    async (startup) => {
      const f = await fixture();
      await withSession(f.kb.id, async (session) => {
        await expect(
          publishCasWithCatalog({
            ...f.input,
            quota: { session, disk: f.disk },
            afterDurableBytes: async () => {
              session.markLost();
            },
          }),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      });
      const attempt = await prisma.casPublication.findFirst({ where: { kbId: f.kb.id } });
      expect(attempt).toMatchObject({ state: "PENDING" });
      const reserved = await prisma.quotaReservation.findMany({
        where: { id: { in: attempt.reservationIds } },
      });
      expect(reserved).toHaveLength(3);
      expect(reserved.every((r) => r.outcome === "RESERVED" && r.heldForPublication)).toBe(true);
      await tombstoneFixturesForSweep();
      await sweep(startup);
      if (startup) expect(kbRecoveryGateOpen()).toBe(true);
      await expectSettled(f, 0);
      expect(await prisma.casPublication.findUnique({ where: { id: attempt.id } })).toMatchObject({
        state: "ABORTED",
      });
      expect(await hasKbLineage(prisma, f.kb.id, f.hash)).toBe(false);
      expect(readFileSync(casBlobPath(f.assets, f.hash)).equals(f.bytes)).toBe(true);
      // Replaying the exact recovery transition changes no counters.
      await runJournalRecoverySweep(
        prisma,
        mkdtempSync(join(tmpdir(), "kb-cas-replay-")),
        f.assets,
        db.urls.applier,
        () => {},
      );
      await expectSettled(f, 0);
    },
  );

  it.each([
    ...["declaration", "temp rewrite", "GIF no data", "PNG zero width"].map((failure) => ({
      failure,
      mp4: undefined,
    })),
    ...invalidMp4References()
      .filter(({ kind }) =>
        [
          "stco beyond EOF",
          "missing stsz",
          "one-byte mdat",
          "trun offset beyond EOF",
          "hybrid later run beyond EOF",
        ].includes(kind),
      )
      .map(({ kind, bytes }) => ({ failure: kind, mp4: bytes })),
  ])("releases quota without catalog/lineage on $failure failure", async ({ failure, mp4 }) => {
    const owner = await prisma.user.create({
      data: {
        name: "cas4",
        email: `cas4-${crypto.randomUUID()}@example.com`,
        emailVerified: true,
      },
    });
    const kb = await activeKb(owner.id);
    const assets = assetsDir();
    const bytes =
      mp4 ??
      (failure === "GIF no data"
        ? gifWithoutImageData()
        : failure === "PNG zero width"
          ? pngWithHeaderField(16, 0, true)
          : minimalWav());
    const mime = mp4
      ? "video/mp4"
      : failure === "GIF no data"
        ? "image/gif"
        : failure === "PNG zero width"
          ? "image/png"
          : "audio/wav";
    const hash = sha256Buffer(bytes);
    const tmp = join(assets, ".private", "tmp");
    async function* tamperedStream() {
      yield bytes;
      const replacement = Buffer.from(bytes);
      replacement[replacement.length - 1] = 0xff;
      const [name] = readdirSync(tmp);
      expect(name).toBeDefined();
      writeFileSync(join(tmp, name!), replacement);
    }
    await withSession(kb.id, async (session) => {
      await expect(
        publishCasWithCatalog({
          assetsDir: assets,
          blobStore: createDiskBlobStore(assets),
          declaredMime: mime,
          declaredHash: failure === "declaration" ? sha256Buffer(Buffer.from("wrong hash")) : hash,
          declaredSize: bytes.length,
          bytes: failure === "temp rewrite" ? tamperedStream() : bytes,
          grantLineage: {
            kbId: kb.id,
            hash: failure === "declaration" ? sha256Buffer(Buffer.from("wrong hash")) : hash,
            actorKey: `user:${owner.id}`,
            actorUserIdSnapshot: owner.id,
            actorUserId: owner.id,
            source: "UPLOAD",
          },
          quota: {
            session,
            disk: {
              // Exercise post-reservation failure/release independently of host disk pressure.
              // Disk-floor admission itself is covered by the quota/authority suites.
              meter: { freeBytes: async () => 1n << 40n },
            },
          },
        }),
      ).rejects.toMatchObject({
        code: failure === "temp rewrite" ? "STORAGE_UNAVAILABLE" : "INVALID_ARGUMENT",
      });
      expect(await prisma.assetBlob.count({ where: { hash } })).toBe(0);
      expect(await hasKbLineage(prisma, kb.id, hash)).toBe(false);
      expect(existsSync(casBlobPath(assets, hash))).toBe(false);
      expect(readdirSync(tmp)).toEqual([]);
      const accounts = await prisma.quotaAccount.findMany({
        where: {
          OR: [
            { dimension: "KB_LINEAGE_BYTES", subjectId: kb.id },
            { dimension: "OWNER_LINEAGE_BYTES", subjectId: owner.id },
            {
              dimension: "DISK_VOLUME",
              subjectId: filesystemSubject(assets),
            },
          ],
        },
      });
      expect(accounts).toHaveLength(3);
      for (const row of accounts) {
        expect(row.reserved).toBe(0n);
      }
    });
  });
});
