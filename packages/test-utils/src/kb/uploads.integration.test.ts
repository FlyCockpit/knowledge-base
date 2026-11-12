// @ts-nocheck — PG integration harness.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { minimalWav, sha256Buffer } from "@knowledge-base/api/lib/kb/fixtures/media-bytes";
import {
  CAS_BLOB_MAX_BYTES,
  createMemoryRatePort,
  KB_LIMITS,
} from "@knowledge-base/api/lib/kb/limits";
import { HeldLockLease } from "@knowledge-base/api/lib/kb/lock";
import { releaseQuota, reserveQuota, statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { configureKbRuntime, getKbRuntime } from "@knowledge-base/api/lib/kb/runtime";
import {
  stagedUploadPath,
  sweepExpiredStagedUploads,
  UPLOAD_MAX_CHUNK_BYTES,
  uploadBegin,
  uploadFinish,
  uploadWrite,
} from "@knowledge-base/api/lib/kb/uploads";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { afterAll, describe, expect, it, vi } from "vitest";
import { initKbVolumes } from "../../../../scripts/init-kb-volumes.mjs";
import { openKbPostgresClusterFromEnv } from "./index.js";

// Targeted fault injection, mirroring the established pattern in
// apps/server/src/kb-journal.integration.test.ts: every other node:fs export
// passes straight through to the real implementation. `vi.mock` is hoisted
// above these imports by Vitest's transform regardless of lexical position.
const fsFault = vi.hoisted(() => ({
  leafFsyncOnce: false,
  unlinkFailForId: "",
  unlinkFailIds: new Set<string>(),
  readError: false,
  freeBytes: null as bigint | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    async statfs(path, options) {
      const stats = await fs.statfs(path, options);
      return fsFault.freeBytes === null
        ? stats
        : { ...stats, bavail: fsFault.freeBytes, bsize: 1n };
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    readSync(...args) {
      if (fsFault.readError)
        throw Object.assign(new Error("injected read failure"), { code: "EIO" });
      return fs.readSync(...args);
    },
    fsyncSync(fd) {
      if (fsFault.leafFsyncOnce && fs.fstatSync(fd).isFile()) {
        fsFault.leafFsyncOnce = false;
        throw Object.assign(new Error("injected leaf fsync failure"), { code: "EIO" });
      }
      return fs.fsyncSync(fd);
    },
    unlinkSync(path) {
      if (
        (fsFault.unlinkFailForId && String(path).endsWith(`/${fsFault.unlinkFailForId}`)) ||
        fsFault.unlinkFailIds.has(String(path).split("/").at(-1))
      ) {
        throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
      }
      return fs.unlinkSync(path);
    },
  };
});

function filesystemSubject(path: string): string {
  return `fs:${execFileSync("/usr/bin/stat", ["--file-system", "--format=%t:%i", "--", path], { encoding: "utf8" }).trim()}`;
}

const DESCRIPTION = "uploads integration knowledge base";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
const prisma = db.createPrismaClient("runtime");

db.applyPrismaSchema();

const dataRoot = mkdtempSync(join(tmpdir(), "kb-upload-data-"));
const { reposDir, assetsDir } = initKbVolumes({ KB_DATA_ROOT: dataRoot });

const coordinator = {
  run: <T>(options: {
    opId: string;
    kind: "authority" | "git-write";
    kbIds?: readonly string[];
    barrier?: Parameters<typeof runLockedOperation>[0]["barrier"];
    run: (ctx: {
      lease: { transaction: (work: (query: unknown) => Promise<T>) => Promise<T> };
    }) => Promise<T>;
  }) =>
    runLockedOperation({
      connectionString: db.urls.runtime,
      opId: options.opId,
      kbIds: options.kbIds,
      kind: "kb-write",
      barrier: options.barrier,
      run: (lease) => options.run({ lease }),
    }),
};

const memoryRatePort = createMemoryRatePort();
const runtimeConfig = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir,
  assetsDir,
  blobStore: createDiskBlobStore(assetsDir),
  canonicalOrigin: "https://kb.example.com",
  cursorSigner: createCursorSigner(randomBytes(32)),
  diskMeter: { freeBytes: async () => 1n << 40n },
  coordinator,
};
configureKbRuntime({ ...runtimeConfig, ratePort: memoryRatePort });
setKbRecoveryComplete(true);

afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

async function owner() {
  return prisma.user.create({
    data: {
      name: "upload",
      email: `upload-${crypto.randomUUID()}@example.invalid`,
      emailVerified: true,
    },
  });
}

async function activeKb(userId: string) {
  return prisma.knowledgeBase.create({
    data: {
      ownerId: userId,
      name: "Upload KB",
      slug: `upl-${crypto.randomUUID().slice(0, 8)}`,
      description: DESCRIPTION,
      state: "ACTIVE",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });
}

async function writeFrames(userId: string, kbId: string, uploadId: string, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const slice = bytes.subarray(offset, Math.min(offset + UPLOAD_MAX_CHUNK_BYTES, bytes.length));
    const result = await uploadWrite(getKbRuntime(), userId, assetsDir, {
      kbId,
      uploadId,
      offset,
      bytesBase64: slice.toString("base64"),
    });
    offset = result.offset;
  }
  return offset;
}

describe("kb staged uploads", () => {
  it("shares outstanding upload capacity with repository paths but not independent filesystems", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const otherRoot = statSync(assetsDir).dev === statSync("/dev/shm").dev ? "/tmp" : "/dev/shm";
    const otherDevice = mkdtempSync(join(otherRoot, "kb-upload-quota-"));
    const amount = BigInt(CAS_BLOB_MAX_BYTES);
    const subjectId = filesystemSubject(assetsDir);
    const balance = () =>
      prisma.quotaAccount.findUnique({
        where: { dimension_subjectId: { dimension: "DISK_VOLUME", subjectId } },
      });
    const reserve = (path, bytes) =>
      runLockedOperation({
        connectionString: db.urls.runtime,
        opId: crypto.randomUUID(),
        kind: "kb-write",
        kbIds: [base.id],
        run: (lease) =>
          reserveQuota(lease, {
            opId: crypto.randomUUID(),
            charges: [],
            expiresAt: new Date(Date.now() + 60_000),
            disks: [{ path, bytes, meter: statfsDiskMeter(path) }],
          }),
      });
    const release = (ids) =>
      runLockedOperation({
        connectionString: db.urls.runtime,
        opId: crypto.randomUUID(),
        kind: "kb-write",
        kbIds: [base.id],
        run: (lease) => releaseQuota(lease, ids),
      });
    let separate: Awaited<ReturnType<typeof reserveQuota>> | undefined;
    try {
      expect(statSync(assetsDir).dev).toBe(statSync(reposDir).dev);
      expect(statSync(otherDevice).dev).not.toBe(statSync(assetsDir).dev);
      expect(await balance()).toBeNull();
      fsFault.freeBytes = KB_LIMITS.freeDiskFloorBytes + amount;
      const input = {
        kbId: base.id,
        idempotencyKey: "shared-device-quota-upload",
        kind: "asset",
        size: Number(amount),
        contentHash: sha256Buffer(minimalWav()),
        mime: "audio/wav",
      };
      const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, input);
      expect(statSync(stagedUploadPath(assetsDir, begin.uploadId)).size).toBe(0);
      expect((await balance()).reserved).toBe(amount);
      // A new request/lease reuses the persisted account, including a begin replay.
      expect(await uploadBegin(getKbRuntime(), user.id, assetsDir, input)).toEqual(begin);
      await expect(reserve(reposDir, 1n << 20n)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      expect((await balance()).reserved).toBe(amount);
      separate = await reserve(otherDevice, amount);
      expect(
        await prisma.quotaAccount.findUnique({
          where: {
            dimension_subjectId: {
              dimension: "DISK_VOLUME",
              subjectId: filesystemSubject(otherDevice),
            },
          },
        }),
      ).toMatchObject({ reserved: amount });
      await db.query(
        "runtime",
        `UPDATE "staged_upload" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`,
        [begin.uploadId],
      );
      await expect(
        uploadFinish(getKbRuntime(), user.id, assetsDir, {
          kbId: base.id,
          uploadId: begin.uploadId,
        }),
      ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
      expect((await balance()).reserved).toBe(0n);
      const repo = await reserve(reposDir, amount);
      expect((await balance()).reserved).toBe(amount);
      await release(repo.reservationIds);
      expect((await balance()).reserved).toBe(0n);
    } finally {
      fsFault.freeBytes = null;
      if (separate) await release(separate.reservationIds);
      rmSync(otherDevice, { recursive: true, force: true });
    }
  });

  it("preserves storage errors on acknowledged retries and current-offset reads", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.from("abcdef");
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "rewind-storage-error-key",
      kind: "markdown",
      size: bytes.length,
      contentHash: sha256Buffer(bytes),
      mime: "text/markdown",
    });
    const write = (offset, chunk) =>
      uploadWrite(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
        offset,
        bytesBase64: chunk.toString("base64"),
      });
    const first = bytes.subarray(0, 3);
    const tail = bytes.subarray(3);
    await write(0, first);
    try {
      fsFault.readError = true;
      await expect(write(0, first)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await expect(write(3, tail)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    } finally {
      fsFault.readError = false;
    }
    expect(await prisma.stagedUpload.findUnique({ where: { id: begin.uploadId } })).toMatchObject({
      offset: 3,
    });
    expect(await write(0, first)).toMatchObject({ offset: 3 });
    await expect(write(0, Buffer.from("xxx"))).rejects.toMatchObject({ code: "CONFLICT" });
    const path = stagedUploadPath(assetsDir, begin.uploadId);
    truncateSync(path, 1);
    await expect(write(0, first)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    writeFileSync(path, first);
    // Complete unacknowledged tails must match too; partial tails can be rewritten.
    writeFileSync(path, Buffer.from("abcxxx"));
    await expect(write(3, tail)).rejects.toMatchObject({ code: "CONFLICT" });
    writeFileSync(path, Buffer.from("abcd"));
    expect(await write(3, tail)).toMatchObject({ offset: 6 });
    expect(
      await uploadFinish(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
      }),
    ).toMatchObject({ state: "READY" });
  });

  it("uploads a 25 MiB asset in frames, accepts duplicate chunk retry, finishes once", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.alloc(CAS_BLOB_MAX_BYTES, 0x61);
    minimalWav().copy(bytes, 0);
    const hash = sha256Buffer(bytes);
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "asset-25m-upload-key12",
      kind: "asset",
      size: bytes.length,
      contentHash: hash,
      mime: "audio/wav",
    });
    await writeFrames(user.id, base.id, begin.uploadId, bytes);
    await expect(
      uploadFinish(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }, 120_000);

  it("accepts an identical chunk retry at the same offset", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = minimalWav();
    const hash = sha256Buffer(bytes);
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "retry-chunk-small-wav1",
      kind: "asset",
      size: bytes.length,
      contentHash: hash,
      mime: "audio/wav",
    });
    const chunk = bytes.toString("base64");
    const first = await uploadWrite(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      uploadId: begin.uploadId,
      offset: 0,
      bytesBase64: chunk,
    });
    const retry = await uploadWrite(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      uploadId: begin.uploadId,
      offset: 0,
      bytesBase64: chunk,
    });
    expect(retry.offset).toBe(first.offset);
  });

  it("finishes a trusted small asset upload to READY", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = minimalWav();
    const hash = sha256Buffer(bytes);
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "small-asset-finish12",
      kind: "asset",
      size: bytes.length,
      contentHash: hash,
      mime: "audio/wav",
    });
    await writeFrames(user.id, base.id, begin.uploadId, bytes);
    const finish = await uploadFinish(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      uploadId: begin.uploadId,
    });
    expect(finish.state).toBe("READY");
  });

  it("returns NOT_FOUND for stolen upload id", async () => {
    const ownerUser = await owner();
    const other = await owner();
    const base = await activeKb(ownerUser.id);
    const bytes = Buffer.from("# hello\n");
    const hash = sha256Buffer(bytes);
    const begin = await uploadBegin(getKbRuntime(), ownerUser.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "md-upload-stolen12",
      kind: "markdown",
      size: bytes.length,
      contentHash: hash,
      mime: "text/markdown",
    });
    await expect(
      uploadWrite(getKbRuntime(), other.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
        offset: 0,
        bytesBase64: bytes.toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects hash mismatch at finish", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.from("# ok\n");
    const wrongHash = sha256Buffer(Buffer.from("other"));
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "md-hash-mismatch12",
      kind: "markdown",
      size: bytes.length,
      contentHash: wrongHash,
      mime: "text/markdown",
    });
    await writeFrames(user.id, base.id, begin.uploadId, bytes);
    await expect(
      uploadFinish(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects invalid utf8 markdown at finish", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bad = Buffer.from([0xff, 0xfe, 0xfd]);
    const hash = sha256Buffer(bad);
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "md-bad-utf8-finish1",
      kind: "markdown",
      size: bad.length,
      contentHash: hash,
      mime: "text/markdown",
    });
    await writeFrames(user.id, base.id, begin.uploadId, bad);
    await expect(
      uploadFinish(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("releases quota once on expiry and rejects late finish", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.from("x");
    const hash = sha256Buffer(bytes);
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "expire-quota-once12",
      kind: "markdown",
      size: bytes.length,
      contentHash: hash,
      mime: "text/markdown",
    });
    const reserved = await db.query(
      "runtime",
      `SELECT "reservationIds" FROM "staged_upload" WHERE id = $1`,
      [begin.uploadId],
    );
    const [reservationId] = reserved.rows[0].reservationIds;
    const accountBefore = await db.query(
      "runtime",
      `SELECT a.reserved::text AS reserved, r.amount::text AS amount
         FROM "quota_reservation" r JOIN "quota_account" a ON a.id = r."accountId"
        WHERE r.id = $1`,
      [reservationId],
    );
    const reservationAmount = BigInt(accountBefore.rows[0].amount);
    const reservedBefore = BigInt(accountBefore.rows[0].reserved);
    expect(reservationAmount).toBeGreaterThan(0n);
    // The quota account is shared with other tests in this file (per-user,
    // per-dimension), so assert the delta this reservation contributes
    // rather than an absolute balance.
    expect(reservedBefore).toBeGreaterThanOrEqual(reservationAmount);

    await db.query(
      "runtime",
      `UPDATE "staged_upload" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`,
      [begin.uploadId],
    );

    // A write on an already-expired upload must be denied promptly (not the
    // ~30s MUTATION_DEADLINE a nested-session self-deadlock would produce)
    // and must never advance the offset or resurrect the row.
    const writeStarted = Date.now();
    await expect(
      uploadWrite(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
        offset: 0,
        bytesBase64: bytes.toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    expect(Date.now() - writeStarted).toBeLessThan(5_000);

    const finishStarted = Date.now();
    await expect(
      uploadFinish(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        uploadId: begin.uploadId,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    expect(Date.now() - finishStarted).toBeLessThan(5_000);

    const reservation = await db.query(
      "runtime",
      `SELECT outcome::text AS outcome FROM "quota_reservation" WHERE id = $1`,
      [reservationId],
    );
    expect(reservation.rows[0].outcome).toBe("RELEASED");
    const accountAfter = await db.query(
      "runtime",
      `SELECT reserved::text AS reserved FROM "quota_account"
        WHERE id = (SELECT "accountId" FROM "quota_reservation" WHERE id = $1)`,
      [reservationId],
    );
    expect(BigInt(accountAfter.rows[0].reserved)).toBe(reservedBefore - reservationAmount);

    const row = await db.query(
      "runtime",
      `SELECT state::text AS state FROM "staged_upload" WHERE id = $1`,
      [begin.uploadId],
    );
    expect(row.rows[0].state).toBe("EXPIRED");
  }, 20_000);

  it("durably reclaims (not just marks reclaimed) when the leaf-file fsync fails during creation", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.from("# ok\n");
    const hash = sha256Buffer(bytes);
    // createStagedUploadFile's O_CREAT|O_EXCL open succeeds, then the very
    // next fsync (on the new leaf file, not a directory) throws — the file
    // exists on disk even though begin ultimately fails.
    fsFault.leafFsyncOnce = true;
    try {
      await expect(
        uploadBegin(getKbRuntime(), user.id, assetsDir, {
          kbId: base.id,
          idempotencyKey: "begin-leaf-fsync-fail1",
          kind: "markdown",
          size: bytes.length,
          contentHash: hash,
          mime: "text/markdown",
        }),
      ).rejects.toThrow();
    } finally {
      fsFault.leafFsyncOnce = false;
    }
    const row = await db.query(
      "runtime",
      `SELECT id, state::text AS state, "stagingReclaimedAt" FROM "staged_upload" WHERE "kbId" = $1`,
      [base.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].state).toBe("EXPIRED");
    // The old behavior blindly marked this reclaimed without ever attempting
    // removal, leaking the on-disk file forever (the sweep only revisits rows
    // with stagingReclaimedAt IS NULL). The fix must have actually removed it.
    expect(row.rows[0].stagingReclaimedAt).not.toBeNull();
    expect(existsSync(stagedUploadPath(assetsDir, row.rows[0].id))).toBe(false);
    await expect(
      uploadBegin(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        idempotencyKey: "begin-leaf-fsync-fail1",
        kind: "markdown",
        size: bytes.length,
        contentHash: hash,
        mime: "text/markdown",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    expect(existsSync(stagedUploadPath(assetsDir, row.rows[0].id))).toBe(false);
  });

  it("heals a missing staging file on begin replay after the receipt already committed", async () => {
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.from("# heal\n");
    const hash = sha256Buffer(bytes);
    const beginInput = {
      kbId: base.id,
      idempotencyKey: "begin-replay-heal-file1",
      kind: "markdown" as const,
      size: bytes.length,
      contentHash: hash,
      mime: "text/markdown",
    };
    const first = await uploadBegin(getKbRuntime(), user.id, assetsDir, beginInput);
    expect(existsSync(stagedUploadPath(assetsDir, first.uploadId))).toBe(true);

    // Simulate the crash window this closes: the barrier's own transaction
    // (row insert, quota reserve, FINALIZED receipt) already committed, but
    // the file was never durably created — a real crash lands here between
    // that commit and createStagedUploadFile. Removing the file after the
    // fact reproduces the same on-disk state without needing an actual
    // process kill.
    rmSync(stagedUploadPath(assetsDir, first.uploadId));

    // A replay with the identical idempotency key must not trust the stored
    // "success" receipt blindly — it has to notice the file is missing and
    // (re)create it, rather than handing back a receipt for an upload that
    // can never be written to.
    const replays = await Promise.all([
      uploadBegin(getKbRuntime(), user.id, assetsDir, beginInput),
      uploadBegin(getKbRuntime(), user.id, assetsDir, beginInput),
    ]);
    expect(replays.map((replay) => replay.uploadId)).toEqual([first.uploadId, first.uploadId]);
    expect(existsSync(stagedUploadPath(assetsDir, first.uploadId))).toBe(true);

    // The healed upload is now actually usable end to end.
    await writeFrames(user.id, base.id, first.uploadId, bytes);
    const finish = await uploadFinish(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      uploadId: first.uploadId,
    });
    expect(finish.state).toBe("READY");
  });

  it("bounds retry progress when a terminal upload's staging file cannot be unlinked", async () => {
    // Earlier tests in this shared-database file (e.g. the request-time
    // expiry test above) can leave their own already-EXPIRED,
    // stagingReclaimedAt-IS-NULL rows behind — the request-time expiry path
    // never calls commitStagedUploadExpiry. Drain those first so this test's
    // pass-count assertions are about this row alone, not the batch.
    await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);

    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.from("# stuck\n");
    const hash = sha256Buffer(bytes);
    const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
      kbId: base.id,
      idempotencyKey: "stuck-reclaim-file1",
      kind: "markdown",
      size: bytes.length,
      contentHash: hash,
      mime: "text/markdown",
    });
    await db.query(
      "runtime",
      `UPDATE "staged_upload" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`,
      [begin.uploadId],
    );
    fsFault.unlinkFailForId = begin.uploadId;
    try {
      // Pass 1: the row transitions WRITING -> EXPIRED. That state change is
      // progress on its own, even though the file-reclaim attempt inside the
      // same call fails.
      const firstPass = await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);
      expect(firstPass).toBe(1);
      const afterFirst = await db.query(
        "runtime",
        `SELECT state::text AS state, "stagingReclaimedAt" FROM "staged_upload" WHERE id = $1`,
        [begin.uploadId],
      );
      expect(afterFirst.rows[0].state).toBe("EXPIRED");
      expect(afterFirst.rows[0].stagingReclaimedAt).toBeNull();

      // Pass 2 visits the failed row once, reports no progress and returns.
      // Failure stays retryable without spinning within this traversal.
      const secondPass = await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);
      expect(secondPass).toBe(0);
    } finally {
      fsFault.unlinkFailForId = "";
    }

    // Once the fault clears, the very next pass reclaims it for real.
    const finalPass = await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);
    expect(finalPass).toBe(1);
    const finalRow = await db.query(
      "runtime",
      `SELECT "stagingReclaimedAt" FROM "staged_upload" WHERE id = $1`,
      [begin.uploadId],
    );
    expect(finalRow.rows[0].stagingReclaimedAt).not.toBeNull();
  }, 20_000);

  it.each(["EXPIRED", "ABORTED"])(
    "does not resurrect a reclaimed %s upload on begin replay",
    async (state) => {
      const user = await owner();
      const base = await activeKb(user.id);
      const bytes = Buffer.from("# terminal\n");
      const input = {
        kbId: base.id,
        idempotencyKey: "terminal-replay-key1",
        kind: "markdown",
        size: bytes.length,
        contentHash: sha256Buffer(bytes),
        mime: "text/markdown",
      };
      const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, input);
      await prisma.stagedUpload.update({
        where: { id: begin.uploadId },
        data: { expiresAt: new Date(0) },
      });
      await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);
      await prisma.stagedUpload.update({ where: { id: begin.uploadId }, data: { state } });
      const before = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: begin.uploadId } });
      expect(before.stagingReclaimedAt).not.toBeNull();
      await expect(uploadBegin(getKbRuntime(), user.id, assetsDir, input)).rejects.toMatchObject({
        code: "UPLOAD_EXPIRED",
      });
      expect(existsSync(stagedUploadPath(assetsDir, begin.uploadId))).toBe(false);
      expect(
        (await prisma.stagedUpload.findUniqueOrThrow({ where: { id: begin.uploadId } }))
          .stagingReclaimedAt,
      ).toEqual(before.stagingReclaimedAt);
    },
  );

  it.each(["WRITING", "READY"])(
    "settles TTL-elapsed %s begin replay without recreating bytes",
    async (state) => {
      const user = await owner();
      const base = await activeKb(user.id);
      const bytes = Buffer.from("# late\n");
      const input = {
        kbId: base.id,
        idempotencyKey: "ttl-replay-key1",
        kind: "markdown",
        size: bytes.length,
        contentHash: sha256Buffer(bytes),
        mime: "text/markdown",
      };
      const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, input);
      if (state === "READY") {
        await writeFrames(user.id, base.id, begin.uploadId, bytes);
        await uploadFinish(getKbRuntime(), user.id, assetsDir, {
          kbId: base.id,
          uploadId: begin.uploadId,
        });
        // Live READY replay must preserve the sealed bytes and the begin receipt.
        expect(await uploadBegin(getKbRuntime(), user.id, assetsDir, input)).toEqual(begin);
        expect(readFileSync(stagedUploadPath(assetsDir, begin.uploadId))).toEqual(bytes);
      }
      await prisma.stagedUpload.update({
        where: { id: begin.uploadId },
        data: {
          expiresAt: new Date(0),
          ...(state === "READY" ? { readyExpiresAt: new Date(0) } : {}),
        },
      });
      await expect(uploadBegin(getKbRuntime(), user.id, assetsDir, input)).rejects.toMatchObject({
        code: "UPLOAD_EXPIRED",
      });
      const row = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: begin.uploadId } });
      expect(row.state).toBe("EXPIRED");
      expect(row.stagingReclaimedAt).not.toBeNull();
      expect(existsSync(stagedUploadPath(assetsDir, begin.uploadId))).toBe(false);
      expect(
        await prisma.quotaReservation.findMany({
          where: { id: { in: row.reservationIds } },
          take: 10,
        }),
      ).toEqual([expect.objectContaining({ outcome: "RELEASED" })]);
    },
  );

  it.each(["WRITING", "READY"])(
    "never recreates missing acknowledged %s bytes on begin replay",
    async (state) => {
      const user = await owner();
      const base = await activeKb(user.id);
      const bytes = Buffer.from("# missing\n");
      const input = {
        kbId: base.id,
        idempotencyKey: "missing-replay-key1",
        kind: "markdown",
        size: bytes.length,
        contentHash: sha256Buffer(bytes),
        mime: "text/markdown",
      };
      const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, input);
      await writeFrames(user.id, base.id, begin.uploadId, bytes);
      if (state === "READY")
        await uploadFinish(getKbRuntime(), user.id, assetsDir, {
          kbId: base.id,
          uploadId: begin.uploadId,
        });
      rmSync(stagedUploadPath(assetsDir, begin.uploadId));
      await expect(uploadBegin(getKbRuntime(), user.id, assetsDir, input)).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
      expect(existsSync(stagedUploadPath(assetsDir, begin.uploadId))).toBe(false);
      expect(
        (await prisma.stagedUpload.findUniqueOrThrow({ where: { id: begin.uploadId } })).state,
      ).toBe("EXPIRED");
    },
  );

  it("visits later expired WRITING and READY rows past a full failed reclaim page", async () => {
    await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);
    expect(await sweepExpiredStagedUploads(db.urls.runtime, assetsDir)).toBe(0);
    const user = await owner();
    const base = await activeKb(user.id);
    const bytes = Buffer.from("# page\n");
    const later = [];
    for (const state of ["WRITING", "READY"]) {
      const begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, {
        kbId: base.id,
        idempotencyKey: `later-page-${state}`,
        kind: "markdown",
        size: bytes.length,
        contentHash: sha256Buffer(bytes),
        mime: "text/markdown",
      });
      if (state === "READY") {
        await writeFrames(user.id, base.id, begin.uploadId, bytes);
        await uploadFinish(getKbRuntime(), user.id, assetsDir, {
          kbId: base.id,
          uploadId: begin.uploadId,
        });
      }
      await prisma.stagedUpload.update({
        where: { id: begin.uploadId },
        data: {
          expiresAt: new Date(0),
          ...(state === "READY" ? { readyExpiresAt: new Date(0) } : {}),
        },
      });
      later.push(begin.uploadId);
    }
    const firstId = BigInt(`0x${[...later].sort()[0].replaceAll("-", "")}`);
    expect(firstId).toBeGreaterThan(100n);
    const failedIds = Array.from({ length: 100 }, (_, i) => {
      const hex = (firstId - BigInt(i + 1)).toString(16).padStart(32, "0");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
    await prisma.stagedUpload.createMany({
      data: failedIds.map((id) => ({
        id,
        kbId: base.id,
        actorKey: `user:${user.id}`,
        actorUserIdSnapshot: user.id,
        kind: "MARKDOWN",
        declaredSize: bytes.length,
        declaredHash: sha256Buffer(bytes),
        declaredMime: "text/markdown",
        reservationIds: [],
        expiresAt: new Date(0),
        state: "EXPIRED",
      })),
    });
    fsFault.unlinkFailIds = new Set(failedIds);
    try {
      expect(await sweepExpiredStagedUploads(db.urls.runtime, assetsDir)).toBe(2);
      for (const id of later) {
        const row = await prisma.stagedUpload.findUniqueOrThrow({ where: { id } });
        expect(row.state).toBe("EXPIRED");
        expect(row.stagingReclaimedAt).not.toBeNull();
        expect(existsSync(stagedUploadPath(assetsDir, id))).toBe(false);
        expect(
          await prisma.quotaReservation.findMany({
            where: { id: { in: row.reservationIds } },
            take: 10,
          }),
        ).toEqual([expect.objectContaining({ outcome: "RELEASED" })]);
      }
      expect(await sweepExpiredStagedUploads(db.urls.runtime, assetsDir)).toBe(0);
      expect(
        await prisma.stagedUpload.count({
          where: { id: { in: failedIds }, stagingReclaimedAt: null },
        }),
      ).toBe(100);
    } finally {
      fsFault.unlinkFailIds.clear();
    }
    expect(await sweepExpiredStagedUploads(db.urls.runtime, assetsDir)).toBe(100);
    expect(await sweepExpiredStagedUploads(db.urls.runtime, assetsDir)).toBe(0);
  }, 60_000);

  it.each([
    ["begin", "identity"],
    ["write", "identity"],
    ["finish", "identity"],
    ["begin", "charge"],
    ["write", "charge"],
    ["finish", "charge"],
  ])(
    "orders %s against a production ban during its %s await and denies subsequent replay",
    async (operation, boundary) => {
      const user = await owner();
      const base = await activeKb(user.id);
      const bytes = Buffer.from("# authority\n");
      const beginInput = {
        kbId: base.id,
        idempotencyKey: "authority-order-key1",
        kind: "markdown",
        size: bytes.length,
        contentHash: sha256Buffer(bytes),
        mime: "text/markdown",
      };
      let begin: Awaited<ReturnType<typeof uploadBegin>> | undefined;
      if (operation !== "begin")
        begin = await uploadBegin(getKbRuntime(), user.id, assetsDir, beginInput);
      if (operation === "finish") await writeFrames(user.id, base.id, begin.uploadId, bytes);
      const action = () =>
        operation === "begin"
          ? uploadBegin(getKbRuntime(), user.id, assetsDir, beginInput)
          : operation === "write"
            ? uploadWrite(getKbRuntime(), user.id, assetsDir, {
                kbId: base.id,
                uploadId: begin.uploadId,
                offset: 0,
                bytesBase64: bytes.toString("base64"),
              })
            : uploadFinish(getKbRuntime(), user.id, assetsDir, {
                kbId: base.id,
                uploadId: begin.uploadId,
              });
      let ban: Promise<unknown> | undefined;
      let triggered = false;
      async function queueBan() {
        if (triggered) return;
        triggered = true;
        let pid: number | undefined;
        ban = prisma.$transaction(
          async (tx) => {
            pid = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
            await lockIdentityAuthority(tx);
            await tx.user.update({ where: { id: user.id }, data: { banned: true } });
          },
          { timeout: 10_000 },
        );
        // Observe a real blocked lock request, not timing luck or a mocked
        // permission result. An unlocked identity read lets the ban commit and
        // this assertion fails on the original F05 implementation.
        await expect
          .poll(
            async () => {
              if (!pid) return false;
              const locks = await db.query(
                "runtime",
                `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`,
                [pid],
              );
              return locks.rows.length > 0;
            },
            { timeout: 2_000, interval: 5 },
          )
          .toBe(true);
      }
      const transaction = HeldLockLease.prototype.transaction;
      const spy = vi
        .spyOn(HeldLockLease.prototype, "transaction")
        .mockImplementation(function (fn, reservation) {
          return transaction.call(
            this,
            (query) =>
              fn(async (sql, values) => {
                const result = await query(sql, values);
                if (boundary === "identity" && sql.includes('FROM "user" u')) await queueBan();
                return result;
              }),
            reservation,
          );
        });
      configureKbRuntime({
        ...runtimeConfig,
        ratePort: {
          async consume(bucket, key, points) {
            if (boundary === "charge") await queueBan();
            return memoryRatePort.consume(bucket, key, points);
          },
        },
      });
      try {
        const result = await action();
        expect(triggered).toBe(true);
        if (operation === "begin") begin = result;
        await ban;
        const row = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: begin.uploadId } });
        expect(row.offset).toBe(operation === "begin" ? 0 : bytes.length);
        expect(row.state).toBe(operation === "finish" ? "READY" : "WRITING");
        expect(readFileSync(stagedUploadPath(assetsDir, begin.uploadId))).toEqual(
          operation === "begin" ? Buffer.alloc(0) : bytes,
        );
        await expect(action()).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await prisma.stagedUpload.count({ where: { kbId: base.id } })).toBe(1);
      } finally {
        spy.mockRestore();
        configureKbRuntime({ ...runtimeConfig, ratePort: memoryRatePort });
        await ban;
      }
    },
  );
});
