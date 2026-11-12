import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { authorizedFrameStream } from "@knowledge-base/api/lib/kb/authorized-stream";
import { createKnowledgeBaseAsGrant } from "@knowledge-base/api/lib/kb/bases";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { type CredentialQuery, credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import {
  runJournalRecoverySweep,
  setKbRecoveryComplete,
} from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { uploadBegin, uploadWrite } from "@knowledge-base/api/lib/kb/uploads";
import { mintPersonalToken, revokePersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { afterAll, describe, expect, it } from "vitest";
import { openKbPostgresClusterFromEnv } from "./index";

type Gate = {
  closed: boolean;
  outstanding: number;
  close(): Promise<void>;
  admit(signal: AbortSignal): { signal: AbortSignal; release(): void } | null;
};
const { createAdmissionGate } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/admission.ts")).href
)) as { createAdmissionGate(): Gate };
type Actor = { principal: TokenPrincipal; verifier: CredentialVerifier; recheck(): Promise<void> };
const {
  createBearerAdmission,
}: {
  createBearerAdmission(options: {
    withQuery: CredentialQuery;
    gate?: Gate;
    origin: string;
    verifyOAuth?(): Promise<Record<string, unknown>>;
  }): (request: Request, options?: { selfRevoke?: boolean }) => Promise<Actor>;
} = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
);
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
const reposDir = mkdtempSync(join(tmpdir(), "kb-admission-repos-"));
const assetsDir = mkdtempSync(join(tmpdir(), "kb-admission-assets-"));
const runtime: KbRuntimeConfig = {
  prisma,
  reposDir,
  assetsDir,
  blobStore: createDiskBlobStore(assetsDir),
  connectionString: db.urls.runtime,
  canonicalOrigin: "https://admission.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
  ratePort: createMemoryRatePort(),
  diskMeter: { freeBytes: async () => 1n << 40n },
  createGitExecutor: () => ({
    exec: ({ cwd, argv, env }) => {
      execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
    },
  }),
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
afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
  rmSync(assetsDir, { recursive: true, force: true });
});
async function fixture() {
  const user = await prisma.user.create({
    data: { name: "Admission", email: `${randomUUID()}@example.invalid`, twoFactorEnabled: true },
  });
  const minted = await mintPersonalToken(runtime, user.id, {
    name: "fixture",
    scopes: ["mcp:write"],
    toolGroups: [...MCP_TOOL_GROUPS],
    acl: [],
    allowCreate: true,
    createdKbBits: ["read", "manage"],
  });
  const admit = createBearerAdmission({
    withQuery: credentialQuery(db.urls.runtime),
    origin: runtime.canonicalOrigin,
    verifyOAuth: async () => {
      throw new Error("PAT never invokes OAuth");
    },
  });
  const request = () =>
    new Request(`${runtime.canonicalOrigin}/mcp`, {
      headers: { authorization: `Bearer ${minted.secret}` },
    });
  return {
    user,
    minted,
    admit,
    request,
    actor: await admit(request()),
    revoke: () => revokePersonalToken(runtime, user.id, minted.token.id),
  };
}
const creation = () => ({
  name: "Admission KB",
  slug: `admit-${randomUUID().slice(0, 8)}`,
  description: "Admission reservation fixture",
  idempotencyKey: randomUUID(),
});

describe("admission through durable authority", () => {
  it("self-revoke admits only the presented PAT generation and leaves siblings live", async () => {
    const f = await fixture();
    const sibling = await mintPersonalToken(runtime, f.user.id, {
      name: "sibling",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    const admitted = await f.admit(f.request(), { selfRevoke: true });
    expect(admitted.principal.credential?.tokenId).toBe(f.minted.token.id);
    await f.revoke();
    await expect(f.admit(f.request(), { selfRevoke: true })).rejects.toBeDefined();
    const live = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: sibling.token.id },
      include: { grant: true },
    });
    expect(live.revokedAt).toBeNull();
    expect(live.grant.revokedAt).toBeNull();
  });
  it("stops a real zero-prefetch stream after revocation between frames", async () => {
    const f = await fixture();
    let frames = 0;
    const stream = authorizedFrameStream({
      signal: new AbortController().signal,
      read: async (offset, deliver) => {
        await f.actor.recheck();
        frames++;
        deliver({
          bytesBase64: Buffer.alloc(256 * 1024).toString("base64"),
          nextOffset: offset + 256 * 1024,
          eof: false,
        });
      },
      discard: async () => {},
    });
    const reader = stream.body.getReader();
    expect((await reader.read()).value?.byteLength).toBe(256 * 1024);
    await f.revoke();
    await expect(reader.read()).rejects.toBeDefined();
    expect(frames).toBe(1);
  });
  it("a mutation paused before reservation is denied with no intent or effects", async () => {
    setKbRecoveryComplete(true);
    const f = await fixture();
    let entered!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const delayed: KbRuntimeConfig = {
      ...runtime,
      coordinator: {
        run: async (options) => {
          entered();
          await released;
          return runtime.coordinator.run(options);
        },
      },
    };
    const pending = createKnowledgeBaseAsGrant(
      delayed,
      f.actor.principal,
      f.actor.verifier,
      creation(),
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await paused;
    await f.revoke();
    resume();
    await rejected;
    expect(
      await prisma.operationIntent.count({
        where: { actorKey: `grant:${f.actor.principal.grantId}` },
      }),
    ).toBe(0);
    expect(await prisma.knowledgeBase.count({ where: { ownerId: f.user.id } })).toBe(0);
  });
  it("COMMITTING recovery finishes exactly once after revoke; private replay remains denied", async () => {
    setKbRecoveryComplete(true);
    const f = await fixture();
    const input = creation();
    const interrupted: KbRuntimeConfig = {
      ...runtime,
      createGitExecutor: (ctx, kbId) => ({
        exec(call) {
          runtime.createGitExecutor!(ctx, kbId).exec(call);
          if (call.argv.includes("update-ref")) throw new Error("fixture crash after publication");
        },
      }),
    };
    await expect(
      createKnowledgeBaseAsGrant(interrupted, f.actor.principal, f.actor.verifier, input),
    ).rejects.toThrow("fixture crash");
    const intent = await prisma.operationIntent.findFirstOrThrow({
      where: {
        actorKey: `grant:${f.actor.principal.grantId}`,
        idempotencyKey: input.idempotencyKey,
      },
    });
    expect(intent.phase).toBe("COMMITTING");
    await f.revoke();
    for (let i = 0; i < 2; i++)
      await runJournalRecoverySweep(prisma, reposDir, assetsDir, db.urls.runtime, () => {});
    expect(
      (await prisma.operationIntent.findUniqueOrThrow({ where: { opId: intent.opId } })).phase,
    ).toBe("FINALIZED");
    expect(await prisma.knowledgeBase.count({ where: { id: intent.reservedKbId! } })).toBe(1);
    expect(await prisma.grantKbAcl.count({ where: { grantId: f.actor.principal.grantId } })).toBe(
      1,
    );
    await expect(
      createKnowledgeBaseAsGrant(runtime, f.actor.principal, f.actor.verifier, input),
    ).rejects.toBeDefined();
  });
  it("staging binds the grant actor and rechecks before continuation", async () => {
    setKbRecoveryComplete(true);
    const f = await fixture();
    const created = await createKnowledgeBaseAsGrant(
      runtime,
      f.actor.principal,
      f.actor.verifier,
      creation(),
    );
    const kbId = (created.kb as { id: string }).id;
    const begun = await uploadBegin(runtime, f.actor, assetsDir, {
      kbId,
      kind: "markdown",
      // Uploads are 1+ bytes (writes carry 1..196608 bytes); this is the "x" written below,
      // so only the revocation can reject that write.
      size: 1,
      contentHash: "sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      mime: "text/markdown",
      idempotencyKey: randomUUID(),
    });
    expect(
      (await prisma.stagedUpload.findUniqueOrThrow({ where: { id: begun.uploadId } })).actorKey,
    ).toBe(`grant:${f.actor.principal.grantId}`);
    await f.revoke();
    await expect(
      uploadWrite(runtime, f.actor, assetsDir, {
        kbId,
        uploadId: begun.uploadId,
        offset: 0,
        bytesBase64: "eA==",
      }),
    ).rejects.toBeDefined();
  });
});

describe("owned credential SQL and forced-2FA authority", () => {
  it.each(["policy", "role", "enrollment"])(
    "committed %s change wins before waiting admission without stale tombstones",
    async (change) => {
      const f = await fixture();
      await prisma.user.update({
        where: { id: f.user.id },
        data: { role: "admin", twoFactorEnabled: false, createdAt: new Date(0) },
      });
      await prisma.appSetting.upsert({
        where: { key: "force2faInternalUsers" },
        create: { key: "force2faInternalUsers", value: "true" },
        update: { value: "true" },
      });
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const wait = new Promise<void>((r) => {
        release = r;
      });
      const writer = runLockedOperation({
        connectionString: db.urls.runtime,
        opId: randomUUID(),
        kind: "authority",
        run: (lease) =>
          lease.transaction(async (q) => {
            if (change === "policy")
              await q(`UPDATE app_setting SET value='false' WHERE key='force2faInternalUsers'`);
            else if (change === "role")
              await q(`UPDATE "user" SET role='user' WHERE id=$1`, [f.user.id]);
            else await q('UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1', [f.user.id]);
            entered();
            await wait;
          }),
      });
      await ready;
      const pending = f.admit(f.request());
      // Yield to the real waiting PG transaction, then commit the authorized change.
      await new Promise((r) => setTimeout(r, 100));
      release();
      await writer;
      await expect(pending).resolves.toBeDefined();
      const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: f.minted.token.id },
        include: { grant: true },
      });
      expect(pat.revokedAt).toBeNull();
      expect(pat.grant.revokedAt).toBeNull();
      await prisma.appSetting.update({
        where: { key: "force2faInternalUsers" },
        data: { value: "true" },
      });
    },
  );
  it("expired enforced grace atomically revokes all standing credentials and enrollment cannot resurrect them", async () => {
    const f = await fixture();
    const sibling = await mintPersonalToken(runtime, f.user.id, {
      name: "sibling",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [],
    });
    await prisma.user.update({
      where: { id: f.user.id },
      data: { role: "admin", twoFactorEnabled: false, createdAt: new Date(0) },
    });
    await expect(f.admit(f.request())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const id of [f.minted.token.id, sibling.token.id]) {
      const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id },
        include: { grant: true },
      });
      expect(pat.revokedAt).not.toBeNull();
      expect(pat.grant.revokedAt).not.toBeNull();
      expect(pat.grant.revokeReason).toBe("forced_2fa");
    }
    await prisma.user.update({ where: { id: f.user.id }, data: { twoFactorEnabled: true } });
    await expect(f.admit(f.request())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("enrollment grace preserves grants, and failure after the tombstone write rolls back both", async () => {
    const f = await fixture();
    await prisma.user.update({
      where: { id: f.user.id },
      data: { role: "admin", twoFactorEnabled: false },
    });
    await expect(f.admit(f.request())).resolves.toBeDefined();
    expect(
      (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: f.minted.token.id } }))
        .revokedAt,
    ).toBeNull();
    await prisma.user.update({ where: { id: f.user.id }, data: { createdAt: new Date(0) } });
    let tokenUpdated = false;
    const owned = credentialQuery(db.urls.runtime);
    const fail = createBearerAdmission({
      origin: runtime.canonicalOrigin,
      withQuery: (signal, run) =>
        owned(signal, (q) =>
          run(async <R>(sql: string, params?: unknown[]) => {
            const result = await q<R>(sql, params);
            // R30 writes both tombstones in one statement (grant CTE + PAT
            // update). Fail after it executes, inside the same transaction.
            if (sql.includes('UPDATE "mcp_grant"') && sql.includes('UPDATE "mcp_personal_token"')) {
              tokenUpdated = true;
              throw new Error("injected failure after tombstones");
            }
            return result;
          }),
        ),
    });
    await expect(fail(f.request())).rejects.toThrow("injected failure after tombstones");
    expect(tokenUpdated).toBe(true);
    const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: f.minted.token.id },
      include: { grant: true },
    });
    expect(pat.revokedAt).toBeNull();
    expect(pat.grant.revokedAt).toBeNull();
    await prisma.user.update({ where: { id: f.user.id }, data: { twoFactorEnabled: true } });
    await expect(f.admit(f.request())).resolves.toBeDefined();
  });

  it("shutdown owns and cancels media-verifier SQL continuations, then refuses re-entry", async () => {
    const f = await fixture();
    const gate = createAdmissionGate();
    const owned = credentialQuery(db.urls.runtime);
    let stalled = false;
    let pid = 0;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const admit = createBearerAdmission({
      origin: runtime.canonicalOrigin,
      gate,
      withQuery: (signal, run) =>
        owned(signal, (q) =>
          run(async <R>(sql: string, params?: unknown[]) => {
            if (stalled && sql.includes('FROM "mcp_grant"')) {
              pid = (await q<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
              entered();
              await q("SELECT pg_sleep(60)");
            }
            return q<R>(sql, params);
          }),
        ),
    });
    const actor = await admit(f.request());
    stalled = true;
    const pending = actor.recheck();
    const denied = expect(pending).rejects.toBeDefined();
    await ready;
    expect(gate.outstanding).toBe(1);
    const started = Date.now();
    await gate.close();
    await denied;
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(gate.outstanding).toBe(0);
    await expect(actor.recheck()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(admit(f.request())).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(
      (await db.query("runtime", "SELECT pid FROM pg_stat_activity WHERE pid=$1", [pid])).rows,
    ).toHaveLength(0);
  });

  it("an unheld query adapter cannot bypass the owned credential I/O port", async () => {
    const f = await fixture();
    const sql = credentialQuery(db.urls.runtime);
    let sessions = 0;
    const admit = createBearerAdmission({
      origin: runtime.canonicalOrigin,
      withQuery: (signal, run) => {
        sessions++;
        return sql(signal, run);
      },
    });
    const actor = await admit(f.request());
    const before = sessions;
    const rebound = actor.verifier.forQuery!(async () => {
      throw new Error("unowned adapter used for credentials");
    });
    await expect(rebound.inspect(actor.principal)).resolves.toMatchObject({
      generationActive: true,
    });
    expect(await rebound.grantBits!(actor.principal, "unheld-read")).toEqual([]);
    expect(sessions).toBe(before + 2);
  });
  it.each(["authority", "kb"] as const)(
    "live inspect/grantBits reuse an inherited %s lease without opening a second SQL session",
    async (kind) => {
      const f = await fixture();
      const sql = credentialQuery(db.urls.runtime);
      let sessions = 0;
      const admit = createBearerAdmission({
        origin: runtime.canonicalOrigin,
        withQuery: (signal, run) => {
          sessions++;
          return sql(signal, run);
        },
      });
      const actor = await admit(f.request());
      const before = sessions;
      await runLockedOperation({
        connectionString: db.urls.runtime,
        opId: randomUUID(),
        kind: kind === "authority" ? "authority" : "kb-write",
        ...(kind === "kb" ? { kbIds: ["inherited-credential-read"] } : {}),
        run: (lease) =>
          lease.transaction(async () => {
            expect(lease.holdingAuthority()).toBe(kind === "authority");
            await actor.recheck();
            expect(
              await actor.verifier.grantBits!(actor.principal, "inherited-credential-read"),
            ).toEqual([]);
            expect(sessions).toBe(before);
          }),
      });
      // Re-entry after the parent closes returns to the ordinary owned port.
      await actor.recheck();
      expect(sessions).toBe(before + 1);
    },
  );
  it("real SQL stall settles admission within its default deadline and drains the owned transaction", async () => {
    const f = await fixture();
    const gate = createAdmissionGate();
    const owned = credentialQuery(db.urls.runtime);
    let pid = 0;
    const admit = createBearerAdmission({
      origin: runtime.canonicalOrigin,
      gate,
      withQuery: (signal, run) =>
        owned(signal, async (q) => {
          pid = (await q<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          await q("SELECT pg_sleep(60)");
          return run(q);
        }),
    });
    const started = Date.now();
    await expect(admit(f.request())).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(32_000);
    expect(pid).toBeGreaterThan(0);
    await gate.close();
    expect(gate.outstanding).toBe(0);
    expect(
      (await db.query("runtime", "SELECT pid FROM pg_stat_activity WHERE pid=$1", [pid])).rows,
    ).toHaveLength(0);
  }, 40_000);
  it("joins real stalled SQL cancellation before a successor obtains the authority lock", async () => {
    const query = credentialQuery(db.urls.runtime);
    const controller = new AbortController();
    let pid = 0;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const pending = query(controller.signal, async (q) => {
      pid = (await q<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      entered();
      await q("SELECT pg_sleep(60)");
    });
    const rejected = expect(pending).rejects.toBeDefined();
    await ready;
    // Confirm pg_sleep, not a mock or queued callback, owns the wait.
    for (let n = 0; n < 100; n++) {
      const state = await db.query(
        "runtime",
        "SELECT query,state FROM pg_stat_activity WHERE pid=$1",
        [pid],
      );
      if (state.rows[0]?.query === "SELECT pg_sleep(60)" && state.rows[0]?.state === "active")
        break;
      if (n === 99) throw new Error("SQL stall not reached");
      await new Promise((r) => setTimeout(r, 10));
    }
    const started = Date.now();
    controller.abort();
    const successor = query(new AbortController().signal, (q) => q("SELECT 1"));
    await rejected;
    expect(Date.now() - started).toBeLessThan(3_000);
    await successor;
    expect(
      (await db.query("runtime", "SELECT pid FROM pg_stat_activity WHERE pid=$1", [pid])).rows,
    ).toHaveLength(0);
    await expect(
      query(controller.signal, () => {
        throw new Error("pre-abort ran");
      }),
    ).rejects.toBeDefined();
  });
});
