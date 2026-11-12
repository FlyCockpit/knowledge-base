import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assetCacheBinding, createAssetCache } from "@knowledge-base/api/lib/kb/asset-cache";
import { createAssetPublicationState } from "@knowledge-base/api/lib/kb/asset-publication-state";
import { createAssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import { createAssetCacheTransactions } from "@knowledge-base/api/lib/kb/asset-storage-state";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { ASSET_FRAME_BYTES } from "@knowledge-base/api/lib/kb/authorized-stream";
import type { BlobStore } from "@knowledge-base/api/lib/kb/blob-store";
import { casBlobPath, createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { assetS3Key, createS3BlobStore } from "@knowledge-base/api/lib/kb/blob-store-s3";
import { publishCasBytes } from "@knowledge-base/api/lib/kb/cas";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import * as media from "@knowledge-base/api/lib/kb/fixtures/media-bytes";
import { kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import { writeInitialMainCommit, writeStagedObjects } from "@knowledge-base/api/lib/kb/git-write";
import {
  type AssetManifestEntry,
  canonicalManifestBytes,
} from "@knowledge-base/api/lib/kb/manifest";
import { KB_MANAGED_GITIGNORE } from "@knowledge-base/api/lib/kb/paths";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { mintPersonalToken, revokePersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index";
import { createAssetS3Fixture } from "./s3-fixture";

// Cross-project fixture imports; owning projects type-check the production modules.
const {
  createKbAssetRoutes,
}: {
  createKbAssetRoutes: (options: {
    runtime: () => Pick<
      KbRuntimeConfig,
      "prisma" | "reposDir" | "assetsDir" | "blobStore" | "canonicalOrigin"
    >;
    session: () => Promise<{ user: { id: string } } | null>;
    bearer?: (
      request: Request,
    ) => Promise<{ principal: TokenPrincipal; verifier: CredentialVerifier }>;
  }) => { request(path: string, init?: RequestInit): Promise<Response> };
} = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/kb-asset-routes.ts")).href
);
const {
  stageCommitWithTreeFiles,
}: {
  stageCommitWithTreeFiles: (input: {
    parentSha: string;
    message: string;
    files: { segments: string[]; content: Buffer }[];
  }) => { commitSha: string; objects: Parameters<typeof writeStagedObjects>[1] };
} = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/lib/kb/staged-tree.ts")).href
);

const { createBearerAdmission } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
)) as {
  createBearerAdmission(options: {
    origin: string;
    withQuery: ReturnType<typeof credentialQuery>;
  }): (request: Request) => Promise<{ principal: TokenPrincipal; verifier: CredentialVerifier }>;
};
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const root = mkdtempSync(join(tmpdir(), "kb-asset-http-"));
const reposDir = join(root, "repos");
const assetsDir = join(root, "assets");
mkdirSync(reposDir);
mkdirSync(assetsDir);
setKbRecoveryComplete(true);
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(root, { recursive: true, force: true });
});
const user = (name: string) =>
  prisma.user.create({
    data: { name, email: `${randomUUID()}@example.invalid`, emailVerified: true },
  });
const owner = await user("Asset reader");
const member = await user("Asset member");
function app(
  userId: string | null = owner.id,
  blobStore: BlobStore = createDiskBlobStore(assetsDir),
) {
  return createKbAssetRoutes({
    runtime: () => ({
      prisma,
      reposDir,
      assetsDir,
      blobStore,
      canonicalOrigin: "https://kb.example.invalid",
    }),
    session: async () => (userId ? { user: { id: userId } } : null),
  });
}
async function kb() {
  const row = await prisma.knowledgeBase.create({
    data: {
      ownerId: owner.id,
      name: "Media",
      slug: `media-${randomUUID().slice(0, 8)}`,
      description: "Asset HTTP integration fixture",
      state: "CREATING",
    },
  });
  const rev = await writeInitialMainCommit(
    {
      reposDir,
      kbId: row.id,
      executor: {
        exec: ({ cwd, argv, env }) => {
          execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
        },
      },
    },
    { message: "fixture", description: row.description },
  );
  await prisma.knowledgeBase.update({
    where: { id: row.id },
    data: { state: "ACTIVE", headSha: rev },
  });
  return { id: row.id, rev };
}
async function commit(
  kb: { id: string; rev: string },
  entries: AssetManifestEntry[],
  publish = true,
) {
  const staged = stageCommitWithTreeFiles({
    parentSha: kb.rev,
    message: randomUUID(),
    files: [
      { segments: ["index.md"], content: Buffer.from("# Media\n") },
      { segments: [".gitignore"], content: Buffer.from(KB_MANAGED_GITIGNORE) },
      {
        segments: [".assets", "manifest.json"],
        content: canonicalManifestBytes({ version: 1, entries }),
      },
    ],
  });
  const repo = kbBareRepoPath(reposDir, kb.id);
  writeStagedObjects(repo, staged.objects);
  if (publish) {
    // Test-only fixture publication; production writes stay behind the coordinator.
    writeFileSync(join(repo, "refs/heads/main"), `${staged.commitSha}\n`);
    await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: { headSha: staged.commitSha },
    });
  }
  return { id: kb.id, rev: staged.commitSha };
}
async function asset(kbId: string, bytes: Buffer, mime: string): Promise<AssetManifestEntry> {
  const hash = media.sha256Buffer(bytes);
  await publishCasBytes({
    blobStore: createDiskBlobStore(assetsDir),
    bytes,
    declaredHash: hash,
    declaredSize: bytes.length,
    declaredMime: mime,
  });
  await prisma.assetBlob.upsert({
    where: { hash },
    create: { hash, size: bytes.length, mime },
    update: {},
  });
  await prisma.kbAssetLineage.create({
    data: {
      kbId,
      hash,
      actorKey: `user:${owner.id}`,
      actorUserIdSnapshot: owner.id,
      source: "UPLOAD",
    },
  });
  return { path: "media.bin", hash, size: bytes.length, mime };
}
const url = (kb: { id: string; rev: string }, hash: string) =>
  `/kb-assets/${kb.id}/${hash}?rev=${kb.rev}`;

describe("asset-http real Git/CAS/live SQL authority", () => {
  it("mounted never-expiring PAT reads actual CAS frames and loses the next frame after grant revocation", async () => {
    const base = await kb();
    const bytes = Buffer.alloc(ASSET_FRAME_BYTES * 4);
    media.minimalWav().copy(bytes);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    const entry = await asset(base.id, bytes, "audio/wav");
    const revision = await commit(base, [entry]);
    const tokenRuntime: Parameters<typeof mintPersonalToken>[0] = {
      canonicalOrigin: "https://kb.example.invalid",
      coordinator: {
        run: (o) =>
          runLockedOperation({
            connectionString: db.urls.runtime,
            opId: o.opId,
            kind: "authority",
            run: (lease) =>
              o.run({
                lease,
                signal: lease.scope.signal,
                issueWriteCapability() {
                  throw new Error("No Git writes");
                },
              }),
          }),
      },
    };
    const minted = await mintPersonalToken(tokenRuntime, owner.id, {
      name: "media",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: base.id, bits: ["read"] }],
      expiresAt: null,
    });
    const mounted = createKbAssetRoutes({
      runtime: () => ({
        prisma,
        reposDir,
        assetsDir,
        blobStore: createDiskBlobStore(assetsDir),
        canonicalOrigin: tokenRuntime.canonicalOrigin,
      }),
      bearer: createBearerAdmission({
        origin: tokenRuntime.canonicalOrigin,
        withQuery: credentialQuery(db.urls.runtime),
      }),
      session: async () => {
        throw new Error("Bearer media must not fall back to cookies");
      },
    });
    const response = await mounted.request(
      `${tokenRuntime.canonicalOrigin}${url(revision, entry.hash)}`,
      { headers: { authorization: `Bearer ${minted.secret}` } },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect(Buffer.from((await reader.read()).value!)).toEqual(
        bytes.subarray(0, ASSET_FRAME_BYTES),
      );
      await setImmediate();
      await revokePersonalToken(tokenRuntime, owner.id, minted.token.id);
      await expect(reader.read()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await reader.cancel().catch(() => {});
    }
  });
  it("removing only the read tool group stops the next frame and refuses a new read, with no bytes", async () => {
    const base = await kb();
    const bytes = Buffer.alloc(ASSET_FRAME_BYTES * 4);
    media.minimalWav().copy(bytes);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    const entry = await asset(base.id, bytes, "audio/wav");
    const revision = await commit(base, [entry]);
    const tokenRuntime: Parameters<typeof mintPersonalToken>[0] = {
      canonicalOrigin: "https://kb.example.invalid",
      coordinator: {
        run: (o) =>
          runLockedOperation({
            connectionString: db.urls.runtime,
            opId: o.opId,
            kind: "authority",
            run: (lease) =>
              o.run({
                lease,
                signal: lease.scope.signal,
                issueWriteCapability() {
                  throw new Error("No Git writes");
                },
              }),
          }),
      },
    };
    const minted = await mintPersonalToken(tokenRuntime, owner.id, {
      name: "media",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: base.id, bits: ["read"] }],
      expiresAt: null,
    });
    const mounted = createKbAssetRoutes({
      runtime: () => ({
        prisma,
        reposDir,
        assetsDir,
        blobStore: createDiskBlobStore(assetsDir),
        canonicalOrigin: tokenRuntime.canonicalOrigin,
      }),
      bearer: createBearerAdmission({
        origin: tokenRuntime.canonicalOrigin,
        withQuery: credentialQuery(db.urls.runtime),
      }),
      session: async () => {
        throw new Error("Bearer media must not fall back to cookies");
      },
    });
    const response = await mounted.request(
      `${tokenRuntime.canonicalOrigin}${url(revision, entry.hash)}`,
      { headers: { authorization: `Bearer ${minted.secret}` } },
    );
    expect(response.status).toBe(200);
    const { grantId } = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: minted.token.id },
      select: { grantId: true },
    });
    // The grant stays otherwise valid: only `read` is removed.
    const withoutRead = MCP_TOOL_GROUPS.filter((group) => group !== "read");
    const reader = response.body!.getReader();
    try {
      expect(Buffer.from((await reader.read()).value!)).toEqual(
        bytes.subarray(0, ASSET_FRAME_BYTES),
      );
      await setImmediate();
      await prisma.mcpGrant.update({ where: { id: grantId }, data: { toolGroups: withoutRead } });
      await expect(reader.read()).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await reader.cancel().catch(() => {});
    }
    const refused = await mounted.request(
      `${tokenRuntime.canonicalOrigin}${url(revision, entry.hash)}`,
      { headers: { authorization: `Bearer ${minted.secret}` } },
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).not.toBe("audio/wav");
    expect(await refused.json()).toEqual({ error: "FORBIDDEN" });
  });
  it.each([
    ["image/jpeg", media.minimalJpeg],
    ["image/png", media.minimalPng],
    ["image/gif", media.minimalGif],
    ["image/webp", media.minimalWebp],
    ["video/mp4", media.realMp4],
    ["video/webm", media.realWebm],
    ["audio/mpeg", media.cbrMp3NoTag],
    ["audio/wav", media.minimalWav],
    ["audio/ogg", media.minimalOgg],
    ["application/pdf", media.minimalPdf],
  ] as const)(
    "serves trusted %s exactly, with the required disposition",
    async (mime, makeBytes) => {
      const base = await kb();
      const bytes = makeBytes();
      const entry = await asset(base.id, bytes, mime);
      const rev = await commit(base, [entry]);
      const response = await app().request(url(rev, entry.hash));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mime);
      expect(response.headers.get("content-disposition")).toBe(
        mime === "application/pdf" ? "attachment" : "inline",
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    },
  );
  it("empty manifest and default unauthenticated requests disclose no blob", async () => {
    const base = await kb();
    const hash = `sha256:${"a".repeat(64)}`;
    expect((await app().request(url(base, hash))).status).toBe(404);
    const response = await app(null).request(url(base, hash));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
  });
  it("retains historical bytes after HEAD removal; bounds ranges and HEAD", async () => {
    const base = await kb();
    const bytes = media.minimalWav();
    const entry = await asset(base.id, bytes, "audio/wav");
    const historic = await commit(base, [entry]);
    const head = await commit(historic, []);
    expect((await app().request(url(head, entry.hash))).status).toBe(404);
    const history = await app().request(url(historic, entry.hash));
    expect(history.status).toBe(200);
    expect(Buffer.from(await history.arrayBuffer())).toEqual(bytes);
    for (const [range, start, end] of [
      ["bytes=2-6", 2, 6],
      ["bytes=-4", bytes.length - 4, bytes.length - 1],
      ["bytes=4-", 4, bytes.length - 1],
      ["bytes=0-999999", 0, bytes.length - 1],
      ["bytes=-999999", 0, bytes.length - 1],
    ] as const) {
      const response = await app().request(url(historic, entry.hash), { headers: { range } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
    }
    for (const range of ["bytes=999999-", "bytes=0-1,4-5", "bytes=0-9007199254740992"]) {
      const response = await app().request(url(historic, entry.hash), { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
      expect(await response.json()).toEqual({ error: "RANGE_NOT_SATISFIABLE" });
    }
    const response = await app().request(url(historic, entry.hash), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(await response.text()).toBe("");
  });
  it("rejects foreign hash/revision, absent lineage, unreachable commit and unreadable KB", async () => {
    const source = await kb();
    const entry = await asset(source.id, media.minimalPng(), "image/png");
    const revision = await commit(source, [entry]);
    const target = await kb();
    const noLineage = await commit(target, [entry]);
    const unreachable = await commit(revision, [entry], false);
    for (const requested of [
      url(target, entry.hash),
      url(noLineage, entry.hash),
      url({ id: target.id, rev: revision.rev }, entry.hash),
      url(unreachable, entry.hash),
    ]) {
      const response = await app().request(requested);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    }
    const response = await app(member.id).request(url(revision, entry.hash), {
      headers: { range: "bytes=999999-" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.has("content-range")).toBe(false);
  });
  it("maps corrupt and missing physical bytes to STORAGE_UNAVAILABLE before headers", async () => {
    const base = await kb();
    const bytes = media.minimalPdf();
    const entry = await asset(base.id, bytes, "application/pdf");
    const revision = await commit(base, [entry]);
    const path = casBlobPath(assetsDir, entry.hash);
    writeFileSync(path, Buffer.alloc(bytes.length, 0));
    for (const missing of [false, true]) {
      if (missing) rmSync(path);
      const response = await app().request(url(revision, entry.hash));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "STORAGE_UNAVAILABLE" });
    }
  });
  it("paused reader emits no new frame after durable share revocation", async () => {
    const base = await kb();
    const bytes = Buffer.alloc(ASSET_FRAME_BYTES * 4);
    media.minimalWav().copy(bytes);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    const entry = await asset(base.id, bytes, "audio/wav");
    const revision = await commit(base, [entry]);
    await prisma.kbShare.create({ data: { kbId: base.id, userId: member.id, bits: ["read"] } });
    const response = await app(member.id).request(url(revision, entry.hash));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toHaveLength(ASSET_FRAME_BYTES);
    await setImmediate(); // no consumer demand: no next authorized frame queued
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId: base.id, userId: member.id } },
      data: { revokedAt: new Date() },
    });
    await expect(reader.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function remoteFixture() {
  const http = await createAssetS3Fixture();
  const lifecycle = createAssetStorageLifecycle("SERVER");
  const config = {
    endpoint: http.endpoint,
    bucket: "assets",
    region: "auto",
    prefix: "p4",
    forcePathStyle: true,
    credentials: { accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" },
  };
  const cacheDir = join(root, randomUUID());
  mkdirSync(cacheDir);
  const binding = await assetCacheBinding({
    assetsDir: cacheDir,
    storageGeneration: randomUUID(),
    configuration: assetS3Locator(config),
    limit: 26214400n,
  });
  const transactions = createAssetCacheTransactions(db.urls.runtime);
  const cache = createAssetCache({
    assetsDir: cacheDir,
    binding,
    transactions,
    lifecycle,
    meter: { freeBytes: async () => 100n * 1024n ** 3n },
  });
  await cache.initializeEmpty(() => {});
  await cache.registerOwner(() => {}, Date.now() + 15000);
  const publication = createAssetPublicationState({
    binding: { storageGeneration: binding.storageGeneration, locator: assetS3Locator(config) },
    transactions,
  });
  const store = createS3BlobStore({ assetsDir: cacheDir, config, publication, cache, lifecycle });
  const bytes = Buffer.alloc(ASSET_FRAME_BYTES * 3, 0x61);
  media.minimalWav().copy(bytes);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  const base = await kb();
  const entry = await asset(base.id, bytes, "audio/wav");
  const revision = await commit(base, [entry]);
  http.objects.set(`/assets/${assetS3Key(config.prefix, entry.hash)}`, { bytes, metadata: {} });
  const entries = () =>
    prisma.assetCacheEntry.findMany({ where: { cacheId: binding.cacheId }, take: 10 });
  const pins = () => prisma.assetCachePin.count({ where: { entry: { cacheId: binding.cacheId } } });
  return {
    http,
    store,
    cache,
    lifecycle,
    bytes,
    entry,
    revision,
    entries,
    pins,
    cacheDir,
    binding,
    close: async () => {
      await lifecycle.stop();
      await http.close();
    },
  };
}

describe("S3 asset HTTP with real SDK, Git, Postgres and cache", () => {
  it("tees the first frame before remote EOF, applies backpressure and preserves FILLING recency in READY", async () => {
    const f = await remoteFixture();
    try {
      const gate = f.http.pauseGetsAfter(ASSET_FRAME_BYTES);
      const response = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = reader.read();
      await gate.reached;
      expect(Buffer.from((await first).value!)).toEqual(f.bytes.subarray(0, ASSET_FRAME_BYTES));
      await vi.waitFor(async () =>
        expect((await f.entries())[0]?.lastFetchSequence).toBeGreaterThan(0n),
      );
      const filling = (await f.entries())[0]!;
      expect(filling.state).toBe("FILLING");
      expect(await f.pins()).toBe(1);
      const partial = join(f.cacheDir, ".private/tmp", filling.tempName);
      expect(readFileSync(partial)).toHaveLength(ASSET_FRAME_BYTES);
      await setImmediate();
      expect(readFileSync(partial)).toHaveLength(ASSET_FRAME_BYTES);
      gate.release();
      let total = ASSET_FRAME_BYTES;
      for (;;) {
        const frame = await reader.read();
        if (frame.done) break;
        total += frame.value.length;
      }
      expect(total).toBe(f.bytes.length);
      await vi.waitFor(async () => expect(await f.pins()).toBe(0));
      const ready = (await f.entries())[0]!;
      expect(ready.state).toBe("READY");
      expect(ready.lastFetchSequence).toBeGreaterThanOrEqual(filling.lastFetchSequence);
      const calls = f.http.requests.length;
      f.http.setGetStatus(503);
      const cached = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      expect(Buffer.from(await cached.arrayBuffer())).toEqual(f.bytes);
      expect(f.http.requests).toHaveLength(calls);
    } finally {
      await f.close();
    }
  });
  it.each(["bytes=0-2", "bytes=262142-262147", "bytes=524288-", "bytes=-7"])(
    "hashes the whole miss for %s",
    async (range) => {
      const f = await remoteFixture();
      try {
        const response = await app(owner.id, f.store).request(url(f.revision, f.entry.hash), {
          headers: { range },
        });
        expect(response.status).toBe(206);
        const match = /bytes (\d+)-(\d+)\//.exec(response.headers.get("content-range")!)!;
        expect(Buffer.from(await response.arrayBuffer())).toEqual(
          f.bytes.subarray(Number(match[1]), Number(match[2]) + 1),
        );
        await vi.waitFor(async () => expect(await f.pins()).toBe(0));
        expect((await f.entries())[0]?.state).toBe("READY");
        expect(readFileSync(casBlobPath(f.cacheDir, f.entry.hash))).toEqual(f.bytes);
        expect(f.http.requests.map((r) => r.method)).toEqual(["GET"]);
      } finally {
        await f.close();
      }
    },
  );
  it.each([null, "bytes=0-2"])(
    "withholds the final frame on a corrupt tail (%s), repairs and refills",
    async (range) => {
      const f = await remoteFixture();
      try {
        f.http.corruptGets(true);
        const response = await app(owner.id, f.store).request(url(f.revision, f.entry.hash), {
          headers: range ? { range } : {},
        });
        expect(response.status).toBe(range ? 206 : 200);
        let delivered = 0;
        const reader = response.body!.getReader();
        await expect(
          (async () => {
            for (;;) {
              const frame = await reader.read();
              if (frame.done) break;
              delivered += frame.value.length;
            }
          })(),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        expect(delivered).toBe(range ? 0 : f.bytes.length - ASSET_FRAME_BYTES);
        await vi.waitFor(async () => expect(await f.pins()).toBe(0));
        await f.cache.recover();
        expect(await f.entries()).toEqual([]);
        f.http.corruptGets(false);
        const retry = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
        expect(Buffer.from(await retry.arrayBuffer())).toEqual(f.bytes);
      } finally {
        await f.close();
      }
    },
  );
  it("HEAD and internal reads verify without admission/touch; 416 performs no byte IO", async () => {
    const f = await remoteFixture();
    try {
      const head = await app(owner.id, f.store).request(url(f.revision, f.entry.hash), {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(await f.entries()).toEqual([]);
      const r = await f.store.open({
        hash: f.entry.hash,
        size: f.bytes.length,
        purpose: "internal",
        signal: new AbortController().signal,
      });
      await r.preflight();
      await r.readFrame(0, 2);
      r.sampleDownload?.();
      await r.complete();
      await r.close();
      expect(await f.entries()).toEqual([]);
      const calls = f.http.requests.length;
      const invalid = await app(owner.id, f.store).request(url(f.revision, f.entry.hash), {
        headers: { range: "bytes=0-1,4-5" },
      });
      expect(invalid.status).toBe(416);
      expect(f.http.requests).toHaveLength(calls);
      f.http.corruptGets(true);
      const badHead = await app(owner.id, f.store).request(url(f.revision, f.entry.hash), {
        method: "HEAD",
      });
      expect(badHead.status).toBe(503);
      expect(await f.entries()).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it.each(["revocation", "cancel", "shutdown"])("drains a partial fill after %s", async (kind) => {
    const f = await remoteFixture();
    try {
      await prisma.kbShare.create({
        data: { kbId: f.revision.id, userId: member.id, bits: ["read"] },
      });
      const gate = f.http.pauseGetsAfter(ASSET_FRAME_BYTES);
      const response = await app(member.id, f.store).request(url(f.revision, f.entry.hash));
      const reader = response.body!.getReader();
      expect((await reader.read()).value).toHaveLength(ASSET_FRAME_BYTES);
      if (kind === "revocation") {
        await prisma.kbShare.update({
          where: { kbId_userId: { kbId: f.revision.id, userId: member.id } },
          data: { revokedAt: new Date() },
        });
        await expect(reader.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
      } else if (kind === "cancel") await reader.cancel();
      else {
        await f.lifecycle.stop();
        await expect(reader.read()).rejects.toThrow();
      }
      gate.release();
      await vi.waitFor(async () => expect(await f.pins()).toBe(0));
      if (kind !== "shutdown") {
        await f.cache.recover();
        expect(await f.entries()).toEqual([]);
      }
    } finally {
      await f.close();
    }
  });
  it("ignores failed/stalled recency and closes final-frame byte pins independently", async () => {
    const f = await remoteFixture();
    const pending = Promise.withResolvers<void>();
    try {
      const touch = vi
        .spyOn(f.cache.state, "touch")
        .mockRejectedValue(new Error("recency DB unavailable"));
      const first = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      expect(Buffer.from(await first.arrayBuffer())).toEqual(f.bytes);
      await vi.waitFor(async () => expect(await f.pins()).toBe(0));
      expect(touch).toHaveBeenCalled();
      touch.mockImplementation(() => pending.promise);
      const cached = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      const before = touch.mock.calls.length;
      expect(Buffer.from(await cached.arrayBuffer())).toEqual(f.bytes);
      await vi.waitFor(async () => expect(await f.pins()).toBe(0));
      expect(touch.mock.calls.length - before).toBe(1);
      expect(await f.cache.repair(Date.now() + 5000, f.entry.hash, true)).toBe(true);
      expect(await f.entries()).toEqual([]);
    } finally {
      pending.resolve();
      await f.close();
    }
  });
  it("same-hash followers wait for READY and never start a second GET", async () => {
    const f = await remoteFixture();
    try {
      const gate = f.http.pauseGetsAfter(ASSET_FRAME_BYTES);
      const first = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      const reader = first.body!.getReader();
      expect((await reader.read()).value).toHaveLength(ASSET_FRAME_BYTES);
      let opened = false;
      const following = app(owner.id, f.store)
        .request(url(f.revision, f.entry.hash))
        .then((r) => {
          opened = true;
          return r;
        });
      await setImmediate();
      expect(opened).toBe(false);
      gate.release();
      while (!(await reader.read()).done) {
        /* drain leader */
      }
      const second = await following;
      expect(Buffer.from(await second.arrayBuffer())).toEqual(f.bytes);
      expect(f.http.requests.map((r) => r.method)).toEqual(["GET"]);
      await vi.waitFor(async () => expect(await f.pins()).toBe(0));
    } finally {
      await f.close();
    }
  });
  it("publication dedup invalidates corrupt cache bytes and a fresh publication refills safely", async () => {
    const f = await remoteFixture();
    try {
      await prisma.appSetting.upsert({
        where: { key: "kb.asset-storage" },
        create: {
          key: "kb.asset-storage",
          value: JSON.stringify({
            version: 1,
            mode: "s3",
            activeGeneration: f.binding.storageGeneration,
            locator: f.binding.configuration,
          }),
        },
        update: {
          value: JSON.stringify({
            version: 1,
            mode: "s3",
            activeGeneration: f.binding.storageGeneration,
            locator: f.binding.configuration,
          }),
        },
      });
      const initial = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      await initial.arrayBuffer();
      await vi.waitFor(async () => expect(await f.pins()).toBe(0));
      const old = (await f.entries())[0]!;
      writeFileSync(casBlobPath(f.cacheDir, f.entry.hash), Buffer.alloc(f.bytes.length));
      const publish = () =>
        f.store.publishVerified({
          declaredHash: f.entry.hash,
          declaredSize: f.bytes.length,
          declaredMime: "audio/wav",
          bytes: f.bytes,
        });
      await expect(publish()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await f.cache.recover();
      expect(await f.entries()).toEqual([]);
      await publish();
      expect(await f.pins()).toBe(0);
      const fresh = (await f.entries())[0]!;
      expect(fresh.incarnation).not.toBe(old.incarnation);
      expect(fresh.state).toBe("READY");
      expect(fresh.lastFetchSequence).toBe(0n);
    } finally {
      await f.close();
    }
  });
  it("invalidates corrupt cache hits, then permits safe remote refill", async () => {
    const f = await remoteFixture();
    try {
      const initial = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      await initial.arrayBuffer();
      await vi.waitFor(async () => expect(await f.pins()).toBe(0));
      const old = (await f.entries())[0]!;
      writeFileSync(casBlobPath(f.cacheDir, f.entry.hash), Buffer.alloc(f.bytes.length));
      const bad = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      expect(bad.status).toBe(503);
      await f.cache.recover();
      const good = await app(owner.id, f.store).request(url(f.revision, f.entry.hash));
      expect(Buffer.from(await good.arrayBuffer())).toEqual(f.bytes);
      expect((await f.entries())[0]?.incarnation).not.toBe(old.incarnation);
    } finally {
      await f.close();
    }
  });
});
