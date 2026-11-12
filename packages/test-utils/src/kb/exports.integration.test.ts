import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { casBlobPath, createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import {
  EXPORT_LIMITS,
  prepareExport,
  reclaimExports,
  startExportLifecycle,
} from "@knowledge-base/api/lib/kb/exports";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { completeExport, downloadExport, readTransfer } from "@knowledge-base/api/lib/kb/transfers";
import { mintPersonalToken, revokePersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import type { Prisma } from "@knowledge-base/db/client";
import { Client, type QueryResult } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactPath,
  asset,
  assetsDir,
  clean,
  commit,
  fixture,
  frames,
  prisma,
  registerExportHooks,
  released,
  request,
  root,
  runtime,
  s3Sources,
  user,
} from "./export-fixture";

type Bearer = (
  request: Request,
) => Promise<{ principal: TokenPrincipal; verifier: CredentialVerifier }>;
const { createBearerAdmission } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
)) as {
  createBearerAdmission(options: {
    origin: string;
    withQuery: ReturnType<typeof credentialQuery>;
  }): Bearer;
};
const { createKbExportRoutes } = (await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/kb-export-routes.ts"))
    .href
)) as {
  createKbExportRoutes(options: {
    runtime(): KbRuntimeConfig;
    bearer?: Bearer;
    session(): Promise<{ user: { id: string } } | null>;
  }): { request(url: string, init?: RequestInit): Promise<Response> };
};

type ExportAction = () => Promise<void>;
let preparation: Promise<ExportAction> | undefined;
let execution: Promise<void> | undefined;
async function drainPreparation() {
  // A timed-out hook retains this promise until its native fixture work has settled.
  await preparation?.catch(() => undefined);
}
async function drainCase() {
  // Original hooks/tests own failures; these catches only join their work for cleanup.
  await drainPreparation();
  await execution?.catch(() => undefined);
}
registerExportHooks({ drainWork: drainCase });

function preparedCase(name: string, prepare: () => Promise<ExportAction>) {
  describe(name, () => {
    let action: ExportAction;
    beforeEach(async () => {
      // Never overwrite the owner of a previous timed-out or rejected setup.
      await drainCase();
      execution = undefined;
      preparation = prepare();
      action = await preparation;
    }, 60_000);
    it("enforces the export invariant", () => {
      execution = action();
      return execution;
    });
  });
}

function barrier() {
  let release = () => {};
  const wait = new Promise<void>((done) => {
    release = done;
  });
  return { wait, release };
}

/** Pause actual EOF SQL on the authority lease; authorization, row lock and rollback stay real. */
function observeGrace(hook: (update: () => Promise<number>) => Promise<number>): KbRuntimeConfig {
  return {
    ...runtime,
    coordinator: {
      run: (options) =>
        runtime.coordinator.run({
          ...options,
          run: (context) =>
            options.run({
              ...context,
              lease: new Proxy(context.lease, {
                get(lease, key, receiver) {
                  if (key !== "transaction") return Reflect.get(lease, key, receiver);
                  return <T>(work: (query: LockQuery) => Promise<T>, reservation = false) =>
                    lease.transaction(
                      (query) =>
                        work(async <R>(sql: string, values?: unknown[]) => {
                          if (!sql.includes('SET "downloadCompletedAt"'))
                            return query<R>(sql, values);
                          let result: QueryResult<R> | undefined;
                          await hook(async () => {
                            result = await query<R>(sql, values);
                            return result.rowCount ?? 0;
                          });
                          if (!result) throw new Error("Grace hook must execute the actual SQL");
                          return result;
                        }),
                      reservation,
                    );
                },
              }),
            }),
        }),
    },
  };
}

describe("exports real Git/CAS/SQL", () => {
  for (const kind of ["signal", "shutdown"] as const) {
    preparedCase(`R46r1 F2: ${kind} joins actual row/file cleanup before failure`, async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      return async () => {
        const lifecycle = await startExportLifecycle(runtime);
        const descriptor = await prepareExport(runtime, base.actor, request(pinned));
        const entered = barrier();
        const resume = barrier();
        const controlled = {
          ...runtime,
          prisma: new Proxy(prisma, {
            get(target, key, receiver) {
              if (key !== "exportArtifact") return Reflect.get(target, key, receiver);
              return new Proxy(target.exportArtifact, {
                get(model, method, modelReceiver) {
                  if (method !== "updateMany") return Reflect.get(model, method, modelReceiver);
                  return async (args: Prisma.ExportArtifactUpdateManyArgs) => {
                    entered.release();
                    await resume.wait;
                    return model.updateMany(args);
                  };
                },
              });
            },
          }),
        };
        const abort = new AbortController();
        const mounted = createKbExportRoutes({
          runtime: () => controlled,
          session: async () => ({ user: { id: base.actor.principal.userId } }),
        });
        const response = await mounted.request(
          `${runtime.canonicalOrigin}/kb-exports/${base.kbId}/${descriptor.transferId}`,
          { signal: abort.signal },
        );
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect((await reader.read()).value).toHaveLength(196608);
        let observed = false;
        let stopped = false;
        let stopping: Promise<void> | undefined;
        if (kind === "signal") abort.abort();
        else {
          // Production closes write admission before export lifecycle shutdown.
          controlled.coordinator = {
            run: async () => {
              throw new Error("write admission closed");
            },
          };
          stopping = lifecycle.stop().then(() => {
            stopped = true;
          });
        }
        const refused = expect(
          reader.read().finally(() => {
            observed = true;
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
        try {
          await entered.wait;
          expect(observed).toBe(false);
          expect(stopped).toBe(false);
          expect(
            await prisma.exportArtifact.findUniqueOrThrow({ where: { id: descriptor.transferId } }),
          ).toMatchObject({ state: "READY", reclaimedAt: null });
          expect(existsSync(artifactPath(descriptor.transferId))).toBe(true);
          resume.release();
          await Promise.all([refused, stopping]);
          await clean(descriptor.transferId);
          const next = await prepareExport(runtime, base.actor, request(pinned));
          await completeExport(runtime, base.actor, {
            kbId: base.kbId,
            transferId: next.transferId,
          });
        } finally {
          resume.release();
          await Promise.allSettled([refused, stopping]);
          await lifecycle.stop();
        }
      };
    });
  }
  preparedCase("R46r1 F2: shutdown owns pending admission before body creation", async () => {
    const base = await fixture();
    return async () => {
      const lifecycle = await startExportLifecycle(runtime);
      const descriptor = await prepareExport(runtime, base.actor, request(base, "assets"));
      const entered = barrier();
      const resume = barrier();
      let first = true;
      const controlled = {
        ...runtime,
        prisma: new Proxy(prisma, {
          get(target, key, receiver) {
            if (key !== "exportArtifact") return Reflect.get(target, key, receiver);
            return new Proxy(target.exportArtifact, {
              get(model, method, modelReceiver) {
                if (method !== "findUnique") return Reflect.get(model, method, modelReceiver);
                return async (args: Prisma.ExportArtifactFindUniqueArgs) => {
                  if (first) {
                    first = false;
                    entered.release();
                    await resume.wait;
                  }
                  return model.findUnique(args);
                };
              },
            });
          },
        }),
      };
      const opening = downloadExport(controlled, base.actor, {
        kbId: base.kbId,
        transferId: descriptor.transferId,
        signal: new AbortController().signal,
      });
      await entered.wait;
      let stopped = false;
      const stopping = lifecycle.stop().then(() => {
        stopped = true;
      });
      try {
        await Promise.resolve();
        expect(stopped).toBe(false);
        resume.release();
        const { body } = await opening;
        await expect(body.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
        await stopping;
        await clean(descriptor.transferId);
      } finally {
        resume.release();
        await Promise.allSettled([opening, stopping]);
      }
    };
  });
  for (const kind of ["revoke", "signal", "successful-sibling"] as const) {
    preparedCase(`R46r1 F3: first EOF ${kind} owns only its completed delivery`, async () => {
      const base = await fixture();
      const member = await user();
      await prisma.kbShare.create({ data: { kbId: base.kbId, userId: member.id, bits: ["read"] } });
      const actor = { principal: { kind: "browser" as const, userId: member.id } };
      const other = await fixture();
      await prisma.kbShare.create({
        data: { kbId: other.kbId, userId: member.id, bits: ["read"] },
      });
      return async () => {
        const descriptor = await prepareExport(runtime, actor, request(base, "assets"));
        const entered = barrier();
        const resume = barrier();
        const controlled =
          kind === "successful-sibling"
            ? {
                ...runtime,
                prisma: new Proxy(prisma, {
                  get(target, key, receiver) {
                    if (key !== "$executeRawUnsafe") return Reflect.get(target, key, receiver);
                    return async (sql: string, ...values: unknown[]) => {
                      const changed = await target.$executeRawUnsafe(sql, ...values);
                      if (sql.includes('SET "offset"')) {
                        entered.release();
                        await resume.wait;
                      }
                      return changed;
                    };
                  },
                }),
              }
            : observeGrace(async (update) => {
                const changed = await update();
                entered.release();
                await resume.wait;
                return changed;
              });
        const abort = new AbortController();
        const { body } = await downloadExport(controlled, actor, {
          kbId: base.kbId,
          transferId: descriptor.transferId,
          signal: abort.signal,
        });
        const reader = body.getReader();
        const reading = reader.read();
        const refused = expect(reading).rejects.toMatchObject(
          kind === "revoke" ? { code: "NOT_FOUND" } : { name: "AbortError" },
        );
        try {
          await entered.wait;
          if (kind === "successful-sibling") {
            expect(
              (
                await readTransfer(runtime, actor, {
                  kbId: base.kbId,
                  transferId: descriptor.transferId,
                  offset: 0,
                })
              ).eof,
            ).toBe(true);
          }
          if (kind === "revoke") {
            await prisma.kbShare.update({
              where: { kbId_userId: { kbId: base.kbId, userId: member.id } },
              data: { revokedAt: new Date() },
            });
          } else abort.abort();
          resume.release();
          await refused;
          if (kind === "successful-sibling") {
            const retained = await prisma.exportArtifact.findUniqueOrThrow({
              where: { id: descriptor.transferId },
            });
            expect(retained).toMatchObject({ state: "READY", reclaimedAt: null });
            expect(retained.downloadCompletedAt).not.toBeNull();
            expect(existsSync(artifactPath(descriptor.transferId))).toBe(true);
            expect(
              (
                await readTransfer(runtime, actor, {
                  kbId: base.kbId,
                  transferId: descriptor.transferId,
                  offset: 0,
                })
              ).eof,
            ).toBe(true);
            await completeExport(runtime, actor, {
              kbId: base.kbId,
              transferId: descriptor.transferId,
            });
          } else {
            await clean(descriptor.transferId);
            expect(
              (
                await prisma.exportArtifact.findUniqueOrThrow({
                  where: { id: descriptor.transferId },
                })
              ).downloadCompletedAt,
            ).toBeNull();
            const next = await prepareExport(runtime, actor, request(other, "assets"));
            await completeExport(runtime, actor, { kbId: other.kbId, transferId: next.transferId });
          }
        } finally {
          resume.release();
          await Promise.allSettled([reading, refused]);
        }
      };
    });
  }
  preparedCase(
    "F1: a stale wall-clock sweep cannot reclaim EOF grace committed after row contention",
    async () => {
      const base = await fixture();
      const descriptor = await prepareExport(runtime, base.actor, request(base, "assets"));
      return async () => {
        const selected = barrier();
        const resumeSweep = barrier();
        const observed = new Proxy(prisma, {
          get(target, key, receiver) {
            if (key !== "exportArtifact") return Reflect.get(target, key, receiver);
            return new Proxy(target.exportArtifact, {
              get(model, method, modelReceiver) {
                if (method !== "findMany") return Reflect.get(model, method, modelReceiver);
                return async (args: Prisma.ExportArtifactFindManyArgs) => {
                  const rows = await model.findMany(args);
                  if (rows.some((row) => row.id === descriptor.transferId)) {
                    selected.release();
                    await resumeSweep.wait;
                  }
                  return rows;
                };
              },
            });
          },
        });
        // Let the offset write finish; block only the actual EOF grace UPDATE.
        const graceEntered = barrier();
        const graceSubmit = barrier();
        const eofRuntime = observeGrace(async (update) => {
          graceEntered.release();
          await graceSubmit.wait;
          return update();
        });
        const blocker = new Client({ connectionString: runtime.connectionString });
        await blocker.connect();
        let eof: ReturnType<typeof readTransfer> | undefined;
        let sweep: ReturnType<typeof reclaimExports> | undefined;
        try {
          // Expiry stays well inside the grace window but far enough ahead that
          // admission and the EOF UPDATE cannot race real time. The sweep below
          // gets a stale clock at exactly this expiry instead of waiting for it.
          await prisma.$executeRawUnsafe(
            `UPDATE "export_artifact" SET "expiresAt"=clock_timestamp()+interval '60 seconds' WHERE id=$1::uuid`,
            descriptor.transferId,
          );
          eof = readTransfer(eofRuntime, base.actor, {
            kbId: base.kbId,
            transferId: descriptor.transferId,
            offset: 0,
          });
          await graceEntered.wait;
          await blocker.query("BEGIN");
          await blocker.query(`SELECT id FROM "export_artifact" WHERE id=$1::uuid FOR UPDATE`, [
            descriptor.transferId,
          ]);
          graceSubmit.release();
          // Readiness only: the EOF UPDATE is queued behind the row lock.
          await vi.waitFor(
            async () => {
              const rows = await prisma.$queryRawUnsafe<{ count: number }[]>(
                `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE "export_artifact" SET "downloadCompletedAt"%'`,
              );
              expect(rows[0]?.count).toBe(1);
            },
            { timeout: 20_000, interval: 10 },
          );
          const stale = await prisma.exportArtifact.findUniqueOrThrow({
            where: { id: descriptor.transferId },
          });
          // The stale sweep's clock is exactly the committed expiry (lte matches).
          expect(stale).toMatchObject({ state: "READY", downloadCompletedAt: null });
          const cutoff = stale.expiresAt;
          sweep = reclaimExports({ ...runtime, prisma: observed }, { now: cutoff });
          await selected.wait;
          await blocker.query("COMMIT");
          expect((await eof).eof).toBe(true);
          const graced = await prisma.exportArtifact.findUniqueOrThrow({
            where: { id: descriptor.transferId },
          });
          expect(graced.state).toBe("READY");
          // The EOF statement began before the expiry the sweep acts on.
          expect(graced.downloadCompletedAt!.getTime()).toBeLessThan(cutoff.getTime());
          expect(graced.expiresAt.getTime()).toBeGreaterThan(cutoff.getTime());
          expect(graced.expiresAt.getTime() - Date.now()).toBeGreaterThan(590000);
          resumeSweep.release();
          await sweep;
          const retained = await prisma.exportArtifact.findUniqueOrThrow({
            where: { id: descriptor.transferId },
          });
          expect(retained).toMatchObject({ state: "READY", reclaimedAt: null });
          expect(retained.expiresAt).toEqual(graced.expiresAt);
          expect(existsSync(artifactPath(descriptor.transferId))).toBe(true);
          expect(
            (
              await readTransfer(runtime, base.actor, {
                kbId: base.kbId,
                transferId: descriptor.transferId,
                offset: 0,
              })
            ).eof,
          ).toBe(true);
          await completeExport(runtime, base.actor, {
            kbId: base.kbId,
            transferId: descriptor.transferId,
          });
          await released(descriptor.transferId, "DOWNLOADED");
        } finally {
          graceSubmit.release();
          resumeSweep.release();
          await blocker.query("ROLLBACK");
          await blocker.end();
          await Promise.allSettled([eof, sweep]);
        }
      };
    },
  );
  preparedCase(
    "F1 inverse: reclamation commits before unlink; a later EOF cannot resurrect the artifact",
    async () => {
      const base = await fixture();
      const descriptor = await prepareExport(runtime, base.actor, request(base, "assets"));
      return async () => {
        const entered = barrier();
        const resume = barrier();
        const controlled = {
          ...runtime,
          prisma: new Proxy(prisma, {
            get(target, key, receiver) {
              if (key !== "$executeRawUnsafe") return Reflect.get(target, key, receiver);
              return async (sql: string, ...values: unknown[]) => {
                const changed = await target.$executeRawUnsafe(sql, ...values);
                if (sql.includes('SET "offset"')) {
                  entered.release();
                  await resume.wait;
                }
                return changed;
              };
            },
          }),
        };
        const eof = readTransfer(controlled, base.actor, {
          kbId: base.kbId,
          transferId: descriptor.transferId,
          offset: 0,
        });
        const refused = expect(eof).rejects.toMatchObject({ code: "NOT_FOUND" });
        try {
          await entered.wait;
          // Hold after frame/offset admission, before the EOF authority lease.
          // Reclamation wins that lease and commits before this EOF can start.
          await prisma.$executeRawUnsafe(
            `UPDATE "export_artifact" SET "expiresAt"=clock_timestamp() WHERE id=$1::uuid`,
            descriptor.transferId,
          );
          await vi.waitFor(
            async () => {
              const row = await prisma.exportArtifact.findUniqueOrThrow({
                where: { id: descriptor.transferId },
              });
              expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
            },
            { timeout: 3000, interval: 20 },
          );
          // Fail directory traversal only AFTER terminal intent committed. Restart
          // retries the recoverable cleanup; it must never restore READY.
          const unavailable = {
            ...runtime,
            assetsDir: `${assetsDir}/missing`,
            blobStore: createDiskBlobStore(`${assetsDir}/missing`),
          };
          await expect(reclaimExports(unavailable)).rejects.toThrow();
          expect(
            await prisma.exportArtifact.findUniqueOrThrow({ where: { id: descriptor.transferId } }),
          ).toMatchObject({ state: "ABORTED", reclaimedAt: null });
          expect(existsSync(artifactPath(descriptor.transferId))).toBe(true);
          await reclaimExports(runtime, { restart: true });
          await clean(descriptor.transferId);
          resume.release();
          await refused;
          expect(
            await prisma.exportArtifact.findUniqueOrThrow({ where: { id: descriptor.transferId } }),
          ).toMatchObject({ state: "ABORTED", downloadCompletedAt: null });
        } finally {
          resume.release();
          await Promise.allSettled([eof]);
        }
      };
    },
  );
  preparedCase("joins delayed fixture work before cleanup or re-entry", async () => {
    const base = await fixture();
    return async () => {
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = (async () => {
        entered();
        await resume;
        expect(existsSync(root)).toBe(true);
        expect(
          (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: base.kbId } })).state,
        ).toBe("ACTIVE");
        return async () => {};
      })();
      preparation = pending;
      await ready;
      let joined = false;
      const joining = drainPreparation().then(() => {
        joined = true;
      });
      try {
        await Promise.resolve();
        expect(joined).toBe(false);
        expect(existsSync(root)).toBe(true);
      } finally {
        release();
        await joining;
      }
      await pending;
      expect(joined).toBe(true);
    };
  });
  preparedCase(
    "mounted bearer ZIP reads real Git/CAS bytes and stops after exact PAT revocation",
    async () => {
      const base = await fixture();
      const entry = await asset(base);
      const pinned = await commit(base, [entry]);
      const minted = await mintPersonalToken(runtime, base.actor.principal.userId, {
        name: "zip",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: base.kbId, bits: ["read"] }],
        expiresAt: null,
      });
      const bearer = createBearerAdmission({
        origin: runtime.canonicalOrigin,
        withQuery: credentialQuery(runtime.connectionString),
      });
      const authorization = `Bearer ${minted.secret}`;
      const actor = await bearer(
        new Request(`${runtime.canonicalOrigin}/mcp`, { headers: { authorization } }),
      );
      return async () => {
        const descriptor = await prepareExport(runtime, actor, request(pinned));
        const mounted = createKbExportRoutes({
          runtime: () => runtime,
          bearer,
          session: async () => {
            throw new Error("Bearer ZIP must not use cookies");
          },
        });
        const response = await mounted.request(
          `${runtime.canonicalOrigin}/kb-exports/${base.kbId}/${descriptor.transferId}`,
          { headers: { authorization } },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/zip");
        const reader = response.body!.getReader();
        const first = (await reader.read()).value!;
        expect(first.byteLength).toBe(196608);
        expect(Buffer.from(first.subarray(0, 4)).toString("hex")).toBe("504b0304");
        await revokePersonalToken(runtime, base.actor.principal.userId, minted.token.id);
        await expect(reader.read()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        await clean(descriptor.transferId);
      };
    },
  );
  preparedCase(
    "removing only the export tool group stops the next ZIP frame and refuses a new download",
    async () => {
      const base = await fixture();
      const entry = await asset(base);
      const pinned = await commit(base, [entry]);
      const minted = await mintPersonalToken(runtime, base.actor.principal.userId, {
        name: "zip",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: base.kbId, bits: ["read"] }],
        expiresAt: null,
      });
      const bearer = createBearerAdmission({
        origin: runtime.canonicalOrigin,
        withQuery: credentialQuery(runtime.connectionString),
      });
      const authorization = `Bearer ${minted.secret}`;
      const actor = await bearer(
        new Request(`${runtime.canonicalOrigin}/mcp`, { headers: { authorization } }),
      );
      return async () => {
        const descriptor = await prepareExport(runtime, actor, request(pinned));
        const mounted = createKbExportRoutes({
          runtime: () => runtime,
          bearer,
          session: async () => {
            throw new Error("Bearer ZIP must not use cookies");
          },
        });
        const response = await mounted.request(
          `${runtime.canonicalOrigin}/kb-exports/${base.kbId}/${descriptor.transferId}`,
          { headers: { authorization } },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/zip");
        const reader = response.body!.getReader();
        const first = (await reader.read()).value!;
        expect(first.byteLength).toBe(196608);
        expect(Buffer.from(first.subarray(0, 4)).toString("hex")).toBe("504b0304");
        const { grantId } = await prisma.mcpPersonalToken.findUniqueOrThrow({
          where: { id: minted.token.id },
          select: { grantId: true },
        });
        // The grant stays otherwise valid: only `export` is removed.
        await prisma.mcpGrant.update({
          where: { id: grantId },
          data: { toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "export") },
        });
        await expect(reader.read()).rejects.toMatchObject({ code: "FORBIDDEN" });
        const refused = await mounted.request(
          `${runtime.canonicalOrigin}/kb-exports/${base.kbId}/${descriptor.transferId}`,
          { headers: { authorization } },
        );
        expect(refused.status).toBe(403);
        expect(refused.headers.get("content-type")).not.toBe("application/zip");
        await clean(descriptor.transferId);
      };
    },
  );
  preparedCase("empty assets ZIP is a valid empty archive", async () => {
    const base = await fixture();
    return async () => {
      const descriptor = await prepareExport(runtime, base.actor, request(base, "assets"));
      expect(descriptor.size).toBe(22);
      execFileSync("python3", [
        "-c",
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==[]; assert z.testzip() is None",
        artifactPath(descriptor.transferId),
      ]);
      const bytes = await frames(base, descriptor.transferId);
      expect(bytes.length).toBe(22);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
        descriptor.contentHash,
      );
    };
  });
  preparedCase("whole export pins immutable bytes and replays one audited receipt", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    const input = request(pinned);
    return async () => {
      const descriptor = await prepareExport(runtime, base.actor, input);
      expect(descriptor.rev).toBe(pinned.rev);
      await commit(pinned, [], "# Later\n");
      expect(await prepareExport(runtime, base.actor, input)).toEqual(descriptor);
      await expect(
        prepareExport(runtime, base.actor, { ...input, kind: "assets" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
      execFileSync("python3", [
        "-c",
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert set(z.namelist())=={'index.md','.gitignore','.assets/manifest.json','media/data.wav'}; assert z.read('index.md')==b'# Pinned\\n'; assert z.testzip() is None",
        artifactPath(descriptor.transferId),
      ]);
      expect(
        await prisma.auditEvent.count({
          where: { opId: descriptor.operationId, action: "export_prepare" },
        }),
      ).toBe(1);
    };
  });
  preparedCase(
    "browser download and framed transfer return the same complete artifact",
    async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      return async () => {
        const descriptor = await prepareExport(runtime, base.actor, request(pinned));
        const bytes = await frames(base, descriptor.transferId);
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
          descriptor.contentHash,
        );
        // This exact artifact stays readable during grace. Compare both
        // transports on it; a second export is unnecessary fixture work.
        const response = await downloadExport(runtime, base.actor, {
          kbId: base.kbId,
          transferId: descriptor.transferId,
          signal: new AbortController().signal,
        });
        const browserBytes = Buffer.from(await new Response(response.body).arrayBuffer());
        expect(browserBytes).toEqual(bytes);
        expect(browserBytes.length).toBe(descriptor.size);
        expect(
          (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: descriptor.transferId } }))
            .offset,
        ).toBe(descriptor.size);
      };
    },
  );
  preparedCase("concurrent prepares by one user stay limited to one slot", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    return async () => {
      const racing = await Promise.allSettled([
        prepareExport(runtime, base.actor, request(pinned)),
        prepareExport(runtime, base.actor, request(pinned)),
      ]);
      const admitted = racing.filter((r) => r.status === "fulfilled");
      const refused = racing.filter((r) => r.status === "rejected");
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "RATE_LIMITED" });
      const first = (
        admitted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof prepareExport>>>
      ).value;
      // While the artifact is ready and not yet acknowledged, the slot is held.
      await expect(prepareExport(runtime, base.actor, request(pinned))).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
      // A partial download (not EOF) keeps the slot too.
      await readTransfer(runtime, base.actor, {
        kbId: base.kbId,
        transferId: first.transferId,
        offset: 0,
      });
      await expect(prepareExport(runtime, base.actor, request(pinned))).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
    };
  });
  preparedCase(
    "the last frame starts a grace window; a lost last reply is retryable and the slot stays held",
    async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      return async () => {
        const first = await prepareExport(runtime, base.actor, request(pinned));
        const bytes = await frames(base, first.transferId);
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
          first.contentHash,
        );
        const graced = await prisma.exportArtifact.findUniqueOrThrow({
          where: { id: first.transferId },
        });
        expect(graced.state).toBe("READY");
        expect(graced.reclaimedAt).toBeNull();
        expect(graced.downloadCompletedAt).not.toBeNull();
        expect(existsSync(artifactPath(first.transferId))).toBe(true);
        // The grace window is 10 minutes from the first EOF frame.
        expect(EXPORT_LIMITS.graceMs).toBe(600_000);
        expect(graced.expiresAt.getTime() - graced.downloadCompletedAt!.getTime()).toBe(600_000);
        // Re-reading the last frame within grace succeeds with identical bytes.
        const lastOffset = Math.floor((first.size - 1) / 196608) * 196608;
        const again = await readTransfer(runtime, base.actor, {
          kbId: base.kbId,
          transferId: first.transferId,
          offset: lastOffset,
        });
        expect(again.eof).toBe(true);
        expect(Buffer.from(again.bytesBase64, "base64")).toEqual(bytes.subarray(lastOffset));
        // A retried EOF never restarts the window.
        const after = await prisma.exportArtifact.findUniqueOrThrow({
          where: { id: first.transferId },
        });
        expect(after.downloadCompletedAt).toEqual(graced.downloadCompletedAt);
        expect(after.expiresAt).toEqual(graced.expiresAt);
        // The slot is still held during grace, and a periodic sweep keeps it.
        await reclaimExports(runtime);
        await expect(prepareExport(runtime, base.actor, request(pinned))).rejects.toMatchObject({
          code: "RATE_LIMITED",
        });
        expect(existsSync(artifactPath(first.transferId))).toBe(true);
      };
    },
  );
  preparedCase(
    "acknowledgement releases the slot and deletes the export; a second ack is idempotent; another user is refused",
    async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      const member = await user();
      await prisma.kbShare.create({ data: { kbId: base.kbId, userId: member.id, bits: ["read"] } });
      const memberActor = { principal: { kind: "browser" as const, userId: member.id } };
      // Browser-route download to completion starts grace; it does not delete.
      const otherKb = await fixture();
      return async () => {
        const first = await prepareExport(runtime, base.actor, request(pinned));
        const response = await downloadExport(runtime, base.actor, {
          kbId: base.kbId,
          transferId: first.transferId,
          signal: new AbortController().signal,
        });
        const bytes = Buffer.from(await new Response(response.body).arrayBuffer());
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
          first.contentHash,
        );
        expect(existsSync(artifactPath(first.transferId))).toBe(true);
        // Another user (with read access to the KB) cannot acknowledge it.
        await expect(
          completeExport(runtime, memberActor, { kbId: base.kbId, transferId: first.transferId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        const untouched = await prisma.exportArtifact.findUniqueOrThrow({
          where: { id: first.transferId },
        });
        expect(untouched.state).toBe("READY");
        expect(untouched.reclaimedAt).toBeNull();
        expect(existsSync(artifactPath(first.transferId))).toBe(true);
        // The owner acknowledges: slot released and export gone.
        await expect(
          completeExport(runtime, base.actor, { kbId: base.kbId, transferId: first.transferId }),
        ).resolves.toEqual({ transferId: first.transferId, released: true });
        await released(first.transferId, "DOWNLOADED");
        await expect(
          readTransfer(runtime, base.actor, {
            kbId: base.kbId,
            transferId: first.transferId,
            offset: 0,
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        // Acknowledging twice is idempotent.
        await expect(
          completeExport(runtime, base.actor, { kbId: base.kbId, transferId: first.transferId }),
        ).resolves.toEqual({ transferId: first.transferId, released: true });
        await released(first.transferId, "DOWNLOADED");
        // The next export is admitted at once.
        const second = await prepareExport(runtime, base.actor, request(pinned));
        // Acknowledging before the download completed releases too (the client gave up).
        await completeExport(runtime, base.actor, {
          kbId: base.kbId,
          transferId: second.transferId,
        });
        await released(second.transferId, "ABORTED");
        // Unknown ids and a wrong KB are refused.
        const third = await prepareExport(runtime, base.actor, request(pinned));
        await expect(
          completeExport(runtime, base.actor, { kbId: otherKb.kbId, transferId: third.transferId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          completeExport(runtime, base.actor, {
            kbId: base.kbId,
            transferId: "00000000-0000-4000-8000-000000000000",
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(
          (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: third.transferId } }))
            .state,
        ).toBe("READY");
        const reserved = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*) FROM "quota_reservation" WHERE "opId" = ANY($1::text[]) AND outcome='RESERVED'`,
          [first.transferId, second.transferId],
        );
        expect(Number(reserved[0]!.count)).toBe(0);
      };
    },
  );
  preparedCase(
    "with no acknowledgement, grace expiry (injected clock) releases the slot and deletes the export, also after a restart",
    async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      return async () => {
        const first = await prepareExport(runtime, base.actor, request(pinned));
        await frames(base, first.transferId);
        const row = await prisma.exportArtifact.findUniqueOrThrow({
          where: { id: first.transferId },
        });
        const graceEnd = row.downloadCompletedAt!.getTime() + EXPORT_LIMITS.graceMs;
        // Just before grace ends nothing is released.
        await reclaimExports(runtime, { now: new Date(graceEnd - 1000) });
        expect(
          (await prisma.exportArtifact.findUniqueOrThrow({ where: { id: first.transferId } }))
            .state,
        ).toBe("READY");
        expect(existsSync(artifactPath(first.transferId))).toBe(true);
        // At grace expiry the sweep releases and deletes it, as a completed download.
        await reclaimExports(runtime, { now: new Date(graceEnd + 1000) });
        await released(first.transferId, "DOWNLOADED");
        await prepareExport(runtime, base.actor, request(pinned)).then((next) =>
          completeExport(runtime, base.actor, { kbId: base.kbId, transferId: next.transferId }),
        );
        // Crash safety: grace is durable state, so a restart sweep after expiry reclaims it.
        const second = await prepareExport(runtime, base.actor, request(pinned));
        await frames(base, second.transferId);
        const secondRow = await prisma.exportArtifact.findUniqueOrThrow({
          where: { id: second.transferId },
        });
        await reclaimExports(runtime, {
          restart: true,
          now: new Date(secondRow.downloadCompletedAt!.getTime() + EXPORT_LIMITS.graceMs + 1000),
        });
        await released(second.transferId, "DOWNLOADED");
      };
    },
  );
  preparedCase("terminal failure still releases immediately", async () => {
    const base = await fixture();
    const pinned = await commit(base, [await asset(base)]);
    return async () => {
      const first = await prepareExport(runtime, base.actor, request(pinned));
      await frames(base, first.transferId);
      // The artifact file is lost during grace: the next read aborts and releases at once.
      await unlink(artifactPath(first.transferId));
      await expect(
        readTransfer(runtime, base.actor, {
          kbId: base.kbId,
          transferId: first.transferId,
          offset: 0,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await clean(first.transferId);
      await prepareExport(runtime, base.actor, request(pinned));
    };
  });
  for (const failure of ["missing", "corrupt", "lineage", "collision"] as const) {
    preparedCase(`${failure} leaves no usable partial artifact`, async () => {
      const base = await fixture();
      const entry = await asset(base, 20);
      const pinned = await commit(base, [
        { ...entry, path: failure === "collision" ? "INDEX.md" : entry.path },
      ]);
      return async () => {
        if (failure === "missing") await unlink(casBlobPath(assetsDir, entry.hash));
        if (failure === "corrupt")
          await writeFile(casBlobPath(assetsDir, entry.hash), Buffer.alloc(20, 2));
        if (failure === "lineage")
          await prisma.kbAssetLineage.delete({
            where: { kbId_hash: { kbId: base.kbId, hash: entry.hash } },
          });
        const input = request(pinned);
        await expect(prepareExport(runtime, base.actor, input)).rejects.toThrow();
        const row = await prisma.exportArtifact.findUniqueOrThrow({
          where: {
            actorKey_kbId_idempotencyKey: {
              actorKey: `user:${base.actor.principal.userId}`,
              kbId: base.kbId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        await clean(row.id);
        await expect(
          readTransfer(runtime, base.actor, { kbId: base.kbId, transferId: row.id, offset: 0 }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      };
    });
  }
  preparedCase(
    "enforces one/user and two/server; same key is one receipt; released slots admit again",
    async () => {
      const [a, b, c] = await Promise.all([fixture(), fixture(), fixture()]);
      const input = request(a);
      return async () => {
        const first = await prepareExport(runtime, a.actor, input);
        await expect(prepareExport(runtime, a.actor, request(a))).rejects.toMatchObject({
          code: "RATE_LIMITED",
        });
        await prepareExport(runtime, b.actor, request(b));
        await expect(prepareExport(runtime, c.actor, request(c))).rejects.toMatchObject({
          code: "RATE_LIMITED",
        });
        expect(await prepareExport(runtime, a.actor, input)).toEqual(first);
        await prisma.exportArtifact.update({
          where: { id: first.transferId },
          data: { expiresAt: new Date(0) },
        });
        await reclaimExports(runtime);
        await clean(first.transferId);
        await prepareExport(runtime, c.actor, request(c));
        await expect(prepareExport(runtime, a.actor, input)).rejects.toMatchObject({
          code: "CONFLICT",
        });
      };
    },
  );
  preparedCase(
    "TTL is fixed, another actor cannot reuse artifacts, and revoke stops the next frame",
    async () => {
      const base = await fixture();
      const entry = await asset(base);
      const pinned = await commit(base, [entry]);
      const member = await user();
      await prisma.kbShare.create({ data: { kbId: base.kbId, userId: member.id, bits: ["read"] } });
      const memberActor = { principal: { kind: "browser" as const, userId: member.id } };
      const input = request(pinned);
      return async () => {
        const descriptor = await prepareExport(runtime, memberActor, input);
        await expect(
          readTransfer(runtime, base.actor, {
            kbId: base.kbId,
            transferId: descriptor.transferId,
            offset: 0,
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        const download = await downloadExport(runtime, memberActor, {
          kbId: base.kbId,
          transferId: descriptor.transferId,
          signal: new AbortController().signal,
        });
        const reader = download.body.getReader();
        expect((await reader.read()).value!.length).toBe(196608);
        expect(
          (
            await prisma.exportArtifact.findUniqueOrThrow({ where: { id: descriptor.transferId } })
          ).expiresAt.toISOString(),
        ).toBe(descriptor.expiresAt);
        await prisma.kbShare.update({
          where: { kbId_userId: { kbId: base.kbId, userId: member.id } },
          data: { revokedAt: new Date() },
        });
        await expect(reader.read()).rejects.toThrow();
        await clean(descriptor.transferId);
      };
    },
  );
  preparedCase(
    "disconnect invalidates a sealed artifact and startup reclaims orphan intent/file",
    async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      return async () => {
        const descriptor = await prepareExport(runtime, base.actor, request(pinned));
        const stream = await downloadExport(runtime, base.actor, {
          kbId: base.kbId,
          transferId: descriptor.transferId,
          signal: new AbortController().signal,
        });
        const reader = stream.body.getReader();
        await reader.read();
        await reader.cancel();
        await clean(descriptor.transferId);
        const next = await prepareExport(runtime, base.actor, request(pinned));
        await prisma.exportArtifact.update({
          where: { id: next.transferId },
          data: { state: "WRITING" },
        });
        const lifecycle = await startExportLifecycle(runtime);
        await clean(next.transferId);
        await lifecycle.stop();
      };
    },
  );
  preparedCase(
    "shutdown joins a reserved preparation and releases its durable intent before returning",
    async () => {
      const base = await fixture();
      return async () => {
        const lifecycle = await startExportLifecycle(runtime);
        let entered!: () => void;
        let release!: () => void;
        const reserved = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const resume = new Promise<void>((resolve) => {
          release = resolve;
        });
        let first = true;
        const controlled: KbRuntimeConfig = {
          ...runtime,
          coordinator: {
            async run(options) {
              const result = await runtime.coordinator.run(options);
              if (first) {
                first = false;
                entered();
                await resume;
              }
              return result;
            },
          },
        };
        const input = request(base);
        const preparing = prepareExport(controlled, base.actor, input);
        const rejected = expect(preparing).rejects.toMatchObject({ code: "CANCELLED" });
        await reserved;
        const stopping = lifecycle.stop();
        release();
        await rejected;
        await stopping;
        const row = await prisma.exportArtifact.findUniqueOrThrow({
          where: {
            actorKey_kbId_idempotencyKey: {
              actorKey: `user:${base.actor.principal.userId}`,
              kbId: base.kbId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        await clean(row.id);
      };
    },
  );
  preparedCase(
    "R46r1 F2: shutdown retains preparation ownership through final reclamation",
    async () => {
      const base = await fixture();
      return async () => {
        const lifecycle = await startExportLifecycle(runtime);
        const entered = barrier();
        const resume = barrier();
        let id: string | undefined;
        const controlled: KbRuntimeConfig = {
          ...runtime,
          prisma: new Proxy(prisma, {
            get(target, key, receiver) {
              if (key !== "exportArtifact") return Reflect.get(target, key, receiver);
              return new Proxy(target.exportArtifact, {
                get(model, method, modelReceiver) {
                  if (method === "findUniqueOrThrow")
                    return async (args: Prisma.ExportArtifactFindUniqueOrThrowArgs) => {
                      const row = await model.findUniqueOrThrow(args);
                      id = row.id;
                      throw new Error("Injected final receipt read failure");
                    };
                  if (method === "findMany")
                    return async (args: Prisma.ExportArtifactFindManyArgs) => {
                      const rows = await model.findMany(args);
                      if (rows.some((row) => row.id === id)) {
                        entered.release();
                        await resume.wait;
                      }
                      return rows;
                    };
                  return Reflect.get(model, method, modelReceiver);
                },
              });
            },
          }),
        };
        const preparing = prepareExport(controlled, base.actor, request(base, "assets"));
        const rejected = expect(preparing).rejects.toBeDefined();
        await entered.wait;
        let stopped = false;
        const stopping = lifecycle.stop().then(() => {
          stopped = true;
        });
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(stopped).toBe(false);
          resume.release();
          await Promise.all([rejected, stopping]);
          if (!id) throw new Error("Missing real preparation receipt");
          await clean(id);
        } finally {
          resume.release();
          await Promise.allSettled([rejected, stopping]);
        }
      };
    },
  );
  preparedCase(
    "R46r1 F3: failed producer final return preserves a replay's delivered EOF",
    async () => {
      const base = await fixture();
      return async () => {
        let id: string | undefined;
        let delivered: Awaited<ReturnType<typeof readTransfer>> | undefined;
        const controlled: KbRuntimeConfig = {
          ...runtime,
          prisma: new Proxy(prisma, {
            get(target, key, receiver) {
              if (key !== "exportArtifact") return Reflect.get(target, key, receiver);
              return new Proxy(target.exportArtifact, {
                get(model, method, modelReceiver) {
                  if (method !== "findUniqueOrThrow")
                    return Reflect.get(model, method, modelReceiver);
                  return async (args: Prisma.ExportArtifactFindUniqueOrThrowArgs) => {
                    const row = await model.findUniqueOrThrow(args);
                    id = row.id;
                    delivered = await readTransfer(runtime, base.actor, {
                      kbId: base.kbId,
                      transferId: row.id,
                      offset: 0,
                    });
                    throw new Error("Injected original producer return failure");
                  };
                },
              });
            },
          }),
        };
        await expect(
          prepareExport(controlled, base.actor, request(base, "assets")),
        ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        if (!id || !delivered) throw new Error("Missing delivered replay frame");
        expect(delivered.eof).toBe(true);
        const completed = await prisma.exportArtifact.findUniqueOrThrow({ where: { id } });
        expect(completed.state).toBe("READY");
        expect(completed.downloadCompletedAt).not.toBeNull();
        expect(existsSync(artifactPath(id))).toBe(true);
        expect(
          await readTransfer(runtime, base.actor, { kbId: base.kbId, transferId: id, offset: 0 }),
        ).toEqual(delivered);
        await completeExport(runtime, base.actor, { kbId: base.kbId, transferId: id });
        await released(id, "DOWNLOADED");
      };
    },
  );
  preparedCase(
    "R46r1 F2: replay cancellation joins its still-returning producer before cleanup",
    async () => {
      const base = await fixture();
      return async () => {
        const entered = barrier();
        const resume = barrier();
        const input = request(base, "assets");
        const controlled: KbRuntimeConfig = {
          ...runtime,
          prisma: new Proxy(prisma, {
            get(target, key, receiver) {
              if (key !== "exportArtifact") return Reflect.get(target, key, receiver);
              return new Proxy(target.exportArtifact, {
                get(model, method, modelReceiver) {
                  if (method !== "findUniqueOrThrow")
                    return Reflect.get(model, method, modelReceiver);
                  return async (args: Prisma.ExportArtifactFindUniqueOrThrowArgs) => {
                    const row = await model.findUniqueOrThrow(args);
                    entered.release();
                    await resume.wait;
                    return row;
                  };
                },
              });
            },
          }),
        };
        const preparing = prepareExport(controlled, base.actor, input);
        const cancelled = expect(preparing).rejects.toMatchObject({ code: "CANCELLED" });
        await entered.wait;
        const replay = await prepareExport(runtime, base.actor, input);
        const abort = new AbortController();
        const { body } = await downloadExport(runtime, base.actor, {
          kbId: base.kbId,
          transferId: replay.transferId,
          signal: abort.signal,
        });
        const reader = body.getReader();
        abort.abort();
        let observed = false;
        const refused = expect(
          reader.read().finally(() => {
            observed = true;
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
        try {
          await cancelled; // Actual reaper found and cancelled the original owner.
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          expect(observed).toBe(false);
          expect(existsSync(artifactPath(replay.transferId))).toBe(true);
          resume.release();
          await refused;
          await clean(replay.transferId);
        } finally {
          resume.release();
          await Promise.allSettled([cancelled, refused]);
        }
      };
    },
  );
  preparedCase(
    "R46r1 F2: a failed discard does not let shutdown abandon another pending reader",
    async () => {
      const base = await fixture();
      const pinned = await commit(base, [await asset(base)]);
      return async () => {
        const lifecycle = await startExportLifecycle(runtime);
        const descriptor = await prepareExport(runtime, base.actor, request(pinned));
        const entered = barrier();
        const resume = barrier();
        const failing: KbRuntimeConfig = {
          ...runtime,
          prisma: new Proxy(prisma, {
            get(target, key, receiver) {
              if (key !== "exportArtifact") return Reflect.get(target, key, receiver);
              return new Proxy(target.exportArtifact, {
                get(model, method, modelReceiver) {
                  if (method !== "updateMany") return Reflect.get(model, method, modelReceiver);
                  return async (args: Prisma.ExportArtifactUpdateManyArgs) => {
                    // Actual PostgreSQL statement failure, with no row mutation.
                    await target.$executeRawUnsafe(
                      `UPDATE "export_artifact" SET "offset"=1/0 WHERE id=$1::uuid`,
                      descriptor.transferId,
                    );
                    return model.updateMany(args);
                  };
                },
              });
            },
          }),
        };
        const delayed: KbRuntimeConfig = {
          ...runtime,
          prisma: new Proxy(prisma, {
            get(target, key, receiver) {
              if (key !== "$executeRawUnsafe") return Reflect.get(target, key, receiver);
              return async (sql: string, ...values: unknown[]) => {
                const changed = await target.$executeRawUnsafe(sql, ...values);
                if (sql.includes('SET "offset"') && values[1] === 393216) {
                  entered.release();
                  await resume.wait;
                }
                return changed;
              };
            },
          }),
        };
        const openReader = async (config: KbRuntimeConfig) => {
          const { body } = await downloadExport(config, base.actor, {
            kbId: base.kbId,
            transferId: descriptor.transferId,
            signal: new AbortController().signal,
          });
          const reader = body.getReader();
          await reader.read();
          return reader;
        };
        const first = await openReader(failing);
        const second = await openReader(delayed);
        const secondFailure = expect(second.read()).rejects.toMatchObject({ name: "AbortError" });
        await entered.wait;
        let stopped = false;
        const stopping = lifecycle.stop().finally(() => {
          stopped = true;
        });
        const stopFailure = expect(stopping).rejects.toMatchObject({ code: "P2010" });
        try {
          await expect(first.read()).rejects.toMatchObject({ code: "P2010" });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(stopped).toBe(false);
          resume.release();
          await Promise.all([secondFailure, stopFailure]);
          await clean(descriptor.transferId);
        } finally {
          resume.release();
          await Promise.allSettled([secondFailure, stopFailure]);
        }
      };
    },
  );
  preparedCase("a preparation deadline cannot publish a late result", async () => {
    const base = await fixture();
    const input = request(base);
    return async () => {
      await expect(
        prepareExport(runtime, base.actor, input, { deadlineMs: 0 }),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(
        await prisma.exportArtifact.count({ where: { kbId: base.kbId, state: "READY" } }),
      ).toBe(0);
    };
  });
  preparedCase(
    "unknown/foreign/unreachable revisions, expired reads and preparation cancellation are denied",
    async () => {
      const base = await fixture();
      const unreachable = await commit(base, [], "# Unreachable", false);
      return async () => {
        for (const rev of ["f".repeat(40), unreachable.rev])
          await expect(
            prepareExport(runtime, base.actor, { ...request(base), rev }),
          ).rejects.toMatchObject({ code: "NOT_FOUND" });
        const abort = new AbortController();
        abort.abort();
        await expect(
          prepareExport(runtime, base.actor, request(base), { signal: abort.signal }),
        ).rejects.toMatchObject({ code: "CANCELLED" });
        const descriptor = await prepareExport(runtime, base.actor, request(base));
        await prisma.exportArtifact.update({
          where: { id: descriptor.transferId },
          data: { expiresAt: new Date(0) },
        });
        await expect(
          readTransfer(runtime, base.actor, {
            kbId: base.kbId,
            transferId: descriptor.transferId,
            offset: 0,
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await reclaimExports(runtime);
        await clean(descriptor.transferId);
      };
    },
  );
});

it("prepares S3 ZIP sources without admitting/touching cache and refuses a corrupt source", async () => {
  const base = await fixture();
  const entry = await asset(base);
  await commit(base, [entry]);
  const f = await s3Sources([entry]);
  try {
    const descriptor = await prepareExport(f.runtime, base.actor, request(base, "assets"));
    expect((await frames(base, descriptor.transferId)).length).toBeGreaterThan(entry.size);
    await completeExport(f.runtime, base.actor, {
      kbId: base.kbId,
      transferId: descriptor.transferId,
    });
    expect(await prisma.assetCacheEntry.count({ where: { cacheId: f.binding.cacheId } })).toBe(0);
    f.http.corruptGets(true);
    await expect(
      prepareExport(f.runtime, base.actor, request(base, "assets")),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await prisma.exportArtifact.count({ where: { kbId: base.kbId, state: "READY" } })).toBe(
      0,
    );
    expect(await prisma.assetCacheEntry.count({ where: { cacheId: f.binding.cacheId } })).toBe(0);
    expect(f.http.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
  } finally {
    await f.close();
  }
});
