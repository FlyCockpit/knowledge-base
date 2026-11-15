import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyArchive,
  prepareArchive,
  refuseLargeObjects,
  restorePrefix,
} from "./restore-archive.mjs";

test("PG18 archive boundary accepts only generated preamble and preserves SQL-looking COPY bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "restore-prefix-"));
  try {
    const path = join(dir, "restore.sql");
    const prefix =
      "-- PostgreSQL database dump\n\n\\restrict Fixture18\n\n-- Dumped by pg_dump version 18.6\n\nSET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\nSET transaction_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\nSELECT pg_catalog.set_config('search_path', '', false);\nSET check_function_bodies = false;\nSET xmloption = content;\nSET client_min_messages = warning;\nSET row_security = off;\n\nSET default_tablespace = '';\n\nSET default_table_access_method = heap;\n";
    const body =
      "\n--\n-- Name: fixture; Type: TABLE; Schema: public; Owner: postgres\n--\nCREATE TABLE public.fixture (v text);\nCOPY public.fixture (v) FROM stdin;\nSET statement_timeout = 0;\n\\.\n";
    await writeFile(path, prefix + body);
    const result = await restorePrefix(path);
    assert.equal(result.prefix, prefix + "\n");
    const original = await readFile(path);
    assert.equal(original.subarray(result.offset).toString(), body.slice(1));
    for (const invalid of [
      prefix.replace("SET transaction_timeout = 0;", ""),
      `${prefix}COMMIT;\n`,
      `${prefix}SET unexpected_setting = on;\n`,
      prefix.replace("standard_conforming_strings = on", "standard_conforming_strings = off"),
    ]) {
      await writeFile(path, invalid + body);
      await assert.rejects(restorePrefix(path));
    }
    await writeFile(path, "--" + "x".repeat(70_000) + body);
    await assert.rejects(restorePrefix(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Fake native clients on an isolated PATH: the fixture dir holds only the
// fakes and a `node` link (the fakes' interpreter). No real Postgres IO.
async function clients(t, { pgRestore = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "restore-archive-clients-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink(process.execPath, join(dir, "node"));
  const calls = join(dir, "calls.jsonl");
  if (pgRestore) {
    await writeFile(
      join(dir, "pg_restore"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args.includes("--list")) {
  process.stdout.write(";\\n; Archive created at 2026-11-14\\n;\\n");
  process.stdout.write("215; 1259 16385 TABLE public BLOB writer\\n");
  process.stdout.write("3300; 0 16385 TABLE DATA public BLOB writer\\n");
  for (const line of JSON.parse(process.env.FAKE_TOC || "[]")) process.stdout.write(line + "\\n");
} else process.stdout.write(${JSON.stringify(validScript)});
`,
      { mode: 0o755 },
    );
  }
  const read = async () =>
    (await readFile(calls, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { dir, env: { PATH: dir }, calls: read };
}
const validScript =
  "--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\nSET transaction_timeout = 0;\n\n--\n-- Name: fixture; Type: TABLE\n--\n";

test("archives with large objects are refused from the TOC before any script is written", async (t) => {
  for (const entry of [
    "3301; 2613 16397 BLOB - 16397 writer",
    "3302; 2613 16397 BLOB METADATA - BLOB METADATA 16397 writer",
    "3303; 0 0 BLOBS - BLOBS 16397..16397 writer",
  ]) {
    const f = await clients(t);
    const output = join(f.dir, "restore.sql");
    await assert.rejects(
      prepareArchive(join(f.dir, "pg_restore"), output, {
        env: { ...f.env, FAKE_TOC: JSON.stringify([entry]) },
      }),
      { code: "RESTORE_LARGE_OBJECTS" },
      entry,
    );
    assert.deepEqual(await f.calls(), [["--list"]], entry);
    await assert.rejects(stat(output), { code: "ENOENT" }, entry);
  }
  // A table that is merely named BLOB is not a large object.
  const f = await clients(t);
  const output = join(f.dir, "restore.sql");
  await prepareArchive(join(f.dir, "pg_restore"), output, { env: f.env });
  assert.deepEqual(
    (await f.calls()).map((args) => args[0]),
    ["--list", "--no-owner"],
  );
  assert.equal(await readFile(output, "utf8"), validScript);
});

test("an oversized archive TOC is refused instead of buffered without bound", async (t) => {
  const f = await clients(t);
  await assert.rejects(
    refuseLargeObjects(join(f.dir, "pg_restore"), { env: f.env, maxBytes: 16 }),
    { code: "RESTORE_ARCHIVE_LIST_BUDGET" },
  );
});

test("a missing pg_restore or psql fails clearly (CHILD_SPAWN) instead of crashing or hanging", async (t) => {
  const missing = await clients(t, { pgRestore: false });
  const input = join(missing.dir, "postgres.dump");
  await writeFile(input, "PGDMP");
  const output = join(missing.dir, "restore.sql");
  await assert.rejects(prepareArchive(input, output, { env: missing.env }), {
    code: "CHILD_SPAWN",
  });
  await assert.rejects(stat(output), { code: "ENOENT" });
  // applyArchive: the validated script is ready, but psql is not installed.
  await writeFile(output, validScript);
  await assert.rejects(applyArchive(output, { env: missing.env, timeout: 10_000 }), {
    code: "CHILD_SPAWN",
  });
});
