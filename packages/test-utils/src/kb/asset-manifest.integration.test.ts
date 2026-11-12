import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assetValidationContext, prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { assetCacheBinding, createAssetCache } from "@knowledge-base/api/lib/kb/asset-cache";
import { createAssetPublicationState } from "@knowledge-base/api/lib/kb/asset-publication-state";
import { createAssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import { createAssetCacheTransactions } from "@knowledge-base/api/lib/kb/asset-storage-state";
import {
  type AssetImportRequest,
  listAssets,
  mutateAsset,
} from "@knowledge-base/api/lib/kb/assets";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import type { BlobStore } from "@knowledge-base/api/lib/kb/blob-store";
import { casBlobPath, createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { assetS3Key, createS3BlobStore } from "@knowledge-base/api/lib/kb/blob-store-s3";
import {
  type ApplyResult,
  type Change,
  type ChangesApplyRequest,
  createChangesPublication,
} from "@knowledge-base/api/lib/kb/changes";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { readDocumentAtRevision } from "@knowledge-base/api/lib/kb/documents-read";
import { minimalWav, sha256Buffer } from "@knowledge-base/api/lib/kb/fixtures/media-bytes";
import { kbBareRepoPath, readHeadSha } from "@knowledge-base/api/lib/kb/git-read";
import {
  createTreeReuseCommit,
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import {
  canonicalRequestHash,
  type PublicationBarrier,
  reconcileKbIntents,
} from "@knowledge-base/api/lib/kb/operation-intent";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { getPullRequest } from "@knowledge-base/api/lib/kb/pull-requests";
import { expireQuota } from "@knowledge-base/api/lib/kb/quota";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import {
  stagedUploadPath,
  sweepExpiredStagedUploads,
  UPLOAD_MAX_CHUNK_BYTES,
  uploadBegin,
  uploadFinish,
  uploadWrite,
} from "@knowledge-base/api/lib/kb/uploads";
import { validateNewlyReachableCommits } from "@knowledge-base/api/lib/kb/validate-tree";
import { assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index";
import { createAssetS3Fixture } from "./s3-fixture";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();

const prisma = db.createPrismaClient("runtime");
const root = mkdtempSync(join(tmpdir(), "kb-assets-19-"));
const reposDir = join(root, "repos");
const assetsDir = join(root, "assets");
mkdirSync(reposDir, { recursive: true, mode: 0o700 });
mkdirSync(assetsDir, { recursive: true, mode: 0o700 });
const executor: GitMutatingExecutor = {
  exec: ({ cwd, argv, env }) =>
    new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("git failed"))));
    }),
};
const runtime: KbRuntimeConfig = {
  prisma,
  reposDir,
  assetsDir,
  blobStore: createDiskBlobStore(assetsDir),
  connectionString: db.urls.runtime,
  canonicalOrigin: "https://kb.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  createGitExecutor: () => executor,
  coordinator: {
    run: (options) =>
      runLockedOperation({
        connectionString: db.urls.runtime,
        opId: options.opId,
        kind: "kb-write",
        kbIds: options.kbIds,
        barrier: options.barrier,
        run: (lease) =>
          options.run({
            lease,
            signal: lease.scope.signal,
            issueWriteCapability: () => {
              throw new Error("test executor only");
            },
          }),
      }),
  },
};
setKbRecoveryComplete(true);
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(root, { recursive: true, force: true });
});
const user = () =>
  prisma.user.create({
    data: {
      name: "asset tester",
      email: `asset-${randomUUID()}@example.invalid`,
      emailVerified: true,
    },
  });
async function kb(ownerId: string) {
  const row = await prisma.knowledgeBase.create({
    data: {
      ownerId,
      name: "Assets",
      slug: `assets-${randomUUID().slice(0, 8)}`,
      description: "Asset manifest integration fixture",
      state: "CREATING",
    },
  });
  const headSha = await writeInitialMainCommit(
    { reposDir, kbId: row.id, executor },
    { message: "init", description: row.description },
  );
  return prisma.knowledgeBase.update({ where: { id: row.id }, data: { headSha, state: "ACTIVE" } });
}
async function upload(
  userId: string,
  kbId: string,
  bytes = minimalWav(),
  kind: "markdown" | "asset" = "asset",
  ratePort = runtime.ratePort,
) {
  const uploadRuntime = { ...runtime, ratePort };
  const begun = await uploadBegin(uploadRuntime, userId, assetsDir, {
    kbId,
    idempotencyKey: randomUUID(),
    kind,
    size: bytes.length,
    contentHash: sha256Buffer(bytes),
    mime: kind === "asset" ? "audio/wav" : "text/markdown",
  });
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_MAX_CHUNK_BYTES)
    await uploadWrite(uploadRuntime, userId, assetsDir, {
      kbId,
      uploadId: begun.uploadId,
      offset,
      bytesBase64: bytes.subarray(offset, offset + UPLOAD_MAX_CHUNK_BYTES).toString("base64"),
    });
  await uploadFinish(uploadRuntime, userId, assetsDir, { kbId, uploadId: begun.uploadId });
  return begun.uploadId;
}
async function apply(
  userId: string,
  kbId: string,
  request: ChangesApplyRequest | AssetImportRequest,
  key = randomUUID(),
  barrier?: PublicationBarrier,
  blobStore: BlobStore = runtime.blobStore,
): Promise<ApplyResult> {
  // A client naming a PR read its head. Explicit undefined tests omissions.
  if (request.proposalNumber !== undefined && !("proposalHeadSha" in request)) {
    const row = await prisma.pullRequest.findUnique({
      where: { kbId_number: { kbId, number: request.proposalNumber } },
      select: { headSha: true },
    });
    if (row) request = { ...request, proposalHeadSha: row.headSha };
  }
  const publication = createChangesPublication({
    store: prismaAuthorityStore(prisma),
    principal: { kind: "browser", userId },
    reposDir,
    assetsDir,
    blobStore,
    kbId,
    request,
    operation: request.mode === "import" ? "ASSET_IMPORT" : "CHANGES_APPLY",
    idempotencyKey: key,
    requestHash: canonicalRequestHash(request),
    barrier,
    diskMeter: runtime.diskMeter,
  });
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: request.mode === "import" ? [kbId, request.source.kbId] : [kbId],
    barrier: publication.barrier,
    run: async (ctx) => (await publication.publish(ctx.lease, executor)) as unknown as ApplyResult,
  });
}
const edit = (
  baseRevision: string,
  changes: Change[],
  proposalNumber?: number,
): ChangesApplyRequest => ({
  mode: "edit",
  title: "Assets and text",
  baseRevision,
  changes,
  sourceSessionIds: [],
  ...(proposalNumber ? { proposalNumber } : {}),
});
async function recover(kbId: string) {
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [kbId],
    run: (ctx) => ctx.lease.transaction((query) => reconcileKbIntents(query, reposDir, kbId)),
  });
}
/** Kill only a disposable publisher after its Git child exited and ref fsynced. */
async function crashAfterRef(
  userId: string,
  kbId: string,
  request: ChangesApplyRequest,
  key: string,
  remoteSetup?: string,
) {
  const moduleUrl = (name: string) =>
    JSON.stringify(
      pathToFileURL(resolve(import.meta.dirname, `../../../api/src/lib/kb/${name}.ts`)).href,
    );
  const childPath = join(root, `crash-${randomUUID()}.mts`);
  writeFileSync(
    childPath,
    `
    import {execFileSync} from "node:child_process";
    import {randomUUID} from "node:crypto";
    import {createChangesPublication} from ${moduleUrl("changes")};
    import {createDiskBlobStore} from ${moduleUrl("blob-store-disk")};
    import {runLockedOperation} from ${moduleUrl("authority-lock")};
    import {canonicalRequestHash} from ${moduleUrl("operation-intent")};
    ${remoteSetup ?? `const blobStore = createDiskBlobStore(${JSON.stringify(assetsDir)});`}
    const request = ${JSON.stringify(request)};
    const publication = createChangesPublication({store:{},principal:{kind:"browser",userId:${JSON.stringify(userId)}},
      reposDir:${JSON.stringify(reposDir)},assetsDir:${JSON.stringify(assetsDir)},blobStore,kbId:${JSON.stringify(kbId)},
      request,operation:"CHANGES_APPLY",idempotencyKey:${JSON.stringify(key)},requestHash:canonicalRequestHash(request),
      barrier:{afterRefUpdate:()=>process.kill(process.pid,"SIGKILL")}});
    await runLockedOperation({connectionString:process.env.KB_TEST_RUNTIME_URL,opId:randomUUID(),kind:"kb-write",kbIds:[${JSON.stringify(kbId)}],
      barrier:publication.barrier,run:lease=>publication.publish(lease,{exec:async ({cwd,argv,env})=>{execFileSync(argv[0],argv.slice(1),{cwd,env,stdio:"ignore"});}})});
  `,
  );
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), childPath], {
      env: { ...process.env, KB_TEST_RUNTIME_URL: db.urls.runtime },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (_code, signal) => resolve(signal));
  });
  expect(signal).toBe("SIGKILL");
}
const staged = (id: string) => prisma.stagedUpload.findUniqueOrThrow({ where: { id } });

describe("asset-manifest", () => {
  // These staged fixtures represent uploads collected across rate windows.
  // Each upload retains real per-call rate charging; publication is still one call.
  it("publishes 32 staged Markdown creates and replacements through the full upload path", async () => {
    const actor = await user(),
      target = await kb(actor.id);
    let base = target.headSha!;
    for (const op of ["create", "replace"] as const) {
      const changes: Change[] = [];
      for (let i = 0; i < 32; i++)
        changes.push({
          op,
          path: `staged/${i}.md`,
          content: {
            uploadId: await upload(
              actor.id,
              target.id,
              Buffer.from(`# ${op} ${i}\n`),
              "markdown",
              createMemoryRatePort(),
            ),
          },
        });
      const result = await apply(actor.id, target.id, edit(base, changes));
      expect(result.changedPaths).toHaveLength(32);
      base = result.commitSha;
      for (const change of changes)
        if ("content" in change && "uploadId" in change.content)
          expect((await staged(change.content.uploadId)).state).toBe("CONSUMED");
    }
  });

  it.each(["main", "proposal", "mixed", "capacity"] as const)(
    "publishes a full 32-operation asset batch atomically (%s)",
    async (mode) => {
      const owner = await user(),
        target = await kb(owner.id);
      const actor = mode === "proposal" ? await user() : owner;
      if (mode === "proposal")
        await prisma.kbShare.create({
          data: { kbId: target.id, userId: actor.id, bits: ["read", "propose"] },
        });
      const changes: Change[] = [];
      let lineageBytes = 0n;
      for (let i = 0; i < 32; i++) {
        if (mode === "mixed" && i % 2) {
          changes.push({
            op: "create",
            path: `batch/${i}.md`,
            content: { markdown: `# Document ${i}\n` },
          });
        } else {
          const bytes = wav(i + 100);
          lineageBytes += BigInt(bytes.length);
          changes.push({
            op: "assetPut",
            path: `batch/${i}.wav`,
            uploadId: await upload(actor.id, target.id, bytes, "asset", createMemoryRatePort()),
          });
        }
      }
      if (mode === "capacity")
        await prisma.$executeRaw`
        INSERT INTO "quota_account" (id, dimension, "subjectId", committed, reserved, "updatedAt")
        VALUES (${randomUUID()}, 'KB_LINEAGE_BYTES', ${target.id}, 1073741824, 0, now())`;
      const request = edit(target.headSha!, changes),
        key = randomUUID();
      if (mode === "capacity") {
        await expect(apply(actor.id, target.id, request, key)).rejects.toMatchObject({
          code: "QUOTA_EXCEEDED",
        });
        expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(target.headSha);
        expect(
          await prisma.operationIntent.count({
            where: { kbId: target.id, operation: "CHANGES_APPLY" },
          }),
        ).toBe(0);
        expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(0);
        for (const change of changes)
          if (change.op === "assetPut") expect((await staged(change.uploadId)).state).toBe("READY");
        return;
      }
      const objectBytes = () => {
        const dir = join(kbBareRepoPath(reposDir, target.id), "objects");
        return readdirSync(dir)
          .filter((fan) => /^[0-9a-f]{2}$/.test(fan))
          .reduce(
            (sum, fan) =>
              sum +
              readdirSync(join(dir, fan)).reduce(
                (bytes, name) => bytes + BigInt(statSync(join(dir, fan, name)).size),
                0n,
              ),
            0n,
          );
      };
      const beforeBytes = objectBytes();
      const result = await apply(actor.id, target.id, request, key);
      expect(result.changedPaths).toHaveLength(32);
      expect(await apply(actor.id, target.id, request, key)).toEqual(result);
      expect(
        await prisma.operationIntent.count({
          where: { kbId: target.id, operation: "CHANGES_APPLY", phase: "FINALIZED" },
        }),
      ).toBe(1);
      expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(
        mode === "mixed" ? 16 : 32,
      );
      const accounts = await prisma.$queryRaw<
        { dimension: string; committed: bigint; reserved: bigint }[]
      >`
        SELECT dimension::text, committed, reserved FROM "quota_account" WHERE "subjectId" IN (${target.id}, ${owner.id})`;
      expect(accounts.find((a) => a.dimension === "KB_LINEAGE_BYTES")).toMatchObject({
        committed: lineageBytes,
        reserved: 0n,
      });
      expect(accounts.find((a) => a.dimension === "OWNER_LINEAGE_BYTES")).toMatchObject({
        committed: lineageBytes,
        reserved: 0n,
      });
      expect(accounts.find((a) => a.dimension === "KB_HISTORY_BYTES")).toMatchObject({
        committed: objectBytes() - beforeBytes,
        reserved: 0n,
      });
      if (mode === "proposal") {
        expect(accounts.find((a) => a.dimension === "KB_BRANCH")).toMatchObject({
          committed: 1n,
          reserved: 0n,
        });
        expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(target.headSha);
      } else expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(result.commitSha);
      // Every removal also fits the response warning bound at 32.
      const removals: Change[] = changes
        .filter((c) => c.op === "assetPut")
        .map((c) => ({ op: "assetRemove", path: c.path }));
      const referenced = await apply(
        actor.id,
        target.id,
        edit(result.commitSha, [
          {
            op: "create",
            path: "references.md",
            content: { markdown: removals.map((c) => `![asset](${c.path})`).join("\n") },
          },
        ]),
      );
      const removed = await apply(
        actor.id,
        target.id,
        edit(referenced.commitSha, removals, result.proposal?.number),
      );
      expect(removed.changedPaths).toHaveLength(removals.length);
      expect(removed.warnings).toHaveLength(removals.length);
    },
  );

  it("empty list; invalid eighth operation preserves staging, successful eight-op replay commits once", async () => {
    const actor = await user();
    const target = await kb(actor.id);
    expect(await listAssets(runtime, actor.id, { kbId: target.id })).toEqual({
      items: [],
      nextCursor: null,
    });
    const assetId = await upload(actor.id, target.id);
    const markdown = `${"large document ".repeat(11000)}\n![audio](media/sound.wav)\n`;
    const textId = await upload(actor.id, target.id, Buffer.from(markdown), "markdown");
    const changes: Change[] = [
      { op: "assetPut", path: "media/sound.wav", uploadId: assetId },
      { op: "create", path: "large.md", content: { uploadId: textId } },
      ...Array.from({ length: 5 }, (_, i) => ({
        op: "create" as const,
        path: `docs/${i}.md`,
        content: { markdown: `# ${i}` },
      })),
      { op: "delete", path: "missing.md" },
    ];
    await expect(apply(actor.id, target.id, edit(target.headSha!, changes))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(target.headSha);
    expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(0);
    expect(
      await prisma.operationIntent.count({
        where: { kbId: target.id, operation: "CHANGES_APPLY" },
      }),
    ).toBe(0);
    for (const id of [assetId, textId])
      expect(await staged(id)).toMatchObject({
        state: "READY",
        reservedByOpId: null,
        consumedByOpId: null,
      });
    changes[7] = { op: "create", path: "last.md", content: { markdown: "# Last" } };
    const request = edit(target.headSha!, changes);
    const key = randomUUID();
    const result = await apply(actor.id, target.id, request, key);
    expect(await apply(actor.id, target.id, request, key)).toEqual(result);
    // Every main-moving apply schedules an index build for the new head; with no
    // embedding profile that is a lexical one. Replay returns the same job.
    expect(result).toMatchObject({ kind: "applied", indexJobId: expect.any(String) });
    expect(
      await prisma.indexGeneration.findMany({
        where: { kbId: target.id, jobId: result.indexJobId! },
        select: { commitSha: true },
      }),
    ).toEqual([{ commitSha: result.commitSha }]);
    expect(result.changedPaths).toHaveLength(8);
    expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(1);
    expect(
      await prisma.operationIntent.count({
        where: { kbId: target.id, operation: "CHANGES_APPLY" },
      }),
    ).toBe(1);
    for (const id of [assetId, textId])
      expect(await staged(id)).toMatchObject({
        state: "CONSUMED",
        consumedByOpId: result.operationId,
        reservedByOpId: null,
      });
    const doc = await readDocumentAtRevision({
      reposDir,
      kbId: target.id,
      commitSha: result.commitSha,
      path: "large.md",
      query: prismaAssetQuery(prisma),
    });
    expect(doc.markdown).toBe(markdown);
    expect(doc.assetRefs).toHaveLength(1);
    await expect(
      apply(
        actor.id,
        target.id,
        edit(result.commitSha, [{ op: "assetPut", path: "again.wav", uploadId: assetId }]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      mutateAsset(runtime, actor.id, "put", {
        kbId: target.id,
        baseRevision: result.commitSha,
        idempotencyKey: randomUUID(),
        path: "foreign-operation.wav",
        uploadId: assetId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const removed = await apply(
      actor.id,
      target.id,
      edit(result.commitSha, [{ op: "assetRemove", path: "media/sound.wav" }]),
    );
    expect((await listAssets(runtime, actor.id, { kbId: target.id })).items).toEqual([]);
    expect(
      (await listAssets(runtime, actor.id, { kbId: target.id, rev: result.commitSha })).items,
    ).toEqual(doc.assetRefs);
    expect(
      (
        await readDocumentAtRevision({
          reposDir,
          kbId: target.id,
          commitSha: removed.commitSha,
          path: "large.md",
        })
      ).assetRefs,
    ).toEqual([]);
    expect(
      (
        await readDocumentAtRevision({
          reposDir,
          kbId: target.id,
          commitSha: result.commitSha,
          path: "large.md",
          query: prismaAssetQuery(prisma),
        })
      ).assetRefs,
    ).toEqual(doc.assetRefs);
    expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(1);
    expect(readFileSync(casBlobPath(assetsDir, sha256Buffer(minimalWav())))).toEqual(minimalWav());
    // Even an empty tip cannot hide the preceding nonempty manifest from push validation.
    expect(
      (
        await validateNewlyReachableCommits(
          { repoPath: kbBareRepoPath(reposDir, target.id) },
          { oldSha: target.headSha!, newSha: removed.commitSha },
        )
      ).ok,
    ).toBe(false);
  });

  it("post-ref interruption keeps staging pinned past TTL and recovers identical consumption exactly once", async () => {
    const actor = await user();
    const target = await kb(actor.id);
    const uploadId = await upload(actor.id, target.id);
    const request = edit(target.headSha!, [{ op: "assetPut", path: "sound.wav", uploadId }]);
    const key = randomUUID();
    await crashAfterRef(actor.id, target.id, request, key);
    const intent = await prisma.operationIntent.findFirstOrThrow({
      where: { kbId: target.id, idempotencyKey: key },
    });
    expect(intent.phase).toBe("COMMITTING");
    expect(await staged(uploadId)).toMatchObject({ state: "READY", reservedByOpId: intent.opId });
    await prisma.stagedUpload.update({
      where: { id: uploadId },
      data: { readyExpiresAt: new Date(0) },
    });
    await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);
    expect(existsSync(stagedUploadPath(assetsDir, uploadId))).toBe(true);
    await prisma.quotaReservation.updateMany({
      where: { id: { in: (await staged(uploadId)).reservationIds } },
      data: { expiresAt: new Date(0) },
    });
    await runtime.coordinator.run({
      opId: randomUUID(),
      kind: "git-write",
      kbIds: [target.id],
      run: (ctx) => ctx.lease.transaction((query) => expireQuota({ transactionQuery: query })),
    });

    expect(await recover(target.id)).toBe("ok");
    expect(await recover(target.id)).toBe("ok");
    const result = await apply(actor.id, target.id, request, key);
    expect(result.commitSha).toBe(intent.newRef);
    expect(result.operationId).toBe(intent.opId);
    expect(await staged(uploadId)).toMatchObject({
      state: "CONSUMED",
      consumedByOpId: intent.opId,
      reservedByOpId: null,
    });
    expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(1);
    const quotas = await prisma.quotaAccount.findMany({
      where: { subjectId: target.id, dimension: "KB_LINEAGE_BYTES" },
    });
    expect(quotas.map((row) => [row.committed, row.reserved])).toEqual([
      [BigInt(minimalWav().length), 0n],
    ]);
    await sweepExpiredStagedUploads(db.urls.runtime, assetsDir);
    expect(existsSync(stagedUploadPath(assetsDir, uploadId))).toBe(false);
  });

  it("unpublished interruption unclaims staging; noop staged replacement consumes with its receipt", async () => {
    const actor = await user();
    const target = await kb(actor.id);
    const uploadId = await upload(actor.id, target.id);
    await expect(
      apply(
        actor.id,
        target.id,
        edit(target.headSha!, [{ op: "assetPut", path: "a.wav", uploadId }]),
        randomUUID(),
        {
          afterPrepared: () => {
            throw new Error("stop");
          },
        },
      ),
    ).rejects.toThrow("stop");
    await recover(target.id);
    expect(await staged(uploadId)).toMatchObject({ state: "READY", reservedByOpId: null });
    const result = await apply(
      actor.id,
      target.id,
      edit(target.headSha!, [{ op: "assetPut", path: "a.wav", uploadId }]),
    );
    const original = await readDocumentAtRevision({
      reposDir,
      kbId: target.id,
      commitSha: result.commitSha,
      path: "index.md",
    });
    const textId = await upload(actor.id, target.id, Buffer.from(original.markdown), "markdown");
    const request = edit(result.commitSha, [
      { op: "replace", path: "index.md", content: { uploadId: textId } },
    ]);
    const key = randomUUID();
    const noop = await apply(actor.id, target.id, request, key);
    expect(noop).toMatchObject({ kind: "noop", commitSha: result.commitSha });
    expect(await apply(actor.id, target.id, request, key)).toEqual(noop);
    expect(await staged(textId)).toMatchObject({
      state: "CONSUMED",
      consumedByOpId: noop.operationId,
    });
  });

  it("stolen/type-mismatched/expired handles and path collisions reject before consumption", async () => {
    const actor = await user();
    const other = await user();
    const target = await kb(actor.id);
    const foreign = await kb(actor.id);
    const assetId = await upload(actor.id, target.id);
    const textId = await upload(actor.id, target.id, Buffer.from("text"), "markdown");
    const stolen = await upload(actor.id, foreign.id);
    await prisma.kbShare.create({ data: { kbId: target.id, userId: other.id, bits: ["propose"] } });
    const foreignActorUpload = await upload(other.id, target.id);
    for (const change of [
      { op: "assetPut", path: "x.wav", uploadId: textId },
      { op: "create", path: "x.md", content: { uploadId: assetId } },
      { op: "assetPut", path: "x.wav", uploadId: stolen },
      { op: "assetPut", path: "x.wav", uploadId: foreignActorUpload },
    ] as Change[]) {
      await expect(
        apply(actor.id, target.id, edit(target.headSha!, [change])),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      apply(
        actor.id,
        target.id,
        edit("f".repeat(40), [{ op: "assetPut", path: "x.wav", uploadId: assetId }]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (const path of ["INDEX.md", ".assets/extra.wav", "index.md/child.wav"])
      await expect(
        apply(
          actor.id,
          target.id,
          edit(target.headSha!, [{ op: "assetPut", path, uploadId: assetId }]),
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      apply(
        actor.id,
        target.id,
        edit(target.headSha!, [
          { op: "assetPut", path: "a.wav", uploadId: assetId },
          { op: "assetPut", path: "A.wav", uploadId: assetId },
        ]),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await staged(assetId)).toMatchObject({ state: "READY", reservedByOpId: null });
    await prisma.stagedUpload.update({
      where: { id: assetId },
      data: { readyExpiresAt: new Date(0) },
    });
    await expect(
      apply(
        actor.id,
        target.id,
        edit(target.headSha!, [{ op: "assetPut", path: "x.wav", uploadId: assetId }]),
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
  });

  it("propose-only uploads stay on the actor's PR and retries reauthorize", async () => {
    const owner = await user();
    const actor = await user();
    const target = await kb(owner.id);
    await prisma.kbShare.create({ data: { kbId: target.id, userId: actor.id, bits: ["propose"] } });
    const uploadId = await upload(actor.id, target.id);
    const key = randomUUID();
    const request = edit(target.headSha!, [{ op: "assetPut", path: "a.wav", uploadId }]);
    const result = await apply(actor.id, target.id, request, key);
    expect(result).toMatchObject({ kind: "proposed", indexJobId: null });
    expect(result.proposal).not.toBeNull();
    expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(target.headSha);
    expect((await listAssets(runtime, owner.id, { kbId: target.id })).items).toEqual([]);
    expect(
      (await listAssets(runtime, owner.id, { kbId: target.id, rev: result.commitSha })).items,
    ).toHaveLength(1);
    expect(await apply(actor.id, target.id, request, key)).toEqual(result);
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId: target.id, userId: actor.id } },
      data: { revokedAt: new Date() },
    });
    await expect(apply(actor.id, target.id, request, key)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("dedup aliases paginate at pinned history; revoked direct write cannot publish main", async () => {
    const owner = await user();
    const actor = await user();
    const target = await kb(owner.id);
    const share = { kbId_userId: { kbId: target.id, userId: actor.id } };
    await prisma.kbShare.create({ data: { kbId: target.id, userId: actor.id, bits: ["write"] } });
    const uploadId = await upload(actor.id, target.id);
    await expect(
      apply(
        actor.id,
        target.id,
        edit(target.headSha!, [{ op: "assetPut", path: "a.wav", uploadId }]),
        randomUUID(),
        {
          afterPrepared: async () => {
            await prisma.kbShare.update({ where: share, data: { bits: ["propose"] } });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(target.headSha);
    await recover(target.id);
    await prisma.kbShare.update({ where: share, data: { bits: ["write"] } });
    const result = await apply(
      actor.id,
      target.id,
      edit(target.headSha!, [
        { op: "assetPut", path: "a.wav", uploadId },
        { op: "assetPut", path: "z.wav", uploadId },
      ]),
    );
    const first = await listAssets(runtime, actor.id, { kbId: target.id, limit: 1 });
    expect(first.items.map((item) => item.path)).toEqual(["a.wav"]);
    expect(first.nextCursor).not.toBeNull();
    await apply(
      actor.id,
      target.id,
      edit(result.commitSha, [{ op: "assetRemove", path: "z.wav" }]),
    );
    const next = await listAssets(runtime, actor.id, {
      kbId: target.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(next.items.map((item) => item.path)).toEqual(["z.wav"]);
    expect(next.nextCursor).toBeNull();
    const quota = await prisma.quotaAccount.findFirstOrThrow({
      where: { subjectId: target.id, dimension: "KB_LINEAGE_BYTES" },
    });
    expect(quota.committed).toBe(BigInt(minimalWav().length));
    await prisma.kbShare.update({ where: share, data: { revokedAt: new Date() } });
    await expect(
      listAssets(runtime, actor.id, { kbId: target.id, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("imports require reachable source membership and live source authority, and copies survive later share loss", async () => {
    const origin = await user();
    const actor = await user();
    const source = await kb(origin.id);
    const target = await kb(actor.id);
    const uploadId = await upload(origin.id, source.id);
    const put = (await mutateAsset(runtime, origin.id, "put", {
      kbId: source.id,
      baseRevision: source.headSha!,
      idempotencyKey: randomUUID(),
      path: "a.wav",
      uploadId,
    })) as unknown as ApplyResult;
    const request: AssetImportRequest = {
      mode: "import",
      title: "Import",
      sourceSessionIds: [],
      kbId: target.id,
      baseRevision: target.headSha!,
      idempotencyKey: randomUUID(),
      path: "copied.wav",
      source: { kbId: source.id, rev: put.commitSha, hash: sha256Buffer(minimalWav()) },
    };
    await expect(apply(actor.id, target.id, request)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await prisma.kbShare.create({ data: { kbId: source.id, userId: actor.id, bits: ["read"] } });
    await expect(
      apply(actor.id, target.id, {
        ...request,
        source: { ...request.source, rev: source.headSha! },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const orphan = await createTreeReuseCommit(
      { reposDir, kbId: source.id },
      { parentSha: put.commitSha, message: "unreachable" },
    );
    await expect(
      apply(actor.id, target.id, {
        ...request,
        source: { ...request.source, rev: orphan },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const shareWhere = { kbId_userId: { kbId: source.id, userId: actor.id } };
    await expect(
      apply(actor.id, target.id, request, randomUUID(), {
        afterPrepared: async () => {
          await prisma.kbShare.update({ where: shareWhere, data: { revokedAt: new Date() } });
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await recover(target.id);
    expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(0);
    await prisma.kbShare.update({ where: shareWhere, data: { revokedAt: null } });
    const key = randomUUID();
    const wire = {
      kbId: target.id,
      baseRevision: request.baseRevision,
      idempotencyKey: key,
      path: request.path,
      source: request.source,
    };
    const copied = (await mutateAsset(runtime, actor.id, "import", wire)) as unknown as ApplyResult;
    await prisma.kbShare.update({ where: shareWhere, data: { revokedAt: new Date() } });
    expect(await mutateAsset(runtime, actor.id, "import", wire)).toEqual(copied);
    expect((await listAssets(runtime, actor.id, { kbId: target.id })).items).toMatchObject([
      { path: "copied.wav", hash: request.source.hash },
    ]);
    expect(
      await prisma.kbAssetLineage.findUniqueOrThrow({
        where: { kbId_hash: { kbId: target.id, hash: request.source.hash } },
      }),
    ).toMatchObject({ source: "IMPORT", sourceKbId: source.id, sourceRev: put.commitSha });
    const validation = await assetValidationContext(prismaAssetQuery(prisma), target.id, [
      request.source.hash,
    ]);
    expect(
      (
        await validateNewlyReachableCommits(
          { repoPath: kbBareRepoPath(reposDir, target.id), ...validation },
          { oldSha: target.headSha!, newSha: copied.commitSha },
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await validateNewlyReachableCommits(
          { repoPath: kbBareRepoPath(reposDir, target.id) },
          { oldSha: target.headSha!, newSha: copied.commitSha },
        )
      ).ok,
    ).toBe(false);
  });
});

/** A distinct, still valid WAV: only one silent sample differs. */
function wav(variant: number) {
  const bytes = Buffer.from(minimalWav());
  bytes[bytes.length - 1] = 0x80 + variant;
  return bytes;
}
async function prStatus(userId: string, kbId: string, number = 1) {
  return (
    await getPullRequest(
      {
        store: prismaAuthorityStore(prisma),
        principal: { kind: "browser", userId },
        query: prismaAssetQuery(prisma),
        reposDir,
        cursorSigner: runtime.cursorSigner,
      },
      { kbId, number },
    )
  ).pr;
}
async function proposer(kbId: string) {
  const author = await user();
  await prisma.kbShare.create({ data: { kbId, userId: author.id, bits: ["read", "propose"] } });
  return author;
}

describe("asset proposals moved onto main", () => {
  it("independent additions merge; rewriting the PR's own asset against main clashes unless the PR is named", async () => {
    const owner = await user();
    const target = await kb(owner.id);
    const author = await proposer(target.id);
    const proposed = await apply(
      author.id,
      target.id,
      edit(target.headSha!, [
        {
          op: "assetPut",
          path: "media/b.wav",
          uploadId: await upload(author.id, target.id, wav(1)),
        },
      ]),
    );
    expect(proposed.proposal?.number).toBe(1);
    const main = await apply(
      owner.id,
      target.id,
      edit(target.headSha!, [
        {
          op: "assetPut",
          path: "media/a.wav",
          uploadId: await upload(owner.id, target.id, wav(2)),
        },
      ]),
    );
    expect((await prStatus(owner.id, target.id)).status).toBe("OPEN");
    for (const change of [
      async (): Promise<Change> => ({
        op: "assetPut",
        path: "media/b.wav",
        uploadId: await upload(author.id, target.id, wav(3)),
      }),
      async (): Promise<Change> => ({ op: "assetRemove", path: "media/b.wav" }),
    ]) {
      await expect(
        apply(author.id, target.id, edit(main.commitSha, [await change()])),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          reason: "PROPOSAL_CONFLICT",
          paths: [{ path: "media/b.wav", base: null, theirs: null }],
        },
      });
    }
    const moved = await apply(
      author.id,
      target.id,
      edit(
        main.commitSha,
        [
          {
            op: "assetPut",
            path: "media/b.wav",
            uploadId: await upload(author.id, target.id, wav(4)),
          },
        ],
        1,
      ),
    );
    expect(moved.proposal).toMatchObject({ number: 1, baseSha: main.commitSha, status: "OPEN" });
    const assets = await listAssets(runtime, owner.id, { kbId: target.id, rev: moved.commitSha });
    expect(assets.items.map((item) => item.path)).toEqual(["media/a.wav", "media/b.wav"]);
  });

  it("the same asset added on both sides is a conflict on that asset, resolved with assetPut", async () => {
    const owner = await user();
    const target = await kb(owner.id);
    const author = await proposer(target.id);
    await apply(
      author.id,
      target.id,
      edit(target.headSha!, [
        {
          op: "assetPut",
          path: "media/x.wav",
          uploadId: await upload(author.id, target.id, wav(5)),
        },
      ]),
    );
    const main = await apply(
      owner.id,
      target.id,
      edit(target.headSha!, [
        {
          op: "assetPut",
          path: "media/x.wav",
          uploadId: await upload(owner.id, target.id, wav(6)),
        },
      ]),
    );
    expect((await prStatus(owner.id, target.id)).status).toBe("CONFLICT");
    await expect(
      apply(
        author.id,
        target.id,
        edit(main.commitSha, [{ op: "assetRemove", path: "media/y.wav" }]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "PROPOSAL_CONFLICT" } });
    const resolution: Change = {
      op: "assetPut",
      path: "media/x.wav",
      uploadId: await upload(author.id, target.id, wav(7)),
    };
    // A fresh conflict has the same consent rule as any PR-changed path.
    for (const change of [resolution, { op: "assetRemove" as const, path: "media/x.wav" }]) {
      await expect(
        apply(author.id, target.id, edit(main.commitSha, [change])),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "PROPOSAL_CONFLICT", paths: [{ kind: "asset", path: "media/x.wav" }] },
      });
    }
    const resolved = await apply(author.id, target.id, edit(main.commitSha, [resolution], 1));
    expect(resolved.proposal).toMatchObject({ number: 1, status: "OPEN" });
  });
});

describe("asset resolutions are valid on a conflicted asset", () => {
  it("delete-vs-replace both ways and add/add, resolved by assetRemove or assetPut", async () => {
    type Side = "replace" | "remove" | "add";
    const scenarios: Array<{ pr: Side; main: Side }> = [
      { pr: "replace", main: "remove" },
      { pr: "remove", main: "replace" },
      { pr: "add", main: "add" },
    ];
    let variant = 10;
    const nextVariant = () => {
      variant += 1;
      return variant;
    };
    for (const scenario of scenarios)
      for (const resolution of ["assetRemove", "assetPut"] as const) {
        const owner = await user();
        const target = await kb(owner.id);
        const author = await proposer(target.id);
        let base = target.headSha!;
        if (scenario.pr !== "add")
          base = (
            await apply(
              owner.id,
              target.id,
              edit(base, [
                {
                  op: "assetPut",
                  path: "media/c.wav",
                  uploadId: await upload(owner.id, target.id, wav(nextVariant())),
                },
              ]),
            )
          ).commitSha;
        const side = async (who: string, kind: Side): Promise<Change> =>
          kind === "remove"
            ? { op: "assetRemove", path: "media/c.wav" }
            : {
                op: "assetPut",
                path: "media/c.wav",
                uploadId: await upload(who, target.id, wav(nextVariant())),
              };
        await apply(author.id, target.id, edit(base, [await side(author.id, scenario.pr)]));
        const main = await apply(
          owner.id,
          target.id,
          edit(base, [await side(owner.id, scenario.main)]),
        );
        const label = `${scenario.pr} vs ${scenario.main} / ${resolution}`;
        expect((await prStatus(owner.id, target.id)).status, label).toBe("CONFLICT");
        const change: Change =
          resolution === "assetRemove"
            ? { op: "assetRemove", path: "media/c.wav" }
            : {
                op: "assetPut",
                path: "media/c.wav",
                uploadId: await upload(author.id, target.id, wav(nextVariant())),
              };
        const resolved = await apply(author.id, target.id, edit(main.commitSha, [change], 1));
        expect(resolved.proposal, label).toMatchObject({ number: 1, status: "OPEN" });
        const assets = await listAssets(runtime, owner.id, {
          kbId: target.id,
          rev: resolved.commitSha,
        });
        expect(
          assets.items.map((item) => item.path),
          label,
        ).toEqual(resolution === "assetRemove" ? [] : ["media/c.wav"]);
      }
  });
});

describe(".md-named assets conflict as assets", () => {
  it("a case collision and a same-path clash are asset conflicts resolved by asset ops", async () => {
    for (const [prPath, mainPath] of [
      ["media/a.md", "media/A.md"],
      ["media/x.md", "media/x.md"],
    ] as const) {
      const owner = await user();
      const target = await kb(owner.id);
      const author = await proposer(target.id);
      await apply(
        author.id,
        target.id,
        edit(target.headSha!, [
          { op: "assetPut", path: prPath, uploadId: await upload(author.id, target.id, wav(40)) },
        ]),
      );
      const main = await apply(
        owner.id,
        target.id,
        edit(target.headSha!, [
          { op: "assetPut", path: mainPath, uploadId: await upload(owner.id, target.id, wav(41)) },
        ]),
      );
      expect((await prStatus(owner.id, target.id)).status).toBe("CONFLICT");
      await expect(
        apply(author.id, target.id, edit(main.commitSha, [{ op: "delete", path: prPath }], 1)),
      ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "PROPOSAL_CONFLICT" } });
      await expect(
        apply(
          author.id,
          target.id,
          edit(main.commitSha, [
            { op: "create", path: "unrelated.md", content: { markdown: "u" } },
          ]),
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: {
          // A case variant: main's own entry is reported too (it stands in the way).
          paths: [
            ...(mainPath === prPath
              ? []
              : [expect.objectContaining({ path: mainPath, kind: "asset" })]),
            expect.objectContaining({ path: prPath, yours: expect.stringContaining(prPath) }),
          ],
        },
      });
      const resolved = await apply(
        author.id,
        target.id,
        edit(main.commitSha, [{ op: "assetRemove", path: prPath }], 1),
      );
      expect(resolved.proposal).toMatchObject({ status: "OPEN" });
    }
  });
});

/** An asset the user can import: put into a KB of their own, at its commit. */
async function importable(userId: string, bytes: Buffer) {
  const source = await kb(userId);
  const put = (await mutateAsset(runtime, userId, "put", {
    kbId: source.id,
    baseRevision: source.headSha!,
    idempotencyKey: randomUUID(),
    path: "source.wav",
    uploadId: await upload(userId, source.id, bytes),
  })) as unknown as ApplyResult;
  return { kbId: source.id, rev: put.commitSha, hash: sha256Buffer(bytes) };
}
const importAt = (
  kbId: string,
  baseRevision: string,
  path: string,
  source: AssetImportRequest["source"],
): AssetImportRequest => ({
  mode: "import",
  title: `Import asset ${path}`,
  sourceSessionIds: [],
  kbId,
  baseRevision,
  idempotencyKey: randomUUID(),
  path,
  source,
});

describe("asset imports follow the PR update flow", () => {
  it("an import against main moves the PR onto main; importing over the PR's own asset clashes", async () => {
    const owner = await user();
    const target = await kb(owner.id);
    const author = await proposer(target.id);
    await apply(
      author.id,
      target.id,
      edit(target.headSha!, [
        {
          op: "assetPut",
          path: "media/b.wav",
          uploadId: await upload(author.id, target.id, wav(8)),
        },
      ]),
    );
    const main = await apply(
      owner.id,
      target.id,
      edit(target.headSha!, [{ op: "create", path: "main.md", content: { markdown: "# Main\n" } }]),
    );
    const source = await importable(author.id, wav(9));
    // The import writes media/b.wav, which the PR changed: against main's
    // version it would drop the PR's asset unseen.
    await expect(
      apply(author.id, target.id, importAt(target.id, main.commitSha, "media/b.wav", source)),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "PROPOSAL_CONFLICT", paths: [{ path: "media/b.wav", kind: "asset" }] },
    });
    const moved = await apply(
      author.id,
      target.id,
      importAt(target.id, main.commitSha, "media/c.wav", source),
    );
    expect(moved.kind).toBe("proposed");
    expect(moved.proposal).toMatchObject({ number: 1, baseSha: main.commitSha, status: "OPEN" });
    const assets = await listAssets(runtime, owner.id, { kbId: target.id, rev: moved.commitSha });
    expect(assets.items.map((item) => item.path)).toEqual(["media/b.wav", "media/c.wav"]);
  });

  it("an imported asset resolves a conflict on that asset", async () => {
    const owner = await user();
    const target = await kb(owner.id);
    const author = await proposer(target.id);
    await apply(
      author.id,
      target.id,
      edit(target.headSha!, [
        {
          op: "assetPut",
          path: "media/x.wav",
          uploadId: await upload(author.id, target.id, wav(10)),
        },
      ]),
    );
    const main = await apply(
      owner.id,
      target.id,
      edit(target.headSha!, [
        {
          op: "assetPut",
          path: "media/x.wav",
          uploadId: await upload(owner.id, target.id, wav(11)),
        },
      ]),
    );
    expect((await prStatus(owner.id, target.id)).status).toBe("CONFLICT");
    const source = await importable(author.id, wav(12));
    const resolved = await apply(author.id, target.id, {
      ...importAt(target.id, main.commitSha, "media/x.wav", source),
      proposalNumber: 1,
    });
    expect(resolved.proposal).toMatchObject({ number: 1, baseSha: main.commitSha, status: "OPEN" });
    const assets = await listAssets(runtime, owner.id, {
      kbId: target.id,
      rev: resolved.commitSha,
    });
    expect(assets.items).toMatchObject([{ path: "media/x.wav", hash: source.hash }]);
  });
});

describe("a deleted document's restoration and the asset in its way", () => {
  // Base A.md; main edits it; the PR deletes it and adds asset a.md.
  const setupClash = async () => {
    const owner = await user();
    const target = await kb(owner.id);
    const author = await proposer(target.id);
    const doc = await apply(
      owner.id,
      target.id,
      edit(target.headSha!, [{ op: "create", path: "A.md", content: { markdown: "# base\n" } }]),
    );
    await apply(
      author.id,
      target.id,
      edit(doc.commitSha, [
        { op: "delete", path: "A.md" },
        { op: "assetPut", path: "a.md", uploadId: await upload(author.id, target.id, wav(13)) },
      ]),
    );
    const main = await apply(
      owner.id,
      target.id,
      edit(doc.commitSha, [{ op: "replace", path: "A.md", content: { markdown: "# main\n" } }]),
    );
    return { owner, target, author, main };
  };
  const restore: Change = { op: "create", path: "A.md", content: { markdown: "# main\n" } };

  it("both are reported; removing the asset is progress, then the document is restored", async () => {
    const { owner, target, author, main } = await setupClash();
    await expect(
      apply(
        author.id,
        target.id,
        edit(main.commitSha, [{ op: "create", path: "z.md", content: { markdown: "# z\n" } }]),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "PROPOSAL_CONFLICT",
        paths: [
          { path: "A.md", kind: "document" },
          { path: "a.md", kind: "asset" },
        ],
      },
    });
    const removed = await apply(
      author.id,
      target.id,
      edit(main.commitSha, [{ op: "assetRemove", path: "a.md" }], 1),
    );
    expect(removed.proposal).toMatchObject({ number: 1, status: "CONFLICT" });
    const restored = await apply(author.id, target.id, edit(removed.commitSha, [restore], 1));
    expect(restored.proposal).toMatchObject({ number: 1, status: "OPEN" });
    expect((await prStatus(owner.id, target.id)).status).toBe("OPEN");
  });

  it("a recorded asset conflict still needs both selectors, even at the PR head", async () => {
    const { target, author, main } = await setupClash();
    const step = await apply(
      author.id,
      target.id,
      edit(main.commitSha, [{ op: "delete", path: "A.md" }], 1),
    );
    expect(step.proposal?.status).toBe("CONFLICT");
    for (const base of [main.commitSha, step.commitSha]) {
      for (const change of [
        { op: "assetRemove" as const, path: "a.md" },
        {
          op: "assetPut" as const,
          path: "a.md",
          uploadId: await upload(author.id, target.id, wav(14)),
        },
      ]) {
        await expect(apply(author.id, target.id, edit(base, [change]))).rejects.toMatchObject({
          code: "CONFLICT",
          details: { reason: "PROPOSAL_CONFLICT", paths: [{ path: "a.md", kind: "asset" }] },
        });
      }
    }
    const resolved = await apply(
      author.id,
      target.id,
      edit(main.commitSha, [{ op: "assetRemove", path: "a.md" }], 1),
    );
    expect(resolved.proposal?.status).toBe("OPEN");
  });

  it("removing the asset and restoring the document in one request resolves both", async () => {
    const { target, author, main } = await setupClash();
    const resolved = await apply(
      author.id,
      target.id,
      edit(main.commitSha, [{ op: "assetRemove", path: "a.md" }, restore], 1),
    );
    expect(resolved.proposal).toMatchObject({ number: 1, status: "OPEN" });
    expect(
      (await listAssets(runtime, author.id, { kbId: target.id, rev: resolved.commitSha })).items,
    ).toEqual([]);
  });
});

describe("a document and an asset at one path are two writes", () => {
  for (const order of ["delete first", "assetPut first"] as const)
    it(`resolves both conflicts in one request, ${order}`, async () => {
      // Main edits document a.md; the PR deletes it and adds asset a.md.
      const owner = await user();
      const target = await kb(owner.id);
      const author = await proposer(target.id);
      const doc = await apply(
        owner.id,
        target.id,
        edit(target.headSha!, [{ op: "create", path: "a.md", content: { markdown: "# base\n" } }]),
      );
      await apply(
        author.id,
        target.id,
        edit(doc.commitSha, [
          { op: "delete", path: "a.md" },
          { op: "assetPut", path: "a.md", uploadId: await upload(author.id, target.id, wav(20)) },
        ]),
      );
      const main = await apply(
        owner.id,
        target.id,
        edit(doc.commitSha, [{ op: "replace", path: "a.md", content: { markdown: "# main\n" } }]),
      );
      const changes: Change[] = [
        { op: "delete", path: "a.md" },
        { op: "assetPut", path: "a.md", uploadId: await upload(author.id, target.id, wav(21)) },
      ];
      const resolved = await apply(
        author.id,
        target.id,
        edit(main.commitSha, order === "delete first" ? changes : changes.reverse(), 1),
      );
      expect(resolved.proposal).toMatchObject({ number: 1, status: "OPEN" });
      expect(
        (await listAssets(runtime, author.id, { kbId: target.id, rev: resolved.commitSha })).items,
      ).toMatchObject([{ path: "a.md" }]);
    });
});

// P3 runs actual SDK HTTP, Postgres intents, cache accounting, Git refs and
// staged-upload settlement together. Production still constructs disk only.
describe("S3 publication before ref/catalog", () => {
  async function remote() {
    const http = await createAssetS3Fixture();
    const lifecycle = createAssetStorageLifecycle("SERVER");
    const remoteRoot = mkdtempSync(join(root, "s3-publication-"));
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= lifecycle.stop().finally(() => http.close()));
    onTestFinished(close);
    const config = {
      bucket: "kb-assets",
      endpoint: http.endpoint,
      region: "auto",
      prefix: "instance",
      forcePathStyle: true,
      credentials: { accessKeyId: "fixture-writer", secretAccessKey: "fixture-disposable-key" },
    };
    const locator = assetS3Locator(config);
    const storageGeneration = randomUUID();
    const transactions = createAssetCacheTransactions(db.urls.runtime);
    const publication = createAssetPublicationState({
      binding: { storageGeneration, locator },
      transactions,
    });
    await prisma.appSetting.upsert({
      where: { key: "kb.asset-storage" },
      create: {
        key: "kb.asset-storage",
        value: JSON.stringify({
          version: 1,
          mode: "s3",
          activeGeneration: storageGeneration,
          locator,
        }),
      },
      update: {
        value: JSON.stringify({
          version: 1,
          mode: "s3",
          activeGeneration: storageGeneration,
          locator,
        }),
      },
    });
    const binding = await assetCacheBinding({
      assetsDir: remoteRoot,
      storageGeneration,
      configuration: locator,
      limit: 26214400n,
    });
    const cache = createAssetCache({
      assetsDir: remoteRoot,
      binding,
      lifecycle,
      transactions,
      meter: runtime.diskMeter,
    });
    await cache.initializeEmpty(() => {});
    await cache.registerOwner(() => {}, Date.now() + 15000);
    const store = createS3BlobStore({
      assetsDir: remoteRoot,
      config,
      publication,
      cache,
      lifecycle,
    });
    return {
      http,
      store,
      cache,
      publication,
      binding,
      childSetup: `
        const {createAssetCache} = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../../api/src/lib/kb/asset-cache.ts")).href)});
        const {createAssetPublicationState} = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../../api/src/lib/kb/asset-publication-state.ts")).href)});
        const {createAssetStorageLifecycle} = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../../api/src/lib/kb/asset-storage-lifecycle.ts")).href)});
        const {createAssetCacheTransactions} = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../../api/src/lib/kb/asset-storage-state.ts")).href)});
        const {createS3BlobStore} = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../../api/src/lib/kb/blob-store-s3.ts")).href)});
        const binding = {...${JSON.stringify({ ...binding, limit: undefined })}, limit:26214400n};
        const lifecycle = createAssetStorageLifecycle("WORKER");
        const transactions = createAssetCacheTransactions(process.env.KB_TEST_RUNTIME_URL);
        const cache = createAssetCache({assetsDir:${JSON.stringify(remoteRoot)},binding,lifecycle,transactions,meter:{freeBytes:async()=>1n<<40n}});
        await cache.registerOwner(()=>{},Date.now()+15000);
        const publicationState = createAssetPublicationState({binding:${JSON.stringify(publication.binding)},transactions});
        const blobStore = createS3BlobStore({assetsDir:${JSON.stringify(remoteRoot)},config:${JSON.stringify(config)},publication:publicationState,cache,lifecycle});
      `,
      key: (bytes: Buffer) => `/kb-assets/${assetS3Key(config.prefix, sha256Buffer(bytes))}`,
      // Suite teardown removes directories after all fixtures finish; keeping
      // their inodes alive prevents reuse against persisted cache identities.
      close,
    };
  }
  it("failed PUT releases READY claims immediately; fresh-key retry grants lineage once", async () => {
    const f = await remote();
    try {
      const actor = await user(),
        target = await kb(actor.id),
        bytes = wav(19);
      const uploadId = await upload(actor.id, target.id, bytes);
      const request = edit(target.headSha!, [{ op: "assetPut", path: "remote.wav", uploadId }]);
      const failedKey = randomUUID();
      f.http.setPutStatus(403);
      await expect(
        apply(actor.id, target.id, request, failedKey, undefined, f.store),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(target.headSha);
      expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(0);
      expect(await staged(uploadId)).toMatchObject({
        state: "READY",
        reservedByOpId: null,
        consumedByOpId: null,
      });
      const pending = await prisma.assetRetainedObject.findUniqueOrThrow({
        where: {
          storageGeneration_locator_hash: { ...f.publication.binding, hash: sha256Buffer(bytes) },
        },
      });
      expect(pending.state).toBe("PENDING");
      f.http.setPutStatus(200);
      await expect(
        apply(actor.id, target.id, request, failedKey, undefined, f.store),
      ).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
      await apply(actor.id, target.id, request, randomUUID(), undefined, f.store);
      expect(await staged(uploadId)).toMatchObject({ state: "CONSUMED", reservedByOpId: null });
      expect(
        await prisma.kbAssetLineage.count({
          where: { kbId: target.id, hash: sha256Buffer(bytes) },
        }),
      ).toBe(1);
      expect(f.http.objects.get(f.key(bytes))?.bytes).toEqual(bytes);
    } finally {
      await f.close();
    }
  });
  it("publishes a first asset without ListBucket when missing-key HEAD returns 403", async () => {
    const f = await remote();
    try {
      const bytes = wav(33);
      f.http.setMissingHeadStatus(403);
      await expect(
        f.store.publishVerified({
          declaredHash: sha256Buffer(bytes),
          declaredSize: bytes.length,
          declaredMime: "audio/wav",
          bytes,
        }),
      ).resolves.toMatchObject({ durability: { backend: "s3" } });
      expect(f.http.requests.map((r) => r.method)).toEqual(["HEAD", "PUT", "HEAD"]);
      expect(f.http.requests[1]!.headers["if-none-match"]).toBe("*");
      expect(f.http.objects.get(f.key(bytes))?.bytes).toEqual(bytes);
    } finally {
      await f.close();
    }
  });
  it("does not overwrite or confirm an unreadable existing key after HEAD 403", async () => {
    const f = await remote();
    try {
      const bytes = wav(34);
      const existing = Buffer.alloc(bytes.length, 0);
      f.http.objects.set(f.key(bytes), { bytes: existing, metadata: {} });
      f.http.setGetStatus(403);
      await expect(
        f.store.publishVerified({
          declaredHash: sha256Buffer(bytes),
          declaredSize: bytes.length,
          declaredMime: "audio/wav",
          bytes,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(f.http.requests.map((r) => r.method)).toEqual(["HEAD", "PUT", "HEAD"]);
      expect(f.http.objects.get(f.key(bytes))?.bytes).toEqual(existing);
      const intent = await prisma.assetRetainedObject.findUniqueOrThrow({
        where: {
          storageGeneration_locator_hash: { ...f.publication.binding, hash: sha256Buffer(bytes) },
        },
      });
      expect(intent.state).toBe("PENDING");
    } finally {
      await f.close();
    }
  });
  it("lost PUT response is probed; metadata-free dedup GETs; corruption never overwrites", async () => {
    const f = await remote();
    const bytes = wav(20),
      hash = sha256Buffer(bytes);
    const publish = () =>
      f.store.publishVerified({
        declaredHash: hash,
        declaredSize: bytes.length,
        declaredMime: "audio/wav",
        bytes,
      });
    try {
      f.http.loseNextPutResponse();
      await expect(publish()).resolves.toMatchObject({ durability: { backend: "s3" } });
      expect(f.http.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
      expect(f.http.requests.find((r) => r.method === "PUT")?.headers["if-none-match"]).toBe("*");
      expect(f.http.requests.find((r) => r.method === "PUT")?.headers["x-amz-acl"]).toBeUndefined();
      expect(
        f.http.requests.find((r) => r.method === "PUT")?.headers["x-amz-checksum-crc32"],
      ).toBeUndefined();
      f.http.objects.get(f.key(bytes))!.metadata = {};
      await publish();
      expect(f.http.requests.some((r) => r.method === "GET")).toBe(true);
      f.http.corruptGets(true);
      await expect(publish()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(f.http.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
      expect(f.http.requests.every((r) => ["PUT", "HEAD", "GET"].includes(r.method))).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("cancelled PUT and admission failure preserve staging and a discoverable orphan", async () => {
    const f = await remote();
    try {
      const bytes = wav(21),
        hash = sha256Buffer(bytes);
      const abort = new AbortController();
      f.http.hangPuts(true);
      const timer = setTimeout(() => abort.abort(), 100);
      try {
        await expect(
          f.store.publishVerified({
            declaredHash: hash,
            declaredSize: bytes.length,
            declaredMime: "audio/wav",
            bytes,
            signal: abort.signal,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      } finally {
        clearTimeout(timer);
      }
      f.http.hangPuts(false);
      const actor = await user(),
        target = await kb(actor.id);
      const uploadId = await upload(actor.id, target.id, bytes);
      const open = f.cache.open;
      f.cache.open = async () => {
        throw new Error("admission unavailable");
      };
      await expect(
        apply(
          actor.id,
          target.id,
          edit(target.headSha!, [{ op: "assetPut", path: "orphan.wav", uploadId }]),
          randomUUID(),
          undefined,
          f.store,
        ),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(await staged(uploadId)).toMatchObject({ state: "READY", reservedByOpId: null });
      expect(readHeadSha(kbBareRepoPath(reposDir, target.id))).toBe(target.headSha);
      expect(f.http.objects.has(f.key(bytes))).toBe(true);
      expect(
        (
          await prisma.assetRetainedObject.findUniqueOrThrow({
            where: { storageGeneration_locator_hash: { ...f.publication.binding, hash } },
          })
        ).state,
      ).toBe("DURABLE");
      f.cache.open = open;
      await apply(
        actor.id,
        target.id,
        edit(target.headSha!, [{ op: "assetPut", path: "orphan.wav", uploadId }]),
        randomUUID(),
        undefined,
        f.store,
      );
    } finally {
      await f.close();
    }
  });
  it("checks imported grants remotely without copying or admitting source bytes", async () => {
    const f = await remote();
    try {
      const actor = await user(),
        source = await importable(actor.id, wav(22)),
        target = await kb(actor.id);
      const request = importAt(target.id, target.headSha!, "import.wav", source);
      await expect(
        apply(actor.id, target.id, request, randomUUID(), undefined, f.store),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(0);
      const bytes = wav(22);
      f.http.objects.set(f.key(bytes), {
        bytes,
        metadata: { sha256: sha256Buffer(bytes).slice(7), size: String(bytes.length) },
      });
      await apply(actor.id, target.id, request, randomUUID(), undefined, f.store);
      expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(1);
      expect(await prisma.assetCacheEntry.count({ where: { cacheId: f.binding.cacheId } })).toBe(0);
      expect(f.http.requests.every((r) => r.method === "HEAD")).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("deduplicates concurrent publishers across KBs and recovers a ref published before DB finalization", async () => {
    const f = await remote();
    try {
      const actor = await user(),
        a = await kb(actor.id),
        b = await kb(actor.id),
        bytes = wav(23);
      const uploadA = await upload(actor.id, a.id, bytes),
        uploadB = await upload(actor.id, b.id, bytes);
      const keyA = randomUUID();
      const requestA = edit(a.headSha!, [{ op: "assetPut", path: "a.wav", uploadId: uploadA }]);
      const results = await Promise.allSettled([
        apply(
          actor.id,
          a.id,
          requestA,
          keyA,
          {
            afterRefUpdate: async () => {
              throw new Error("DB finalization failed");
            },
          },
          f.store,
        ),
        apply(
          actor.id,
          b.id,
          edit(b.headSha!, [{ op: "assetPut", path: "b.wav", uploadId: uploadB }]),
          randomUUID(),
          undefined,
          f.store,
        ),
      ]);
      expect(results[0]?.status).toBe("rejected");
      expect(results[1]?.status).toBe("fulfilled");
      await recover(a.id);
      expect(await staged(uploadA)).toMatchObject({ state: "CONSUMED" });
      await apply(actor.id, a.id, requestA, keyA, undefined, f.store);
      expect(
        await prisma.kbAssetLineage.count({
          where: { kbId: { in: [a.id, b.id] }, hash: sha256Buffer(bytes) },
        }),
      ).toBe(2);
      expect(f.http.objects.size).toBe(1);
      expect(
        await prisma.assetRetainedObject.count({
          where: { ...f.publication.binding, hash: sha256Buffer(bytes), state: "DURABLE" },
        }),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("recovers exactly once after SIGKILL between the S3-backed ref update and catalog finalization", async () => {
    const f = await remote();
    try {
      const actor = await user(),
        target = await kb(actor.id),
        bytes = wav(24),
        key = randomUUID();
      const uploadId = await upload(actor.id, target.id, bytes);
      const request = edit(target.headSha!, [{ op: "assetPut", path: "killed.wav", uploadId }]);
      await crashAfterRef(actor.id, target.id, request, key, f.childSetup);
      expect(f.http.objects.get(f.key(bytes))?.bytes).toEqual(bytes);
      expect(
        await prisma.assetCachePin.count({ where: { entry: { cacheId: f.binding.cacheId } } }),
      ).toBe(0);
      expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(0);
      await recover(target.id);
      await apply(actor.id, target.id, request, key, undefined, f.store);
      expect(await staged(uploadId)).toMatchObject({ state: "CONSUMED" });
      expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("publishes a batch larger than cache capacity and releases each pin before the next blob", async () => {
    const f = await remote();
    try {
      const actor = await user(),
        target = await kb(actor.id);
      // Valid PCM WAVs whose combined payload exceeds the minimum 25 MiB cache.
      const large = (value: number) => {
        const b = Buffer.alloc(14 * 1024 * 1024, value);
        minimalWav().copy(b);
        b.writeUInt32LE(b.length - 8, 4);
        b.writeUInt32LE(b.length - 44, 40);
        return b;
      };
      const changes: Change[] = [];
      for (const value of [31, 32])
        changes.push({
          op: "assetPut",
          path: `large-${value}.wav`,
          uploadId: await upload(
            actor.id,
            target.id,
            large(value),
            "asset",
            createMemoryRatePort(),
          ),
        });
      await apply(
        actor.id,
        target.id,
        edit(target.headSha!, changes),
        randomUUID(),
        undefined,
        f.store,
      );
      expect(await prisma.kbAssetLineage.count({ where: { kbId: target.id } })).toBe(2);
      expect(
        await prisma.assetCachePin.count({ where: { entry: { cacheId: f.binding.cacheId } } }),
      ).toBe(0);
      const state = await prisma.assetCacheState.findUniqueOrThrow({
        where: { id: f.binding.cacheId },
      });
      expect(state.chargedBytes).toBeLessThanOrEqual(26214400n);
      expect(f.http.objects.size).toBe(2);
    } finally {
      await f.close();
    }
  }, 60000);
});
