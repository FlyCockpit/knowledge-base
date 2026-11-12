/** Built service boundaries contain import-time and runtime driver failures.
 * Each driver owns connection syntax; neither a diagnostic nor an inherited
 * stdout/stderr writer can forward credential-bearing content. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { buildArtifactPath } from "./build-artifacts.mjs";
import { openKbPostgresClusterFromEnv } from "./postgres";
import { openKbRedisFromEnv } from "./redis";

const ROOT = resolve(import.meta.dirname, "../../../..");
const CANARY = "EntryCanary9Zq7Kp2Xw";

function run(app: "server" | "worker", env: Record<string, string>, killAfterMs: number) {
  const entry = join(ROOT, "apps", app, "dist", "index.mjs");
  if (!existsSync(entry)) throw new Error(`Missing ${entry}; run via pnpm test:kb -- entry-canary`);
  const home = mkdtempSync(join(tmpdir(), "kb-entry-canary-"));
  const data = join(home, "data");
  for (const dir of ["repos/.private", "assets", "models", "index"])
    mkdirSync(join(data, dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(data, "repos/.private/worker.fence"), "");
  return new Promise<{ output: string; code: number | null }>((done) => {
    const child = spawn(process.execPath, [entry, "--fenced"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        NODE_ENV: "development",
        KB_DATA_ROOT: data,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), killAfterMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      done({ output, code });
    });
  });
}

/** Every line is one JSON record (nothing else may reach the process output). */
function records(output: string) {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(
          `non-record output line: ${line.slice(0, 200).replaceAll(CANARY, "<canary>")}`,
        );
      }
    });
}

describe.each(["server", "worker"] as const)("built %s entrypoint", (app) => {
  it.each([
    // The driver rejects these at construction: a configuration failure.
    ["REDIS_URL", `redis://default:${CANARY}@[not-a-host`, "config"],
    ["REDIS_URL", `redis://default:${CANARY}%zz@127.0.0.1:6379`, "config"],
    // node-postgres accepts these and fails to connect: the driver's own code.
    ["DATABASE_URL", `postgresql://kb:${CANARY}%zz@127.0.0.1:1/kb`, "connect"],
    [
      "DATABASE_URL",
      `postgresql://kb:${CANARY}@db.invalid:5432/kb?sslmode=%zz`.replace("db.invalid", "[bad"),
      "connect",
    ],
  ] as const)(
    "credential-bearing %s failures stay within fixed driver startup records",
    async (setting, value, kind) => {
      const { output, code } = await run(
        app,
        {
          DATABASE_URL: "postgresql://kb@127.0.0.1:1/kb",
          REDIS_URL: "redis://127.0.0.1:1",
          BETTER_AUTH_SECRET: "Qx7pL2mZ9vR4tK8wN3cJ6hB1yF5dG0sA",
          BETTER_AUTH_URL: "http://localhost:3999",
          KB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
          [setting]: value,
        },
        60_000,
      );
      expect(code).not.toBe(0);
      expect(output).not.toContain(CANARY);
      const all = records(output);
      if (kind === "config")
        expect(all).toContainEqual(
          expect.objectContaining({
            site: `${app}.startup`,
            stage: "redis",
            errorClass: "ConnectionConfigError",
            setting,
            reason: "DRIVER_REJECTED",
          }),
        );
      else {
        // A connect failure is never relabelled as a DATABASE_URL configuration error.
        const failure = all.find((record) => record.site === `${app}.startup`);
        expect(failure).toMatchObject({ errorCode: expect.stringMatching(/^[A-Z0-9_]+$/) });
        expect(failure).not.toHaveProperty("setting");
        expect(failure?.errorClass).not.toBe("ConnectionConfigError");
      }
    },
    120_000,
  );

  it("tells a volume fence held by another process apart from other startup failures", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-entry-fence-"));
    const data = join(home, "data");
    mkdirSync(join(data, "repos/.private"), { recursive: true, mode: 0o700 });
    writeFileSync(join(data, "repos/.private/worker.fence"), "");
    const supervisor = join(ROOT, "apps/server/native/kb-supervisor");
    const holder = spawn(
      supervisor,
      [...(app === "worker" ? ["--worker"] : []), "--", "sleep", "60"],
      { env: { PATH: process.env.PATH ?? "", KB_DATA_ROOT: data }, stdio: "ignore" },
    );
    const held = new Promise((done) => holder.once("close", done));
    try {
      await delay(500);
      const { output, code } = await run(app, { KB_DATA_ROOT: data }, 30_000);
      expect(code).toBe(85);
      const all = records(output);
      expect(all).toContainEqual({
        level: "error",
        site: "supervisor.fatal",
        message: "native supervisor could not start",
        reason: "FENCE_HELD",
        exitCode: 85,
      });
      expect(all).toContainEqual(
        expect.objectContaining({ site: "service.exit", service: app, exitCode: 85 }),
      );
    } finally {
      holder.kill("SIGTERM");
      await held;
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([
    ["SMTP_FROM", "SMTP_FROM_MISSING", { SMTP_HOST: "smtp.example.com" }],
    ...(app === "server"
      ? ([
          ["BETTER_AUTH_URL", "HTTPS_REQUIRED", { BETTER_AUTH_URL: "http://example.com" }],
          ["BETTER_AUTH_SECRET", "WEAK_SECRET", { BETTER_AUTH_SECRET: "x".repeat(32) }],
        ] as const)
      : []),
  ] as const)(
    "production %s carries closed, distinguishable startup detail",
    async (setting, reason, overrides) => {
      const { output, code } = await run(
        app,
        {
          NODE_ENV: "production",
          DATABASE_URL: `postgresql://kb:${CANARY}@127.0.0.1:1/kb`,
          REDIS_URL: `redis://default:${CANARY}@127.0.0.1:1`,
          BETTER_AUTH_SECRET: "Qx7pL2mZ9vR4tK8wN3cJ6hB1yF5dG0sA",
          BETTER_AUTH_URL: "https://example.com",
          ...overrides,
        },
        30_000,
      );
      expect(code).not.toBe(0);
      expect(output).not.toContain(CANARY);
      expect(records(output)).toContainEqual(
        expect.objectContaining({
          site: `${app}.startup`,
          errorClass: "EnvValidationError",
          setting,
          reason,
          stage: "import",
        }),
      );
    },
    60_000,
  );

  it("an unreachable, credential-bearing REDIS_URL logs only fixed connection records", async () => {
    const { output } = await run(
      app,
      {
        REDIS_URL: `redis://default:${CANARY}@127.0.0.1:1`,
        DATABASE_URL: `postgresql://kb:${CANARY}@127.0.0.1:1/kb`,
        BETTER_AUTH_SECRET: "Qx7pL2mZ9vR4tK8wN3cJ6hB1yF5dG0sA",
        BETTER_AUTH_URL: "http://localhost:3999",
        KB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
      15_000,
    );
    expect(output).not.toContain(CANARY);
    records(output);
  }, 60_000);
});

// Exercise the shipped app and Better Auth router, not a replacement request handler.
it("built server keeps real reset-password and verification URLs out of output", async () => {
  const cluster = await openKbPostgresClusterFromEnv();
  const redis = openKbRedisFromEnv();
  const home = mkdtempSync(join(tmpdir(), "kb-request-canary-"));
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  let output = "";
  try {
    const db = await cluster.createDatabase();
    db.applyPrismaSchema();
    const data = join(home, "data");
    for (const dir of ["repos/.private", "assets", "models", "index"])
      mkdirSync(join(data, dir), { recursive: true, mode: 0o700 });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    const requestedPort = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    child = spawn(process.execPath, [join(ROOT, "apps/server/dist/index.mjs"), "--fenced"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        NODE_ENV: "development",
        DATABASE_URL: db.urls.applier,
        REDIS_URL: redis.url,
        KB_DATA_ROOT: data,
        BETTER_AUTH_SECRET: "Qx7pL2mZ9vR4tK8wN3cJ6hB1yF5dG0sA",
        BETTER_AUTH_URL: "http://localhost:3999",
        SERVER_PORT: String(requestedPort),
        KB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", () => resolve());
    });
    void closed.catch(() => {});
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr!.on("data", (chunk) => {
      output += chunk;
    });
    const appRecords = () => records(output.slice(0, output.lastIndexOf("\n") + 1));
    let port: number | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      const listening = appRecords().find((record) => record.site === "server.listening");
      if (typeof listening?.port === "number") {
        port = listening.port;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    expect(port, `server did not listen: ${output.replaceAll(CANARY, "<canary>")}`).toBeGreaterThan(
      0,
    );
    const origin = `http://127.0.0.1:${port}`;
    for (const path of [
      `/api/auth/reset-password/${CANARY}?callbackURL=%2Fen-US%2Freset`,
      `/api/auth/verify-email?token=${CANARY}&callbackURL=%2Fen-US`,
    ]) {
      const response = await fetch(`${origin}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (appRecords().filter((record) => record.site === "http.request").length === 2) break;
      await delay(10);
    }
    const requests = appRecords().filter((record) => record.site === "http.request");
    expect(requests).toHaveLength(2);
    for (const record of requests)
      expect(record).toMatchObject({ route: "/api/auth/*", method: "GET" });
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain("callbackURL");
  } finally {
    if (child && closed) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 30_000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
    await redis.close();
    await cluster.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

it("built output owner drops a CommonJS library's console, aliases, fs writes and native child text", async () => {
  const home = mkdtempSync(join(tmpdir(), "kb-output-canary-"));
  try {
    const library = join(home, "library.cjs");
    const childEntry = join(home, "child.cjs");
    const secret = JSON.stringify(`password=${CANARY}`);
    writeFileSync(
      library,
      `
      console.warn(${secret});
      const p = process;
      p.stderr.write(${secret});
      const { stderr } = require("node:process");
      stderr.write(${secret});
      const fs = require("node:fs");
      fs.writeSync(1, ${secret});
      fs.write(2, Buffer.from(${secret}), () => {});
      require("node:util").promisify(fs.write)(2, ${secret}).then(({bytesWritten, buffer}) => {
        if (bytesWritten !== Buffer.byteLength(${secret}) || buffer !== ${secret})
          throw new Error("promisify result changed");
      });
      // Ordinary file writes still work, including the overloaded callbacks.
      fs.writeFileSync(${JSON.stringify(join(home, "file"))}, "ok");
      console.dir({ get secret() { throw new Error("inspection must not run"); } });
      fs.writeFileSync(1, ${secret});
      fs.writevSync(1, [Buffer.from(${secret})]);
      fs.writev(2, [Buffer.from(${secret})], () => {});
      const stream = fs.createWriteStream(null, { fd: 2, autoClose: false });
      stream.cork(); stream.write(${secret}); stream.write(${secret}); stream.uncork(); stream.end();
      new (require("node:worker_threads").Worker)(
        'require("node:fs").writeFileSync(1, ' + JSON.stringify(${secret}) + ')', { eval: true });
      require("node:child_process").spawnSync(process.execPath,
        ["-e", 'require("node:fs").writeFileSync(2, ' + JSON.stringify(${secret}) + ')'], { stdio: "inherit" });
      // Even an attacker writing the dedicated channel must satisfy the schema.
      fs.writeSync(3, JSON.stringify({ site: "mcp.tool", level: "error", message: ${secret} }) + "\\n");
      fs.writeSync(3, "x".repeat(20000) + "\\n");
    `,
    );
    writeFileSync(
      childEntry,
      `
      require("node:fs").writeSync(1, ${secret});
      require("node:fs").writeSync(2, ${secret});
      process.send({ t: "library_log", ignored: 'password=EntryCanary9Zq7Kp2Xw' });
      process.send({ t: "ready" });
      process.on("message", (m) => {
        if (m.t === "shutdown") process.exit(0);
        if (m.t === "count") process.send({ t: "counts", token: m.token, counts: [1], limit: 4096 });
      });
    `,
    );
    const { output, code } = await new Promise<{ output: string; code: number | null }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [join(buildArtifactPath("output-canary"), "index.mjs"), library, childEntry],
          {
            cwd: home,
            env: { PATH: process.env.PATH ?? "", HOME: home },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ output, code });
        });
      },
    );
    expect(output).not.toContain(CANARY);
    expect(code, output).toBe(0);
    const all = records(output);
    expect(all).toContainEqual(
      expect.objectContaining({ site: "service.start", service: "worker" }),
    );
    expect(all).toContainEqual(expect.objectContaining({ site: "service.exit", exitCode: 0 }));
    expect(all).toContainEqual(
      expect.objectContaining({ site: "service.records-rejected", count: 2 }),
    );
    const drained = all.filter((record) => record.site === "service.output");
    expect(drained).toHaveLength(2);
    for (const record of drained) expect(record.bytes).toBeGreaterThan(0);
    for (const stream of ["stdout", "stderr"])
      expect(all).toContainEqual(
        expect.objectContaining({
          site: "child.output",
          service: "qwen",
          stream,
          bytes: Buffer.byteLength(`password=${CANARY}`),
        }),
      );
    expect(all).toContainEqual(
      expect.objectContaining({ site: "child.closed", signal: "SIGKILL" }),
    );
    expect(all).toContainEqual(expect.objectContaining({ site: "qwen.library" }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

it.each(["SIGTERM", "SIGINT"] as const)(
  "the output supervisor forwards %s and drains the child's final records",
  async (signal) => {
    const child = spawn(
      process.execPath,
      [join(buildArtifactPath("output-canary"), "index.mjs"), "--signal"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output += bytes;
    });
    try {
      for (let attempt = 0; attempt < 200 && !output.includes('"worker.started"'); attempt++) {
        if (child.exitCode !== null) break;
        await delay(25);
      }
      expect(records(output)).toContainEqual(expect.objectContaining({ site: "worker.started" }));
      child.kill(signal);
      expect(await closed).toBe(0);
      const all = records(output);
      expect(all).toContainEqual(
        expect.objectContaining({ site: "worker.shutdown-start", signal }),
      );
      expect(all).toContainEqual(
        expect.objectContaining({ site: "worker.job-completed", count: 1 }),
      );
      expect(all.at(-1)).toMatchObject({ site: "service.exit", exitCode: 0 });
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed;
    }
  },
  30_000,
);

it("the output supervisor propagates a nonzero service exit code", async () => {
  const child = spawn(
    process.execPath,
    [join(buildArtifactPath("output-canary"), "index.mjs"), "--exit-code"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    output += bytes;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(code).toBe(23);
  expect(records(output).at(-1)).toMatchObject({ site: "service.exit", exitCode: 23 });
}, 30_000);
