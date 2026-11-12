/// <reference path="./pg.d.ts" />
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@knowledge-base/db/client";
import { createPrismaPgAdapter } from "@knowledge-base/db/prisma-adapter";
import { Client, type QueryResult } from "pg";
import { buildArtifactPath } from "./build-artifacts.mjs";

export type KbRoleName = "applier" | "runtime";

export type KbPostgresCluster = {
  id: string;
  host: string;
  port: number;
  superuserPassword: string;
  close(): Promise<void>;
  createDatabase(idOrOptions?: string | { id?: string }): Promise<KbPostgresDatabase>;
};

export type KbPostgresDatabase = {
  id: string;
  database: string;
  urls: Record<KbRoleName, string>;
  query(role: KbRoleName, text: string, values?: unknown[]): Promise<QueryResult>;
  applyPrismaSchema(): void;
  createPrismaClient(role?: KbRoleName): PrismaClient;
  close(): Promise<void>;
};

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const MIGRATION_RUNNER = new URL("../../../../scripts/db/migrate-runtime.mjs", import.meta.url)
  .href;
const PRISMA_OWNER = new URL("../../../../scripts/db/lib/prisma.mjs", import.meta.url).href;
const ROLE_PREFIX: Record<KbRoleName, string> = {
  applier: "kb_applier_",
  runtime: "kb_runtime_",
};

function randomId(): string {
  return randomBytes(4).toString("hex");
}

function encodePassword(password: string): string {
  return encodeURIComponent(password);
}

function roleName(role: KbRoleName, id: string): string {
  return `${ROLE_PREFIX[role]}${id}`;
}

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Refusing unsafe PostgreSQL identifier ${value}`);
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildUrl(input: {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}): string {
  return `postgresql://${encodeURIComponent(input.user)}:${encodePassword(input.password)}@${input.host}:${input.port}/${input.database}`;
}

export function assertTestDatabaseUrl(url: string, expectedId?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refusing unparseable database URL before connecting.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Refusing non-postgres database URL before connecting.");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "");
  if (database === "knowledge_base" || database.length === 0) {
    throw new Error("Refusing shared developer DATABASE_URL before connecting.");
  }
  if (!/^kb_test_[a-z0-9]+$/.test(database)) {
    throw new Error(`Refusing non-test database ${database} before connecting.`);
  }
  const id = database.slice("kb_test_".length);
  if (expectedId && id !== expectedId) {
    throw new Error(`Database ${database} does not match fixture ${expectedId}.`);
  }
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("Refusing non-loopback database URL before connecting.");
  }
  const user = decodeURIComponent(parsed.username);
  const allowed = new Set<string>([roleName("applier", id), roleName("runtime", id)]);
  if (!allowed.has(user)) {
    throw new Error(`Refusing non-fixture role ${user || "<empty>"} before connecting.`);
  }
  return parsed;
}

function assertClusterEnv(): {
  id: string;
  host: string;
  port: number;
  superuserPassword: string;
} {
  const id = process.env.KB_TEST_ID;
  const host = process.env.KB_TEST_PG_HOST;
  const portText = process.env.KB_TEST_PG_PORT;
  const superuserPassword = process.env.KB_TEST_PG_SUPERUSER_PASSWORD;
  if (!id || !host || !portText || !superuserPassword) {
    throw new Error("KB postgres fixtures require pnpm test:kb (missing KB_TEST_* cluster env).");
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("KB postgres fixtures received a malformed KB_TEST_PG_PORT.");
  }
  return { id, host, port, superuserPassword };
}

async function connect(url: string): Promise<Client> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 5_000,
  });
  client.on("error", () => {});
  await client.connect();
  return client;
}

async function withAdmin<T>(
  cluster: { host: string; port: number; superuserPassword: string },
  database: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  if (database === "knowledge_base") {
    throw new Error("Refusing shared developer DATABASE_URL before connecting.");
  }
  const url = buildUrl({
    user: "postgres",
    password: cluster.superuserPassword,
    host: cluster.host,
    port: cluster.port,
    database,
  });
  const client = await connect(url);
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * `pnpm test:kb` pins a non-UTC Node TZ and a distinct non-UTC PostgreSQL
 * TimeZone (scripts/test-kb.mjs). Fail closed if either did not take effect,
 * so a UTC sandbox cannot silently hide an offset bug.
 */
async function assertPinnedTimeZones(cluster: {
  host: string;
  port: number;
  superuserPassword: string;
}): Promise<void> {
  const expectedTz = process.env.KB_TEST_TZ;
  const expectedPg = process.env.KB_TEST_PG_TIMEZONE;
  if (!expectedTz || !expectedPg) {
    throw new Error(
      "KB postgres fixtures require pnpm test:kb (missing KB_TEST_TZ / KB_TEST_PG_TIMEZONE).",
    );
  }
  const canonical = (zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  const processTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (processTz !== canonical(expectedTz)) {
    throw new Error(`Node TZ is ${processTz}, expected the pinned ${expectedTz}.`);
  }
  const sessionTz = await withAdmin(cluster, "postgres", async (admin) => {
    const result = await admin.query("SELECT current_setting('TimeZone') AS tz");
    return String(result.rows[0]?.tz);
  });
  if (sessionTz !== expectedPg) {
    throw new Error(`PostgreSQL TimeZone is ${sessionTz}, expected the pinned ${expectedPg}.`);
  }
}

export async function openKbPostgresClusterFromEnv(): Promise<KbPostgresCluster> {
  const env = assertClusterEnv();
  await assertPinnedTimeZones(env);
  const databases = new Set<KbPostgresDatabase>();
  return {
    id: env.id,
    host: env.host,
    port: env.port,
    superuserPassword: env.superuserPassword,
    async createDatabase(idOrOptions?: string | { id?: string }) {
      const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions?.id;
      const database = await provisionDatabase(env, id ?? randomId());
      databases.add(database);
      const originalClose = database.close;
      database.close = async () => {
        databases.delete(database);
        await originalClose();
      };
      return database;
    },
    async close() {
      for (const database of [...databases]) await database.close();
    },
  };
}

async function provisionDatabase(
  cluster: {
    host: string;
    port: number;
    superuserPassword: string;
  },
  id: string,
): Promise<KbPostgresDatabase> {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error(`Invalid fixture id ${id}`);
  const database = `kb_test_${id}`;
  const passwords: Record<KbRoleName, string> = {
    applier: randomBytes(16).toString("hex"),
    runtime: randomBytes(16).toString("hex"),
  };
  await withAdmin(cluster, "postgres", async (admin) => {
    for (const role of ["applier", "runtime"] as const) {
      const name = roleName(role, id);
      await admin.query(
        `CREATE ROLE ${quoteIdent(name)} LOGIN PASSWORD ${quoteLiteral(passwords[role])}`,
      );
    }
    await admin.query(
      `CREATE DATABASE ${quoteIdent(database)} OWNER ${quoteIdent(roleName("applier", id))}`,
    );
  });
  await withAdmin(cluster, database, async (admin) => {
    await admin.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(roleName("runtime", id))}`);
    await admin.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(roleName("applier", id))} IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(roleName("runtime", id))}`,
    );
  });

  const urls: Record<KbRoleName, string> = {
    applier: buildUrl({
      user: roleName("applier", id),
      password: passwords.applier,
      host: cluster.host,
      port: cluster.port,
      database,
    }),
    runtime: buildUrl({
      user: roleName("runtime", id),
      password: passwords.runtime,
      host: cluster.host,
      port: cluster.port,
      database,
    }),
  };
  for (const url of Object.values(urls)) assertTestDatabaseUrl(url, id);

  const open = new Set<Client>();
  let closed = false;
  const fixture: KbPostgresDatabase = {
    id,
    database,
    urls,
    async query(role, text, values = []) {
      if (closed) throw new Error(`Fixture ${id} is closed.`);
      assertTestDatabaseUrl(urls[role], id);
      const client = await connect(urls[role]);
      open.add(client);
      try {
        return await client.query(text, values);
      } finally {
        open.delete(client);
        await client.end().catch(() => {});
      }
    },
    applyPrismaSchema() {
      if (closed) throw new Error(`Fixture ${id} is closed.`);
      assertTestDatabaseUrl(urls.applier, id);
      // Run the committed history with the same owned Prisma engine as images.
      // Only the guarded disposable fixture URL is passed; no dotenv is read.
      const script = `import { run } from ${JSON.stringify(MIGRATION_RUNNER)};
        import { prisma, tempConfig } from ${JSON.stringify(PRISMA_OWNER)};
        import { unlinkSync, rmdirSync } from 'node:fs';
        import { dirname } from 'node:path';
        const config = tempConfig({ url: process.env.DATABASE_URL });
        try {
          process.exitCode = await run({ env: process.env, connectRetryMs: 0,
            runPrisma: (args, options) => prisma([...args, '--config', config], { ...options, guardPath: ${JSON.stringify(buildArtifactPath("child-guard"))} }) });
        } finally { unlinkSync(config); rmdirSync(dirname(config)); }`;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DATABASE_URL: urls.applier,
          PRISMA_HIDE_UPDATE_MESSAGE: "1",
        },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error || result.status !== 0) {
        // Never attach the subprocess error/argv: they can contain the fixture
        // password. Retain bounded diagnostics with credentials removed.
        const detail = [result.error?.message, result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n")
          .replaceAll(urls.applier, "[fixture database]")
          .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database URL]")
          .replaceAll(passwords.applier, "[redacted]")
          .slice(-8192);
        throw new Error(
          `Prisma fixture schema failed (${result.status ?? result.signal}): ${detail}`,
        );
      }
    },
    createPrismaClient(role = "applier") {
      assertTestDatabaseUrl(urls[role], id);
      const adapter = createPrismaPgAdapter({ connectionString: urls[role], max: 8 });
      return new PrismaClient({ adapter });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of open) await client.end().catch(() => {});
      open.clear();
      await withAdmin(cluster, "postgres", async (admin) => {
        await admin.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await admin.query(
          `REVOKE CONNECT ON DATABASE ${quoteIdent(database)} FROM PUBLIC, ${quoteIdent(roleName("applier", id))}, ${quoteIdent(roleName("runtime", id))}`,
        );
      });
    },
  };
  return fixture;
}
