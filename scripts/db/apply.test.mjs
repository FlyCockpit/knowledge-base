import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { applyLocal } from "./apply.mjs";
import {
  KB_DDL_LOCK_KEY,
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_ADVISORY_LOCK,
  readMigrationsFolder,
} from "./lib/migration-state.mjs";
import { MIGRATIONS_DIR } from "./lib/prisma.mjs";

const URL_ = `postgresql://${["u", "p"].join(":")}@localhost/db`;

/**
 * A fake `pg` over one failed (unfinished) 0_init row and a set of held locks;
 * `restorePending` adds a non-READY kb_restore row.
 */
function fakePg(checksum, held, { restorePending = false } = {}) {
  const calls = [];
  return {
    calls,
    pg: {
      Client: class {
        async connect() {}
        async end() {}
        escapeIdentifier(name) {
          return `"${name}"`;
        }
        async query(sql, params = []) {
          calls.push(sql);
          if (/pg_try_advisory_lock/.test(sql)) {
            if (held.has(MIGRATION_RUNNER_LOCK_KEY)) return { rows: [{ acquired: false }] };
            return { rows: [{ acquired: true }] };
          }
          if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
          if (/pg_locks/.test(sql)) return { rows: [{ held: held.has(params[0]) }] };
          if (/kb_restore/.test(sql) && /to_regclass/.test(sql))
            return { rows: [{ restore_table: restorePending ? "kb_restore" : null }] };
          if (/kb_restore/.test(sql)) return { rows: restorePending ? [{}] : [] };
          if (/to_regclass/.test(sql)) return { rows: [{ t: "_prisma_migrations" }] };
          return {
            rows: [
              {
                migration_name: "0_init",
                checksum,
                finished_at: null,
                rolled_back_at: null,
                logs: null,
              },
            ],
          };
        }
      },
    },
  };
}

describe("db:migrate:apply never resolves a migration another session is applying", () => {
  let dir;
  let checksum;
  /** @type {ReturnType<typeof mock.method>} */
  let errorMock;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "apply-"));
    mkdirSync(path.join(dir, "0_init"));
    // The shipped baseline: a real transactional migration with its commit marker.
    copyFileSync(
      path.join(MIGRATIONS_DIR, "0_init", "migration.sql"),
      path.join(dir, "0_init", "migration.sql"),
    );
    [{ checksum }] = readMigrationsFolder(dir);
    errorMock = mock.method(console, "error", () => {});
    mock.method(console, "log", () => {});
  });
  afterEach(() => {
    mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (held, options) => {
    const { pg, calls } = fakePg(checksum, new Set(held), options);
    const prismaCalls = [];
    const code = await applyLocal({
      url: URL_,
      pg: /** @type {typeof import("pg")} */ (/** @type {unknown} */ (pg)),
      migrationsDir: dir,
      prisma: async (args) => {
        prismaCalls.push(args.join(" "));
        return { code: 0 };
      },
    });
    return { code, prismaCalls, calls };
  };

  test("Prisma's lock held (a deploy is mid-migration): refuses, runs no prisma command", async () => {
    const { code, prismaCalls } = await run([PRISMA_ADVISORY_LOCK]);
    assert.equal(code, 1);
    assert.deepEqual(prismaCalls, []);
  });

  test("runner lock held (a production runner or restore): refuses, runs no prisma command", async () => {
    const { code, prismaCalls } = await run([MIGRATION_RUNNER_LOCK_KEY]);
    assert.equal(code, 1);
    assert.deepEqual(prismaCalls, []);
  });

  test("KB lifecycle (DADP) lock held (a snapshot, restore or storage migration): refuses, runs no prisma command", async () => {
    const { code, prismaCalls, calls } = await run([KB_DDL_LOCK_KEY]);
    assert.equal(code, 1);
    assert.deepEqual(prismaCalls, []);
    assert.ok(
      !calls.some((sql) => /pg_try_advisory_lock/.test(sql)),
      "never takes the runner lock",
    );
  });

  test("a KB restore is pending: refuses, runs no prisma command", async () => {
    const { code, prismaCalls } = await run([], { restorePending: true });
    assert.equal(code, 1);
    assert.deepEqual(prismaCalls, []);
    const errors = errorMock.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(errors.some((line) => /restore is pending/.test(line)));
  });

  test("nobody applying: takes the runner lock, resolves, deploys, releases", async () => {
    const { code, prismaCalls, calls } = await run([]);
    assert.equal(code, 0);
    assert.deepEqual(prismaCalls, [
      "migrate resolve --rolled-back 0_init",
      "migrate " + "deploy",
      "generate",
    ]);
    assert.ok(calls.some((sql) => /pg_try_advisory_lock\(72707370\)/.test(sql)));
    assert.ok(calls.some((sql) => /pg_advisory_unlock\(72707370\)/.test(sql)));
  });
});
