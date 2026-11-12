import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@knowledge-base/db/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import { createDiskBlobStore } from "./blob-store-disk";
import { authorizeDocumentRead } from "./documents-read";
import { EXPORT_LIMITS, exportDescriptor, fileIdentity } from "./exports";
import type { HeldLockLease, LockQuery } from "./lock";
import type { KbRuntimeConfig } from "./runtime";
import { completeExport, readTransfer } from "./transfers";

vi.mock("./documents-read", () => ({ authorizeDocumentRead: vi.fn() }));
const prisma = mockDeep<PrismaClient>();
const actor = { principal: { kind: "browser" as const, userId: "owner" } };
let root: string;
let runtime: KbRuntimeConfig;
let row: NonNullable<Awaited<ReturnType<typeof prisma.exportArtifact.findUnique>>>;
let path: string;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "kb-transfer-"));
  await mkdir(join(root, ".private/tmp"), { recursive: true });
  const id = randomUUID();
  path = join(root, ".private/tmp", `export-${id}`);
  await writeFile(path, Buffer.alloc(196610, 7));
  const file = await open(path, "r");
  const identity = fileIdentity(await file.stat({ bigint: true }));
  await file.close();
  row = {
    id,
    kbId: "a".repeat(24),
    actorKey: "user:owner",
    actorUserIdSnapshot: "owner",
    kind: "whole",
    idempotencyKey: "a".repeat(16),
    requestHash: "hash",
    rev: "a".repeat(40),
    size: 196610,
    contentHash: `sha256:${"b".repeat(64)}`,
    fileIdentity: identity,
    frameHashes: [196608, 2].map((n) =>
      createHash("sha256").update(Buffer.alloc(n, 7)).digest("hex"),
    ),
    offset: 0,
    reservationIds: [],
    expiresAt: new Date(Date.now() + 900000),
    deadlineAt: new Date(),
    state: "READY",
    reclaimedAt: null,
    downloadCompletedAt: null,
    createdAt: new Date(),
  };
  const lease = mockDeep<HeldLockLease>();
  const query: LockQuery = async <R>(sql: string, values?: unknown[]) => ({
    rows: await prisma.$queryRawUnsafe<R[]>(sql, ...(values ?? [])),
    rowCount: 1,
  });
  lease.transaction.mockImplementation((work) => work(query));
  runtime = {
    prisma,
    assetsDir: root,
    blobStore: createDiskBlobStore(root),
    coordinator: {
      run: (options) =>
        options.run({
          lease,
          signal: new AbortController().signal,
          issueWriteCapability: () => {
            throw new Error("unused");
          },
        }),
    },
  } as KbRuntimeConfig;
  prisma.exportArtifact.findUnique.mockImplementation(async () => row);
  prisma.$executeRawUnsafe.mockResolvedValue(1);
  // Mirrors Postgres' 1-based inclusive `"frameHashes"[from:to]` slice.
  prisma.$queryRawUnsafe.mockImplementation((async (sql: string, ...args: unknown[]) => {
    if (sql.startsWith("SELECT id,")) {
      const selected = await prisma.exportArtifact.findUnique({ where: { id: row.id } });
      return selected ? [selected] : [];
    }
    if (sql.startsWith("UPDATE")) return [];
    return [{ hashes: row.frameHashes.slice(Number(args[1]) - 1, Number(args[2])) }];
  }) as never);
  prisma.exportArtifact.findMany.mockResolvedValue([]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const input = (offset = 0) => ({ kbId: row.kbId, transferId: row.id, offset });
describe("actor-bound immutable transfer frames", () => {
  it("reconstructs bounded frames with exact offsets, EOF and descriptor hash", async () => {
    const first = await readTransfer(runtime, actor, input());
    const last = await readTransfer(runtime, actor, input(first.nextOffset));
    expect(first).toMatchObject({
      offset: 0,
      nextOffset: 196608,
      eof: false,
      contentHash: exportDescriptor(row).contentHash,
    });
    expect(last).toMatchObject({ offset: 196608, nextOffset: 196610, eof: true });
    expect(
      Buffer.concat([
        Buffer.from(first.bytesBase64, "base64"),
        Buffer.from(last.bytesBase64, "base64"),
      ]),
    ).toEqual(await readFile(path));
    expect(await readTransfer(runtime, actor, input())).toEqual(first);
    await expect(readTransfer(runtime, actor, input(196610))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
  it("verifies both sealed frames for an unaligned bounded read", async () => {
    const frame = await readTransfer(runtime, actor, { ...input(196607), maxBytes: 3 });
    expect(frame).toMatchObject({ offset: 196607, nextOffset: 196610, eof: true });
    expect(Buffer.from(frame.bytesBase64, "base64")).toEqual(Buffer.alloc(3, 7));
    row.frameHashes[1] = "0".repeat(64);
    await expect(
      readTransfer(runtime, actor, { ...input(196607), maxBytes: 3 }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("denies actor/KB mismatch, expired receipts and non-ready state", async () => {
    for (const patch of [
      { actorKey: "grant:another" },
      { kbId: "b".repeat(24) },
      { expiresAt: new Date(0) },
      { state: "WRITING" },
    ]) {
      const request = input();
      const original = { ...row };
      Object.assign(row, patch);
      await expect(readTransfer(runtime, actor, request)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      row = original;
    }
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it("rechecks revocation before the next frame and late authorization before emission", async () => {
    await readTransfer(runtime, actor, input());
    vi.mocked(authorizeDocumentRead).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "NOT_FOUND" }),
    );
    await expect(readTransfer(runtime, actor, input(196608))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    vi.mocked(authorizeDocumentRead)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("late revoke"));
    await expect(readTransfer(runtime, actor, input())).rejects.toThrow("late revoke");
  });
  it("never refreshes expiry and denies expiration during a read", async () => {
    const expires = row.expiresAt;
    await readTransfer(runtime, actor, input());
    expect(row.expiresAt).toBe(expires);
    prisma.$executeRawUnsafe.mockImplementationOnce(async () => {
      row.expiresAt = new Date(0);
      return 1;
    });
    await expect(readTransfer(runtime, actor, input())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(prisma.exportArtifact.update).not.toHaveBeenCalled();
  });
  it("fails on same-size corruption and inode substitution", async () => {
    await writeFile(path, Buffer.alloc(196610, 8));
    await expect(readTransfer(runtime, actor, { ...input(), maxBytes: 1 })).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });
  it("the EOF frame starts the grace window once and never deletes or releases", async () => {
    await readTransfer(runtime, actor, input());
    const graceCalls = () =>
      prisma.$queryRawUnsafe.mock.calls.filter(([sql]) =>
        String(sql).includes("downloadCompletedAt"),
      );
    expect(graceCalls()).toHaveLength(0);
    const last = await readTransfer(runtime, actor, input(196608));
    expect(last.eof).toBe(true);
    expect(graceCalls()).toHaveLength(1);
    const [sql, id, graceMs] = graceCalls()[0]!;
    expect(String(sql)).toMatch(/WHEN "downloadCompletedAt" IS NULL/);
    expect(String(sql)).toMatch(/state='READY'/);
    expect(id).toBe(row.id);
    expect(graceMs).toBe(EXPORT_LIMITS.graceMs);
    expect(prisma.exportArtifact.updateMany).not.toHaveBeenCalled();
    expect(prisma.exportArtifact.findMany).not.toHaveBeenCalled();
  });
  it("only the export's own actor on its own KB can acknowledge; WRITING is a conflict", async () => {
    for (const patch of [{ actorKey: "grant:another" }, { kbId: "b".repeat(24) }]) {
      const original = { ...row };
      Object.assign(row, patch);
      await expect(
        completeExport(runtime, actor, { kbId: original.kbId, transferId: row.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      row = original;
    }
    prisma.exportArtifact.findUnique.mockResolvedValueOnce(null);
    await expect(
      completeExport(runtime, actor, { kbId: row.kbId, transferId: row.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    row.state = "WRITING";
    await expect(
      completeExport(runtime, actor, { kbId: row.kbId, transferId: row.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it("loads only this read's frame-hash slice, never the whole array on admission", async () => {
    await readTransfer(runtime, actor, input(196608));
    for (const call of prisma.exportArtifact.findUnique.mock.calls)
      expect(call[0]).toMatchObject({ select: expect.not.objectContaining({ frameHashes: true }) });
    expect(
      prisma.$queryRawUnsafe.mock.calls
        .filter(([sql]) => String(sql).includes('SELECT "frameHashes"'))
        .map((call) => call.slice(1)),
    ).toEqual([[row.id, 2, 2]]);
  });
});
