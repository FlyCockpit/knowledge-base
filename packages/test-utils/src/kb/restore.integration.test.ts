import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { encryptDeployKey, generateDeployKey } from "@knowledge-base/api/lib/kb/deploy-key";
import { encryptKbSecret } from "@knowledge-base/api/lib/kb/envelope";
import { embeddingFingerprint } from "@knowledge-base/api/lib/kb/fingerprint";
import { scheduleIndexBuild } from "@knowledge-base/api/lib/kb/generations";
import { writeInitialMainCommit } from "@knowledge-base/api/lib/kb/git-write";
import { runIndexBuildDelivery } from "@knowledge-base/api/lib/kb/index-build";
import { startMaintenanceParticipant } from "@knowledge-base/api/lib/kb/maintenance";
import { canonicalManifestBytes } from "@knowledge-base/api/lib/kb/manifest";
import { reserveMirrorAttempt } from "@knowledge-base/api/lib/kb/mirror";
import { purgeRetiredGenerations } from "@knowledge-base/api/lib/kb/retention";
import {
  authenticatePersonalToken,
  digestPatSecret,
  generatePatSecret,
} from "@knowledge-base/api/lib/mcp-token-access";
import {
  createDeviceApprovalService,
  digestDeviceCode,
} from "@knowledge-base/auth/device-approval";
import { createMcpConsentService } from "@knowledge-base/auth/mcp-consent";
import { resolveMcpPlugins } from "@knowledge-base/auth/mcp-plugins";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { createSessionCacheVersion } from "@knowledge-base/auth/session-authority";
import { PrismaClient } from "@knowledge-base/db/client";
import { createPrismaPgAdapter } from "@knowledge-base/db/prisma-adapter";
import { assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { isSkeletonOnly, kbDataPaths } from "../../../../scripts/init-kb-volumes.mjs";
import { coordinateBackup, encryptBundle, readBundle } from "../../../../scripts/lib/kb-backup.mjs";
import { requireBuiltArtifact } from "./build-artifacts.mjs";
import { type KbPostgresCluster, openKbPostgresClusterFromEnv } from "./postgres";
import { createAssetS3Fixture } from "./s3-fixture";

const { readMigrationState } = (await import(
  new URL("../../../../scripts/db/lib/migration-state.mjs", import.meta.url).href
)) as {
  readMigrationState(input: {
    databaseUrl: string;
    migrationsDir: string;
    pg: { Client: typeof Client };
    connectTimeoutMs: number;
  }): Promise<{ state: string; checksumMismatch: string[] }>;
};
const migrationsDir = resolve(import.meta.dirname, "../../../../packages/db/prisma/migrations");
async function migrationReady(databaseUrl: string) {
  const state = await readMigrationState({
    databaseUrl,
    migrationsDir,
    pg: { Client },
    connectTimeoutMs: 5000,
  });
  return state.state === "up-to-date" && state.checksumMismatch.length === 0;
}

const root = resolve(import.meta.dirname, "../../../..");
vi.mock("@knowledge-base/queue", () => ({ redisConnection: {} }));
const authSecret = "disposable-restore-auth-secret-only";
const password = "disposable-restore-password-only";
const totp = "JBSWY3DPEHPK3PXP";
function authFor(db: PrismaClient) {
  return betterAuth({
    database: prismaAdapter(db, { provider: "postgresql" }),
    baseURL: "https://restore.invalid",
    secret: authSecret,
    session: { cookieCache: { enabled: true, maxAge: 60, version: createSessionCacheVersion(db) } },
    emailAndPassword: { enabled: true },
    plugins: [
      twoFactor(),
      ...resolveMcpPlugins({ baseUrl: "https://restore.invalid", secret: authSecret, db }),
    ],
  });
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
let cluster: KbPostgresCluster;
let tools: string;
let oldPath: string | undefined;
beforeAll(async () => {
  cluster = await openKbPostgresClusterFromEnv();
  tools = await mkdtemp(join(tmpdir(), "restore-pg-tools-"));
  oldPath = process.env.PATH;
  const cid = execFileSync(
    "docker",
    [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${process.env.KB_TEST_PROJECT}`,
      "--filter",
      "label=com.docker.compose.service=postgres",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!/^[a-f0-9]+$/.test(cid)) throw new Error("Disposable PostgreSQL unavailable");
  for (const tool of ["psql", "pg_dump", "pg_restore"])
    await writeFile(
      join(tools, tool),
      `#!/bin/sh\nexec docker exec -i -e PGDATABASE -e PGUSER -e PGPASSWORD -e PGSSLMODE -e PGOPTIONS -e PGPORT=5432 -e PGHOST=127.0.0.1 ${cid} ${tool} "$@"\n`,
      { mode: 0o700 },
    );
  process.env.PATH = `${tools}:${oldPath}`;
  requireBuiltArtifact(
    join(root, "apps/server/native/kb-supervisor"),
    "pnpm test:kb --build-only restore",
  );
});
const indexDir = mkdtempSync(join(tmpdir(), "kb-restore-index-"));
afterAll(async () => {
  process.env.PATH = oldPath;
  if (seed) await rm(seed.dir, { recursive: true, force: true });
  await cluster?.close();
  if (tools) await rm(tools, { recursive: true, force: true });
});
const master = Buffer.alloc(32, 73);
async function sql(url: string, text: string, values: unknown[] = []) {
  const client = new Client({ connectionString: url });
  client.on("error", () => {});
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}
async function emptyTarget(dir: string) {
  const database = `kb_test_restore${randomUUID().replaceAll("-", "")}`;
  const admin = `postgresql://postgres:${encodeURIComponent(cluster.superuserPassword)}@${cluster.host}:${cluster.port}/postgres`;
  await sql(admin, `CREATE DATABASE "${database}"`);
  const url = admin.replace(/\/postgres$/, `/${database}`);
  // Whole-volume contract (case i): a bare, existing, node-writable data root.
  const data = join(dir, "target-data");
  await mkdir(data);
  const { reposDir: repos, assetsDir: assets } = kbDataPaths(data);
  return { url, data, repos, assets };
}
let seed: Awaited<ReturnType<typeof seedFixture>> | undefined;
/** Unfinished INDEX_KB jobs of a KB, lowest generation epoch first (companion before semantic). */
async function indexJobsInEpochOrder(db: PrismaClient, kbId: string, states: Array<"PENDING">) {
  const generations = await db.indexGeneration.findMany({
    where: { kbId, job: { kind: "INDEX_KB", state: { in: states } } },
    orderBy: { epoch: "asc" },
    select: { job: { select: { id: true } } },
    take: 10,
  });
  return generations.map((g) => g.job);
}

async function seedFixture() {
  const source = await cluster.createDatabase();
  source.applyPrismaSchema();
  const dir = await mkdtemp(join(tmpdir(), "restore-fixture-"));
  const sourceData = join(dir, "source-data");
  const repos = join(sourceData, "repos"),
    assets = join(sourceData, "assets");
  await mkdir(join(repos, ".private"), { recursive: true });
  for (const name of ["server", "worker"])
    await writeFile(join(repos, `.private/${name}.fence`), "");
  await mkdir(join(assets, "objects"), { recursive: true });
  const db = source.createPrismaClient();
  const user = await db.user.create({
    data: {
      name: "Restored owner",
      email: `${randomUUID()}@example.invalid`,
      role: "admin",
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  await db.account.create({
    data: {
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await hashPassword(password),
    },
  });
  await db.twoFactor.create({
    data: {
      userId: user.id,
      secret: await symmetricEncrypt({ key: authSecret, data: totp }),
      backupCodes: await symmetricEncrypt({ key: authSecret, data: '["disposable-code"]' }),
    },
  });
  await db.localModel.create({ data: { id: "qwen3-embedding-0.6b-q8_0", state: "READY" } });
  await db.bootstrapState.create({
    data: { id: "singleton", userId: user.id, completedAt: new Date() },
  });
  const kbId = `k${randomUUID().replaceAll("-", "").slice(0, 23)}`;
  let head = await writeInitialMainCommit(
    {
      reposDir: repos,
      kbId,
      executor: {
        exec: ({ cwd, argv, env }) => {
          execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "pipe" });
        },
      },
    },
    { message: "restore fixture", description: "Restored Markdown history" },
  );
  await db.knowledgeBase.create({
    data: {
      id: kbId,
      ownerId: user.id,
      name: "Restore",
      slug: "restore",
      description: "Restored Markdown history",
      state: "ACTIVE",
      headSha: head,
    },
  });
  const blob = Buffer.from("historic CAS asset"),
    hex = createHash("sha256").update(blob).digest("hex");
  await mkdir(join(assets, "objects", hex.slice(0, 2)));
  await writeFile(join(assets, "objects", hex.slice(0, 2), hex.slice(2)), blob);
  await db.assetBlob.create({
    data: { hash: `sha256:${hex}`, size: blob.length, mime: "image/png" },
  });
  await db.kbAssetLineage.create({
    data: {
      kbId,
      hash: `sha256:${hex}`,
      actorKey: `user:${user.id}`,
      actorUserIdSnapshot: user.id,
      source: "UPLOAD",
    },
  });
  const repo = join(repos, `kb_${kbId}.git`);
  const gitEnv = {
    PATH: process.env.PATH,
    GIT_INDEX_FILE: join(dir, "fixture.index"),
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (argv: string[], input?: Buffer) =>
    execFileSync("git", ["--git-dir", repo, ...argv], {
      env: gitEnv,
      input,
      encoding: "utf8",
    }).trim();
  git(["read-tree", head]);
  const manifestSha = git(
    ["hash-object", "-w", "--stdin"],
    canonicalManifestBytes({
      version: 1,
      entries: [
        { path: "historic.png", hash: `sha256:${hex}`, size: blob.length, mime: "image/png" },
      ],
    }),
  );
  git(["update-index", "--add", "--cacheinfo", `100644,${manifestSha},.assets/manifest.json`]);
  head = git(["commit-tree", git(["write-tree"]), "-p", head, "-m", "retain historic asset"]);
  git(["update-ref", "refs/heads/main", head]);
  await db.knowledgeBase.update({ where: { id: kbId }, data: { headSha: head } });
  const grantId = randomUUID();
  await db.mcpGrant.create({
    data: {
      id: grantId,
      actorUserIdSnapshot: user.id,
      userId: user.id,
      kind: "PAT",
      clientId: "fixture",
      referenceId: randomUUID(),
      scopes: ["mcp:write"],
      toolGroups: ["read", "edit"],
      createdKbBits: [],
    },
  });
  const namespace = randomUUID(),
    recordId = randomUUID(),
    invitationId = randomUUID();
  const sealedCiphertext = JSON.stringify(
    encryptKbSecret(
      "disposable-sealed",
      {
        aadVersion: 1,
        purpose: "sealed-literal",
        userId: namespace,
        objectId: recordId,
        revision: "1",
      },
      master,
    ),
  );
  const invitationCiphertext = JSON.stringify(
    encryptKbSecret(
      "invitee@example.invalid",
      {
        aadVersion: 1,
        purpose: "share-email",
        userId: user.id,
        objectId: invitationId,
        revision: "1",
      },
      master,
    ),
  );
  await db.sealedRecord.create({
    data: {
      namespace,
      recordId,
      kbId,
      ownerId: user.id,
      ownerSnapshot: user.id,
      ciphertext: sealedCiphertext,
    },
  });
  await db.shareInvitation.create({
    data: {
      kbId,
      inviterUserId: user.id,
      canonicalEmail: "invitee@example.invalid",
      emailCiphertext: invitationCiphertext,
      requestId: invitationId,
      idempotencyKey: "restore-invitation",
      bits: ["read"],
    },
  });
  const pat = generatePatSecret();
  await db.mcpPersonalToken.create({
    data: {
      userIdSnapshot: user.id,
      userId: user.id,
      name: "old PAT",
      lookupPrefix: pat.lookupPrefix,
      secretDigest: digestPatSecret(pat.secret),
      grantId,
      scopes: ["mcp:write"],
      resource: "https://restore.invalid/mcp",
    },
  });
  const session = await db.session.create({
    data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600000) },
  });
  let oldCookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${createHmac("sha256", authSecret).update(session.token).digest("base64")}`)}`;
  expect(
    (await authFor(db).api.getSession({ headers: new Headers({ cookie: oldCookie }) }))?.user.id,
  ).toBe(user.id);
  const cached = await authFor(db).api.getSession({
    headers: new Headers({ cookie: oldCookie }),
    asResponse: true,
  });
  expect(cookie(cached)).toContain("session_data");
  oldCookie += `; ${cookie(cached)}`;
  expect(
    (await authFor(db).api.getSession({ headers: new Headers({ cookie: oldCookie }) }))?.user.id,
  ).toBe(user.id);
  expect(
    await authenticatePersonalToken(prismaAssetQuery(db), pat.secret, new Date()),
  ).not.toBeNull();
  const auth = authFor(db);
  const send = (path: string, init: RequestInit = {}) =>
    auth.handler(new Request(`https://restore.invalid/api/auth${path}`, init));
  const registration = await send("/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Restore",
      redirect_uris: ["https://client.invalid/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:read offline_access",
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = z
    .object({ client_id: z.string() })
    .parse(await registration.json());
  const pkce = "v".repeat(43),
    resource = "https://restore.invalid/mcp";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://client.invalid/cb",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(pkce).digest("base64url"),
    resource,
    scope: "mcp:read offline_access",
    state: randomUUID(),
  });
  const authorization = await send(`/oauth2/authorize?${params}`, {
    headers: { cookie: oldCookie },
  });
  expect(authorization.status).toBe(302);
  const oauthQuery = new URL(
    authorization.headers.get("location")!,
    "https://restore.invalid",
  ).search.slice(1);
  const actor = { userId: user.id, sessionId: session.id };
  const consent = createMcpConsentService({ db, secret: authSecret, resource });
  await consent.approve(actor, {
    ...(await consent.prepare(actor, oauthQuery)),
    oauthQuery,
    selection: {
      scopes: ["mcp:read", "offline_access"],
      toolGroups: MCP_TOOL_GROUPS.filter((group) => group !== "sealed"),
      acl: [],
    },
    explicitConsent: true,
  });
  const approval = await send("/oauth2/consent", {
    method: "POST",
    headers: {
      cookie: oldCookie,
      origin: "https://restore.invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify({ oauth_query: oauthQuery, accept: true }),
  });
  expect(approval.status).toBe(200);
  const code = new URL(
    z.object({ url: z.string() }).parse(await approval.json()).url,
  ).searchParams.get("code")!;
  const exchange = await send("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      resource,
      grant_type: "authorization_code",
      redirect_uri: "https://client.invalid/cb",
      code,
      code_verifier: pkce,
    }),
  });
  expect(exchange.status).toBe(200);
  const oauth = z
    .object({ access_token: z.string(), refresh_token: z.string() })
    .parse(await exchange.json());
  const jwks = z
    .object({ keys: z.array(z.record(z.string(), z.unknown())) })
    .parse(await (await send("/jwks")).json());
  expect((await jwtVerify(oauth.access_token, createLocalJWKSet(jwks))).payload.sub).toBe(user.id);
  const deviceCode = "disposable-ready-device";
  await db.deviceCode.create({
    data: {
      deviceCodeDigest: digestDeviceCode(deviceCode),
      userCode: "OLDABCDE",
      clientId: "kb-cli",
      scope: "mcp:read",
      status: "pending",
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const device = createDeviceApprovalService({ db, resource });
  const { nonce } = await device.claim(actor, "OLDABCDE");
  await device.select(actor, {
    userCode: "OLDABCDE",
    nonce,
    selection: { scopes: ["mcp:read"], toolGroups: [...MCP_TOOL_GROUPS], acl: [] },
  });
  await device.decide(actor, { userCode: "OLDABCDE", nonce }, "approve");
  await expect(
    device.exchange({ deviceCode, name: "Restore" }, async () => {
      throw Error("SOURCE_READY");
    }),
  ).rejects.toThrow("SOURCE_READY");
  const providerId = `p${randomUUID().replaceAll("-", "").slice(0, 23)}`,
    probe = randomUUID();
  await db.durableJob.create({
    data: { id: probe, dedupKey: probe, kind: "PROVIDER_PROBE", desired: {}, state: "COMPLETE" },
  });
  await db.embeddingProvider.create({
    data: { id: providerId, ownerId: user.id, name: "Restored provider" },
  });
  const ciphertext = JSON.stringify(
    encryptKbSecret(
      "disposable-provider",
      {
        aadVersion: 1,
        purpose: "provider-secret",
        userId: user.id,
        objectId: providerId,
        revision: "1",
      },
      master,
    ),
  );
  await db.providerRevision.create({
    data: {
      providerId,
      version: 1,
      endpointUrl: "https://provider.invalid/embeddings",
      model: "fixture",
      dimensions: 2,
      ciphertext,
      ownerSnapshot: user.id,
      fingerprint: embeddingFingerprint({
        endpointUrl: "https://provider.invalid/embeddings",
        model: "fixture",
        dimensions: 2,
      }),
      idempotencyKey: "restore-provider",
      requestHash: "hash",
      jobId: probe,
    },
  });
  await db.knowledgeBase.update({
    where: { id: kbId },
    data: { profileProviderId: providerId, profileVersion: 1 },
  });
  await db.kbRemote.create({ data: { kbId, state: "DISCONNECTED" } });
  const deploy = `d${randomUUID().replaceAll("-", "").slice(0, 23)}`;
  const generatedKey = generateDeployKey();
  await db.deployKeyVersion.create({
    data: {
      id: deploy,
      kbId,
      keyVersion: 1,
      remoteVersion: 1,
      url: "ssh://git@mirror.invalid/a/b.git",
      hostKeys: [generatedKey.publicKey],
      publicKey: generatedKey.publicKey,
      fingerprint: generatedKey.fingerprint,
      state: "ACTIVE",
      ciphertext: encryptDeployKey(
        generatedKey.seed,
        { kbId, remoteVersion: 1, keyVersion: 1 },
        master,
      ),
      createdBy: user.id,
    },
  });
  generatedKey.seed.destroy();
  await db.kbRemote.update({
    where: { kbId },
    data: { state: "ACTIVE", activeKeyId: deploy, remoteVersion: 1 },
  });
  const mirrorId = randomUUID();
  await db.mirrorAttempt.create({
    data: {
      id: mirrorId,
      kbId,
      keyId: deploy,
      remoteVersion: 1,
      actorKey: `user:${user.id}`,
      actorUserId: user.id,
      mainSha: head,
    },
  });
  expect(
    await db.$transaction((tx) =>
      reserveMirrorAttempt(prismaAssetQuery(tx), { attemptId: mirrorId }),
    ),
  ).toBe(true);
  await db.$transaction((tx) => scheduleIndexBuild(prismaAssetQuery(tx), kbId));
  // The lexical companion first, then the semantic build it gates.
  for (const oldBuild of await indexJobsInEpochOrder(db, kbId, ["PENDING"])) {
    await db.durableJob.update({ where: { id: oldBuild.id }, data: { state: "PUBLISHED" } });
    const delivered = await runIndexBuildDelivery(db, {
      connectionString: source.urls.applier,
      indexDir,
      reposDir: repos,
      masterKey: master.toString("base64"),
      workerId: randomUUID(),
      durableJobId: oldBuild.id,
      embedder: { embed: async (texts) => texts.map(() => [0.6, 0.8]) },
    });
    // A skipped delivery built nothing: fail here, not on a later assertion.
    expect(delivered).not.toEqual({ skipped: true });
  }
  const oldGeneration = (await db.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } }))
    .activeGenerationId;
  expect(oldGeneration).not.toBeNull();
  const deadline = new Date(Date.now() + 3600000);
  for (const state of ["WRITING", "READY"] as const) {
    await db.stagedUpload.create({
      data: {
        kbId,
        actorKey: `user:${user.id}`,
        actorUserIdSnapshot: user.id,
        kind: "ASSET",
        declaredSize: 1,
        declaredHash: `sha256:${hex}`,
        declaredMime: "image/png",
        reservationIds: [],
        expiresAt: deadline,
        state,
      },
    });
    await db.exportArtifact.create({
      data: {
        id: randomUUID(),
        kbId,
        actorKey: `user:${user.id}`,
        actorUserIdSnapshot: user.id,
        kind: "ZIP",
        idempotencyKey: state,
        requestHash: state,
        rev: head,
        reservationIds: [],
        expiresAt: deadline,
        deadlineAt: deadline,
        state,
      },
    });
  }
  const queryId = randomUUID();
  await db.durableJob.create({
    data: {
      id: queryId,
      dedupKey: queryId,
      kind: "QUERY_EMBEDDING",
      desired: {},
      state: "RUNNING",
      dispatchOwner: "old-dispatcher",
      dispatchClaimUntil: deadline,
      workerOwner: "old-worker",
      leaseUntil: deadline,
    },
  });
  await db.queryEmbeddingRequest.create({
    data: {
      id: queryId,
      kbId,
      generationId: oldGeneration!,
      actorKey: `user:${user.id}`,
      userId: user.id,
      principal: {},
      snapshot: {},
      state: "RUNNING",
      queryCiphertext: "disposable-query",
      resultCiphertext: "disposable-result",
      deadline,
      scrubAt: deadline,
    },
  });
  await db.generationLease.create({
    data: { requestId: queryId, generationId: oldGeneration!, expiresAt: deadline },
  });
  await db.modelVolumeLease.create({
    data: { id: "restore-volume", owner: "old-worker", leaseUntil: deadline },
  });
  await db.qwenReembedLease.upsert({
    where: { id: "qwen-reembed" },
    create: { id: "qwen-reembed", kbId, generationId: oldGeneration },
    update: { kbId, generationId: oldGeneration },
  });
  const quota = await db.quotaAccount.create({
    data: { dimension: "DISK_VOLUME", subjectId: "restore-test", committed: 3n, reserved: 7n },
  });
  const reservation = await db.quotaReservation.create({
    data: {
      accountId: quota.id,
      amount: 7n,
      opId: queryId,
      expiresAt: deadline,
      heldForPublication: true,
    },
  });
  // A FAILED build in the bundle (restored as FAILED, purgeable later), and a BUILDING build whose
  // generation still references the RESERVED reservation: restore must clear the ids before it
  // cancels the job (guard I2 would refuse the cancel otherwise).
  const failedBuild = await db.$transaction((tx) => scheduleIndexBuild(prismaAssetQuery(tx), kbId));
  await db.durableJob.update({ where: { id: failedBuild!.jobId }, data: { state: "FAILED" } });
  await db.indexGeneration.update({
    where: { id: failedBuild!.generationId },
    data: { state: "FAILED", errorCode: "INDEX_BUILD_FAILED" },
  });
  const building = await db.$transaction((tx) => scheduleIndexBuild(prismaAssetQuery(tx), kbId));
  await db.durableJob.update({
    where: { id: building!.jobId },
    data: { state: "RUNNING", workerOwner: "old-worker", leaseUntil: deadline, attemptEpoch: 1 },
  });
  await db.indexGeneration.update({
    where: { id: building!.generationId },
    data: { state: "BUILDING", quotaReservationIds: [reservation.id] },
  });
  const identity = join(dir, "identity");
  execFileSync("age-keygen", ["-pq", "-o", identity], { stdio: "pipe" });
  const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
  const file = await coordinateBackup({
    connectionString: source.urls.applier,
    dataDir: sourceData,
    backupDir: dir,
    recipient,
    supervisor: join(root, "apps/server/native/kb-supervisor"),
  });
  const sourceDesiredEpoch = (
    await db.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } })
  ).desiredEpoch.toString();
  await db.$disconnect();
  return {
    dir,
    source,
    file,
    identity,
    recipient,
    user,
    kbId,
    head,
    hex,
    blob,
    grantId,
    session,
    oldGeneration,
    queryId,
    quotaId: quota.id,
    reservationId: reservation.id,
    failedGeneration: failedBuild!.generationId,
    buildingGeneration: building!.generationId,
    buildingJob: building!.jobId,
    sourceDesiredEpoch,
    oauth,
    clientId,
    deviceCode,
    pat,
    oldCookie,
    mirrorId,
    ciphertext,
    sealedCiphertext,
    invitationCiphertext,
    attemptId: randomUUID(),
  };
}
async function fixture() {
  seed ??= await seedFixture();
  const dir = await mkdtemp(join(tmpdir(), "restore-target-"));
  return { ...seed, dir, target: await emptyTarget(dir), attemptId: randomUUID() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function restore(
  f: Fixture,
  boundary?: string,
  kill?: "SIGKILL" | "SIGTERM",
  key = master.toString("base64"),
  restoredAuthSecret = authSecret,
  assetEnvironment: Record<string, string> = {},
  assetSourceRemap = false,
  cancelCacheScan = false,
) {
  const script = join(f.dir, "restore.mjs");
  await writeFile(
    script,
    `import {restoreOffline} from '${root}/scripts/lib/kb-restore.mjs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const abort=new AbortController();process.on('SIGTERM',()=>abort.abort());
const opendir=fs.opendirSync;
let scanCancelled=false;
fs.opendirSync=(...args)=>{
 const dir=opendir(...args),read=dir.readSync.bind(dir);
 dir.readSync=()=>{
  const entry=read();
  if(${cancelCacheScan}&&!scanCancelled&&entry&&/^[a-f0-9]{62}$/.test(entry.name)){
   scanCancelled=true;process.emit('SIGTERM');console.error('CACHE_SCAN_CANCELLED');
  }
  return entry;
 };
 return dir;
};
syncBuiltinESMExports();
try{await restoreOffline({file:process.env.BUNDLE,identity:process.env.IDENTITY,attemptId:process.env.ATTEMPT,connectionString:process.env.DATABASE_URL,dataDir:process.env.KB_DATA_ROOT,masterKey:process.env.KB_MASTER_KEY,authSecret:process.env.BETTER_AUTH_SECRET,assetSourceRemap:process.env.ASSET_REMAP==='true',signal:abort.signal,barrier:async phase=>{if(phase===process.env.BOUNDARY){console.log('BARRIER '+process.pid);await new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}}});}catch(error){console.error(error.code ?? 'RESTORE_FAILED');process.exitCode=1;}`,
  );
  const child = spawn(
    join(root, "apps/server/native/kb-supervisor"),
    ["--restore", "--", process.execPath, script],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        DATABASE_URL: f.target.url,
        KB_DATA_ROOT: f.target.data,
        BUNDLE: f.file,
        IDENTITY: f.identity,
        ATTEMPT: f.attemptId,
        KB_MASTER_KEY: key,
        BETTER_AUTH_SECRET: restoredAuthSecret,
        BOUNDARY: boundary ?? "",
        ...assetEnvironment,
        ASSET_REMAP: String(assetSourceRemap),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let error = "";
  child.stderr.on("data", (b) => {
    error += b;
  });
  const done = new Promise<number>((r, j) => {
    child.once("error", j);
    child.once("close", (c) => r(c ?? 1));
  });
  if (boundary) {
    try {
      const pid = await new Promise<number>((r, j) => {
        const timer = setTimeout(() => j(Error(`Missing ${boundary}: ${error}`)), 45000);
        child.stdout.on("data", (b) => {
          const m = b.toString().match(/BARRIER (\d+)/);
          if (m) {
            clearTimeout(timer);
            r(Number(m[1]));
          }
        });
        void done.then(() => {
          clearTimeout(timer);
          j(Error(`Exited before ${boundary}: ${error}`));
        });
      });
      await expect(startMaintenanceParticipant(f.target.url, () => {})).rejects.toThrow();
      expect(await migrationReady(f.target.url)).toBe(false);
      process.kill(pid, kill ?? "SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  }
  return { code: await done, error };
}
async function cleanup(f: Fixture) {
  await rm(f.dir, { recursive: true, force: true });
}

it("backup65 round trip preserves history/assets/roles/bootstrap, resets every authority surface and queues a fresh index", async () => {
  const f = await fixture();
  try {
    const restored = await restore(f);
    expect(restored.code, restored.error).toBe(0);
    // The bare root received the whole data-volume skeleton.
    for (const sub of [
      "repos/.private/tmp",
      "assets/.private/staging",
      "models/.private/tmp",
      "index",
    ])
      expect((await stat(join(f.target.data, sub))).isDirectory(), sub).toBe(true);
    const query = (text: string, values: unknown[] = []) => sql(f.target.url, text, values);
    expect(
      execFileSync(
        "git",
        ["--git-dir", join(f.target.repos, `kb_${f.kbId}.git`), "show", `${f.head}:index.md`],
        { encoding: "utf8" },
      ),
    ).toContain("Restored Markdown history");
    expect(
      await readFile(join(f.target.assets, "objects", f.hex.slice(0, 2), f.hex.slice(2))),
    ).toEqual(f.blob);
    for (const table of ["session", "device_code", "verification", "jwks", "oauth_consent"])
      expect((await query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(0);
    for (const [table, column] of [
      ["mcp_grant", "revokedAt"],
      ["mcp_personal_token", "revokedAt"],
      ["oauth_refresh_token", "revoked"],
      ["oauth_access_token", "revoked"],
    ])
      expect(
        (await query(`SELECT count(*)::int AS n FROM ${table} WHERE "${column}" IS NULL`)).rows[0]
          ?.n,
      ).toBe(0);
    expect(
      (await query('SELECT id FROM mcp_grant WHERE id=$1 AND "revokedAt" IS NOT NULL', [f.grantId]))
        .rows,
    ).toHaveLength(1);
    expect((await query('SELECT role FROM "user" WHERE id=$1', [f.user.id])).rows[0]?.role).toBe(
      "admin",
    );
    expect(
      (await query('SELECT "completedAt" FROM bootstrap_state')).rows[0]?.completedAt,
    ).not.toBeNull();
    expect((await query('SELECT state,"activeKeyId" FROM kb_remote')).rows[0]).toEqual({
      state: "DISCONNECTED",
      activeKeyId: null,
    });
    expect((await query("SELECT ciphertext,state FROM kb_deploy_key_version")).rows[0]).toEqual({
      ciphertext: null,
      state: "DESTROYED",
    });
    expect((await query("SELECT state FROM kb_mirror_attempt")).rows[0]?.state).toBe("CANCELLED");
    for (const table of ["staged_upload", "export_artifact"])
      expect((await query(`SELECT state FROM ${table}`)).rows.map((row) => row.state)).toEqual([
        "ABORTED",
        "ABORTED",
      ]);
    expect(
      (
        await query(
          'SELECT state,"queryCiphertext","resultCiphertext" FROM query_embedding_request',
        )
      ).rows[0],
    ).toEqual({ state: "CANCELLED", queryCiphertext: null, resultCiphertext: null });
    expect(
      (
        await query(
          'SELECT state,"attemptEpoch","dispatchOwner","workerOwner","leaseUntil" FROM durable_job WHERE id=$1',
          [f.queryId],
        )
      ).rows[0],
    ).toEqual({
      state: "CANCELLED",
      attemptEpoch: 2,
      dispatchOwner: null,
      workerOwner: null,
      leaseUntil: null,
    });
    for (const table of ["generation_lease", "kb_model_volume_lease"])
      expect((await query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(0);
    expect(
      (
        await query(
          'SELECT "kbId","generationId" FROM kb_qwen_reembed_lease WHERE id=\'qwen-reembed\'',
        )
      ).rows[0],
    ).toEqual({ kbId: null, generationId: null });
    expect(
      (
        await query("SELECT committed::text,reserved::text FROM quota_account WHERE id=$1", [
          f.quotaId,
        ])
      ).rows[0],
    ).toEqual({ committed: "3", reserved: "0" });
    expect(
      (
        await query(
          'SELECT outcome,"heldForPublication","releasedAt" FROM quota_reservation WHERE "accountId"=$1',
          [f.quotaId],
        )
      ).rows[0],
    ).toMatchObject({
      outcome: "RELEASED",
      heldForPublication: false,
      releasedAt: expect.any(Date),
    });
    expect(
      (await query("SELECT count(*)::int AS n FROM durable_job WHERE state='COMPLETE'")).rows[0]?.n,
    ).toBeGreaterThanOrEqual(2);
    expect((await query("SELECT ciphertext FROM provider_revision")).rows[0]?.ciphertext).toBe(
      f.ciphertext,
    );
    expect(
      (await query('SELECT "activeGenerationId" FROM knowledge_base')).rows[0]?.activeGenerationId,
    ).toBeNull();
    expect(
      (await query("SELECT state FROM index_generation WHERE id=$1", [f.oldGeneration])).rows[0]
        ?.state,
    ).toBe("SUPERSEDED");
    // The BUILDING generation's reservation ids were cleared before its job was cancelled; the
    // FAILED generation stays FAILED (FAILED -> SUPERSEDED is not a valid transition).
    expect(
      (
        await query('SELECT state,"quotaReservationIds" FROM index_generation WHERE id=$1', [
          f.buildingGeneration,
        ])
      ).rows[0],
    ).toEqual({ state: "SUPERSEDED", quotaReservationIds: [] });
    expect(
      (await query("SELECT state FROM durable_job WHERE id=$1", [f.buildingJob])).rows[0]?.state,
    ).toBe("CANCELLED");
    expect(
      (
        await query('SELECT state,"quotaReservationIds" FROM index_generation WHERE id=$1', [
          f.failedGeneration,
        ])
      ).rows[0],
    ).toEqual({ state: "FAILED", quotaReservationIds: [] });
    expect(
      (await query("SELECT outcome FROM quota_reservation WHERE id=$1", [f.reservationId])).rows[0]
        ?.outcome,
    ).toBe("RELEASED");
    // ... and is purgeable afterwards.
    expect(
      (
        await purgeRetiredGenerations({
          connectionString: f.target.url,
          indexDir: join(f.target.data, "index"),
          now: new Date(Date.now() + 2 * 86_400_000),
        })
      ).purged,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await query("SELECT state FROM index_generation WHERE id=$1", [f.failedGeneration])).rows[0]
        ?.state,
    ).toBe("PURGED");
    expect((await query("SELECT ciphertext FROM sealed_record")).rows[0]?.ciphertext).toBe(
      f.sealedCiphertext,
    );
    expect(
      (await query('SELECT "emailCiphertext" FROM share_invitation')).rows[0]?.emailCiphertext,
    ).toBe(f.invitationCiphertext);
    const build = (
      await query("SELECT desired,state FROM durable_job WHERE kind='INDEX_KB' AND state='PENDING'")
    ).rows;
    expect(build).toHaveLength(1);
    expect(build[0]?.state).toBe("PENDING");
    expect(build[0]?.desired).toMatchObject({ kbId: f.kbId, commitSha: f.head, dimensions: 2 });
    expect((await query("SELECT state FROM kb_local_model")).rows[0]?.state).toBe("DOWNLOADING");
    expect(
      (await query("SELECT state FROM durable_job WHERE kind='DOWNLOAD_MODEL'")).rows[0]?.state,
    ).toBe("PENDING");
    const db = new PrismaClient({
      adapter: createPrismaPgAdapter({ connectionString: f.target.url, max: 3 }),
    });
    try {
      const auth = authFor(db);
      expect(
        await auth.api.getSession({ headers: new Headers({ cookie: f.oldCookie }) }),
      ).toBeNull();
      expect(
        await authenticatePersonalToken(prismaAssetQuery(db), f.pat.secret, new Date()),
      ).toBeNull();
      expect(await reserveMirrorAttempt(prismaAssetQuery(db), { attemptId: f.mirrorId })).toBe(
        false,
      );
      const refresh = await auth.handler(
        new Request("https://restore.invalid/api/auth/oauth2/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: f.clientId,
            resource: "https://restore.invalid/mcp",
            grant_type: "refresh_token",
            refresh_token: f.oauth.refresh_token,
          }),
        }),
      );
      expect(refresh.status).toBe(400);
      expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
      const jwks = z
        .object({ keys: z.array(z.record(z.string(), z.unknown())) })
        .parse(
          await (await auth.handler(new Request("https://restore.invalid/api/auth/jwks"))).json(),
        );
      await expect(jwtVerify(f.oauth.access_token, createLocalJWKSet(jwks))).rejects.toThrow();
      const mint = vi.fn(async () => {
        throw Error("Unexpected restored device mint");
      });
      await expect(
        createDeviceApprovalService({ db, resource: "https://restore.invalid/mcp" }).exchange(
          { deviceCode: f.deviceCode, name: "Restore" },
          mint,
        ),
      ).rejects.toThrow("invalid_grant");
      expect(mint).not.toHaveBeenCalled();
      const signIn = await auth.api.signInEmail({
        body: { email: f.user.email, password },
        asResponse: true,
      });
      expect(signIn.status).toBe(200);
      expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
      const { code } = await auth.api.generateTOTP({ body: { secret: totp } });
      const challenge = await auth.api.verifyTOTP({
        headers: new Headers({ cookie: cookie(signIn) }),
        body: { code },
        asResponse: true,
      });
      expect(challenge.status).toBe(200);
      expect(
        (await auth.api.getSession({ headers: new Headers({ cookie: cookie(challenge) }) }))?.user
          .id,
      ).toBe(f.user.id);
      const startup = join(f.dir, "startup.mjs");
      await writeFile(
        startup,
        `import {PrismaClient} from '${root}/packages/db/prisma/generated/client.ts';
import {createPrismaPgAdapter} from '${root}/packages/db/src/prisma-adapter.ts';
import {assertProcessFence} from '${root}/apps/server/src/kb-process.ts';
import {runStartupJournalRecovery} from '${root}/packages/api/src/lib/kb/recovery.ts';
import {startMaintenanceParticipant} from '${root}/packages/api/src/lib/kb/maintenance.ts';
import {authorizedAssetsAtRevision,prismaAssetQuery} from '${root}/packages/api/src/lib/kb/asset-authz.ts';
import {sqlAuthorityStore} from '${root}/packages/api/src/lib/kb/permissions.ts';
const db=new PrismaClient({adapter:createPrismaPgAdapter({connectionString:process.env.DATABASE_URL,max:2})});let permit;
try{permit=await startMaintenanceParticipant(process.env.DATABASE_URL,()=>{});await runStartupJournalRecovery(db,process.env.KB_DATA_ROOT+'/repos',process.env.KB_DATA_ROOT+'/assets',process.env.DATABASE_URL,assertProcessFence);const query=prismaAssetQuery(db);const assets=await authorizedAssetsAtRevision({query,store:sqlAuthorityStore(query),principal:{kind:'browser',userId:'${f.user.id}'},kbId:'${f.kbId}',operation:'read',reposDir:process.env.KB_DATA_ROOT+'/repos',rev:'${f.head}'});console.log(JSON.stringify(assets.map(a=>a.hash)));}finally{await permit?.release();await db.$disconnect();}`,
      );
      const hashes = execFileSync(
        join(root, "apps/server/native/kb-supervisor"),
        ["--", process.execPath, "--import", "tsx", startup],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            DATABASE_URL: f.target.url,
            KB_DATA_ROOT: f.target.data,
          },
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(JSON.parse(hashes)).toEqual([`sha256:${f.hex}`]);
      // The lexical companion first, then the semantic build it gates.
      for (const job of await indexJobsInEpochOrder(db, f.kbId, ["PENDING"])) {
        await db.durableJob.update({ where: { id: job.id }, data: { state: "PUBLISHED" } });
        const delivered = await runIndexBuildDelivery(db, {
          connectionString: f.target.url,
          // The restored data volume's index directory (the restore skeleton created it).
          indexDir: join(f.target.data, "index"),
          reposDir: f.target.repos,
          masterKey: master.toString("base64"),
          workerId: randomUUID(),
          durableJobId: job.id,
          embedder: { embed: async (texts) => texts.map(() => [0.6, 0.8]) },
        });
        // A skipped delivery built nothing: fail here, not on a later assertion.
        expect(delivered).not.toEqual({ skipped: true });
      }
      expect(
        (await db.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).activeGenerationId,
      ).not.toBeNull();
    } finally {
      await db.$disconnect();
    }
    const permit = await startMaintenanceParticipant(f.target.url, () => {});
    await permit.release();
    expect(
      (await query("SELECT value FROM app_setting WHERE key='kb.instance.identity'")).rows[0]
        ?.value,
    ).toContain('"authorityEpoch":"2"');
    const repeated = await restore(f);
    expect(repeated.code, repeated.error).toBe(0);
    expect(
      (await query("SELECT count(*)::int AS n FROM audit_event WHERE action='RESTORE_RESULT'"))
        .rows[0]?.n,
    ).toBe(1);
    await rm(join(f.target.assets, "objects", f.hex.slice(0, 2), f.hex.slice(2)));
    expect((await restore(f)).code).not.toBe(0);
    await expect(startMaintenanceParticipant(f.target.url, () => {})).rejects.toThrow();
    expect((await restore(f)).code).toBe(0);
    expect(
      (await query("SELECT epoch FROM knowledge_base_control.kb_restore")).rows[0]?.epoch,
    ).toBe("2");
  } finally {
    await cleanup(f);
  }
}, 180000);

it.each(["imported", "reset", "promoting", "promoted"])(
  "crash at %s keeps admission closed and resumes to one reset epoch and restore hold",
  async (boundary) => {
    const f = await fixture();
    try {
      expect((await restore(f, boundary, "SIGKILL")).code).not.toBe(0);
      // Matching migration history cannot admit an incomplete durable restore,
      // even when its transient maintenance request has disappeared.
      await sql(f.target.url, "DELETE FROM app_setting WHERE key='kb.maintenance.request'");
      expect(await migrationReady(f.target.url)).toBe(false);
      if (boundary === "imported") {
        expect(() =>
          execFileSync(process.execPath, [join(root, "scripts/db/migrate-runtime.mjs")], {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              DATABASE_URL: f.target.url,
              BACKUP_ENABLED: "false",
            },
            stdio: "pipe",
            timeout: 30000,
          }),
        ).toThrow();
      }
      await expect(startMaintenanceParticipant(f.target.url, () => {})).rejects.toThrow();
      if (boundary === "reset") {
        expect((await restore(f, "promoting", "SIGTERM")).code).not.toBe(0);
        await expect(startMaintenanceParticipant(f.target.url, () => {})).rejects.toThrow();
      }
      if (boundary === "promoting") {
        const folder = join(f.target.assets, "objects", f.hex.slice(0, 2));
        await mkdir(folder, { recursive: true });
        const target = join(folder, f.hex.slice(2));
        await writeFile(`${target}.restore-part`, f.blob);
        await link(`${target}.restore-part`, target);
      }
      expect((await restore(f)).code).toBe(0);
      await expect(
        readFile(
          join(f.target.assets, "objects", f.hex.slice(0, 2), `${f.hex.slice(2)}.restore-part`),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (
          await sql(
            f.target.url,
            'SELECT "desiredEpoch"::text AS epoch FROM knowledge_base WHERE id=$1',
            [f.kbId],
          )
        ).rows[0]?.epoch,
      ).toBe(String(BigInt(f.sourceDesiredEpoch) + 1n));
      expect(
        (await sql(f.target.url, 'SELECT "remoteVersion" FROM kb_remote WHERE "kbId"=$1', [f.kbId]))
          .rows[0]?.remoteVersion,
      ).toBe(2);
      expect(
        (await sql(f.target.url, "SELECT value FROM app_setting WHERE key='kb.instance.identity'"))
          .rows[0]?.value,
      ).toContain('"authorityEpoch":"2"');
      expect(
        (
          await sql(
            f.target.url,
            "SELECT count(*)::int AS n FROM public._knowledge_base_hold WHERE reason='restore'",
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await sql(
            f.target.url,
            "SELECT count(*)::int AS n FROM audit_event WHERE action='RESTORE_RESULT'",
          )
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      await cleanup(f);
    }
  },
  180000,
);

it.each(["key", "missing-key", "auth-key", "partial", "ref", "schema", "symlink", "metadata"])(
  "%s invalid restore stays diagnosable and cannot promote",
  async (kind) => {
    const f = await fixture();
    try {
      if (kind === "symlink") {
        await rm(f.target.assets, { recursive: true, force: true });
        await symlink(join(dirname(f.file), "source-data", "assets"), f.target.assets);
      } else if (!["key", "missing-key", "auth-key"].includes(kind)) {
        const bundle = await readBundle(f.file, f.identity);
        const sources = [];
        for (const entry of bundle.files) {
          if (kind === "partial" && entry.path.startsWith("assets/")) continue;
          const source = join(f.dir, "modified", entry.path);
          await mkdir(dirname(source), { recursive: true });
          await writeFile(source, entry.bytes);
          if (kind === "ref" && entry.path.endsWith("refs/heads/main"))
            await writeFile(source, "f".repeat(40) + "\n");
          if (kind === "schema" && entry.path.endsWith("migration.sql"))
            await writeFile(source, entry.bytes.toString() + "\n-- altered migration\n");
          sources.push({ path: entry.path, source });
        }
        f.file = join(f.dir, "modified.age");
        await encryptBundle({
          file: f.file,
          metadata:
            kind === "metadata" ? { ...bundle.metadata, authorityEpoch: "99" } : bundle.metadata,
          sources,
          recipient: f.recipient,
        });
      }
      expect(
        (
          await restore(
            f,
            undefined,
            undefined,
            kind === "missing-key"
              ? ""
              : kind === "key"
                ? Buffer.alloc(32, 1).toString("base64")
                : master.toString("base64"),
            kind === "auth-key" ? "wrong-auth-key" : authSecret,
          )
        ).code,
      ).not.toBe(0);
      expect((await readdir(f.target.repos)).filter((n) => n.endsWith(".git"))).toEqual([]);
      await expect(startMaintenanceParticipant(f.target.url, () => {})).rejects.toThrow();
    } finally {
      await cleanup(f);
    }
  },
  180000,
);

it("exclusive DB maintenance and empty-target checks leave previous bytes intact", async () => {
  const f = await fixture();
  const owner = new Client({ connectionString: f.target.url });
  try {
    await owner.connect();
    await owner.query("SELECT pg_advisory_lock($1::bigint)", [0x4b424d41]);
    expect((await restore(f)).error).toContain("RESTORE_MAINTENANCE_BUSY");
    await owner.end();
    // The refused attempt still left a skeleton-only root (case ii below).
    expect(isSkeletonOnly(f.target.data)).toBe(true);
    // Case iii: one stray file anywhere in the data root refuses the target.
    for (const stray of [join(f.target.assets, "sentinel"), join(f.target.data, "stray")]) {
      await writeFile(stray, "previous bytes");
      expect((await restore(f)).error).toContain("RESTORE_EMPTY_TARGET_REQUIRED");
      expect(await readFile(stray, "utf8")).toBe("previous bytes");
      await rm(stray);
    }
    // Case ii: a skeleton-only root restores.
    const restored = await restore(f);
    expect(restored.code, restored.error).toBe(0);
  } finally {
    await owner.end().catch(() => {});
    await cleanup(f);
  }
}, 180000);

it("unfinished journal and missing historic lineage cannot be adopted at restart", async () => {
  const f = await fixture();
  try {
    expect((await restore(f, "imported", "SIGKILL")).code).not.toBe(0);
    const opId = randomUUID();
    await sql(
      f.target.url,
      `INSERT INTO operation_intent("opId","updatedAt","kbId","actorKey","actorUserIdSnapshot",operation,"idempotencyKey","requestHash","publishNonce") VALUES($1::uuid,now(),$2,$3,$4,'write',($1::uuid)::text,'fixture',($1::uuid)::text)`,
      [opId, f.kbId, `user:${f.user.id}`, f.user.id],
    );
    expect((await restore(f)).error).toContain("RESTORE_JOURNAL_RECOVERY_REQUIRED");
    await sql(f.target.url, `UPDATE operation_intent SET phase='ABORTED' WHERE "opId"=$1`, [opId]);
    await sql(f.target.url, `DELETE FROM kb_asset_lineage WHERE "kbId"=$1 AND hash=$2`, [
      f.kbId,
      `sha256:${f.hex}`,
    ]);
    expect((await restore(f)).error).toContain("RESTORE_LINEAGE_INVALID");
    await expect(startMaintenanceParticipant(f.target.url, () => {})).rejects.toThrow();
    expect((await readdir(f.target.repos)).filter((name) => name.endsWith(".git"))).toEqual([]);
  } finally {
    await cleanup(f);
  }
}, 180000);

it("S3 reference backup ignores cache; replica restore binds generation, preserves source orphans as history and rechecks READY", {
  timeout: 180000,
}, async () => {
  const f = await fixture();
  const sourceS3 = await createAssetS3Fixture(),
    replica = await createAssetS3Fixture();
  let sourceClosed = false;
  const sourceGeneration = randomUUID();
  const config = (endpoint: string) => ({
    bucket: "assets",
    endpoint,
    region: "us-east-1",
    prefix: "retained",
    forcePathStyle: true,
  });
  const env = (endpoint: string) => ({
    KB_ASSET_S3_ENABLED: "true",
    KB_ASSET_S3_BUCKET: "assets",
    KB_ASSET_S3_ENDPOINT: endpoint,
    KB_ASSET_S3_REGION: "us-east-1",
    KB_ASSET_S3_PREFIX: "retained",
    KB_ASSET_S3_FORCE_PATH_STYLE: "true",
    KB_ASSET_S3_ACCESS_KEY_ID: "runtime-comparison-fixture",
    KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "operator-reader-fixture",
    KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "operator-secret-fixture",
  });
  const sourceLocator = assetS3Locator(config(sourceS3.endpoint)),
    targetLocator = assetS3Locator(config(replica.endpoint));
  const sourceData = join(seed!.dir, "source-data");
  const key = `/assets/retained/objects/${f.hex.slice(0, 2)}/${f.hex.slice(2)}`;
  const object = { bytes: f.blob, metadata: { sha256: f.hex, size: String(f.blob.length) } };
  sourceS3.objects.set(key, object);
  replica.objects.set(key, object);
  const orphan = `sha256:${"c".repeat(64)}`,
    pending = `sha256:${"d".repeat(64)}`;
  try {
    await f.source.query(
      "applier",
      `INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES('kb.asset-storage',$1,now(),now()) ON CONFLICT(key) DO UPDATE SET value=$1`,
      [
        JSON.stringify({
          version: 1,
          mode: "s3",
          activeGeneration: sourceGeneration,
          locator: sourceLocator,
        }),
      ],
    );
    for (const [hash, state] of [
      [`sha256:${f.hex}`, "DURABLE"],
      [orphan, "DURABLE"],
      [pending, "PENDING"],
    ])
      await f.source.query(
        "applier",
        `INSERT INTO asset_retained_object("storageGeneration",locator,hash,size,state) VALUES($1,$2,$3,$4,$5::"AssetRetainedStatus")`,
        [sourceGeneration, sourceLocator, hash, f.blob.length, state],
      );
    // Imported cache bookkeeping cannot reserve the new, empty volume.
    await f.source.query(
      "applier",
      `INSERT INTO asset_cache_state(id,"storageGeneration",configuration,"effectiveLimit","chargedBytes") VALUES('source-cache',$1,'source-config',26214400,5)`,
      [sourceGeneration],
    );
    const owner = randomUUID(),
      incarnation = randomUUID();
    await f.source.query(
      "applier",
      `INSERT INTO asset_cache_owner(epoch,"cacheId",role) VALUES($1,'source-cache','SERVER')`,
      [owner],
    );
    await f.source.query(
      "applier",
      `INSERT INTO asset_cache_entry("cacheId",hash,incarnation,size,state,"fillOwner","tempName","quotaReservations") VALUES('source-cache',$1,$2,5,'FILLING',$3,$4,'{}')`,
      [`sha256:${f.hex}`, incarnation, owner, `cache-${incarnation}`],
    );
    await f.source.query(
      "applier",
      `INSERT INTO asset_cache_pin(id,incarnation,"ownerEpoch") VALUES($1,$2,$3)`,
      [randomUUID(), incarnation, owner],
    );
    const input = {
      connectionString: f.source.urls.applier,
      dataDir: sourceData,
      backupDir: f.dir,
      recipient: f.recipient,
      supervisor: join(root, "apps/server/native/kb-supervisor"),
      assetEnvironment: env(sourceS3.endpoint),
    };
    sourceS3.objects.delete(key);
    await expect(coordinateBackup(input)).rejects.toThrow();
    expect((await readdir(f.dir)).filter((n) => n.endsWith(".complete"))).toEqual([]);
    sourceS3.objects.set(key, {
      ...object,
      metadata: { sha256: "0".repeat(64), size: String(f.blob.length) },
    });
    await expect(coordinateBackup(input)).rejects.toThrow();
    sourceS3.objects.set(key, object);
    const file = await coordinateBackup(input);
    const { readBundle } = await import("../../../../scripts/lib/kb-backup.mjs");
    const bundle = await readBundle(file, f.identity);
    expect(bundle.metadata.version).toBe(3);
    expect(bundle.files.some((e) => e.path.startsWith("assets/"))).toBe(false);
    expect(bundle.files.find((e) => e.path === "asset-inventory.jsonl")?.bytes.toString()).toBe(
      JSON.stringify({ hash: `sha256:${f.hex}`, size: f.blob.length }) + "\n",
    );
    expect(sourceS3.requests.every((r) => r.method === "HEAD")).toBe(true);
    const target = { ...f, file };
    await sourceS3.close();
    sourceClosed = true;
    const run = (
      boundary?: string,
      remap = true,
      environment = env(replica.endpoint),
      cancelCacheScan = false,
    ) =>
      restore(
        target,
        boundary,
        boundary ? "SIGKILL" : undefined,
        master.toString("base64"),
        authSecret,
        environment,
        remap,
        cancelCacheScan,
      );
    expect((await run(undefined, false)).error).toContain("RESTORE_ASSET_REMAP_REQUIRED");
    expect((await run("imported")).code).not.toBe(0);
    expect((await run(undefined, true, env(sourceS3.endpoint))).error).toContain(
      "RESTORE_ASSET_TARGET_CONFLICT",
    );
    expect((await run("asset-reconciled")).code).not.toBe(0);
    const generation = (
      await targetQuery(
        f.target.url,
        `SELECT asset_target->>'generation' AS generation FROM knowledge_base_control.kb_restore`,
      )
    ).rows[0]!.generation;
    const restored = await run();
    expect(restored.code, restored.error).toBe(0);
    const rows = (
      await targetQuery(
        f.target.url,
        `SELECT hash,state::text AS state FROM asset_retained_object WHERE "storageGeneration"=$1 ORDER BY hash`,
        [generation],
      )
    ).rows;
    expect(rows).toEqual([{ hash: `sha256:${f.hex}`, state: "DURABLE" }]);
    expect(
      (
        await targetQuery(
          f.target.url,
          `SELECT hash,state::text AS state FROM asset_retained_object WHERE "storageGeneration"=$1 ORDER BY hash`,
          [sourceGeneration],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { hash: `sha256:${f.hex}`, state: "DURABLE" },
        { hash: orphan, state: "DURABLE" },
        { hash: pending, state: "PENDING" },
      ]),
    );
    for (const table of [
      "asset_cache_pin",
      "asset_cache_entry",
      "asset_cache_owner",
      "asset_cache_state",
    ])
      expect(
        (await targetQuery(f.target.url, `SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n,
      ).toBe(0);
    // An empty restored cache need not materialize the objects directory.
    expect(
      await readdir(join(f.target.assets, "objects")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return [];
      }),
    ).toEqual([]);
    const record = JSON.parse(
      String(
        (
          await targetQuery(
            f.target.url,
            `SELECT value FROM app_setting WHERE key='kb.asset-storage'`,
          )
        ).rows[0]!.value,
      ),
    );
    expect(record).toMatchObject({
      mode: "s3",
      activeGeneration: generation,
      locator: targetLocator,
    });
    // Replaying a READY restore must dispose of this target's cache, including
    // a fill whose process died with a durable pin and quota reservation.
    for (const interrupted of [false, true]) {
      const script = `
import { tsImport } from 'tsx/esm/api';
import { Client } from 'pg';
const domain = await tsImport(${JSON.stringify(join(root, "packages/api/src/lib/kb/asset-storage-offline.ts"))}, import.meta.url);
const {createRuntimeAssetStore, attachRuntimeAssetCache, assetRoleFenceProof} = await tsImport(${JSON.stringify(join(root, "packages/api/src/lib/kb/asset-storage-runtime.ts"))}, import.meta.url);
const {createAssetStorageLifecycle} = await tsImport(${JSON.stringify(join(root, "packages/api/src/lib/kb/asset-storage-lifecycle.ts"))}, import.meta.url);
const client = new Client({connectionString:process.env.DATABASE_URL});
await client.connect();
const marker = JSON.parse((await client.query("SELECT value FROM app_setting WHERE key='kb.asset-storage'")).rows[0].value);
await client.end();
const assetsDir = process.env.KB_DATA_ROOT+'/assets';
if (process.env.INITIALIZE==='true') {
 await domain.initializeOfflineAssetCache({assetsDir,connectionString:process.env.DATABASE_URL,generation:marker.activeGeneration,locator:marker.locator,limit:26214400n,assertOfflineFences:domain.offlineAssetFenceProof(process.env.KB_DATA_ROOT+'/repos')});
} else {
 const lifecycle = createAssetStorageLifecycle('SERVER');
 const input = {assetsDir,connectionString:process.env.DATABASE_URL,marker,lifecycle,env:{...process.env,KB_ASSET_S3_ENABLED:true},assertRoleFence:assetRoleFenceProof(process.env.KB_DATA_ROOT+'/repos','server')};
 if (${interrupted}) {
   const cache = await attachRuntimeAssetCache(input);
   const fill = await cache.beginFill(${JSON.stringify(`sha256:${f.hex}`)},${f.blob.length},Date.now()+30000);
   fill.write(Buffer.from(${JSON.stringify(f.blob.subarray(0, 1).toString("base64"))},'base64'));
   process.kill(process.pid,'SIGKILL');
 } else {
   const store = await createRuntimeAssetStore(input);
   const reader = await store.open({hash:${JSON.stringify(`sha256:${f.hex}`)},size:${f.blob.length},purpose:'download',signal:lifecycle.signal});
   await reader.preflight();
   await reader.readFrame(0,${f.blob.length});
   await reader.complete();
   await reader.close();
   await lifecycle.stop();
 }
}
`;
      const cacheProcess = async (initialize: boolean) => {
        const child = spawn(
          join(root, "apps/server/native/kb-supervisor"),
          [
            ...(initialize ? ["--restore"] : []),
            "--",
            process.execPath,
            "--input-type=module",
            "-e",
            script,
          ],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              ...env(replica.endpoint),
              KB_ASSET_CACHE_MAX_BYTES: "26214400",
              KB_ASSET_S3_SECRET_ACCESS_KEY: "runtime-fixture-secret",
              DATABASE_URL: f.target.url,
              KB_DATA_ROOT: f.target.data,
              INITIALIZE: String(initialize),
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let error = "";
        child.stderr.on("data", (b) => {
          error += b;
        });
        return await new Promise<{ code: number | null; error: string }>(
          (resolveResult, reject) => {
            child.once("error", reject);
            child.once("close", (code) =>
              resolveResult({
                code,
                error: error
                  .split("\n")
                  .filter((line) => !line.includes('"level":"info"'))
                  .join("\n")
                  .trim(),
              }),
            );
          },
        );
      };
      expect(await cacheProcess(true)).toEqual({ code: 0, error: "" });
      const filled = await cacheProcess(false);
      if (interrupted) expect(filled.code).not.toBe(0);
      else expect(filled.code, filled.error).toBe(0);
      expect(
        (await targetQuery(f.target.url, "SELECT state::text AS state FROM asset_cache_entry"))
          .rows,
      ).toEqual([{ state: interrupted ? "FILLING" : "READY" }]);
      if (!interrupted) {
        const cancelled = await run(undefined, true, env(replica.endpoint), true);
        expect(cancelled.error).toContain("CACHE_SCAN_CANCELLED");
        expect(cancelled.code).not.toBe(0);
        expect(
          (await targetQuery(f.target.url, "SELECT state FROM knowledge_base_control.kb_restore"))
            .rows[0]?.state,
        ).not.toBe("READY");
        expect(
          (await targetQuery(f.target.url, "SELECT id FROM asset_cache_pin LIMIT 1")).rows,
        ).toEqual([]);
        expect(
          (
            await targetQuery(
              f.target.url,
              "SELECT id FROM quota_reservation WHERE outcome='RESERVED' LIMIT 1",
            )
          ).rows,
        ).toEqual([]);
        expect(
          (
            await targetQuery(
              f.target.url,
              'SELECT state::text,"cleanupOwner","cleanupAttempt" FROM asset_cache_entry',
            )
          ).rows,
        ).toEqual([{ state: "READY", cleanupOwner: null, cleanupAttempt: null }]);
      }
      if (interrupted)
        expect(
          (
            await targetQuery(
              f.target.url,
              "SELECT id FROM quota_reservation WHERE outcome='RESERVED'",
            )
          ).rows.length,
        ).toBeGreaterThan(0);
      if (interrupted) {
        const [temp] = await readdir(join(f.target.assets, ".private/tmp"));
        const foreign = join(f.dir, "untracked-cache-alias");
        await link(join(f.target.assets, ".private/tmp", temp!), foreign);
        expect((await run()).code).not.toBe(0);
        // An unproven alias blocks disposal; neither the entry nor its charge
        // may disappear on a failed replay. Remove the fixture fault and resume.
        expect(
          (await targetQuery(f.target.url, "SELECT state FROM knowledge_base_control.kb_restore"))
            .rows[0]?.state,
        ).not.toBe("READY");
        expect(
          (await targetQuery(f.target.url, "SELECT incarnation FROM asset_cache_entry LIMIT 1"))
            .rows,
        ).toHaveLength(1);
        expect(
          (
            await targetQuery(
              f.target.url,
              "SELECT id FROM quota_reservation WHERE outcome='RESERVED'",
            )
          ).rows.length,
        ).toBeGreaterThan(0);
        await unlink(foreign);
      }
      const replay = await run();
      expect(replay.code, replay.error).toBe(0);
      expect(
        (await targetQuery(f.target.url, "SELECT incarnation FROM asset_cache_entry LIMIT 1")).rows,
      ).toEqual([]);
      expect(
        (
          await targetQuery(
            f.target.url,
            "SELECT id FROM quota_reservation WHERE outcome='RESERVED' LIMIT 1",
          )
        ).rows,
      ).toEqual([]);
      expect(await readdir(join(f.target.assets, ".private/tmp"))).toEqual([]);
      expect(await readdir(join(f.target.assets, "objects", f.hex.slice(0, 2)))).toEqual([]);
      // The same initializer the next startup/reconciliation needs now succeeds.
      expect(await cacheProcess(true)).toEqual({ code: 0, error: "" });
      // Remove the empty target bookkeeping by replay before the next scenario.
      expect((await run()).code).toBe(0);
    }
    replica.objects.delete(key);
    expect((await run()).code).not.toBe(0);
    expect(
      (await targetQuery(f.target.url, `SELECT state FROM knowledge_base_control.kb_restore`))
        .rows[0]!.state,
    ).not.toBe("READY");
    replica.objects.set(key, object);
    const repeated = await run();
    expect(repeated.code, repeated.error).toBe(0);
    expect(
      (
        await targetQuery(
          f.target.url,
          `SELECT asset_target->>'generation' AS generation FROM knowledge_base_control.kb_restore`,
        )
      ).rows[0]!.generation,
    ).toBe(generation);
    // A same-locator archive containing historical generations also receives
    // a fresh authority generation, with only its verified reference set.
    const sameFile = await coordinateBackup({
      connectionString: f.target.url,
      dataDir: f.target.data,
      backupDir: join(f.dir, "same-locator-backup"),
      recipient: f.recipient,
      supervisor: join(root, "apps/server/native/kb-supervisor"),
      assetEnvironment: env(replica.endpoint),
    });
    const sameDir = await mkdtemp(join(tmpdir(), "s3-restore-same-locator-"));
    try {
      const same = {
        ...f,
        file: sameFile,
        dir: sameDir,
        target: await emptyTarget(sameDir),
        attemptId: randomUUID(),
      };
      const result = await restore(
        same,
        undefined,
        undefined,
        master.toString("base64"),
        authSecret,
        env(replica.endpoint),
      );
      expect(result.code, result.error).toBe(0);
      const newGeneration = (
        await targetQuery(
          same.target.url,
          `SELECT asset_target->>'generation' AS generation FROM knowledge_base_control.kb_restore`,
        )
      ).rows[0]!.generation;
      expect(newGeneration).not.toBe(generation);
      expect(newGeneration).not.toBe(sourceGeneration);
      expect(
        (
          await targetQuery(
            same.target.url,
            `SELECT hash,state::text AS state FROM asset_retained_object WHERE "storageGeneration"=$1 ORDER BY hash`,
            [newGeneration],
          )
        ).rows,
      ).toEqual([{ hash: `sha256:${f.hex}`, state: "DURABLE" }]);
    } finally {
      await rm(sameDir, { recursive: true, force: true });
    }
  } finally {
    if (!sourceClosed) await sourceS3.close();
    await replica.close();
    await cleanup(f);
  }
});

async function targetQuery(url: string, sql: string, values: unknown[] = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}
