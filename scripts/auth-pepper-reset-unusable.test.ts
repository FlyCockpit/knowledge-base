import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { parseArgs } from "node:util";
import { runInNewContext } from "node:vm";

// Exercise the actual CLI body with fake IO; never load local env or connect.
const source = readFileSync(new URL("./auth-pepper-reset-unusable.ts", import.meta.url), "utf8");
const body = stripTypeScriptTypes(source.slice(source.indexOf("async function main()")))
  .replace('import("../packages/env/src/server.ts")', "loadEnv()")
  .replace("import(STORE_MODULE)", "loadStore()")
  .replace("import(DB_MODULE)", "loadDb()")
  .replace("import.meta.dirname", "directory");

async function run(
  argv: string[],
  options: { guard?: number; count?: number; reset?: number; fail?: boolean } = {},
) {
  const output: string[] = [];
  const events: string[] = [];
  const calls: unknown[][] = [];
  const process = { exitCode: 0 };
  const env = {
    BETTER_AUTH_SECRET: { reveal: () => "fixture-current-key" },
    BETTER_AUTH_SECRET_PREVIOUS: { reveal: () => "fixture-previous-key" },
  };
  await runInNewContext(body, {
    process,
    console: {
      log: (line: string) => output.push(line),
      error: (line: string) => output.push(line),
    },
    parseArgs: (options: Parameters<typeof parseArgs>[0]) => parseArgs({ ...options, args: argv }),
    resolve,
    // import.meta is replaced above, keeping the real path construction.
    directory: "/fixture/scripts",
    spawnSync: (...args: unknown[]) => {
      events.push("guard");
      calls.push(args);
      return { status: options.guard ?? 0 };
    },
    loadEnv: async () => {
      events.push("env");
      return { env };
    },
    loadDb: async () => {
      events.push("db");
      return {
        default: {
          $disconnect: async () => {
            events.push("disconnect");
          },
        },
      };
    },
    createPasswordPepper: (secrets: unknown) => {
      events.push("pepper");
      calls.push([secrets]);
      return "fixture-pepper";
    },
    loadStore: async () => ({ resetUnusablePasswords }),
  });
  return { output: output.join("\n"), events, calls, process, env };

  async function resetUnusablePasswords(...args: unknown[]) {
    events.push("reset");
    calls.push(args);
    if (options.fail) throw new Error("sensitive database error must never be echoed");
    return {
      count: options.count ?? 2,
      userIds: ["user-a", "user-b"],
      reset: options.reset ?? 0,
    };
  }
}

test("recovery CLI defaults to a guarded dry run and uses the validated server secrets", async () => {
  const result = await run([]);
  assert.deepEqual(result.events, ["guard", "env", "pepper", "db", "reset", "disconnect"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.calls[0]?.[1])), [
    "/fixture/scripts/assert-local-database.sh",
    "auth:pepper:reset-unusable",
  ]);
  assert.equal(
    JSON.stringify(result.calls[1]?.[0]),
    JSON.stringify({
      secret: result.env.BETTER_AUTH_SECRET.reveal(),
      previousSecret: result.env.BETTER_AUTH_SECRET_PREVIOUS.reveal(),
    }),
  );
  assert.equal(JSON.stringify(result.calls[2]?.[2]), "{}");
  assert.match(result.output, /Unusable password rows: 2/);
  assert.match(result.output, /user-a.*user-b/);
  assert.match(result.output, /Nothing changed/);
  assert.doesNotMatch(result.output, /fixture-current-key|fixture-previous-key/);
});

test("recovery CLI refuses a non-local target before loading secrets or the database", async () => {
  const result = await run([], { guard: 1 });
  assert.deepEqual(result.events, ["guard"]);
  assert.equal(result.process.exitCode, 1);
  assert.match(result.output, /--allow-non-local/);
});

test("recovery CLI allows explicit non-local one-shot confirmation", async () => {
  const result = await run(["--allow-non-local", "--confirm", "2"], { reset: 2 });
  assert.equal(result.events.includes("guard"), false);
  assert.equal(JSON.stringify(result.calls[1]?.[2]), '{"confirm":2}');
  assert.match(result.output, /Reset 2 password row\(s\)/);
  assert.equal(result.process.exitCode, 0);
});

test("recovery CLI rejects malformed confirmations before IO", async () => {
  for (const args of [
    ["--confirm", "-1"],
    ["--confirm", "1.5"],
    ["--confirm", ""],
    ["--confirm", "9007199254740992"],
    ["--unknown"],
  ]) {
    const result = await run(args);
    assert.deepEqual(result.events, []);
    assert.equal(result.process.exitCode, 1);
  }
});

test("recovery CLI reports wrong counts and concurrent changes as unsuccessful", async () => {
  const mismatch = await run(["--confirm", "3"]);
  assert.match(mismatch.output, /Nothing changed/);
  assert.equal(mismatch.process.exitCode, 1);
  const raced = await run(["--confirm", "2"], { reset: 1 });
  assert.match(raced.output, /keep servers stopped and preview again/);
  assert.doesNotMatch(raced.output, /Start the server/);
  assert.equal(raced.process.exitCode, 1);
});

test("recovery CLI disconnects after failure without leaking database errors", async () => {
  const result = await run([], { fail: true });
  assert.equal(result.events.at(-1), "disconnect");
  assert.equal(result.process.exitCode, 1);
  assert.doesNotMatch(result.output, /sensitive database error/);
});
