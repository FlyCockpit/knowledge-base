import { execFile } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { remoteSealedNamespace } from "@knowledge-base/api/lib/kb/attachment";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createChangesPublication } from "@knowledge-base/api/lib/kb/changes";
import {
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import { canonicalRequestHash } from "@knowledge-base/api/lib/kb/operation-intent";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { enrollSealedRecord } from "@knowledge-base/api/lib/kb/sealed-records";
import { resolveSealedReference } from "@knowledge-base/api/lib/kb/sealed-resolve";
import {
  authenticatePersonalToken,
  createGrantCredentialVerifier,
  revokePersonalToken,
} from "@knowledge-base/api/lib/mcp-token-access";
import { createBootstrapDatabaseAdapter } from "@knowledge-base/auth/bootstrap";
import {
  createDeviceApprovalService,
  digestDeviceCode,
  resolveDevicePlugins,
} from "@knowledge-base/auth/device-approval";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import type { Prisma } from "@knowledge-base/db/client";
import { betterAuth } from "better-auth";
import { admin, twoFactor } from "better-auth/plugins";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requireBuiltArtifact } from "./build-artifacts.mjs";
import { openKbPostgresClusterFromEnv } from "./index";

const wiring = vi.hoisted(() => ({ runtime: {}, settings: vi.fn(), user: vi.fn() }));
vi.mock("@knowledge-base/env/server", () => ({
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  env: { NODE_ENV: "test" },
}));
vi.mock("@knowledge-base/api/lib/kb/runtime", () => ({ getKbRuntime: () => wiring.runtime }));
vi.mock("../../../api/src/lib/procedure-budget", () => ({
  createProcedureBudget: () => async () => {},
}));
vi.mock("@knowledge-base/db", () => ({
  default: {
    appSetting: { findMany: (args: unknown) => wiring.settings(args) },
    // The forced-2FA gate re-reads the live user row before refusing.
    user: { findUnique: (args: unknown) => wiring.user(args) },
  },
}));
// Real HTTP + provider + oRPC + PG; the Redis procedure budget is isolated here.
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient("runtime");
wiring.settings.mockImplementation((args) => prisma.appSetting.findMany(args));
wiring.user.mockImplementation((args) => prisma.user.findUnique(args));
const observedErrors: unknown[] = [];
const pendingRequests = new Set<Promise<void>>();
let cliAction: Promise<unknown> | undefined;
let deviceAction: Promise<void> | undefined;
function runOwnedDeviceAction(run: () => Promise<void>): Promise<void> {
  deviceAction = Promise.resolve().then(run);
  return deviceAction;
}
async function drainDeviceActions(): Promise<void> {
  await deviceAction?.catch(() => {});
  await cliAction?.catch(() => {});
  await Promise.all([...pendingRequests]);
}
const cliDir = resolve(import.meta.dirname, "../../../../apps/cli");
let observe:
  | ((path: string, body: string, status: number, response: string) => Promise<void>)
  | undefined;
const server = createServer();
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
const baseUrl = `http://127.0.0.1:${address.port}`;
const transport = baseUrl;

const secret = "disposable-device-integration-signing-secret";
const resource = `${baseUrl}/mcp`;
wiring.runtime = { prisma, canonicalOrigin: baseUrl };
const captured: string[] = [];
const auth = betterAuth({
  database: createBootstrapDatabaseAdapter(prisma),
  baseURL: baseUrl,
  secret,
  trustedOrigins: [baseUrl],
  rateLimit: { enabled: false },
  logger: { log: (_level, message, ...args) => captured.push(JSON.stringify([message, ...args])) },
  plugins: [...resolveDevicePlugins({ db: prisma, baseUrl }), admin(), twoFactor()],
});
const service = createDeviceApprovalService({ db: prisma, resource });

function barrier() {
  let release = () => {};
  const wait = new Promise<void>((done) => {
    release = done;
  });
  return { wait, release };
}

/** Only adds a barrier AFTER the real session read. All SQL/locks/commits are real. */
function pausedIdentity() {
  const reached = barrier();
  const resume = barrier();
  const observed = new Proxy(prisma, {
    get(target, key, receiver) {
      if (key !== "$transaction") return Reflect.get(target, key, receiver);
      return <T>(
        run: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: {
          timeout?: number;
          maxWait?: number;
        },
      ) =>
        target.$transaction(
          (tx) =>
            run(
              new Proxy(tx, {
                get(client, property, txReceiver) {
                  if (property !== "session") return Reflect.get(client, property, txReceiver);
                  return new Proxy(client.session, {
                    get(sessions, method, sessionReceiver) {
                      if (method !== "findUnique")
                        return Reflect.get(sessions, method, sessionReceiver);
                      return async (args: Prisma.SessionFindUniqueArgs) => {
                        const row = await sessions.findUnique(args);
                        reached.release();
                        await resume.wait;
                        return row;
                      };
                    },
                  });
                },
              }),
            ),
          options,
        );
    },
  });
  return { service: createDeviceApprovalService({ db: observed, resource }), reached, resume };
}

async function waitingAuthority() {
  await vi.waitFor(
    async () => {
      const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_locks
       WHERE locktype = 'advisory' AND classid = 1262633301 AND objid = 1
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      expect(rows[0]?.count).toBeGreaterThan(0);
    },
    { timeout: 2000, interval: 10 },
  );
}

function cookieFor(token: string) {
  const signed = `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
  return `better-auth.session_token=${encodeURIComponent(signed)}`;
}
// Cross-project modules are type-checked by their owning packages.
const { guardDeviceApproval } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/device-approval-gate.ts"))
    .href
);
const { cliCredentialsRouter } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/cli-credentials.ts")).href
);
const { mcpTokensRouter } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../api/src/routers/mcp-tokens.ts")).href
);
const { RPCHandler } = await import(
  pathToFileURL(
    resolve(
      import.meta.dirname,
      "../../../api/node_modules/@orpc/server/dist/adapters/fetch/index.mjs",
    ),
  ).href
);
const rpc = new RPCHandler({ cliCredentials: cliCredentialsRouter, mcpTokens: mcpTokensRouter });
const app = new Hono();
app.use(
  "*",
  logger((line) => captured.push(line)),
);
app.all("/api/auth/*", async (c) => {
  const rejected = await guardDeviceApproval(c.req.raw, {
    baseUrl,
    service,
    getSession: auth.api.getSession,
  });
  return rejected ?? auth.handler(c.req.raw);
});
app.all("/rpc/*", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const result = await rpc.handle(c.req.raw, {
    prefix: "/rpc",
    context: { session, clientIp: "127.0.0.1" },
  });
  return result.response ?? new Response(null, { status: 404 });
});
const { createBearerAdmission } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/mcp/auth.ts")).href
);
const { createKbTokenRoutes } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../apps/server/src/kb-token-routes.ts")).href
);
app.route(
  "/",
  createKbTokenRoutes({
    admit: createBearerAdmission({
      query: prismaAssetQuery(prisma),
      origin: baseUrl,
      verifyOAuth: async () => {
        throw new Error("PAT fixture never invokes OAuth");
      },
    }),
    revoke: (userId: string, tokenId: string) =>
      revokePersonalToken(
        {
          canonicalOrigin: baseUrl,
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
                      throw new Error("unused device fixture capability");
                    },
                  }),
              }),
          } satisfies KbRuntimeConfig["coordinator"],
        },
        userId,
        tokenId,
      ),
    charge: async () => {},
    isClosing: () => false,
  }),
);
server.on("request", (req, res) => {
  const observer = observe;
  const work = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const response = await app.fetch(
      new Request(baseUrl + req.url, {
        method: req.method,
        headers,
        ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    const responseBody = await response.arrayBuffer();
    if (observer && req.url)
      await observer(
        req.url,
        Buffer.concat(chunks).toString(),
        response.status,
        Buffer.from(responseBody).toString(),
      );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(responseBody));
  })().catch((error) => {
    observedErrors.push(error);
    res.writeHead(500);
    res.end();
  });
  pendingRequests.add(work);
  void work.then(() => pendingRequests.delete(work));
});
function send(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(transport + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: new URL(baseUrl).host,
      origin: baseUrl,
      "content-type": "application/json",
      "x-csrf-token": "orpc",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const startSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});
async function fixture() {
  const user = await prisma.user.create({
    data: { name: "Device", email: `${randomUUID()}@example.invalid`, twoFactorEnabled: true },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) },
  });
  const cookie = cookieFor(session.token);
  const start = await send("/api/auth/device/code", {
    client_id: "kb-cli",
    scope: "mcp:read mcp:write",
  });
  expect(start.status).toBe(200);
  const code = startSchema.parse(await start.json());
  const actor = { userId: user.id, sessionId: session.id };
  const registerRecipient = (recipientKey: {
    recipientKeyId: string;
    recipientPublicKey: string;
  }) =>
    send("/rpc/cliCredentials/registerDeviceRecipient", {
      json: { deviceCode: code.device_code, recipientKey },
    });
  async function claim() {
    const res = await send(`/api/auth/device?user_code=${code.user_code}`, undefined, { cookie });
    expect(res.status).toBe(200);
    return z.object({ nonce: z.uuid() }).parse(await res.json());
  }
  const select = (
    nonce: string,
    selection: unknown = { scopes: ["mcp:read"], toolGroups: [...MCP_TOOL_GROUPS], acl: [] },
  ) =>
    send(
      "/rpc/cliCredentials/selectDeviceIntent",
      { json: { userCode: code.user_code, nonce, selection } },
      { cookie },
    );
  const decide = (nonce: string, decision = "approve") =>
    send(
      `/api/auth/device/${decision}`,
      { userCode: code.user_code },
      { cookie, "x-device-approval-nonce": nonce },
    );
  const exchange = (extra = {}) =>
    send("/rpc/cliCredentials/exchangeDeviceCode", {
      json: { deviceCode: code.device_code, name: "Laptop", ...extra },
    });
  async function approve(selection?: unknown) {
    const { nonce } = await claim();
    expect((await select(nonce, selection)).status).toBe(200);
    expect((await decide(nonce)).status).toBe(200);
    return nonce;
  }
  const maturePoll = () =>
    prisma.deviceCode.update({
      where: { deviceCodeDigest: digestDeviceCode(code.device_code) },
      data: { lastPolledAt: new Date(Date.now() - 10000) },
    });
  return {
    code,
    user,
    session,
    actor,
    cookie,
    claim,
    select,
    decide,
    exchange,
    approve,
    maturePoll,
    registerRecipient,
  };
}

function sealedDeviceTest(
  name: string,
  run: (fixture: Awaited<ReturnType<typeof sealedDeviceFixture>>) => Promise<void>,
): void {
  describe(name, () => {
    let fixture: Awaited<ReturnType<typeof sealedDeviceFixture>> | undefined;
    let setup: Promise<void> | undefined;
    beforeAll(() => {
      // Real Git/enrollment prepares the history. The HTTP action keeps 30s.
      setup = sealedDeviceFixture().then((prepared) => {
        fixture = prepared;
      });
      return setup;
    }, 180_000);
    afterAll(async () => {
      await setup?.catch(() => {});
      await drainDeviceActions();
      fixture?.cleanup();
    }, 300_000);
    it("preserves rejection, consumption and legitimate retry assertions", () =>
      runOwnedDeviceAction(async () => {
        if (!fixture) throw new Error("sealed device fixture is not ready");
        await run(fixture);
      }));
  });
}

type DeviceFixture = Awaited<ReturnType<typeof fixture>>;
async function sealedDeviceFixture() {
  const f = await fixture();
  const kb = await prisma.knowledgeBase.create({
    data: {
      ownerId: f.user.id,
      name: "Sealed device",
      slug: `device-${randomUUID()}`,
      description: "Sealed device regression fixture",
      state: "CREATING",
    },
  });
  const reposDir = mkdtempSync(join(tmpdir(), "kb-device-sealed-"));
  const executor: GitMutatingExecutor = {
    async exec({ cwd, argv, env }) {
      await promisify(execFile)(argv[0]!, argv.slice(1), { cwd, env });
    },
  };
  const runtime = {
    prisma,
    canonicalOrigin: baseUrl,
    reposDir,
    ratePort: createMemoryRatePort(),
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
  } satisfies Pick<
    KbRuntimeConfig,
    "prisma" | "canonicalOrigin" | "reposDir" | "ratePort" | "coordinator"
  >;
  try {
    const base = await writeInitialMainCommit(
      { reposDir, kbId: kb.id, executor },
      { message: "fixture", description: "Fixture description" },
    );
    await prisma.knowledgeBase.update({
      where: { id: kb.id },
      data: { state: "ACTIVE", headSha: base },
    });
    setKbRecoveryComplete(true);
    const masterKey = randomBytes(32).toString("base64");
    const canary = "device-sealed-regression-canary";
    const created = await enrollSealedRecord(
      runtime,
      { kind: "browser", userId: f.user.id },
      {
        kbId: kb.id,
        namespace: remoteSealedNamespace(baseUrl, kb.id),
        plaintext: canary,
        idempotencyKey: randomUUID(),
      },
      masterKey,
    );
    const keyPair = generateKeyPairSync("x25519");
    const record = await prisma.sealedRecord.findFirstOrThrow({ where: { kbId: kb.id } });
    const recipient = {
      kbId: kb.id,
      namespace: record.namespace,
      recordId: record.recordId,
      recipientKeyId: randomUUID(),
      recipientPublicKey: keyPair.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const selection = {
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: kb.id, bits: ["read"] }],
      recipients: [recipient],
    };
    expect(
      (
        await f.registerRecipient({
          recipientKeyId: recipient.recipientKeyId,
          recipientPublicKey: recipient.recipientPublicKey,
        })
      ).status,
    ).toBe(200);
    const request = {
      mode: "edit" as const,
      baseRevision: base,
      title: "Sealed",
      sourceSessionIds: [],
      changes: [
        { op: "create" as const, path: "sealed.md", content: { markdown: created.reference } },
      ],
    };
    const publication = createChangesPublication({
      store: prismaAuthorityStore(prisma),
      principal: { kind: "browser", userId: f.user.id },
      reposDir,
      kbId: kb.id,
      canonicalOrigin: baseUrl,
      idempotencyKey: randomUUID(),
      request,
      operation: "CHANGES_APPLY",
      requestHash: canonicalRequestHash(request),
    });
    await runtime.coordinator.run({
      opId: randomUUID(),
      kind: "git-write",
      kbIds: [kb.id],
      barrier: publication.barrier,
      run: ({ lease }) => publication.publish(lease, executor),
    });
    return {
      ...f,
      kb,
      record,
      recipient,
      selection,
      keyPair,
      runtime,
      masterKey,
      canary,
      reference: created.reference,
      cleanup: () => rmSync(reposDir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(reposDir, { recursive: true, force: true });
    throw error;
  }
}

const revokers: { name: string; prepare: (f: DeviceFixture) => Promise<() => Promise<void>> }[] = [
  ...[
    "sign-out",
    "revoke-session",
    "revoke-sessions",
    "revoke-other-sessions",
    "admin/revoke-user-session",
    "admin/revoke-user-sessions",
  ].map((path) => ({
    name: path,
    async prepare(f: DeviceFixture) {
      let cookie = f.cookie;
      if (path === "revoke-other-sessions") {
        const survivor = await prisma.session.create({
          data: {
            userId: f.user.id,
            token: randomUUID(),
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
        cookie = cookieFor(survivor.token);
      }
      if (path.startsWith("admin/")) {
        const administrator = await fixture();
        await prisma.user.update({ where: { id: administrator.user.id }, data: { role: "admin" } });
        cookie = administrator.cookie;
      }
      const body =
        path === "revoke-session"
          ? { token: f.session.token }
          : path === "admin/revoke-user-session"
            ? { sessionToken: f.session.token }
            : path === "admin/revoke-user-sessions"
              ? { userId: f.user.id }
              : {};
      return async () => {
        const response = await auth.handler(
          new Request(`${baseUrl}/api/auth/${path}`, {
            method: "POST",
            headers: { cookie, origin: baseUrl, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        expect(response.status).toBe(200);
        if (path === "revoke-other-sessions")
          expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).not.toBeNull();
      };
    },
  })),
  {
    name: "auth.api.revokeSession",
    async prepare(f) {
      return async () => {
        const response = await auth.api.revokeSession({
          headers: new Headers({ cookie: f.cookie, origin: baseUrl }),
          body: { token: f.session.token },
          asResponse: true,
        });
        expect(response.status).toBe(200);
      };
    },
  },
  ...(["delete", "deleteMany"] as const).flatMap((method) =>
    [false, true].map((transactional) => ({
      name: `adapter.${method}/${transactional ? "transactional" : "direct"}`,
      async prepare(f: DeviceFixture) {
        const adapter = createBootstrapDatabaseAdapter(prisma)(auth.options);
        const remove = (tx: typeof adapter) =>
          tx[method]({
            model: "session",
            where: [{ field: "token", value: f.session.token }],
          });
        return async () => {
          if (transactional) await adapter.transaction(remove);
          else await remove(adapter);
        };
      },
    })),
  ),
];

async function selected(f: DeviceFixture) {
  const { nonce } = await f.claim();
  expect((await f.select(nonce)).status).toBe(200);
  return { userCode: f.code.user_code, nonce };
}

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
});
describe("device HTTP/PG boundary", () => {
  it("R34b registration is immutable, secret-bound, pre-claim only, and cannot authorize substituted recipient keys", () =>
    runOwnedDeviceAction(async () => {
      const f = await fixture();
      const keyPair = generateKeyPairSync("x25519");
      const key = {
        recipientKeyId: randomUUID(),
        recipientPublicKey: keyPair.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
      };
      expect(
        (
          await f.registerRecipient({
            ...key,
            recipientPublicKey: Buffer.alloc(32).toString("base64"),
          })
        ).status,
      ).toBe(400);
      const expired = await fixture();
      await prisma.deviceCode.update({
        where: { userCode: expired.code.user_code },
        data: { expiresAt: new Date(0) },
      });
      expect((await expired.registerRecipient(key)).status).toBe(400);
      expect((await f.registerRecipient(key)).status).toBe(200);
      expect((await f.registerRecipient(key)).status).toBe(200);
      expect((await f.registerRecipient({ ...key, recipientKeyId: randomUUID() })).status).toBe(
        400,
      );
      expect(
        (
          await send("/rpc/cliCredentials/registerDeviceRecipient", {
            json: { deviceCode: "unknown-device", recipientKey: key },
          })
        ).status,
      ).toBe(400);
      const claim = await f.claim();
      expect((await f.registerRecipient(key)).status).toBe(400);
      expect(
        (
          await send(`/api/auth/device?user_code=${f.code.user_code}`, undefined, {
            cookie: f.cookie,
          })
        ).status,
      ).toBe(200);
      const kb = await prisma.knowledgeBase.create({
        data: {
          ownerId: f.user.id,
          name: "Registered",
          slug: `registered-${randomUUID()}`,
          description: "Recipient binding fixture",
          state: "ACTIVE",
        },
      });
      const record = await prisma.sealedRecord.create({
        data: {
          namespace: randomUUID(),
          recordId: randomUUID(),
          kbId: kb.id,
          ownerId: f.user.id,
          ownerSnapshot: f.user.id,
          ciphertext: "disposable-fixture",
        },
      });
      const recipient = {
        kbId: kb.id,
        namespace: record.namespace,
        recordId: record.recordId,
        ...key,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const selection = {
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: kb.id, bits: ["read"] }],
        recipients: [{ ...recipient, recipientKeyId: randomUUID() }],
      };
      expect((await f.select(claim.nonce, selection)).status).toBe(400);
      const otherKey = generateKeyPairSync("x25519")
        .publicKey.export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64");
      expect(
        (
          await f.select(claim.nonce, {
            ...selection,
            recipients: [{ ...recipient, recipientPublicKey: otherKey }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await prisma.deviceApproval.findUniqueOrThrow({
            where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
          })
        ).selection,
      ).toBeNull();
      const valid = { ...selection, recipients: [recipient] };
      expect((await f.select(claim.nonce, valid)).status).toBe(200);
      const substitutions = [
        { ...recipient, recipientKeyId: randomUUID() },
        { ...recipient, recipientPublicKey: otherKey },
      ];
      // Persisted intent corruption cannot bypass either later binding check.
      for (const stage of ["approve", "exchange"] as const) {
        for (const substituted of substitutions) {
          await prisma.deviceApproval.update({
            where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
            data: { selection: { ...valid, recipients: [substituted] } },
          });
          const response = stage === "approve" ? await f.decide(claim.nonce) : await f.exchange();
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(
            (
              await prisma.deviceApproval.findUniqueOrThrow({
                where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
              })
            ).consumedAt,
          ).toBeNull();
          expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(0);
        }
        await prisma.deviceApproval.update({
          where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
          data: { selection: valid },
        });
        if (stage === "approve") expect((await f.decide(claim.nonce)).status).toBe(200);
      }
      expect((await f.exchange()).status).toBe(200);
    }));
  beforeAll(async () => {
    requireBuiltArtifact(resolve(cliDir, "target/debug/kb"), "pnpm test:kb --build-only device");
  }, 180_000);
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(async () => {
    await drainDeviceActions();
    deviceAction = undefined;
    cliAction = undefined;
    observe = undefined;
    vi.useRealTimers();
    expect(observedErrors.splice(0)).toEqual([]);
  }, 300_000);
  it("an observer assertion failure returns a response and is retained for the test owner", () => {
    return runOwnedDeviceAction(async () => {
      const failure = new Error("disposable-observer-failure");
      observe = async () => {
        throw failure;
      };
      try {
        const response = await fetch(`${baseUrl}/fixture-observer-failure`, {
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(500);
        expect(observedErrors.splice(0)).toEqual([failure]);
      } finally {
        observe = undefined;
      }
    });
  });
  it("teardown joins an in-flight response using its captured observer", async () => {
    let reached!: () => void;
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished!: () => void;
    const observerFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let original = 0;
    let successor = 0;
    observe = async () => {
      reached();
      await resumed;
      original++;
      finished();
    };
    const response = fetch(`${baseUrl}/fixture-held-response`, {
      signal: AbortSignal.timeout(5000),
    });
    let drained = false;
    try {
      await observed;
      observe = async () => {
        successor++;
      };
      const drain = drainDeviceActions().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);
      const order = Promise.race([
        observerFinished.then(() => "observer"),
        drain.then(() => "drain"),
      ]);
      expect(
        await Promise.race([
          drain.then(() => "drain"),
          new Promise<string>((resolve) => setTimeout(() => resolve("held"), 50)),
        ]),
      ).toBe("held");
      release();
      expect(await order).toBe("observer");
      expect((await response).status).toBe(404);
      await drain;
      expect(drained).toBe(true);
      expect(original).toBe(1);
      expect(successor).toBe(0);
    } finally {
      release();
      await response.catch(() => {});
      observe = undefined;
    }
  });
  it("runs the CLI through real snake_case start, typed pending/slow_down oRPC, approval and exact PAT self-revoke", () => {
    return runOwnedDeviceAction(async () => {
      const run = promisify(execFile);
      const local = mkdtempSync(resolve(tmpdir(), "kb-cli-device-"));
      const f = await fixture();
      const sibling = f;
      await sibling.approve();
      const siblingToken = z
        .object({ json: z.object({ credentialId: z.string() }) })
        .parse(await (await sibling.exchange()).json()).json;
      let code: z.infer<typeof startSchema> | undefined;
      let exchanges = 0;
      let mintedId = "";
      let patCanary = "";
      observe = async (path, body, status, response) => {
        if (path === "/api/auth/device/code") {
          expect(JSON.parse(body)).toEqual({ client_id: "kb-cli", scope: "mcp:read mcp:write" });
          expect(status).toBe(200);
          code = startSchema.parse(JSON.parse(response));
        }
        if (path === "/rpc/cliCredentials/exchangeDeviceCode") {
          expect(JSON.parse(body)).toEqual({
            json: { deviceCode: code!.device_code, name: "Actual CLI" },
          });
          exchanges++;
          const parsed = JSON.parse(response);
          if (exchanges === 1) {
            expect(status).toBe(400);
            expect(parsed).toMatchObject({
              json: { code: "BAD_REQUEST", data: { error: "authorization_pending" } },
            });
            await prisma.deviceCode.update({
              where: { userCode: code!.user_code },
              data: { lastPolledAt: new Date(Date.now() + 60000) },
            });
          } else if (exchanges === 2) {
            expect(status).toBe(400);
            expect(parsed).toMatchObject({
              json: { code: "BAD_REQUEST", data: { error: "slow_down" } },
            });
            Object.assign(f.code, code);
            await f.approve();
            await f.maturePoll();
          } else {
            expect(status).toBe(200);
            const result = z
              .object({
                json: z.strictObject({
                  credentialId: z.string(),
                  userId: z.string(),
                  secret: z.string(),
                  expiresAt: z.iso.datetime(),
                  resource: z.literal(resource),
                }),
              })
              .parse(parsed).json;
            mintedId = result.credentialId;
            patCanary = result.secret;
          }
        }
        if (path === "/api/kb/token/revoke-self") {
          expect(body).toBe("");
          expect(status).toBe(204);
        }
      };
      const env = {
        ...process.env,
        KB_CONFIG_DIR: resolve(local, "config"),
        KB_DATA_DIR: resolve(local, "data"),
        RUST_LOG: "debug",
      };
      try {
        const binary = resolve(cliDir, "target/debug/kb");
        const args = ["--server", baseUrl, "--allow-loopback-http"];
        const loginCall = run(binary, ["login", ...args, "--name", "Actual CLI"], {
          env,
          timeout: 110_000,
          killSignal: "SIGKILL",
        });
        cliAction = loginCall;
        const login = await loginCall;
        expect(exchanges).toBe(3);
        expect(`${login.stdout}${login.stderr}`).not.toContain(patCanary);
        expect(`${login.stdout}${login.stderr}`).not.toContain(code!.device_code);
        expect(
          (await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: mintedId } })).revokedAt,
        ).toBeNull();
        const logoutCall = run(binary, ["logout", ...args], {
          env,
          timeout: 10_000,
          killSignal: "SIGKILL",
        });
        cliAction = logoutCall;
        const logout = await logoutCall;
        expect(`${logout.stdout}${logout.stderr}`).not.toContain(patCanary);
        const revoked = await prisma.mcpPersonalToken.findUniqueOrThrow({
          where: { id: mintedId },
          include: { grant: true },
        });
        expect(revoked.revokedAt).not.toBeNull();
        expect(revoked.grant.revokedAt).not.toBeNull();
        expect(
          (
            await prisma.mcpPersonalToken.findUniqueOrThrow({
              where: { id: siblingToken.credentialId },
            })
          ).revokedAt,
        ).toBeNull();
        expect(
          readdirSync(resolve(local, "data/credentials")).filter((name) => name.endsWith(".json")),
        ).toEqual([]);
      } finally {
        observe = undefined;
        rmSync(local, { recursive: true, force: true });
      }
    });
  }, 120000);
  it.each(["claim", "select", "check", "deny"] as const)(
    "in-flight %s retains its live session until commit",
    (operation) => {
      return runOwnedDeviceAction(async () => {
        const f = await fixture();
        const input =
          operation === "claim"
            ? { userCode: f.code.user_code, nonce: randomUUID() }
            : operation === "select"
              ? { userCode: f.code.user_code, ...(await f.claim()) }
              : await selected(f);
        const paused = pausedIdentity();
        const run =
          operation === "claim"
            ? paused.service.claim(f.actor, input.userCode)
            : operation === "select"
              ? paused.service.select(f.actor, {
                  ...input,
                  selection: { scopes: ["mcp:read"], toolGroups: [...MCP_TOOL_GROUPS], acl: [] },
                })
              : operation === "check"
                ? paused.service.check(f.actor, input, "approve")
                : paused.service.decide(f.actor, input, "deny");
        let revocation: Promise<void> | undefined;
        try {
          await paused.reached.wait;
          revocation = (await revokers[1]!.prepare(f))();
          await waitingAuthority();
        } finally {
          paused.resume.release();
          await Promise.all([run, revocation]);
        }
        expect(await prisma.session.findUnique({ where: { id: f.session.id } })).toBeNull();
      });
    },
  );
  it("a revocation lock timeout fails closed without deleting the live session", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      const input = await selected(f);
      const paused = pausedIdentity();
      const approval = paused.service.decide(f.actor, input, "approve");
      try {
        await paused.reached.wait;
        const response = await auth.handler(
          new Request(`${baseUrl}/api/auth/revoke-session`, {
            method: "POST",
            headers: { cookie: f.cookie, origin: baseUrl, "content-type": "application/json" },
            body: JSON.stringify({ token: f.session.token }),
          }),
        );
        expect(response.status).toBe(500);
        expect(await prisma.session.findUnique({ where: { id: f.session.id } })).not.toBeNull();
        expect(await prisma.auditEvent.count({ where: { opId: input.nonce } })).toBe(0);
      } finally {
        paused.resume.release();
        await approval;
      }
      await (await revokers[1]!.prepare(f))();
      expect((await f.exchange()).status).toBe(200);
    });
  });
  it.each(revokers)(
    "completed $name revocation denies all human device operations",
    ({ prepare }) => {
      return runOwnedDeviceAction(async () => {
        const f = await fixture();
        const input = await selected(f);
        await (await prepare(f))();
        expect(await prisma.session.findUnique({ where: { id: f.session.id } })).toBeNull();
        const calls = [
          () => service.claim(f.actor, input.userCode),
          () =>
            service.select(f.actor, {
              ...input,
              selection: { scopes: ["mcp:read"], toolGroups: [...MCP_TOOL_GROUPS], acl: [] },
            }),
          () => service.check(f.actor, input, "approve"),
          () => service.decide(f.actor, input, "approve"),
          () => service.decide(f.actor, input, "deny"),
        ];
        for (const call of calls) await expect(call()).rejects.toThrow("invalid_grant");
        expect(
          (await prisma.deviceCode.findUniqueOrThrow({ where: { userCode: input.userCode } }))
            .status,
        ).toBe("pending");
        expect(await prisma.auditEvent.count({ where: { opId: input.nonce } })).toBe(0);
        expect((await f.exchange()).status).toBe(400);
        expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(0);
      });
    },
  );
  it.each(revokers)(
    "in-flight approval commits before $name revocation can finish",
    ({ prepare }) => {
      return runOwnedDeviceAction(async () => {
        const f = await fixture();
        const input = await selected(f);
        const revoke = await prepare(f);
        const paused = pausedIdentity();
        const approval = paused.service.decide(f.actor, input, "approve");
        let revocation: Promise<void> | undefined;
        try {
          await paused.reached.wait;
          revocation = revoke();
          await waitingAuthority();
          expect(await prisma.session.findUnique({ where: { id: f.session.id } })).not.toBeNull();
          expect(await prisma.auditEvent.count({ where: { opId: input.nonce } })).toBe(0);
        } finally {
          paused.resume.release();
          await Promise.all([approval, revocation]);
        }
        expect(await prisma.session.findUnique({ where: { id: f.session.id } })).toBeNull();
        expect(
          await prisma.auditEvent.count({ where: { opId: input.nonce, outcome: "SUCCESS" } }),
        ).toBe(1);
        // A completed legitimate approval survives logout and remains exchangeable.
        expect((await f.exchange()).status).toBe(200);
        expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(1);
      });
    },
  );
  it.each(["delete", "deleteMany"] as const)(
    "transactional session %s holds authority through commit and rollback",
    (method) => {
      return runOwnedDeviceAction(async () => {
        for (const rollback of [false, true]) {
          const f = await fixture();
          const input = await selected(f);
          const reached = barrier();
          const resume = barrier();
          const adapter = createBootstrapDatabaseAdapter(prisma)(auth.options);
          const revocation = adapter
            .transaction(async (tx) => {
              await tx[method]({ model: "session", where: [{ field: "id", value: f.session.id }] });
              reached.release();
              await resume.wait;
              if (rollback) throw new Error("rollback session revocation");
            })
            .then(
              () => "committed",
              () => "rolled back",
            );
          await reached.wait;
          const approval = service.decide(f.actor, input, "approve").then(
            () => "approved",
            () => "denied",
          );
          try {
            await waitingAuthority();
          } finally {
            resume.release();
          }
          expect(await revocation).toBe(rollback ? "rolled back" : "committed");
          expect(await approval).toBe(rollback ? "approved" : "denied");
          expect(await prisma.auditEvent.count({ where: { opId: input.nonce } })).toBe(
            rollback ? 1 : 0,
          );
          expect((await f.exchange()).status).toBe(rollback ? 200 : 400);
          expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(
            rollback ? 1 : 0,
          );
        }
      });
    },
  );
  it("rejects control-character exchange names with400, preserves approval and permits a Unicode retry", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      await f.approve();
      const before = await prisma.deviceApproval.findUniqueOrThrow({
        where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
      });
      for (const name of ["Laptop\u0000name", "\tLaptop", "Laptop\n", "Laptop\u0085name"]) {
        const response = await f.exchange({ name });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ json: { code: "BAD_REQUEST" } });
        expect(await prisma.deviceApproval.findUniqueOrThrow({ where: { id: before.id } })).toEqual(
          before,
        );
        expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(0);
        expect(
          await prisma.auditEvent.count({ where: { actorUserId: f.user.id, action: "pat_mint" } }),
        ).toBe(0);
        const humanMint = await send(
          "/rpc/mcpTokens/create",
          {
            json: { name, scopes: ["mcp:read"], toolGroups: [...MCP_TOOL_GROUPS], acl: [] },
          },
          { cookie: f.cookie },
        );
        expect(humanMint.status).toBe(400);
      }
      expect((await f.exchange({ name: "  Ordinateur 日本語 💻  " })).status).toBe(200);
      expect(
        (await prisma.mcpPersonalToken.findFirstOrThrow({ where: { userId: f.user.id } })).name,
      ).toBe("Ordinateur 日本語 💻");
    });
  });
  it("starts snake_case, pending400, slow_down400, then exactly shaped success with empty ACL and digest-only storage/logs", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      expect(f.code.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(f.code.expires_in).toBe(600);
      expect(f.code.interval).toBe(5);
      expect(new URL(f.code.verification_uri_complete).searchParams.get("user_code")).toBe(
        f.code.user_code,
      );
      const row = await prisma.deviceCode.findUniqueOrThrow({
        where: { userCode: f.code.user_code },
      });
      expect(row.deviceCodeDigest).toBe(digestDeviceCode(f.code.device_code));
      expect(row.userId).toBeNull();
      const pending = await f.exchange();
      expect(pending.status).toBe(400);
      expect(await pending.json()).toMatchObject({
        json: { code: "BAD_REQUEST", data: { error: "authorization_pending" } },
      });
      const fast = await f.exchange();
      expect(fast.status).toBe(400);
      expect(await fast.json()).toMatchObject({ json: { data: { error: "slow_down" } } });
      await f.approve();
      await f.maturePoll();
      const response = await f.exchange();
      expect(response.status).toBe(200);
      const result = z
        .object({
          json: z.strictObject({
            credentialId: z.string(),
            userId: z.string(),
            secret: z.string(),
            expiresAt: z.iso.datetime(),
            resource: z.literal(resource),
          }),
        })
        .parse(await response.json()).json;
      expect(result.userId).toBe(f.user.id);
      const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({
        where: { id: result.credentialId },
        include: { grant: { include: { acl: true, sealedConsumerGrants: true } } },
      });
      expect(pat.grant.acl).toEqual([]);
      expect(pat.grant.allowCreate).toBe(false);
      expect(pat.grant.sealedConsumerGrants).toEqual([]);
      expect(Date.parse(result.expiresAt) - Date.now()).toBeGreaterThan(89 * 86400000);
      const durable = JSON.stringify([
        row,
        pat,
        await prisma.deviceApproval.findUnique({
          where: { deviceCodeDigest: row.deviceCodeDigest },
        }),
        await prisma.auditEvent.findMany({ where: { actorUserId: f.user.id }, take: 20 }),
      ]);
      for (const plain of [f.code.device_code, result.secret]) {
        expect(durable).not.toContain(plain);
        expect(captured.join("\n")).not.toContain(plain);
      }
      expect((await f.exchange()).status).toBe(400);
    });
  });
  it("serializes simultaneous exchanges to one PAT/secret and never replays a lost response", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      await f.approve();
      const responses = await Promise.all([f.exchange(), f.exchange()]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      expect(
        bodies.filter(
          (b) => z.object({ json: z.object({ secret: z.string() }) }).safeParse(b).success,
        ),
      ).toHaveLength(1);
      expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(1);
      expect((await f.exchange()).status).toBe(400);
    });
  });
  it("rejects direct plugin approval, missing claim/nonce, forged selection and exchange ACL", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      expect((await f.decide(randomUUID())).status).toBe(403);
      const { nonce } = await f.claim();
      expect((await f.decide(nonce)).status).toBe(403);
      const direct = await auth.handler(
        new Request(`${baseUrl}/api/auth/device/approve`, {
          method: "POST",
          headers: {
            cookie: f.cookie,
            origin: baseUrl,
            "content-type": "application/json",
            "x-device-approval-nonce": nonce,
          },
          body: JSON.stringify({ userCode: f.code.user_code }),
        }),
      );
      expect(direct.status).toBe(403);
      expect((await f.select(randomUUID())).status).toBe(400);
      expect(
        (
          await f.select(nonce, {
            scopes: ["mcp:read"],
            toolGroups: [...MCP_TOOL_GROUPS],
            acl: [{ kbId: "a".repeat(24), bits: ["manage"] }],
          })
        ).status,
      ).toBe(400);
      expect((await f.exchange({ acl: [] })).status).toBe(400);
      expect(
        (
          await send("/api/auth/device/token", {
            device_code: f.code.device_code,
            client_id: "kb-cli",
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          })
        ).status,
      ).toBe(404);
      expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(0);
      expect(
        (await send("/api/auth/device/code", { client_id: "kb-cli", user_id: f.user.id })).status,
      ).toBe(400);
    });
  });
  it("requires a human session/2FA and binds nonce to the claiming session", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      const other = await fixture();
      const { nonce } = await f.claim();
      expect(
        await service
          .select(other.actor, {
            userCode: f.code.user_code,
            nonce,
            selection: { scopes: ["mcp:read"], toolGroups: [...MCP_TOOL_GROUPS], acl: [] },
          })
          .then(
            () => 200,
            () => 400,
          ),
      ).toBe(400);
      const patOnly = await send(`/api/auth/device?user_code=${f.code.user_code}`, undefined, {
        authorization: "Bearer kbp_fake",
      });
      expect(patOnly.status).toBe(401);
      await prisma.user.update({
        where: { id: f.user.id },
        data: { role: "admin", twoFactorEnabled: false, createdAt: new Date(0) },
      });
      expect((await f.select(nonce)).status).toBe(403);
      expect((await f.decide(nonce)).status).toBe(403);
    });
  });
  it("denial and expiry are terminal; a valid claimed denial needs no grant selection", () => {
    return runOwnedDeviceAction(async () => {
      const denied = await fixture();
      const { nonce } = await denied.claim();
      expect((await denied.decide(nonce, "deny")).status).toBe(200);
      expect(await (await denied.exchange()).json()).toMatchObject({
        json: { data: { error: "access_denied" } },
      });
      expect((await denied.decide(nonce)).status).toBe(403);
      const expired = await fixture();
      await expired.approve();
      await prisma.deviceCode.update({
        where: { userCode: expired.code.user_code },
        data: { expiresAt: new Date(0) },
      });
      expect(await (await expired.exchange()).json()).toMatchObject({
        json: { data: { error: "expired_token" } },
      });
      expect(
        await prisma.mcpPersonalToken.count({
          where: { userId: { in: [denied.user.id, expired.user.id] } },
        }),
      ).toBe(0);
    });
  });
  it("rechecks selected share rights after approval and rejects instead of clipping", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      const owner = await fixture();
      const kb = await prisma.knowledgeBase.create({
        data: {
          ownerId: owner.user.id,
          name: "Shared",
          slug: `device-${randomUUID()}`,
          description: "Device share revocation fixture",
          state: "ACTIVE",
        },
      });
      await prisma.kbShare.create({ data: { kbId: kb.id, userId: f.user.id, bits: ["read"] } });
      await f.approve({
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: kb.id, bits: ["read"] }],
      });
      await prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.kbShare.update({
          where: { kbId_userId: { kbId: kb.id, userId: f.user.id } },
          data: { revokedAt: new Date() },
        });
      });
      expect((await f.exchange()).status).toBe(400);
      expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(0);
    });
  });
  it("preserves exact create/KB bits, rejects selection changes and rolls back consumption on mint failure", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      const selection = {
        scopes: ["mcp:write"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [],
        allowCreate: true,
        createdKbBits: ["read"],
      };
      const nonce = await f.approve(selection);
      expect((await f.select(nonce, { ...selection, createdKbBits: ["manage"] })).status).toBe(400);
      await expect(
        service.exchange({ deviceCode: f.code.device_code, name: "Laptop" }, async () => {
          throw new Error("injected rollback");
        }),
      ).rejects.toThrow("injected rollback");
      expect(
        (
          await prisma.deviceApproval.findUniqueOrThrow({
            where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
          })
        ).consumedAt,
      ).toBeNull();
      expect((await f.exchange()).status).toBe(200);
      const pat = await prisma.mcpPersonalToken.findFirstOrThrow({
        where: { userId: f.user.id },
        include: { grant: true },
      });
      expect(pat.grant.createdKbBits).toEqual(["read"]);
      expect(pat.grant.allowCreate).toBe(true);
    });
  });
  describe.each(["select", "approve", "exchange"] as const)(
    "R29a requires enrolled 2FA for sealed device recipients at %s",
    (stage) => {
      sealedDeviceTest("checks the real device boundary", async (f) => {
        try {
          const { nonce } = await f.claim();
          if (stage !== "select") expect((await f.select(nonce, f.selection)).status).toBe(200);
          if (stage === "exchange") expect((await f.decide(nonce)).status).toBe(200);
          await prisma.user.update({ where: { id: f.user.id }, data: { twoFactorEnabled: false } });
          const response =
            stage === "select"
              ? await f.select(nonce, f.selection)
              : stage === "approve"
                ? await f.decide(nonce)
                : await f.exchange();
          expect(response.status).toBeGreaterThanOrEqual(400);
          const intent = await prisma.deviceApproval.findUniqueOrThrow({
            where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
          });
          expect(intent.consumedAt).toBeNull();
          if (stage === "select") expect(intent.selection).toBeNull();
          expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(0);
          // A valid new approval remains possible after re-enrollment. Exchange
          // denial terminalizes the approved intent, as other authority losses do.
          if (stage !== "exchange") {
            await prisma.user.update({
              where: { id: f.user.id },
              data: { twoFactorEnabled: true },
            });
            if (stage === "select") expect((await f.select(nonce, f.selection)).status).toBe(200);
            expect((await f.decide(nonce)).status).toBe(200);
            expect((await f.exchange()).status).toBe(200);
          }
        } finally {
          f.cleanup();
        }
      });
    },
  );

  describe.each(["select", "approve", "exchange"] as const)(
    "R29a rejects unusable keys and finer expiry at device %s without consumption",
    (stage) => {
      for (const defect of ["low-order", "expiry"]) {
        sealedDeviceTest(defect, async (f) => {
          try {
            const lowOrder = Buffer.alloc(32);
            lowOrder[0] = 1;
            const badRecipient = {
              ...f.recipient,
              ...(defect === "low-order"
                ? { recipientPublicKey: lowOrder.toString("base64") }
                : { expiresAt: f.recipient.expiresAt.replace(/\.\d{3}Z$/, ".123600000Z") }),
            };
            const invalid = { ...f.selection, recipients: [badRecipient] };
            const { nonce } = await f.claim();
            if (stage !== "select") expect((await f.select(nonce, f.selection)).status).toBe(200);
            if (stage === "exchange") expect((await f.decide(nonce)).status).toBe(200);
            if (stage !== "select") {
              // An older persisted selection cannot bypass current validation.
              await prisma.deviceApproval.update({
                where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
                data: { selection: invalid },
              });
            }
            const response =
              stage === "select"
                ? await f.select(nonce, invalid)
                : stage === "approve"
                  ? await f.decide(nonce)
                  : await f.exchange();
            expect(response.status).toBeGreaterThanOrEqual(400);
            const intent = await prisma.deviceApproval.findUniqueOrThrow({
              where: { deviceCodeDigest: digestDeviceCode(f.code.device_code) },
            });
            expect(intent.consumedAt).toBeNull();
            if (stage === "select") expect(intent.selection).toBeNull();
            expect(await prisma.deviceCode.count({ where: { userCode: f.code.user_code } })).toBe(
              1,
            );
            expect(await prisma.mcpPersonalToken.count({ where: { userId: f.user.id } })).toBe(0);
            expect(
              await prisma.sealedConsumerGrant.count({
                where: { namespace: f.recipient.namespace },
              }),
            ).toBe(0);
            // Rejection has no partial mint/consumption and permits a corrected retry.
            if (stage === "select") expect((await f.select(nonce, f.selection)).status).toBe(200);
            else
              await prisma.deviceApproval.update({
                where: { id: intent.id },
                data: { selection: f.selection },
              });
            if (stage !== "exchange") expect((await f.decide(nonce)).status).toBe(200);
            expect((await f.exchange()).status).toBe(200);
          } finally {
            f.cleanup();
          }
        });
      }
    },
  );

  describe("R29a round trips a generated device key through real PAT admission and recipient decryption", () => {
    sealedDeviceTest("checks the real device boundary", async (f) => {
      try {
        await f.approve(f.selection);
        const response = await f.exchange();
        expect(response.status).toBe(200);
        const minted = z
          .object({ json: z.object({ secret: z.string(), credentialId: z.string() }) })
          .parse(await response.json()).json;
        const pat = await prisma.mcpPersonalToken.findUniqueOrThrow({
          where: { id: minted.credentialId },
        });
        const stored = await prisma.sealedConsumerGrant.findFirstOrThrow({
          where: { grantId: pat.grantId },
        });
        expect(stored.expiresAt.toISOString()).toBe(f.recipient.expiresAt);
        const query = prismaAssetQuery(prisma);
        const principal = await authenticatePersonalToken(query, minted.secret, new Date());
        if (!principal) throw new Error("Device PAT identification failed");
        const result = await resolveSealedReference(
          f.runtime,
          principal,
          {
            kbId: f.kb.id,
            path: "sealed.md",
            reference: f.reference,
            recipientKeyId: f.recipient.recipientKeyId,
          },
          { verifier: createGrantCredentialVerifier(query), masterKey: f.masterKey },
        );
        expect(result.expiresAt).toBe(f.recipient.expiresAt);
        const publicKey = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b656e032100", "hex"),
            Buffer.from(result.envelope.ephemeralPublicKey, "base64"),
          ]),
          format: "der",
          type: "spki",
        });
        const shared = diffieHellman({ privateKey: f.keyPair.privateKey, publicKey });
        const key = Buffer.from(
          hkdfSync(
            "sha256",
            shared,
            createHash("sha256").update(f.reference).digest(),
            Buffer.from(`kb/sealed/1\0${f.recipient.recipientKeyId}\0${result.expiresAt}`),
            32,
          ),
        );
        try {
          const bytes = Buffer.from(result.envelope.ciphertext, "base64");
          const decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            Buffer.from(result.envelope.nonce, "base64"),
          );
          decipher.setAAD(
            Buffer.from(`${f.reference}\0${f.recipient.recipientKeyId}\0${result.expiresAt}`),
          );
          decipher.setAuthTag(bytes.subarray(-16));
          const plaintext = Buffer.concat([
            decipher.update(bytes.subarray(0, -16)),
            decipher.final(),
          ]);
          expect(plaintext.toString("utf8")).toBe(f.canary);
          plaintext.fill(0);
          expect(JSON.stringify(result)).not.toContain(f.canary);
        } finally {
          key.fill(0);
          shared.fill(0);
        }
      } finally {
        f.cleanup();
      }
    });
  });

  it("R29a leaves ordinary device approvals available to an unforced unenrolled user", () => {
    return runOwnedDeviceAction(async () => {
      const f = await fixture();
      await prisma.user.update({ where: { id: f.user.id }, data: { twoFactorEnabled: false } });
      await f.approve({ scopes: ["mcp:read"], toolGroups: [...MCP_TOOL_GROUPS], acl: [] });
      expect((await f.exchange()).status).toBe(200);
    });
  });

  it("binds selected recipients to the minted PAT generation and rejects a revoked record", () => {
    return runOwnedDeviceAction(async () => {
      for (const revoked of [false, true]) {
        const f = await fixture();
        const kb = await prisma.knowledgeBase.create({
          data: {
            ownerId: f.user.id,
            name: "Sealed",
            slug: `device-${randomUUID()}`,
            description: "Selected recipient fixture",
            state: "ACTIVE",
          },
        });
        const record = await prisma.sealedRecord.create({
          data: {
            namespace: randomUUID(),
            recordId: randomUUID(),
            kbId: kb.id,
            ownerId: f.user.id,
            ownerSnapshot: f.user.id,
            ciphertext: "fixture-ciphertext",
          },
        });
        const recipient = {
          kbId: kb.id,
          namespace: record.namespace,
          recordId: record.recordId,
          recipientKeyId: randomUUID(),
          recipientPublicKey: Buffer.alloc(32, 7).toString("base64"),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
        expect(
          (
            await f.registerRecipient({
              recipientKeyId: recipient.recipientKeyId,
              recipientPublicKey: recipient.recipientPublicKey,
            })
          ).status,
        ).toBe(200);
        await f.approve({
          scopes: ["mcp:read"],
          toolGroups: [...MCP_TOOL_GROUPS],
          acl: [{ kbId: kb.id, bits: ["read"] }],
          recipients: [recipient],
        });
        if (revoked)
          await prisma.$transaction(async (tx) => {
            await lockIdentityAuthority(tx);
            await tx.sealedRecord.update({
              where: {
                namespace_recordId: { namespace: record.namespace, recordId: record.recordId },
              },
              data: { revokedAt: new Date(), ciphertext: null },
            });
          });
        expect((await f.exchange()).status).toBe(revoked ? 400 : 200);
        const pat = await prisma.mcpPersonalToken.findFirst({ where: { userId: f.user.id } });
        if (revoked) expect(pat).toBeNull();
        else {
          const rows = await prisma.sealedConsumerGrant.findMany({
            where: { grantId: pat!.grantId },
            take: 2,
          });
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            consumerKind: "pat",
            consumerId: pat!.grantId,
            recipientKeyId: recipient.recipientKeyId,
            recipientPublicKey: recipient.recipientPublicKey,
          });
        }
      }
    });
  });
});
