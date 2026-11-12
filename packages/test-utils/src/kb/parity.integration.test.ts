import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
/** Task 62: same schema corpus and real lifecycle/edit/asset scenarios on both transports. */

import { execFileSync, spawn } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { minimalPng, sha256Buffer } from "@knowledge-base/api/lib/kb/fixtures/media-bytes";
import { startTestIndexReader } from "@knowledge-base/api/lib/kb/index-file/testing";
import { QWEN_ARTIFACT } from "@knowledge-base/api/lib/kb/model-artifact";
import { KB_TOOL_NAMES } from "@knowledge-base/api/lib/kb/protocol/catalog";
import { schemaDiagnostic } from "@knowledge-base/api/lib/kb/protocol/diagnostics";
import fixtures from "@knowledge-base/api/lib/kb/protocol/fixtures.json" with { type: "json" };
import schema from "@knowledge-base/api/lib/kb/protocol/schema.json" with { type: "json" };
import { createProvider } from "@knowledge-base/api/lib/kb/providers";
import { enrollSealedRecord, grantSealedRecord } from "@knowledge-base/api/lib/kb/sealed-records";
import { mintPersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { diagnosticCorpus } from "./diagnostic-corpus";
import { db, prisma, registerExportHooks, runtime, user } from "./export-fixture";
import { deliverIndexBuild } from "./index-delivery";
import { callResult, localPeer, normalize } from "./parity";

const embedder = {
  embed: async (texts: readonly string[], options: { beforeDispatch?: () => Promise<void> }) => {
    await options.beforeDispatch?.();
    return texts.map(() => [1, 0]);
  },
};
vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
// The corpus owns real PG authority/leases/Git children; kernel server-volume
// supervision is covered separately, not asserted by this fixture port.
vi.mock("../../../../apps/server/src/kb-process.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertProcessFence() {},
}));
const { createKbWriteCoordinator, gitMutatingExecutor } = (await import(
  new URL("../../../../apps/server/src/kb-write-coordinator.ts", import.meta.url).href
)) as {
  createKbWriteCoordinator(
    deps: Record<string, unknown>,
  ): typeof runtime.coordinator & { shutdown(): Promise<void> };
  gitMutatingExecutor: NonNullable<typeof runtime.createGitExecutor>;
};
let coordinator: ReturnType<typeof createKbWriteCoordinator>;

type Actor = {
  principal: import("@knowledge-base/api/lib/kb/principal").TokenPrincipal;
  verifier: import("@knowledge-base/api/lib/kb/principal").CredentialVerifier;
  recheck(): Promise<void>;
};
type Gate = {
  readonly closed: boolean;
  readonly outstanding: number;
  close(): Promise<void>;
  admit(signal: AbortSignal): { signal: AbortSignal; release(): void } | null;
};
const { createMcpEndpoint } = (await import(
  new URL("../../../../apps/server/src/mcp/handler.ts", import.meta.url).href
)) as {
  createMcpEndpoint(options: {
    admit: (request: Request) => Promise<Actor>;
    gate: Gate;
    origin: string;
    runtime(): typeof runtime;
    masterKey(): string;
  }): { fetch(request: Request): Promise<Response>; close(): Promise<void> };
};
const { createBearerAdmission } = (await import(
  new URL("../../../../apps/server/src/mcp/auth.ts", import.meta.url).href
)) as {
  createBearerAdmission(options: {
    query: ReturnType<typeof prismaAssetQuery>;
    origin: string;
    verifyOAuth(): Promise<Record<string, unknown>>;
  }): (request: Request) => Promise<Actor>;
};
const { createAdmissionGate } = (await import(
  new URL("../../../../apps/server/src/mcp/admission.ts", import.meta.url).href
)) as { createAdmissionGate(): Gate };
const { runQueryEmbeddingDelivery } = (await import(
  new URL("../../../../apps/worker/src/handlers/query-embedding.ts", import.meta.url).href
)) as {
  runQueryEmbeddingDelivery(
    db: typeof prisma,
    options: import("@knowledge-base/api/lib/kb/query-embedding").QueryEmbeddingOptions & {
      workerId: string;
      durableJobId: string;
      embedder: typeof embedder;
    },
  ): Promise<unknown>;
};
registerExportHooks();
const root = mkdtempSync(join(tmpdir(), "kb-parity-"));
let local: Awaited<ReturnType<typeof localPeer>>;
let endpoint: ReturnType<typeof createMcpEndpoint>;
let token = "";
const master = randomBytes(32).toString("base64");
async function remote(name: string, args: Record<string, unknown>) {
  const pending = endpoint.fetch(
    new Request(`${runtime.canonicalOrigin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-protocol-version": "2026-07-28",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "parity", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  if (
    (name === "knowledge_search" || name === "knowledge_structured_search") &&
    typeof args.query === "string" &&
    !schemaDiagnostic(schema.tools[name].input, args)
  ) {
    let row: { id: string } | null = null;
    for (let n = 0; n < 200 && !row; n++) {
      row = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: String(args.kbId), state: "PENDING" },
        select: { id: true },
      });
      if (!row) await new Promise((r) => setTimeout(r, 10));
    }
    if (row) {
      await prisma.durableJob.update({ where: { id: row.id }, data: { state: "PUBLISHED" } });
      await runQueryEmbeddingDelivery(prisma, {
        connectionString: db.urls.runtime,
        masterKey: master,
        workerId: randomUUID(),
        durableJobId: row.id,
        embedder,
      });
    }
  }
  const response = await pending;
  const body = (await response.json()) as { result: unknown };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return callResult.parse(body.result);
}
/** Delivers one server index build, as the worker would (no-op unless still PENDING). */
async function build(jobId: unknown) {
  if (!jobId) return;
  const job = await prisma.durableJob.findUnique({
    where: { id: String(jobId) },
    select: { state: true },
  });
  if (job?.state !== "PENDING") return;
  await prisma.durableJob.update({ where: { id: String(jobId) }, data: { state: "PUBLISHED" } });
  await deliverIndexBuild(prisma, {
    connectionString: db.urls.runtime,
    indexDir,
    reposDir: runtime.reposDir,
    masterKey: master,
    workerId: randomUUID(),
    durableJobId: String(jobId),
    embedder,
  });
}
/**
 * Every new KB and main write schedules a (lexical) generation. The CLI builds it
 * on its own (background worker, or inline in the rich fixture); this harness has no
 * server worker, so each call settles both sides before the next comparison: deliver
 * every pending server build, and wait for the CLI's desired generation to settle.
 */
const delivered = new Set<string>();
async function settle(kbIds: string[]) {
  for (;;) {
    const pending = await prisma.durableJob.findMany({
      where: { kind: "INDEX_KB", state: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
      take: 20,
    });
    const next = pending.find((job) => !delivered.has(job.id));
    if (!next) break;
    delivered.add(next.id);
    await build(next.id);
  }
  for (const kbId of kbIds) {
    for (let n = 0; ; n++) {
      const status = await local.call("knowledge_index_status", { kbId });
      // A principal that cannot read the status, or a deleted KB, has nothing to settle.
      if (status.isError) break;
      const state = (status.structuredContent.data as { desiredState?: unknown }).desiredState;
      if (state !== "PENDING" && state !== "BUILDING" && state !== "INDEXING") break;
      if (n >= 600) throw new Error(`local index build did not settle for ${kbId}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
const calls = new Set<string>();
async function both(name: string, args: Record<string, unknown>[], expectedError = false) {
  calls.add(name);
  const a = await remote(name, args[0]!);
  const b = await local.call(name, args[1]!);
  if (!expectedError && !b.isError) {
    const data = (b.structuredContent.data ?? {}) as { kb?: { id?: unknown } };
    const kbIds = [args[1]!.kbId, data.kb?.id].filter((id): id is string => typeof id === "string");
    await settle([...new Set(kbIds)]);
  }
  expect(a.isError, `${name}: ${JSON.stringify(a.structuredContent)}`).toBe(expectedError);
  expect(b.isError, `${name}: ${JSON.stringify(b.structuredContent)}`).toBe(expectedError);
  expect(normalize(b.structuredContent), name).toEqual(normalize(a.structuredContent));
  expect(JSON.parse(b.content[0]!.text)).toEqual(b.structuredContent);
  return [a.structuredContent.data ?? {}, b.structuredContent.data ?? {}];
}
beforeAll(async () => {
  const children = new Map<
    number,
    {
      child: ReturnType<typeof spawn>;
      exit: Promise<{ opId: string; pid: number; status: number }>;
    }
  >();
  coordinator = createKbWriteCoordinator({
    connectionString: db.urls.runtime,
    assertFence() {},
    closeAdmission: async () => {},
    async spawn(req: { opId: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
      const child = spawn(req.argv[0]!, req.argv.slice(1), {
        cwd: req.cwd,
        env: req.env,
        stdio: "ignore",
        timeout: 10000,
        killSignal: "SIGKILL",
      });
      const exit = new Promise<{ opId: string; pid: number; status: number }>((done, fail) => {
        child.once("error", fail);
        child.once("exit", (status) =>
          done({ opId: req.opId, pid: child.pid!, status: status ?? -1 }),
        );
      });
      children.set(child.pid!, { child, exit });
      return { pid: child.pid! };
    },
    async wait(opId: string, pid: number) {
      const entry = children.get(pid);
      if (!entry) throw new Error("unknown child");
      const result = await entry.exit;
      if (result.opId !== opId) throw new Error("wrong child operation");
      return result;
    },
    async drain(opId: string, pid: number) {
      const entry = children.get(pid);
      if (!entry) throw new Error("unknown child");
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill("SIGKILL");
      const result = await entry.exit;
      if (result.opId !== opId) throw new Error("wrong child operation");
      return result;
    },
  });
  runtime.coordinator = coordinator;
  runtime.createGitExecutor = gitMutatingExecutor;
  const owner = await user();
  await prisma.user.update({ where: { id: owner.id }, data: { twoFactorEnabled: true } });
  const minted = await mintPersonalToken(runtime, owner.id, {
    name: "parity",
    scopes: ["mcp:write"],
    toolGroups: [...MCP_TOOL_GROUPS],
    acl: [],
    allowCreate: true,
    createdKbBits: ["read", "manage"],
  });
  token = minted.secret;
  const gate = createAdmissionGate();
  endpoint = createMcpEndpoint({
    admit: createBearerAdmission({
      query: prismaAssetQuery(prisma),
      origin: runtime.canonicalOrigin,
      verifyOAuth: async () => {
        throw new Error("PAT fixture");
      },
    }),
    gate,
    runtime: () => runtime,
    origin: runtime.canonicalOrigin,
    masterKey: () => master,
  });
  local = await localPeer(
    resolve(import.meta.dirname, "../../../../apps/cli/target/debug/kb"),
    join(root, "store"),
  );
}, 180000);
const indexDir = mkdtempSync(join(tmpdir(), "kb-parity-index-"));
const indexReader = await startTestIndexReader(indexDir);

afterAll(async () => {
  await indexReader.stop();
  await local?.close();
  await endpoint?.close();
  await coordinator?.shutdown();
  rmSync(root, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});
describe("server/local stdio parity", () => {
  it("official SDK handshake and exact frozen server names/schemas; no shell/control plane", async () => {
    const exact = { id: "user-id", rev: "user-revision", createdAt: "user-timestamp" };
    expect(normalize({ id: "generated", frontMatter: exact, matchedRow: exact })).toEqual({
      id: "<id>",
      frontMatter: exact,
      matchedRow: exact,
    });
    const listing = await local.list();
    expect(listing.tools.map((t) => t.name)).toEqual([...KB_TOOL_NAMES]);
    for (const t of listing.tools) {
      const row = schema.tools[t.name as keyof typeof schema.tools];
      expect(t.inputSchema).toEqual(row.input);
      expect(t.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "data"],
        properties: { schemaVersion: { const: "kb/1" }, data: row.output },
      });
    }
    await expect(local.unsupported()).rejects.toMatchObject({ code: -32601 });
    const cancellation = new AbortController();
    cancellation.abort(new Error("fixture canceled"));
    await expect(
      local.peer.request(
        {
          method: "tools/call",
          params: {
            name: "knowledge_bases_list",
            arguments: {},
          },
        },
        { signal: cancellation.signal },
      ),
    ).rejects.toThrow("fixture canceled");
    await local.peer.notification({
      method: "notifications/cancelled",
      params: { requestId: 9000 },
    });
    expect((await local.call("knowledge_bases_list", {})).structuredContent.data!.items).toEqual(
      [],
    );
  });
  it("every catalog row rejects the complete malformed-input corpus identically before effects", async () => {
    for (const name of KB_TOOL_NAMES) {
      const row = fixtures.tools[name];
      // Independent malformed requests have no domain effects; four also
      // exercises the same bounded concurrent client admission as production.
      for (let i = 0; i < row.invalidInputs.length; i += 4)
        await Promise.all(
          row.invalidInputs
            .slice(i, i + 4)
            .map((invalid) => both(name, [invalid.value, invalid.value], true)),
        );
    }
    expect(calls.size).toBe(KB_TOOL_NAMES.length);
  }, 120000);
  it("schema-generated defects at every tool input node match on both transports", async () => {
    expect(JSON.stringify(schema.tools)).not.toContain('"$ref"');
    const corpus = diagnosticCorpus();
    expect(corpus.length).toBeGreaterThan(1000);
    for (const { tool, label, value } of corpus) {
      const a = await remote(tool, value as Record<string, unknown>);
      const b = await local.call(tool, value as Record<string, unknown>);
      expect(a.structuredContent.error?.code, `${tool} ${label}`).toBe("INVALID_ARGUMENT");
      expect(b.structuredContent.error?.code, `${tool} ${label}`).toBe("INVALID_ARGUMENT");
      expect(b.structuredContent.error?.details, `${tool} ${label}`).toEqual(
        a.structuredContent.error?.details,
      );
    }
  }, 240000);
  it("empty store, primary lifecycle, edits, replay, pinned source and delete", async () => {
    await both("knowledge_bases_list", [{}, {}]);
    const create = {
      name: "Parity",
      slug: "parity",
      description: "Parity fixture description",
      idempotencyKey: randomUUID(),
    };
    const made = await both("knowledge_bases_create", [create, create]);
    const kb = made.map((v) => v.kb as Record<string, unknown>);
    const refs = kb.map((k) => ({ kbId: k.id }));
    await both("knowledge_bases_create", [create, create]);
    await both("knowledge_bases_list", [{}, {}]);
    const heads = await both("knowledge_bases_get", [refs[0]!, refs[1]!]);
    await both("knowledge_documents_list", [refs[0]!, refs[1]!]);
    await both("knowledge_documents_get", [
      { ...refs[0], path: "index.md" },
      { ...refs[1], path: "index.md" },
    ]);
    const key = randomUUID();
    const write = kb.map((k) => ({
      kbId: k.id,
      baseRevision: k.headSha,
      idempotencyKey: key,
      path: "a.md",
      content: { markdown: "# Parity\n\nExact UTF8 λ source\n" },
    }));
    const changed = await both("knowledge_documents_create", [write[0]!, write[1]!]);
    await both("knowledge_documents_create", [write[0]!, write[1]!]);
    await both("knowledge_documents_get", [
      { ...refs[0], path: "a.md" },
      { ...refs[1], path: "a.md" },
    ]);
    await both("knowledge_documents_get", [
      { ...refs[0], path: "index.md", rev: (heads[0]!.kb as Record<string, unknown>).headSha },
      { ...refs[1], path: "index.md", rev: (heads[1]!.kb as Record<string, unknown>).headSha },
    ]);
    const updates = changed.map((v, i) => ({
      ...write[i],
      baseRevision: v.commitSha,
      idempotencyKey: randomUUID(),
      content: { markdown: "# Changed\n" },
    }));
    const updated = await both("knowledge_documents_update", [updates[0]!, updates[1]!]);
    await both(
      "knowledge_documents_delete",
      updated.map((v, i) => ({
        ...refs[i],
        baseRevision: v.commitSha,
        idempotencyKey: randomUUID(),
        path: "a.md",
        confirm: "DELETE",
      })),
    );
    await both(
      "knowledge_bases_delete",
      refs.map((r) => ({
        ...r,
        metadataVersion: 1,
        idempotencyKey: randomUUID(),
        confirm: "DELETE",
      })),
    );
  }, 120000);
});

describe("complete rich corpus", () => {
  let richRoot: string;
  let refs: Record<string, unknown>[];
  let heads: string[];
  let provider: string[];
  let ownerId: string;
  let grantId: string;
  let sealed: string[];
  let upload: string[];
  let assetRev: string[];
  let assetHash: string;
  let proposal: Record<string, unknown>[];
  const successful = new Set<string>();
  const key = () => randomUUID();
  async function call(name: string, args: Record<string, unknown>[]) {
    const values = await both(name, args);
    expect(values[0], name).toBeDefined();
    successful.add(name);
    return values;
  }
  async function edit(markdown: string, path = "alpha.md", name = "knowledge_documents_create") {
    const out = await call(
      name,
      refs.map((r, i) => ({
        ...r,
        baseRevision: heads[i],
        path,
        content: { markdown },
        idempotencyKey: key(),
      })),
    );
    heads = out.map((v) => String(v.commitSha));
    return out;
  }
  beforeAll(async () => {
    await local.close();
    richRoot = join(root, "rich");
    local = await localPeer(
      resolve(import.meta.dirname, "../../../../apps/cli/target/debug/kb-parity-fixture"),
      richRoot,
      ["--endpoint", "https://provider.example.invalid/embeddings"],
    );
    const created = await call("knowledge_bases_create", [
      {
        name: "Rich",
        slug: "rich",
        description: "Rich parity fixture",
        idempotencyKey: "rich-create-key-001",
      },
      {
        name: "Rich",
        slug: "rich",
        description: "Rich parity fixture",
        idempotencyKey: "rich-create-key-001",
      },
    ]);
    refs = created.map((v) => ({ kbId: (v.kb as Record<string, unknown>).id }));
    heads = created.map((v) => String((v.kb as Record<string, unknown>).headSha));
    ownerId = (
      await prisma.knowledgeBase.findUniqueOrThrow({
        where: { id: String(refs[0]!.kbId) },
        select: { ownerId: true },
      })
    ).ownerId!;
    grantId = (
      await prisma.mcpPersonalToken.findFirstOrThrow({
        where: { grant: { actorUserIdSnapshot: ownerId } },
        select: { grantId: true },
      })
    ).grantId;
    const registration = await createProvider(
      runtime,
      ownerId,
      {
        name: "Fixture",
        model: "fixture",
        endpointUrl: "https://provider.example.invalid/embeddings",
        dimensions: 2,
        apiKey: "disposable-parity-credential",
        idempotencyKey: key(),
      },
      master,
    );
    await prisma.durableJob.update({
      where: { id: registration.jobId },
      data: { state: "COMPLETE" },
    });
    provider = [registration.provider.providerId, String(local.setup().providerId)];
    const actor = { kind: "browser" as const, userId: ownerId };
    const kb = created[0]!.kb as Record<string, unknown>;
    const enrolled = await enrollSealedRecord(
      runtime,
      actor,
      {
        kbId: String(kb.id),
        namespace: String(kb.sealedNamespace),
        plaintext: "disposable-sealed-parity-canary",
        idempotencyKey: key(),
      },
      master,
    );
    sealed = [enrolled.reference, String(local.setup().reference)];
    await grantSealedRecord(runtime, actor, {
      kbId: String(kb.id),
      reference: sealed[0]!,
      consumerKind: "pat",
      consumerId: grantId,
      recipientKeyId: String(local.setup().recipientKeyId),
      recipientPublicKey: String(local.setup().recipientPublicKey),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      idempotencyKey: key(),
    });
    execFileSync("git", [
      "--git-dir",
      join(runtime.reposDir, `kb_${refs[0]!.kbId}.git`),
      "update-ref",
      "refs/heads/users/topic",
      heads[0]!,
    ]);
    await prisma.branchOwner.create({
      data: {
        kbId: String(refs[0]!.kbId),
        refName: "refs/heads/users/topic",
        ownerActorKey: `grant:${grantId}`,
        purpose: "USER",
      },
    });
  }, 180000);
  it("logical builtin classifications agree before registry creation in fresh, disabled and initially loading states", async () => {
    const saved = await prisma.localModel.findUnique({ where: { id: QWEN_ARTIFACT.modelId } });
    expect(saved).toBeNull();
    expect(await prisma.embeddingProvider.count({ where: { kind: "SYSTEM_BUILTIN" } })).toBe(0);
    try {
      for (const state of ["fresh", "disabled", "loading"] as const) {
        if (state !== "fresh")
          await prisma.localModel.upsert({
            where: { id: QWEN_ARTIFACT.modelId },
            create: {
              id: QWEN_ARTIFACT.modelId,
              state: state === "loading" ? "DOWNLOADING" : "DISABLED",
            },
            update: { state: state === "loading" ? "DOWNLOADING" : "DISABLED" },
          });
        for (const narrowed of [false, true]) {
          const prior = token;
          if (narrowed)
            token = (
              await mintPersonalToken(runtime, ownerId, {
                name: "narrowed builtin manager",
                scopes: ["mcp:write"],
                toolGroups: [...MCP_TOOL_GROUPS],
                acl: [{ kbId: String(refs[0]!.kbId), bits: ["manage"] }],
              })
            ).secret;
          const peer = await localPeer(
            resolve(import.meta.dirname, "../../../../apps/cli/target/debug/kb-parity-fixture"),
            join(root, `builtin-${state}-${narrowed}`),
            [
              "--endpoint",
              "https://provider.example.invalid/embeddings",
              "--builtin-state",
              state,
              ...(narrowed ? ["--narrow-manager"] : []),
            ],
          );
          try {
            // Use the generated accepted corpus, rather than another hand-picked
            // list of provider spellings or revision combinations.
            for (const variant of fixtures.tools.knowledge_embedding_profile_set.validInputVariants.filter(
              (v) => v.label.startsWith("builtin-"),
            )) {
              const input = { ...variant.value, idempotencyKey: key() };
              const a = await remote("knowledge_embedding_profile_set", { ...input, ...refs[0] });
              const b = await peer.call("knowledge_embedding_profile_set", {
                ...input,
                kbId: (peer.setup().kb as Record<string, unknown>).id,
              });
              const error = a.structuredContent.error;
              expect(error?.code, `${state} ${narrowed} ${variant.label}`).toBe(
                "revision" in input && input.revision === 99 ? "CONFLICT" : "INDEX_UNAVAILABLE",
              );
              expect(
                normalize(b.structuredContent),
                `${state} ${narrowed} ${variant.label}`,
              ).toEqual(normalize(a.structuredContent));
            }
          } finally {
            token = prior;
            await peer.close();
          }
        }
      }
    } finally {
      await prisma.localModel.deleteMany({ where: { id: QWEN_ARTIFACT.modelId } });
    }
  }, 120000);
  it("metadata/profile/index default and source data plus deterministic dreams", async () => {
    await call("knowledge_bases_list", [{}, {}]);
    await call("knowledge_bases_get", refs);
    await call("knowledge_index_status", refs);
    await call("knowledge_embedding_profile_get", refs);
    await call("knowledge_assets_list", refs);
    await call("knowledge_documents_list", refs);
    await call(
      "knowledge_documents_get",
      refs.map((r) => ({ ...r, path: "index.md" })),
    );
    await call(
      "knowledge_bases_update",
      refs.map((r) => ({ ...r, metadataVersion: 1, name: "Rich renamed", idempotencyKey: key() })),
    );
    const dream = await call(
      "knowledge_changes_apply",
      refs.map((r, i) => ({
        ...r,
        baseRevision: heads[i],
        idempotencyKey: key(),
        mode: "dream",
        changes: [],
        sourceSessionIds: ["00000000-0000-4000-8000-000000000004"],
        title: "Dream",
        dream: {
          model: { provider: "fixture", model: "fixture" },
          redactionApplied: true,
          upserts: [
            {
              id: "concept",
              type: "concept",
              title: null,
              body: "Alpha dream source",
              citations: [],
              provenance: "dream",
            },
          ],
        },
      })),
    );
    heads = dream.map((v) => String(v.commitSha));
    await edit(
      "---\nid: alpha\ntype: concept\n---\nAlpha searchable source text.\n\n| name | count |\n| --- | --- |\n| target | 2 |\n",
    );
    await edit(
      "---\nid: alpha\ntype: concept\n---\nAlpha searchable source text.\n\n| name | count |\n| --- | --- |\n| target | 2 |\n",
      "alpha.md",
      "knowledge_documents_update",
    );
  }, 120000);
  it("uploads/assets/imports retain historical rev and immutable export frames", async () => {
    const bytes = minimalPng();
    assetHash = sha256Buffer(bytes);
    const begun = await call(
      "knowledge_upload_begin",
      refs.map((r) => ({
        ...r,
        idempotencyKey: key(),
        kind: "asset",
        size: bytes.length,
        mime: "image/png",
        contentHash: assetHash,
      })),
    );
    upload = begun.map((v) => String(v.uploadId));
    await call(
      "knowledge_upload_write",
      refs.map((r, i) => ({
        ...r,
        uploadId: upload[i],
        offset: 0,
        bytesBase64: bytes.toString("base64"),
      })),
    );
    await call(
      "knowledge_upload_finish",
      refs.map((r, i) => ({ ...r, uploadId: upload[i] })),
    );
    const put = await call(
      "knowledge_assets_put",
      refs.map((r, i) => ({
        ...r,
        baseRevision: heads[i],
        idempotencyKey: key(),
        path: "assets/pixel.png",
        uploadId: upload[i],
      })),
    );
    heads = put.map((v) => String(v.commitSha));
    assetRev = [...heads];
    await call(
      "knowledge_assets_list",
      refs.map((r, i) => ({ ...r, rev: assetRev[i] })),
    );
    const imported = await call(
      "knowledge_assets_import",
      refs.map((r, i) => ({
        ...r,
        baseRevision: heads[i],
        idempotencyKey: key(),
        path: "assets/copied.png",
        source: { kbId: r.kbId, rev: assetRev[i], hash: assetHash },
      })),
    );
    heads = imported.map((v) => String(v.commitSha));
    // Parity on domain refusals: the typed cause, with its pointer.
    const stage = async (data: Buffer, kind: "asset" | "markdown") => {
      const started = await call(
        "knowledge_upload_begin",
        refs.map((r) => ({
          ...r,
          idempotencyKey: key(),
          kind,
          size: data.length,
          mime: kind === "asset" ? "image/png" : "text/markdown",
          contentHash: sha256Buffer(data),
        })),
      );
      const ids = started.map((v) => String(v.uploadId));
      await call(
        "knowledge_upload_write",
        refs.map((r, i) => ({
          ...r,
          uploadId: ids[i],
          offset: 0,
          bytesBase64: data.toString("base64"),
        })),
      );
      return ids;
    };
    const clash = await stage(bytes, "asset");
    await call(
      "knowledge_upload_finish",
      refs.map((r, i) => ({ ...r, uploadId: clash[i] })),
    );
    const collide = refs.map((r, i) => ({
      ...r,
      baseRevision: heads[i],
      idempotencyKey: key(),
      // An asset case-folding onto the document alpha.md.
      path: "ALPHA.md",
      uploadId: clash[i],
    }));
    await both("knowledge_assets_put", collide, true);
    const collision = await remote("knowledge_assets_put", {
      ...collide[0]!,
      idempotencyKey: key(),
    });
    expect(collision.structuredContent.error?.details).toEqual({
      reason: "PATH_CASE_COLLISION",
      field: "/path",
    });
    const control = await stage(Buffer.from("# bell \u0007\n"), "markdown");
    await both(
      "knowledge_upload_finish",
      refs.map((r, i) => ({ ...r, uploadId: control[i] })),
      true,
    );
    const prepared = await call(
      "knowledge_export_prepare",
      refs.map((r) => ({ ...r, kind: "assets", idempotencyKey: key() })),
    );
    const ids = prepared.map((v) => v.transferId);
    await call(
      "knowledge_transfer_read",
      refs.map((r, i) => ({ ...r, transferId: ids[i], offset: 0 })),
    );
    await call(
      "knowledge_export_complete",
      refs.map((r, i) => ({ ...r, transferId: ids[i] })),
    );
  }, 120000);
  it("every typed refusal reason matches across transports (R4 review)", async () => {
    const reason = async (name: string, args: Record<string, unknown>[], details: unknown) => {
      await both(name, args, true);
      const result = await remote(name, args[0]!);
      expect(result.structuredContent.error?.details, name).toEqual(details);
    };
    // Profile classification: unknown provider, never-existing revision, omitted revision.
    const profile = (extra: (i: number) => Record<string, unknown>) =>
      refs.map((r, i) => ({ ...r, idempotencyKey: key(), confirm: "RUN", ...extra(i) }));
    await reason(
      "knowledge_embedding_profile_set",
      profile(() => ({ providerId: "z".repeat(24), revision: 1 })),
      {},
    );
    await reason(
      "knowledge_embedding_profile_set",
      profile((i) => ({ providerId: provider[i], revision: 99 })),
      { reason: "REVISION_NOT_CURRENT", field: "/revision" },
    );
    await reason(
      "knowledge_embedding_profile_set",
      profile((i) => ({ providerId: provider[i] })),
      { reason: "MISSING_ARGUMENT", field: "/revision" },
    );
    // A document read of a missing path; a write that names a missing or reserved one.
    await reason(
      "knowledge_documents_get",
      refs.map((r) => ({ ...r, path: "missing.md" })),
      { reason: "PATH_NOT_FOUND", field: "/path" },
    );
    await reason(
      "knowledge_documents_update",
      refs.map((r, i) => ({
        ...r,
        baseRevision: heads[i],
        idempotencyKey: key(),
        path: "missing.md",
        content: { markdown: "# m\n" },
      })),
      { reason: "PATH_NOT_FOUND", field: "/path" },
    );
    await reason(
      "knowledge_documents_create",
      refs.map((r, i) => ({
        ...r,
        baseRevision: heads[i],
        idempotencyKey: key(),
        path: ".assets/x.md",
        content: { markdown: "# x\n" },
      })),
      { reason: "RESERVED_PATH", field: "/path" },
    );
    // Schema refusals (including content unions and dream session requirements)
    // are generated for all siblings by diagnosticCorpus above.
    // Uploads: past the declared size, rewritten acknowledged bytes, a wrong
    // content hash at finish, and a write after finish.
    const data = Buffer.from("# staged\n");
    const begin = async (contentHash: string) =>
      (
        await call(
          "knowledge_upload_begin",
          refs.map((r) => ({
            ...r,
            idempotencyKey: key(),
            kind: "markdown",
            size: data.length,
            mime: "text/markdown",
            contentHash,
          })),
        )
      ).map((v) => String(v.uploadId));
    const write = (ids: string[], offset: number, bytes: Buffer) =>
      refs.map((r, i) => ({
        ...r,
        uploadId: ids[i],
        offset,
        bytesBase64: bytes.toString("base64"),
      }));
    const sized = await begin(sha256Buffer(data));
    await reason("knowledge_upload_write", write(sized, 0, Buffer.concat([data, data])), {
      reason: "TOO_LARGE",
      field: "/bytesBase64",
    });
    await call("knowledge_upload_write", write(sized, 0, data.subarray(0, 4)));
    await reason("knowledge_upload_write", write(sized, 0, Buffer.from("XXXXXX")), {
      reason: "UPLOAD_BYTES_MISMATCH",
      field: "/offset",
    });
    const wrong = await begin(sha256Buffer(Buffer.from("# other!\n")));
    await call("knowledge_upload_write", write(wrong, 0, data));
    await reason(
      "knowledge_upload_finish",
      refs.map((r, i) => ({ ...r, uploadId: wrong[i] })),
      { reason: "CONTENT_HASH_MISMATCH" },
    );
    const done = await begin(sha256Buffer(data));
    await call("knowledge_upload_write", write(done, 0, data));
    await call(
      "knowledge_upload_finish",
      refs.map((r, i) => ({ ...r, uploadId: done[i] })),
    );
    await reason("knowledge_upload_write", write(done, 0, data), {
      reason: "UPLOAD_NOT_WRITABLE",
    });
  }, 120000);

  it("owned user branches, complete PR details, reviewed close and propose-only transitions", async () => {
    const source = [
      (local.setup().kb as Record<string, unknown>).headSha,
      (local.setup().kb as Record<string, unknown>).headSha,
    ];
    const remoteSource = execFileSync(
      "git",
      [
        "--git-dir",
        join(runtime.reposDir, `kb_${refs[0]!.kbId}.git`),
        "rev-parse",
        "refs/heads/users/topic",
      ],
      { encoding: "utf8" },
    ).trim();
    source[0] = remoteSource;
    const opened = await call(
      "knowledge_pull_requests_create",
      refs.map((r, i) => ({
        ...r,
        headBranch: "users/topic",
        expectedHeadSha: source[i],
        expectedTargetSha: heads[i],
        title: "Owned user branch",
        idempotencyKey: key(),
      })),
    );
    proposal = opened.map((v) => v.pr as Record<string, unknown>);
    await call("knowledge_pull_requests_list", refs);
    await call(
      "knowledge_pull_requests_get",
      refs.map((r, i) => ({ ...r, number: proposal[i]!.number })),
    );
    await call(
      "knowledge_pull_requests_review",
      refs.map((r, i) => ({
        ...r,
        number: proposal[i]!.number,
        decision: "close",
        expectedHeadSha: source[i],
        expectedTargetSha: heads[i],
        idempotencyKey: key(),
        confirm: "CLOSE",
      })),
    );
    const narrowed = await mintPersonalToken(runtime, ownerId, {
      name: "proposal",
      scopes: ["mcp:write"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: String(refs[0]!.kbId), bits: ["propose"] }],
    });
    const prior = token;
    token = narrowed.secret;
    const ownerPeer = local;
    local = await localPeer(
      resolve(import.meta.dirname, "../../../../apps/cli/target/debug/kb"),
      richRoot,
      ["--principal", String(ownerPeer.setup().proposer)],
    );
    try {
      const made = await call(
        "knowledge_documents_create",
        refs.map((r, i) => ({
          ...r,
          baseRevision: heads[i],
          idempotencyKey: key(),
          path: "proposal.md",
          content: { markdown: "# Proposal" },
        })),
      );
      expect(made[0]!.kind).toBe("proposed");
      expect(made[0]!.indexJobId).toBeNull();
      await both(
        "knowledge_bases_update",
        refs.map((r) => ({ ...r, metadataVersion: 2, name: "Denied", idempotencyKey: key() })),
        true,
      );
    } finally {
      token = prior;
      await local.close();
      local = ownerPeer;
    }
  }, 120000);
  it("real index build/search exact spans/ranking, structured and zero chunks", async () => {
    const set = await call(
      "knowledge_embedding_profile_set",
      refs.map((r, i) => ({
        ...r,
        providerId: provider[i],
        revision: 1,
        idempotencyKey: key(),
        confirm: "RUN",
      })),
    );
    await build(set[0]!.jobId);
    await call("knowledge_embedding_profile_get", refs);
    await call("knowledge_index_status", refs);
    const out = await call(
      "knowledge_search",
      refs.map((r) => ({ ...r, query: "Alpha" })),
    );
    expect((out[0]!.results as Record<string, unknown>[]).map((r) => r.path)).toContain(
      "concepts/concept.md",
    );
    await call(
      "knowledge_structured_search",
      refs.map((r) => ({ ...r, type: "concept" })),
    );
    const structured = await call(
      "knowledge_structured_search",
      refs.map((r) => ({
        ...r,
        structured: [
          { column: "count", equals: 2 },
          { column: "name", equals: "target" },
        ],
      })),
    );
    expect((structured[0]!.items as Record<string, unknown>[])[0]?.matchedRow).toEqual({
      name: "target",
      count: 2,
    });
    const rebuilt = await call(
      "knowledge_index_rebuild",
      refs.map((r) => ({ ...r, idempotencyKey: key(), confirm: "RUN" })),
    );
    await build(rebuilt[0]!.jobId);
  }, 120000);
  it("complete zero-chunk generations stay searchable without query embedding", async () => {
    const created = await call(
      "knowledge_bases_create",
      [0, 1].map(() => ({
        name: "Empty",
        slug: "empty",
        description: "Zero chunk corpus",
        idempotencyKey: key(),
      })),
    );
    const empty = created.map((v) => v.kb as Record<string, unknown>);
    const erased = await call(
      "knowledge_documents_update",
      empty.map((v) => ({
        kbId: v.id,
        baseRevision: v.headSha,
        path: "index.md",
        content: { markdown: "" },
        idempotencyKey: key(),
      })),
    );
    const set = await call(
      "knowledge_embedding_profile_set",
      empty.map((v, i) => ({
        kbId: v.id,
        providerId: provider[i],
        revision: 1,
        idempotencyKey: key(),
        confirm: "RUN",
      })),
    );
    await build(set[0]!.jobId);
    const result = await call(
      "knowledge_search",
      empty.map((v) => ({ kbId: v.id, query: "Alpha" })),
    );
    expect(result[0]!.results).toEqual([]);
    expect(result[1]!.results).toEqual([]);
    await call(
      "knowledge_structured_search",
      empty.map((v) => ({ kbId: v.id, type: "concept" })),
    );
    await call(
      "knowledge_bases_delete",
      empty.map((v) => ({
        kbId: v.id,
        metadataVersion: 1,
        confirm: "DELETE",
        idempotencyKey: key(),
      })),
    );
    expect(erased.map((v) => v.kind)).toEqual(["applied", "applied"]);
  }, 120000);
  it("FTS goldens: diacritic folding, punctuated AND, phrases and the hybrid majority match the local backend", async () => {
    const created = await call(
      "knowledge_bases_create",
      [0, 1].map(() => ({
        name: "FTS",
        slug: "fts-goldens",
        description: "FTS golden corpus",
        idempotencyKey: key(),
      })),
    );
    const kbs = created.map((v) => v.kb as Record<string, unknown>);
    let revs = (
      await call(
        "knowledge_documents_update",
        kbs.map((v) => ({
          kbId: v.id,
          baseRevision: v.headSha,
          path: "index.md",
          content: { markdown: "" },
          idempotencyKey: key(),
        })),
      )
    ).map((v) => String(v.commitSha));
    for (const [path, markdown] of [
      ["art.md", "the art of state planning\n"],
      ["cafe.md", "café au lait\n"],
      ["mail.md", "write to user at example dot com\n"],
      ["other.md", "nothing relevant here\n"],
      ["pi.md", "pi is 3.14 roughly\n"],
    ] as const)
      revs = (
        await call(
          "knowledge_documents_create",
          kbs.map((v, i) => ({
            kbId: v.id,
            baseRevision: revs[i],
            path,
            content: { markdown },
            idempotencyKey: key(),
          })),
        )
      ).map((v) => String(v.commitSha));
    const set = await call(
      "knowledge_embedding_profile_set",
      kbs.map((v, i) => ({
        kbId: v.id,
        providerId: provider[i],
        revision: 1,
        idempotencyKey: key(),
        confirm: "RUN",
      })),
    );
    await build(set[0]!.jobId);
    for (const [query, matched] of [
      ["cafe", ["cafe.md"]],
      ["café", ["cafe.md"]],
      ["state-of-the-art", ["art.md"]],
      ["user@example.com", ["mail.md"]],
      ["3.14", ["pi.md"]],
      ["3.15", []],
      // In a hybrid search 1 of 2 words is no majority; 2 of 3 is.
      ["banana state", []],
      ["banana state planning", ["art.md"]],
      ['"state planning"', ["art.md"]],
      ['"planning state"', []],
    ] as const) {
      // `call` asserts server == local; every chunk is in the vector arm (fewer than 80), so
      // exactly the FTS matches score above one arm's normalized maximum, 0.5 (L-25).
      const out = await call(
        "knowledge_search",
        kbs.map((v) => ({ kbId: v.id, query, limit: 20 })),
      );
      for (const side of out)
        expect(
          (side.results as Array<{ path: string; score: number }>)
            .filter((hit) => hit.score > 0.5 + 1e-9)
            .map((hit) => hit.path),
          query,
        ).toEqual(matched);
    }
    await call(
      "knowledge_bases_delete",
      kbs.map((v) => ({
        kbId: v.id,
        metadataVersion: 1,
        confirm: "DELETE",
        idempotencyKey: key(),
      })),
    );
  }, 120000);
  it("sealed results are ciphertext, exact errors and final effects cover every catalog row", async () => {
    // Random envelopes have exact closed shapes and fixed binding fields; their
    // cryptographic bytes are deliberately compared by schema and absence of literal.
    const write = await Promise.all(
      refs.map((r, i) =>
        i === 0
          ? remote("knowledge_documents_create", {
              ...r,
              baseRevision: heads[i],
              idempotencyKey: key(),
              path: "sealed.md",
              content: { markdown: sealed[i] },
            })
          : local.call("knowledge_documents_create", {
              ...r,
              baseRevision: heads[i],
              idempotencyKey: key(),
              path: "sealed.md",
              content: { markdown: sealed[i] },
            }),
      ),
    );
    heads = write.map((v) => String(v.structuredContent.data!.commitSha));
    const encrypted = await Promise.all(
      refs.map((r, i) =>
        i === 0
          ? remote("knowledge_sealed_resolve", {
              ...r,
              path: "sealed.md",
              reference: sealed[i],
              recipientKeyId: local.setup().recipientKeyId,
            })
          : local.call("knowledge_sealed_resolve", {
              ...r,
              path: "sealed.md",
              reference: sealed[i],
              recipientKeyId: local.setup().recipientKeyId,
            }),
      ),
    );
    for (const r of encrypted) {
      expect(r.isError).toBe(false);
      expect((r.structuredContent.data!.envelope as Record<string, unknown>).algorithm).toBe(
        "X25519-HKDF-SHA256-AES256GCM",
      );
      expect(JSON.stringify(r)).not.toContain("disposable-sealed-parity-canary");
    }
    for (const result of encrypted) {
      const data = result.structuredContent.data!;
      const envelope = data.envelope as Record<string, string>;
      expect(Object.keys(envelope).sort()).toEqual([
        "algorithm",
        "ciphertext",
        "ephemeralPublicKey",
        "nonce",
      ]);
      const ttl = Date.parse(String(data.expiresAt)) - Date.now();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60000);
      const privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b656e04220420", "hex"),
          Buffer.alloc(32, 2),
        ]),
        format: "der",
        type: "pkcs8",
      });
      const publicKey = createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b656e032100", "hex"),
          Buffer.from(envelope.ephemeralPublicKey!, "base64"),
        ]),
        format: "der",
        type: "spki",
      });
      const shared = diffieHellman({ privateKey, publicKey });
      const keyBytes = Buffer.from(
        hkdfSync(
          "sha256",
          shared,
          createHash("sha256").update(String(data.reference)).digest(),
          Buffer.from(`kb/sealed/1\0${data.recipientKeyId}\0${data.expiresAt}`),
          32,
        ),
      );
      const bytes = Buffer.from(envelope.ciphertext!, "base64");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        keyBytes,
        Buffer.from(envelope.nonce!, "base64"),
      );
      decipher.setAAD(Buffer.from(`${data.reference}\0${data.recipientKeyId}\0${data.expiresAt}`));
      decipher.setAuthTag(bytes.subarray(-16));
      try {
        expect(
          Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(),
        ).toBe("disposable-sealed-parity-canary");
      } finally {
        keyBytes.fill(0);
        shared.fill(0);
      }
    }
    await both(
      "knowledge_sealed_resolve",
      refs.map((r, i) => ({
        ...r,
        path: "sealed.md",
        reference: sealed[i],
        recipientKeyId: "00000000-0000-4000-8000-000000000004",
      })),
      true,
    );
    successful.add("knowledge_sealed_resolve");
    const gone = await call(
      "knowledge_documents_delete",
      refs.map((r, i) => ({
        ...r,
        baseRevision: heads[i],
        path: "sealed.md",
        confirm: "DELETE",
        idempotencyKey: key(),
      })),
    );
    heads = gone.map((v) => String(v.commitSha));
    await call(
      "knowledge_bases_delete",
      refs.map((r) => ({ ...r, metadataVersion: 2, confirm: "DELETE", idempotencyKey: key() })),
    );
    expect([...successful].sort()).toEqual([...KB_TOOL_NAMES].sort());
  }, 120000);
});
