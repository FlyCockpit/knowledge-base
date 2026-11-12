// @ts-nocheck — PG integration harness.
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

vi.mock("@knowledge-base/env/server", () => ({
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  env: {
    NODE_ENV: "test",
    KB_MASTER_KEY: new Secret(Buffer.from("a".repeat(32)).toString("base64")),
  },
}));

vi.mock("../../../../apps/server/src/kb-process.js", async (importOriginal) => ({
  ...(await importOriginal()),
  assertProcessFence() {},
}));

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeUserAccount } from "@knowledge-base/api/lib/kb/account-removal";
import { remoteSealedNamespace } from "@knowledge-base/api/lib/kb/attachment";
import { createKnowledgeBase } from "@knowledge-base/api/lib/kb/bases";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runKbEmailDelivery } from "@knowledge-base/api/lib/kb/kb-email";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import { getOperationLease } from "@knowledge-base/api/lib/kb/lock";
import {
  authorize,
  expandBits,
  prismaAuthorityStore,
} from "@knowledge-base/api/lib/kb/permissions";
import {
  runStartupJournalRecovery,
  setKbRecoveryComplete,
} from "@knowledge-base/api/lib/kb/recovery";
import { configureKbRuntime } from "@knowledge-base/api/lib/kb/runtime";
import { enrollSealedRecord } from "@knowledge-base/api/lib/kb/sealed-records";
import {
  shareAccept,
  shareInvite,
  shareList,
  shareRevoke,
  shareSetSealedValues,
  shareUpdate,
} from "@knowledge-base/api/lib/kb/shares";
import { transferAccept, transferRequest } from "@knowledge-base/api/lib/kb/transfer";
import {
  assertOrdinaryAccountDeletionAllowed,
  runWithAllowedAccountDeletion,
} from "@knowledge-base/auth/account-deletion-policy";
import { createBootstrapDatabaseAdapter } from "@knowledge-base/auth/bootstrap";
import {
  AUTHORITY_LOCK_CLASSID,
  AUTHORITY_LOCK_OBJID,
  lockIdentityAuthority,
} from "@knowledge-base/db/authority-lock";
import { afterAll, describe, expect, it } from "vitest";
import { createKbWriteCoordinator } from "../../../../apps/server/src/kb-write-coordinator.js";
import { openKbPostgresClusterFromEnv } from "./index.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
// Exercise the real plugins installed in the auth workspace.
const authRequire = createRequire(resolve(ROOT, "packages/auth/package.json"));
const { admin, twoFactor } = await import(authRequire.resolve("better-auth/plugins"));

const cluster = await openKbPostgresClusterFromEnv();
const database = await cluster.createDatabase();
const prisma = database.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-members-repos-"));
const children = new Map<number, Promise<{ opId: string; pid: number; status: number }>>();
const coordinator = createKbWriteCoordinator({
  connectionString: database.urls.runtime,
  closeAdmission: async () => {},
  async spawn(req) {
    const child = spawn(req.argv[0], req.argv.slice(1), {
      cwd: req.cwd,
      env: req.env,
      stdio: "ignore",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const exit = new Promise<{ opId: string; pid: number; status: number }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status) =>
        resolve({ opId: req.opId, pid: child.pid!, status: status ?? -1 }),
      );
    });
    children.set(child.pid!, exit);
    return { pid: child.pid! };
  },
  // The coordinator waits by (opId, pid); an unknown child is a harness bug.
  wait: async (_opId, pid) => {
    const exit = children.get(pid);
    if (!exit) throw new Error(`unknown supervised child ${pid}`);
    return exit;
  },
});

database.applyPrismaSchema();

const localGitExecutor = {
  exec({ cwd, argv, env }) {
    execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
  },
};

const runtimeAssetsDir = mkdtempSync(join(tmpdir(), "kb-members-assets-"));
const runtime = {
  prisma,
  connectionString: database.urls.runtime,
  reposDir,
  assetsDir: runtimeAssetsDir,
  blobStore: createDiskBlobStore(runtimeAssetsDir),
  canonicalOrigin: "https://kb.example.com",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  coordinator,
  createGitExecutor: () => localGitExecutor,
};
configureKbRuntime(runtime);
setKbRecoveryComplete(true);

process.env.KB_MASTER_KEY = randomBytes(32).toString("base64");
/** The share-invite email envelope key (the router passes env.KB_MASTER_KEY). */
const MEMBERS_MASTER_KEY = Buffer.from("a".repeat(32)).toString("base64");

afterAll(async () => {
  await prisma.$disconnect();
  await database.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
});

async function user(label: string) {
  return prisma.user.create({
    data: {
      name: label,
      email: `${label}-${crypto.randomUUID()}@example.invalid`,
      emailVerified: true,
    },
  });
}

const identityWriters = [
  {
    name: "ORM role demotion",
    error: "FORBIDDEN",
    write: (id) =>
      prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.user.update({ where: { id }, data: { role: "user" } });
      }),
  },
  {
    name: "ORM ban",
    error: "UNAUTHORIZED",
    write: (id) =>
      prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.user.update({ where: { id }, data: { banned: true } });
      }),
  },
  {
    name: "forced-2FA policy",
    error: "UNAUTHORIZED",
    write: () =>
      prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.appSetting.upsert({
          where: { key: "force2faInternalUsers" },
          create: { key: "force2faInternalUsers", value: "true" },
          update: { value: "true" },
        });
      }),
  },
  ...[
    { name: "Better Auth role", update: { role: "user" }, error: "FORBIDDEN" },
    {
      name: "Better Auth ban",
      update: { banned: true },
      error: "UNAUTHORIZED",
      method: "updateMany",
    },
    {
      name: "Better Auth 2FA",
      update: { twoFactorEnabled: false },
      error: "UNAUTHORIZED",
      transactional: true,
    },
    {
      name: "Better Auth verified email",
      update: { emailVerified: false },
      error: "FORBIDDEN",
      transactional: true,
    },
  ].map(({ update, method = "update", transactional, ...rest }) => ({
    ...rest,
    write: (id) => {
      const adapter = createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] });
      const write = (tx) =>
        tx[method]({ model: "user", where: [{ field: "id", value: id }], update });
      return transactional ? adapter.transaction(write) : write(adapter);
    },
  })),
];

async function removalActor(writer) {
  const actor = await user("authority-actor");
  const policyChange = writer.name === "forced-2FA policy";
  await prisma.appSetting.upsert({
    where: { key: "force2faInternalUsers" },
    create: { key: "force2faInternalUsers", value: policyChange ? "false" : "true" },
    update: { value: policyChange ? "false" : "true" },
  });
  await prisma.user.update({
    where: { id: actor.id },
    data: {
      role: "admin",
      twoFactorEnabled: !policyChange,
      createdAt: new Date(Date.now() - 25 * 3600_000),
    },
  });
  return actor;
}

describe("kb members integration", () => {
  it.each(
    ["ordinary", "admin-force"].flatMap((mode) =>
      ["published", "interrupted-before-ref", "interrupted-after-ref"].map((outcome) => ({
        mode,
        outcome,
      })),
    ),
  )("$mode removal settles a reserved creation ($outcome)", async ({ mode, outcome }) => {
    const owner = await user("creating-owner");
    const admin = await user("creating-admin");
    await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });
    const reserved = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    const submitted = Promise.withResolvers<void>();
    const interrupted = new Error("interrupted creation");
    const creationRuntime = {
      ...runtime,
      coordinator: {
        run: (options) =>
          coordinator.run({
            ...options,
            async run(ctx) {
              reserved.resolve(options.kbIds[0]);
              await release.promise;
              if (outcome === "interrupted-before-ref") throw interrupted;
              return options.run(ctx);
            },
          }),
      },
      createGitExecutor: () => ({
        exec(request) {
          localGitExecutor.exec(request);
          if (outcome === "interrupted-after-ref" && request.argv.includes("update-ref")) {
            throw interrupted;
          }
        },
      }),
    };
    const creation = createKnowledgeBase(creationRuntime, owner.id, {
      name: "Concurrent creation",
      slug: "concurrent-creation",
      description: "account removal must settle this publication",
      idempotencyKey: "concurrent-create",
    });
    const observedCreation = creation.catch((error) => error);
    let removal: Promise<unknown> | undefined;
    let kbId: string;
    try {
      kbId = await Promise.race([reserved.promise, creation.then(() => "unexpected")]);
      expect(
        await prisma.operationIntent.findFirst({ where: { kbId, operation: "KB_CREATE" } }),
      ).toMatchObject({ phase: "COMMITTING" });
      removal = runWithAllowedAccountDeletion(mode, () =>
        removeUserAccount(
          {
            ...runtime,
            coordinator: {
              run(options) {
                const pending = coordinator.run(options);
                submitted.resolve();
                return pending;
              },
            },
          },
          owner.id,
          { actingUserId: mode === "ordinary" ? owner.id : admin.id },
        ),
      );
      removal.catch(() => {});
      await Promise.race([submitted.promise, removal]);
      // An authority-only sentinel can pass while removal joins the creator's
      // KB gate. Without that gate, deletion commits before this sentinel and
      // clears the CREATING owner. No sleep or scheduler timing is involved.
      await coordinator.run({
        opId: crypto.randomUUID(),
        kind: "authority",
        async run(ctx) {
          const row = await ctx.lease.query(
            `SELECT "ownerId", state::text AS state FROM "knowledge_base" WHERE id = $1`,
            [kbId],
          );
          expect(row.rows).toEqual([{ ownerId: owner.id, state: "CREATING" }]);
        },
      });
    } finally {
      release.resolve();
      await Promise.allSettled([observedCreation, removal]);
    }
    if (outcome === "published") await expect(creation).resolves.toHaveProperty("kb.id", kbId);
    else await expect(creation).rejects.toThrow(interrupted);

    const published = outcome !== "interrupted-before-ref";
    const blocked = mode === "ordinary" && published;
    if (blocked) {
      await expect(removal).rejects.toMatchObject({ code: "ACCOUNT_DELETION_BLOCKED" });
    } else {
      await expect(removal).resolves.toEqual({ tombstonedKbCount: published ? 1 : 0 });
    }
    expect(await prisma.user.count({ where: { id: owner.id } })).toBe(blocked ? 1 : 0);
    expect(await prisma.knowledgeBase.findUnique({ where: { id: kbId } })).toMatchObject({
      state: blocked ? "ACTIVE" : "TOMBSTONED",
      ownerId: blocked ? owner.id : null,
    });
    expect(
      await prisma.operationIntent.findFirst({ where: { kbId, operation: "KB_CREATE" } }),
    ).toMatchObject({ phase: published ? "FINALIZED" : "ABORTED" });
    expect(await prisma.auditEvent.count({ where: { kbId, action: "kb_create" } })).toBe(
      published ? 1 : 0,
    );
    expect(await prisma.auditEvent.count({ where: { kbId, action: "kb_tombstone" } })).toBe(
      published && !blocked ? 1 : 0,
    );
    // A finalized creation keeps its Git history, even after force removal.
    if (published) {
      const kb = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
      expect(
        execFileSync("git", ["--git-dir", join(reposDir, `kb_${kbId}.git`), "rev-parse", "main"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(kb.headSha);
    }
    await runStartupJournalRecovery(
      prisma,
      reposDir,
      runtime.assetsDir,
      database.urls.runtime,
      () => {},
    );
  });

  it.each(["ordinary", "admin-force"])(
    "%s removal refuses ownership acquired after its lock discovery",
    async (mode) => {
      const owner = await user("late-creation-owner");
      const admin = await user("late-creation-admin");
      await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });
      const discovered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const removal = runWithAllowedAccountDeletion(mode, () =>
        removeUserAccount(
          {
            ...runtime,
            coordinator: {
              async run(options) {
                discovered.resolve();
                await release.promise;
                return coordinator.run(options);
              },
            },
          },
          owner.id,
          { actingUserId: mode === "ordinary" ? owner.id : admin.id },
        ),
      );
      removal.catch(() => {});
      let created: Awaited<ReturnType<typeof createKnowledgeBase>>;
      try {
        await Promise.race([discovered.promise, removal]);
        created = await createKnowledgeBase(runtime, owner.id, {
          name: "Late creation",
          slug: "late-creation",
          description: "creation wins after removal discovers its lock set",
          idempotencyKey: "late-create",
        });
      } finally {
        release.resolve();
        await Promise.allSettled([removal]);
      }
      await expect(removal).rejects.toMatchObject({
        code: "ACCOUNT_DELETION_BLOCKED",
        message: "Knowledge base ownership changed; retry removal",
      });
      expect(await prisma.user.count({ where: { id: owner.id } })).toBe(1);
      expect(await prisma.knowledgeBase.findUnique({ where: { id: created.kb.id } })).toMatchObject(
        { state: "ACTIVE", ownerId: owner.id },
      );
      const retry = runWithAllowedAccountDeletion(mode, () =>
        removeUserAccount(runtime, owner.id, {
          actingUserId: mode === "ordinary" ? owner.id : admin.id,
        }),
      );
      if (mode === "ordinary") {
        await expect(retry).rejects.toMatchObject({ code: "ACCOUNT_DELETION_BLOCKED" });
      } else {
        await expect(retry).resolves.toEqual({ tombstonedKbCount: 1 });
      }
    },
  );

  it.each(identityWriters)("$name committing first prevents account removal", async (writer) => {
    const actor = await removalActor(writer);
    const target = await user("authority-target");
    await writer.write(actor.id);
    await expect(
      removeUserAccount(runtime, target.id, { actingUserId: actor.id }),
    ).rejects.toMatchObject({ code: writer.error });
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
    expect(
      await prisma.auditEvent.count({ where: { action: "account_remove", actorUserId: actor.id } }),
    ).toBe(0);
  });

  it.each(identityWriters)(
    "$name waits across removal reauthorization and reservation",
    async (writer) => {
      const actor = await removalActor(writer);
      const target = await user("reserved-target");
      const checked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const paused = {
        ...runtime,
        coordinator: {
          run: (options) =>
            coordinator.run({
              ...options,
              barrier: {
                ...options.barrier,
                async reauthorize(ctx) {
                  await options.barrier.reauthorize(ctx);
                  checked.resolve();
                  await release.promise;
                },
              },
            }),
        },
      };
      const removal = removeUserAccount(paused, target.id, { actingUserId: actor.id });
      // Attach rejection observers before testing the interleaving.
      const observedRemoval = removal.catch((error) => error);
      let mutation: Promise<unknown> | undefined;
      try {
        await Promise.race([checked.promise, removal]);
        mutation = writer.write(actor.id);
        mutation.catch(() => {});
        // Observe a real PG lock waiter; no sleep-based assertion that the writer
        // "probably" hasn't committed yet. It cannot pass the shared gate.
        await expect
          .poll(
            async () => {
              const result = await database.query(
                "runtime",
                `
          SELECT EXISTS (SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND NOT granted) AS waiting`,
                [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID],
              );
              return result.rows[0].waiting;
            },
            { timeout: 2500 },
          )
          .toBe(true);
        expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
      } finally {
        release.resolve();
        await Promise.allSettled([observedRemoval, mutation]);
      }
      await expect(removal).resolves.toEqual({ tombstonedKbCount: 0 });
      await mutation;
      expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
      const lateTarget = await user("late-target");
      await expect(
        removeUserAccount(runtime, lateTarget.id, { actingUserId: actor.id }),
      ).rejects.toMatchObject({ code: writer.error });
      expect(await prisma.user.findUnique({ where: { id: lateTarget.id } })).not.toBeNull();
    },
  );

  it("shares and transfers fail closed on mutation admission and replay without a charge", async () => {
    const owner = await user("budget-owner");
    const member = await user("budget-member");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Budget KB",
      slug: `budget-${crypto.randomUUID().slice(0, 8)}`,
      description: "mutation admission integration knowledge base",
      idempotencyKey: "budget-create",
    });
    const kbId = created.kb.id;
    const inviteInput = {
      kbId,
      email: member.email,
      permissions: ["read"],
      idempotencyKey: "budget-invite",
    };
    const invited = await shareInvite(runtime, owner.id, inviteInput, MEMBERS_MASTER_KEY);
    const consume = vi.fn();
    const denied = { ...runtime, ratePort: { consume } };
    const counts = async () => ({
      invites: await prisma.shareInvitation.count({ where: { kbId } }),
      receipts: await prisma.operationIntent.count({ where: { kbId } }),
      audits: await prisma.auditEvent.count({ where: { kbId } }),
    });
    for (const [reply, code] of [
      [{ retryAfterSeconds: 60 }, "RATE_LIMITED"],
      [{ unavailable: true }, "STORAGE_UNAVAILABLE"],
    ]) {
      consume.mockResolvedValue(reply);
      const before = await counts();
      await expect(
        shareInvite(
          denied,
          owner.id,
          { ...inviteInput, idempotencyKey: `new-${code}` },
          MEMBERS_MASTER_KEY,
        ),
      ).rejects.toMatchObject({ code });
      await expect(
        shareAccept(denied, member.id, { requestId: invited.requestId }),
      ).rejects.toMatchObject({ code });
      expect(await counts()).toEqual(before);
      expect(await prisma.kbShare.count({ where: { kbId } })).toBe(0);
    }
    consume.mockClear();
    await expect(shareInvite(denied, owner.id, inviteInput, MEMBERS_MASTER_KEY)).resolves.toEqual(
      invited,
    );
    expect(consume).not.toHaveBeenCalled();
    // Exercise the in-lock receipt race too, by suppressing only the preview.
    const preview = vi.spyOn(prisma.operationIntent, "findUnique").mockResolvedValueOnce(null);
    try {
      await expect(shareInvite(denied, owner.id, inviteInput, MEMBERS_MASTER_KEY)).resolves.toEqual(
        invited,
      );
      expect(consume).not.toHaveBeenCalled();
    } finally {
      preview.mockRestore();
    }
    await shareAccept(runtime, member.id, { requestId: invited.requestId });
    const transferInput = {
      kbId,
      recipientUserId: member.id,
      metadataVersion: created.kb.metadataVersion,
      idempotencyKey: "budget-transfer",
    };
    for (const [reply, code] of [
      [{ retryAfterSeconds: 60 }, "RATE_LIMITED"],
      [{ unavailable: true }, "STORAGE_UNAVAILABLE"],
    ]) {
      consume.mockResolvedValue(reply);
      const before = await counts();
      await expect(
        shareRevoke(denied, owner.id, { kbId, shareUserId: member.id }),
      ).rejects.toMatchObject({ code });
      await expect(transferRequest(denied, owner.id, transferInput)).rejects.toMatchObject({
        code,
      });
      expect(await counts()).toEqual(before);
      expect(await prisma.kbTransfer.count({ where: { kbId } })).toBe(0);
      expect(
        await prisma.kbShare.findUnique({ where: { kbId_userId: { kbId, userId: member.id } } }),
      ).toMatchObject({ revokedAt: null });
    }
    const transfer = await transferRequest(runtime, owner.id, transferInput);
    consume.mockClear();
    await expect(transferRequest(denied, owner.id, transferInput)).resolves.toEqual(transfer);
    expect(consume).not.toHaveBeenCalled();
    const transferPreview = vi.spyOn(prisma.kbTransfer, "findUnique").mockResolvedValueOnce(null);
    try {
      await expect(transferRequest(denied, owner.id, transferInput)).resolves.toEqual(transfer);
      expect(consume).not.toHaveBeenCalled();
    } finally {
      transferPreview.mockRestore();
    }
    for (const [reply, code] of [
      [{ retryAfterSeconds: 60 }, "RATE_LIMITED"],
      [{ unavailable: true }, "STORAGE_UNAVAILABLE"],
    ]) {
      consume.mockResolvedValue(reply);
      const before = await counts();
      await expect(transferAccept(denied, member.id, transfer)).rejects.toMatchObject({ code });
      expect(await counts()).toEqual(before);
      expect(await prisma.knowledgeBase.findUnique({ where: { id: kbId } })).toMatchObject({
        ownerId: owner.id,
        metadataVersion: created.kb.metadataVersion,
      });
      expect(
        await prisma.kbTransfer.findUnique({ where: { requestId: transfer.requestId } }),
      ).toMatchObject({ state: "PENDING" });
    }
    expect(consume).toHaveBeenCalledWith("kb:mutation", `user:${member.id}:${kbId}`, 1);
    // Two successful owner mutations so far: invite + transfer request;
    // create is in its separate bucket. 58 more invitations fill the 60 slots.
    for (let i = 0; i < 58; i += 1) {
      await shareInvite(
        runtime,
        owner.id,
        {
          ...inviteInput,
          email: `budget-${i}@example.invalid`,
          idempotencyKey: `fill-${i}`,
        },
        MEMBERS_MASTER_KEY,
      );
    }
    const full = await counts();
    await expect(
      shareInvite(
        runtime,
        owner.id,
        { ...inviteInput, idempotencyKey: "over-budget" },
        MEMBERS_MASTER_KEY,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await counts()).toEqual(full);
    await expect(
      shareRevoke(runtime, owner.id, { kbId, shareUserId: member.id }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(shareInvite(runtime, owner.id, inviteInput, MEMBERS_MASTER_KEY)).resolves.toEqual(
      invited,
    );
    await expect(transferAccept(runtime, member.id, transfer)).resolves.toMatchObject({
      ownerId: member.id,
    });
  });

  it("invite-by-email is neutral until acceptance and lists only accepted shares", async () => {
    const owner = await user("owner");
    const member = await user("member");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Team KB",
      slug: `team-${crypto.randomUUID().slice(0, 8)}`,
      description: "members integration knowledge base",
      idempotencyKey: "create-members",
    });
    const kbId = created.kb.id as string;

    const known = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: member.email,
        permissions: ["read", "propose"],
        idempotencyKey: "invite-1",
      },
      MEMBERS_MASTER_KEY,
    );
    const unknown = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: `missing-${crypto.randomUUID()}@example.invalid`,
        permissions: ["read"],
        idempotencyKey: "invite-2",
      },
      MEMBERS_MASTER_KEY,
    );
    expect(known).toEqual({ accepted: true, requestId: expect.any(String) });
    expect(unknown.accepted).toBe(true);

    const beforeAccept = await prisma.kbShare.count({ where: { kbId } });
    expect(beforeAccept).toBe(0);

    const listPending = await shareList(runtime, owner.id, { kbId });
    expect(listPending.items).toHaveLength(0);

    await expect(
      shareAccept(runtime, owner.id, { requestId: known.requestId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await shareAccept(runtime, member.id, { requestId: known.requestId });
    const listAfter = await shareList(runtime, owner.id, { kbId });
    expect(listAfter.items.some((row) => row.userId === member.id)).toBe(true);
  });

  it("lists display names, shows the invited address only to its inviter or the owner, and edits bits in place", async () => {
    const owner = await user("names-owner");
    const manager = await user("names-manager");
    const member = await user("names-member");
    const outsider = await user("names-outsider");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Names KB",
      slug: `names-${crypto.randomUUID().slice(0, 8)}`,
      description: "member display name integration knowledge base",
      idempotencyKey: "create-names",
    });
    const kbId = created.kb.id as string;
    const invite = async (inviter, email, permissions, key) =>
      shareInvite(
        runtime,
        inviter,
        { kbId, email, permissions, idempotencyKey: key },
        MEMBERS_MASTER_KEY,
      );
    const managerInvite = await invite(owner.id, manager.email, ["manage"], "names-1");
    await shareAccept(runtime, manager.id, { requestId: managerInvite.requestId });
    // The manager, not the owner, invites the member.
    const memberInvite = await invite(manager.id, member.email.toUpperCase(), ["read"], "names-2");
    await shareAccept(runtime, member.id, { requestId: memberInvite.requestId });

    const rowsFor = async (viewer) =>
      Object.fromEntries(
        (await shareList(runtime, viewer, { kbId })).items.map((row) => [row.userId, row]),
      );
    const byOwner = await rowsFor(owner.id);
    expect(byOwner[member.id]).toMatchObject({ name: "names-member", invitedEmail: member.email });
    expect(byOwner[manager.id]).toMatchObject({ invitedEmail: manager.email });
    const byManager = await rowsFor(manager.id);
    // The manager sent the member's invitation, not their own.
    expect(byManager[member.id]).toMatchObject({
      name: "names-member",
      invitedEmail: member.email,
    });
    expect(byManager[manager.id]).toMatchObject({ name: "names-manager", invitedEmail: null });

    // A member whose current address no longer matches the invitation shows no address.
    await prisma.user.update({
      where: { id: member.id },
      data: { email: `moved-${crypto.randomUUID()}@example.invalid` },
    });
    expect((await rowsFor(owner.id))[member.id].invitedEmail).toBeNull();

    // Edit permissions: manage may change bits in place; the stored set is canonical.
    await expect(
      shareUpdate(runtime, manager.id, {
        kbId,
        shareUserId: member.id,
        permissions: ["write"],
      }),
    ).resolves.toEqual({ shareUserId: member.id, bits: ["read", "propose", "write"] });
    expect(
      expandBits(
        (await prisma.kbShare.findUnique({ where: { kbId_userId: { kbId, userId: member.id } } }))
          .bits,
      ),
    ).toEqual(["read", "propose", "write"]);
    await expect(
      prisma.auditEvent.findFirst({ where: { kbId, action: "share_update" } }),
    ).resolves.toMatchObject({ actorUserId: manager.id, outcome: "SUCCESS" });

    // Without manage the change is refused, and nothing moves.
    await expect(
      shareUpdate(runtime, member.id, { kbId, shareUserId: member.id, permissions: ["manage"] }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) });
    await expect(
      shareUpdate(runtime, outsider.id, { kbId, shareUserId: member.id, permissions: ["read"] }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(FORBIDDEN|NOT_FOUND)$/) });
    await expect(
      shareUpdate(runtime, owner.id, { kbId, shareUserId: member.id, permissions: [] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(
      (await prisma.kbShare.findUnique({ where: { kbId_userId: { kbId, userId: member.id } } }))
        .bits,
    ).toEqual(["read", "propose", "write"]);

    // A revoked share is not edited back to life.
    await shareRevoke(runtime, owner.id, { kbId, shareUserId: member.id });
    await expect(
      shareUpdate(runtime, owner.id, { kbId, shareUserId: member.id, permissions: ["read"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await prisma.kbShare.findUnique({ where: { kbId_userId: { kbId, userId: member.id } } }),
    ).toMatchObject({ revokedAt: expect.any(Date) });
  });

  it("transfer commits a single owner and blocks ordinary deletion", async () => {
    const owner = await user("transfer-owner");
    const recipient = await user("transfer-recipient");
    const admin = await user("transfer-admin");
    await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });

    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Transfer KB",
      slug: `xfer-${crypto.randomUUID().slice(0, 8)}`,
      description: "transfer integration knowledge base",
      idempotencyKey: "create-transfer",
    });
    const kbId = created.kb.id as string;
    const metadataVersion = created.kb.metadataVersion as number;

    await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: recipient.email,
        permissions: ["read"],
        idempotencyKey: "share-recipient",
      },
      MEMBERS_MASTER_KEY,
    );
    const invite = await prisma.shareInvitation.findFirst({
      where: { kbId, canonicalEmail: recipient.email.toLowerCase() },
    });
    await shareAccept(runtime, recipient.id, { requestId: invite!.requestId });

    await expect(assertOrdinaryAccountDeletionAllowed(prisma, owner.id)).rejects.toThrow(
      /active knowledge bases/i,
    );

    const { requestId } = await transferRequest(runtime, owner.id, {
      kbId,
      recipientUserId: recipient.id,
      metadataVersion,
      idempotencyKey: "xfer-req",
    });
    const accepted = await transferAccept(runtime, recipient.id, { requestId });
    expect(accepted.ownerId).toBe(recipient.id);

    const owners = await prisma.knowledgeBase.findMany({
      where: { id: kbId },
      select: { ownerId: true },
    });
    expect(owners).toEqual([{ ownerId: recipient.id }]);

    await runWithAllowedAccountDeletion("admin-force", () =>
      removeUserAccount(runtime, owner.id, { actingUserId: admin.id }),
    );
    const gone = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(gone).toBeNull();
  });

  it("acceptance leaves the former owner exactly manage, which the new owner can remove", async () => {
    const owner = await user("d265-owner");
    // This positive workflow enrolls a sealed value; model an enrolled owner
    // so it reaches the ownership-transfer assertions under the live 2FA gate.
    await prisma.user.update({ where: { id: owner.id }, data: { twoFactorEnabled: true } });
    const recipient = await user("d265-recipient");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Former owner KB",
      slug: `d265-${crypto.randomUUID().slice(0, 8)}`,
      description: "former owner keeps manage",
      idempotencyKey: "create-d265",
    });
    const kbId = created.kb.id as string;
    const master = randomBytes(32).toString("base64");
    await enrollSealedRecord(
      runtime,
      { kind: "browser", userId: owner.id },
      {
        kbId,
        namespace: remoteSealedNamespace(runtime.canonicalOrigin, kbId),
        plaintext: "d265-canary",
        idempotencyKey: crypto.randomUUID(),
      },
      master,
    );
    await shareInvite(
      runtime,
      owner.id,
      { kbId, email: recipient.email, permissions: ["read"], idempotencyKey: "d265-share" },
      MEMBERS_MASTER_KEY,
    );
    const invite = await prisma.shareInvitation.findFirst({
      where: { kbId, canonicalEmail: recipient.email.toLowerCase() },
    });
    await shareAccept(runtime, recipient.id, { requestId: invite!.requestId });
    const { requestId } = await transferRequest(runtime, owner.id, {
      kbId,
      recipientUserId: recipient.id,
      metadataVersion: created.kb.metadataVersion as number,
      idempotencyKey: "d265-xfer",
    });
    await expect(transferAccept(runtime, recipient.id, { requestId })).resolves.toMatchObject({
      ownerId: recipient.id,
    });

    const manage = expandBits(["manage"]);
    const former = await prisma.kbShare.findUniqueOrThrow({
      where: { kbId_userId: { kbId, userId: owner.id } },
    });
    expect(former.revokedAt).toBeNull();
    expect(former.bits).toEqual(manage);
    const store = prismaAuthorityStore(prisma);
    const live = await authorize({
      principal: { kind: "browser", userId: owner.id },
      kbId,
      operation: "manage",
      store,
    });
    expect(live.bits).toEqual(manage);
    // The new owner holds ownership, not a redundant share.
    const recipientShare = await prisma.kbShare.findUniqueOrThrow({
      where: { kbId_userId: { kbId, userId: recipient.id } },
    });
    expect(recipientShare.revokedAt).not.toBeNull();
    const members = await shareList(runtime, recipient.id, { kbId });
    expect(members.items.map((row) => [row.userId, row.bits])).toEqual([[owner.id, manage]]);
    expect(
      (await prisma.kbTransfer.findUniqueOrThrow({ where: { requestId } })).formerOwnerBits,
    ).toEqual(manage);
    const audit = await prisma.auditEvent.findFirst({
      where: { kbId, action: "transfer_former_owner_share" },
    });
    expect(audit?.metadata).toMatchObject({ shareUserId: owner.id, requestId });

    // Sealed control follows ownership only: records move to the new owner and
    // the former owner's manage share cannot enroll or approve sealed values.
    const records = await prisma.sealedRecord.findMany({ where: { kbId } });
    expect(records.map((r) => r.ownerId)).toEqual([recipient.id]);
    await expect(
      enrollSealedRecord(
        runtime,
        { kind: "browser", userId: owner.id },
        {
          kbId,
          namespace: remoteSealedNamespace(runtime.canonicalOrigin, kbId),
          plaintext: "former-owner",
          idempotencyKey: crypto.randomUUID(),
        },
        master,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await shareRevoke(runtime, recipient.id, { kbId, shareUserId: owner.id });
    await expect(
      authorize({
        principal: { kind: "browser", userId: owner.id },
        kbId,
        operation: "read",
        store,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("delegated self-service removal commits with actor-equals-target audit", async () => {
    const selfUser = await user("self-remove");
    await runWithAllowedAccountDeletion("ordinary", () =>
      removeUserAccount(runtime, selfUser.id, { actingUserId: selfUser.id }),
    );
    expect(await prisma.user.findUnique({ where: { id: selfUser.id } })).toBeNull();
    // The audit row is inserted while the actor still exists; the user DELETE
    // then SET NULLs the live FK while the snapshot preserves attribution.
    const audit = await prisma.auditEvent.findFirst({
      where: {
        action: "account_remove",
        metadata: { path: ["shareUserId"], equals: selfUser.id },
      },
      select: { actorUserId: true, actorUserIdSnapshot: true },
    });
    expect(audit).toMatchObject({ actorUserId: null, actorUserIdSnapshot: selfUser.id });
  });

  it("rejects admin-force removal when the actor was demoted before the reservation", async () => {
    const owner = await user("demote-owner");
    const actor = await user("demote-actor");
    // The outer gate would have passed while the actor was still an admin;
    // the demotion lands between the gate and the reservation.
    await prisma.user.update({ where: { id: actor.id }, data: { role: "admin" } });
    await prisma.user.update({ where: { id: actor.id }, data: { role: "user" } });

    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Demote KB",
      slug: `demote-${crypto.randomUUID().slice(0, 8)}`,
      description: "demotion race integration knowledge base",
      idempotencyKey: "create-demote",
    });
    const kbId = created.kb.id as string;

    await expect(
      runWithAllowedAccountDeletion("admin-force", () =>
        removeUserAccount(runtime, owner.id, { actingUserId: actor.id }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
    // Nothing was tombstoned or detached on the way out.
    expect(
      await prisma.knowledgeBase.findUnique({
        where: { id: kbId },
        select: { state: true, ownerId: true },
      }),
    ).toMatchObject({ state: "ACTIVE", ownerId: owner.id });
  });

  it("rejects ordinary cross-user removal by a non-admin actor", async () => {
    const target = await user("cross-target");
    const actor = await user("cross-actor");
    await expect(
      runWithAllowedAccountDeletion("ordinary", () =>
        removeUserAccount(runtime, target.id, { actingUserId: actor.id }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it("rejects removal by an established admin outside the 2FA enrollment grace", async () => {
    const target = await user("twofa-target");
    const staleAdmin = await prisma.user.create({
      data: {
        name: "twofa-admin",
        email: `twofa-admin-${crypto.randomUUID()}@example.invalid`,
        emailVerified: true,
        role: "admin",
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    try {
      await expect(
        runWithAllowedAccountDeletion("ordinary", () =>
          removeUserAccount(runtime, target.id, { actingUserId: staleAdmin.id }),
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: staleAdmin.id } });
    }
  });

  it("re-invitation keeps earlier idempotency receipts exactly-once", async () => {
    const owner = await user("receipt-owner");
    const member = await user("receipt-member");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Receipt KB",
      slug: `receipt-${crypto.randomUUID().slice(0, 8)}`,
      description: "receipt integration knowledge base",
      idempotencyKey: "create-receipt",
    });
    const kbId = created.kb.id as string;

    const first = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: member.email,
        permissions: ["read"],
        idempotencyKey: "invite-a",
      },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, member.id, { requestId: first.requestId });

    const second = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: member.email,
        permissions: ["manage"],
        idempotencyKey: "invite-b",
      },
      MEMBERS_MASTER_KEY,
    );
    expect(second.requestId).not.toBe(first.requestId);
    await shareAccept(runtime, member.id, { requestId: second.requestId });

    // Retrying the ORIGINAL request replays its original result and never
    // re-grants: the receipt survives the re-invitation untouched.
    const replay = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: member.email,
        permissions: ["read"],
        idempotencyKey: "invite-a",
      },
      MEMBERS_MASTER_KEY,
    );
    expect(replay.requestId).toBe(first.requestId);
    await expect(
      shareAccept(runtime, member.id, { requestId: replay.requestId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const share = await prisma.kbShare.findUnique({
      where: { kbId_userId: { kbId, userId: member.id } },
      select: { bits: true, revokedAt: true },
    });
    // Invitation bits are stored in expanded canonical form.
    expect(share).toMatchObject({
      bits: ["read", "propose", "write", "review", "manage"],
      revokedAt: null,
    });
  });

  it("supersedes a pending invitation whose inviter lost authority", async () => {
    const owner = await user("supersede-owner");
    const manager = await user("supersede-manager");
    const recipient = await user("supersede-recipient");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Supersede KB",
      slug: `supersede-${crypto.randomUUID().slice(0, 8)}`,
      description: "supersede integration knowledge base",
      idempotencyKey: "create-supersede",
    });
    const kbId = created.kb.id as string;

    const managerInvite = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: manager.email,
        permissions: ["manage"],
        idempotencyKey: "invite-manager",
      },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, manager.id, { requestId: managerInvite.requestId });

    const deadIntent = await shareInvite(
      runtime,
      manager.id,
      {
        kbId,
        email: recipient.email,
        permissions: ["read"],
        idempotencyKey: "manager-invite",
      },
      MEMBERS_MASTER_KEY,
    );
    await shareRevoke(runtime, owner.id, { kbId, shareUserId: manager.id });

    const revived = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: recipient.email,
        permissions: ["read", "propose"],
        idempotencyKey: "owner-invite",
      },
      MEMBERS_MASTER_KEY,
    );
    expect(revived.requestId).not.toBe(deadIntent.requestId);

    // The dead intent's requestId is invalidated by the supersede.
    await expect(
      shareAccept(runtime, recipient.id, { requestId: deadIntent.requestId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await shareAccept(runtime, recipient.id, { requestId: revived.requestId });
    const share = await prisma.kbShare.findUnique({
      where: { kbId_userId: { kbId, userId: recipient.id } },
      select: { bits: true },
    });
    expect(share?.bits).toEqual(["read", "propose"]);
  });

  it("rejects acceptance after the recipient is banned mid-flight", async () => {
    const owner = await user("ban-owner");
    const recipient = await user("ban-recipient");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Ban KB",
      slug: `ban-${crypto.randomUUID().slice(0, 8)}`,
      description: "ban race integration knowledge base",
      idempotencyKey: "create-ban",
    });
    const kbId = created.kb.id as string;

    const invite = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: recipient.email,
        permissions: ["read"],
        idempotencyKey: "invite-ban",
      },
      MEMBERS_MASTER_KEY,
    );

    await prisma.user.update({ where: { id: recipient.id }, data: { banned: true } });
    await expect(
      shareAccept(runtime, recipient.id, { requestId: invite.requestId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      await prisma.kbShare.findUnique({
        where: { kbId_userId: { kbId, userId: recipient.id } },
      }),
    ).toBeNull();
  });

  it("enforces the per-KB accepted-share limit on new active shares", async () => {
    const owner = await user("limit-owner");
    const recipient = await user("limit-recipient");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Limit KB",
      slug: `limit-${crypto.randomUUID().slice(0, 8)}`,
      description: "share limit integration knowledge base",
      idempotencyKey: "create-limit",
    });
    const kbId = created.kb.id as string;

    const fillerUsers = Array.from({ length: 1024 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `filler-${index}`,
      email: `filler-${index}-${crypto.randomUUID()}@example.invalid`,
      emailVerified: true,
    }));
    await prisma.user.createMany({ data: fillerUsers });
    await prisma.kbShare.createMany({
      data: fillerUsers.map((filler) => ({
        id: crypto.randomUUID().replaceAll("-", "").slice(0, 24),
        kbId,
        userId: filler.id,
        bits: ["read"],
      })),
    });

    const invite = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: recipient.email,
        permissions: ["read"],
        idempotencyKey: "invite-limit",
      },
      MEMBERS_MASTER_KEY,
    );
    await expect(
      shareAccept(runtime, recipient.id, { requestId: invite.requestId }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(
      await prisma.kbShare.findUnique({
        where: { kbId_userId: { kbId, userId: recipient.id } },
      }),
    ).toBeNull();

    // Revoking one active share frees a slot for the next acceptance.
    await prisma.kbShare.update({
      where: { kbId_userId: { kbId, userId: fillerUsers[0]!.id } },
      data: { revokedAt: new Date() },
    });
    await shareAccept(runtime, recipient.id, { requestId: invite.requestId });
  });
});

/** Test mailer: the real durable delivery path with a capturing transport. */
async function deliverKbEmails(
  requestIds: string[],
  beforeEffect?: () => Promise<void>,
  duringEffect?: (signal: AbortSignal) => Promise<void>,
) {
  const jobs = await prisma.durableJob.findMany({
    where: { kind: "KB_EMAIL" },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  const mine = jobs.filter((job) =>
    requestIds.includes((job.desired as { requestId: string }).requestId),
  );
  const sent: { to: string; subject: string; html: string }[] = [];
  for (const job of mine) {
    await prisma.durableJob.update({ where: { id: job.id }, data: { state: "PUBLISHED" } });
    await runKbEmailDelivery(prisma, {
      workerId: "test-mailer",
      connectionString: runtime.connectionString,
      durableJobId: job.id,
      masterKey: MEMBERS_MASTER_KEY,
      send: async (message, guard) => {
        await beforeEffect?.();
        if (guard)
          await guard(async (signal) => {
            await duringEffect?.(signal);
            signal.throwIfAborted();
            sent.push(message);
          });
        else sent.push(message); // Historical regression replay uses the old producer.
      },
    });
  }
  return { jobs: mine, sent };
}

async function membersKb(label: string, owner: { id: string }) {
  const created = await createKnowledgeBase(runtime, owner.id, {
    name: `${label} KB`,
    slug: `${label}-${crypto.randomUUID().slice(0, 8)}`,
    description: `${label} integration knowledge base`,
    idempotencyKey: `create-${label}`,
  });
  return {
    kbId: created.kb.id as string,
    metadataVersion: created.kb.metadataVersion as number,
  };
}

describe("invite and transfer email", () => {
  it("known and unknown addresses get identical responses and exactly one queued email each with the acceptance link", async () => {
    const owner = await user("mail-owner");
    const member = await user("mail-member");
    const { kbId } = await membersKb("mail", owner);
    const unknownEmail = `nobody-${crypto.randomUUID()}@example.invalid`;
    const known = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: member.email,
        permissions: ["read"],
        idempotencyKey: "mail-known",
        locale: "es-MX",
      },
      MEMBERS_MASTER_KEY,
    );
    const unknown = await shareInvite(
      runtime,
      owner.id,
      {
        kbId,
        email: unknownEmail,
        permissions: ["read"],
        idempotencyKey: "mail-unknown",
        locale: "es-MX",
      },
      MEMBERS_MASTER_KEY,
    );
    // Identical response shape and value classes: no account enumeration.
    const shape = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v]));
    expect(shape(known)).toEqual(shape(unknown));
    expect(known).toEqual({ accepted: true, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(unknown).toEqual({
      accepted: true,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });

    // Nothing is sent in the request: both emails wait in the durable queue.
    const { jobs, sent } = await deliverKbEmails([known.requestId, unknown.requestId]);
    expect(jobs).toHaveLength(2);
    expect(Object.keys(jobs[0]!.desired as object).sort()).toEqual(
      Object.keys(jobs[1]!.desired as object).sort(),
    );
    expect(JSON.stringify(jobs.map((job) => job.desired))).not.toContain("@example.invalid");
    expect(sent.map((m) => m.to).sort()).toEqual([member.email, unknownEmail].sort());
    for (const [request, to] of [
      [known, member.email],
      [unknown, unknownEmail],
    ] as const) {
      const message = sent.find((m) => m.to === to)!;
      const acceptPath = `/es-MX/kbs/${kbId}/settings?accept=${request.requestId}`;
      expect(message.html).toContain(`${runtime.canonicalOrigin}${acceptPath}`);
      // Unknown addresses reach sign-up, which returns to the acceptance page.
      expect(message.html).toContain(
        `${runtime.canonicalOrigin}/es-MX/signup?redirectTo=${encodeURIComponent(acceptPath)}`,
      );
    }
    // Same template for both: only the per-invite link differs.
    const [a, b] = [known, unknown].map((request) =>
      sent.find((m) => m.html.includes(request.requestId))!.html.replaceAll(request.requestId, "X"),
    );
    expect(a).toBe(b);
    expect(
      await prisma.durableJob.count({
        where: { id: { in: jobs.map((j) => j.id) }, state: "COMPLETE" },
      }),
    ).toBe(2);

    // A retried request (same key) replays its receipt and queues nothing new.
    await shareInvite(
      runtime,
      owner.id,
      { kbId, email: unknownEmail, permissions: ["read"], idempotencyKey: "mail-unknown" },
      MEMBERS_MASTER_KEY,
    );
    expect((await deliverKbEmails([unknown.requestId])).jobs).toHaveLength(1);

    // The emailed link still accepts after sign-up with the invited address.
    const late = await prisma.user.create({
      data: { name: "late", email: unknownEmail, emailVerified: true },
    });
    await shareAccept(runtime, late.id, { requestId: unknown.requestId });
  });

  it("an invitation that is no longer pending is completed without sending", async () => {
    const owner = await user("mail-stale-owner");
    const member = await user("mail-stale-member");
    const { kbId } = await membersKb("mailstale", owner);
    const invite = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: member.email, permissions: ["read"], idempotencyKey: "mail-stale" },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, member.id, { requestId: invite.requestId });
    const { jobs, sent } = await deliverKbEmails([invite.requestId]);
    expect(jobs).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect((await prisma.durableJob.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).state).toBe(
      "COMPLETE",
    );
  });

  it("a transfer offer queues one email to the recipient with the transfer link", async () => {
    const owner = await user("mail-xfer-owner");
    const recipient = await user("mail-xfer-recipient");
    await prisma.user.update({ where: { id: recipient.id }, data: { locale: "es-MX" } });
    const { kbId, metadataVersion } = await membersKb("mailxfer", owner);
    const invite = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: recipient.email, permissions: ["read"], idempotencyKey: "mail-xfer-share" },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, recipient.id, { requestId: invite.requestId });
    const { requestId } = await transferRequest(runtime, owner.id, {
      kbId,
      recipientUserId: recipient.id,
      metadataVersion,
      idempotencyKey: "mail-xfer",
    });
    const { jobs, sent } = await deliverKbEmails([requestId]);
    expect(jobs).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(recipient.email);
    expect(sent[0]!.html).toContain(
      `${runtime.canonicalOrigin}/es-MX/kbs/${kbId}/settings?transfer=${requestId}`,
    );
  });
});

describe("R46r4 queued email authority", () => {
  for (const template of ["share_invite", "transfer_offer"]) {
    for (const atEffect of [false, true]) {
      it(`${template} suppresses revoked authority ${atEffect ? "at SMTP handoff" : "before delivery"}`, async () => {
        const owner = await user("queued-owner");
        const member = await user("queued-member");
        const { kbId, metadataVersion } = await membersKb("queued", owner);
        const share = await shareInvite(
          runtime,
          owner.id,
          { kbId, email: member.email, permissions: ["manage"], idempotencyKey: "member" },
          MEMBERS_MASTER_KEY,
        );
        await shareAccept(runtime, member.id, { requestId: share.requestId });
        const offer =
          template === "share_invite"
            ? await shareInvite(
                runtime,
                member.id,
                {
                  kbId,
                  email: "outside@example.invalid",
                  permissions: ["read"],
                  idempotencyKey: "outside",
                },
                MEMBERS_MASTER_KEY,
              )
            : await transferRequest(runtime, owner.id, {
                kbId,
                recipientUserId: member.id,
                metadataVersion,
                idempotencyKey: "transfer",
              });
        const revoke = async () => {
          await shareRevoke(runtime, owner.id, { kbId, shareUserId: member.id });
          await prisma.knowledgeBase.update({
            where: { id: kbId },
            data: { name: "Private post-revoke name" },
          });
        };
        if (!atEffect) await revoke();
        const { sent } = await deliverKbEmails([offer.requestId], atEffect ? revoke : undefined);
        expect(sent).toEqual([]);
      });
    }
  }
  it("a live rename does not suppress an authorized invitation", async () => {
    const owner = await user("rename-owner");
    const { kbId } = await membersKb("rename", owner);
    const invite = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: "outside@example.invalid", permissions: ["read"], idempotencyKey: "rename" },
      MEMBERS_MASTER_KEY,
    );
    const result = await deliverKbEmails([invite.requestId], async () => {
      await prisma.knowledgeBase.update({ where: { id: kbId }, data: { name: "Renamed" } });
    });
    expect(result.sent).toHaveLength(1);
  });
  for (const reason of ["version", "owner", "identity"]) {
    it(`suppresses a transfer offer with stale ${reason} at SMTP handoff`, async () => {
      const owner = await user("stale-owner");
      const member = await user("stale-member");
      const { kbId, metadataVersion } = await membersKb("staleoffer", owner);
      const invite = await shareInvite(
        runtime,
        owner.id,
        { kbId, email: member.email, permissions: ["read"], idempotencyKey: "share" },
        MEMBERS_MASTER_KEY,
      );
      await shareAccept(runtime, member.id, { requestId: invite.requestId });
      const offer = await transferRequest(runtime, owner.id, {
        kbId,
        recipientUserId: member.id,
        metadataVersion,
        idempotencyKey: "offer",
      });
      const result = await deliverKbEmails([offer.requestId], async () => {
        await prisma.$transaction(async (tx) => {
          await lockIdentityAuthority(tx);
          if (reason === "identity")
            await tx.user.update({ where: { id: member.id }, data: { banned: true } });
          else
            await tx.knowledgeBase.update({
              where: { id: kbId },
              data:
                reason === "owner" ? { ownerId: member.id } : { metadataVersion: { increment: 1 } },
            });
        });
      });
      expect(result.sent).toEqual([]);
    });
  }
  for (const failure of ["cancelled", "expired", "superseded"] as const) {
    it(`a ${failure} job at SMTP handoff cannot send or commit late completion`, async () => {
      const owner = await user("cancel-mail-owner");
      const { kbId } = await membersKb("cancelmail", owner);
      const invite = await shareInvite(
        runtime,
        owner.id,
        { kbId, email: "outside@example.invalid", permissions: ["read"], idempotencyKey: "cancel" },
        MEMBERS_MASTER_KEY,
      );
      await expect(
        deliverKbEmails([invite.requestId], async () => {
          await prisma.durableJob.updateMany({
            where: { desired: { path: ["requestId"], equals: invite.requestId } },
            data:
              failure === "cancelled"
                ? { state: "CANCELLED", cancelledAt: new Date() }
                : failure === "expired"
                  ? { leaseUntil: new Date(0) }
                  : { attemptEpoch: { increment: 1 }, workerOwner: "replacement" },
          });
        }),
      ).rejects.toMatchObject({ name: "DurableJobFenceError" });
      const jobs = await prisma.durableJob.findMany({
        where: { desired: { path: ["requestId"], equals: invite.requestId } },
        take: 2,
      });
      expect(jobs.map((job) => job.state)).toEqual([
        failure === "cancelled" ? "CANCELLED" : "RUNNING",
      ]);
    });
  }
  it("an authorized SMTP effect keeps authority until it drains, then permits revocation", async () => {
    const owner = await user("send-lock-owner");
    const manager = await user("send-lock-manager");
    const { kbId } = await membersKb("sendlock", owner);
    const grant = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: manager.email, permissions: ["manage"], idempotencyKey: "grant" },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, manager.id, { requestId: grant.requestId });
    const invite = await shareInvite(
      runtime,
      manager.id,
      { kbId, email: "outside@example.invalid", permissions: ["read"], idempotencyKey: "effect" },
      MEMBERS_MASTER_KEY,
    );
    let pending: Promise<void> | undefined;
    let revoked = false;
    try {
      const result = await deliverKbEmails([invite.requestId], undefined, async () => {
        pending = prisma.$transaction(async (tx) => {
          await lockIdentityAuthority(tx);
          await tx.kbShare.update({
            where: { kbId_userId: { kbId, userId: manager.id } },
            data: { revokedAt: new Date() },
          });
          revoked = true;
        });
        pending.catch(() => {});
        await expect
          .poll(
            async () => {
              const rows = await prisma.$queryRaw<
                { waiting: boolean }[]
              >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=${AUTHORITY_LOCK_CLASSID}::oid AND objid=${AUTHORITY_LOCK_OBJID}::oid AND NOT granted) AS waiting`;
              return rows[0]?.waiting;
            },
            { timeout: 2000 },
          )
          .toBe(true);
        expect(revoked).toBe(false);
      });
      expect(result.sent).toHaveLength(1);
      expect(pending).toBeDefined();
      await pending;
      expect(revoked).toBe(true);
    } finally {
      await pending?.catch(() => {});
    }
  });
  it("loss of the owned SQL session aborts a paused send before disclosure", async () => {
    const owner = await user("lost-send-owner");
    const { kbId } = await membersKb("lostsend", owner);
    const invite = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: "outside@example.invalid", permissions: ["read"], idempotencyKey: "lost" },
      MEMBERS_MASTER_KEY,
    );
    let lost = false;
    await expect(
      deliverKbEmails([invite.requestId], undefined, async (signal) => {
        const lease = getOperationLease();
        if (!lease) throw new Error("Missing real operation lease");
        const aborted = new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              lost = true;
              resolve();
            },
            { once: true },
          ),
        );
        const stopped = await prisma.$queryRaw<
          { terminated: boolean }[]
        >`SELECT pg_terminate_backend(${lease.backendPid}::int) AS terminated`;
        expect(stopped[0]?.terminated).toBe(true);
        await aborted;
        signal.throwIfAborted();
      }),
    ).rejects.toThrow();
    expect(lost).toBe(true);
    expect(
      (
        await prisma.durableJob.findFirstOrThrow({
          where: { desired: { path: ["requestId"], equals: invite.requestId } },
        })
      ).state,
    ).toBe("RETRY");
  });
  it("rejects oversized mailboxes before invitation/job persistence; exact bounds remain valid", async () => {
    const owner = await user("mailbox-owner");
    const { kbId } = await membersKb("mailbox", owner);
    const address = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(address.length).toBe(254);
    const valid = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: address, permissions: ["read"], idempotencyKey: "exact" },
      MEMBERS_MASTER_KEY,
    );
    expect((await deliverKbEmails([valid.requestId])).sent[0].to).toBe(address);
    for (const email of [
      `${"a".repeat(65)}@example.invalid`,
      `${"a".repeat(1100)}@example.invalid`,
      `a@${"b".repeat(64)}.invalid`,
      `${address}a`,
      "a@example.invalid\r\nBcc: x@example.invalid",
      "a@example.invalid\r\n",
    ]) {
      await expect(
        shareInvite(
          runtime,
          owner.id,
          { kbId, email, permissions: ["read"], idempotencyKey: "invalid" },
          MEMBERS_MASTER_KEY,
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(await prisma.shareInvitation.count({ where: { kbId } })).toBe(1);
  });
});

describe("share option includeSealedValues", () => {
  it("defaults false, only the owner can flip it, and re-acceptance keeps it", async () => {
    const owner = await user("sealed-flag-owner");
    const manager = await user("sealed-flag-manager");
    const reader = await user("sealed-flag-reader");
    const { kbId } = await membersKb("sealedflag", owner);
    for (const [target, bits, key] of [
      [manager, ["manage"], "flag-manager"],
      [reader, ["read"], "flag-reader"],
    ] as const) {
      const invite = await shareInvite(
        runtime,
        owner.id,
        { kbId, email: target.email, permissions: [...bits], idempotencyKey: key },
        MEMBERS_MASTER_KEY,
      );
      await shareAccept(runtime, target.id, { requestId: invite.requestId });
    }
    const flags = async () =>
      Object.fromEntries(
        (await shareList(runtime, owner.id, { kbId })).items.map((row) => [
          row.userId,
          row.includeSealedValues,
        ]),
      );
    expect(await flags()).toEqual({ [manager.id]: false, [reader.id]: false });

    // A non-owner manager can neither grant nor clear the option.
    for (const includeSealedValues of [true, false])
      await expect(
        shareSetSealedValues(runtime, manager.id, {
          kbId,
          shareUserId: reader.id,
          includeSealedValues,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      shareSetSealedValues(runtime, manager.id, {
        kbId,
        shareUserId: manager.id,
        includeSealedValues: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await flags()).toEqual({ [manager.id]: false, [reader.id]: false });

    await expect(
      shareSetSealedValues(runtime, owner.id, {
        kbId,
        shareUserId: manager.id,
        includeSealedValues: true,
      }),
    ).resolves.toEqual({ shareUserId: manager.id, includeSealedValues: true });
    expect(await flags()).toEqual({ [manager.id]: true, [reader.id]: false });
    expect(
      await prisma.auditEvent.count({ where: { kbId, action: "share_sealed_values_set" } }),
    ).toBe(1);

    // No live share -> NOT_FOUND (a revoked share cannot be flagged).
    await shareRevoke(runtime, owner.id, { kbId, shareUserId: reader.id });
    await expect(
      shareSetSealedValues(runtime, owner.id, {
        kbId,
        shareUserId: reader.id,
        includeSealedValues: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Once the owner set it, re-invites and re-acceptances of the LIVE
    // share preserve it.
    const again = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: manager.email, permissions: ["manage"], idempotencyKey: "flag-manager-2" },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, manager.id, { requestId: again.requestId });
    expect((await flags())[manager.id]).toBe(true);
    // Removal by the owner ends the share; a later re-invite starts false.
    await shareRevoke(runtime, owner.id, { kbId, shareUserId: manager.id });
    const afterRemoval = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: manager.email, permissions: ["manage"], idempotencyKey: "flag-manager-3" },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, manager.id, { requestId: afterRemoval.requestId });
    expect((await flags())[manager.id]).toBe(false);
  });

  it("live-share re-invites, permission changes and re-accepts preserve the owner's choice; removal ends it; a new share starts false", async () => {
    const owner = await user("d2615-owner");
    const manager = await user("d2615-manager");
    const member = await user("d2615-member");
    const newcomer = await user("d2615-newcomer");
    const { kbId } = await membersKb("d2615", owner);
    const accept = async (
      inviter: { id: string },
      target: { id: string; email: string },
      permissions: string[],
      key: string,
    ) => {
      const invite = await shareInvite(
        runtime,
        inviter.id,
        { kbId, email: target.email, permissions, idempotencyKey: key },
        MEMBERS_MASTER_KEY,
      );
      await shareAccept(runtime, target.id, { requestId: invite.requestId });
    };
    const flagOf = async (userId: string) =>
      (await prisma.kbShare.findUniqueOrThrow({ where: { kbId_userId: { kbId, userId } } }))
        .includeSealedValues;
    await accept(owner, manager, ["manage"], "d2615-manager");
    await accept(manager, member, ["read"], "d2615-member");
    expect(await flagOf(member.id)).toBe(false);

    // Only the owner writes the flag.
    await expect(
      shareSetSealedValues(runtime, manager.id, {
        kbId,
        shareUserId: member.id,
        includeSealedValues: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await flagOf(member.id)).toBe(false);
    await shareSetSealedValues(runtime, owner.id, {
      kbId,
      shareUserId: member.id,
      includeSealedValues: true,
    });
    expect(await flagOf(member.id)).toBe(true);

    // Manager re-invites a live member with changed permissions; member re-accepts.
    await accept(manager, member, ["read", "write"], "d2615-member-2");
    const changed = await prisma.kbShare.findUniqueOrThrow({
      where: { kbId_userId: { kbId, userId: member.id } },
    });
    // The permission change applied (write expands to its implied bits).
    expect(changed.bits).toContain("write");
    expect(changed.includeSealedValues).toBe(true);

    // The manager removes the member (ending the share) and re-invites;
    // the member accepts a NEW share, which starts false.
    await shareRevoke(runtime, manager.id, { kbId, shareUserId: member.id });
    const ended = await prisma.kbShare.findUniqueOrThrow({
      where: { kbId_userId: { kbId, userId: member.id } },
    });
    expect(ended.revokedAt).not.toBeNull();
    await accept(manager, member, ["read"], "d2615-member-3");
    expect(await flagOf(member.id)).toBe(false);
    // Only the owner turns it back on.
    await expect(
      shareSetSealedValues(runtime, manager.id, {
        kbId,
        shareUserId: member.id,
        includeSealedValues: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await flagOf(member.id)).toBe(false);
    await shareSetSealedValues(runtime, owner.id, {
      kbId,
      shareUserId: member.id,
      includeSealedValues: true,
    });
    expect(await flagOf(member.id)).toBe(true);
    // ...and the new live share again preserves it across a manager re-invite.
    await accept(manager, member, ["read", "write"], "d2615-member-4");
    expect(await flagOf(member.id)).toBe(true);

    // A member's first share always starts false, whoever invites.
    await accept(owner, newcomer, ["read"], "d2615-newcomer");
    expect(await flagOf(newcomer.id)).toBe(false);
    expect(
      await prisma.auditEvent.count({ where: { kbId, action: "share_sealed_values_set" } }),
    ).toBe(2);
  });

  it("the former owner's retained manage share never includes sealed values", async () => {
    const owner = await user("sealed-xfer-owner");
    const recipient = await user("sealed-xfer-recipient");
    const { kbId, metadataVersion } = await membersKb("sealedxfer", owner);
    const invite = await shareInvite(
      runtime,
      owner.id,
      { kbId, email: recipient.email, permissions: ["read"], idempotencyKey: "sx-share" },
      MEMBERS_MASTER_KEY,
    );
    await shareAccept(runtime, recipient.id, { requestId: invite.requestId });
    await shareSetSealedValues(runtime, owner.id, {
      kbId,
      shareUserId: recipient.id,
      includeSealedValues: true,
    });
    const { requestId } = await transferRequest(runtime, owner.id, {
      kbId,
      recipientUserId: recipient.id,
      metadataVersion,
      idempotencyKey: "sx-xfer",
    });
    await transferAccept(runtime, recipient.id, { requestId });
    const former = await prisma.kbShare.findUniqueOrThrow({
      where: { kbId_userId: { kbId, userId: owner.id } },
    });
    expect(former.revokedAt).toBeNull();
    expect(former.includeSealedValues).toBe(false);
  });
});

describe("R46r2 private control receipt authority", () => {
  it("denies both original receipts after the new owner removes the former owner's share", async () => {
    const owner = await user("removed-receipt-owner");
    const recipient = await user("removed-receipt-recipient");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Removed receipt",
      slug: `removed-receipt-${crypto.randomUUID().slice(0, 8)}`,
      description: "Removed owner control receipt fixture",
      idempotencyKey: crypto.randomUUID(),
    });
    const kbId = created.kb.id;
    const inviteInput = {
      kbId,
      email: recipient.email,
      permissions: ["read"],
      idempotencyKey: crypto.randomUUID(),
    };
    const invite = await shareInvite(runtime, owner.id, inviteInput, MEMBERS_MASTER_KEY);
    await shareAccept(runtime, recipient.id, invite);
    const transferInput = {
      kbId,
      recipientUserId: recipient.id,
      metadataVersion: created.kb.metadataVersion,
      idempotencyKey: crypto.randomUUID(),
    };
    const transfer = await transferRequest(runtime, owner.id, transferInput);
    await transferAccept(runtime, recipient.id, transfer);
    await shareRevoke(runtime, recipient.id, { kbId, shareUserId: owner.id });
    await expect(
      authorize({
        store: prismaAuthorityStore(prisma),
        principal: { kind: "browser", userId: owner.id },
        kbId,
        operation: "read",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const before = await prisma.auditEvent.count({ where: { kbId } });
    const attempts = await Promise.allSettled([
      shareInvite(runtime, owner.id, inviteInput, MEMBERS_MASTER_KEY),
      transferRequest(runtime, owner.id, transferInput),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    expect(await prisma.auditEvent.count({ where: { kbId } })).toBe(before);
  });

  it("reauthorizes historical transfer and invite receipts without repeating their effects", async () => {
    const owner = await user("receipt-owner-live");
    const member = await user("receipt-new-owner");
    const created = await createKnowledgeBase(runtime, owner.id, {
      name: "Receipt authority",
      slug: `receipt-live-${crypto.randomUUID().slice(0, 8)}`,
      description: "Live authority receipt integration",
      idempotencyKey: crypto.randomUUID(),
    });
    const kbId = created.kb.id;
    const input = {
      kbId,
      email: member.email,
      permissions: ["read"],
      idempotencyKey: crypto.randomUUID(),
    };
    const invite = await shareInvite(runtime, owner.id, input, MEMBERS_MASTER_KEY);
    await shareAccept(runtime, member.id, invite);
    const transferInput = {
      kbId,
      recipientUserId: member.id,
      metadataVersion: created.kb.metadataVersion,
      idempotencyKey: crypto.randomUUID(),
    };
    const transfer = await transferRequest(runtime, owner.id, transferInput);
    const counts = async () => ({
      audit: await prisma.auditEvent.count({ where: { kbId } }),
      mail: await prisma.durableJob.count({
        where: { kind: "KB_EMAIL", desired: { path: ["kbId"], equals: kbId } },
      }),
      invite: await prisma.shareInvitation.findMany({ where: { kbId } }),
      transfer: await prisma.kbTransfer.findMany({ where: { kbId } }),
    });
    const consume = vi.fn(() => {
      throw new Error("replay must be free");
    });
    const replayRuntime = { ...runtime, ratePort: { consume } };
    const replay = async () => {
      const before = await counts();
      await expect(
        shareInvite(replayRuntime, owner.id, input, MEMBERS_MASTER_KEY),
      ).resolves.toEqual(invite);
      await expect(transferRequest(replayRuntime, owner.id, transferInput)).resolves.toEqual(
        transfer,
      );
      expect(await counts()).toEqual(before);
      expect(consume).not.toHaveBeenCalled();
    };
    await replay();
    await prisma.knowledgeBase.update({
      where: { id: kbId },
      data: { metadataVersion: { increment: 1 } },
    });
    await replay(); // Current authorization, historical metadata, no repeated effect.
    for (const loss of ["ban", "2fa"]) {
      const before = await counts();
      await createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] }).update({
        model: "user",
        where: [{ field: "id", value: owner.id }],
        update:
          loss === "ban"
            ? { banned: true, banExpires: new Date(Date.now() + 3600000) }
            : {
                role: "admin",
                twoFactorEnabled: false,
                createdAt: new Date(Date.now() - 2 * 86400000),
              },
      });
      if (loss === "2fa") {
        // The promotion started a fresh grace; age it past its end.
        await prisma.user.update({
          where: { id: owner.id },
          data: { twoFactorGraceStartedAt: new Date(Date.now() - 2 * 86400000) },
        });
      }
      await expect(
        shareInvite(replayRuntime, owner.id, input, MEMBERS_MASTER_KEY),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(transferRequest(replayRuntime, owner.id, transferInput)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(await counts()).toEqual(before);
      await createBootstrapDatabaseAdapter(prisma)({ plugins: [admin(), twoFactor()] }).update({
        model: "user",
        where: [{ field: "id", value: owner.id }],
        update: { banned: false, twoFactorEnabled: true, role: "user" },
      });
      await replay();
    }
    await expect(
      shareInvite(
        replayRuntime,
        owner.id,
        { ...input, permissions: ["manage"] },
        MEMBERS_MASTER_KEY,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(
      transferRequest(replayRuntime, owner.id, { ...transferInput, recipientUserId: owner.id }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    // A fresh current-version request supersedes the pending transfer, then changes ownership.
    const current = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
    const accepted = await transferRequest(runtime, owner.id, {
      ...transferInput,
      metadataVersion: current.metadataVersion,
      idempotencyKey: crypto.randomUUID(),
    });
    await transferAccept(runtime, member.id, accepted);
    // Former owner retains manage for invitations, but transfer still requires exact ownership.
    await expect(shareInvite(replayRuntime, owner.id, input, MEMBERS_MASTER_KEY)).resolves.toEqual(
      invite,
    );
    await expect(transferRequest(replayRuntime, owner.id, transferInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await shareRevoke(runtime, member.id, { kbId, shareUserId: owner.id });
    const before = await counts();
    await expect(
      authorize({
        store: prismaAuthorityStore(prisma),
        principal: { kind: "browser", userId: owner.id },
        kbId,
        operation: "read",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      shareInvite(replayRuntime, owner.id, input, MEMBERS_MASTER_KEY),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(transferRequest(replayRuntime, owner.id, transferInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await counts()).toEqual(before);
  });
});
