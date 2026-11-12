import { existsSync } from "node:fs";
import type { Context } from "@knowledge-base/api/context";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import { prepareExport } from "@knowledge-base/api/lib/kb/exports";
import { configureKbRuntime } from "@knowledge-base/api/lib/kb/runtime";
import { readTransfer } from "@knowledge-base/api/lib/kb/transfers";
import { mintPersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import {
  AUTHORITY_LOCK_CLASSID,
  AUTHORITY_LOCK_OBJID,
  lockIdentityAuthority,
} from "@knowledge-base/db/authority-lock";
import type { PrismaClient } from "@knowledge-base/db/client";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import {
  artifactPath,
  clean,
  commit,
  fixture,
  prisma,
  registerExportHooks,
  request,
  runtime,
  user,
} from "../../../../test-utils/src/kb/export-fixture";
import { HeldLockLease, type LockQuery } from "./lock";

// Default app singleton is not the service DB; all authority/effect SQL uses runtime.prisma.
vi.mock("@knowledge-base/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@knowledge-base/env/server", () => ({ env: { NODE_ENV: "test" } }));
// The RPC budget is tested separately; these fixtures own PostgreSQL only.
vi.mock("../procedure-budget", () => ({ createProcedureBudget: () => async () => {} }));
const { kbExportsRouter } = await import("../../routers/kb-exports");
const { dispatchTool } = await import("../../../../../apps/server/src/mcp/tool-dispatch");
const { createBearerAdmission } = await import("../../../../../apps/server/src/mcp/auth");
const { createKbExportRoutes } = await import("../../../../../apps/server/src/kb-export-routes");
registerExportHooks();
configureKbRuntime(runtime);

async function setup(transport: "rpc" | "zip" | "mcp") {
  const base = await fixture();
  const member = await user();
  await prisma.kbShare.create({ data: { kbId: base.kbId, userId: member.id, bits: ["read"] } });
  const pinned = await commit(base, [], "# Confidential EOF contents\n");
  const browser = { principal: { kind: "browser" as const, userId: member.id } };
  const actor =
    transport === "mcp"
      ? await (async () => {
          const minted = await mintPersonalToken(runtime, member.id, {
            name: "race",
            scopes: ["mcp:read"],
            toolGroups: ["read", "export"],
            acl: [{ kbId: base.kbId, bits: ["read"] }],
            expiresAt: null,
          });
          const bearer = createBearerAdmission({
            origin: runtime.canonicalOrigin,
            withQuery: credentialQuery(runtime.connectionString),
          });
          return bearer(
            new Request(`${runtime.canonicalOrigin}/mcp`, {
              headers: { authorization: `Bearer ${minted.secret}` },
            }),
          );
        })()
      : undefined;
  const descriptor = await prepareExport(runtime, actor ?? browser, request(pinned));
  const session = mockDeep<NonNullable<Context["session"]>>();
  session.user.id = member.id;
  session.user.twoFactorEnabled = true;
  session.user.banned = false;
  const rpc = createRouterClient(kbExportsRouter, {
    context: () => ({ session, clientIp: undefined }),
  });
  const input = { kbId: base.kbId, transferId: descriptor.transferId };
  const revoke = () =>
    prisma.$transaction(async (tx) => {
      await lockIdentityAuthority(tx);
      await tx.kbShare.update({
        where: { kbId_userId: { kbId: base.kbId, userId: member.id } },
        data: { revokedAt: new Date() },
      });
    });
  const read = async () => {
    if (transport === "rpc") return rpc.read({ ...input, offset: 0 });
    if (transport === "mcp" && actor)
      return dispatchTool(
        "knowledge_transfer_read",
        { ...input, offset: 0, maxBytes: 196608 },
        { runtime, actor, signal: new AbortController().signal },
      );
    const mounted = createKbExportRoutes({
      runtime: () => runtime,
      session: async () => ({ user: { id: member.id } }),
    });
    const response = await mounted.request(
      `${runtime.canonicalOrigin}/kb-exports/${base.kbId}/${descriptor.transferId}`,
    );
    if (response.status !== 200) throw new Error(`ZIP refused: ${response.status}`);
    return response.arrayBuffer();
  };
  const ack = () =>
    transport === "mcp" && actor
      ? dispatchTool("knowledge_export_complete", input, {
          runtime,
          actor,
          signal: new AbortController().signal,
        })
      : rpc.complete(input);
  return { input, descriptor, revoke, read, ack, browser, actor };
}

/** Keep the real lazy Prisma request/brand/relations; only delay its await. */
function rendezvous<T extends PromiseLike<unknown>>(
  request: T,
  wait: () => Promise<void>,
  before: boolean,
): T {
  return new Proxy(request, {
    get(target, key, receiver) {
      if (key === "then")
        return (resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          (before
            ? wait().then(() => target)
            : Promise.resolve(target).then(async (row) => {
                await wait();
                return row;
              })
          ).then(resolve, reject);
      return Reflect.get(target, key, receiver);
    },
  });
}

/** Revoke/cancel after the real offset write but before the EOF authority lease. */
function observeBeforeGrace(wait: () => Promise<void>) {
  const original = prisma.$executeRawUnsafe.bind(prisma);
  return vi.spyOn(prisma, "$executeRawUnsafe").mockImplementation((sql, ...params) =>
    rendezvous(
      original(sql, ...params),
      async () => {
        if (sql.includes('SET "offset"=')) await wait();
      },
      false,
    ),
  );
}

describe("R46r4 export authority at persisted EOF and acknowledgement", () => {
  for (const transport of ["rpc", "zip", "mcp"] as const) {
    it(`${transport}: revocation during EOF grace persistence suppresses confidential bytes`, async () => {
      const test = await setup(transport);
      let injected = false;
      const spy = observeBeforeGrace(async () => {
        if (!injected) {
          injected = true;
          await test.revoke();
        }
      });
      try {
        if (transport === "mcp") expect(await test.read()).toMatchObject({ isError: true });
        else await expect(test.read()).rejects.toBeDefined();
        expect(injected).toBe(true);
        await expect(
          readTransfer(runtime, test.browser, { ...test.input, offset: 0 }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        spy.mockRestore();
      }
    });
  }
  it("MCP cancellation at final EOF projection rolls back grace and reclaims before the reply", async () => {
    const test = await setup("mcp");
    const abort = new AbortController();
    let injected = false;
    const original = HeldLockLease.prototype.transaction;
    const spy = vi.spyOn(HeldLockLease.prototype, "transaction").mockImplementation(function <T>(
      this: HeldLockLease,
      work: (query: LockQuery) => Promise<T>,
      reservation = false,
    ): Promise<T> {
      return original.bind(this)(
        (query) =>
          work(async <R>(sql: string, values?: unknown[]) => {
            const result = await query<R>(sql, values);
            if (sql.includes('SET "downloadCompletedAt"')) {
              injected = true;
              abort.abort(new DOMException("Cancelled", "AbortError"));
            }
            return result;
          }),
        reservation,
      );
    });
    try {
      if (!test.actor) throw new Error("Missing actual bearer actor");
      const result = await dispatchTool(
        "knowledge_transfer_read",
        { ...test.input, offset: 0 },
        {
          runtime,
          actor: test.actor,
          signal: abort.signal,
        },
      );
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "CANCELLED" } },
      });
      await clean(test.input.transferId);
      expect(
        (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: test.input.transferId } }))
          .downloadCompletedAt,
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  for (const state of ["expired", "cancelled"] as const) {
    it(`EOF cannot grace an artifact ${state} during the conditional write`, async () => {
      const test = await setup("rpc");
      const spy = observeBeforeGrace(async () => {
        await prisma.exportArtifact.update({
          where: { id: test.input.transferId },
          data: state === "expired" ? { expiresAt: new Date(0) } : { state: "ABORTED" },
        });
      });
      try {
        await expect(test.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(
          (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: test.input.transferId } }))
            .downloadCompletedAt,
        ).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  }
  for (const transport of ["rpc", "mcp"] as const) {
    it(`${transport}: revocation winning the authority gate preserves the artifact on ACK`, async () => {
      const test = await setup(transport);
      await test.revoke();
      if (transport === "mcp") expect(await test.ack()).toMatchObject({ isError: true });
      else await expect(test.ack()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: test.input.transferId } }))
          .state,
      ).toBe("READY");
      expect(existsSync(artifactPath(test.input.transferId))).toBe(true);
    });
    it(`${transport}: a revoke started between ACK authorization and CAS waits for the terminal commit`, async () => {
      const test = await setup(transport);
      let revoked = false;
      let stateAtRevoke: string | undefined;
      let pending: Promise<void> | undefined;
      const transaction = prisma.$transaction.bind(prisma);
      const race = async () => {
        pending = transaction(async (tx) => {
          await lockIdentityAuthority(tx);
          const row = await tx.exportArtifact.findUniqueOrThrow({
            where: { id: test.input.transferId },
          });
          stateAtRevoke = row.state;
          await tx.kbShare.updateMany({
            where: { kbId: test.input.kbId },
            data: { revokedAt: new Date() },
          });
          revoked = true;
        });
        pending.catch(() => {});
        await expect
          .poll(
            async () => {
              if (revoked) return true;
              const rows = await prisma.$queryRaw<
                { waiting: boolean }[]
              >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=${AUTHORITY_LOCK_CLASSID}::oid AND objid=${AUTHORITY_LOCK_OBJID}::oid AND NOT granted) AS waiting`;
              return rows[0]?.waiting;
            },
            { timeout: 2000 },
          )
          .toBe(true);
      };
      const globalRead = prisma.exportArtifact.findUnique.bind(prisma.exportArtifact);
      const oldSpy = vi
        .spyOn(prisma.exportArtifact, "findUnique")
        .mockImplementation((args) => rendezvous(globalRead(args), race, false));
      const originalTransaction = HeldLockLease.prototype.transaction;
      const leaseSpy = vi
        .spyOn(HeldLockLease.prototype, "transaction")
        .mockImplementation(function <T>(
          this: HeldLockLease,
          work: (query: LockQuery) => Promise<T>,
          reservation = false,
        ): Promise<T> {
          return originalTransaction.bind(this)(
            async (query) =>
              work(async <R>(sql: string, values?: unknown[]) => {
                const result = await query<R>(sql, values);
                if (sql.startsWith('SELECT id, "kbId", "actorKey", state FROM "export_artifact"'))
                  await race();
                return result;
              }),
            reservation,
          );
        });
      try {
        const result = await test.ack();
        // MCP's post-effect check may observe revocation; the committed order is the proof.
        if (transport === "rpc")
          expect(result).toEqual({ transferId: test.input.transferId, released: true });
        expect(pending).toBeDefined();
        await pending;
        expect(revoked).toBe(true);
        expect(stateAtRevoke).toBe("ABORTED");
        expect(existsSync(artifactPath(test.input.transferId))).toBe(false);
      } finally {
        oldSpy.mockRestore();
        leaseSpy.mockRestore();
        await pending?.catch(() => {});
      }
    });
  }
});
