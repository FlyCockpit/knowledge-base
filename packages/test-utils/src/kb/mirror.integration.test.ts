import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeUserAccount } from "@knowledge-base/api/lib/kb/account-removal";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { deleteKnowledgeBase } from "@knowledge-base/api/lib/kb/bases";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { decryptDeployKey } from "@knowledge-base/api/lib/kb/deploy-key";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import type { DnsLookupFn } from "@knowledge-base/api/lib/kb/egress";
import { kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import {
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import { queueNameForDurableKind } from "@knowledge-base/api/lib/kb/jobs";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import {
  activateVerifiedDeployKey,
  configureMirror,
  disconnectMirror,
  finishMirrorAttempt,
  getMirrorStatus,
  type MirrorStatus,
  queueMirrorAttempt,
  registerMirrorExecutor,
  reserveMirrorAttempt,
  resetMirrorExecutorForTests,
  rotateMirrorKey,
  teardownMirror,
} from "@knowledge-base/api/lib/kb/mirror";
import type { Principal } from "@knowledge-base/api/lib/kb/principal";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import {
  listTransferLifecycleHandlersForTests,
  transferAccept,
  transferRequest,
} from "@knowledge-base/api/lib/kb/transfer";
import { runWithAllowedAccountDeletion } from "@knowledge-base/auth/account-deletion-policy";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireBuiltArtifact } from "./build-artifacts.mjs";
import { openKbPostgresClusterFromEnv, openKbRedisFromEnv } from "./index";
import { reapProcessTree, spawnProcessGroup } from "./process";
import { createSshFixture, snapshotRepo } from "./ssh";

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));

type NetworkInput = {
  attemptId: string;
  canonicalRepo: string;
  url: string;
  hostKeys: string[];
  seed: ReturnType<typeof decryptDeployKey>;
  sha: string;
  activate: boolean;
  signal: AbortSignal;
};
type NetworkResult = { state: "COMPLETED" | "FAILED" | "UNKNOWN"; resultCode: string };
// Dynamic module URLs keep this composite TS project inside its root, matching
// the other cross-app integration suites. Production source is typechecked by worker.
const { runMirrorDelivery, recoverMirrorReservations } = (await import(
  new URL("../../../../apps/worker/src/handlers/push-mirror.ts", import.meta.url).href
)) as {
  runMirrorDelivery(
    db: KbRuntimeConfig["prisma"],
    options: {
      durableJobId: string;
      workerId: string;
      connectionString: string;
      reposDir: string;
      masterKey: string;
      scratchRoot: string;
      signal?: AbortSignal;
      transport(input: NetworkInput): Promise<NetworkResult>;
    },
  ): Promise<unknown>;
  recoverMirrorReservations(
    db: KbRuntimeConfig["prisma"],
    connectionString: string,
    root: string,
  ): Promise<void>;
};
const { runMirrorSsh, MirrorDrainError, processIdentity } = (await import(
  new URL("../../../../apps/worker/src/lib/mirror-ssh.ts", import.meta.url).href
)) as {
  MirrorDrainError: typeof Error;
  processIdentity(pid: number): Promise<string | null>;
  runMirrorSsh(
    input: NetworkInput,
    options: {
      root: string;
      wrapperPath: string;
      timeoutMs?: number;
      resolveAddress(host: string): Promise<string>;
    },
  ): Promise<NetworkResult>;
};

const cluster = await openKbPostgresClusterFromEnv();
const redis = openKbRedisFromEnv(`${cluster.id}mirror`);
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-mirror-"));
const executor: GitMutatingExecutor = {
  exec({ cwd, argv, env }) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("fixture Git failed")),
      );
    });
  },
};
const runtime: KbRuntimeConfig = {
  prisma,
  reposDir,
  assetsDir: reposDir,
  blobStore: createDiskBlobStore(reposDir),
  connectionString: db.urls.runtime,
  canonicalOrigin: "https://mirror.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  createGitExecutor: () => executor,
  coordinator: {
    run: (options) =>
      runLockedOperation({
        ...options,
        connectionString: db.urls.runtime,
        kind: options.kind === "authority" ? "authority" : "kb-write",
        run: (lease) =>
          options.run({
            lease,
            signal: lease.scope.signal,
            issueWriteCapability() {
              throw new Error("unused fixture capability");
            },
          }),
      }),
  },
};
const master = randomBytes(32);
const masterKey = master.toString("base64");
const publicLookup = ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
  cb(null, [{ address: "93.184.216.10", family: 4 }])) as unknown as DnsLookupFn;
const privateLookup = ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
  cb(null, [{ address: "10.9.8.7", family: 4 }])) as unknown as DnsLookupFn;
const actor = (userId: string): Principal => ({ kind: "browser", userId });

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.from(value);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}
const hostKey = () =>
  `ssh-ed25519 ${Buffer.concat([sshString("ssh-ed25519"), sshString(randomBytes(32))]).toString("base64")}`;

async function user() {
  return prisma.user.create({
    data: {
      name: "Fixture",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
}
async function setup() {
  const owner = await user(),
    other = await user();
  const kb = await prisma.knowledgeBase.create({
    data: {
      ownerId: owner.id,
      name: "Mirror fixture",
      slug: `mirror-${randomUUID().slice(0, 8)}`,
      description: "Mirror fixture description",
      state: "CREATING",
    },
  });
  const base = await writeInitialMainCommit(
    { reposDir, kbId: kb.id, executor },
    { message: "fixture", description: "Fixture description" },
  );
  await prisma.knowledgeBase.update({
    where: { id: kb.id },
    data: { state: "ACTIVE", headSha: base },
  });
  setKbRecoveryComplete(true);
  runtime.ratePort = createMemoryRatePort();
  const configure = (
    patch: Partial<{ url: string; hostKeys: string[]; idempotencyKey: string }> = {},
    principal: Principal = actor(owner.id),
    lookup: DnsLookupFn = publicLookup,
  ) =>
    configureMirror(
      runtime,
      principal,
      {
        kbId: kb.id,
        url: "ssh://git@git.example.com/team/kb.git",
        hostKeys: [hostKey()],
        idempotencyKey: randomUUID(),
        ...patch,
      },
      masterKey,
      { lookup },
    );
  return { owner, other, kbId: kb.id, base, configure };
}
const inAuthority = <T>(run: (query: LockQuery) => Promise<T>) =>
  runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) => lease.transaction(run),
  }) as Promise<T>;
const keyRow = (id: string) => prisma.deployKeyVersion.findUniqueOrThrow({ where: { id } });
async function insertAttempt(
  kbId: string,
  keyId: string,
  remoteVersion: number,
  state: "QUEUED" | "RESERVED",
  userId: string,
  mainSha: string,
) {
  return prisma.mirrorAttempt.create({
    data: {
      id: randomUUID(),
      kbId,
      keyId,
      remoteVersion,
      actorKey: `user:${userId}`,
      actorUserId: userId,
      mainSha,
      state,
    },
  });
}
async function activate(kbId: string, keyId: string) {
  return inAuthority((query) => activateVerifiedDeployKey(query, { kbId, keyId }));
}
function seedB64(ciphertext: string, kbId: string, remoteVersion: number, keyVersion: number) {
  const seed = decryptDeployKey(ciphertext, { kbId, remoteVersion, keyVersion }, master);
  try {
    return seed.use((bytes) => [bytes.toString("base64"), bytes.toString("hex")]);
  } finally {
    seed.destroy();
  }
}

afterEach(async () => {
  await pendingMirrorAction?.catch(() => {});
  pendingMirrorAction = undefined;
  resetMirrorExecutorForTests();
}, 180_000);
afterAll(async () => {
  await redis.close();
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});

let pendingMirrorAction: Promise<void> | undefined;
function mirrorFixtureTest(
  name: string,
  run: (
    fixture: Awaited<ReturnType<typeof setup>>,
    siblings: Awaited<ReturnType<typeof setup>>[],
  ) => Promise<void>,
  count = 1,
): void {
  describe(name, () => {
    const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
    let preparation: Promise<void> | undefined;
    let action: Promise<void> | undefined;
    beforeAll(() => {
      // Real initial Git trees are fixture preparation, separate from the30s
      // mirror operation assertions. Each sibling is owned before its action.
      preparation = (async () => {
        for (let i = 0; i < count; i++) fixtures.push(await setup());
      })();
      return preparation;
    }, 180_000);
    afterAll(async () => {
      await preparation?.catch(() => {});
      await action?.catch(() => {});
    }, 180_000);
    it("preserves the real mirror state and authority assertions", () => {
      action = Promise.resolve().then(() => {
        const [fixture, ...siblings] = fixtures;
        if (!fixture) throw new Error("mirror fixture is not ready");
        return run(fixture, siblings);
      });
      pendingMirrorAction = action;
      return action;
    });
  });
}

describe("mirror configuration with real authority and PostgreSQL", () => {
  mirrorFixtureTest(
    "configure creates a pending key only, with public projections and no private material anywhere but ciphertext",
    async (f, _siblings) => {
      const empty = await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId });
      expect(empty).toMatchObject({ state: "DISCONNECTED", active: null, pending: null });
      const result = await f.configure();
      const status: MirrorStatus = result.mirror;
      expect(status.state).toBe("PENDING");
      expect(status.active).toBeNull();
      expect(status.pending).toMatchObject({
        url: "ssh://git@git.example.com/team/kb.git",
        state: "PENDING",
        publicKey: expect.stringMatching(/^ssh-ed25519 /),
        fingerprint: expect.stringMatching(/^SHA256:/),
      });
      expect(status.pending!.hostKeys[0]).toMatchObject({
        algorithm: "ssh-ed25519",
        fingerprint: expect.stringMatching(/^SHA256:/),
      });
      const row = await keyRow(status.pending!.keyId);
      expect(row.ciphertext).toBeTruthy();
      const secrets = seedB64(row.ciphertext!, f.kbId, row.remoteVersion, row.keyVersion);
      const audits = await prisma.auditEvent.findMany({ where: { kbId: f.kbId } });
      const receipts = await prisma.operationIntent.findMany({ where: { kbId: f.kbId } });
      const surfaces = JSON.stringify([result, status, audits, receipts]);
      for (const secret of secrets) expect(surfaces).not.toContain(secret);
      expect(surfaces).not.toMatch(/PRIVATE KEY|ciphertext/i);
      expect(audits.map((a) => a.action)).toContain("mirror_configure");
    },
    1,
  );

  mirrorFixtureTest(
    "rejects private resolution and bad URLs/host keys before any row changes",
    async (f, _siblings) => {
      await expect(f.configure({}, actor(f.owner.id), privateLookup)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(f.configure({ url: "git@github.com:o/r.git" })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(
        f.configure({ hostKeys: ["SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"] }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(await prisma.deployKeyVersion.count({ where: { kbId: f.kbId } })).toBe(0);
    },
    1,
  );

  mirrorFixtureTest(
    "is manage-only for humans: write sharers, strangers and token principals are refused",
    async (f, _siblings) => {
      await prisma.kbShare.create({
        data: { kbId: f.kbId, userId: f.other.id, bits: ["read", "propose", "write", "review"] },
      });
      await expect(f.configure({}, actor(f.other.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        getMirrorStatus(runtime, actor(f.other.id), { kbId: f.kbId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const stranger = await user();
      await expect(f.configure({}, actor(stranger.id))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const token: Principal = {
        kind: "token",
        userId: f.owner.id,
        grantId: randomUUID(),
        grantGeneration: randomUUID(),
        scopes: ["mcp:write"],
        expiresAt: new Date(Date.now() + 60_000),
        storedAcl: new Map([[f.kbId, ["manage"]]]),
      };
      await expect(f.configure({}, token)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await prisma.deployKeyVersion.count({ where: { kbId: f.kbId } })).toBe(0);
      // A manage share is a legitimate human manager.
      await prisma.kbShare.update({
        where: { kbId_userId: { kbId: f.kbId, userId: f.other.id } },
        data: { bits: ["manage"] },
      });
      await expect(f.configure({}, actor(f.other.id))).resolves.toMatchObject({
        mirror: { state: "PENDING" },
      });
    },
    1,
  );

  mirrorFixtureTest(
    "configure retry with the same idempotency key replays; a changed body mismatches",
    async (f, _siblings) => {
      const key = randomUUID();
      const hostKeys = [hostKey()];
      const first = await f.configure({ idempotencyKey: key, hostKeys });
      const again = await f.configure({ idempotencyKey: key, hostKeys });
      expect(again.operationId).toBe(first.operationId);
      expect(await prisma.deployKeyVersion.count({ where: { kbId: f.kbId } })).toBe(1);
      await expect(
        f.configure({ idempotencyKey: key, hostKeys, url: "ssh://git@git.example.com/o/x.git" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    },
    1,
  );

  mirrorFixtureTest(
    "configure and rotate never replace the active key until verified activation; failed pending leaves active usable",
    async (f, _siblings) => {
      const first = await f.configure();
      const firstKey = first.mirror.pending!.keyId;
      // Activation is a CAS on the exact pending key; the worker verifies first.
      await activate(f.kbId, firstKey);
      const active = await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId });
      expect(active).toMatchObject({ state: "ACTIVE", pending: null });
      expect(active.active!.keyId).toBe(firstKey);
      const versionAfterActivation = active.remoteVersion;

      // Rotation produces a pending key; active untouched and still decryptable.
      const rotated = await rotateMirrorKey(
        runtime,
        actor(f.owner.id),
        {
          kbId: f.kbId,
          idempotencyKey: randomUUID(),
        },
        masterKey,
      );
      expect(rotated.mirror.active!.keyId).toBe(firstKey);
      expect(rotated.mirror.pending!.url).toBe(active.active!.url);
      expect(rotated.mirror.remoteVersion).toBe(versionAfterActivation);
      // Reconfigure to a new URL: still pending; replaces only the previous pending key.
      const reconf = await f.configure({ url: "ssh://git@git.example.com:2222/team/other.git" });
      expect(reconf.mirror.active!.keyId).toBe(firstKey);
      expect(reconf.mirror.active!.url).toBe("ssh://git@git.example.com/team/kb.git");
      expect(reconf.mirror.pending!.url).toBe("ssh://git@git.example.com:2222/team/other.git");
      expect(await keyRow(rotated.mirror.pending!.keyId)).toMatchObject({
        state: "DESTROYED",
        ciphertext: null,
      });
      // A stale pending key id cannot be activated (failed/abandoned pending setup).
      await expect(activate(f.kbId, rotated.mirror.pending!.keyId)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      const still = await keyRow(firstKey);
      expect(still.state).toBe("ACTIVE");
      expect(() =>
        seedB64(still.ciphertext!, f.kbId, still.remoteVersion, still.keyVersion),
      ).not.toThrow();
      // Activating the current pending key switches atomically and bumps remoteVersion.
      await activate(f.kbId, reconf.mirror.pending!.keyId);
      const switched = await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId });
      expect(switched.active!.keyId).toBe(reconf.mirror.pending!.keyId);
      expect(switched.remoteVersion).toBe(versionAfterActivation + 1);
      expect(await keyRow(firstKey)).toMatchObject({ state: "DESTROYED", ciphertext: null });
    },
    1,
  );

  mirrorFixtureTest(
    "stored ciphertext cannot be moved between key rows or remote versions",
    async (f, _siblings) => {
      const a = (await f.configure()).mirror.pending!;
      await activate(f.kbId, a.keyId);
      const b = (
        await rotateMirrorKey(
          runtime,
          actor(f.owner.id),
          {
            kbId: f.kbId,
            idempotencyKey: randomUUID(),
          },
          masterKey,
        )
      ).mirror.pending!;
      const rowA = await keyRow(a.keyId);
      const rowB = await keyRow(b.keyId);
      expect(() =>
        seedB64(rowA.ciphertext!, f.kbId, rowB.remoteVersion, rowB.keyVersion),
      ).toThrow();
      expect(() =>
        seedB64(rowB.ciphertext!, f.kbId, rowA.remoteVersion, rowA.keyVersion),
      ).toThrow();
    },
    1,
  );

  mirrorFixtureTest(
    "old attempts never adopt a newer key, URL or remote version",
    async (f, _siblings) => {
      const a = (await f.configure()).mirror.pending!;
      await activate(f.kbId, a.keyId);
      const v = (await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId })).remoteVersion;
      const current = await insertAttempt(f.kbId, a.keyId, v, "QUEUED", f.owner.id, f.base);
      const stale = await insertAttempt(f.kbId, a.keyId, v, "QUEUED", f.owner.id, f.base);
      expect(await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: current.id }))).toBe(
        true,
      );
      // Replay of a reservation is not a second reservation.
      expect(await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: current.id }))).toBe(
        false,
      );
      const b = (
        await rotateMirrorKey(
          runtime,
          actor(f.owner.id),
          {
            kbId: f.kbId,
            idempotencyKey: randomUUID(),
          },
          masterKey,
        )
      ).mirror.pending!;
      await prisma.mirrorAttempt.update({
        where: { id: current.id },
        data: { state: "COMPLETED" },
      });
      await activate(f.kbId, b.keyId);
      // The queued attempt pinned to the old key/version is cancelled, never re-pointed.
      expect(await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: stale.id }))).toBe(
        false,
      );
      expect(
        await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: stale.id } }),
      ).toMatchObject({ keyId: a.keyId, remoteVersion: v, state: "CANCELLED" });
    },
    1,
  );

  mirrorFixtureTest(
    "disconnect bumps remoteVersion, cancels unreserved attempts, destroys keys and is idempotent",
    async (f, _siblings) => {
      const a = (await f.configure()).mirror.pending!;
      await activate(f.kbId, a.keyId);
      const pending = (await f.configure()).mirror.pending!;
      const before = await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId });
      const queued = await insertAttempt(
        f.kbId,
        a.keyId,
        before.remoteVersion,
        "QUEUED",
        f.owner.id,
        f.base,
      );
      const key = randomUUID();
      const done = await disconnectMirror(runtime, actor(f.owner.id), {
        kbId: f.kbId,
        idempotencyKey: key,
      });
      expect(done.mirror).toMatchObject({
        state: "DISCONNECTED",
        active: null,
        pending: null,
        remoteVersion: before.remoteVersion + 1,
      });
      for (const id of [a.keyId, pending.keyId])
        expect(await keyRow(id)).toMatchObject({ state: "DESTROYED", ciphertext: null });
      expect(
        await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: queued.id } }),
      ).toMatchObject({ state: "CANCELLED" });
      const replay = await disconnectMirror(runtime, actor(f.owner.id), {
        kbId: f.kbId,
        idempotencyKey: key,
      });
      expect(replay.operationId).toBe(done.operationId);
      const again = await disconnectMirror(runtime, actor(f.owner.id), {
        kbId: f.kbId,
        idempotencyKey: randomUUID(),
      });
      expect(again.mirror.remoteVersion).toBe(before.remoteVersion + 1);
      const audits = JSON.stringify(await prisma.auditEvent.findMany({ where: { kbId: f.kbId } }));
      expect(audits).toContain("mirror_disconnect");
      expect(audits).not.toMatch(/PRIVATE KEY/);
    },
    1,
  );

  mirrorFixtureTest(
    "disconnect with a reserved attempt requires the executor drain before destroying keys or succeeding",
    async (f, _siblings) => {
      const a = (await f.configure()).mirror.pending!;
      await activate(f.kbId, a.keyId);
      const v = (await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId })).remoteVersion;
      const reserved = await insertAttempt(f.kbId, a.keyId, v, "RESERVED", f.owner.id, f.base);
      const key = randomUUID();
      // No executor registered: fail closed, retryable; ciphertext retained, no success receipt.
      await expect(
        disconnectMirror(runtime, actor(f.owner.id), { kbId: f.kbId, idempotencyKey: key }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect((await keyRow(a.keyId)).ciphertext).toBeTruthy();
      expect(
        await prisma.operationIntent.count({
          where: { kbId: f.kbId, operation: "MIRROR_DISCONNECT" },
        }),
      ).toBe(0);
      // Remote is already disconnected: no new reservation can use the key meanwhile.
      const late = await insertAttempt(f.kbId, a.keyId, v, "QUEUED", f.owner.id, f.base);
      expect(await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: late.id }))).toBe(false);

      const drain = vi.fn(async (kbId: string, attemptIds: readonly string[]) => {
        expect((await keyRow(a.keyId)).ciphertext).toBeTruthy();
        await prisma.mirrorAttempt.updateMany({
          where: { kbId, id: { in: [...attemptIds] } },
          data: { state: "UNKNOWN", finishedAt: new Date() },
        });
      });
      registerMirrorExecutor({ drain });
      const done = await disconnectMirror(runtime, actor(f.owner.id), {
        kbId: f.kbId,
        idempotencyKey: key,
      });
      expect(drain).toHaveBeenCalledWith(f.kbId, [reserved.id]);
      expect(done.mirror.state).toBe("DISCONNECTED");
      expect(await keyRow(a.keyId)).toMatchObject({ state: "DESTROYED", ciphertext: null });
      // An executor that does not settle the attempt leaves the request failing closed.
      const g = _siblings[0]!;
      const b = (await g.configure()).mirror.pending!;
      await activate(g.kbId, b.keyId);
      const gv = (await getMirrorStatus(runtime, actor(g.owner.id), { kbId: g.kbId }))
        .remoteVersion;
      await insertAttempt(g.kbId, b.keyId, gv, "RESERVED", g.owner.id, g.base);
      registerMirrorExecutor({ drain: async () => {} });
      await expect(
        disconnectMirror(runtime, actor(g.owner.id), {
          kbId: g.kbId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect((await keyRow(b.keyId)).ciphertext).toBeTruthy();
    },
    2,
  );

  mirrorFixtureTest(
    "transfer registers the same teardown",
    async (f, _siblings) => {
      const a = (await f.configure()).mirror.pending!;
      await activate(f.kbId, a.keyId);
      const before = await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId });
      expect(listTransferLifecycleHandlersForTests()).toContain(teardownMirror);
      const handler = listTransferLifecycleHandlersForTests().find((h) => h === teardownMirror)!;
      await inAuthority((query) =>
        handler({ query, kbId: f.kbId, fromUserId: f.owner.id, toUserId: f.other.id }),
      );
      const after = await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId });
      expect(after).toMatchObject({ state: "DISCONNECTED", active: null, pending: null });
      expect(after.remoteVersion).toBe(before.remoteVersion + 1);
      expect(await keyRow(a.keyId)).toMatchObject({ state: "DESTROYED", ciphertext: null });
    },
    1,
  );

  describe.each(["delete", "account-removal"])(
    "%s tombstone disconnects the mirror and destroys key ciphertext",
    (path) => {
      mirrorFixtureTest(
        "%s tombstone disconnects the mirror and destroys key ciphertext",
        async (f, _siblings) => {
          const a = (await f.configure()).mirror.pending!;
          await activate(f.kbId, a.keyId);
          const pending = (await f.configure()).mirror.pending!;
          if (path === "delete")
            await deleteKnowledgeBase(runtime, f.owner.id, {
              kbId: f.kbId,
              metadataVersion: 1,
              idempotencyKey: randomUUID(),
              confirm: "DELETE",
            });
          else {
            const admin = await user();
            await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });
            await runWithAllowedAccountDeletion("admin-force", () =>
              removeUserAccount(runtime, f.owner.id, { actingUserId: admin.id }),
            );
          }
          const remote = await prisma.kbRemote.findUniqueOrThrow({ where: { kbId: f.kbId } });
          expect(remote).toMatchObject({
            state: "DISCONNECTED",
            activeKeyId: null,
            pendingKeyId: null,
          });
          for (const id of [a.keyId, pending.keyId])
            expect(await keyRow(id)).toMatchObject({ state: "DESTROYED", ciphertext: null });
        },
        1,
      );
    },
  );
});

// Test-first acceptance probes. Actual Postgres owns authority; actual
// OpenSSH/git-receive-pack owns all remote effects (no spawn/network mocks).
describe("mirror execution against real SSH", () => {
  async function recoveryGroup(attemptId: string, root: string) {
    const tracked = spawnProcessGroup(
      process.execPath,
      ["-e", "console.log('READY'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await once(tracked.child.stdout!, "data");
    const raw = readFileSync(`/proc/${tracked.pid}/stat`, "utf8");
    const identity = raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]!;
    const dir = join(root, `${attemptId}-fault`);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "owner"), "2147483647 1", { mode: 0o600 });
    await writeFile(join(dir, "group"), `${tracked.pid} ${identity}`, { mode: 0o600 });
    await writeFile(join(dir, "key"), "disposable fixture", { mode: 0o600 });
    return { tracked, dir, identity };
  }

  for (const consumer of ["startup", "redelivery"])
    for (const name of ["owner", "group"])
      for (const fault of ["unreadable", "malformed"])
        mirrorFixtureTest(
          `F1 ${consumer} preserves RESERVED, ciphertext and ${fault} ${name} evidence`,
          async (f) => {
            const root = mkdtempSync("/dev/shm/mirror-fault-");
            let group: Awaited<ReturnType<typeof recoveryGroup>> | undefined;
            try {
              const key = (await f.configure()).mirror.pending!;
              await activate(f.kbId, key.keyId);
              const push = await queueMirrorAttempt(
                runtime,
                actor(f.owner.id),
                { kbId: f.kbId, idempotencyKey: randomUUID() },
                "PUSH",
              );
              await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: push.attemptId }));
              await inAuthority((query) => teardownMirror({ query, kbId: f.kbId }));
              group = await recoveryGroup(push.attemptId, root);
              const marker = join(group.dir, name);
              const original = await readFile(marker, "utf8");
              if (fault === "unreadable") await chmod(marker, 0);
              else await writeFile(marker, "invalid ownership");
              if (consumer === "redelivery")
                await prisma.durableJob.update({
                  where: { id: push.attemptId },
                  data: { state: "PUBLISHED", leaseUntil: null },
                });
              const deliver = () =>
                runMirrorDelivery(prisma, {
                  durableJobId: push.attemptId,
                  workerId: `fault:${randomUUID()}`,
                  connectionString: db.urls.runtime,
                  reposDir,
                  masterKey,
                  scratchRoot: root,
                  transport: async () => {
                    throw new Error("Recovery must deny new dispatch");
                  },
                });
              await expect(
                consumer === "startup"
                  ? recoverMirrorReservations(prisma, db.urls.runtime, root)
                  : deliver(),
              ).rejects.toBeInstanceOf(MirrorDrainError);
              expect(group.tracked.child.exitCode).toBeNull();
              expect(await readdir(group.dir)).toEqual(
                expect.arrayContaining(["owner", "group", "key"]),
              );
              expect(await keyRow(key.keyId)).toMatchObject({ state: "RETIRED" });
              expect((await keyRow(key.keyId)).ciphertext).toBeTruthy();
              expect(
                (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } }))
                  .state,
              ).toBe("RESERVED");
              if (consumer === "startup" && name === "owner") {
                const idempotencyKey = randomUUID();
                await expect(
                  disconnectMirror(runtime, actor(f.owner.id), { kbId: f.kbId, idempotencyKey }),
                ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
                expect(
                  await prisma.operationIntent.count({ where: { kbId: f.kbId, idempotencyKey } }),
                ).toBe(0);
              }
              await chmod(marker, 0o600);
              await writeFile(marker, original);
              await recoverMirrorReservations(prisma, db.urls.runtime, root);
              await group.tracked.done;
              expect(await readdir(root)).toEqual([]);
              expect(await keyRow(key.keyId)).toMatchObject({
                state: "DESTROYED",
                ciphertext: null,
              });
              expect(
                (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } }))
                  .state,
              ).toBe("UNKNOWN");
              await recoverMirrorReservations(prisma, db.urls.runtime, root);
              await disconnectMirror(runtime, actor(f.owner.id), {
                kbId: f.kbId,
                idempotencyKey: randomUUID(),
              });
            } finally {
              if (group) await reapProcessTree(group.tracked, "SIGKILL");
              rmSync(root, { recursive: true, force: true });
            }
          },
        );

  mirrorFixtureTest(
    "F1 generic post-dispatch cleanup failure cannot reuse pre-dispatch drain permission",
    async (f) => {
      const root = mkdtempSync("/dev/shm/mirror-fault-");
      let group: Awaited<ReturnType<typeof recoveryGroup>> | undefined;
      let faultInjected = false;
      try {
        const key = (await f.configure()).mirror.pending!;
        await activate(f.kbId, key.keyId);
        const push = await queueMirrorAttempt(
          runtime,
          actor(f.owner.id),
          { kbId: f.kbId, idempotencyKey: randomUUID() },
          "PUSH",
        );
        await prisma.durableJob.update({
          where: { id: push.attemptId },
          data: { state: "PUBLISHED", leaseUntil: null },
        });
        await expect(
          runMirrorDelivery(prisma, {
            durableJobId: push.attemptId,
            workerId: `fault:${randomUUID()}`,
            connectionString: db.urls.runtime,
            reposDir,
            masterKey,
            scratchRoot: root,
            transport: async (input) => {
              group = await recoveryGroup(input.attemptId, root);
              await chmod(root, 0);
              faultInjected = true;
              throw new Error("Generic transport-finally filesystem failure");
            },
          }),
        ).rejects.toBeInstanceOf(MirrorDrainError);
        expect(faultInjected).toBe(true);
        await chmod(root, 0o700);
        // The failed execution releases its KB lease before authority teardown.
        await inAuthority((query) => teardownMirror({ query, kbId: f.kbId }));
        expect(group!.tracked.child.exitCode).toBeNull();
        expect((await keyRow(key.keyId)).ciphertext).toBeTruthy();
        expect(
          (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
        ).toBe("RESERVED");
        const idempotencyKey = randomUUID();
        await expect(
          disconnectMirror(runtime, actor(f.owner.id), { kbId: f.kbId, idempotencyKey }),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        expect(
          await prisma.operationIntent.count({ where: { kbId: f.kbId, idempotencyKey } }),
        ).toBe(0);
        await recoverMirrorReservations(prisma, db.urls.runtime, root);
        await group!.tracked.done;
        expect(await readdir(root)).toEqual([]);
        expect(await keyRow(key.keyId)).toMatchObject({ state: "DESTROYED", ciphertext: null });
      } finally {
        await chmod(root, 0o700);
        if (group) await reapProcessTree(group.tracked, "SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  mirrorFixtureTest(
    "failed live ownership observation retains RESERVED, ciphertext and no disconnect receipt until recovery",
    async (f) => {
      const root = mkdtempSync("/dev/shm/mirror-observation-");
      const key = (await f.configure()).mirror.pending!;
      await activate(f.kbId, key.keyId);
      const push = await queueMirrorAttempt(
        runtime,
        actor(f.owner.id),
        { kbId: f.kbId, idempotencyKey: randomUUID() },
        "PUSH",
      );
      await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: push.attemptId }));
      const dir = join(root, `${push.attemptId}-live`);
      mkdirSync(dir, { mode: 0o700 });
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const done = once(child, "close");
      await once(child.stdout, "data");
      const marker = `${child.pid} ${await processIdentity(child.pid!)}`;
      writeFileSync(join(dir, "owner"), marker, { mode: 0o600 });
      writeFileSync(join(dir, "group"), marker, { mode: 0o600 });
      chmodSync(join(dir, "owner"), 0);
      const input = { kbId: f.kbId, idempotencyKey: randomUUID() };
      try {
        await expect(recoverMirrorReservations(prisma, db.urls.runtime, root)).rejects.toThrow(
          "drain",
        );
        expect(await processIdentity(child.pid!)).not.toBeNull();
        await expect(disconnectMirror(runtime, actor(f.owner.id), input)).rejects.toMatchObject({
          code: "STORAGE_UNAVAILABLE",
        });
        expect(await keyRow(key.keyId)).toMatchObject({ state: "RETIRED" });
        expect((await keyRow(key.keyId)).ciphertext).toBeTruthy();
        expect(
          (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
        ).toBe("RESERVED");
        expect(
          await prisma.operationIntent.count({
            where: { kbId: f.kbId, idempotencyKey: input.idempotencyKey },
          }),
        ).toBe(0);
        expect(existsSync(dir)).toBe(true);
        chmodSync(join(dir, "owner"), 0o600);
        await recoverMirrorReservations(prisma, db.urls.runtime, root);
        expect(await processIdentity(child.pid!)).toBeNull();
        expect(await keyRow(key.keyId)).toMatchObject({ state: "DESTROYED", ciphertext: null });
        expect(await disconnectMirror(runtime, actor(f.owner.id), input)).toMatchObject({
          mirror: { state: "DISCONNECTED" },
        });
        await recoverMirrorReservations(prisma, db.urls.runtime, root);
      } finally {
        if (await processIdentity(child.pid!)) process.kill(-child.pid!, "SIGKILL");
        await done;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  mirrorFixtureTest(
    "explicit enqueue pins once, rejects the default disconnected case and never auto-enqueues",
    async (f, _siblings) => {
      const input = { kbId: f.kbId, idempotencyKey: randomUUID() };
      expect(await prisma.mirrorAttempt.count({ where: { kbId: f.kbId } })).toBe(0);
      await expect(
        queueMirrorAttempt(runtime, actor(f.owner.id), input, "PUSH"),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const key = (await f.configure()).mirror.pending!;
      await activate(f.kbId, key.keyId);
      const first = await queueMirrorAttempt(runtime, actor(f.owner.id), input, "PUSH");
      expect(await queueMirrorAttempt(runtime, actor(f.owner.id), input, "PUSH")).toEqual(first);
      expect(
        await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: first.attemptId } }),
      ).toMatchObject({
        keyId: key.keyId,
        remoteVersion: key.remoteVersion,
        mainSha: f.base,
        actorUserId: f.owner.id,
        state: "QUEUED",
      });
      expect(
        await prisma.durableJob.count({ where: { id: first.attemptId, kind: "PUSH_MIRROR" } }),
      ).toBe(1);
    },
    1,
  );
  mirrorFixtureTest(
    "startup drains retired keys even when the job has exhausted its retry budget",
    async (f, _siblings) => {
      const root = mkdtempSync("/dev/shm/mirror-recovery-");
      try {
        const key = (await f.configure()).mirror.pending!;
        await activate(f.kbId, key.keyId);
        const push = await queueMirrorAttempt(
          runtime,
          actor(f.owner.id),
          { kbId: f.kbId, idempotencyKey: randomUUID() },
          "PUSH",
        );
        await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: push.attemptId }));
        await inAuthority((query) => teardownMirror({ query, kbId: f.kbId }));
        await prisma.durableJob.update({
          where: { id: push.attemptId },
          data: { state: "FAILED", attemptCount: 6 },
        });
        await recoverMirrorReservations(prisma, db.urls.runtime, root);
        expect(await keyRow(key.keyId)).toMatchObject({ ciphertext: null, state: "DESTROYED" });
        expect(
          (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
        ).toBe("UNKNOWN");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    1,
  );

  async function networkSetup() {
    const f = await setup();
    requireBuiltArtifact(
      resolve(import.meta.dirname, "../../../../apps/worker/dist/ssh-wrapper.mjs"),
      "pnpm test:kb --build-only mirror",
      false,
    );
    const ssh = await createSshFixture();
    try {
      const configured = await f.configure({ url: ssh.url, hostKeys: [ssh.hostKey] });
      await ssh.authorize([configured.mirror.pending!.publicKey]);
      const request = (
        action: "PUSH" | "ACTIVATE",
        principal = actor(f.owner.id),
        idempotencyKey = randomUUID(),
      ) => queueMirrorAttempt(runtime, principal, { kbId: f.kbId, idempotencyKey }, action);
      const consume = (
        attemptId: string,
        timeoutMs = 10_000,
        signal?: AbortSignal,
        transport?: (input: NetworkInput) => Promise<NetworkResult>,
      ) =>
        runMirrorDelivery(prisma, {
          durableJobId: attemptId,
          workerId: `test:${randomUUID()}`,
          connectionString: db.urls.runtime,
          reposDir,
          masterKey,
          scratchRoot: ssh.options.root,
          transport:
            transport ??
            ((input) =>
              runMirrorSsh(
                {
                  ...input,
                  signal: signal ? AbortSignal.any([input.signal, signal]) : input.signal,
                },
                { ...ssh.options, timeoutMs },
              )),
        });
      const deliver = async (attemptId: string, timeoutMs = 10_000, signal?: AbortSignal) => {
        await prisma.durableJob.update({
          where: { id: attemptId },
          data: { state: "PUBLISHED", leaseUntil: null },
        });
        return consume(attemptId, timeoutMs, signal);
      };
      const activated = await request("ACTIVATE");
      await deliver(activated.attemptId);
      expect(
        (await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId })).active?.keyId,
      ).toBe(configured.mirror.pending!.keyId);
      return {
        ...f,
        ssh,
        request,
        deliver,
        consume,
        keyId: configured.mirror.pending!.keyId,
        repo: kbBareRepoPath(reposDir, f.kbId),
      };
    } catch (error) {
      await ssh.close();
      throw error;
    }
  }
  describe("network actions with an activated fixture", () => {
    let network: Awaited<ReturnType<typeof networkSetup>> | undefined;
    let pendingSetup: ReturnType<typeof networkSetup> | undefined;
    beforeEach(async () => {
      // Retain ownership before awaiting: a hook timeout does not cancel setup.
      pendingSetup = networkSetup();
      network = await pendingSetup;
    });
    async function closeNetwork() {
      // Failed setup closes its acquired SSH fixture in networkSetup's catch.
      // Late success must settle before SSH, then file-level DB/repos teardown.
      const acquired = await pendingSetup?.catch(() => undefined);
      await acquired?.ssh.close();
      network = undefined;
      pendingSetup = undefined;
    }
    afterEach(closeNetwork, 180_000);
    afterAll(closeNetwork, 180_000);

    it("joins late setup before reclaiming the exact SSH container and private root", async () => {
      const acquired = network!;
      const root = dirname(acquired.ssh.options.root);
      const name = acquired.ssh.name;
      expect(
        execFileSync("docker", ["inspect", "--format", "{{.State.Running}}", name], {
          encoding: "utf8",
          timeout: 20_000,
        }).trim(),
      ).toBe("true");
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      pendingSetup = ready.then(() => acquired);
      network = undefined;
      let closed = false;
      const closing = closeNetwork().then(() => {
        closed = true;
      });
      try {
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(existsSync(root)).toBe(true);
      } finally {
        release();
        await closing;
      }
      expect(existsSync(root)).toBe(false);
      const remaining = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
        encoding: "utf8",
        timeout: 20_000,
      })
        .trim()
        .split("\n");
      expect(remaining).not.toContain(name);
    });

    it("activates with ls-remote/dry-run, accepts FF, and preserves canonical bytes", async () => {
      const f = network!;
      expect(await f.ssh.mainSha()).toBeNull(); // activation is dry-run
      const before = snapshotRepo(f.repo);
      const push = await f.request("PUSH");
      await f.deliver(push.attemptId);
      expect(await f.ssh.mainSha()).toBe(f.base);
      expect(
        (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
      ).toBe("COMPLETED");
      expect(snapshotRepo(f.repo)).toEqual(before);
      expect(await f.ssh.keysRemaining()).toEqual([]);
      await f.ssh.assertReadonly(f.repo);
    }, 60_000);
    it("rejects divergence without changing canonical bytes", async () => {
      const f = network!;
      const before = snapshotRepo(f.repo);
      const push = await f.request("PUSH");
      await f.deliver(push.attemptId);
      await f.ssh.diverge();
      const diverged = await f.request("PUSH");
      await f.deliver(diverged.attemptId);
      expect(
        (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: diverged.attemptId } })).state,
      ).toBe("FAILED");
      expect(snapshotRepo(f.repo)).toEqual(before);
      expect(await f.ssh.keysRemaining()).toEqual([]);
    }, 60_000);
    it("rejects a wrong host key without replacing the active key or canonical bytes", async () => {
      const f = network!;
      const before = snapshotRepo(f.repo);
      const bad = await f.configure({ url: f.ssh.url, hostKeys: [hostKey()] });
      await f.ssh.authorize([bad.mirror.pending!.publicKey]);
      const activation = await f.request("ACTIVATE");
      await f.deliver(activation.attemptId);
      expect(
        (await getMirrorStatus(runtime, actor(f.owner.id), { kbId: f.kbId })).active?.keyId,
      ).toBe(f.keyId);
      expect(snapshotRepo(f.repo)).toEqual(before);
      expect(await f.ssh.keysRemaining()).toEqual([]);
      await f.ssh.assertReadonly(f.repo); // actual kernel mount, not a spawn assertion
    }, 60_000);

    it.each(["rotation", "revocation", "share-loss", "head-change"])(
      "queued pin survives %s without borrowing a new destination or key",
      async (race) => {
        const f = network!;
        await prisma.kbShare.create({
          data: { kbId: f.kbId, userId: f.other.id, bits: ["manage"] },
        });
        const queued = await f.request("PUSH", actor(f.other.id));
        if (race === "rotation") {
          const pending = (
            await rotateMirrorKey(
              runtime,
              actor(f.owner.id),
              { kbId: f.kbId, idempotencyKey: randomUUID() },
              masterKey,
            )
          ).mirror.pending!;
          await f.ssh.authorize([pending.publicKey]);
          const activation = await f.request("ACTIVATE");
          await f.deliver(activation.attemptId);
          expect((await keyRow(f.keyId)).ciphertext).toBeNull();
        } else if (race === "revocation") {
          await disconnectMirror(runtime, actor(f.owner.id), {
            kbId: f.kbId,
            idempotencyKey: randomUUID(),
          });
        } else if (race === "share-loss") {
          await prisma.kbShare.delete({
            where: { kbId_userId: { kbId: f.kbId, userId: f.other.id } },
          });
        } else {
          await prisma.knowledgeBase.update({
            where: { id: f.kbId },
            data: { headSha: "f".repeat(40) },
          });
        }
        const count = await f.ssh.pushCount();
        await f.deliver(queued.attemptId);
        expect(await f.ssh.pushCount()).toBe(count);
        expect(await f.ssh.mainSha()).toBeNull();
        expect(
          await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: queued.attemptId } }),
        ).toMatchObject({ keyId: f.keyId, mainSha: f.base, state: "CANCELLED" });
      },
      60_000,
    );

    it("disconnect during connection drains the group and removes the tmpfs key before success", async () => {
      const f = network!;
      await f.ssh.mode("pause");
      const push = await f.request("PUSH");
      const stop = new AbortController();
      const running = f.deliver(push.attemptId, undefined, stop.signal);
      try {
        await Promise.race([
          f.ssh.waitConnected(stop.signal),
          running.then(() => {
            throw new Error("Push ended before SSH connection");
          }),
        ]);
        await disconnectMirror(runtime, actor(f.owner.id), {
          kbId: f.kbId,
          idempotencyKey: randomUUID(),
        });
      } finally {
        stop.abort();
        await running;
      }
      expect(await f.ssh.keysRemaining()).toEqual([]);
      expect((await keyRow(f.keyId)).ciphertext).toBeNull();
      expect(
        (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
      ).toBe("UNKNOWN");
    }, 60_000);

    it("production transfer acceptance with an active SSH reservation retires and drains the former owner's key", async () => {
      const f = network!;
      await prisma.kbShare.create({ data: { kbId: f.kbId, userId: f.other.id, bits: ["read"] } });
      const transfer = await transferRequest(runtime, f.owner.id, {
        kbId: f.kbId,
        recipientUserId: f.other.id,
        metadataVersion: 1,
        idempotencyKey: randomUUID(),
      });
      await f.ssh.mode("pause");
      const push = await f.request("PUSH");
      const controller = new AbortController();
      const running = f.deliver(push.attemptId, undefined, controller.signal);
      let accepting: ReturnType<typeof transferAccept> | undefined;
      try {
        await f.ssh.waitConnected(AbortSignal.timeout(20_000));
        expect(
          (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
        ).toBe("RESERVED");
        accepting = transferAccept(runtime, f.other.id, transfer);
        // Acceptance waits for the execution KB lease. Ending the actual SSH
        // execution releases it before the authority transaction can retire keys.
        controller.abort();
        await running;
        expect(await accepting).toMatchObject({ ownerId: f.other.id });
        expect(await f.ssh.keysRemaining()).toEqual([]);
        expect(await keyRow(f.keyId)).toMatchObject({ state: "DESTROYED", ciphertext: null });
        expect(await getMirrorStatus(runtime, actor(f.other.id), { kbId: f.kbId })).toMatchObject({
          state: "DISCONNECTED",
          active: null,
        });
      } finally {
        controller.abort();
        await running;
        await accepting;
      }
    }, 60_000);

    it("lost reply after remote acceptance reconciles SHA on retry with one logical audit receipt", async () => {
      const f = network!;
      const before = snapshotRepo(f.repo);
      await f.ssh.mode("lost-reply");
      const push = await f.request("PUSH");
      const cancelled = new AbortController();
      const delivery = f.deliver(push.attemptId, 10_000, cancelled.signal);
      try {
        // Inject reply loss only after the real receive-pack committed. A short
        // wall-clock budget can otherwise expire before acceptance on busy CI.
        await f.ssh.waitAccepted();
      } finally {
        cancelled.abort();
        await delivery;
      }
      expect(await f.ssh.mainSha()).toBe(f.base);
      expect(
        (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
      ).toBe("UNKNOWN");
      const count = await f.ssh.pushCount();
      await f.ssh.mode("normal");
      await f.deliver(push.attemptId);
      expect(await f.ssh.pushCount()).toBe(count);
      expect(
        (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
      ).toBe("COMPLETED");
      expect(
        await prisma.auditEvent.count({
          where: { opId: push.attemptId, action: "mirror_attempt" },
        }),
      ).toBe(1);
      expect(snapshotRepo(f.repo)).toEqual(before);
    }, 60_000);

    it("server EOF after acceptance persists UNKNOWN and production dispatch retries reconcile without another push", async () => {
      const f = network!;
      const before = snapshotRepo(f.repo);
      const push = await f.request("PUSH");
      await f.ssh.mode("accepted-eof");
      const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
      const queueName = queueNameForDurableKind("PUSH_MIRROR");
      const prefix = redis.key(`eof-${randomUUID()}`);
      const queue = new Queue(queueName, { connection, prefix });
      const worker = new Worker(queueName, (job) => f.consume(job.data.durableJobId), {
        connection,
        prefix,
        autorun: false,
        concurrency: 1,
      });
      const dispatch = () =>
        runDurableDispatcherCycle({
          db: prisma,
          ownerId: `eof:${randomUUID()}`,
          now: () => new Date(),
          getQueue: () => queue,
          hooks: {
            beforePublish: (id) => {
              if (id !== push.attemptId) throw new Error("Other fixture job");
            },
          },
        });
      let running: Promise<void> | undefined;
      try {
        await worker.waitUntilReady();
        await dispatch(); // actual PENDING -> PUBLISHED, before worker admission
        const first = once(worker, "completed", { signal: AbortSignal.timeout(20_000) });
        running = worker.run();
        await first;
        await worker.pause();
        expect(await f.ssh.mainSha()).toBe(f.base);
        expect(
          await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } }),
        ).toMatchObject({ state: "UNKNOWN", resultCode: "REMOTE_OUTCOME_UNKNOWN" });
        const retry = await prisma.durableJob.findUniqueOrThrow({ where: { id: push.attemptId } });
        expect(retry).toMatchObject({ state: "RETRY", attemptCount: 1, attemptEpoch: 2 });
        expect(await f.ssh.keysRemaining()).toEqual([]);
        const count = await f.ssh.pushCount();
        await f.ssh.mode("normal");
        await f.ssh.authorize([]); // the next advertisement fails after earlier acceptance
        // Retain the normal dispatcher clock/backoff and the completed Redis
        // delivery. No manual durable-state or nextRunAt rewrite on retry.
        await new Promise((r) =>
          setTimeout(r, Math.max(0, retry.nextRunAt.getTime() - Date.now()) + 10),
        );
        await dispatch();
        const second = once(worker, "completed", { signal: AbortSignal.timeout(20_000) });
        worker.resume();
        await second;
        await worker.pause();
        expect(
          await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } }),
        ).toMatchObject({ state: "UNKNOWN", resultCode: "REMOTE_OUTCOME_UNKNOWN" });
        const unavailable = await prisma.durableJob.findUniqueOrThrow({
          where: { id: push.attemptId },
        });
        expect(unavailable).toMatchObject({ state: "RETRY", attemptCount: 2, attemptEpoch: 3 });
        expect(await f.ssh.pushCount()).toBe(count);
        await f.ssh.authorize([(await keyRow(f.keyId)).publicKey]);
        await new Promise((r) =>
          setTimeout(r, Math.max(0, unavailable.nextRunAt.getTime() - Date.now()) + 10),
        );
        await dispatch();
        const third = once(worker, "completed", { signal: AbortSignal.timeout(20_000) });
        worker.resume();
        await third;
        expect(
          await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } }),
        ).toMatchObject({ state: "COMPLETED", resultCode: "RECONCILED" });
        expect(
          (await prisma.durableJob.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
        ).toBe("COMPLETE");
        expect(await f.ssh.pushCount()).toBe(count);
        expect(
          await prisma.auditEvent.count({
            where: { opId: push.attemptId, action: "mirror_attempt" },
          }),
        ).toBe(1);
        expect(snapshotRepo(f.repo)).toEqual(before);
      } finally {
        await worker.close();
        await running;
        await queue.obliterate({ force: true });
        await queue.close();
        connection.disconnect();
      }
    }, 60_000);

    it("fresh post-dispatch cleanup failure cannot reuse preparation's drain acknowledgement", async () => {
      const f = network!;
      const push = await f.request("PUSH");
      await prisma.durableJob.update({
        where: { id: push.attemptId },
        data: { state: "PUBLISHED" },
      });
      const dir = join(f.ssh.options.root, `${push.attemptId}-fault`);
      await expect(
        f.consume(push.attemptId, undefined, undefined, async () => {
          mkdirSync(dir, { mode: 0o700 });
          writeFileSync(join(dir, "owner"), "malformed");
          throw new Error("Ordinary post-dispatch cleanup failure");
        }),
      ).rejects.toThrow("drain");
      expect(
        (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
      ).toBe("RESERVED");
      await inAuthority((q) => teardownMirror({ query: q, kbId: f.kbId }));
      expect((await keyRow(f.keyId)).ciphertext).toBeTruthy();
      // Restored confirmed-absence observation lets the next recovery settle.
      rmSync(join(dir, "owner"));
      await recoverMirrorReservations(prisma, db.urls.runtime, f.ssh.options.root);
      expect(await keyRow(f.keyId)).toMatchObject({ state: "DESTROYED", ciphertext: null });
    }, 60_000);

    it("restart recovery drains a persisted reservation, reconciles it, and destroys retired ciphertext", async () => {
      const f = network!;
      const push = await f.request("PUSH");
      await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: push.attemptId }));
      const key = await keyRow(f.keyId);
      await f.ssh.mode("pause");
      const crash = await f.ssh.startCrashablePush({
        attemptId: push.attemptId,
        canonicalRepo: f.repo,
        sha: f.base,
        seed: seedB64(key.ciphertext!, f.kbId, key.remoteVersion, key.keyVersion)[0]!,
      });
      try {
        await f.ssh.waitConnected(AbortSignal.timeout(20_000));
        expect((await f.ssh.keysRemaining()).length).toBe(1);
      } finally {
        await crash();
      }
      await inAuthority((query) => teardownMirror({ query, kbId: f.kbId }));
      await f.deliver(push.attemptId);
      expect((await keyRow(f.keyId)).ciphertext).toBeNull();
      expect(
        (await prisma.mirrorAttempt.findUniqueOrThrow({ where: { id: push.attemptId } })).state,
      ).toBe("UNKNOWN");
    }, 60_000);
  });

  mirrorFixtureTest(
    "claim then tombstone then finish destroys the reserved retired key (carry-in 42)",
    async (f, _siblings) => {
      const key = (await f.configure()).mirror.pending!;
      await activate(f.kbId, key.keyId);
      const attempt = await insertAttempt(
        f.kbId,
        key.keyId,
        key.remoteVersion,
        "QUEUED",
        f.owner.id,
        f.base,
      );
      expect(await inAuthority((q) => reserveMirrorAttempt(q, { attemptId: attempt.id }))).toBe(
        true,
      );
      await deleteKnowledgeBase(runtime, f.owner.id, {
        kbId: f.kbId,
        metadataVersion: 1,
        confirm: "DELETE",
        idempotencyKey: randomUUID(),
      });
      expect((await keyRow(key.keyId)).ciphertext).toBeTruthy();
      await inAuthority((q) =>
        finishMirrorAttempt(q, {
          attemptId: attempt.id,
          state: "UNKNOWN",
          resultCode: "CANCELLED",
        }),
      );
      expect(await keyRow(key.keyId)).toMatchObject({ state: "DESTROYED", ciphertext: null });
    },
    1,
  );
});
