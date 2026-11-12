import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { hardenedGitEnv, kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import type { LiveAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { prismaAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import { setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import { digestPatSecret, generatePatSecret } from "@knowledge-base/api/lib/mcp-token-access";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openKbPostgresClusterFromEnv } from "./postgres";

type Actor = { principal: TokenPrincipal; verifier: CredentialVerifier; recheck(): Promise<void> };
const { createGitHttp } = (await import(
  new URL("../../../../apps/server/src/git-http.ts", import.meta.url).href
)) as {
  createGitHttp(options: {
    reposDir: string;
    admit(request: Request): Promise<Actor>;
    store: LiveAuthorityStore;
    retainedRefs(id: string): Promise<string[]>;
  }): { app: Hono; close(): Promise<void> };
};
const { createBearerAdmission } = (await import(
  new URL("../../../../apps/server/src/mcp/auth.ts", import.meta.url).href
)) as {
  createBearerAdmission(options: {
    query: LockQuery;
    origin: string;
  }): (request: Request) => Promise<Actor>;
};
const { serve } = (await import(
  new URL("../../../../apps/server/node_modules/@hono/node-server/dist/index.mjs", import.meta.url)
    .href
)) as {
  serve(
    options: { fetch: Hono["fetch"]; hostname: string; port: number },
    callback: (info: { port: number }) => void,
  ): Server;
};
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const prisma = db.createPrismaClient();
const reposDir = join(process.env.KB_DATA_ROOT!, "repos");
const id = "a123456789012345678901234";
const repo = kbBareRepoPath(reposDir, id);
const clone = join(reposDir, "clone");
const token = generatePatSecret();
const tokenId = "a234567890123456789012345";
const grantId = randomUUID();
let first = "";
let hidden = "";
let url = "";
let server: Server;
let endpoint: ReturnType<typeof createGitHttp>;
let retained = ["refs/heads/main"];
const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, {
    cwd,
    env: hardenedGitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const client = promisify(execFile);
const auth = () => `Basic ${Buffer.from(`ignored:${token.secret}`).toString("base64")}`;
async function remote(args: string[]) {
  return client("git", ["-c", `http.extraHeader=Authorization: ${auth()}`, ...args], {
    cwd: reposDir,
    env: hardenedGitEnv(),
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}
function commit(message: string, parent?: string) {
  const tree = git(["mktree"]);
  return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
}
beforeAll(async () => {
  await mkdir(repo);
  git(["init", "--bare", "--initial-branch=main"]);
  first = commit("first");
  hidden = commit("private hidden history");
  git(["update-ref", "refs/heads/main", first]);
  for (const ref of ["refs/tags/secret", "refs/heads/unowned", `refs/replace/${first}`])
    git(["update-ref", ref, hidden]);
  setKbRecoveryComplete(true);
  const owner = await prisma.user.create({
    data: { name: "Git test", email: `${randomUUID()}@example.invalid`, twoFactorEnabled: true },
  });
  await prisma.knowledgeBase.create({
    data: {
      id,
      ownerId: owner.id,
      name: "Git test",
      slug: "git-test",
      description: "Git transport test",
      state: "ACTIVE",
      headSha: first,
    },
  });
  await prisma.mcpGrant.create({
    data: {
      id: grantId,
      actorUserIdSnapshot: owner.id,
      userId: owner.id,
      kind: "PAT",
      clientId: `pat:${tokenId}`,
      referenceId: "pat",
      scopes: ["mcp:read"],
      // `edit` lets receive-pack reach its "push not configured" boundary.
      toolGroups: ["read", "edit"],
      createdKbBits: [],
      acl: { create: { kbId: id, bits: ["read"] } },
    },
  });
  // Resource is canonical and independent of the ephemeral HTTP listen port.
  const origin = "http://git.example.invalid";
  await prisma.mcpPersonalToken.create({
    data: {
      id: tokenId,
      userIdSnapshot: owner.id,
      userId: owner.id,
      name: "fixture",
      lookupPrefix: token.lookupPrefix,
      secretDigest: digestPatSecret(token.secret),
      grantId,
      scopes: ["mcp:read"],
      resource: `${origin}/mcp`,
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  endpoint = createGitHttp({
    reposDir,
    admit: createBearerAdmission({ query: prismaAssetQuery(prisma), origin }),
    store: prismaAuthorityStore(prisma),
    retainedRefs: async () => retained,
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: endpoint.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      url = `http://127.0.0.1:${info.port}/git/${id}.git`;
      resolve();
    });
  });
});
afterAll(async () => {
  await endpoint?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
  for (const path of [repo, clone]) await rm(path, { recursive: true, force: true });
});
describe("git-http real PAT/HTTP/Git/supervisor", () => {
  it("clones and fetches exact commits without replace/tag/unowned exposure", async () => {
    await remote(["clone", url, clone]);
    expect(git(["rev-parse", "HEAD"], clone)).toBe(first);
    expect(git(["log", "-1", "--format=%s"], clone)).toBe("first");
    const refs = (await remote(["ls-remote", url])).stdout;
    expect(refs).not.toContain("secret");
    expect(refs).not.toContain("unowned");
    expect(refs).not.toContain("replace");
    const next = commit("second", first);
    git(["update-ref", "refs/heads/main", next]);
    await remote(["-C", clone, "fetch", "origin"]);
    expect(git(["rev-parse", "origin/main"], clone)).toBe(next);
    await expect(remote(["-C", clone, "fetch", "origin", hidden])).rejects.toThrow();
  });
  it("advertises many retained branches through the native supervisor and still hides the rest", async () => {
    // Each retained ref adds a Git config env entry; the supervisor once capped the
    // environment at 64 entries, which refused even a main-only read.
    const branches = Array.from(
      { length: 60 },
      (_, i) => `refs/heads/agent-${String(i).padStart(2, "0")}/topic-branch-name`,
    );
    for (const ref of branches) git(["update-ref", ref, first]);
    retained = ["refs/heads/main", ...branches];
    try {
      const refs = (await remote(["ls-remote", url])).stdout;
      for (const ref of branches) expect(refs).toContain(ref);
      expect(refs).not.toContain("secret");
      expect(refs).not.toContain("unowned");
      expect(refs).not.toContain("replace");
    } finally {
      retained = ["refs/heads/main"];
      for (const ref of branches) git(["update-ref", "-d", ref]);
    }
  });
  it("rejects cookies and JWT passwords and leaves refs unchanged on receive-pack", async () => {
    for (const headers of [
      { cookie: "better-auth.session_token=fixture" },
      { authorization: `Basic ${Buffer.from("u:eyJ.jwt.signature").toString("base64")}` },
    ]) {
      expect((await fetch(`${url}/info/refs?service=git-upload-pack`, { headers })).status).toBe(
        401,
      );
    }
    const before = git(["show-ref"]);
    const response = await fetch(`${url}/git-receive-pack`, {
      method: "POST",
      headers: { authorization: auth(), "content-type": "application/x-git-receive-pack-request" },
      body: "0000",
    });
    expect(response.status).toBe(501);
    expect(git(["show-ref"])).toBe(before);
  });
  it("stops a real supervised pack between frames after revocation", async () => {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      env: hardenedGitEnv(),
      input: randomBytes(1024 * 1024).toString("base64"),
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["mktree"], {
      cwd: repo,
      env: hardenedGitEnv(),
      input: `100644 blob ${blob}\tlarge.md\n`,
      encoding: "utf8",
    }).trim();
    const sha = git(["commit-tree", tree, "-p", first, "-m", "large stream"]);
    git(["update-ref", "refs/heads/main", sha]);
    const want = `want ${sha} side-band-64k ofs-delta\n`;
    const body = `${(Buffer.byteLength(want) + 4).toString(16).padStart(4, "0")}${want}00000009done\n`;
    const response = await endpoint.app.request(`${url}/git-upload-pack`, {
      method: "POST",
      headers: { authorization: auth(), "content-type": "application/x-git-upload-pack-request" },
      body,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBeLessThanOrEqual(256 * 1024);
    await prisma.mcpGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } });
    await expect(reader.read()).rejects.toThrow();
  });
  it("live grant revocation denies subsequent discovery", async () => {
    await prisma.mcpGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } });
    expect(
      (
        await fetch(`${url}/info/refs?service=git-upload-pack`, {
          headers: { authorization: auth() },
        })
      ).status,
    ).toBe(401);
  });
  it("runtime image asserts the installed Git CGI executable", async () => {
    const dockerfile = await readFile(new URL("../../../../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile.slice(dockerfile.indexOf("FROM base AS runner"))).toMatch(
      /test -x.*git-http-backend/,
    );
    const execPath = git(["--exec-path"]);
    expect(execFileSync("test", ["-x", join(execPath, "git-http-backend")]).length).toBe(0);
  });
});
