import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { invalidArgument } from "./argument-reasons";
import {
  assetValidationContext,
  authorizedAssetsAtRevision,
  manifestAtCommitAsync,
  prismaAssetQuery,
} from "./asset-authz";
import type { BlobStore } from "./blob-store";
import { publishCasBytes } from "./cas";
import { boundedTitle, type Change, createChangesPublication } from "./changes";
import { cursorExpiry, stableFilterHash } from "./cursor";
import { authorizeDocumentRead, resolvePinnedRevision } from "./documents-read";
import { KbDomainError } from "./errors";
import { type GitReadOptions, gitReadOptions, kbBareRepoPath } from "./git-read";
import { STAGED_MARKDOWN_BATCH_MAX_BYTES } from "./limits";
import type { HeldLockLease, LockQuery } from "./lock";
import type { AssetManifestEntry } from "./manifest";
import { canonicalRequestHash, type IntentRow } from "./operation-intent";
import { prismaAuthorityStore } from "./permissions";
import { actorKeyFor, type CredentialVerifier, type Principal } from "./principal";
import { kbWriteToolSchemas } from "./protocol/writes";
import type { QuotaCharge } from "./quota";
import type { KbRuntimeConfig } from "./runtime";
import { readPublicationUpload } from "./uploads";

export type AssetImportRequest = z.infer<
  typeof kbWriteToolSchemas.knowledge_assets_import.input
> & {
  mode: "import";
  title: string;
  sourceSessionIds: string[];
};
export type AssetDelta = {
  uploads: { id: string; kind: "MARKDOWN" | "ASSET"; reservationIds: string[] }[];
  lineages: (AssetManifestEntry & { sourceKbId: string | null; sourceRev: string | null })[];
};

/** Prepare only DB claims and in-memory trees. No catalog/lineage/consumption or CAS effect. */
export async function prepareAssetChanges(
  query: LockQuery,
  input: {
    reposDir: string;
    assetsDir?: string;
    kbId: string;
    actorKey: string;
    opId: string;
    baseRevision: string;
    /** The publication's cancellation and deadline. */
    gitOptions?: GitReadOptions;
  },
  changes: Change[],
  imported?: AssetManifestEntry & { sourceKbId: string; sourceRev: string },
) {
  const delta: AssetDelta = { uploads: [], lineages: [] };
  const assetEntries = new Map<string, AssetManifestEntry>();
  const resolved: Change[] = [];
  let markdownBytes = 0;
  let casBytes = 0n;
  for (const change of changes) {
    if (change.op === "assetRemove" || change.op === "delete") {
      resolved.push(change);
      continue;
    }
    if (change.op !== "assetPut" && "markdown" in change.content) {
      markdownBytes += Buffer.byteLength(change.content.markdown);
      resolved.push(change);
      continue;
    }
    if (!input.assetsDir) throw new KbDomainError("STORAGE_UNAVAILABLE", "Staging unavailable");
    const uploadId =
      change.op === "assetPut"
        ? change.uploadId
        : (change.content as { uploadId: string }).uploadId;
    const kind = change.op === "assetPut" ? "ASSET" : "MARKDOWN";
    const { row, bytes } = await readPublicationUpload(query, input.assetsDir, {
      ...input,
      uploadId,
      kind,
    });
    if (!delta.uploads.some((upload) => upload.id === row.id)) {
      delta.uploads.push({ id: row.id, kind, reservationIds: row.reservationIds });
      await query(`UPDATE "staged_upload" SET "reservedByOpId" = $2 WHERE id = $1`, [
        row.id,
        input.opId,
      ]);
    }
    if (change.op === "assetPut") {
      const entry = {
        path: change.path,
        hash: row.declaredHash,
        size: row.declaredSize,
        mime: row.declaredMime,
      };
      assetEntries.set(change.path, entry);
      delta.lineages.push({ ...entry, sourceKbId: null, sourceRev: null });
      casBytes += BigInt(row.declaredSize);
      resolved.push(change);
    } else {
      markdownBytes += bytes.length;
      resolved.push({ ...change, content: { markdown: bytes.toString("utf8") } });
    }
  }
  if (markdownBytes > STAGED_MARKDOWN_BATCH_MAX_BYTES)
    throw invalidArgument("Staged Markdown exceeds batch limit", "TOO_LARGE");
  if (imported) {
    assetEntries.set(imported.path, imported);
    delta.lineages.push(imported);
  }
  const entries = await manifestAtCommitAsync(
    kbBareRepoPath(input.reposDir, input.kbId),
    input.baseRevision,
    input.gitOptions ?? {},
  );
  const validation = await assetValidationContext(
    query,
    input.kbId,
    [...entries, ...delta.lineages].map((entry) => entry.hash),
  );
  // A pre-existing global catalog row is immutable, including on dedup uploads.
  const existing = delta.lineages.length
    ? (
        await query<{ hash: string; size: number; mime: string }>(
          `SELECT hash, size, mime FROM "asset_blob" WHERE hash = ANY($1::text[])`,
          [delta.lineages.map((entry) => entry.hash)],
        )
      ).rows
    : [];
  for (const row of existing) {
    const entry = delta.lineages.find((entry) => entry.hash === row.hash)!;
    if (Number(row.size) !== entry.size || row.mime !== entry.mime)
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset catalog mismatch");
  }
  const charges: QuotaCharge[] = [];
  const owner = (
    await query<{ ownerId: string }>(`SELECT "ownerId" FROM "knowledge_base" WHERE id = $1`, [
      input.kbId,
    ])
  ).rows[0];
  for (const entry of delta.lineages) {
    if (!validation.lineageHashes.has(entry.hash)) {
      if (!owner?.ownerId) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
      charges.push(
        { dimension: "KB_LINEAGE_BYTES", subjectId: input.kbId, amount: BigInt(entry.size) },
        { dimension: "OWNER_LINEAGE_BYTES", subjectId: owner.ownerId, amount: BigInt(entry.size) },
      );
    }
    validation.lineageHashes.add(entry.hash);
    validation.trustedBlobs.set(entry.hash, { size: entry.size, mime: entry.mime });
  }
  return { delta, assetEntries, resolved, validation, charges, casBytes };
}

/** Durable intent + quota precede these recoverable, immutable external effects. */
export async function publishAssetBytes(
  lease: HeldLockLease,
  assetsDir: string,
  blobStore: BlobStore,
  intent: IntentRow,
  delta: AssetDelta,
) {
  for (const entry of delta.lineages) {
    if (entry.sourceKbId && blobStore.backend === "s3")
      await blobStore.assertDurable({
        hash: entry.hash,
        size: entry.size,
        signal: lease.scope.signal,
        deadlineAt: lease.scope.deadlineAt,
      });
  }
  for (const upload of delta.uploads) {
    if (upload.kind !== "ASSET") continue;
    const { row, bytes } = await lease.transaction((query) =>
      readPublicationUpload(query, assetsDir, {
        uploadId: upload.id,
        kbId: intent.kbId!,
        actorKey: intent.actorKey,
        kind: "ASSET",
        opId: intent.opId,
      }),
    );
    await publishCasBytes({
      blobStore,
      declaredHash: row.declaredHash,
      declaredSize: row.declaredSize,
      declaredMime: row.declaredMime,
      bytes,
      signal: lease.scope.signal,
      deadlineAt: lease.scope.deadlineAt,
    });
  }
}

/** Called inside the journal finalization transaction, including recovery. */
export async function finalizeAssetDelta(
  query: LockQuery,
  intent: Pick<IntentRow, "opId" | "kbId" | "actorKey" | "actorUserIdSnapshot" | "actorUserId">,
  delta: AssetDelta,
) {
  // Different KBs can finalize overlapping catalogs concurrently. Always lock hashes in order.
  for (const entry of [...delta.lineages].sort((a, b) =>
    a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0,
  )) {
    await query(
      `INSERT INTO "asset_blob" (hash, size, mime, "verifiedAt") VALUES ($1, $2, $3, now()) ON CONFLICT (hash) DO NOTHING`,
      [entry.hash, entry.size, entry.mime],
    );
    const catalog = (
      await query<{ size: number; mime: string }>(
        `SELECT size, mime FROM "asset_blob" WHERE hash = $1`,
        [entry.hash],
      )
    ).rows[0];
    if (!catalog || Number(catalog.size) !== entry.size || catalog.mime !== entry.mime)
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset catalog mismatch");
    await query(
      `INSERT INTO "kb_asset_lineage" ("kbId", hash, "actorKey", "actorUserIdSnapshot", "actorUserId", source, "sourceKbId", "sourceRev")
      VALUES ($1, $2, $3, $4, $5, $6::"KbAssetLineageSource", $7, $8) ON CONFLICT ("kbId", hash) DO NOTHING`,
      [
        intent.kbId,
        entry.hash,
        intent.actorKey,
        intent.actorUserIdSnapshot,
        intent.actorUserId,
        entry.sourceKbId ? "IMPORT" : "UPLOAD",
        entry.sourceKbId,
        entry.sourceRev,
      ],
    );
  }
  // Lock every upload before quota settlement, in the same order as preparation.
  for (const upload of delta.uploads) {
    const consumed = await query(
      `UPDATE "staged_upload" SET state = 'CONSUMED'::"StagedUploadState",
      "consumedByOpId" = $2, "reservedByOpId" = NULL, "updatedAt" = now()
      WHERE id = $1 AND "reservedByOpId" = $2 AND state = 'READY'::"StagedUploadState"`,
      [upload.id, intent.opId],
    );
    if (consumed.rowCount !== 1) throw new KbDomainError("CONFLICT", "Upload ownership lost");
  }
}

export async function listAssets(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  input: {
    kbId: string;
    rev?: string;
    limit?: number;
    cursor?: string | null;
  },
  verifier?: CredentialVerifier,
  readOptions: GitReadOptions = {},
) {
  const options = gitReadOptions(readOptions);
  const principal = typeof actor === "string" ? { kind: "browser" as const, userId: actor } : actor;
  const admission = {
    store: prismaAuthorityStore(runtime.prisma),
    principal,
    verifier,
    kbId: input.kbId,
    operation: "read" as const,
  };
  await authorizeDocumentRead(admission);
  const row = await runtime.prisma.knowledgeBase.findUnique({
    where: { id: input.kbId },
    select: { headSha: true },
  });
  const actorKey = actorKeyFor(principal);
  const filterHash = stableFilterHash({ kind: "assets" });
  const binding = { actorKey, kbId: input.kbId, filterHash, sortKey: "path:asc", revision: "*" };
  const cursor = input.cursor ? runtime.cursorSigner.verify(input.cursor, binding) : null;
  if (cursor && input.rev && input.rev !== cursor.revision)
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const rev = await resolvePinnedRevision(
    kbBareRepoPath(runtime.reposDir, input.kbId),
    cursor?.revision ?? input.rev,
    row?.headSha ?? null,
    options,
  );
  const entries = await authorizedAssetsAtRevision({
    ...options,
    ...admission,
    query: prismaAssetQuery(runtime.prisma),
    reposDir: runtime.reposDir,
    rev,
  });
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const page = entries
    .filter((entry) => !cursor?.lastKey || entry.path > cursor.lastKey)
    .slice(0, limit + 1);
  const items = page.slice(0, limit);
  await authorizeDocumentRead(admission);
  return {
    items,
    nextCursor:
      page.length > limit
        ? runtime.cursorSigner.sign({
            ...binding,
            v: 1,
            revision: rev,
            lastKey: items.at(-1)!.path,
            exp: cursorExpiry(),
          })
        : null,
  };
}

export async function mutateAsset(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  kind: "put" | "import",
  raw: unknown,
  verifier?: CredentialVerifier,
) {
  const principal = typeof actor === "string" ? { kind: "browser" as const, userId: actor } : actor;
  const schema =
    kind === "put"
      ? kbWriteToolSchemas.knowledge_assets_put.input
      : kbWriteToolSchemas.knowledge_assets_import.input;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new KbDomainError("INVALID_ARGUMENT", "Invalid asset request");
  const input = parsed.data;
  const request =
    "source" in input
      ? {
          ...input,
          mode: "import" as const,
          title: boundedTitle(`Import asset ${input.path}`),
          sourceSessionIds: [],
        }
      : {
          mode: "edit" as const,
          baseRevision: input.baseRevision,
          proposalNumber: input.proposalNumber,
          proposalHeadSha: input.proposalHeadSha,
          title: boundedTitle(`Add asset ${input.path}`),
          sourceSessionIds: [],
          changes: [{ op: "assetPut" as const, path: input.path, uploadId: input.uploadId }],
        };
  const publication = createChangesPublication({
    store: prismaAuthorityStore(runtime.prisma),
    principal,
    verifier,
    reposDir: runtime.reposDir,
    canonicalOrigin: runtime.canonicalOrigin,
    assetsDir: runtime.assetsDir,
    blobStore: runtime.blobStore,
    kbId: input.kbId,
    idempotencyKey: input.idempotencyKey,
    request,
    operation: kind === "put" ? "ASSET_PUT" : "ASSET_IMPORT",
    fieldFor: (_index, key) => (key === "path" ? "/path" : undefined),
    requestHash: canonicalRequestHash(input),
    ratePort: runtime.ratePort,
    diskMeter: runtime.diskMeter,
  });
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: "source" in input ? [input.kbId, input.source.kbId] : [input.kbId],
    barrier: publication.barrier,
    run: (ctx) => {
      const executor = runtime.createGitExecutor?.(ctx, input.kbId);
      if (!executor) throw new KbDomainError("STORAGE_UNAVAILABLE", "Git executor unavailable");
      return publication.publish(ctx.lease, executor);
    },
  });
}
