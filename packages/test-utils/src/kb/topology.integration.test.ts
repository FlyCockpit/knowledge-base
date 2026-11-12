import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_HTTP_BACKEND_PATH } from "@knowledge-base/env/topology";
import {
  CONSUMER_HEARTBEAT_TTL_MS,
  createConsumerHeartbeat,
  hasExternalConsumer,
} from "@knowledge-base/queue/consumer-health";
import { QUEUE_NAMES } from "@knowledge-base/queue/jobs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { drainDockerFixtures, removeDockerContainer, withDockerContainer } from "./docker.js";
import { NODE_BASE_IMAGE } from "./node-image.mjs";

afterEach(drainDockerFixtures, 300_000);

import { openKbRedisFromEnv } from "./index.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const redis = openKbRedisFromEnv();

afterAll(async () => {
  await redis.close();
});

const exec = promisify(execFile);
async function docker(args: string[], options?: { reject?: boolean; timeout?: number }) {
  try {
    const result = await exec("docker", args, { timeout: options?.timeout ?? 60_000 });
    return { status: 0, ...result };
  } catch (error) {
    if (options?.reject !== false) throw error;
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { status: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function readyStatus(origin: string): Promise<number> {
  const response = await fetch(`${origin}/ready`);
  return response.status;
}

describe("dedicated worker topology", () => {
  it("server source never imports or starts a worker consumer", () => {
    const lifecycle = readFileSync(join(ROOT, "apps/server/src/lifecycle.ts"), "utf8");
    const index = readFileSync(join(ROOT, "apps/server/src/index.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(join(ROOT, "apps/server/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.worker).toBeUndefined();
    expect(lifecycle).not.toContain("startWorkerRuntime");
    expect(lifecycle).not.toContain("worker/runtime");
    expect(index).toContain("hasExternalConsumer(redisConnection, Object.values(QUEUE_NAMES))");
    expect(index).not.toContain("startWorkerRuntime");
    expect(GIT_HTTP_BACKEND_PATH).toBe("/usr/lib/git-core/git-http-backend");
    const entrypoint = readFileSync(join(ROOT, "scripts/docker-entrypoint.sh"), "utf8");
    expect(entrypoint).toMatch(/kb_volume_role=server/);
    expect(entrypoint).toMatch(/kb_volume_role=worker/);
    // Role-free skeleton repair runs after the mount-root runtime check.
    expect(entrypoint).toContain("  node /app/scripts/init-kb-volumes.mjs\n");
    expect(entrypoint).not.toContain("--role");
    expect(entrypoint.indexOf("--check-runtime")).toBeLessThan(
      entrypoint.indexOf("  node /app/scripts/init-kb-volumes.mjs\n"),
    );
  });

  it("removes a named fixture when an attached Docker run times out", async () => {
    const name = `kb-topology-timeout-${randomUUID()}`;
    try {
      const pending = withDockerContainer(name, async () => {
        // Ensure a real container exists before timing out its attached client.
        await docker([
          "create",
          "--name",
          name,
          "--network=none",
          "--pull=never",
          NODE_BASE_IMAGE,
          "sleep",
          "infinity",
        ]);
        expect(
          (await docker(["inspect", "--format", "{{.State.Status}}", name])).stdout.trim(),
        ).toBe("created");
        await exec("docker", ["start", "--attach", name], {
          timeout: 1000,
          killSignal: "SIGKILL",
        });
      });
      const rejected = expect(pending).rejects.toMatchObject({ killed: true });
      // A test deadline can abandon its action. The teardown boundary must join
      // that still-running action and its removal before the suite exits.
      await drainDockerFixtures();
      await rejected;
      expect((await docker(["ps", "-aq", "--filter", `name=^/${name}$`])).stdout.trim()).toBe("");
    } finally {
      await docker(["rm", "--force", name], { reject: false });
    }
  }, 180_000);

  it("joins a following Docker fixture registered by an abandoned action", async () => {
    const firstName = `kb-topology-first-${randomUUID()}`;
    const nextName = `kb-topology-next-${randomUUID()}`;
    let finished = false;
    const create = (name: string) =>
      docker([
        "create",
        "--name",
        name,
        "--network=none",
        "--pull=never",
        NODE_BASE_IMAGE,
        "sleep",
        "infinity",
      ]);
    const first = withDockerContainer(firstName, () => create(firstName));
    const following = first.then(() =>
      withDockerContainer(nextName, async () => {
        await create(nextName);
        try {
          await exec("docker", ["start", "--attach", nextName], {
            timeout: 1000,
            killSignal: "SIGKILL",
          });
        } finally {
          finished = true;
        }
      }),
    );
    const rejected = expect(following).rejects.toMatchObject({ killed: true });
    try {
      await drainDockerFixtures();
      expect(finished, "teardown must join the next registered fixture").toBe(true);
      await rejected;
      for (const name of [firstName, nextName])
        expect((await docker(["ps", "-aq", "--filter", `name=^/${name}$`])).stdout.trim()).toBe("");
    } finally {
      await Promise.allSettled([first, following, rejected]);
      for (const name of [firstName, nextName])
        await docker(["rm", "--force", name], { reject: false });
    }
  }, 300_000);

  describe("one data volume", () => {
    const server = `kb-topology-server-${randomUUID()}`;
    const worker = `kb-topology-worker-${randomUUID()}`;
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const volumes: string[] = [];
    let root: string;
    let data: string;
    let setup: Promise<void> | undefined;

    // A Docker named volume lives on the daemon's local disk (the host /tmp may
    // be tmpfs). Mounted at a path absent from the image it gets no copy-up, so
    // it is an empty, operator-provisioned root like an empty bind mount.
    async function emptyVolume(): Promise<string> {
      const name = `kb-topology-data-${randomUUID()}`;
      volumes.push(name);
      await docker(["volume", "create", name]);
      await docker([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "-u",
        "0",
        "-v",
        `${name}:/data`,
        NODE_BASE_IMAGE,
        "chown",
        "1000:1000",
        "/data",
      ]);
      return name;
    }
    async function checkData(mounts: string[]) {
      const name = `kb-topology-check-${randomUUID()}`;
      return withDockerContainer(name, () =>
        docker(
          [
            "run",
            "--rm",
            "--pull=never",
            "--network=none",
            "--name",
            name,
            "--user",
            "1000:1000",
            "-e",
            "KB_DATA_ROOT=/var/lib/knowledge-base",
            "-v",
            `${join(ROOT, "scripts/init-kb-volumes.mjs")}:/init.mjs:ro`,
            ...mounts.flatMap((mount) => ["-v", mount]),
            NODE_BASE_IMAGE,
            "sh",
            "-c",
            "node -e \"import('/init.mjs').then(m=>{m.checkDataVolume();console.log('admitted')})\" && node /init.mjs && test -d /var/lib/knowledge-base/models/.private/tmp && test -d /var/lib/knowledge-base/index && test -f /var/lib/knowledge-base/repos/.private/worker.fence",
          ],
          { reject: false, timeout: 120_000 },
        ),
      );
    }

    beforeAll(() => {
      // Image/startup is infrastructure, not a 30s volume-operation deadline.
      setup = (async () => {
        root = mkdtempSync(join(tmpdir(), "kb-topo-"));
        data = join(root, "data");
        mkdirSync(data);
        // The containers run --pull=never; fetch the digest-pinned base once if absent.
        if ((await docker(["image", "inspect", NODE_BASE_IMAGE], { reject: false })).status !== 0)
          await docker(["pull", NODE_BASE_IMAGE], { timeout: 300_000 });
        const starts = await Promise.allSettled(
          [server, worker].map((name) =>
            docker(
              [
                "run",
                "--detach",
                "--rm",
                "--pull=never",
                "--network=none",
                "--user",
                user,
                "--name",
                name,
                "-e",
                "KB_DATA_ROOT=/var/lib/knowledge-base",
                "-v",
                `${join(ROOT, "scripts/init-kb-volumes.mjs")}:/init.mjs:ro`,
                "-v",
                `${data}:/var/lib/knowledge-base`,
                NODE_BASE_IMAGE,
                "sleep",
                "infinity",
              ],
              { timeout: 180_000 },
            ),
          ),
        );
        for (const result of starts) {
          if (result.status === "rejected") throw result.reason;
        }
      })();
      return setup;
    }, 180_000);

    afterAll(async () => {
      // Joining startup precedes removal, including failed/timed-out setup.
      await setup?.catch(() => {});
      try {
        const removals = await Promise.allSettled([server, worker].map(removeDockerContainer));
        for (const result of removals) {
          if (result.status === "rejected") throw result.reason;
        }
      } finally {
        for (const name of volumes) await docker(["volume", "rm", "-f", name], { reject: false });
        if (root) rmSync(root, { recursive: true, force: true });
      }
    }, 180_000);

    it("role-free nonroot init creates the whole skeleton, including models and index", async () => {
      const initialized = await docker([
        "exec",
        worker,
        "sh",
        "-c",
        "node /init.mjs && test -d /var/lib/knowledge-base/repos/.private/tmp && test -d /var/lib/knowledge-base/assets/.private/staging && test -d /var/lib/knowledge-base/models/.private/tmp && test -d /var/lib/knowledge-base/index",
      ]);
      expect(initialized.status).toBe(0);
      for (const path of ["repos/.private/server.fence", "models/.private/tmp", "index"])
        expect(existsSync(join(data, path)), path).toBe(true);
      // Repair is idempotent from either container.
      expect((await docker(["exec", server, "node", "/init.mjs"])).status).toBe(0);
    });

    it("both roles write and read every surface of the one read-write volume", async () => {
      for (const [writer, reader] of [
        [server, worker],
        [worker, server],
      ] as const) {
        const written = await docker([
          "exec",
          writer,
          "sh",
          "-c",
          `for d in repos assets models index; do mkdir -p /var/lib/knowledge-base/$d && echo ${writer} > /var/lib/knowledge-base/$d/from-${writer}; done`,
        ]);
        expect(written.status).toBe(0);
        const read = await docker([
          "exec",
          reader,
          "sh",
          "-c",
          `for d in repos assets models index; do cat /var/lib/knowledge-base/$d/from-${writer}; done`,
        ]);
        expect(read.stdout).toBe(`${writer}\n`.repeat(4));
      }
    });

    it("an empty mount passes the runtime volume check, then receives the skeleton", async () => {
      const volume = await emptyVolume();
      const result = await checkData([`${volume}:/var/lib/knowledge-base`]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("admitted");
    }, 180_000);

    it("a read-only data mount or a sub-mount below the data root is refused", async () => {
      const volume = await emptyVolume();
      const readOnly = await checkData([`${volume}:/var/lib/knowledge-base:ro`]);
      expect(readOnly.status).not.toBe(0);
      expect(readOnly.stdout).not.toContain("admitted");
      expect(readOnly.stderr).toMatch(/KB data volume invalid/);
      const nested = await emptyVolume();
      const subMount = await checkData([
        `${volume}:/var/lib/knowledge-base`,
        `${nested}:/var/lib/knowledge-base/repos`,
      ]);
      expect(subMount.status).not.toBe(0);
      expect(subMount.stdout).not.toContain("admitted");
      expect(subMount.stderr).toMatch(/KB data volume invalid/);
    }, 180_000);
  });

  it("missing worker consumers are 503, registration is ready, expiry returns 503", async () => {
    const inventory = Object.values(QUEUE_NAMES);
    const client = redis.client();
    const server = createServer((req, res) => {
      if (req.url !== "/ready") {
        res.writeHead(404);
        res.end();
        return;
      }
      void hasExternalConsumer(client, inventory).then((workers) => {
        res.writeHead(workers ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: workers, checks: { workers } }));
      });
    });
    const origin = await new Promise<string>((resolveOrigin, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("ready fixture did not bind"));
          return;
        }
        resolveOrigin(`http://127.0.0.1:${address.port}`);
      });
    });
    try {
      expect(await hasExternalConsumer(client, inventory)).toBe(false);
      expect(await readyStatus(origin)).toBe(503);
      const heartbeat = createConsumerHeartbeat(client, inventory, () => true);
      await heartbeat.start();
      expect(await hasExternalConsumer(client, inventory)).toBe(true);
      expect(await readyStatus(origin)).toBe(200);
      const expiryKey = `knowledge-base:consumers:external:${inventory[0]}`;
      const [replicaId] = await client.zrange(expiryKey, "0", "-1");
      expect(replicaId).toBeTruthy();
      await client.zadd(expiryKey, "0", String(replicaId));
      expect(await hasExternalConsumer(client, inventory)).toBe(false);
      expect(await readyStatus(origin)).toBe(503);
      expect(CONSUMER_HEARTBEAT_TTL_MS).toBe(15_000);
      await heartbeat.stop();
    } finally {
      await new Promise<void>((closeResolve, closeReject) => {
        server.close((error) => (error ? closeReject(error) : closeResolve()));
      });
    }
  });
});
