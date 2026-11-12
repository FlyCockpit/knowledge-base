/** Explicit operations smoke; owns disposable services and never loads the root .env. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prisma, tempConfig } from "./db/lib/prisma.mjs";
import { POSTGRES_IMAGE } from "./test-kb.mjs";

const REDIS_IMAGE =
  "valkey/valkey:9.1.3-alpine@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(import.meta.url);

async function runtimeCheck() {
  const [{ startWorkerRuntime }, queues, { default: prisma }, health] = await Promise.all([
    import("../apps/worker/src/runtime.ts"),
    import("../packages/queue/src/index.ts"),
    import("../packages/db/src/index.ts"),
    import("../packages/queue/src/consumer-health.ts"),
  ]);
  // This worker-only fixture starts after server initialization. Seed the disk
  // authority marker in its owned empty database; production workers still cannot create it.
  await prisma.appSetting.create({
    data: {
      key: "kb.asset-storage",
      value: JSON.stringify({ version: 1, mode: "disk", activeGeneration: randomUUID() }),
    },
  });
  const inventory = Object.values(queues.QUEUE_NAMES);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  // Adjacent-release regression against actual Redis Lua: the old inventory
  // stays live while the new server needs an additional queue. Its heartbeat
  // must never admit that server, even after the old worker republishes.
  const old = health.createConsumerHeartbeat(queues.redisConnection, ["echo"], () => true);
  await old.start();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, ["echo"]), true);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
  const replacement = health.createConsumerHeartbeat(queues.redisConnection, ["echo"], () => true);
  await replacement.start();
  await old.stop();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, ["echo"]), true);
  await replacement.stop();
  const expiringQueue = `heartbeat-expiry-${randomUUID()}`;
  const expiring = health.createConsumerHeartbeat(
    queues.redisConnection,
    [expiringQueue],
    () => true,
  );
  await expiring.start();
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), true);
  const expiryKey = `knowledge-base:consumers:external:${expiringQueue}`;
  const [replicaId] = await queues.redisConnection.zrange(expiryKey, 0, -1);
  assert.ok(replicaId);
  // Model a crashed publisher's expired score without waiting fifteen seconds.
  // The actual production read Lua must use Redis TIME and reject that score.
  await queues.redisConnection.zadd(expiryKey, 0, replicaId);
  assert.equal(await health.hasExternalConsumer(queues.redisConnection, [expiringQueue]), false);
  await expiring.stop();
  const fatal = [];
  let runtime;
  try {
    runtime = await startWorkerRuntime({
      onFatal: (error) => fatal.push(error),
    });
    assert.equal(runtime.isReady(), true);
    assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), true);
    assert.equal(
      await health.hasExternalConsumer(queues.redisConnection, [
        ...inventory,
        "next-release-queue",
      ]),
      false,
    );
    const id = `runtime-${randomUUID()}`;
    const message = "disposable external echo";
    const job = await queues.echoQueue.add("echo", { message }, { jobId: id });
    const deadline = Date.now() + 15_000;
    while ((await job.getState()) !== "completed" && Date.now() < deadline) await delay(50);
    assert.equal(await job.getState(), "completed");
    assert.deepEqual((await queues.echoQueue.getJob(id)).returnvalue, { echoed: message });
    assert.equal(
      (await prisma.appSetting.findUnique({ where: { key: "echo:last" } })).value,
      message,
    );
    const stopping = runtime.stop();
    assert.equal(runtime.isReady(), false);
    assert.equal(runtime.stop(), stopping);
    await stopping;
    assert.equal(await health.hasExternalConsumer(queues.redisConnection, inventory), false);
    await assert.rejects(startWorkerRuntime({ onFatal: () => {} }), /already started/);
    assert.deepEqual(fatal, []);
    console.log("external: schema-backed echo, readiness, withdrawal, drain, and re-entry passed.");
  } finally {
    await runtime?.stop();
    await Promise.all(
      Object.values(queues)
        .filter((value) => value instanceof queues.Queue)
        .map((queue) => queue.close()),
    );
    queues.redisConnection.disconnect();
    await prisma.$disconnect();
  }
}

async function main() {
  if (process.argv[2] === "--runtime-child") {
    assert.equal(process.env.RUNTIME_OPERATIONS_CHILD, "owned-disposable-services");
    await runtimeCheck();
    return;
  }
  if (process.argv[2] !== "--disposable-services") {
    throw new Error("Use node scripts/test-runtime-operations.mjs --disposable-services.");
  }
  const environment = { PATH: process.env.PATH };
  const docker = (...args) => {
    try {
      return execFileSync("docker", args, {
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      }).trim();
    } catch (error) {
      throw new Error(`Runtime Docker ${args[0]} failed (${error.code ?? "nonzero"}).`);
    }
  };
  for (const image of [POSTGRES_IMAGE, REDIS_IMAGE]) {
    docker("image", "inspect", image, "--format", "{{.Id}}");
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "template-runtime-operations-"));
  const containers = [];
  const workerImage = `template-runtime-worker-base:${randomUUID()}`;
  let ownsWorkerImage = false;
  try {
    // The runtime checks Git >=2.45 during startup; the bare Node image lacks Git.
    // Reuse the shipped worker base, including its PG18 client and Git toolchain.
    execFileSync(
      "docker",
      [
        "build",
        "--target",
        "base",
        "-f",
        resolve(root, "Dockerfile.worker"),
        "-t",
        workerImage,
        root,
      ],
      { env: environment, timeout: 300_000, stdio: "pipe" },
    );
    ownsWorkerImage = true;
    const password = randomUUID();
    const postgresName = `template-runtime-pg-${randomUUID()}`;
    const redisName = `template-runtime-redis-${randomUUID()}`;
    containers.push(postgresName, redisName);
    const postgres = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      postgresName,
      "--memory",
      "256m",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=256m",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      POSTGRES_IMAGE,
    );
    const redis = docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      redisName,
      "--memory",
      "64m",
      "--publish",
      "127.0.0.1::6379",
      REDIS_IMAGE,
      "valkey-server",
      "--save",
      "",
      "--appendonly",
      "no",
      "--maxmemory",
      "32mb",
      "--maxmemory-policy",
      "noeviction",
    );
    const port = (id, mapping) => {
      const value = docker("port", id, mapping).split(":").at(-1);
      assert.match(value, /^\d+$/);
      return value;
    };
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port(postgres, "5432/tcp")}/postgres`;
    const redisUrl = `redis://127.0.0.1:${port(redis, "6379/tcp")}`;
    for (let attempt = 0; ; attempt++) {
      try {
        docker("exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "postgres");
        break;
      } catch {
        if (attempt === 49) throw new Error("Disposable PostgreSQL did not become ready.");
        await delay(100);
      }
    }
    // Copy the real Prisma config and schema away from root .env. Only installed
    // packages are linked; dotenv resolves a missing file inside this fixture.
    // One data volume (KB_DATA_ROOT) holding repos/, assets/ and models/.
    const dataDir = resolve(temporary, "data");
    const modelsDir = resolve(dataDir, "models");
    for (const sub of ["repos", "assets", "models"])
      mkdirSync(resolve(dataDir, sub), { recursive: true });
    const fixtureEnv = {
      ...environment,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      NODE_ENV: "production",
      KB_ASSET_S3_ENABLED: "false",
      BACKUP_ENABLED: "false",
      KB_DATA_ROOT: dataDir,
    };
    const config = tempConfig({ url: databaseUrl });
    try {
      for (const operation of ["empty database", "unchanged migrations"]) {
        await prisma(["migrate", "deploy", "--config", config], {
          env: fixtureEnv,
          timeoutMs: 180_000,
        });
        console.log(`Committed migrations with real Prisma: ${operation} passed.`);
      }
    } finally {
      rmSync(resolve(config, ".."), { recursive: true, force: true });
    }
    // The real worker requires a private mirror tmpfs and mounts the one data
    // volume read-write. Run the operations child under those OS boundaries.
    const childEnvFile = resolve(temporary, "worker.env");
    const childEnvironment = {
      ...fixtureEnv,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TMPDIR: modelsDir,
      MIGRATE_ON_START: "false",
      RUNTIME_OPERATIONS_CHILD: "owned-disposable-services",
    };
    writeFileSync(
      childEnvFile,
      Object.entries(childEnvironment)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      { mode: 0o600 },
    );
    const workerName = `template-runtime-worker-${randomUUID()}`;
    containers.push(workerName);
    const result = execFileSync(
      "docker",
      [
        "run",
        "--name",
        workerName,
        "--network",
        "host",
        "--cpus=1",
        "--memory=512m",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--tmpfs",
        `/run/kb-mirror:rw,noexec,nosuid,nodev,size=16m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`,
        "--env-file",
        childEnvFile,
        "--workdir",
        root,
        "--volume",
        `${root}:${root}:ro`,
        ...(existsSync(resolve(root, ".env")) ? ["--volume", `/dev/null:${root}/.env:ro`] : []),
        "--volume",
        `${dataDir}:${dataDir}:rw`,
        "--entrypoint",
        "node",
        workerImage,
        "--import",
        "tsx",
        file,
        "--runtime-child",
      ],
      {
        env: environment,
        timeout: 45_000,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
    process.stdout.write(result);
  } finally {
    const cleanupErrors = [];
    for (const id of containers.reverse()) {
      try {
        docker("rm", "--force", id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (ownsWorkerImage) {
      try {
        docker("image", "rm", workerImage);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error("Disposable fixture cleanup failed; inspect this run's owned containers.");
      process.exitCode = 1;
    } else {
      console.log("Removed only this smoke run's disposable containers and temporary fixture.");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Runtime operations check failed.");
  process.exitCode = 1;
}
