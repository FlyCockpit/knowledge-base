/**
 * Isolated browser fixture for `pnpm test:kb -- browser`.
 *
 * Seeds real Git/CAS/PostgreSQL KB data and serves the REAL `/kb-assets` and
 * `/kb-exports` routes behind the REAL `mountSecurityHeaders`, authenticated by
 * a random fixture-only session cookie (no Better Auth login, no external
 * browser profile). Document reads and export preparation call the production
 * domain services; only the transport for those two calls is a fixture JSON
 * endpoint instead of the session-authenticated oRPC gateway.
 * Routed PR review, MCP consent and credential pages use real Better Auth cookie sessions,
 * session-backed oRPC procedures and the mounted OAuth provider.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { remoteSealedNamespace } from "@knowledge-base/api/lib/kb/attachment";
import {
  type AuthorityBarrier,
  runLockedOperation,
} from "@knowledge-base/api/lib/kb/authority-lock";
import { mapKbDomainError } from "@knowledge-base/api/lib/kb/bases";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { insertBranchOwner } from "@knowledge-base/api/lib/kb/branch-owner";
import { publishCasBytes } from "@knowledge-base/api/lib/kb/cas";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import {
  authorizeDocumentRead,
  readDocumentAtRevision,
  resolvePinnedRevision,
} from "@knowledge-base/api/lib/kb/documents-read";
import { reclaimExports } from "@knowledge-base/api/lib/kb/exports";
import * as media from "@knowledge-base/api/lib/kb/fixtures/media-bytes";
import { kbBareRepoPath, readHeadSha } from "@knowledge-base/api/lib/kb/git-read";
import {
  GitCommandError,
  type GitMutatingExecutor,
  writeInitialMainCommit,
  writeStagedObjects,
} from "@knowledge-base/api/lib/kb/git-write";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { HeldLockLease } from "@knowledge-base/api/lib/kb/lock";
import {
  type AssetManifestEntry,
  canonicalManifestBytes,
} from "@knowledge-base/api/lib/kb/manifest";
import { KB_MANAGED_GITIGNORE } from "@knowledge-base/api/lib/kb/paths";
import { authorize, prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { pullRequestErrorData } from "@knowledge-base/api/lib/kb/pr-conflict";
import { revokeProvider } from "@knowledge-base/api/lib/kb/providers";
import {
  createPullRequestPublication,
  getPullRequest,
  type PrMutationRequest,
} from "@knowledge-base/api/lib/kb/pull-requests";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { configureKbRuntime, type KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { enrollSealedRecord } from "@knowledge-base/api/lib/kb/sealed-records";
import { resolveSealedReference } from "@knowledge-base/api/lib/kb/sealed-resolve";
import {
  authenticatePersonalToken,
  createGrantCredentialVerifier,
  mintPersonalToken,
} from "@knowledge-base/api/lib/mcp-token-access";
import {
  createDeviceApprovalService,
  resolveDevicePlugins,
} from "@knowledge-base/auth/device-approval";
import { resolveMcpPlugins } from "@knowledge-base/auth/mcp-plugins";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { Queue } from "bullmq";
import { Hono } from "hono";
import { openKbPostgresClusterFromEnv } from "./postgres.js";

type FetchApp = { fetch(request: Request): Response | Promise<Response> };
type RouteFactory = (options: {
  runtime: () => KbRuntimeConfig;
  session: (headers: Headers) => Promise<{ user: { id: string } } | null>;
}) => FetchApp & { routes: unknown };

const serverSrc = resolve(import.meta.dirname, "../../../../apps/server/src");
const apiSrc = resolve(import.meta.dirname, "../../../api/src");

/** Data the browser spec needs; contains the fixture cookie, never a real credential. */
export type KbBrowserFixtureData = {
  origin: string;
  attackerOrigin: string;
  cookie: { name: string; value: string };
  kbId: string;
  otherKbId: string;
  oldRev: string;
  headRev: string;
  mediaPath: string;
  hostilePath: string;
  hashes: { png: string; mp4: string; wav: string; other: string };
  pr: KbBrowserPrFixtureData;
  settings: KbBrowserSettingsFixtureData;
  mcp: { cookie: { name: string; value: string }; userId: string };
};

/** KB settings fixture: real oRPC routers at `/rpc`, one cookie per role. */
type KbBrowserSettingsFixtureData = {
  cookies: { owner: string; known: string; member: string; manager: string };
  ownerUserId: string;
  /** Receives share invitations; has an account but no share yet. */
  knownUserId: string;
  knownEmail: string;
  /** No account has this address. */
  unknownEmail: string;
  /** Accepted `read` member of `transferKbId`, the transfer recipient. */
  memberUserId: string;
  /** Holds `manage` on `kbId` without being its owner. */
  managerUserId: string;
  /** Exact live PAT grant generation, not the token ID or secret. */
  sealedConsumerGrantId: string;
  kbId: string;
  transferKbId: string;
  /** Owned by `owner`: a document plus one PNG asset for the editor preview. */
  editor: { kbId: string; path: string; pngHash: string };
};

/** One seeded pull request (real branch, BranchOwner and PR rows). */
export type KbBrowserPr = {
  kbId: string;
  number: number;
  baseSha: string;
  headSha: string;
  targetSha: string;
};

/** Pull-request review fixture: a propose-only author and a review-only reviewer. */
type KbBrowserPrFixtureData = {
  cookies: { author: string; reviewer: string };
  docPath: string;
  /** Formatting + media changes: pic replaced, clip added, sound removed. */
  review: KbBrowserPr & {
    hashes: { picBefore: string; picAfter: string; clip: string; sound: string };
  };
  /** Its main is advanced by `/fixture/advance-main` between view and click. */
  conflict: KbBrowserPr;
  /** 205 changed files: more than CONTRACT's 200 deltas per page. */
  large: KbBrowserPr & { count: number };
  /** Closed by its propose-only author. */
  close: KbBrowserPr;
};

export type KbBrowserFixture = {
  data: KbBrowserFixtureData;
  /** Handles `/kb-assets`, `/kb-exports` and `/fixture/*`; false for anything else. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  attackerHits(): number;
  close(): Promise<void>;
};

const KB_BROWSER_COOKIE = "kb_browser_fixture";

const MEDIA_MARKDOWN = [
  "# Media fixture",
  "",
  "![Fixture picture](../media/pic&#46;png)",
  "",
  "![Fixture clip][clip]",
  "",
  "![Fixture sound](/media/sound%2Ewav)",
  "",
  "[clip]: ../media/clip&period;mp4",
  "",
  "| Kind | File |",
  "| --- | --- |",
  "| image | pic.png |",
  "",
].join("\n");

function hostileMarkdown(attackerOrigin: string): string {
  const pixel = `${attackerOrigin}/pixel.png`;
  return [
    "# Hostile fixture",
    "",
    "<script>window.__kbPwned = 'script'</script>",
    "",
    `<img src="${pixel}?raw" onerror="window.__kbPwned='onerror'">`,
    "",
    `<svg onload="window.__kbPwned='svg'"><image href="${pixel}?svg"/></svg>`,
    "",
    `[js](javascript:window.__kbPwned='link') [data](data:text/html,<script>window.__kbPwned=1</script>) [file](file:///etc/passwd)`,
    "",
    `![remote](${pixel}?md) ![proto](${pixel.replace("http:", "")}?proto) ![inline](data:image/png;base64,iVBORw0KGgo=)`,
    "",
    `[ref-img]: ${pixel}?ref`,
    "",
    "![by reference][ref-img]",
    "",
    `<iframe src="${attackerOrigin}/frame"></iframe>`,
    "",
    "![Gone](../media/missing.png)",
    "",
  ].join("\n");
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const chunks: Buffer[] = [];
  if (req.method !== "GET" && req.method !== "HEAD")
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function stageCommit(input: {
  parentSha: string;
  files: { segments: string[]; content: Buffer }[];
}) {
  const { stageCommitWithTreeFiles } = (await import(
    pathToFileURL(join(apiSrc, "lib/kb/staged-tree.ts")).href
  )) as {
    stageCommitWithTreeFiles(input: {
      parentSha: string;
      message: string;
      files: { segments: string[]; content: Buffer }[];
    }): { commitSha: string; objects: Parameters<typeof writeStagedObjects>[1] };
  };
  return stageCommitWithTreeFiles({ ...input, message: randomUUID() });
}

/** Starts an origin that records every hit; the spec asserts it is never contacted. */
async function startAttacker(): Promise<{ origin: string; hits: () => number; server: Server }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.end(media.minimalPng());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("attacker fixture has no port");
  return { origin: `http://127.0.0.1:${address.port}`, hits: () => hits, server };
}

export async function createKbBrowserFixture(options: {
  origin: string;
}): Promise<KbBrowserFixture> {
  let privateRoot: string | undefined;
  const cleanup: Array<() => void | Promise<void>> = [
    () => {
      if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
    },
  ];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      for (const dispose of [...cleanup].reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "browser data fixture cleanup failed");
    })());
  try {
    const cluster = await openKbPostgresClusterFromEnv();
    cleanup.push(() => cluster.close());
    const db = await cluster.createDatabase();
    cleanup.push(() => db.close());
    db.applyPrismaSchema();
    const prisma = db.createPrismaClient("runtime");
    cleanup.push(() => prisma.$disconnect());
    const root = mkdtempSync(join(tmpdir(), "kb-browser-"));
    privateRoot = root;
    const reposDir = join(root, "repos");
    const assetsDir = join(root, "assets");
    mkdirSync(reposDir);
    mkdirSync(assetsDir);
    setKbRecoveryComplete(true);
    const runtime: KbRuntimeConfig = {
      prisma,
      reposDir,
      assetsDir,
      blobStore: createDiskBlobStore(assetsDir),
      connectionString: db.urls.runtime,
      canonicalOrigin: options.origin,
      cursorSigner: createCursorSigner(randomBytes(32)),
      ratePort: createMemoryRatePort(),
      diskMeter: { freeBytes: async () => 1n << 40n },
      coordinator: {
        run: (run) =>
          runLockedOperation({
            connectionString: db.urls.runtime,
            opId: run.opId,
            kind: "authority",
            run: (lease) =>
              run.run({
                lease,
                signal: lease.scope.signal,
                issueWriteCapability() {
                  throw new Error("browser fixture is read-only");
                },
              }),
          }),
      },
    };
    const attacker = await startAttacker();
    cleanup.push(
      () =>
        new Promise<void>((done, reject) => {
          attacker.server.close((error) => (error ? reject(error) : done()));
        }),
    );

    const owner = await prisma.user.create({
      data: {
        name: "Browser owner",
        email: `${randomUUID()}@example.invalid`,
        emailVerified: true,
        twoFactorEnabled: true,
      },
    });
    const author = await prisma.user.create({
      data: {
        name: "PR author",
        email: `${randomUUID()}@example.invalid`,
        emailVerified: true,
        twoFactorEnabled: true,
      },
    });
    const reviewer = await prisma.user.create({
      data: {
        name: "PR reviewer",
        email: `${randomUUID()}@example.invalid`,
        emailVerified: true,
        twoFactorEnabled: true,
      },
    });
    const sessionValue = randomBytes(32).toString("base64url");
    const sessions = new Map([
      [sessionValue, owner.id],
      [randomBytes(32).toString("base64url"), author.id],
      [randomBytes(32).toString("base64url"), reviewer.id],
    ]);
    const cookieFor = (userId: string) => [...sessions].find(([, id]) => id === userId)![0];
    const session = async (headers: Headers) => {
      for (const part of (headers.get("cookie") ?? "").split(";")) {
        const cookie = part.trim();
        const separator = cookie.indexOf("=");
        const name = cookie.slice(0, separator);
        const value = cookie.slice(separator + 1);
        const userId = name === KB_BROWSER_COOKIE && value ? sessions.get(value) : undefined;
        if (userId) return { user: { id: userId } };
      }
      return null;
    };

    async function createKb(slug: string, ownerId = owner.id) {
      const row = await prisma.knowledgeBase.create({
        data: {
          ownerId,
          name: slug,
          slug: `${slug}-${randomUUID().slice(0, 8)}`,
          description: "Browser fixture knowledge base",
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
    async function asset(kbId: string, path: string, bytes: Buffer, mime: string) {
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
      return { path, hash, size: bytes.length, mime } satisfies AssetManifestEntry;
    }
    async function commit(
      kb: { id: string; rev: string },
      docs: Record<string, string>,
      entries: AssetManifestEntry[],
      ref = "refs/heads/main",
    ) {
      const staged = await stageCommit({
        parentSha: kb.rev,
        files: [
          ...Object.entries(docs).map(([path, markdown]) => ({
            segments: path.split("/"),
            content: Buffer.from(markdown),
          })),
          { segments: [".gitignore"], content: Buffer.from(KB_MANAGED_GITIGNORE) },
          {
            segments: [".assets", "manifest.json"],
            content: canonicalManifestBytes({
              version: 1,
              entries: [...entries].sort((a, b) => (a.path < b.path ? -1 : 1)),
            }),
          },
        ],
      });
      const repo = kbBareRepoPath(reposDir, kb.id);
      writeStagedObjects(repo, staged.objects);
      // Test-only publication; production writes stay behind the write coordinator.
      mkdirSync(join(repo, ref, ".."), { recursive: true });
      writeFileSync(join(repo, ref), `${staged.commitSha}\n`);
      if (ref === "refs/heads/main")
        await prisma.knowledgeBase.update({
          where: { id: kb.id },
          data: { headSha: staged.commitSha },
        });
      return { id: kb.id, rev: staged.commitSha };
    }

    const mediaPath = "notes/media.md";
    const hostilePath = "notes/hostile.md";
    const kb = await createKb("browser");
    const entries = [
      await asset(kb.id, "media/pic.png", media.minimalPng(), "image/png"),
      await asset(kb.id, "media/clip.mp4", media.realMp4(), "video/mp4"),
      await asset(kb.id, "media/sound.wav", media.minimalWav(), "audio/wav"),
    ];
    const docs = {
      "index.md": "# Browser fixture\n",
      [mediaPath]: MEDIA_MARKDOWN,
      [hostilePath]: hostileMarkdown(attacker.origin),
    };
    const old = await commit(kb, docs, entries);
    // HEAD removes every media reference from the manifest; history keeps the bytes.
    const head = await commit(old, docs, []);
    const other = await createKb("other");
    const otherEntry = await asset(other.id, "media/other.png", media.alternatePng(), "image/png");
    await commit(other, { "index.md": "# Other\n" }, [otherEntry]);

    // ---- Pull-request review fixture --------------------------------
    const store = prismaAuthorityStore(prisma);
    const gitExecutor: GitMutatingExecutor = {
      exec({ cwd, argv, env }) {
        return new Promise<void>((done, fail) => {
          const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: "ignore" });
          child.once("error", fail);
          child.once("exit", (code) =>
            code === 0 ? done() : fail(new GitCommandError("fixture", code ?? -1)),
          );
        });
      },
    };
    /** Production PR publication under a real KB write lock, as `mutatePullRequest`. */
    function mutatePr(userId: string, request: PrMutationRequest) {
      const publication = createPullRequestPublication({
        store,
        principal: { kind: "browser", userId },
        reposDir,
        canonicalOrigin: options.origin,
        request,
        ratePort: runtime.ratePort,
        diskMeter: runtime.diskMeter,
      });
      return runLockedOperation({
        opId: randomUUID(),
        kind: "kb-write",
        kbIds: [request.kbId],
        barrier: publication.barrier as AuthorityBarrier,
        connectionString: db.urls.runtime,
        run: (lease: HeldLockLease) => publication.publish(lease, gitExecutor),
      });
    }
    const prDocPath = "notes/review.md";
    async function seedPr(input: {
      slug: string;
      main: Record<string, string>;
      mainAssets: AssetManifestEntry[];
      head: Record<string, string>;
      headAssets: AssetManifestEntry[];
      kb?: { id: string; rev: string };
      authorId?: string;
      reviewerId?: string;
      existingMain?: boolean;
    }) {
      const authorId = input.authorId ?? author.id;
      const reviewerId = input.reviewerId ?? reviewer.id;
      const created = input.kb ?? (await createKb(input.slug));
      for (const [userId, bits] of [
        [authorId, ["propose"]],
        [reviewerId, ["review"]],
      ] as const)
        await prisma.kbShare.upsert({
          where: { kbId_userId: { kbId: created.id, userId } },
          create: { kbId: created.id, userId, bits: [...bits] },
          update: {},
        });
      const main = input.existingMain
        ? created
        : await commit(created, input.main, input.mainAssets);
      const ref = `refs/heads/feature/${input.slug}`;
      const head = await commit(main, input.head, input.headAssets, ref);
      await insertBranchOwner(prismaAssetQuery(prisma), {
        kbId: created.id,
        refName: ref,
        ownerActorKey: `user:${authorId}`,
        purpose: "USER",
      });
      const result = (await mutatePr(authorId, {
        kind: "create",
        kbId: created.id,
        headBranch: `feature/${input.slug}`,
        expectedHeadSha: head.rev,
        expectedTargetSha: main.rev,
        title: `Proposal ${input.slug}`,
        idempotencyKey: randomUUID(),
      })) as { pr: { number: number; status: string } };
      // A seeded PR starts mergeable: an invalid tree on either side (say a
      // missing root file) would otherwise surface only as a disabled Merge.
      if (result.pr.status !== "OPEN")
        throw new Error(`fixture PR ${input.slug} was created ${result.pr.status}`);
      return {
        kbId: created.id,
        number: result.pr.number,
        baseSha: main.rev,
        headSha: head.rev,
        targetSha: main.rev,
      };
    }
    const reviewKb = await createKb("pr-review");
    const pic = await asset(reviewKb.id, "media/pic.png", media.minimalPng(), "image/png");
    const picAfter = await asset(reviewKb.id, "media/pic.png", media.alternatePng(), "image/png");
    const clip = await asset(reviewKb.id, "media/clip.mp4", media.realMp4(), "video/mp4");
    const sound = await asset(reviewKb.id, "media/sound.wav", media.minimalWav(), "audio/wav");
    const reviewPr = await seedPr({
      slug: "review",
      kb: reviewKb,
      main: {
        "index.md": "# PR fixture\n",
        [prDocPath]:
          "# Review\n\nPlain words before.\n\n![Picture](../media/pic.png)\n\n![Sound](../media/sound.wav)\n",
      },
      mainAssets: [pic, sound],
      head: {
        "index.md": "# PR fixture\n",
        [prDocPath]: [
          "# Review",
          "",
          "Now **bold words** and _emphasis_.",
          "",
          "| Kind | Value |",
          "| --- | --- |",
          "| cell | 42 |",
          "",
          "![Picture](../media/pic.png)",
          "",
          "![Clip](../media/clip.mp4)",
          "",
          "<script>window.__kbPwned = 'pr-script'</script>",
          "",
          `<img src="${attacker.origin}/pixel.png?pr" onerror="window.__kbPwned='pr-onerror'">`,
          "",
        ].join("\n"),
      },
      headAssets: [picAfter, clip],
    });
    const conflictPr = await seedPr({
      slug: "conflict",
      main: { "index.md": "# Conflict fixture\n" },
      mainAssets: [],
      head: { "index.md": "# Conflict fixture\n", [prDocPath]: "# Proposed\n" },
      headAssets: [],
    });
    const LARGE = 205;
    const largePr = await seedPr({
      slug: "large",
      main: { "index.md": "# Large fixture\n" },
      mainAssets: [],
      head: Object.fromEntries([
        ["index.md", "# Large fixture\n"],
        ...Array.from({ length: LARGE }, (_, i) => [
          `bulk/${String(i).padStart(4, "0")}.md`,
          `# Bulk ${i}\n`,
        ]),
      ]),
      headAssets: [],
    });
    const closePr = await seedPr({
      slug: "close",
      main: { "index.md": "# Close fixture\n" },
      mainAssets: [],
      head: { "index.md": "# Close fixture\n", [prDocPath]: "# Abandoned\n" },
      headAssets: [],
    });

    const createRoutes = async (file: string, name: string) =>
      ((await import(pathToFileURL(join(serverSrc, file)).href)) as Record<string, RouteFactory>)[
        name
      ]!;
    const { mountSecurityHeaders } = (await import(
      pathToFileURL(join(serverSrc, "security-headers.ts")).href
    )) as {
      mountSecurityHeaders(
        app: Hono,
        options: { cspConnectSrc: string[]; themeInitCspHash: string },
      ): void;
    };
    const app = new Hono();
    mountSecurityHeaders(app, { cspConnectSrc: ["'self'"], themeInitCspHash: "'sha256-fixture'" });
    const routeOptions = { runtime: () => runtime, session };
    app.route(
      "/",
      (await createRoutes("kb-asset-routes.ts", "createKbAssetRoutes"))(routeOptions) as never,
    );
    app.route(
      "/",
      (await createRoutes("kb-export-routes.ts", "createKbExportRoutes"))(routeOptions) as never,
    );

    let revokeNextExport = false;
    const fixture = new Hono();
    fixture.use("*", async (c, next) => {
      const auth = await session(c.req.raw.headers);
      if (!auth) return c.json({ error: "UNAUTHORIZED" }, 401);
      await next();
    });
    // Mirrors `documents.get`: admission, pinned revision, manifest-resolved asset refs.
    fixture.get("/fixture/document", async (c) => {
      const kbId = c.req.query("kbId") ?? "";
      const admission = {
        store: prismaAuthorityStore(prisma),
        principal: {
          kind: "browser" as const,
          userId: (await session(c.req.raw.headers))!.user.id,
        },
        kbId,
        operation: "read" as const,
      };
      try {
        await authorizeDocumentRead(admission);
        const row = await prisma.knowledgeBase.findUnique({
          where: { id: kbId },
          select: { headSha: true },
        });
        const commitSha = await resolvePinnedRevision(
          kbBareRepoPath(reposDir, kbId),
          c.req.query("rev"),
          row?.headSha ?? null,
        );
        return c.json(
          await readDocumentAtRevision({
            reposDir,
            kbId,
            commitSha,
            path: c.req.query("path") ?? "",
            query: prismaAssetQuery(prisma),
          }),
        );
      } catch {
        return c.json({ error: "NOT_FOUND" }, 404);
      }
    });
    // Test-only probe: whether an export's artifact is still held (not yet released).
    fixture.get("/fixture/export-state", async (c) => {
      const row = await prisma.exportArtifact.findUnique({
        where: { id: c.req.query("transferId") ?? "" },
        select: { state: true, reclaimedAt: true },
      });
      return c.json({ state: row?.state ?? null, released: row?.reclaimedAt != null });
    });
    // Test-only clock advance after real served EOF: exercise grace reclamation.
    fixture.post("/fixture/expire-export-grace", async (c) => {
      const { transferId } = await c.req.json();
      const count = await prisma.exportArtifact.updateMany({
        where: {
          id: transferId,
          actorKey: `user:${owner.id}`,
          state: "READY",
          downloadCompletedAt: { not: null },
        },
        data: {
          downloadCompletedAt: new Date(Date.now() - 600_001),
          expiresAt: new Date(Date.now() - 1),
        },
      });
      if (count.count !== 1) return c.json({ error: "missing served EOF" }, 409);
      await reclaimExports(runtime);
      return c.json({ reclaimed: true });
    });
    // Server policy allows one live export per user; each spec starts without one.
    fixture.post("/fixture/reset-exports", async (c) => {
      revokeNextExport = false;
      await prisma.exportArtifact.updateMany({
        where: { reclaimedAt: null },
        data: { expiresAt: new Date(0) },
      });
      await reclaimExports(runtime);
      return c.json({ ok: true });
    });
    fixture.get("/fixture/attacker-hits", (c) => c.json({ hits: attacker.hits() }));
    fixture.post("/fixture/revoke-next-export", (c) => {
      revokeNextExport = true;
      return c.json({ ok: true });
    });

    // ---- PR endpoints: the session user's principal, production PR services ----
    const principalOf = async (headers: Headers) => ({
      kind: "browser" as const,
      userId: (await session(headers))!.user.id,
    });
    // Same error data as the `pullRequests` router (structured CONFLICT details).
    const prError = (error: unknown) => {
      const code = mapKbDomainError(error)?.code ?? "INTERNAL";
      const status =
        code === "CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : 500;
      return { body: pullRequestErrorData(error, code), status } as const;
    };
    let reviewCalls = 0;
    // Mirrors `pullRequests.get` (one CONTRACT page of at most 50 deltas).
    fixture.get("/fixture/pr", async (c) => {
      try {
        const cursor = c.req.query("cursor");
        return c.json(
          await getPullRequest(
            {
              store,
              principal: await principalOf(c.req.raw.headers),
              query: prismaAssetQuery(prisma),
              reposDir,
              cursorSigner: runtime.cursorSigner,
            },
            {
              kbId: c.req.query("kbId") ?? "",
              number: Number(c.req.query("number")),
              page: { limit: 50, cursor: cursor || null },
            },
          ),
        );
      } catch (error) {
        const mapped = prError(error);
        return c.json(mapped.body, mapped.status);
      }
    });
    // Mirrors `pullRequests.review`.
    fixture.post("/fixture/pr-review", async (c) => {
      reviewCalls += 1;
      try {
        const principal = await principalOf(c.req.raw.headers);
        return c.json(
          await mutatePr(principal.userId, {
            ...((await c.req.json()) as Omit<
              Extract<PrMutationRequest, { kind: "review" }>,
              "kind"
            >),
            kind: "review",
          }),
        );
      } catch (error) {
        const mapped = prError(error);
        return c.json(mapped.body, mapped.status);
      }
    });
    // Fresh PR per access-loss scenario; subsequent calls use the real routers.
    fixture.post("/fixture/pr-case", async (c) => {
      await principalOf(c.req.raw.headers);
      // Both sides are valid KB trees (the root index.md is required): an
      // invalid head would make the PR unmergeable, i.e. CONFLICT.
      const notes = (label: string) => ({
        "index.md": "# Access case\n",
        ...Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [
            `notes/${String(i).padStart(2, "0")}.md`,
            `# Private ${label} ${i}\n`,
          ]),
        ),
      });
      const main = notes("before");
      const head = notes("after");
      const caseAuthor = await settingsUser("pr-case-author");
      const caseReviewer = await settingsUser("pr-case-reviewer");
      // A real Better Auth session: the routed PR page is owned by the signed-in actor.
      const reviewerSession = await prisma.session.create({
        data: {
          userId: caseReviewer.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const reviewerCookie = `${reviewerSession.token}.${createHmac("sha256", authSecret).update(reviewerSession.token).digest("base64")}`;
      sessions.set(reviewerCookie, caseReviewer.id);
      const pr = await seedPr({
        authorId: caseAuthor.id,
        reviewerId: caseReviewer.id,
        slug: `access-${randomUUID()}`,
        main,
        head,
        mainAssets: [],
        headAssets: [],
      });
      return c.json({
        pr,
        reviewerUserId: caseReviewer.id,
        reviewerEmail: caseReviewer.email,
        reviewerCookie,
      });
    });
    fixture.get("/fixture/pr-review-calls", (c) => c.json({ calls: reviewCalls }));
    // The viewer's live effective bits, as `kbs.get` reports them.
    fixture.get("/fixture/pr-viewer", async (c) => {
      const principal = await principalOf(c.req.raw.headers);
      const auth = await authorize({
        store,
        principal,
        kbId: c.req.query("kbId") ?? "",
        operation: "read",
      });
      return c.json({ actorKey: `user:${principal.userId}`, bits: auth.bits });
    });
    fixture.get("/fixture/main", (c) =>
      c.json({ rev: readHeadSha(kbBareRepoPath(reposDir, c.req.query("kbId") ?? "")) }),
    );
    // Test-only: another writer advances main after the reviewer loaded the diff.
    fixture.post("/fixture/advance-main", async (c) => {
      const kbId = c.req.query("kbId") ?? "";
      const rev = readHeadSha(kbBareRepoPath(reposDir, kbId));
      if (!rev) return c.json({ error: "NOT_FOUND" }, 404);
      const next = await commit(
        { id: kbId, rev },
        { "index.md": `# Advanced ${randomUUID()}\n` },
        [],
      );
      return c.json({ rev: next.rev });
    });

    // ---- KB settings fixture ---------------------------------------
    // The page talks to the REAL oRPC routers (members, providers, index profile,
    // sealed) through `/rpc`, exactly as the app does; only the session is the
    // fixture cookie. Env is fixture-only and set before the routers load.
    process.env.DATABASE_URL = db.urls.runtime;
    process.env.REDIS_URL = process.env.KB_TEST_REDIS_URL ?? "redis://127.0.0.1:1/0";
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    process.env.BETTER_AUTH_URL = options.origin;
    process.env.KB_MASTER_KEY = randomBytes(32).toString("base64");
    // Acquire global modules only after their disposable environment exists.
    // A partial constructor before this point must not create IO during cleanup.
    const queueModule = await import("@knowledge-base/queue");
    cleanup.push(async () => {
      await Promise.all(
        Object.values(queueModule)
          .filter((value): value is Queue => value instanceof Queue)
          .map((queue) => queue.close()),
      );
      queueModule.redisConnection.disconnect();
    });
    const { default: defaultDb } = await import("@knowledge-base/db");
    if (defaultDb !== prisma) cleanup.push(() => defaultDb.$disconnect());
    const { auth: applicationAuth } = await import("@knowledge-base/auth");
    await applicationAuth.$context;
    const settingsUser = async (label: string) =>
      prisma.user.create({
        data: {
          name: label,
          email: `${label}-${randomUUID()}@example.invalid`,
          emailVerified: true,
          twoFactorEnabled: true,
        },
      });
    const known = await settingsUser("known");
    const member = await settingsUser("member");
    const manager = await settingsUser("manager");
    for (const user of [known, member, manager])
      sessions.set(randomBytes(32).toString("base64url"), user.id);
    const settingsKb = await createKb("settings");
    const transferKb = await createKb("transfer");
    // Editor: real `documents.*` writes through `/rpc`, read back byte-exact.
    const editorKb = await createKb("editor");
    const editorPng = await asset(editorKb.id, "media/pic.png", media.minimalPng(), "image/png");
    await commit(
      editorKb,
      {
        "index.md": "# Editor fixture\n",
        "notes/draft.md": "# Draft start\n\n![pic](../media/pic.png)\n",
      },
      [editorPng],
    );
    await prisma.kbShare.create({
      data: { kbId: settingsKb.id, userId: manager.id, bits: ["manage"] },
    });
    await prisma.kbShare.create({
      data: { kbId: transferKb.id, userId: member.id, bits: ["read"] },
    });
    const { token: sealedConsumerToken } = await mintPersonalToken(runtime, owner.id, {
      name: "Browser sealed recipient",
      scopes: ["mcp:read"],
      toolGroups: [...MCP_TOOL_GROUPS],
      acl: [{ kbId: settingsKb.id, bits: ["read"] }],
    });
    const { grantId: sealedConsumerGrantId } = await prisma.mcpPersonalToken.findUniqueOrThrow({
      where: { id: sealedConsumerToken.id },
      select: { grantId: true },
    });

    const { createKbWriteCoordinator } = (await import(
      pathToFileURL(join(serverSrc, "kb-write-coordinator.ts")).href
    )) as {
      createKbWriteCoordinator(deps: Record<string, unknown>): KbRuntimeConfig["coordinator"];
    };
    const children = new Map<number, Promise<{ opId: string; pid: number; status: number }>>();
    configureKbRuntime({
      ...runtime,
      // Document writes (editor fixture) publish with the fixture's Git executor.
      createGitExecutor: () => gitExecutor,
      // Fixture-only: no Linux process supervisor; children are spawned directly.
      coordinator: createKbWriteCoordinator({
        connectionString: db.urls.runtime,
        assertFence: () => {},
        closeAdmission: async () => {},
        async spawn(req: { opId: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
          const child = spawn(req.argv[0]!, req.argv.slice(1), {
            cwd: req.cwd,
            env: req.env,
            stdio: "ignore",
            timeout: 10_000,
            killSignal: "SIGKILL",
          });
          const exit = new Promise<{ opId: string; pid: number; status: number }>((done, fail) => {
            child.once("error", fail);
            child.once("exit", (status) =>
              done({ opId: req.opId, pid: child.pid!, status: status ?? -1 }),
            );
          });
          children.set(child.pid!, exit);
          return { pid: child.pid! };
        },
        // The coordinator waits by (opId, pid); an unknown child is a harness bug.
        wait: async (_opId: string, pid: number) => {
          const exit = children.get(pid);
          if (!exit) throw new Error(`unknown supervised child ${pid}`);
          return exit;
        },
      }),
    });
    // R34a: real provider and real cookie sessions for consent/credential transport.
    const authSecret = process.env.BETTER_AUTH_SECRET!;
    const mcpAuth = betterAuth({
      database: prismaAdapter(prisma, { provider: "postgresql" }),
      baseURL: options.origin,
      secret: authSecret,
      trustedOrigins: [options.origin],
      plugins: [
        ...resolveMcpPlugins({ baseUrl: options.origin, secret: authSecret, db: prisma }),
        ...resolveDevicePlugins({ baseUrl: options.origin, db: prisma }),
      ],
    });
    // Join plugin initialization before admitting requests or tearing down the
    // fixture DB; an in-flight resource seed must not outlive its connection.
    await mcpAuth.$context;
    await prisma.user.update({ where: { id: owner.id }, data: { twoFactorEnabled: true } });
    const mcpSession = await prisma.session.create({
      data: { userId: owner.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const mcpCookie = {
      name: "better-auth.session_token",
      value: `${mcpSession.token}.${createHmac("sha256", authSecret).update(mcpSession.token).digest("base64")}`,
    };
    const { mountMcpOAuth } = (await import(
      pathToFileURL(join(serverSrc, "mcp-discovery.ts")).href
    )) as {
      mountMcpOAuth(
        app: Hono,
        options: { baseUrl: string; handler: typeof mcpAuth.handler },
      ): typeof mcpAuth.handler;
    };
    const oauthApp = new Hono();
    const oauthHandler = mountMcpOAuth(oauthApp, {
      baseUrl: options.origin,
      handler: mcpAuth.handler,
    });
    oauthApp.all("/api/auth/*", (c) => oauthHandler(c.req.raw));
    const deviceService = createDeviceApprovalService({
      db: prisma,
      resource: `${options.origin}/mcp`,
    });
    const sealedDeviceKb = await createKb("device-sealed");
    const sealedMasterKey = process.env.KB_MASTER_KEY!;
    const sealedDevice = await enrollSealedRecord(
      runtime,
      { kind: "browser", userId: owner.id },
      {
        kbId: sealedDeviceKb.id,
        namespace: remoteSealedNamespace(options.origin, sealedDeviceKb.id),
        plaintext: "browser-device-sealed-canary",
        idempotencyKey: randomUUID(),
      },
      sealedMasterKey,
    );
    await commit(sealedDeviceKb, { "sealed.md": sealedDevice.reference }, []);
    fixture.get("/fixture/device/sealed", (c) =>
      c.json({ kbId: sealedDeviceKb.id, name: "device-sealed", reference: sealedDevice.reference }),
    );
    fixture.post("/fixture/device/resolve", async (c) => {
      const { secret, recipientKeyId } = await c.req.json();
      const query = prismaAssetQuery(prisma);
      const principal = await authenticatePersonalToken(query, secret, new Date());
      if (!principal) return c.json({ error: "FORBIDDEN" }, 403);
      return c.json(
        await resolveSealedReference(
          runtime,
          principal,
          {
            kbId: sealedDeviceKb.id,
            path: "sealed.md",
            reference: sealedDevice.reference,
            recipientKeyId,
          },
          { verifier: createGrantCredentialVerifier(query), masterKey: sealedMasterKey },
        ),
      );
    });
    fixture.post("/fixture/device/numeric", async (c) => {
      const { userCode } = await c.req.json();
      await prisma.deviceCode.update({ where: { userCode }, data: { userCode: "23456789" } });
      return c.json({ userCode: "23456789" });
    });
    fixture.post("/fixture/device/expire", async (c) => {
      const { userCode } = await c.req.json();
      await prisma.deviceCode.update({ where: { userCode }, data: { expiresAt: new Date(0) } });
      return c.json({ expired: true });
    });
    fixture.get("/fixture/device/state", async (c) => {
      const userCode = c.req.query("userCode") ?? "";
      const intent = await prisma.deviceApproval.findFirst({
        where: { userCode },
        select: { decision: true, consumedAt: true, selection: true },
      });
      return c.json({ intent });
    });
    const { guardDeviceApproval } = (await import(
      pathToFileURL(join(serverSrc, "device-approval-gate.ts")).href
    )) as {
      guardDeviceApproval(
        request: Request,
        options: {
          baseUrl: string;
          getSession: (input: {
            headers: Headers;
          }) => Promise<{ user: { id: string }; session: { id: string } } | null>;
          service: typeof deviceService;
        },
      ): Promise<Response | null>;
    };
    // Install the same nonce/Origin gate before the provider handler.
    const deviceApp = new Hono();
    deviceApp.all(
      "*",
      async (c) =>
        (await guardDeviceApproval(c.req.raw, {
          baseUrl: options.origin,
          getSession: (input) => mcpAuth.api.getSession(input),
          service: deviceService,
        })) ?? oauthApp.fetch(c.req.raw),
    );
    fixture.get("/fixture/mcp/session", async (c) => {
      const current = await mcpAuth.api.getSession({ headers: c.req.raw.headers });
      return c.json({
        status: "resolved",
        session: current
          ? { user: { ...current.user, createdAt: current.user.createdAt.getTime() } }
          : null,
      });
    });
    fixture.get("/fixture/mcp/start", async (c) => {
      const name = c.req.query("name") ?? "MCP browser app";
      const registration = await oauthHandler(
        new Request(`${options.origin}/api/auth/oauth2/register`, {
          method: "POST",
          headers: { host: new URL(options.origin).host, "content-type": "application/json" },
          body: JSON.stringify({
            client_name: name,
            redirect_uris: ["https://client.invalid/cb"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: "mcp:read offline_access",
          }),
        }),
      );
      if (registration.status !== 201)
        throw new Error(`MCP registration failed: ${registration.status}`);
      const client = (await registration.json()) as { client_id: string };
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "https://client.invalid/cb",
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url"),
        resource: `${options.origin}/mcp`,
        scope: "mcp:read offline_access",
        state: randomUUID(),
      });
      const response = await oauthHandler(
        new Request(`${options.origin}/api/auth/oauth2/authorize?${query}`, {
          headers: c.req.raw.headers,
        }),
      );
      if (response.status !== 302) throw new Error(`MCP authorize failed: ${response.status}`);
      return c.json({
        clientId: client.client_id,
        url: new URL(response.headers.get("location")!, options.origin).href,
      });
    });
    fixture.post("/fixture/mcp/disable-client", async (c) => {
      await prisma.oauthClient.update({
        where: { clientId: c.req.query("clientId") ?? "" },
        data: { disabled: true },
      });
      return c.json({ ok: true });
    });
    fixture.get("/fixture/mcp/state", async (c) => {
      const grants = await prisma.mcpGrant.findMany({
        where: { userId: owner.id },
        select: {
          id: true,
          clientId: true,
          revokedAt: true,
          acl: { take: 300, select: { kbId: true, bits: true } },
          consentIntents: { take: 10, select: { nonce: true, approvedAt: true } },
        },
        take: 100,
      });
      const tokens = await prisma.mcpPersonalToken.findMany({
        where: { userId: owner.id },
        select: { id: true, name: true, revokedAt: true },
        take: 100,
      });
      return c.json({ grants, tokens });
    });

    let inspectionGrantId = "";
    fixture.post("/fixture/mcp/inventory", async (c) => {
      if (c.req.query("replaceTail")) {
        // Model subset reconsent followed by two creator appends between reads:
        // the first 256 rows and total cardinality stay the same.
        await prisma.$transaction(async (tx) => {
          await tx.grantKbAcl.deleteMany({
            where: {
              grantId: inspectionGrantId,
              kbId: { in: [`perm${String(256).padStart(20, "0")}`, "z".repeat(24)] },
            },
          });
          await tx.grantKbAcl.createMany({
            data: ["w", "y"].map((letter) => ({
              grantId: inspectionGrantId,
              kbId: letter.repeat(24),
              bits: ["read"],
            })),
          });
        });
        return c.json({ replaced: true });
      }
      if (c.req.query("append")) {
        await prisma.grantKbAcl.create({
          data: { grantId: inspectionGrantId, kbId: "z".repeat(24), bits: ["read"] },
        });
        return c.json({ kbId: "z".repeat(24) });
      }
      const sharers = await prisma.user.createManyAndReturn({
        data: Array.from({ length: 13 }, () => ({
          name: "ACL owner",
          email: `${randomUUID()}@example.invalid`,
          emailVerified: true,
        })),
        select: { id: true },
      });
      const kbIds = Array.from({ length: 257 }, (_, i) => `perm${String(i).padStart(20, "0")}`);
      const allIds = [...kbIds, "z".repeat(24), "w".repeat(24), "y".repeat(24)];
      await prisma.knowledgeBase.createMany({
        data: allIds.map((id, i) => ({
          id,
          ownerId: i < 256 ? sharers[Math.floor(i / 20)]!.id : owner.id,
          // Unique names: Connected apps shows a readable KB by name, not id.
          name: `Permission fixture ${id}`,
          slug: `p-${id}`,
          description: "Permission inspection fixture",
          state: "ACTIVE",
          headSha: "a".repeat(40),
        })),
      });
      await prisma.kbShare.createMany({
        data: allIds.slice(0, 256).map((kbId) => ({ kbId, userId: owner.id, bits: ["read"] })),
      });
      await prisma.mcpGrant.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          userId: owner.id,
          actorUserIdSnapshot: owner.id,
          kind: "PAT",
          clientId: `old-pat-${i}`,
          referenceId: randomUUID(),
          scopes: ["mcp:read"],
          toolGroups: ["read"],
          createdKbBits: [],
          revokedAt: new Date(),
        })),
      });
      inspectionGrantId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const clientId = "Permission inspection app";
      await prisma.mcpGrant.create({
        data: {
          id: inspectionGrantId,
          userId: owner.id,
          actorUserIdSnapshot: owner.id,
          kind: "OAUTH",
          clientId,
          referenceId: randomUUID(),
          scopes: ["mcp:read", "mcp:write"],
          toolGroups: ["read", "kb_admin"],
          allowCreate: true,
          createdKbBits: ["read"],
          acl: { create: kbIds.map((kbId) => ({ kbId, bits: ["read"] })) },
        },
      });
      return c.json({ clientId, grantId: inspectionGrantId, lastKb: kbIds.at(-1) });
    });

    // Edit access (MCP scoping phase 5): one OAuth app whose stored ACL holds a
    // revoked share, a downgraded share and `fillers` owned KBs (paging past 50).
    const editKb = (prefix: string) => `${prefix}${randomBytes(10).toString("hex")}`;
    fixture.post("/fixture/mcp/edit-scenario", async (c) => {
      const fillers = Number(c.req.query("fillers") ?? "60");
      const bits = c.req.query("bits") === "write" ? ["read", "propose", "write"] : ["read"];
      const sharer = await prisma.user.create({
        data: {
          name: "Edit sharer",
          email: `${randomUUID()}@example.invalid`,
          emailVerified: true,
        },
      });
      const revoked = editKb("edrev");
      const downgraded = editKb("eddwn");
      const filler = Array.from({ length: fillers }, () => editKb("edfil"));
      await prisma.knowledgeBase.createMany({
        data: [revoked, downgraded, ...filler].map((id, i) => ({
          id,
          ownerId: i < 2 ? sharer.id : owner.id,
          name: i === 0 ? "Edit revoked" : i === 1 ? "Edit downgraded" : `Edit filler ${id}`,
          slug: `e-${id}`,
          description: "Edit access fixture",
          state: "ACTIVE",
          headSha: "a".repeat(40),
        })),
      });
      await prisma.kbShare.createMany({
        data: [
          { kbId: revoked, userId: owner.id, bits: ["read"], revokedAt: new Date() },
          { kbId: downgraded, userId: owner.id, bits: ["read"] },
        ],
      });
      const grantId = randomUUID();
      const clientId = `Edit app ${randomUUID()}`;
      await prisma.mcpGrant.create({
        data: {
          id: grantId,
          userId: owner.id,
          actorUserIdSnapshot: owner.id,
          kind: "OAUTH",
          clientId,
          referenceId: randomUUID(),
          scopes: ["mcp:read", "mcp:write"],
          toolGroups: ["read", "edit"],
          createdKbBits: [],
          acl: {
            create: [
              { kbId: revoked, bits: ["read"] },
              { kbId: downgraded, bits: ["read", "propose", "write"] },
              ...filler.map((kbId) => ({ kbId, bits })),
            ],
          },
        },
      });
      return c.json({ grantId, clientId, revoked, downgraded, filler });
    });
    // A KB the agent creates while the Sheet is open (creator append).
    fixture.post("/fixture/mcp/edit-append", async (c) => {
      const grantId = c.req.query("grantId") ?? "";
      const kbId = editKb("edapp");
      await prisma.knowledgeBase.create({
        data: {
          id: kbId,
          ownerId: owner.id,
          name: `Edit appended ${kbId}`,
          slug: `e-${kbId}`,
          description: "Edit access fixture",
          state: "ACTIVE",
          headSha: "a".repeat(40),
        },
      });
      await prisma.grantKbAcl.create({ data: { grantId, kbId, bits: ["read"] } });
      return c.json({ kbId });
    });
    fixture.get("/fixture/mcp/edit-state", async (c) => {
      const grant = await prisma.mcpGrant.findUniqueOrThrow({
        where: { id: c.req.query("grantId") ?? "" },
        select: {
          toolGroups: true,
          widenedAt: true,
          acl: { take: 300, select: { kbId: true, bits: true } },
          elevations: {
            take: 10,
            orderBy: { createdAt: "asc" },
            select: { id: true, toolGroups: true, revokedAt: true, expiresAt: true },
          },
        },
      });
      return c.json(grant);
    });

    const serverRequire = createRequire(join(serverSrc, "../package.json"));
    type FetchHandler = {
      handle(
        request: Request,
        options: { prefix: string; context: unknown },
      ): Promise<{ matched: boolean; response?: Response }>;
    };
    const { RPCHandler } = (await import(
      pathToFileURL(serverRequire.resolve("@orpc/server/fetch")).href
    )) as { RPCHandler: new (router: unknown, options: { plugins: unknown[] }) => FetchHandler };
    const { BatchHandlerPlugin } = (await import(
      pathToFileURL(serverRequire.resolve("@orpc/server/plugins")).href
    )) as { BatchHandlerPlugin: new (options: { maxSize: number }) => unknown };
    const router = async (file: string, name: string) =>
      (
        (await import(pathToFileURL(join(apiSrc, "routers", file)).href)) as Record<string, unknown>
      )[name];
    const rpc = new RPCHandler(
      {
        mcpConsent: await router("mcp-consent.ts", "mcpConsentRouter"),
        mcpTokens: await router("mcp-tokens.ts", "mcpTokensRouter"),
        mcpGrants: await router("mcp-grants.ts", "mcpGrantsRouter"),
        cliCredentials: await router("cli-credentials.ts", "cliCredentialsRouter"),
        kbModel: await router("kb-model.ts", "kbModelRouter"),
        kbs: await router("kbs.ts", "kbsRouter"),
        documents: await router("documents.ts", "documentsRouter"),
        pullRequests: await router("pull-requests.ts", "pullRequestsRouter"),
        kbUploads: await router("kb-uploads.ts", "kbUploadsRouter"),
        kbAssets: await router("kb-assets.ts", "kbAssetsRouter"),
        search: await router("search.ts", "searchRouter"),
        kbMirror: await router("kb-mirror.ts", "kbMirrorRouter"),
        kbExports: await router("kb-exports.ts", "kbExportsRouter"),
        kbIndex: await router("kb-index.ts", "kbIndexRouter"),
        kbSealed: await router("kb-sealed.ts", "kbSealedRouter"),
        embeddingProviders: await router("embedding-providers.ts", "embeddingProvidersRouter"),
      },
      { plugins: [new BatchHandlerPlugin({ maxSize: 10 })] },
    );
    const rpcApp = new Hono();
    rpcApp.all("/rpc/*", async (c) => {
      const realSession = await mcpAuth.api.getSession({ headers: c.req.raw.headers });
      const auth = await session(c.req.raw.headers);
      const user = auth ? await prisma.user.findUnique({ where: { id: auth.user.id } }) : null;
      const context = {
        // Real Better Auth cookie sessions (MCP consent/credentials) win; otherwise
        // fixture users are enrolled in the database, so session and live gates agree.
        session: realSession ?? (user ? { user, session: { userId: user.id } } : null),
      };
      const { matched, response } = await rpc.handle(c.req.raw, {
        prefix: "/rpc",
        context,
      });
      if (
        matched &&
        response?.ok &&
        revokeNextExport &&
        c.req.path.startsWith("/rpc/kbExports/prepare")
      ) {
        revokeNextExport = false;
        await prisma.exportArtifact.updateMany({
          where: { actorKey: `user:${owner.id}`, state: "READY", reclaimedAt: null },
          data: { expiresAt: new Date(0) },
        });
      }
      return matched && response ? response : c.json({ error: "NOT_FOUND" }, 404);
    });
    // R40: fresh real principals and PRs per lifetime/retry scenario. No shared
    // budgets are widened; reads/reviews still pass through production /rpc.
    fixture.post("/fixture/pr/scenario", async (c) => {
      const users = await prisma.user.createManyAndReturn({
        data: ["author", "reviewer"].map((role) => ({
          name: `R40 ${role}`,
          email: `${randomUUID()}@example.invalid`,
          emailVerified: true,
          twoFactorEnabled: true,
        })),
      });
      const authorId = users[0]!.id;
      const reviewerId = users[1]!.id;
      const cookies: Record<string, string> = {};
      for (const [role, userId] of [
        ["author", authorId],
        ["reviewer", reviewerId],
      ]) {
        const row = await prisma.session.create({
          data: {
            userId: userId!,
            token: randomUUID(),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        const cookie = `${row.token}.${createHmac("sha256", authSecret).update(row.token).digest("base64")}`;
        cookies[role!] = cookie;
        // The same real cookie also authenticates fixture-only setup operations.
        sessions.set(cookie, userId!);
      }
      const main = { "index.md": "# R40 index\n", "deleted.md": "# Removed document\n" };
      const head = { "index.md": "# R40 index\n", "added.md": "# Added document\n" };
      const a = await seedPr({
        slug: `r40-a-${randomUUID()}`,
        main,
        head,
        mainAssets: [],
        headAssets: [],
        authorId,
        reviewerId,
      });
      const b = await seedPr({
        slug: `r40-b-${randomUUID()}`,
        main,
        head,
        mainAssets: [],
        headAssets: [],
        authorId,
        reviewerId,
        kb: { id: a.kbId, rev: a.baseSha },
        existingMain: true,
      });
      const other = await seedPr({
        slug: `r40-other-${randomUUID()}`,
        main,
        head,
        mainAssets: [],
        headAssets: [],
        authorId,
        reviewerId,
      });
      return c.json({ a, b, other, cookies, authorId, reviewerId });
    });
    const editorManagers = new Map<string, string>();
    // Isolate each scenario's principals and real rate budgets instead of
    // exhausting the shared fixture owner or changing any production budget.
    fixture.post("/fixture/editor/actors", async (c) => {
      await principalOf(c.req.raw.headers);
      const editorOwner = await settingsUser("editor-owner");
      const editorManager = await settingsUser("editor-manager");
      const ownerCookie = randomBytes(32).toString("base64url");
      const managerCookie = randomBytes(32).toString("base64url");
      sessions.set(ownerCookie, editorOwner.id);
      sessions.set(managerCookie, editorManager.id);
      editorManagers.set(editorOwner.id, editorManager.id);
      return c.json({
        cookies: { owner: ownerCookie, manager: managerCookie },
        managerUserId: editorManager.id,
        managerEmail: editorManager.email,
      });
    });
    // Test-only setup for the editor/access-loss regressions. The KB still
    // enters through the real create router, and all reads/replays use real RPC.
    fixture.post("/fixture/editor/share", async (c) => {
      const kbId = c.req.query("kbId") ?? "";
      const principal = await principalOf(c.req.raw.headers);
      await authorize({ store, principal, kbId, operation: "manage" });
      await prisma.kbShare.create({
        data: {
          kbId,
          userId: editorManagers.get(principal.userId) ?? manager.id,
          bits:
            c.req.query("writer") === "1"
              ? ["read", "propose", "write"]
              : c.req.query("proposer") === "1"
                ? ["read", "propose"]
                : ["read", "manage"],
        },
      });
      // Public fixture key only: no deploy secret and no queued network work.
      const publicKey = `ssh-ed25519 ${Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        randomBytes(32),
      ]).toString("base64")}`;
      await prisma.kbRemote.create({ data: { kbId, state: "PENDING" } });
      const key = await prisma.deployKeyVersion.create({
        data: {
          kbId,
          keyVersion: 1,
          remoteVersion: 0,
          url: "ssh://git@private-r38.example/team/private.git",
          hostKeys: [publicKey],
          publicKey,
          fingerprint: "SHA256:fixture-public-key",
          createdBy: principal.userId,
        },
      });
      await prisma.kbRemote.update({ where: { kbId }, data: { pendingKeyId: key.id } });
      return c.json({ ok: true });
    });
    fixture.post("/fixture/editor/expire-upload", async (c) => {
      const kbId = c.req.query("kbId") ?? "";
      const principal = await principalOf(c.req.raw.headers);
      await authorize({ store, principal, kbId, operation: "manage" });
      await prisma.stagedUpload.updateMany({
        where: { kbId, state: { in: ["WRITING", "READY", "CONSUMED"] } },
        data: { expiresAt: new Date(0), readyExpiresAt: new Date(0) },
      });
      return c.json({ ok: true });
    });
    fixture.post("/fixture/settings/model-admin", async (c) => {
      const request = await c.req.json().catch(() => ({}));
      const budgetMiB = request.budgetMiB === 512 ? 512 : 4096;
      const adminUser = await prisma.user.update({
        where: { id: owner.id },
        data: { role: "admin", twoFactorEnabled: true },
      });
      const { recordWorkerMemoryBudget } = await import("@knowledge-base/api/lib/kb/local-model");
      await recordWorkerMemoryBudget(
        { connectionString: db.urls.runtime },
        {
          budgetBytes: budgetMiB * 1024 ** 2,
          availableBytes: budgetMiB * 1024 ** 2,
          source: "cgroup-v2",
        },
      );
      return c.json({ ok: true, role: adminUser.role });
    });
    fixture.post("/fixture/settings/model-user", async (c) => {
      await prisma.user.update({ where: { id: owner.id }, data: { role: "user" } });
      return c.json({ ok: true });
    });
    fixture.get("/fixture/settings/state", async (c) => {
      const kbId = c.req.query("kbId") ?? "";
      const kb = await prisma.knowledgeBase.findUnique({
        where: { id: kbId },
        select: { ownerId: true, metadataVersion: true },
      });
      const members = await prisma.kbShare.findMany({
        where: { kbId, revokedAt: null },
        select: { userId: true, bits: true },
        take: 50,
      });
      return c.json({ ...kb, members });
    });
    // Another session revokes the provider while this page's probe is still pending.
    fixture.post("/fixture/settings/revoke-provider", async (c) => {
      await revokeProvider(runtime, owner.id, { providerId: c.req.query("providerId") ?? "" });
      return c.json({ ok: true });
    });
    // Stands in for the worker's successful probe of one exact revision.
    fixture.post("/fixture/settings/provider-ready", async (c) => {
      const revision = await prisma.providerRevision.findFirst({
        where: {
          providerId: c.req.query("providerId") ?? "",
          version: Number(c.req.query("revision")),
        },
        select: { jobId: true },
      });
      if (!revision) return c.json({ error: "NOT_FOUND" }, 404);
      await prisma.durableJob.update({
        where: { id: revision.jobId },
        data: { state: "COMPLETE", completedAt: new Date() },
      });
      return c.json({ ok: true });
    });
    // The built-in model row is an instance-wide singleton the admin model
    // panel specs also read. builtin-ready records what it replaced so
    // builtin-reset can restore it and later specs see the state they seeded.
    let builtinSnapshot:
      | { row: Awaited<ReturnType<typeof prisma.localModel.findUnique>> }
      | undefined;
    fixture.post("/fixture/settings/builtin-reset", async (c) => {
      const { QWEN_ARTIFACT } = await import("@knowledge-base/api/lib/kb/model-artifact");
      if (!builtinSnapshot) return c.json({ ok: true, restored: false });
      const { row } = builtinSnapshot;
      builtinSnapshot = undefined;
      if (row) {
        const { id, configError, ...data } = row;
        await prisma.localModel.update({
          where: { id },
          data: configError === null ? data : { ...data, configError },
        });
        if (configError === null)
          await prisma.$executeRaw`UPDATE kb_local_model SET "configError" = NULL WHERE id = ${id}`;
      } else await prisma.localModel.deleteMany({ where: { id: QWEN_ARTIFACT.modelId } });
      return c.json({ ok: true, restored: true });
    });
    // Simulates completed artifact/runtime verification without loading a model:
    // picker/list/attachment still execute the production SQL and RPC boundaries.
    fixture.post("/fixture/settings/builtin-ready", async (c) => {
      const { QWEN_ARTIFACT } = await import("@knowledge-base/api/lib/kb/model-artifact");
      const { QWEN_MODEL } = await import("@knowledge-base/api/lib/kb/builtin-model");
      const { builtinModelIdentity } = await import("@knowledge-base/api/lib/kb/fingerprint");
      const { DEFAULT_QWEN_RUNTIME_CONFIG } = await import(
        "@knowledge-base/api/lib/kb/qwen-runtime-config"
      );
      const { ensureSystemBuiltinProvider, SYSTEM_BUILTIN_PROVIDER_ID } = await import(
        "@knowledge-base/api/lib/kb/local-model"
      );
      builtinSnapshot ??= {
        row: await prisma.localModel.findUnique({ where: { id: QWEN_ARTIFACT.modelId } }),
      };
      const job = await prisma.durableJob.create({
        data: {
          kind: "DOWNLOAD_MODEL",
          desired: {},
          dedupKey: randomUUID(),
          state: "COMPLETE",
        },
      });
      const data = {
        state: "READY" as const,
        modelId: QWEN_MODEL.modelId,
        runtimeIdentity: builtinModelIdentity(QWEN_MODEL),
        ...DEFAULT_QWEN_RUNTIME_CONFIG,
        jobId: job.id,
      };
      await prisma.localModel.upsert({
        where: { id: QWEN_ARTIFACT.modelId },
        create: { id: QWEN_ARTIFACT.modelId, ...data },
        update: data,
      });
      const revision = await runtime.coordinator.run({
        opId: randomUUID(),
        kind: "authority",
        run: ({ lease }) =>
          lease.transaction((query) =>
            ensureSystemBuiltinProvider(
              query,
              job.id,
              DEFAULT_QWEN_RUNTIME_CONFIG,
              QWEN_ARTIFACT.modelId,
            ),
          ),
      });
      return c.json({ providerId: SYSTEM_BUILTIN_PROVIDER_ID, revision });
    });

    return {
      data: {
        origin: options.origin,
        attackerOrigin: attacker.origin,
        cookie: { name: KB_BROWSER_COOKIE, value: sessionValue },
        kbId: kb.id,
        otherKbId: other.id,
        oldRev: old.rev,
        headRev: head.rev,
        mediaPath,
        hostilePath,
        hashes: {
          png: entries[0]!.hash,
          mp4: entries[1]!.hash,
          wav: entries[2]!.hash,
          other: otherEntry.hash,
        },
        pr: {
          cookies: { author: cookieFor(author.id), reviewer: cookieFor(reviewer.id) },
          docPath: prDocPath,
          review: {
            ...reviewPr,
            hashes: {
              picBefore: pic.hash,
              picAfter: picAfter.hash,
              clip: clip.hash,
              sound: sound.hash,
            },
          },
          conflict: conflictPr,
          large: { ...largePr, count: LARGE },
          close: closePr,
        },
        mcp: { cookie: mcpCookie, userId: owner.id },
        settings: {
          cookies: {
            owner: sessionValue,
            known: cookieFor(known.id),
            member: cookieFor(member.id),
            manager: cookieFor(manager.id),
          },
          ownerUserId: owner.id,
          knownUserId: known.id,
          knownEmail: known.email,
          unknownEmail: `nobody-${randomUUID()}@example.invalid`,
          memberUserId: member.id,
          managerUserId: manager.id,
          sealedConsumerGrantId,
          kbId: settingsKb.id,
          transferKbId: transferKb.id,
          editor: { kbId: editorKb.id, path: "notes/draft.md", pngHash: editorPng.hash },
        },
      },
      async handle(req, res) {
        const path = (req.url ?? "/").split("?")[0]!;
        const target = path.startsWith("/fixture/")
          ? fixture
          : path.startsWith("/api/auth/")
            ? deviceApp
            : path.startsWith("/rpc/")
              ? rpcApp
              : path.startsWith("/kb-assets/") || path.startsWith("/kb-exports/")
                ? app
                : null;
        if (!target) return false;
        await send(res, await target.fetch(await toRequest(req, options.origin)));
        return true;
      },
      attackerHits: attacker.hits,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "browser data setup and cleanup failed");
    }
    throw error;
  }
}
