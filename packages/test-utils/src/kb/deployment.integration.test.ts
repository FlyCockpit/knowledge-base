/** Packaged deployment acceptance: runtime code comes only from built images. */
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { minimalPng } from "@knowledge-base/api/lib/kb/fixtures/media-bytes";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KbPostgresDatabase, openKbPostgresClusterFromEnv } from "./postgres.js";
import { createSshFixture } from "./ssh.js";

const execute = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../../../..");
const project = `${process.env.KB_TEST_PROJECT}-deployment`;
// Docker publishes through the first network by name; retain the fixture default.
const network = `${process.env.KB_TEST_PROJECT}_z-deployment`;
const authSecret = randomBytes(32).toString("hex");
const masterKey = randomBytes(32).toString("base64");
const images = {
  server: process.env.KB_TEST_DEPLOYMENT_SERVER_IMAGE!,
  worker: process.env.KB_TEST_DEPLOYMENT_WORKER_IMAGE!,
};
let scratch: string;
let file: string;
let origin: string;
let cookie: string;
let db: KbPostgresDatabase;
let prisma: ReturnType<KbPostgresDatabase["createPrismaClient"]>;
let cluster: Awaited<ReturnType<typeof openKbPostgresClusterFromEnv>>;
let ssh: Awaited<ReturnType<typeof createSshFixture>>;
let postgres: string;
let redis: string;
let serverContainer: string;
let fixtureIp: string;
let readySetup: Promise<void>;
let serverServiceName = "server";
let started = false;
let networkCreated = false;

function redact(text: string, secrets: string[] = []) {
  let out = text;
  for (const secret of [authSecret, masterKey, ...secrets])
    if (secret) out = out.replaceAll(secret, "[redacted]");
  return out
    .replace(/\bkbp_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(authorization:\s*(?:basic|bearer)\s+)\S+/gi, "$1[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database URL]");
}
/** Exit status of a failed child, never its argv/env (they may carry credentials). */
function exitStatus(error: unknown) {
  const code = Reflect.get(Object(error), "code");
  const signal = Reflect.get(Object(error), "signal");
  const killed = Reflect.get(Object(error), "killed") === true;
  return `exit=${String(code ?? "none")} signal=${String(signal ?? "none")}${killed ? " killed (deadline)" : ""}`;
}
async function docker(args: string[], timeout = 60_000) {
  // Compose supplies its own ownership label. Plain runs need explicit ownership,
  // including CLI probes that may remain in Created after a daemon deadline.
  if (args[0] === "run")
    args = [
      args[0],
      "--label",
      `io.knowledge-base.test-project=${process.env.KB_TEST_PROJECT}`,
      ...args.slice(1),
    ];
  try {
    return (await execute("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    const text = String(Reflect.get(Object(error), "stderr") ?? "");
    // Never attach argv/env: this run uses disposable keys, but keeps secret hygiene.
    // A deadline kill leaves stderr empty; the status still says what happened.
    throw new Error(
      redact(
        `Docker ${args[0] === "compose" ? "compose" : args[0]} failed (${exitStatus(error)})${text ? `: ${text}` : ""}`,
      ),
    );
  }
}
async function compose(...args: string[]) {
  return docker(
    [
      "compose",
      "--project-directory",
      ROOT,
      "-p",
      project,
      "-f",
      file,
      ...args.map((arg) => (arg === "server" ? serverServiceName : arg)),
    ],
    180_000,
  );
}
async function id(role: string) {
  return compose("ps", "-aq", role);
}
async function inImage(role: string, script: string) {
  return docker(["exec", await id(role), "node", "--input-type=module", "-e", script]);
}
async function eventually(check: () => Promise<boolean>, message: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await delay(1500);
  }
  throw new Error(message);
}
async function ready() {
  try {
    const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as { ok: boolean; checks: { workers: boolean } };
    return { status: response.status, ...body };
  } catch {
    return { status: 0, ok: false, checks: { workers: false } };
  }
}
async function waitReady() {
  try {
    await eventually(
      async () => {
        // Docker can reassign an ephemeral published port when this container restarts.
        const port = (await docker(["port", serverContainer, "3000/tcp"], 5000))
          .split("\n")[0]
          ?.split(":")
          .at(-1);
        origin = `http://127.0.0.1:${port}`;
        return (await ready()).ok;
      },
      "Packaged deployment never became ready",
      120_000,
    );
  } catch (error) {
    console.error(await ready());
    console.error(redact(await compose("logs", "--no-color", "--tail", "25", "server", "worker")));
    throw error;
  }
}
// Native HTTP preserves the proxy's public Host; fetch replaces it with loopback.
function publicPost(
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}${path}`,
      {
        method: "POST",
        headers: { ...headers, host: "deployment.example.invalid" },
        signal: AbortSignal.timeout(65_000),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
async function rpc<T>(name: string, input: unknown): Promise<T> {
  const response = await publicPost(
    `/rpc/${name}`,
    {
      "content-type": "application/json",
      "x-csrf-token": "orpc",
      cookie,
      origin: "https://deployment.example.invalid",
    },
    JSON.stringify({ json: input }),
  );
  const body = (await response.json()) as { json: T };
  const message = response.status === 200 ? "" : Reflect.get(Object(body.json), "message");
  expect(response.status, `${name}: ${String(message ?? "")}`).toBe(200);
  return body.json;
}
async function mint(bits?: { kbId: string; bits: string[] }[]) {
  return rpc<{ secret: string }>("mcpTokens/create", {
    name: "Deployment fixture",
    scopes: ["mcp:read", "mcp:write"],
    toolGroups: [...MCP_TOOL_GROUPS],
    acl: bits ?? [],
    allowCreate: !bits,
    createdKbBits: bits ? [] : ["read", "manage"],
    expiresAt: null,
  });
}
async function tool<T>(token: string, name: string, args: unknown): Promise<T> {
  const response = await publicPost(
    "/mcp",
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": "2026-07-28",
    },
    JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "deployment-integration", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  );
  const body = (await response.json()) as {
    error?: { code: number; message: string };
    result: { isError: boolean; structuredContent: { data: T; error?: { code: string } } };
  };
  expect(response.status, `${name}: ${body.error?.message ?? ""}`).toBe(200);
  expect(body.error, name).toBeUndefined();
  expect(body.result.isError, `${name}: ${body.result.structuredContent.error?.code ?? ""}`).toBe(
    false,
  );
  return body.result.structuredContent.data;
}
const key = () => randomUUID();
const internal = (url: string) => {
  const parsed = new URL(url);
  parsed.hostname = "postgres";
  parsed.port = "5432";
  return parsed.href;
};

describe("built deployment runtime graph", { concurrent: false }, () => {
  beforeAll(() => {
    readySetup = (async () => {
      for (const image of Object.values(images)) {
        if (!image) throw new Error("deployment requires built image names from pnpm test:kb");
        await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
      }
      // Exercise the real CLI and its dependency resolution before any schema/network wait.
      for (const role of ["server", "worker"] as const) {
        const help = await docker([
          "run",
          "--rm",
          "--entrypoint",
          "node",
          images[role]!,
          "/app/packages/db/node_modules/prisma/build/index.js",
          "migrate",
          "diff",
          "--help",
        ]);
        expect(help).toContain("--from-empty");
      }
      scratch = await mkdtemp(join(tmpdir(), "kb-deployment-"));
      cluster = await openKbPostgresClusterFromEnv();
      db = await cluster.createDatabase();
      // Preserve the official roles; isolate fixture resources, images and disposable env.
      const yaml = (
        await execute(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            "import { generateDokployCompose } from './scripts/generate-dokploy-config.ts'; console.log(generateDokployCompose({ environment:'development', gitRef:'main', url:'https://deployment.example.invalid' }));",
          ],
          { cwd: ROOT, env: { PATH: process.env.PATH }, timeout: 30_000 },
        )
      ).stdout;
      const source = join(scratch, "generated.yml");
      await writeFile(source, yaml);
      const config = JSON.parse(
        (
          await execute(
            "docker",
            ["compose", "--env-file", "/dev/null", "-f", source, "config", "--format", "json"],
            {
              env: { PATH: process.env.PATH },
              timeout: 30_000,
            },
          )
        ).stdout,
      ) as {
        services: Record<
          string,
          {
            build?: unknown;
            image?: string;
            environment: Record<string, string>;
            depends_on?: unknown;
            networks?: unknown;
            ports?: unknown;
            volumes?: unknown[];
            labels?: unknown;
            command?: string[];
            healthcheck?: unknown;
          }
        >;
        networks: unknown;
        volumes: Record<string, { name: string }>;
      };
      serverServiceName =
        Object.keys(config.services).find((key) => key.endsWith("-server")) ?? "server";
      for (const [name, volume] of Object.entries(config.volumes)) {
        volume.name = `${project}-${name}`;
      }
      postgres = (
        await execute("docker", [
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${process.env.KB_TEST_PROJECT}`,
          "--filter",
          "label=com.docker.compose.service=postgres",
        ])
      ).stdout.trim();
      expect(postgres).toMatch(/^[0-9a-f]+$/);
      // A routed global-unicast address on an isolated bridge exercises real egress
      // validation without a test-only bypass or a request to a real provider.
      const octets = randomBytes(2);
      const subnet = `11.${octets[0]}.${octets[1]}`;
      fixtureIp = `${subnet}.10`;
      await docker(["network", "create", "--subnet", `${subnet}.0/24`, network]);
      networkCreated = true;
      await docker(["network", "connect", "--alias", "postgres", network, postgres]);
      delete config.services.postgres;
      // Redis belongs to this graph so replacement executes Compose's real boundary.
      config.services.redis = {
        image:
          "valkey/valkey:9.1.3-trixie@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7",
        environment: {},
        networks: ["default"],
        command: ["valkey-server", "--maxmemory-policy", "noeviction"],
        healthcheck: { test: ["CMD", "valkey-cli", "ping"] },
      };
      config.networks = { default: { name: network, external: true } };
      for (const role of ["server", "worker"] as const) {
        const service = config.services[role === "server" ? serverServiceName : role]!;
        delete service.build;
        delete service.depends_on;
        delete service.labels;
        service.networks = ["default"];
        service.image = images[role];
        service.environment = {
          ...service.environment,
          DATABASE_URL: internal(db.urls.applier),
          MIGRATE_ON_START: role === "server" ? "true" : "false",
          REDIS_URL: "redis://redis:6379",
          BACKUP_ENABLED: "false",
          KB_MASTER_KEY: masterKey,
          NODE_EXTRA_CA_CERTS: "/fixture-ca.crt",
          ...(role === "server"
            ? {
                BETTER_AUTH_SECRET: authSecret,
                ADMIN_EMAIL: "operator@example.invalid",
                SIGNUP_ENABLED: "false",
              }
            : {}),
        };
        if (role === "server") service.ports = ["127.0.0.1::3000"];
      }
      // HTTPS fixture certificate is a disposable trust input, not runtime source.
      await execute("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=deployment-fixture",
        "-addext",
        `subjectAltName=IP:${fixtureIp}`,
        "-keyout",
        join(scratch, "tls.key"),
        "-out",
        join(scratch, "tls.crt"),
      ]);
      for (const role of ["server", "worker"])
        config.services[role === "server" ? serverServiceName : role]!.volumes!.push({
          type: "bind",
          source: join(scratch, "tls.crt"),
          target: "/fixture-ca.crt",
          read_only: true,
        });
      file = join(scratch, "compose.json");
      await writeFile(file, JSON.stringify(config));
      started = true;
      // The worker waits with a registry identity before the server applies
      // committed migrations. No one-shot schema service participates.
      await compose("up", "-d", "--no-build", "redis", "worker");
      await compose("up", "-d", "--no-build", "server");
      serverContainer = await id("server");
      await eventually(
        async () =>
          (
            await db.query(
              "applier",
              `SELECT to_regclass('public._knowledge_base_instance') AS registry`,
            )
          ).rows[0]?.registry !== null,
        "Server did not apply migrations",
        120_000,
      );
      await eventually(
        async () =>
          (
            await db.query(
              "applier",
              `SELECT count(*)::int AS n FROM _knowledge_base_instance WHERE schema_level='0_init' AND ready_at IS NOT NULL`,
            )
          ).rows[0]?.n === 2,
        "Server and worker did not become ready",
        120_000,
      );
      prisma = db.createPrismaClient();
      const user = await prisma.user.create({
        data: {
          name: "Deployment operator",
          email: "fixture@example.invalid",
          emailVerified: true,
          role: "user",
        },
      });
      const session = await prisma.session.create({
        data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) },
      });
      cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${createHmac("sha256", authSecret).update(session.token).digest("base64")}`)}`;
      await compose("up", "-d", "--no-build", "redis", "server", "worker");
      redis = await id("redis");
      serverContainer = await id("server");
      const port = (await compose("port", "server", "3000")).split(":").at(-1);
      origin = `http://127.0.0.1:${port}`;
      await waitReady();
      ssh = await createSshFixture();
      await docker(["network", "connect", "--ip", fixtureIp, network, ssh.name]);
      await docker(["cp", join(scratch, "tls.key"), `${ssh.name}:/fixture/tls.key`]);
      await docker(["cp", join(scratch, "tls.crt"), `${ssh.name}:/fixture/tls.crt`]);
      await docker([
        "exec",
        "-d",
        ssh.name,
        "node",
        "--input-type=module",
        "-e",
        `import https from 'node:https'; import fs from 'node:fs'; https.createServer({key:fs.readFileSync('/fixture/tls.key'),cert:fs.readFileSync('/fixture/tls.crt')}, async (req,res)=>{let raw='';for await(const b of req)raw+=b;const input=JSON.parse(raw).input;fs.appendFileSync('/fixture/embeddings','request\\n');const texts=Array.isArray(input)?input:[input];res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:texts.map((_,index)=>({index,embedding:[1,0,0]}))}));}).listen(443,'0.0.0.0');`,
      ]);
    })();
    return readySetup;
  }, 300_000);

  afterAll(async () => {
    await readySetup?.catch(() => {});
    const errors: unknown[] = [];
    const clean = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        errors.push(error);
      }
    };
    if (ssh)
      await clean(async () => {
        // The owner confirms container removal before deleting its key mount.
        await ssh.close();
        await expect(access(ssh.directory)).rejects.toMatchObject({ code: "ENOENT" });
      });
    if (started) {
      // This graph has a unique per-run project; remove only its mounted volumes.
      const volumes = new Set<string>();
      await clean(async () => {
        for (const volume of (
          await docker([
            "volume",
            "ls",
            "-q",
            "--filter",
            `label=com.docker.compose.project=${project}`,
          ])
        )
          .split(/\s+/)
          .filter(Boolean))
          volumes.add(volume);
        for (const id of (await compose("ps", "-aq")).trim().split(/\s+/).filter(Boolean))
          for (const mount of JSON.parse(
            await docker(["inspect", "--format", "{{json .Mounts}}", id]),
          ) as Array<{ Type: string; Name: string }>)
            if (mount.Type === "volume") volumes.add(mount.Name);
      });
      await clean(() => compose("down", "--remove-orphans", "--timeout", "10"));
      for (const volume of volumes) await clean(() => docker(["volume", "rm", volume]));
    }
    if (prisma) await clean(() => prisma.$disconnect());
    if (cluster) await clean(() => cluster.close());
    if (networkCreated) {
      for (const container of [postgres])
        if (container) await clean(() => docker(["network", "disconnect", network, container]));
      await clean(() => docker(["network", "rm", network]));
    }
    if (scratch) await clean(() => rm(scratch, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, "Deployment cleanup failed");
  }, 300_000);

  it("boots the empty instance with image-owned artifacts, nonroot mounts and no client key", async () => {
    expect(await ready()).toMatchObject({ status: 200, ok: true, checks: { workers: true } });
    // One data volume, read-write for both roles (decision 19).
    for (const role of ["server", "worker"]) {
      const mounts = JSON.parse(
        await docker(["inspect", await id(role), "--format", "{{json .Mounts}}"]),
      ) as { Destination: string; RW: boolean; Type: string }[];
      expect(
        mounts
          .filter((m) => m.Destination.startsWith("/var/lib/knowledge-base"))
          .map((m) => [m.Destination, m.RW, m.Type]),
      ).toEqual([["/var/lib/knowledge-base", true, "volume"]]);
    }
    for (const role of ["server", "worker"]) {
      const info = await inImage(
        role,
        `import fs from 'node:fs'; console.log(JSON.stringify({uid:process.getuid(),version:process.versions.node,secret:process.env.KB_MASTER_KEY.length}));`,
      );
      expect(JSON.parse(info)).toMatchObject({ uid: 1000, secret: 44 });
      expect(JSON.parse(info).version).toMatch(/^26\./);
      const binding = JSON.parse(
        await docker(["inspect", await id(role), "--format", "{{json .Mounts}}"]),
      ) as { Destination: string; Type: string; Name?: string }[];
      expect(binding.some((m) => m.Destination === "/app")).toBe(false);
      for (const mount of binding.filter((m) => m.Type === "volume")) {
        expect(mount.Name?.startsWith(`${project}-`)).toBe(true);
      }
    }
    expect(
      await inImage(
        "server",
        `import fs from 'node:fs'; function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const n=p+'/'+e.name;if(e.isDirectory())walk(n);else if(fs.readFileSync(n).includes(process.env.KB_MASTER_KEY))throw Error('client key');}}walk('/app/apps/web/dist/client');console.log('client clean');`,
      ),
    ).toBe("client clean");
    // The worker writes the data volume (index/ is its build output surface).
    expect(
      await inImage(
        "worker",
        `import fs from 'node:fs';const p='/var/lib/knowledge-base/index/worker-write';fs.writeFileSync(p,'x');fs.unlinkSync(p);console.log('written')`,
      ),
    ).toBe("written");
    expect(
      await inImage(
        "worker",
        `import fs from 'node:fs';const s=fs.statSync('/run/kb-mirror');console.log(s.uid+':'+(s.mode&511).toString(8)+':'+fs.statfsSync('/run/kb-mirror').type);`,
      ),
    ).toBe(`1000:700:${0x01021994}`);
  });

  it("creates, proposes, merges, clones/pushes, stages media/exports and searches through the built worker", async () => {
    const owner = await mint();
    const made = await tool<{ kb: { id: string; headSha: string } }>(
      owner.secret,
      "knowledge_bases_create",
      {
        name: "Deployment",
        slug: "deployment",
        description: "Packaged runtime acceptance fixture",
        idempotencyKey: key(),
      },
    );
    const kbId = made.kb.id;
    const proposer = await mint([{ kbId, bits: ["propose"] }]);
    const proposed = await tool<{ kind: string; commitSha: string; proposal: { number: number } }>(
      proposer.secret,
      "knowledge_documents_create",
      {
        kbId,
        baseRevision: made.kb.headSha,
        idempotencyKey: key(),
        path: "proposed.md",
        content: { markdown: "# Deployment proposal\n" },
      },
    );
    expect(proposed.kind).toBe("proposed");
    const merged = await tool<{ pr: { mergeCommitSha: string } }>(
      owner.secret,
      "knowledge_pull_requests_review",
      {
        kbId,
        number: proposed.proposal.number,
        decision: "merge",
        expectedHeadSha: proposed.commitSha,
        expectedTargetSha: made.kb.headSha,
        confirm: "MERGE",
        idempotencyKey: key(),
      },
    );
    const clone = join(scratch, "clone");
    const gitEnv = {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const basic = Buffer.from(`fixture:${owner.secret}`).toString("base64");
    const git = async (args: string[]) => {
      try {
        return await execute(
          "git",
          [
            "-c",
            `http.extraHeader=Authorization: Basic ${basic}`,
            "-c",
            "http.extraHeader=Host: deployment.example.invalid",
            ...args,
          ],
          { env: gitEnv, timeout: 65_000 },
        );
      } catch (error) {
        // Surface Git's own diagnosis and status; the PAT, its Basic encoding and argv stay out.
        const stderr = String(Reflect.get(Object(error), "stderr") ?? "").trim();
        const server = await compose("logs", "--no-color", "--tail", "30", "server").catch(
          (logError: unknown) => String(logError),
        );
        console.error(redact(server, [owner.secret, basic]));
        throw new Error(
          redact(
            `Packaged Git operation failed: git ${args.find((arg, index) => !arg.startsWith("-") && !["-C", "-c"].includes(args[index - 1] ?? "")) ?? ""} (${exitStatus(error)})${stderr ? `\n${stderr}` : ""}`,
            [owner.secret, basic],
          ),
        );
      }
    };
    await git(["clone", `${origin}/git/${kbId}.git`, clone]);
    // Reviews record the merger in a two-parent commit even with compatible ancestry.
    // Inspect this fixture's published graph, independent of the checkout's Git history.
    expect((await git(["-C", clone, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      merged.pr.mergeCommitSha,
    );
    expect((await git(["-C", clone, "show", "-s", "--format=%P", "HEAD"])).stdout.trim()).toBe(
      `${made.kb.headSha} ${proposed.commitSha}`,
    );
    expect((await git(["-C", clone, "rev-parse", "HEAD^{tree}"])).stdout.trim()).toBe(
      (await git(["-C", clone, "rev-parse", `${proposed.commitSha}^{tree}`])).stdout.trim(),
    );
    expect(await readFile(join(clone, "proposed.md"), "utf8")).toBe("# Deployment proposal\n");
    await writeFile(
      join(clone, "pushed.md"),
      "# Runtime deployment search\nContainer packaging is tested through Git.\n",
    );
    await git(["-C", clone, "add", "pushed.md"]);
    await git([
      "-C",
      clone,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "packaged push",
    ]);
    await git(["-C", clone, "push", "origin", "main"]);
    const head = (await git(["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
    const png = minimalPng();
    const contentHash = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    const upload = await tool<{ uploadId: string }>(owner.secret, "knowledge_upload_begin", {
      kbId,
      kind: "asset",
      size: png.length,
      mime: "image/png",
      contentHash,
      idempotencyKey: key(),
    });
    await tool(owner.secret, "knowledge_upload_write", {
      kbId,
      uploadId: upload.uploadId,
      offset: 0,
      bytesBase64: png.toString("base64"),
    });
    await tool(owner.secret, "knowledge_upload_finish", { kbId, uploadId: upload.uploadId });
    const asset = await tool<{ commitSha: string }>(owner.secret, "knowledge_assets_put", {
      kbId,
      path: "media/pic.png",
      uploadId: upload.uploadId,
      baseRevision: head,
      idempotencyKey: key(),
    });
    const media = await fetch(`${origin}/kb-assets/${kbId}/${contentHash}?rev=${asset.commitSha}`, {
      headers: { authorization: `Bearer ${owner.secret}` },
    });
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer())).toEqual(png);
    const exported = await tool<{ transferId: string; size: number }>(
      owner.secret,
      "knowledge_export_prepare",
      { kbId, kind: "whole", idempotencyKey: key() },
    );
    const zip = await tool<{ bytesBase64: string; eof: boolean }>(
      owner.secret,
      "knowledge_transfer_read",
      { kbId, transferId: exported.transferId, offset: 0 },
    );
    expect(zip.eof).toBe(true);
    expect(Buffer.from(zip.bytesBase64, "base64").subarray(0, 2).toString()).toBe("PK");
    const { provider } = await rpc<{ provider: { providerId: string; revision: number } }>(
      "embeddingProviders/create",
      {
        name: "Fixture",
        endpointUrl: `https://${fixtureIp}/v1/embeddings`,
        model: "fixture",
        dimensions: 3,
        apiKey: randomBytes(16).toString("hex"),
        idempotencyKey: key(),
      },
    );
    await eventually(
      async () =>
        (
          await rpc<{ items: { providerId: string; status: string }[] }>(
            "embeddingProviders/listMine",
            {},
          )
        ).items.some((p) => p.providerId === provider.providerId && p.status === "ready"),
      "Packaged provider probe failed",
    );
    await tool(owner.secret, "knowledge_embedding_profile_set", {
      kbId,
      providerId: provider.providerId,
      revision: provider.revision,
      confirm: "RUN",
      idempotencyKey: key(),
    });
    await eventually(
      async () =>
        (await tool<{ freshness: string }>(owner.secret, "knowledge_index_status", { kbId }))
          .freshness === "current",
      "Packaged index build failed",
    );
    const search = await tool<{ results: { mode: string; commitSha: string }[] }>(
      owner.secret,
      "knowledge_search",
      { kbId, query: "deployment" },
    );
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0]).toMatchObject({ mode: "hybrid", commitSha: asset.commitSha });
    expect(await docker(["exec", ssh.name, "cat", "/fixture/embeddings"])).toContain("request");
    const mirror = await rpc<{ mirror: { pending: { publicKey: string } } }>("kbMirror/configure", {
      kbId,
      url: `ssh://git@${fixtureIp}:2222/o/r.git`,
      hostKeys: [ssh.hostKey],
      idempotencyKey: key(),
    });
    await ssh.authorize([mirror.mirror.pending.publicKey]);
    await rpc("kbMirror/activate", { kbId, idempotencyKey: key() });
    await eventually(
      async () => (await rpc<{ state: string }>("kbMirror/status", { kbId })).state === "ACTIVE",
      "Packaged SSH activation failed",
    );
    await rpc("kbMirror/push", { kbId, idempotencyKey: key() });
    await eventually(
      async () =>
        (await docker([
          "exec",
          ssh.name,
          "git",
          "--git-dir=/o/r.git",
          "rev-parse",
          "refs/heads/main",
        ])) === asset.commitSha,
      "Packaged mirror push failed",
    );
    expect(
      await inImage(
        "worker",
        `import fs from 'node:fs';console.log(fs.readdirSync('/run/kb-mirror').length)`,
      ),
    ).toBe("0");
  }, 180_000);

  it("fails readiness on consumer loss, replays durable work after Redis replacement, and restarts cleanly", async () => {
    await compose("stop", "worker");
    try {
      await eventually(
        async () => (await ready()).status === 503,
        "Consumer loss admitted readiness",
        30_000,
      );
      const owner = await mint();
      const created = await tool<{ kb: { id: string } }>(owner.secret, "knowledge_bases_create", {
        name: "Queued",
        slug: "queued",
        description: "Redis replacement durable queue fixture",
        idempotencyKey: key(),
      });
      const { provider } = await rpc<{ provider: { providerId: string } }>(
        "embeddingProviders/create",
        {
          name: "Redis fixture",
          endpointUrl: `https://${fixtureIp}/v1/embeddings`,
          model: "fixture",
          dimensions: 3,
          apiKey: randomBytes(16).toString("hex"),
          idempotencyKey: key(),
        },
      );
      const pending = await prisma.providerRevision.findFirstOrThrow({
        where: { providerId: provider.providerId },
        select: { jobId: true },
      });
      expect(
        (
          await prisma.durableJob.findUniqueOrThrow({
            where: { id: pending.jobId },
            select: { state: true },
          })
        ).state,
      ).not.toBe("COMPLETE");
      // This is the suite's exclusively owned Redis. Its replacement has no queue snapshot.
      const oldRedis = redis;
      await docker([
        "exec",
        redis,
        "valkey-cli",
        "SET",
        "deployment-replacement-proof",
        "old-store",
      ]);
      const oldVolumes = JSON.parse(
        await docker(["inspect", oldRedis, "--format", "{{json .Mounts}}"]),
      ) as { Type: string; Name: string }[];
      await compose("up", "-d", "--no-build", "--force-recreate", "--renew-anon-volumes", "redis");
      redis = await id("redis");
      for (const mount of oldVolumes.filter((mount) => mount.Type === "volume"))
        await docker(["volume", "rm", mount.Name]);
      expect(redis).not.toBe(oldRedis);
      expect(
        await docker(["exec", redis, "valkey-cli", "GET", "deployment-replacement-proof"]),
      ).toBe("");
      await compose("start", "worker");
      await waitReady();
      await eventually(
        async () =>
          (
            await prisma.durableJob.findUniqueOrThrow({
              where: { id: pending.jobId },
              select: { state: true },
            })
          ).state === "COMPLETE",
        "DB outbox did not survive Redis replacement",
      );
      expect(
        (
          await rpc<{ items: { providerId: string; status: string }[] }>(
            "embeddingProviders/listMine",
            {},
          )
        ).items,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ providerId: provider.providerId, status: "ready" }),
        ]),
      );
      await compose("restart", "server");
      await waitReady();
      const kb = await tool<{ kb: { id: string } }>(owner.secret, "knowledge_bases_get", {
        kbId: created.kb.id,
      });
      expect(kb.kb.id).toBe(created.kb.id);
    } finally {
      await compose("start", "worker");
    }
  }, 180_000);

  it("fences a second packaged writer and drains the namespace on supervisor SIGKILL and PG loss", async () => {
    const server = await id("server");
    await expect(
      docker(["exec", server, "/usr/local/bin/kb-supervisor", "node", "-e", "process.exit(0)"]),
    ).rejects.toThrow(/fence|writer|lock/i);
    const supervisor = await inImage(
      "server",
      `import fs from 'node:fs';console.log(fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).find(x=>{try{return fs.readFileSync('/proc/'+x+'/comm','utf8').trim()==='kb-supervisor'}catch{return false}}));`,
    );
    const before = await docker(["inspect", server, "--format", "{{.State.StartedAt}}"]);
    // A detached process outside Node's child tracking must still die with the
    // native supervisor's PID namespace. Docker top reports host PIDs.
    await docker(["exec", "-d", server, "sleep", "600"]);
    const oldProcesses = (await docker(["top", server, "-eo", "pid"])).split(/\s+/).slice(1);
    await docker(["exec", "-d", server, "node", "-e", `process.kill(${supervisor},'SIGKILL')`]);
    await eventually(
      async () =>
        (await docker(["inspect", server, "--format", "{{.State.StartedAt}} "])) !== before,
      "Supervisor kill did not tear down its container",
    );
    await waitReady();
    await eventually(
      async () =>
        oldProcesses.every((pid) => {
          try {
            process.kill(Number(pid), 0);
            return false;
          } catch (error) {
            return Reflect.get(Object(error), "code") === "ESRCH";
          }
        }),
      "Old container process survived supervisor death",
    );
    const newProcesses = (await docker(["top", server, "-eo", "pid"])).split(/\s+/).slice(1);
    expect(newProcesses.filter((pid) => oldProcesses.includes(pid))).toEqual([]);
    expect(await docker(["top", server, "-eo", "pid,comm"])).not.toContain("sleep");
    // The runner's disposable PGDATA is tmpfs: stopping it would erase the
    // database. Remove the real runtime network to exercise dependency loss.
    await docker(["network", "disconnect", network, postgres]);
    try {
      await eventually(async () => (await ready()).status !== 200, "PG loss stayed ready", 15_000);
      await expect(
        docker(["exec", server, "/usr/local/bin/kb-supervisor", "node", "-e", "process.exit(0)"]),
      ).rejects.toThrow(/fence|writer|lock/i);
    } finally {
      await docker(["network", "connect", "--alias", "postgres", network, postgres]);
    }
    await waitReady();
    const processes = await inImage(
      "server",
      `import fs from 'node:fs';console.log(fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).map(x=>{try{return fs.readFileSync('/proc/'+x+'/comm','utf8').trim()}catch{return ''}}).filter(x=>x==='kb-supervisor').length);`,
    );
    expect(processes).toBe("1");
  }, 180_000);

  it("refuses missing hook, child, executable, key and wrong filesystem before readiness", async () => {
    for (const [role, artifact] of [
      ["server", "/app/apps/server/dist/git-pre-receive.mjs"],
      ["worker", "/app/apps/worker/dist/qwen-child.mjs"],
      ["worker", "/app/apps/worker/dist/ssh-wrapper.mjs"],
      ["worker", "/usr/local/bin/kb-child-guard"],
      ["server", "/app/scripts/init-kb-volumes.mjs"],
      ["server", "/usr/local/bin/kb-supervisor"],
    ] as const) {
      const args = [
        "compose",
        "--project-directory",
        ROOT,
        "-p",
        project,
        "-f",
        file,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "sh",
        "-u",
        "0",
        role,
        "-c",
        `rm '${artifact}'; exec /usr/local/bin/docker-entrypoint.sh node apps/${role}/dist/index.mjs --fenced`,
      ];
      await expect(docker(args, 30_000), artifact).rejects.toThrow(
        /FATAL: KB runtime deployment invalid/,
      );
    }
    for (const role of ["server", "worker"]) {
      for (const value of ["", Buffer.alloc(31).toString("base64")])
        await expect(
          compose("run", "--rm", "--no-deps", "-e", `KB_MASTER_KEY=${value}`, role),
        ).rejects.toThrow(/FATAL:.*KB_MASTER_KEY/);
    }
    // An `ro` data mount or a mount below the data root is refused for either
    // role. Long-syntax overrides replace the service mount by target.
    const overrides = {
      ro: [
        { type: "volume", source: "kb-data", target: "/var/lib/knowledge-base", read_only: true },
      ],
      submount: [{ type: "tmpfs", target: "/var/lib/knowledge-base/index" }],
    };
    for (const role of ["server", "worker"] as const) {
      for (const [kind, volumes] of Object.entries(overrides)) {
        const override = join(scratch, `${role}-${kind}.json`);
        await writeFile(override, JSON.stringify({ services: { [role]: { volumes } } }), {
          mode: 0o600,
        });
        const overrideArgs = ["compose", "--project-directory", ROOT, "-p", project, "-f", file];
        overrideArgs.push("-f", override);
        const effective = JSON.parse(
          await docker([...overrideArgs, "config", "--format", "json"]),
        ) as {
          services: Record<string, { volumes: { target: string; read_only?: boolean }[] }>;
        };
        const targets = effective.services[role]!.volumes.filter((v) =>
          v.target.startsWith("/var/lib/knowledge-base"),
        );
        if (kind === "ro")
          expect(targets.map((v) => [v.target, v.read_only])).toEqual([
            ["/var/lib/knowledge-base", true],
          ]);
        else
          expect(targets.map((v) => v.target).sort()).toEqual([
            "/var/lib/knowledge-base",
            "/var/lib/knowledge-base/index",
          ]);
        await expect(
          docker([...overrideArgs, "run", "--rm", "--no-deps", role]),
          `${role} ${kind}`,
        ).rejects.toThrow(/KB runtime deployment invalid/);
      }
    }
    const parent = await id("worker");
    await docker(["exec", "-u", "0", parent, "chmod", "0755", "/run/kb-mirror"]);
    try {
      await expect(
        inImage(
          "worker",
          `import {checkRuntimeDeployment} from '/app/scripts/init-kb-volumes.mjs';checkRuntimeDeployment('worker');`,
        ),
      ).rejects.toThrow(/KB runtime deployment invalid/);
    } finally {
      await docker(["exec", "-u", "0", parent, "chmod", "0700", "/run/kb-mirror"]);
    }
  }, 300_000);

  it("checks effective data-root access and repairs existing owner modes for both roles", async () => {
    const path = "/var/lib/knowledge-base";
    for (const role of ["server", "worker"]) {
      const container = await id(role);
      const mode = await inImage(
        role,
        `import fs from 'node:fs';console.log((fs.statSync('${path}').mode&511).toString(8));`,
      );
      try {
        for (const permissions of ["0555", "0600", "0300"]) {
          await docker(["exec", "-u", "0", container, "chmod", permissions, path]);
          await expect(
            compose(
              "run",
              "--rm",
              "--no-deps",
              "-e",
              "DATABASE_URL=postgresql://invalid:invalid@127.0.0.1:1/invalid",
              role,
            ),
          ).rejects.toThrow(/FATAL: KB runtime deployment invalid/);
        }
        await docker(["exec", "-u", "0", container, "chmod", "0555", path]);
        // The same image-owned initializer also repairs a pre-existing root.
        expect(
          await inImage(
            role,
            `import fs from 'node:fs';import {initKbVolumes,checkRuntimeDeployment} from '/app/scripts/init-kb-volumes.mjs';initKbVolumes(process.env);checkRuntimeDeployment('${role}');fs.writeFileSync('${path}/index/access-proof','ok');fs.unlinkSync('${path}/index/access-proof');console.log('repaired');`,
          ),
        ).toBe("repaired");
      } finally {
        await docker(["exec", "-u", "0", container, "chmod", mode, path]);
      }
    }
  }, 180_000);

  it("removes the owned SSH key directory when setup fails before returning a fixture", async () => {
    const bin = join(scratch, "failed-ssh-bin");
    const marker = join(scratch, "failed-ssh-path.json");
    await mkdir(bin);
    // No container has been requested when key generation fails. Docker's
    // absence must not prevent releasing the real temporary key directory.
    await writeFile(join(bin, "docker"), `#!${process.execPath}\nprocess.exit(43);`, {
      mode: 0o755,
    });
    await writeFile(
      join(bin, "ssh-keygen"),
      `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv));process.exit(42);`,
      { mode: 0o755 },
    );
    const script = `import {createSshFixture} from ${JSON.stringify(join(ROOT, "packages/test-utils/src/kb/ssh.ts"))};try{await createSshFixture();throw Error('setup unexpectedly succeeded')}catch(error){if(error.code!==42)throw error;console.log('setup failed as injected')}`;
    expect(
      (
        await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
          cwd: ROOT,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          timeout: 240_000,
        })
      ).stdout,
    ).toContain("setup failed as injected");
    const args = JSON.parse(await readFile(marker, "utf8")) as string[];
    const directory = dirname(args[args.indexOf("-f") + 1]!);
    expect(directory).toMatch(/^\/dev\/shm\/kb-ssh-/);
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 250_000);

  // The agent stack is development-only (its former prod profile is replaced by
  // `pnpm smoke:image`); the full built-image graph is exercised above.
  it("renders the effective agent dev graph without any index builder login", async () => {
    const agentProject = `${project}-agent`;
    const source = join(scratch, "agent.yml");
    const envFile = join(scratch, "agent.env");
    // The graph needs no secret beyond the defaults: an empty operator env file.
    await writeFile(envFile, "", { mode: 0o600 });
    await writeFile(
      source,
      (await readFile(join(ROOT, "docker-compose.agent.yml"), "utf8")).replaceAll(
        "path: .env\n",
        `path: ${envFile}\n`,
      ),
    );
    const config = JSON.parse(
      (
        await execute(
          "docker",
          [
            "compose",
            "--project-directory",
            ROOT,
            "--env-file",
            "/dev/null",
            "-p",
            agentProject,
            "-f",
            source,
            "--profile",
            "dev",
            "config",
            "--format",
            "json",
          ],
          {
            env: { PATH: process.env.PATH, AGENT_VOLUME_ROOT: scratch, KB_MASTER_KEY: masterKey },
            timeout: 30_000,
          },
        )
      ).stdout,
    ) as {
      services: Record<
        string,
        {
          build?: unknown;
          image?: string;
          profiles?: string[];
          environment: Record<string, string>;
          depends_on?: Record<string, unknown>;
          networks?: string[] | Record<string, { aliases: string[] }>;
          ports?: unknown[];
          volumes?: unknown[];
          entrypoint?: string[];
          command?: string[];
        }
      >;
      networks: Record<string, unknown>;
    };
    for (const role of ["app", "worker"])
      expect(
        config.services[`${role}-dev`]!.environment.KB_INDEX_BUILDER_DATABASE_URL,
      ).toBeUndefined();
    expect(Object.keys(config.services).filter((name) => name.endsWith("-prod"))).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("kb_agent_index_builder");
    expect(config.services["dev-setup"]!.command?.join(" ")).toContain("pnpm -F server build");
  }, 60_000);
});
