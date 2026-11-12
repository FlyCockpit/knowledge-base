import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { writeInitialMainCommit } from "@knowledge-base/api/lib/kb/git-write";
import { startMaintenanceParticipant } from "@knowledge-base/api/lib/kb/maintenance";
import { assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  coordinateBackup,
  readBundle,
  verifyEncryptedBundle,
} from "../../../../scripts/lib/kb-backup.mjs";
import { requireBuiltArtifact } from "./build-artifacts.mjs";
import { type KbPostgresCluster, openKbPostgresClusterFromEnv } from "./postgres";
import { createAssetS3Fixture } from "./s3-fixture";

const root = resolve(import.meta.dirname, "../../../..");
let cluster: KbPostgresCluster;
let toolsDir: string;
let oldPath: string | undefined;
beforeAll(async () => {
  cluster = await openKbPostgresClusterFromEnv();
  toolsDir = await mkdtemp(join(tmpdir(), "kb-backup-pg-tools-"));
  oldPath = process.env.PATH;
  const container = execFileSync(
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
  if (!/^[a-f0-9]+$/.test(container))
    throw new Error("Missing disposable PostgreSQL client container");
  for (const name of ["pg_dump", "pg_restore"])
    await writeFile(
      join(toolsDir, name),
      `#!/bin/sh\nexec docker exec -i -e PGDATABASE -e PGUSER -e PGPASSWORD -e PGSSLMODE -e PGPORT=5432 -e PGHOST=127.0.0.1 ${container} ${name} "$@"\n`,
      { mode: 0o700 },
    );
  process.env.PATH = `${toolsDir}:${oldPath}`;
  requireBuiltArtifact(
    join(root, "apps/server/native/kb-supervisor"),
    "pnpm test:kb --build-only backup",
  );
});
afterAll(async () => {
  process.env.PATH = oldPath;
  await cluster?.close();
  if (toolsDir) await rm(toolsDir, { recursive: true, force: true });
});

// Read the bounded manifest while streaming/discarding payloads. In particular,
// the 1 GiB case must prove the exact CAS inventory without retaining it in RAM.
async function encryptedInventory(file: string, identity: string) {
  const child = spawn("age", ["-d", "-i", identity, file], { stdio: ["ignore", "pipe", "ignore"] });
  const done = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  void done.catch(() => {});
  let header = Buffer.alloc(0);
  let inventory: Array<{ path: string; size: number; sha256: string }> | undefined;
  try {
    for await (const bytes of child.stdout) {
      if (inventory) continue;
      header = Buffer.concat([header, bytes]);
      const first = header.indexOf(10);
      const second = header.indexOf(10, first + 1);
      if (first >= 0 && second >= 0) {
        expect(header.subarray(0, first).toString()).toBe("kb/backup/1");
        inventory = JSON.parse(header.subarray(first + 1, second).toString()).inventory;
        header = Buffer.alloc(0);
      } else if (header.length > 1024 * 1024)
        throw new Error("Backup fixture manifest exceeds budget");
    }
    expect(await done).toBe(0);
    if (!inventory) throw new Error("Backup fixture manifest missing");
    return inventory;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await done;
  }
}

it("drains a live Hono auth request and real worker job, denies late OAuth/uploads, and restarts after retry", {
  timeout: 900_000,
}, async () => {
  const db = await cluster.createDatabase();
  db.applyPrismaSchema();
  // One data volume (KB_DATA_ROOT) under a directory both roles mount read-write.
  const dir = await mkdtemp(join(tmpdir(), "kb-backup-live-"));
  const uid = process.getuid!(),
    gid = process.getgid!();
  const environment = {
    PATH: process.env.PATH!,
    NODE_ENV: "development",
    DATABASE_URL: db.urls.runtime,
    REDIS_URL: process.env.KB_TEST_REDIS_URL!,
    BACKUP_ENABLED: "false",
    KB_DATA_ROOT: dir,
    KB_RUNTIME_UID: String(uid),
    KB_RUNTIME_GID: String(gid),
    BETTER_AUTH_SECRET: randomUUID(),
    KB_MASTER_KEY: Buffer.alloc(32, 65).toString("base64"),
  };
  const portOwner = createServer();
  await new Promise<void>((resolve) => portOwner.listen(0, "127.0.0.1", resolve));
  const port = (portOwner.address() as { port: number }).port;
  await new Promise<void>((resolve) => portOwner.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const image = `${process.env.KB_TEST_PROJECT}-worker`;
  const mailEntered = Promise.withResolvers<void>(),
    allowMail = Promise.withResolvers<void>();
  const sockets = new Set<import("node:net").Socket>();
  const smtp = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 fixture ESMTP\r\n");
    let buffer = "",
      data = false;
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      if (data) {
        if (!buffer.includes("\r\n.\r\n")) return;
        buffer = "";
        data = false;
        mailEntered.resolve();
        void allowMail.promise.then(() => socket.write("250 accepted\r\n"));
        return;
      }
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (line === "DATA") {
          data = true;
          socket.write("354 continue\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 fixture\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  Object.assign(environment, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String((smtp.address() as { port: number }).port),
    SMTP_FROM: "fixture@example.invalid",
  });
  const containers: string[] = [];
  let workerKey = "",
    serverKey = "";
  const locks = new Client({ connectionString: db.urls.applier });
  await locks.connect();
  const wait = async (check: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (await check().catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Live maintenance wait failed: ${label}`);
  };
  const status = async (path: string, method = "GET") =>
    (
      await fetch(origin + path, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
        signal: AbortSignal.timeout(2000),
      })
    ).status;
  try {
    execFileSync(process.execPath, [join(root, "scripts/init-kb-volumes.mjs")], {
      env: environment,
      stdio: "pipe",
    });
    // P6: only the fenced server may initialize storage authority on an empty instance.
    for (const role of ["server", "worker"]) {
      const name = `kb-65-live-${role}-${randomUUID()}`;
      const env = {
        ...environment,
        SERVER_PORT: String(port),
        BETTER_AUTH_URL: origin,
        CORS_ORIGIN: origin,
      };
      const args = [
        "run",
        "--label",
        `io.knowledge-base.test-project=${process.env.KB_TEST_PROJECT}`,
        "-d",
        "--name",
        name,
        "--restart",
        "unless-stopped",
        "--network",
        "host",
        "--pid",
        "host",
        "--user",
        `${uid}:${gid}`,
        "-w",
        root,
        "-v",
        `${root}:${root}:ro`,
        "-v",
        `${dir}:${dir}:rw`,
      ];
      if (role === "worker")
        args.push("--tmpfs", `/run/kb-mirror:rw,mode=0700,uid=${uid},gid=${gid}`);
      for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
      // The production process chain: output supervisor -> kb-supervisor ->
      // service bootstrap, which owns the named record channel.
      args.push(
        "--entrypoint",
        "node",
        image,
        "--import",
        join(root, "node_modules/tsx/dist/loader.mjs"),
        join(root, `apps/${role}/src/output.ts`),
        "--fenced",
      );
      execFileSync("docker", args, { stdio: "pipe" });
      containers.push(name);
      if (role === "server") {
        await wait(async () => {
          const rows = (
            await db.query(
              "applier",
              "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' LIMIT 1",
            )
          ).rows;
          const key = rows[0]?.key;
          serverKey = typeof key === "string" ? key : "";
          const marker = (
            await db.query(
              "applier",
              "SELECT key FROM app_setting WHERE key='kb.asset-storage' LIMIT 1",
            )
          ).rows;
          return Boolean(serverKey) && marker.length === 1;
        }, "fenced server storage initialization");
      }
      if (role === "worker")
        await wait(async () => {
          const rows = (
            await db.query(
              "applier",
              "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' AND key<>$1 LIMIT 1",
              [serverKey],
            )
          ).rows;
          const key = rows[0]?.key;
          workerKey = typeof key === "string" ? key : "";
          return Boolean(workerKey);
        }, "worker permit registration");
    }
    await wait(async () => (await status("/ready")) === 200, "ready server and worker");
    expect(await status("/.well-known/oauth-authorization-server/api/auth")).toBe(200);
    await locks.query(
      `INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES ('echo:last','before',now(),now())`,
    );
    await locks.query(
      `INSERT INTO "user"(id,name,email,role,"emailVerified","operationalAlerts","createdAt","updatedAt") VALUES ($1,'fixture','alert@example.invalid','admin',true,true,now(),now())`,
      ["s".repeat(24)],
    );
    const failureScript = join(dir, "fail.mjs");
    await writeFile(
      failureScript,
      `import {createRequire} from 'node:module';const {Queue}=createRequire('${root}/apps/worker/package.json')('bullmq');const url=new URL(process.env.REDIS_URL);const queue=new Queue('echo',{connection:{host:url.hostname,port:Number(url.port)}});await queue.add('echo',{}, {jobId:'live-failure'});await queue.close();`,
    );
    execFileSync(process.execPath, [failureScript], { env: environment, stdio: "pipe" });
    await mailEntered.promise;
    // Block this admitted account lookup without freezing unrelated user/audit
    // work needed by the real hosts' shutdown paths.
    await locks.query('BEGIN; LOCK TABLE "account" IN ACCESS EXCLUSIVE MODE');
    await locks.query("UPDATE app_setting SET value=value WHERE key='echo:last'");
    const queueScript = join(dir, "enqueue.mjs");
    // Resolve the installed queue package through its workspace, not a version path.
    await writeFile(
      queueScript,
      `import {createRequire} from 'node:module';const {Queue}=createRequire('${root}/apps/worker/package.json')('bullmq');const url=new URL(process.env.REDIS_URL);const queue=new Queue('echo',{connection:{host:url.hostname,port:Number(url.port)}});await queue.add('echo',{message:'settled-before-cutoff'},{jobId:'live-maintenance'});await queue.close();`,
    );
    execFileSync(process.execPath, [queueScript], { env: environment, stdio: "pipe" });
    let authSettled = false;
    const auth = fetch(origin + "/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify({ email: "alert@example.invalid", password: "disposable" }),
    }).then((response) => {
      authSettled = true;
      return response.status;
    });
    void auth.catch(() => {});
    await wait(
      async () =>
        (
          await db.query(
            "applier",
            "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted AND l.locktype='transactionid' LIMIT 1",
          )
        ).rows.length > 0,
      "real consumer blocked in PostgreSQL",
    );
    await wait(
      async () =>
        (
          await db.query(
            "applier",
            "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted AND l.relation='account'::regclass LIMIT 1",
          )
        ).rows.length > 0,
      "admitted auth handler blocked in PostgreSQL",
    );
    const identity = join(dir, "identity");
    execFileSync("age-keygen", ["-o", identity], { stdio: "pipe" });
    const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
    const input = {
      connectionString: db.urls.applier,
      dataDir: dir,
      backupDir: dir,
      recipient,
      supervisor: join(root, "apps/server/native/kb-supervisor"),
    };
    let drainNow = 0;
    await expect(
      coordinateBackup({
        ...input,
        now: () => drainNow,
        barrier: async (phase: string) => {
          if (phase !== "drain") return;
          // Observe actual admission closure before advancing the product clock;
          // a 500ms host race cannot stand in for the five-minute drain contract.
          // A bare /ready 503 is not that signal: the worker participant usually
          // sees the request first, and readiness then answers a JSON 503
          // (checks.workers=false) while the HTTP host's own participant has not
          // polled yet. Only the closed HTTP admission gate answers with an
          // empty 503 before any route runs.
          await wait(async () => {
            const response = await fetch(origin + "/ready", {
              signal: AbortSignal.timeout(2000),
            });
            return response.status === 503 && (await response.text()) === "";
          }, "HTTP admission gate closes");
          drainNow = 300_000;
        },
      }),
    ).rejects.toThrow(/five minutes/);
    expect(authSettled).toBe(false);
    for (const [path, method] of [
      ["/ready", "GET"],
      ["/.well-known/oauth-authorization-server/api/auth", "GET"],
      ["/api/auth/oauth2/token", "POST"],
      ["/rpc/kbUploads/write", "POST"],
    ] as const)
      expect(await status(path, method)).toBe(503);
    expect(
      (
        await db.query(
          "applier",
          "SELECT value FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' AND value LIKE '%DRAINED' LIMIT 1",
        )
      ).rows,
    ).toHaveLength(0);
    await locks.query("COMMIT");
    expect(await auth).toBeGreaterThanOrEqual(400);
    await wait(
      async () =>
        (await db.query("applier", "SELECT value FROM app_setting WHERE key='echo:last'")).rows[0]
          ?.value === "settled-before-cutoff",
      "durable job settles",
    );
    // The HTTP host has drained; the worker must still own its admitted mail.
    await wait(
      async () =>
        (
          await db.query(
            "applier",
            "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' AND key<>$1 AND value LIKE '%DRAINED' LIMIT 1",
            [workerKey],
          )
        ).rows.length === 1,
      "HTTP drained while worker alert stays pending",
    );
    expect(
      (await db.query("applier", "SELECT value FROM app_setting WHERE key=$1", [workerKey])).rows[0]
        ?.value,
    ).toBe("LIVE");
    allowMail.resolve();
    const file = await coordinateBackup(input);
    expect((await readBundle(file, identity)).files.length).toBeGreaterThan(0);
    await wait(async () => (await status("/ready")) === 200, "automatic post-backup ready restart");
    expect(await status("/.well-known/oauth-authorization-server/api/auth")).toBe(200);
    expect(
      (
        await db.query(
          "applier",
          "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' LIMIT 3",
        )
      ).rows,
    ).toHaveLength(2);
  } catch (error) {
    for (const name of containers) {
      const logs = spawnSync("docker", ["logs", "--tail", "30", name], { encoding: "utf8" });
      console.error((logs.stdout + logs.stderr).replaceAll(db.urls.runtime, "[fixture database]"));
    }
    throw error;
  } finally {
    allowMail.resolve();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    await locks.query("ROLLBACK").catch(() => {});
    await locks.end();
    for (const name of containers.reverse())
      execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects head and historic CAS divergence, then backs up a supported 1 GiB CAS inventory", {
  timeout: 4_200_000,
}, async () => {
  const db = await cluster.createDatabase();
  db.applyPrismaSchema();
  const dir = await mkdtemp(join(tmpdir(), "kb-backup-volume-"));
  const repos = join(dir, "repos"),
    assets = join(dir, "assets");
  const id = "v".repeat(24),
    user = "u".repeat(24);
  try {
    await mkdir(join(repos, ".private"), { recursive: true });
    for (const name of ["server", "worker"])
      await writeFile(join(repos, `.private/${name}.fence`), "");
    const repo = join(repos, `kb_${id}.git`);
    execFileSync("git", ["init", "--bare", repo], { stdio: "pipe" });
    const head = await writeInitialMainCommit(
      {
        reposDir: repos,
        kbId: id,
        executor: {
          exec: async ({ argv, cwd, env }) => {
            execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "pipe" });
          },
        },
      },
      { message: "initial", description: "volume fixture" },
    );
    await db.query(
      "applier",
      `INSERT INTO "user"(id,name,email,"emailVerified",role,"createdAt","updatedAt") VALUES ($1,'fixture','volume@example.invalid',true,'user',now(),now())`,
      [user],
    );
    await db.query(
      "applier",
      `INSERT INTO knowledge_base(id,"ownerId",name,slug,description,state,"defaultBranch","headSha","metadataVersion","desiredEpoch","nextPrNumber","createdAt","updatedAt") VALUES ($1,$2,'volume','volume','volume fixture','ACTIVE','main',$3,1,0,1,now(),now())`,
      [id, user, "0".repeat(40)],
    );
    const identity = join(dir, "identity");
    execFileSync("age-keygen", ["-o", identity], { stdio: "pipe" });
    const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
    const input = {
      connectionString: db.urls.applier,
      dataDir: dir,
      backupDir: dir,
      recipient,
      supervisor: join(root, "apps/server/native/kb-supervisor"),
    };
    await expect(coordinateBackup(input)).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith(".complete"))).toEqual([]);
    await db.query("applier", 'UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [id, head]);
    const missing = createHash("sha256").update("historic missing blob").digest("hex");
    await db.query(
      "applier",
      "INSERT INTO asset_blob(hash,size,mime) VALUES ($1,21,'application/octet-stream')",
      [`sha256:${missing}`],
    );
    await expect(coordinateBackup(input)).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => n.endsWith(".complete"))).toEqual([]);
    await mkdir(join(assets, "objects", missing.slice(0, 2)), { recursive: true });
    await writeFile(
      join(assets, "objects", missing.slice(0, 2), missing.slice(2)),
      "historic missing blob",
    );
    const expectedObjects = [
      {
        path: `assets/objects/${missing.slice(0, 2)}/${missing.slice(2)}`,
        size: 21,
        sha256: missing,
      },
    ];
    // Individually bounded 25 MiB blobs; one shared 1 GiB inventory. Stream writes
    // and verification rather than allocating a whole-volume fixture in RAM.
    for (let n = 0; n < 41; n++) {
      const chunk = Buffer.alloc(1024 * 1024, n),
        count = n === 40 ? 24 : 25;
      const hash = createHash("sha256");
      for (let i = 0; i < count; i++) hash.update(chunk);
      const hex = hash.digest("hex"),
        parent = join(assets, "objects", hex.slice(0, 2));
      await mkdir(parent, { recursive: true });
      expectedObjects.push({
        path: `assets/objects/${hex.slice(0, 2)}/${hex.slice(2)}`,
        size: count * chunk.length,
        sha256: hex,
      });
      const file = await open(join(parent, hex.slice(2)), "wx", 0o600);
      try {
        for (let i = 0; i < count; i++) await file.writeFile(chunk);
      } finally {
        await file.close();
      }
      await db.query(
        "applier",
        "INSERT INTO asset_blob(hash,size,mime) VALUES ($1,$2,'application/octet-stream')",
        [`sha256:${hex}`, count * chunk.length],
      );
    }
    const started = Date.now(),
      file = await coordinateBackup(input);
    expect((await verifyEncryptedBundle(file)).size).toBeGreaterThan(1024 ** 3);
    const objects = (await encryptedInventory(file, identity)).filter((entry) =>
      entry.path.startsWith("assets/objects/"),
    );
    expect(objects.sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      expectedObjects.sort((a, b) => a.path.localeCompare(b.path)),
    );
    expect(objects.reduce((sum, entry) => sum + entry.size, 0)).toBe(1024 ** 3 + 21);
    // Snapshot I/O has its own one-hour product deadline; elapsed host disk
    // throughput is not a backup correctness invariant. The encrypted receipt
    // above covers every byte, and cutoff/restore tests verify the contents.
    expect((await readdir(dir)).filter((n) => /^\.kb-(cutoff|backup)-/.test(n))).toEqual([]);
    console.log(`Supported-volume backup: 1 GiB CAS, elapsed ${Date.now() - started}ms.`);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("quiesced backup cutoff", () => {
  it.each([
    ["before", false],
    ["after", false],
    ["after", true],
  ] as const)(
    "drains a write paused %s reservation (crashed=%s); PG, head, historic assets share a cutoff",
    async (phase, crashed) => {
      const db = await cluster.createDatabase();
      db.applyPrismaSchema();
      const dir = await mkdtemp(join(tmpdir(), "kb-backup-integration-"));
      const repos = join(dir, "repos"),
        assets = join(dir, "assets");
      await mkdir(join(repos, ".private"), { recursive: true });
      for (const name of ["server", "worker"])
        await writeFile(join(repos, `.private/${name}.fence`), "");
      const id = "a".repeat(24),
        repo = join(repos, `kb_${id}.git`);
      execFileSync("git", ["init", "--bare", repo], { stdio: "pipe" });
      const git = (args: string[], input?: string) =>
        execFileSync("git", ["--git-dir", repo, ...args], {
          encoding: "utf8",
          input,
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
        }).trim();
      let old = await writeInitialMainCommit(
        {
          reposDir: repos,
          kbId: id,
          executor: {
            exec: async ({ argv, cwd, env }) => {
              execFileSync(argv[0]!, argv.slice(1), { cwd, env, stdio: "pipe" });
            },
          },
        },
        { message: "initial", description: "fixture description" },
      );
      const userId = "b".repeat(24);
      await db.query(
        "applier",
        `INSERT INTO "user" (id,name,email,"emailVerified",role,"createdAt","updatedAt") VALUES ($1,'fixture','fixture@example.invalid',true,'user',now(),now())`,
        [userId],
      );
      await db.query(
        "applier",
        `INSERT INTO "knowledge_base" (id,"ownerId",name,slug,description,state,"defaultBranch","headSha","metadataVersion","desiredEpoch","nextPrNumber","createdAt","updatedAt") VALUES ($1,$3,'Fixture','fixture','fixture description','ACTIVE','main',$2,1,0,1,now(),now())`,
        [id, old, userId],
      );
      await writeFile(
        join(dir, ".env"),
        "KB_MASTER_KEY=fixture-master-secret\nBETTER_AUTH_SECRET=fixture-auth-secret",
      );
      await mkdir(join(assets, "models"), { recursive: true });
      await writeFile(join(assets, "models", "weights"), "excluded model");
      const blob = Buffer.from("historic bytes absent from the active manifest");
      const hex = createHash("sha256").update(blob).digest("hex");
      const manifest = git(
        ["hash-object", "-w", "--stdin"],
        JSON.stringify({
          version: 1,
          entries: [
            {
              path: "media/historic.bin",
              hash: `sha256:${hex}`,
              size: blob.length,
              mime: "text/plain",
            },
          ],
        }),
      );
      const assetTree = git(["mktree"], `100644 blob ${manifest}\tmanifest.json\n`);
      const historicTree = git(
        ["mktree"],
        git(["ls-tree", old]).replace(
          /^040000 tree [a-f0-9]+\t\.assets$/m,
          `040000 tree ${assetTree}\t.assets`,
        ) + "\n",
      );
      const historic = git(["commit-tree", historicTree, "-p", old, "-m", "historic asset"]);
      old = git(["commit-tree", `${old}^{tree}`, "-p", historic, "-m", "remove active asset"]);
      git(["update-ref", "refs/heads/main", old]);
      await db.query("applier", 'UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [id, old]);
      await mkdir(join(assets, "objects", hex.slice(0, 2)), { recursive: true });
      await writeFile(join(assets, "objects", hex.slice(0, 2), hex.slice(2)), blob);
      await db.query(
        "applier",
        `INSERT INTO asset_blob(hash,size,mime) VALUES ($1,$2,'application/octet-stream')`,
        [`sha256:${hex}`, blob.length],
      );
      await db.query(
        "applier",
        `INSERT INTO kb_asset_lineage("kbId",hash,"actorKey","actorUserIdSnapshot",source) VALUES ($1,$2,$3,$3,'UPLOAD')`,
        [id, `sha256:${hex}`, userId],
      );
      const identity = join(dir, "identity");
      execFileSync("age-keygen", ["-pq", "-o", identity], { stdio: "pipe" });
      const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
      const source = `
import { createRequire } from 'node:module';
import { createKbWriteCoordinator, runJournalTestPublish } from '${root}/apps/server/src/kb-write-coordinator.ts';
import { startMaintenanceParticipant } from '${root}/packages/api/src/lib/kb/maintenance.ts';
import { sqlAuthorityStore } from '${root}/packages/api/src/lib/kb/permissions.ts';
import { reconcileKbIntents } from '${root}/packages/api/src/lib/kb/operation-intent.ts';
import { runLockedOperation } from '${root}/packages/api/src/lib/kb/authority-lock.ts';
import { setKbRecoveryComplete } from '${root}/packages/api/src/lib/kb/recovery.ts';
const {Client}=createRequire('${root}/package.json')('pg');
const client=new Client({connectionString:process.env.DATABASE_URL}); await client.connect();
setKbRecoveryComplete(true);
const coordinator=createKbWriteCoordinator({connectionString:process.env.DATABASE_URL});
let release; const pause=new Promise(r=>release=r);
const permit=await startMaintenanceParticipant(process.env.DATABASE_URL,()=>{ coordinator.closeWriteAdmission(); release(); });
const barrier=()=>{console.log('PAUSED '+process.pid); return pause;};
try { await runJournalTestPublish(coordinator,{store:sqlAuthorityStore(client.query.bind(client)),principal:{kind:'browser',userId:'${userId}'},reposDir:process.env.KB_DATA_ROOT+'/repos',kbId:'${id}',idempotencyKey:'backup_fixture_key',request:{marker:'fixture'},barrier:{${phase === "before" ? "afterPrepared" : "afterCommitting"}:barrier}}); }
catch(error) { if('${phase}'==='after') throw error; }
await coordinator.shutdown();
await runLockedOperation({connectionString:process.env.DATABASE_URL,opId:'backup-recovery',kind:'kb-write',kbIds:['${id}'],run:lease=>lease.transaction(query=>reconcileKbIntents(query,process.env.KB_DATA_ROOT+'/repos','${id}'))});
const {spawn}=await import('node:child_process');
const oldChild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('OLD_READY');setTimeout(()=>{require('fs').writeFileSync(process.env.LEAK,'late');process.exit(0)},8000);"],{env:{PATH:process.env.PATH,LEAK:'${dir}/late-write'},stdio:['ignore','pipe','ignore',Number(process.env.KB_FENCE_FD)]});
await new Promise(r=>oldChild.stdout.once('data',r));
await client.end(); await permit.release(); process.exit(0);
`;
      const fixture = join(dir, "writer.mjs");
      await writeFile(fixture, source);
      const child = spawn(
        join(root, "apps/server/native/kb-supervisor"),
        ["--", process.execPath, "--import", "tsx", fixture],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: db.urls.runtime, KB_DATA_ROOT: dir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let writerPid = 0;
      let stderr = "";
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      const done = new Promise<number>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolveExit(code ?? 1));
      });
      try {
        const lines = createInterface({ input: child.stdout });
        await new Promise<void>((resolveReady, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Writer did not pause: " + stderr.replaceAll(db.urls.runtime, "[fixture]"),
                ),
              ),
            180_000,
          );
          lines.on("line", (line) => {
            const match = line.match(/^PAUSED ([1-9]\d*)$/);
            if (match) {
              writerPid = Number(match[1]);
              clearTimeout(timer);
              lines.close();
              resolveReady();
            }
          });
          void done.then((code) => {
            clearTimeout(timer);
            lines.close();
            reject(new Error(`Writer exited before maintenance (${code})`));
          });
        });
        if (crashed) {
          process.kill(writerPid, "SIGKILL");
          expect(await done).not.toBe(0);
          await expect(
            coordinateBackup({
              connectionString: db.urls.applier,
              dataDir: dir,
              backupDir: dir,
              recipient,
              supervisor: join(root, "apps/server/native/kb-supervisor"),
            }),
          ).rejects.toThrow(/Incomplete maintenance drain/);
          const recovery = join(dir, "recovery.mjs");
          await writeFile(
            recovery,
            `import {createPrismaPgAdapter} from '${root}/packages/db/src/prisma-adapter.ts';
import {PrismaClient} from '${root}/packages/db/prisma/generated/client.ts';
import {runStartupJournalRecovery} from '${root}/packages/api/src/lib/kb/recovery.ts';
import {startMaintenanceParticipant} from '${root}/packages/api/src/lib/kb/maintenance.ts';
import {assertProcessFence} from '${root}/apps/server/src/kb-process.ts';
const db=new PrismaClient({adapter:createPrismaPgAdapter({connectionString:process.env.DATABASE_URL})});
try{await startMaintenanceParticipant(process.env.DATABASE_URL,()=>{},()=>runStartupJournalRecovery(db,process.env.KB_DATA_ROOT+'/repos',process.env.KB_DATA_ROOT+'/assets',process.env.DATABASE_URL,assertProcessFence));throw Error('unexpected admission');}catch(error){if(!error.message.includes('offline recovery'))throw error;}finally{await db.$disconnect();}`,
          );
          const recovered = spawn(
            join(root, "apps/server/native/kb-supervisor"),
            ["--", process.execPath, "--import", "tsx", recovery],
            {
              cwd: root,
              env: {
                ...process.env,
                DATABASE_URL: db.urls.runtime,
                KB_DATA_ROOT: dir,
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let failure = "";
          recovered.stderr.on("data", (b) => {
            failure += b;
          });
          expect(await new Promise((resolve) => recovered.once("close", resolve)), failure).toBe(0);
        }
        const file = await coordinateBackup({
          connectionString: db.urls.applier,
          dataDir: dir,
          backupDir: dir,
          recipient,
          supervisor: join(root, "apps/server/native/kb-supervisor"),
          schemaDir: join(root, "packages/db/prisma"),
        });
        if (!crashed) expect(await done, stderr.replaceAll(db.urls.runtime, "[fixture]")).toBe(0);
        const next = git(["rev-parse", "refs/heads/main"]);
        if (phase === "before" || crashed) expect(next).toBe(old);
        else expect(next).not.toBe(old);
        await expect(readFile(join(dir, "late-write"))).rejects.toThrow();
        const bundle = await readBundle(file, identity);
        expect(
          bundle.files.every(
            (f) =>
              !f.bytes.includes(Buffer.from("fixture-master-secret")) &&
              !f.bytes.includes(Buffer.from("fixture-auth-secret")),
          ),
        ).toBe(true);
        const audits = await db.query(
          "applier",
          `SELECT revision,metadata FROM audit_event WHERE action='BACKUP_CUTOFF' LIMIT 2`,
        );
        expect(audits.rows).toHaveLength(1);
        expect(audits.rows[0]?.revision).toBe(bundle.metadata.cutoff);
        const auditMetadata = audits.rows[0]?.metadata;
        if (!auditMetadata || typeof auditMetadata !== "object")
          throw new Error("Missing audit metadata");
        expect(Object.keys(auditMetadata).sort()).toEqual(["reasonCode", "requestId"]);
        expect(bundle.metadata.authorityEpoch).toBe("1");
        expect(bundle.files.some((f) => f.path === "schema/migrations/0_init/migration.sql")).toBe(
          true,
        );
        expect(
          bundle.files.some(
            (f) => f.path.startsWith("schema/sql/") || f.path.startsWith("schema/prisma/"),
          ),
        ).toBe(false);
        const applied = await db.query(
          "applier",
          "SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name",
        );
        expect(bundle.metadata.migrationHistory.applied).toEqual(applied.rows);
        expect(bundle.metadata.migrationHistory.contracts).toHaveLength(1);
        expect(bundle.metadata.sourceCatalog.length).toBeGreaterThan(0);
        expect(bundle.metadata.heads[0]!.headSha).toBe(phase === "after" && !crashed ? next : old);
        const entry = bundle.files.find(
          (f: { path: string }) => f.path === `assets/objects/${hex.slice(0, 2)}/${hex.slice(2)}`,
        );
        expect(entry?.bytes).toEqual(blob);
        const inspectRepo = join(dir, "inspect.git");
        for (const f of bundle.files.filter((f) => f.path.startsWith(`repos/kb_${id}.git/`))) {
          const target = join(inspectRepo, f.path.slice(`repos/kb_${id}.git/`.length));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.bytes);
        }
        expect(
          execFileSync(
            "git",
            ["--git-dir", inspectRepo, "show", `${historic}:.assets/manifest.json`],
            { encoding: "utf8" },
          ),
        ).toContain(hex);
        expect(git(["show", "refs/heads/main:.assets/manifest.json"])).toContain('"entries":[]');
        expect(bundle.files.some((f: { path: string }) => f.path === "postgres.dump")).toBe(true);
        expect(
          bundle.files.every((f: { path: string }) => !/models|redis|\.env|identity/.test(f.path)),
        ).toBe(true);
        expect(
          (
            await db.query(
              "applier",
              "SELECT value FROM app_setting WHERE key='kb.maintenance.request'",
            )
          ).rows,
        ).toEqual([]);
        const dump = join(dir, "check.dump");
        await writeFile(
          dump,
          bundle.files.find((f: { path: string }) => f.path === "postgres.dump")!.bytes,
        );
        const sql = execFileSync("pg_restore", ["-a", "-f", "-"], {
          encoding: "utf8",
          input: await readFile(dump),
        });
        expect(sql).toContain(phase === "after" && !crashed ? next : old);
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM");
        await done;
        await db.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    900_000,
  );
});

it("timeout retains durable admission, startup refuses, and an offline retry recovers", async () => {
  const db = await cluster.createDatabase();
  db.applyPrismaSchema();
  const dir = await mkdtemp(join(tmpdir(), "kb-drain-timeout-"));
  const identity = join(dir, "identity");
  execFileSync("age-keygen", ["-pq", "-o", identity], { stdio: "pipe" });
  const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
  let closed = false;
  const admissionClosed = Promise.withResolvers<void>();
  const permit = await startMaintenanceParticipant(db.urls.runtime, () => {
    closed = true;
    admissionClosed.resolve();
  });
  let now = 0;
  try {
    await expect(
      coordinateBackup({
        connectionString: db.urls.applier,
        dataDir: dir,
        backupDir: dir,
        recipient,
        timeout: 300_000,
        now: () => now,
        barrier: async (phase: string) => {
          if (phase === "drain") {
            // Synchronize with the real participant, then expire the product's
            // exact five-minute bound independently of filesystem throughput.
            await admissionClosed.promise;
            now = 300_000;
          }
        },
      }),
    ).rejects.toThrow(/five minutes/);
    expect(closed).toBe(true);
    await expect(startMaintenanceParticipant(db.urls.runtime, () => {})).rejects.toThrow(
      /recovery/,
    );
    expect(
      (
        await db.query(
          "applier",
          "SELECT value FROM app_setting WHERE key='kb.maintenance.request'",
        )
      ).rows,
    ).toHaveLength(1);
    for (const kill of ["SIGTERM", "SIGKILL"] as const) {
      const script = join(dir, "drain.mjs");
      await writeFile(
        script,
        `import {coordinateBackup} from '${root}/scripts/lib/kb-backup.mjs';const abort=new AbortController();process.on('SIGTERM',()=>abort.abort());try{await coordinateBackup({connectionString:process.env.DATABASE_URL,dataDir:'${dir}',backupDir:'${dir}',recipient:process.env.BACKUP_AGE_RECIPIENT,signal:abort.signal,barrier:async phase=>{if(phase==='drain'){console.log('DRAIN');await new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}}});}catch{process.exitCode=1;}`,
      );
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, DATABASE_URL: db.urls.applier, BACKUP_AGE_RECIPIENT: recipient },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const done = new Promise((resolve) => child.once("close", resolve));
      try {
        const lines = createInterface({ input: child.stdout });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            lines.close();
            reject(new Error("drain barrier"));
          }, 180_000);
          lines.on("line", (line) => {
            if (line !== "DRAIN") return;
            clearTimeout(timer);
            lines.close();
            resolve();
          });
          void done.then(() => {
            clearTimeout(timer);
            lines.close();
            reject(new Error("drain child exited before barrier"));
          });
        });
        let recoveryRan = false;
        await expect(
          startMaintenanceParticipant(
            db.urls.runtime,
            () => {},
            async () => {
              recoveryRan = true;
            },
          ),
        ).rejects.toThrow(/recovery/);
        expect(recoveryRan).toBe(false);
        child.kill(kill);
        expect(await done).not.toBe(0);
        await expect(startMaintenanceParticipant(db.urls.runtime, () => {})).rejects.toThrow(
          /recovery/,
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await done;
      }
    }
    await permit.release();
    const repos = join(dir, "repos"),
      assets = join(dir, "assets");
    await mkdir(join(repos, ".private"), { recursive: true });
    await mkdir(join(assets, "objects"), { recursive: true });
    for (const name of ["server", "worker"])
      await writeFile(join(repos, `.private/${name}.fence`), "");
    const input = {
      connectionString: db.urls.applier,
      dataDir: dir,
      backupDir: dir,
      recipient,
      supervisor: join(root, "apps/server/native/kb-supervisor"),
    };
    await db.query(
      "applier",
      "DELETE FROM app_setting WHERE key='kb.maintenance.request' OR key LIKE 'kb.maintenance.participant.%'",
    );
    await db.query(
      "applier",
      `INSERT INTO app_setting(key,value,"createdAt","updatedAt") SELECT 'kb.maintenance.participant.crashed.' || n,'LIVE',now(),now() FROM generate_series(1,1001) n`,
    );
    await expect(coordinateBackup(input)).rejects.toThrow(/Incomplete maintenance drain/);
    const previous = await coordinateBackup(input),
      bytes = await readFile(previous);
    expect(
      (
        await db.query(
          "applier",
          "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' LIMIT 1",
        )
      ).rows,
    ).toHaveLength(0);
    await db.query(
      "applier",
      `INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES ('kb.maintenance.request','fixture',now(),now()) ON CONFLICT(key) DO UPDATE SET value='fixture'`,
    );
    const coherent = join(dir, "coherent.mjs");
    await writeFile(
      coherent,
      `import {createRequire} from 'node:module';import {snapshotOffline} from '${root}/scripts/lib/kb-backup.mjs';const {Client}=createRequire('${root}/package.json')('pg');await snapshotOffline({connectionString:process.env.DATABASE_URL,dataDir:process.env.KB_DATA_ROOT,backupDir:process.env.BACKUP_DIR,recipient:process.env.BACKUP_AGE_RECIPIENT,schemaDir:'${root}/packages/db/prisma',runId:'00000000-0000-4000-8000-000000000002',barrier:async phase=>{if(phase==='dump'){const writer=new Client({connectionString:process.env.DATABASE_URL});await writer.connect();try{await writer.query(\`INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES ('backup.postCut','must-not-enter-exported-snapshot',now(),now())\`);}finally{await writer.end();}}}});`,
    );
    const snapshotChild = spawn(input.supervisor, ["--backup", "--", process.execPath, coherent], {
      env: {
        ...process.env,
        DATABASE_URL: db.urls.applier,
        KB_DATA_ROOT: dir,
        BACKUP_DIR: dir,
        BACKUP_AGE_RECIPIENT: recipient,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let snapshotFailure = "";
    snapshotChild.stderr.on("data", (b) => {
      snapshotFailure += b;
    });
    expect(
      await new Promise((resolve) => snapshotChild.once("close", resolve)),
      snapshotFailure,
    ).toBe(0);
    const cutoff = await readBundle(
      join(dir, "backup-00000000-0000-4000-8000-000000000002.age"),
      identity,
    );
    const cutoffSql = execFileSync("pg_restore", ["-a", "-f", "-"], {
      encoding: "utf8",
      input: cutoff.files.find((f) => f.path === "postgres.dump")!.bytes,
    });
    expect(
      (
        await db.query(
          "applier",
          "SELECT value FROM app_setting WHERE key='backup.postCut' LIMIT 1",
        )
      ).rows,
    ).toHaveLength(1);
    expect(cutoffSql).not.toContain("must-not-enter-exported-snapshot");
    for (const stage of [
      "reclaimed",
      "dump-started",
      "file-started",
      "encryption-started",
      "publish",
      "ciphertext-published",
    ]) {
      for (const kill of ["SIGTERM", "SIGKILL"] as const) {
        if (stage === "reclaimed")
          await db.query(
            "applier",
            `INSERT INTO app_setting(key,value,"createdAt","updatedAt") SELECT 'kb.maintenance.participant.reclaim.' || n,'LIVE',now(),now() FROM generate_series(1,2001) n ON CONFLICT(key) DO NOTHING`,
          );
        await db.query(
          "applier",
          `INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES ('kb.maintenance.request','fixture',now(),now()) ON CONFLICT(key) DO UPDATE SET value='fixture'`,
        );
        const script = join(dir, "interrupted.mjs");
        await writeFile(
          script,
          `import {snapshotOffline} from '${root}/scripts/lib/kb-backup.mjs';
const abort=new AbortController();process.on('SIGTERM',()=>abort.abort());
try { await snapshotOffline({connectionString:process.env.DATABASE_URL,dataDir:process.env.KB_DATA_ROOT,backupDir:process.env.BACKUP_DIR,recipient:process.env.BACKUP_AGE_RECIPIENT,schemaDir:'${root}/packages/db/prisma',runId:'00000000-0000-4000-8000-000000000001',signal:abort.signal,barrier:async phase=>{if(phase==='${stage}'){console.log('BARRIER '+process.pid);await new Promise((_,reject)=>abort.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}}}); }catch{process.exitCode=1;}`,
        );
        const child = spawn(input.supervisor, ["--backup", "--", process.execPath, script], {
          env: {
            ...process.env,
            DATABASE_URL: db.urls.applier,
            KB_DATA_ROOT: dir,
            BACKUP_DIR: dir,
            BACKUP_AGE_RECIPIENT: recipient,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stderr.on("data", (b) => {
          output += b;
        });
        const done = new Promise<number>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolveExit(code ?? 1));
        });
        try {
          const lines = createInterface({ input: child.stdout });
          const pid = await new Promise<number>((resolvePid, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Missing snapshot barrier ${stage}/${kill}: ${output}`)),
              180_000,
            );
            lines.on("line", (line) => {
              const m = line.match(/^BARRIER ([1-9]\d*)$/);
              if (m) {
                clearTimeout(timer);
                lines.close();
                resolvePid(Number(m[1]));
              }
            });
            void done.then(() => {
              clearTimeout(timer);
              lines.close();
              reject(new Error("Snapshot exited before barrier: " + output));
            });
          });
          await expect(startMaintenanceParticipant(db.urls.runtime, () => {})).rejects.toThrow(
            /closed|recovery/,
          );
          process.kill(pid, kill);
          expect(await done).not.toBe(0);
          await expect(
            readFile(join(dir, "backup-00000000-0000-4000-8000-000000000001.age.complete")),
          ).rejects.toThrow();
          expect(await readFile(previous)).toEqual(bytes);
        } finally {
          if (child.exitCode === null) child.kill("SIGTERM");
          await done;
        }
      }
    }
    expect((await readdir(dir)).some((name) => name.startsWith(".kb-cutoff-"))).toBe(true);
    const recovered = await coordinateBackup(input);
    await expect(
      readFile(join(dir, "backup-00000000-0000-4000-8000-000000000001.age")),
    ).rejects.toThrow();
    expect((await readdir(dir)).filter((name) => /^\.kb-(cutoff|backup)-/.test(name))).toEqual([]);
    let successorClosed = false;
    const successor = await startMaintenanceParticipant(db.urls.runtime, () => {
      successorClosed = true;
    });
    expect(successorClosed).toBe(false);
    expect(
      (
        await db.query(
          "applier",
          "SELECT key FROM app_setting WHERE key LIKE 'kb.maintenance.participant.%' LIMIT 2",
        )
      ).rows,
    ).toHaveLength(1);
    await successor.release();
    expect((await readBundle(recovered, identity)).metadata.instanceId).toBe(
      (await readBundle(previous, identity)).metadata.instanceId,
    );
  } finally {
    await permit.release();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 900_000);

it("S3 backup checks remote authority with an empty cache and refuses a disappeared object after encryption", async () => {
  const db = await cluster.createDatabase();
  db.applyPrismaSchema();
  const dir = await mkdtemp(join(tmpdir(), "s3-backup-cutoff-"));
  const remote = await createAssetS3Fixture();
  const hex = createHash("sha256").update("historic").digest("hex"),
    hash = `sha256:${hex}`;
  const key = `/assets/objects/${hex.slice(0, 2)}/${hex.slice(2)}`;
  const object = { bytes: Buffer.from("historic"), metadata: { sha256: hex, size: "8" } };
  const environment = {
    KB_ASSET_S3_ENABLED: "true",
    KB_ASSET_S3_BUCKET: "assets",
    KB_ASSET_S3_ENDPOINT: remote.endpoint,
    KB_ASSET_S3_REGION: "us-east-1",
    KB_ASSET_S3_FORCE_PATH_STYLE: "true",
    KB_ASSET_S3_ACCESS_KEY_ID: "runtime-comparison-fixture",
    KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "operator-fixture",
    KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "operator-secret-fixture",
  };
  const barrier = createHttpServer((_req, res) => {
    remote.objects.delete(key);
    res.end("done");
  });
  await new Promise<void>((r) => barrier.listen(0, "127.0.0.1", r));
  try {
    await mkdir(join(dir, "repos/.private"), { recursive: true });
    for (const name of ["server", "worker"])
      await writeFile(join(dir, `repos/.private/${name}.fence`), "");
    await mkdir(join(dir, "assets/objects"), { recursive: true });
    await writeFile(join(dir, "assets/objects", "corrupt-cache-must-not-be-walked"), "ignored");
    const identity = join(dir, "identity");
    execFileSync("age-keygen", ["-o", identity], { stdio: "pipe" });
    const recipient = execFileSync("age-keygen", ["-y", identity], { encoding: "utf8" }).trim();
    await db.query(
      "applier",
      `INSERT INTO asset_blob(hash,size,mime) VALUES($1,8,'application/octet-stream')`,
      [hash],
    );
    const locator = assetS3Locator({
      bucket: "assets",
      endpoint: remote.endpoint,
      region: "us-east-1",
      prefix: "",
      forcePathStyle: true,
    });
    await db.query(
      "applier",
      `INSERT INTO app_setting(key,value,"createdAt","updatedAt") VALUES('kb.asset-storage',$1,now(),now()),('kb.maintenance.request','offline',now(),now())`,
      [JSON.stringify({ version: 1, mode: "s3", activeGeneration: randomUUID(), locator })],
    );
    remote.objects.set(key, object);
    const runId = randomUUID(),
      script = join(dir, "snapshot.mjs");
    await writeFile(
      script,
      `import {snapshotOffline} from ${JSON.stringify(join(root, "scripts/lib/kb-backup.mjs"))};const abort=new AbortController();process.on('SIGTERM',()=>abort.abort());try{await snapshotOffline({connectionString:process.env.DATABASE_URL,dataDir:process.env.KB_DATA_ROOT,backupDir:process.env.KB_DATA_ROOT,recipient:process.env.BACKUP_AGE_RECIPIENT,schemaDir:${JSON.stringify(join(root, "packages/db/prisma"))},runId:${JSON.stringify(runId)},signal:abort.signal,barrier:async stage=>{if(stage==='encryption') await fetch(process.env.BARRIER);}});}catch{process.exitCode=1;}`,
    );
    const child = spawn(
      join(root, "apps/server/native/kb-supervisor"),
      ["--backup", "--", process.execPath, script],
      {
        env: {
          PATH: process.env.PATH,
          ...environment,
          DATABASE_URL: db.urls.applier,
          KB_DATA_ROOT: dir,
          BACKUP_AGE_RECIPIENT: recipient,
          BARRIER: `http://127.0.0.1:${(barrier.address() as { port: number }).port}`,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let error = "";
    child.stderr.on("data", (b) => {
      error += b;
    });
    const code = await new Promise<number | null>((r, j) => {
      child.once("error", j);
      child.once("close", r);
    });
    expect(code, error).not.toBe(0);
    expect(
      (await readdir(dir)).filter((n) => n.endsWith(".age") || n.endsWith(".complete")),
    ).toEqual([]);
    expect(
      (
        await db.query(
          "applier",
          `SELECT 1 FROM audit_event WHERE action='BACKUP_RESULT' AND outcome='SUCCESS' LIMIT 1`,
        )
      ).rows,
    ).toEqual([]);
    remote.objects.set(key, object);
    const file = await coordinateBackup({
      connectionString: db.urls.applier,
      dataDir: dir,
      backupDir: dir,
      recipient,
      supervisor: join(root, "apps/server/native/kb-supervisor"),
      assetEnvironment: environment,
    });
    const bundle = await readBundle(file, identity);
    expect(bundle.metadata.version).toBe(3);
    expect(bundle.files.filter((e) => e.path.startsWith("assets/"))).toEqual([]);
    expect(
      remote.requests.every(
        (r) => r.method === "HEAD" && String(r.headers.authorization).includes("operator-fixture"),
      ),
    ).toBe(true);
  } finally {
    await new Promise<void>((r, j) => barrier.close((e) => (e ? j(e) : r())));
    await remote.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
