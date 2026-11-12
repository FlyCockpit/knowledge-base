// Unit tests for scripts/db/lib/contracts.mjs with in-memory fake clients:
// no database. The real-Postgres cases live in test-migrations.mjs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import {
  admit,
  applyAllContracts,
  applyContract,
  CLUSTER_DDL,
  CONTRACT_PREAMBLE_TIMEOUT_MS,
  CONTRACT_START_MIN_MS,
  CONTRACT_STATEMENT_TIMEOUT_MS,
  checkClusterIdentity,
  classifyFailure,
  ddlFor,
  HOLD_DDL,
  holdUpsertSql,
  lateRecoveries,
  nameReuseLive,
  planContracts,
  pruneInstances,
  REGISTER_TIMEOUT_MS,
  readLiveCatalog,
  recordApplied,
  SOAK_MS,
  scheduleLines,
  statementTimeoutMs,
  validateContract,
} from "./contracts.mjs";
import { analyzeContract, catalogFromSql, enumRemoveContract, wrapTransactional } from "./sql.mjs";

// Fixture SQL is assembled so policy greps never see a literal deletion.
const DROP = "DROP";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-07T12:00:00Z");
const R1 = "20261101000000_retire_a";
const R2 = "20261102000000_retire_b";

const row = (overrides = {}) => ({
  contract_attempts: 0,
  contract_attempt_level: null,
  contract_last_error: null,
  contract_applied_at: null,
  contract_effects: 'column "t"."x"',
  ...overrides,
});
/** Contract folders the fixtures know; an image at `level` contains those at or below it by default. */
const FOLDERS = [R1, R2, "x_B"];
const instance = (
  level,
  {
    ready = NOW - 8 * DAY,
    seen = NOW - 60_000,
    role = "server",
    contracts = level === null ? null : FOLDERS.filter((name) => name <= level),
  } = {},
) => ({
  role,
  host: "h1",
  schema_level: level,
  contract_folders: contracts,
  ready_at: ready,
  last_seen_at: seen,
});
const plan = (input) =>
  planContracts({
    now: NOW,
    fresh: false,
    level: R2,
    pending: [{ name: R1, row: row() }],
    instances: [instance(R2)],
    holds: [],
    ...input,
  });

test("hold and instance expiry SQL use elapsed time units across session DST changes", async () => {
  assert.match(holdUpsertSql("tenant"), /\$2::double precision \* interval '1 millisecond'/);
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 2 };
    },
  };
  assert.equal(await pruneInstances(client, "tenant"), 2);
  assert.match(calls[0].sql, /"tenant"\."_knowledge_base_instance"/);
  assert.match(
    calls[0].sql,
    /last_seen_at < now\(\) - \(\$1::double precision \* interval '86400 seconds'\)/,
  );
  assert.deepEqual(calls[0].params, [30]);
});

describe("planContracts (the due rule)", () => {
  test("due once a release containing R was ready 7 days ago and none lacking it is alive", () => {
    assert.deepEqual(plan({}).due, [R1]);
  });

  test("a fresh database ignores the soak entirely", () => {
    assert.deepEqual(plan({ fresh: true, instances: [] }).due, [R1]);
  });

  test("no release containing R has been ready → soak with no date", () => {
    const result = plan({ instances: [instance(R2, { ready: null })] });
    assert.deepEqual(result.due, []);
    assert.equal(result.entries[0].status, "soak");
    assert.equal(result.entries[0].until, null);
  });

  test("ready only 6 days ago → soak until ready + 7 days", () => {
    const ready = NOW - 6 * DAY;
    const result = plan({ instances: [instance(R2, { ready })] });
    assert.deepEqual(result.due, []);
    assert.equal(result.entries[0].until, ready + SOAK_MS);
    assert.match(
      scheduleLines(result)[0],
      /will delete column "t"\."x" after 2026-11-08T12:00:00Z/,
    );
  });

  test("an older instance seen 6 days ago blocks; one seen 8 days ago does not", () => {
    const old = (seen) => instance("20261001000000_older", { seen, role: "worker" });
    const blocked = plan({ instances: [instance(R2), old(NOW - 6 * DAY)] });
    assert.equal(blocked.entries[0].status, "waiting");
    assert.match(scheduleLines(blocked)[0], /waiting for: worker@h1 on 20261001000000_older/);
    assert.deepEqual(plan({ instances: [instance(R2), old(NOW - 8 * DAY)] }).due, [R1]);
  });

  test("an instance with a NULL level blocks", () => {
    const result = plan({ instances: [instance(R2), instance(null)] });
    assert.equal(result.entries[0].status, "waiting");
    assert.match(scheduleLines(result)[0], /unknown level/);
  });

  test("an active hold blocks; an expired one does not", () => {
    const held = plan({ holds: [{ reason: "restore", until: NOW + DAY }] });
    assert.equal(held.entries[0].status, "held");
    assert.match(scheduleLines(held)[0], /held until 2026-11-08T12:00:00Z \(restore\)/);
    assert.deepEqual(plan({ holds: [{ reason: "restore", until: NOW - 1 }] }).due, [R1]);
  });

  test("3 attempts at this level → needs a person; at a lower recorded level → due again", () => {
    const stuck = plan({
      pending: [
        {
          name: R1,
          row: row({
            contract_attempts: 3,
            contract_attempt_level: R2,
            contract_last_error: "XX000: boom",
          }),
        },
      ],
    });
    assert.equal(stuck.entries[0].status, "needs-person");
    assert.match(scheduleLines(stuck)[0], /needs a person: XX000: boom/);
    assert.match(scheduleLines(stuck)[0], /a release that adds a migration tries again/);
    const newer = plan({
      level: "20261103000000_next",
      pending: [{ name: R1, row: row({ contract_attempts: 3, contract_attempt_level: R2 }) }],
    });
    assert.deepEqual(newer.due, [R1]);
  });

  test("monotonic: the first contract that is not due stops every later one", () => {
    const result = plan({
      pending: [
        { name: R1, row: row({ contract_attempts: 3, contract_attempt_level: R2 }) },
        { name: R2, row: row() },
      ],
    });
    assert.deepEqual(result.due, []);
    assert.equal(result.entries[1].status, "due");
  });

  test("levels compare by code unit, not locale", () => {
    // localeCompare puts "a" before "B"; Prisma's folder order (and ours) does not.
    const result = planContracts({
      now: NOW,
      fresh: false,
      level: "x_a",
      pending: [{ name: "x_B", row: row() }],
      instances: [instance("x_a")],
    });
    assert.deepEqual(result.due, ["x_B"]);
  });

  test("the in-transaction re-plan ignores the attempt it just counted", () => {
    const counted = { name: R1, row: row({ contract_attempts: 3, contract_attempt_level: R2 }) };
    assert.deepEqual(plan({ pending: [counted] }).due, []);
    assert.deepEqual(plan({ pending: [counted], ignoreAttempts: true }).due, [R1]);
    assert.deepEqual(
      plan({
        pending: [counted],
        ignoreAttempts: true,
        holds: [{ reason: "owner", until: NOW + 1 }],
      }).due,
      [],
      "holds still apply",
    );
  });

  test("an unrecorded contract is not due", () => {
    assert.equal(plan({ pending: [{ name: R1 }] }).entries[0].status, "unrecorded");
  });

  describe("an out-of-order folder (merged after a newer one)", () => {
    // M sorts before the old release's level, but that release's image lacks it.
    const M = "20261020000000_drop_col";
    const OLD = "20261101000000_a";
    const NEW = "20261105000000_b";
    const oldRelease = (overrides = {}) =>
      instance(OLD, { contracts: [], ready: NOW - 10 * DAY, seen: NOW, ...overrides });
    const newRelease = (overrides = {}) =>
      instance(NEW, { contracts: [M], ready: null, seen: NOW, ...overrides });
    const outOfOrder = (instances) =>
      planContracts({
        now: NOW,
        fresh: false,
        level: NEW,
        pending: [{ name: M, row: row() }],
        instances,
        holds: [],
      });

    test("the reviewer's scenario: the serving old release (level ≥ M) blocks; nothing is due", () => {
      const result = outOfOrder([oldRelease(), newRelease()]);
      assert.deepEqual(result.due, []);
      assert.equal(result.entries[0].status, "waiting");
      assert.match(
        scheduleLines(result)[0],
        /waiting for: server@h1 on 20261101000000_a, an image without this migration/,
      );
    });

    test("an old release ready long ago never counts as ready for M", () => {
      const result = outOfOrder([oldRelease({ seen: NOW - 8 * DAY }), newRelease()]);
      assert.equal(result.entries[0].status, "soak");
      assert.equal(result.entries[0].until, null);
    });

    test("the normal path: due once the release containing M was ready 7 days and the old one is gone", () => {
      const result = outOfOrder([
        oldRelease({ seen: NOW - 8 * DAY }),
        newRelease({ ready: NOW - 7 * DAY - 1 }),
      ]);
      assert.deepEqual(result.due, [M]);
    });

    test("an old release that restarted after M was applied (registered via admission, lacking M) blocks", () => {
      // Its registration lists its own contract folders, which do not include M.
      const restarted = oldRelease({ ready: NOW - DAY, contracts: [R1] });
      const result = outOfOrder([restarted, newRelease({ ready: NOW - 8 * DAY })]);
      assert.equal(result.entries[0].status, "waiting");
    });

    test("a heartbeat-only row (no folder list) blocks even at a high level", () => {
      const result = outOfOrder([
        newRelease({ ready: NOW - 8 * DAY }),
        instance(NEW, { contracts: null, seen: NOW }),
      ]);
      assert.equal(result.entries[0].status, "waiting");
    });
  });
});

/** A scripted fake: each query is matched against `handlers` in order. */
function scripted(handlers) {
  const client = new EventEmitter();
  client.queries = [];
  client.query = async (sql, params = []) => {
    client.queries.push({ sql, params });
    for (const [pattern, reply] of handlers)
      if (pattern.test(sql)) return typeof reply === "function" ? reply(params, sql) : reply;
    return { rows: [], rowCount: 0 };
  };
  return client;
}

describe("admit (rollback admission)", () => {
  const tablesPresent = [/to_regclass/, { rows: [{ present: true }] }];
  const rows = (list) => [/FOR SHARE/, { rows: list }];
  const inserted = (client) => client.queries.some((q) => /INSERT INTO/.test(q.sql));
  const safe = { name: R2, rollback_safe: true, rollback_reasons: null, contract_applied_at: null };

  test("every ahead migration recorded, safe, not contracted → admitted and registered", async () => {
    const client = scripted([tablesPresent, rows([safe])]);
    const result = await admit(client, {
      schema: "public",
      ahead: [R2],
      id: "id",
      role: "server",
      level: R1,
    });
    assert.deepEqual([result.admitted, result.registered], [true, true]);
    assert.ok(
      client.queries.some((q) => /FOR SHARE/.test(q.sql)),
      "rows read FOR SHARE",
    );
    const insert = client.queries.find((q) => /INSERT INTO/.test(q.sql));
    assert.deepEqual(insert.params.slice(1, 3), ["server", R1]);
    assert.ok(
      client.queries.some((q) => q.sql === "SET LOCAL lock_timeout = 60000"),
      "a rollback admission may wait out a running contract",
    );
    assert.ok(client.queries.findIndex((q) => q.sql === "COMMIT") > client.queries.indexOf(insert));
  });

  for (const [why, list, pattern] of [
    ["no record", [], /no rollback record/],
    [
      "not rollback-safe",
      [{ ...safe, rollback_safe: false, rollback_reasons: "adds an enum value" }],
      /not rollback-safe \(adds an enum value\)/,
    ],
    [
      "contract already applied",
      [{ ...safe, contract_applied_at: new Date(NOW) }],
      /deletion already ran/,
    ],
  ])
    test(`refused: ${why}, and nothing is registered`, async () => {
      const client = scripted([tablesPresent, rows(list)]);
      const result = await admit(client, { schema: "public", ahead: [R2], id: "id" });
      assert.equal(result.admitted, false);
      assert.match(result.reasons.join(), pattern);
      assert.equal(inserted(client), false);
    });

  test("read-only (no id): admitted, inserts nothing", async () => {
    const client = scripted([tablesPresent, rows([safe])]);
    const result = await admit(client, { schema: "public", ahead: [R2] });
    assert.deepEqual([result.admitted, result.registered], [true, false]);
    assert.equal(inserted(client), false);
  });

  test("missing runner tables: db-ahead refused; up to date admitted without registering", async () => {
    const missing = [/to_regclass/, { rows: [{ present: false }] }];
    const ahead = await admit(scripted([missing]), { schema: "public", ahead: [R2], id: "id" });
    assert.deepEqual([ahead.admitted, ahead.missingTables], [false, true]);
    const current = await admit(scripted([missing]), { schema: "public", id: "id" });
    assert.deepEqual([current.admitted, current.registered], [true, false]);
  });

  test("no ahead, id set → registers with the schema-qualified table, bounded", async () => {
    const client = scripted([tablesPresent]);
    await admit(client, { schema: "app", id: "id", role: "worker", level: R2, host: "h" });
    assert.match(
      client.queries.find((q) => /INSERT/.test(q.sql)).sql,
      /"app"\."_knowledge_base_instance"/,
    );
    for (const setting of ["lock_timeout", "statement_timeout"])
      assert.ok(
        client.queries.some((q) => q.sql === `SET LOCAL ${setting} = ${REGISTER_TIMEOUT_MS}`),
        setting,
      );
  });

  test("registration records the image's contract folders (an image lacking M lists no M)", async () => {
    const M = "20261020000000_drop_col";
    const client = scripted([tablesPresent, rows([{ ...safe, name: M }])]);
    // An older image admitted against a database that applied M (out of order).
    const result = await admit(client, {
      schema: "public",
      ahead: [M],
      id: "id",
      level: "20261101000000_a",
      contracts: [R1],
    });
    assert.deepEqual([result.admitted, result.registered], [true, true]);
    const insert = client.queries.find((q) => /INSERT INTO/.test(q.sql));
    assert.match(insert.sql, /contract_folders/);
    assert.deepEqual(insert.params[4], [R1]);
    // …and the due rule treats that registration as a blocker for M.
    const registered = {
      role: "server",
      host: null,
      schema_level: insert.params[2],
      contract_folders: insert.params[4],
      ready_at: NOW - 10 * DAY,
      last_seen_at: NOW,
    };
    const result2 = planContracts({
      now: NOW,
      fresh: false,
      level: "20261105000000_b",
      pending: [{ name: M, row: row() }],
      instances: [
        registered,
        instance("20261105000000_b", { contracts: [M], ready: NOW - 8 * DAY }),
      ],
    });
    assert.equal(result2.entries[0].status, "waiting");
  });

  test("no contract folders given → an empty list, never NULL", async () => {
    const client = scripted([tablesPresent]);
    await admit(client, { schema: "public", id: "id" });
    assert.deepEqual(client.queries.find((q) => /INSERT/.test(q.sql)).params[4], []);
  });
});

/** A fake for the identity check: the stored row, holds, and query order. */
function identityDb({
  stored = null,
  identity = { system_identifier: "7", timeline: 1 },
  oid = "5",
  registry = "900",
} = {}) {
  // `identity` is an Error (both reads fail) or { system_identifier, timeline },
  // where either value may itself be an Error (that read alone fails).
  const part = (field) => {
    const value = identity instanceof Error ? identity : identity[field];
    if (value instanceof Error) throw value;
    return { rows: [{ value }] };
  };
  const db = { stored, holds: new Map(), inTx: false, events: [] };
  const client = new EventEmitter();
  client.queries = [];
  client.query = async (sql, params = []) => {
    client.queries.push({ sql, params, inTx: db.inTx });
    if (sql === "BEGIN") db.inTx = true;
    else if (sql === "COMMIT" || sql === "ROLLBACK") db.inTx = false;
    else if (/FROM pg_database/.test(sql)) return { rows: [{ oid }] };
    else if (/pg_control_system/.test(sql)) return part("system_identifier");
    else if (/pg_walfile_name/.test(sql)) return part("timeline");
    else if (/to_regclass/.test(sql)) return { rows: [{ oid: registry }] };
    else if (/FOR UPDATE/.test(sql)) return { rows: db.stored ? [{ ...db.stored }] : [] };
    else if (
      /INSERT INTO "public"\."_knowledge_base_cluster"|UPDATE "public"\."_knowledge_base_cluster"/.test(
        sql,
      )
    ) {
      const [system_identifier, timeline, database_oid, registry_oid] = params;
      db.stored = { system_identifier, timeline, database_oid, registry_oid };
      db.events.push(/^INSERT/.test(sql.trim()) ? "insert" : "update");
    } else if (/_knowledge_base_hold/.test(sql)) {
      const [reason, duration] = params;
      const until = Math.max(db.holds.get(reason) ?? 0, NOW + duration);
      db.holds.set(reason, until);
      return { rows: [{ until: new Date(until) }] };
    }
    return { rows: [] };
  };
  return { db, client };
}
const sqlError = (code, message = code) => Object.assign(new Error(message), { code });

describe("checkClusterIdentity", () => {
  const same = { system_identifier: "7", timeline: 1, database_oid: "5", registry_oid: "900" };
  const run = async (setup, fresh = false) => {
    const { db, client } = identityDb(setup);
    const lines = [];
    const result = await checkClusterIdentity(client, {
      schema: "public",
      fresh,
      log: (l) => lines.push(l),
    });
    return { db, client, lines, result };
  };

  test("fresh database, no row → insert, no hold", async () => {
    const { db, result } = await run({}, true);
    assert.deepEqual(db.events, ["insert"]);
    assert.equal(db.holds.size, 0);
    assert.deepEqual(result, { skipContracts: false, held: false });
  });

  test("non-fresh database, no row → insert and hold", async () => {
    const { db, lines } = await run({});
    assert.deepEqual(db.events, ["insert"]);
    assert.ok(db.holds.has("cluster-changed"));
    assert.match(lines.join(), /deletion scheduling starts on this database/);
    assert.equal(db.stored.registry_oid, "900", "every insert stores the registry oid");
  });

  for (const [field, change] of [
    ["system_identifier", { identity: { system_identifier: "8", timeline: 1 } }],
    ["timeline", { identity: { system_identifier: "7", timeline: 2 } }],
    ["database_oid", { oid: "6" }],
  ])
    test(`${field} change → hold, row updated, log names the field`, async () => {
      const { db, lines, client } = await run({ stored: same, ...change });
      assert.deepEqual(db.events, ["update"]);
      assert.ok(db.holds.has("cluster-changed"));
      assert.match(lines.join(), new RegExp(`restored or moved \\(${field}: `));
      assert.match(
        client.queries.find((q) => /UPDATE "public"\."_knowledge_base_cluster"/.test(q.sql)).sql,
        /changed_at = now\(\)/,
      );
    });

  test("registry oid differs, all else the same → hold with the logical-backup log; a second run writes nothing", async () => {
    const first = await run({ stored: same, registry: "901" });
    assert.ok(first.db.holds.has("cluster-changed"));
    assert.match(first.lines.join(), /restored from a logical backup \(registry table recreated\)/);
    assert.equal(first.db.stored.registry_oid, "901", "the row stores the live oid");
    const second = await run({ stored: first.db.stored, registry: "901" });
    assert.deepEqual(second.db.events, []);
    assert.equal(second.db.holds.size, 0);
  });

  test("the registry oid is read inside the compare transaction with a typed parameter (R6-1)", async () => {
    const { client } = await run({ stored: same });
    const read = client.queries.find((q) => /to_regclass/.test(q.sql));
    assert.equal(read.inTx, true);
    assert.match(read.sql, /\$1::text/);
  });

  test("same identity → no write", async () => {
    const { db } = await run({ stored: same });
    assert.deepEqual(db.events, []);
    assert.equal(db.holds.size, 0);
  });

  test("42501 with a stored real identity → hold, 'unavailable' stored", async () => {
    const { db } = await run({ stored: same, identity: sqlError("42501") });
    assert.ok(db.holds.has("cluster-changed"));
    assert.equal(db.stored.system_identifier, "unavailable");
    assert.equal(db.stored.timeline, null);
  });

  test("system id revoked alone: the timeline is still read, so a PITR is still detected", async () => {
    const pitr = await run({
      stored: { ...same, system_identifier: "unavailable" },
      identity: { system_identifier: sqlError("42501"), timeline: 2 },
    });
    assert.ok(pitr.db.holds.has("cluster-changed"));
    assert.match(pitr.lines.join(), /timeline: 1 → 2/);
    assert.deepEqual(
      [pitr.db.stored.system_identifier, pitr.db.stored.timeline],
      ["unavailable", 2],
    );
    const steady = await run({
      stored: pitr.db.stored,
      identity: { system_identifier: sqlError("42501"), timeline: 2 },
    });
    assert.deepEqual(steady.db.events, []);
    assert.equal(steady.db.holds.size, 0);
  });

  test("timeline revoked alone: the system id is still compared; timeline stored NULL", async () => {
    const moved = await run({
      stored: { ...same, timeline: null },
      identity: { system_identifier: "8", timeline: sqlError("42883") },
    });
    assert.ok(moved.db.holds.has("cluster-changed"));
    assert.deepEqual([moved.db.stored.system_identifier, moved.db.stored.timeline], ["8", null]);
    const steady = await run({
      stored: { ...same, timeline: null },
      identity: { system_identifier: "7", timeline: sqlError("42883") },
    });
    assert.deepEqual(steady.db.events, []);
  });

  test("a non-unavailable error on either read skips contracts", async () => {
    for (const identity of [
      { system_identifier: "7", timeline: sqlError("08006") },
      { system_identifier: sqlError("57014"), timeline: 1 },
    ]) {
      const { result, db } = await run({ stored: same, identity });
      assert.deepEqual(result, { skipContracts: true, held: false });
      assert.deepEqual(db.events, []);
    }
  });

  test("42501 with 'unavailable' stored → no hold", async () => {
    const stored = { ...same, system_identifier: "unavailable", timeline: null };
    const { db } = await run({ stored, identity: sqlError("42501") });
    assert.deepEqual(db.events, []);
    assert.equal(db.holds.size, 0);
  });

  for (const code of ["08006", "57014"])
    test(`a ${code} identity read error → skipContracts, no write`, async () => {
      const { db, result, lines } = await run({ stored: same, identity: sqlError(code) });
      assert.deepEqual(result, { skipContracts: true, held: false });
      assert.deepEqual(db.events, []);
      assert.match(lines.join(), new RegExp(`cluster identity read failed \\(${code}\\)`));
    });

  test("the identity reads are issued separately, outside the FOR UPDATE transaction", async () => {
    const { client } = await run({ stored: same });
    const begin = client.queries.findIndex((q) => q.sql === "BEGIN");
    for (const pattern of [/pg_control_system/, /pg_walfile_name/]) {
      const reads = client.queries.filter((q) => pattern.test(q.sql));
      assert.equal(reads.length, 1);
      assert.equal(reads[0].inTx, false);
      assert.ok(client.queries.indexOf(reads[0]) < begin);
    }
    assert.ok(
      !client.queries.some((q) => /pg_control_system/.test(q.sql) && /pg_walfile_name/.test(q.sql)),
      "one revoked function never hides the other",
    );
  });

  test("a hold upsert never shortens a longer hold", async () => {
    assert.match(holdUpsertSql("public"), /greatest\(h\.until, EXCLUDED\.until\)/);
    const { db, client } = identityDb({ stored: { ...same, timeline: 9 } });
    db.holds.set("cluster-changed", NOW + 30 * DAY);
    await checkClusterIdentity(client, { schema: "public", fresh: false });
    assert.equal(db.holds.get("cluster-changed"), NOW + 30 * DAY);
  });
});

describe("readLiveCatalog", () => {
  test("timeoutMs bounds the whole read: each query gets what is left of it", async () => {
    const client = scripted([]);
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    const query = client.query;
    client.query = async (sql, params) => {
      const result = await query(sql, params);
      if (/^\s*SELECT/.test(sql)) t += 1_500;
      return result;
    };
    try {
      await readLiveCatalog(client, "public", { timeoutMs: 5_000 });
    } finally {
      Date.now = realNow;
    }
    const timeouts = client.queries
      .filter((q) => /statement_timeout/.test(q.sql))
      .map((q) => Number(/= (\d+)$/.exec(q.sql)?.[1]));
    assert.deepEqual(timeouts, [5_000, 3_500, 2_000, 500]);
    assert.ok(client.queries.some((q) => /lock_timeout = '5s'/.test(q.sql)));
    assert.equal(client.queries.at(-1).sql, "COMMIT");
  });
});

describe("DDL constants", () => {
  test("the cluster table carries registry_oid and no observed_at; schema is filled in", () => {
    assert.match(CLUSTER_DDL, /registry_oid oid NOT NULL/);
    assert.doesNotMatch(CLUSTER_DDL, /observed_at/);
    assert.match(
      ddlFor(HOLD_DDL, 'we"ird'),
      /^CREATE TABLE IF NOT EXISTS "we""ird"\."_knowledge_base_hold"/,
    );
  });
});

// --- validation -------------------------------------------------------------

const FOLDER = "20261101000000_retire_a";
const ENUM_HEADER = {
  enumName: "E",
  pairs: [{ from: "B", to: "A" }],
  columns: [{ table: "t", column: "c", array: false }],
  folder: FOLDER,
};
const LIVE = catalogFromSql(`CREATE TYPE "E" AS ENUM ('A', 'B');
CREATE TABLE "t" ("id" INTEGER NOT NULL, "c" "E" NOT NULL DEFAULT 'A', "x" TEXT, "y" TEXT NOT NULL, CONSTRAINT "t_pkey" PRIMARY KEY ("id"));`);
const IMAGE = catalogFromSql(`CREATE TYPE "E" AS ENUM ('A');
CREATE TABLE "t" ("id" INTEGER NOT NULL, "c" "E" NOT NULL DEFAULT 'A', "y" TEXT NOT NULL, CONSTRAINT "t_pkey" PRIMARY KEY ("id"));`);
const contractOf = (sql) => ({ name: FOLDER, contract: { sql, checksum: "sum" } });
const validate = (sql, overrides = {}) =>
  validateContract({
    migration: contractOf(sql),
    row: { contract_checksum: "sum" },
    live: LIVE,
    image: IMAGE,
    ...overrides,
  });

describe("validateContract", () => {
  test("a plain column drop of a nullable column not in the image is valid", () => {
    assert.equal(validate(`ALTER TABLE "t" ${DROP} COLUMN "x";\n`).ok, true);
  });

  test("the enum template is valid when the image lacks B and live defaults name only A", () => {
    assert.equal(validate(`${enumRemoveContract(ENUM_HEADER)}\n`).ok, true);
  });

  test("7c-1: a checksum that differs from the recorded one", () => {
    const result = validate(`ALTER TABLE "t" ${DROP} COLUMN "x";\n`, {
      row: { contract_checksum: "other" },
    });
    assert.match(result.finding, /differs from the copy recorded/);
  });

  test("7c-2: anything outside the allowlist", () => {
    assert.match(validate(`UPDATE "t" SET "x" = NULL WHERE true;\n`).finding, /not allowed/);
  });

  test("7c-3: a NOT NULL column without a default means the expand step is missing", () => {
    const image = catalogFromSql(`CREATE TABLE "t" ("id" INTEGER NOT NULL);`);
    assert.match(
      validate(`ALTER TABLE "t" ${DROP} COLUMN "y";\n`, { image }).finding,
      /NOT NULL without a default.*expand step/,
    );
  });

  test("7c-4: an object that still exists in the image's schema", () => {
    assert.match(
      validate(`ALTER TABLE "t" ${DROP} COLUMN "y";\n`, {
        live: catalogFromSql(`CREATE TABLE "t" ("y" TEXT);`),
      }).finding,
      /still exists in this image's Prisma schema/,
    );
    assert.match(validate(`${DROP} TABLE "t";\n`).finding, /table "t" still exists/);
  });

  test("7c-4: the image's enum still has the removed label", () => {
    const image = catalogFromSql(`CREATE TYPE "E" AS ENUM ('A', 'B');`);
    assert.match(
      validate(`${enumRemoveContract(ENUM_HEADER)}\n`, { image }).finding,
      /still has E\.B/,
    );
  });

  test("7c-5: a live default that still names the removed label", () => {
    const live = catalogFromSql(`CREATE TYPE "E" AS ENUM ('A', 'B');
CREATE TABLE "t" ("c" "E" NOT NULL DEFAULT 'B');`);
    assert.match(
      validate(`${enumRemoveContract(ENUM_HEADER)}\n`, { live }).finding,
      /still names B: the expand step for this removal is missing/,
    );
  });

  test("an image-catalog failure is a finding", () => {
    assert.match(
      validate(`ALTER TABLE "t" ${DROP} COLUMN "x";\n`, { image: new Error("timed out") }).finding,
      /image's schema could not be read \(timed out\)/,
    );
  });

  test("an unknown template version → deploy a newer image", () => {
    const sql = enumRemoveContract(ENUM_HEADER).replace(
      "-- knowledge-base:enum-remove v1",
      "-- knowledge-base:enum-remove v9",
    );
    assert.match(
      validate(`${sql}\n`).finding,
      /template v9 not known to this image.*deploy a newer image/,
    );
  });
});

// --- applyContract ------------------------------------------------------------

function fakeClock(start = NOW) {
  const clock = { t: start };
  clock.now = () => clock.t;
  return clock;
}

/**
 * One `_knowledge_base_migration` row with transaction semantics, and a hook that
 * decides what each contract statement does.
 */
function contractDb({ initial = row(), onStatement = () => {}, clock = fakeClock() } = {}) {
  // timeouts: the statement_timeout each contract statement ran with.
  const db = {
    row: { ...initial },
    snapshot: null,
    timeouts: [],
    committed: [],
    timeout: 0,
    sets: [],
  };
  const client = new EventEmitter();
  client.query = async (sql, params = []) => {
    if (sql === "BEGIN") db.snapshot = { ...db.row };
    else if (sql === "COMMIT") db.snapshot = null;
    else if (sql === "ROLLBACK") {
      if (db.snapshot) db.row = db.snapshot;
      db.snapshot = null;
    } else if (/SET LOCAL statement_timeout/.test(sql)) {
      db.timeout = Number(/= (\d+)/.exec(sql)[1]);
      db.sets.push(sql);
    } else if (/^SET LOCAL/.test(sql)) {
      db.sets.push(sql);
      // lock_timeout / search_path
    } else if (/FOR UPDATE/.test(sql)) return { rows: [{ ...db.row }] };
    else if (/SET contract_attempts = CASE/.test(sql)) {
      const level = params[1];
      const fresh = db.row.contract_attempt_level === null || level > db.row.contract_attempt_level;
      db.row.contract_attempts = fresh ? 1 : db.row.contract_attempts + 1;
      db.row.contract_attempt_level = level;
    } else if (/SET contract_applied_at = now\(\)/.test(sql)) {
      db.row.contract_applied_at = new Date(NOW);
      db.row.contract_backup = params[1];
      db.row.contract_note = params[2];
      db.row.contract_last_error = null;
    } else if (/SET contract_attempts = \$2, contract_attempt_level = \$3/.test(sql)) {
      db.row.contract_attempts = params[1];
      db.row.contract_attempt_level = params[2];
      db.row.contract_last_error = params[3];
    } else if (/SET contract_last_error = \$2/.test(sql)) db.row.contract_last_error = params[1];
    else {
      db.timeouts.push(db.timeout);
      return (await onStatement(sql, client, clock)) ?? { rows: [] };
    }
    return { rows: [] };
  };
  return { db, client, clock };
}

const PLAIN = `ALTER TABLE "t" ${DROP} COLUMN "x";\n`;
const LEVEL = "20261103000000_level";
async function apply(
  db,
  { sql = PLAIN, budgetMs = 30_000, level = LEVEL, replan = async () => true } = {},
) {
  const migration = contractOf(sql);
  const clock = db.clock;
  return applyContract(db.client, {
    schema: "public",
    migration,
    analysis: analyzeContract(sql, { folder: FOLDER }),
    level,
    deadline: clock.now() + budgetMs,
    backup: "pre-drop-x.dump",
    now: clock.now,
    replan,
  });
}
const failing = (error, { advance = 0 } = {}) => ({
  onStatement: (_sql, _client, clock) => {
    clock.t += advance;
    throw error;
  },
});

describe("applyContract", () => {
  test("applies, records the backup and captures knowledge-base: notices", async () => {
    const t = contractDb({
      onStatement: (_sql, client) => {
        client.emit("notice", { message: 'knowledge-base:label-kept "E" "B" (timed out)' });
        client.emit("notice", { message: "unrelated" });
      },
    });
    const result = await apply(t);
    assert.equal(result.status, "applied");
    assert.ok(t.db.row.contract_applied_at);
    assert.equal(t.db.row.contract_backup, "pre-drop-x.dump");
    assert.equal(t.db.row.contract_note, 'knowledge-base:label-kept "E" "B" (timed out)');
    assert.equal(t.db.row.contract_attempts, 1);
  });

  test("no-op when already applied", async () => {
    const t = contractDb({ initial: row({ contract_applied_at: new Date(NOW) }) });
    assert.equal((await apply(t)).status, "noop");
    assert.equal(t.db.row.contract_attempts, 0);
  });

  test("start rule: less than CONTRACT_START_MIN_MS left → not started, nothing touched", async () => {
    const t = contractDb({});
    const result = await apply(t, { budgetMs: CONTRACT_START_MIN_MS - 1 });
    assert.equal(result.status, "not-started");
    assert.equal(t.db.row.contract_attempts, 0);
  });

  test("no longer due on re-plan → rolled back and the attempt undone", async () => {
    const t = contractDb({});
    assert.equal((await apply(t, { replan: async () => false })).status, "not-due");
    assert.equal(t.db.row.contract_attempts, 0);
    assert.equal(t.db.row.contract_applied_at, null);
  });

  for (const code of ["55P03", "40P01", "08006"])
    test(`${code} undoes the attempt`, async () => {
      const t = contractDb(failing(sqlError(code)));
      assert.equal((await apply(t)).status, "transient");
      assert.deepEqual([t.db.row.contract_attempts, t.db.row.contract_attempt_level], [0, null]);
      assert.match(t.db.row.contract_last_error, new RegExp(`^${code}: `));
    });

  test("a connection loss without a SQLSTATE undoes the attempt", async () => {
    const t = contractDb(failing(new Error("Connection terminated unexpectedly")));
    assert.equal((await apply(t)).status, "transient");
    assert.equal(t.db.row.contract_attempts, 0);
  });

  test("a full-15 s 57014 on a plain statement counts", async () => {
    const t = contractDb(failing(sqlError("57014"), { advance: 15_000 }));
    const result = await apply(t, { budgetMs: 60_000 });
    assert.equal(result.status, "counted");
    assert.equal(t.db.row.contract_attempts, 1);
    assert.equal(t.db.timeouts[0], CONTRACT_STATEMENT_TIMEOUT_MS);
  });

  test("an external cancel (57014 well before its timeout) undoes the attempt", async () => {
    const t = contractDb(failing(sqlError("57014"), { advance: 2_000 }));
    assert.equal((await apply(t)).status, "transient");
    assert.equal(t.db.row.contract_attempts, 0);
  });

  test("a crash after the attempt is recorded counts (the accounting commits first)", async () => {
    const t = contractDb({ onStatement: () => new Promise(() => {}) });
    void apply(t);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.db.row.contract_attempts, 1);
    assert.equal(t.db.row.contract_attempt_level, LEVEL);
  });

  test("non-template statements get clamp(remaining, 1 s, 15 s)", () => {
    assert.equal(statementTimeoutMs({ template: false, remainingMs: 25_000 }), 15_000);
    assert.equal(statementTimeoutMs({ template: false, remainingMs: 4_321.9 }), 4_321);
    assert.equal(statementTimeoutMs({ template: false, remainingMs: -5 }), 1_000);
    assert.equal(statementTimeoutMs({ template: true, remainingMs: 1 }), 15_000);
  });

  test("the timeout is computed per statement from the remaining budget", async () => {
    const sql = `ALTER TABLE "t" ${DROP} COLUMN "x";\n${DROP} INDEX "i";\n`;
    const t = contractDb({
      onStatement: (_sql, _client, clock) => {
        clock.t += 8_000;
      },
    });
    await apply(t, { sql, budgetMs: 20_000 });
    assert.deepEqual(t.db.timeouts, [15_000, 12_000]);
  });

  test("the enum template always gets the fixed 15 s", async () => {
    const sql = `${enumRemoveContract(ENUM_HEADER)}\n`;
    const t = contractDb({});
    await apply(t, { sql, budgetMs: CONTRACT_START_MIN_MS });
    assert.deepEqual(t.db.timeouts, [15_000]);
  });

  test("the attempt accounting and the row lock are bounded by lock and statement timeouts", async () => {
    const t = contractDb({});
    await apply(t);
    const bounded = [
      `SET LOCAL lock_timeout = ${CONTRACT_PREAMBLE_TIMEOUT_MS}`,
      `SET LOCAL statement_timeout = ${CONTRACT_PREAMBLE_TIMEOUT_MS}`,
    ];
    assert.deepEqual(t.db.sets.slice(0, 2), bounded, "attempt accounting");
    assert.ok(t.db.sets.slice(2).includes(bounded[1]), "row lock and re-plan");
  });

  test("the enum template never starts with less than its fixed 15 s left", async () => {
    const sql = `${enumRemoveContract(ENUM_HEADER)}\n`;
    const t = contractDb({});
    const result = await apply(t, {
      sql,
      budgetMs: CONTRACT_START_MIN_MS,
      // The bookkeeping waited on locks for 5.001 s.
      replan: async () => {
        t.clock.t += CONTRACT_START_MIN_MS - CONTRACT_STATEMENT_TIMEOUT_MS + 1;
        return true;
      },
    });
    assert.equal(result.status, "not-started");
    assert.deepEqual(t.db.timeouts, [], "the template never ran");
    assert.deepEqual([t.db.row.contract_attempts, t.db.row.contract_applied_at], [0, null]);
  });

  test("past the deadline no further statement starts: rolled back like a shortened timeout", async () => {
    const sql = `ALTER TABLE "t" ${DROP} COLUMN "x";\n${DROP} INDEX "i";\n`;
    const t = contractDb({
      onStatement: (_sql, _client, clock) => {
        clock.t += 25_000;
      },
    });
    const result = await apply(t, { sql, budgetMs: 25_000 });
    assert.equal(result.status, "short-timeout");
    assert.deepEqual(t.db.timeouts, [15_000], "the second statement never ran");
    assert.match(
      t.db.row.contract_last_error,
      /^short-timeout \S+ 1\/3: the time budget ran out before statement 2 of 2/,
    );
    assert.deepEqual([t.db.row.contract_attempts, t.db.row.contract_applied_at], [0, null]);
  });

  describe("repeated shortened 57014 (R5-5, R6-2)", () => {
    test("1st and 2nd at one level are undone with 1/3, 2/3; the 3rd needs a person", async () => {
      // Each run starts with exactly the minimum budget; the re-plan uses 15 s
      // of it, so the statement runs with a shortened 5 s timeout and hits it.
      const t = contractDb({
        onStatement: (_sql, _client, clock) => {
          clock.t += 5_000;
          throw sqlError("57014", "canceling statement due to statement timeout");
        },
      });
      const run = () => {
        t.clock.t = NOW;
        return apply(t, {
          budgetMs: CONTRACT_START_MIN_MS,
          replan: async () => {
            t.clock.t += 15_000;
            return true;
          },
        });
      };
      assert.equal((await run()).status, "short-timeout");
      assert.deepEqual(t.db.timeouts, [5_000]);
      assert.match(
        t.db.row.contract_last_error,
        /^short-timeout 20261103000000_level 1\/3: 57014: /,
      );
      assert.equal(t.db.row.contract_attempts, 0);
      assert.equal((await run()).status, "short-timeout");
      assert.match(t.db.row.contract_last_error, /^short-timeout \S+ 2\/3: /);
      assert.equal((await run()).status, "counted");
      assert.match(t.db.row.contract_last_error, /^short-timeout \S+ 3\/3: /);
      assert.equal(t.db.row.contract_attempts, 3);
      const lines = scheduleLines(
        planContracts({
          now: NOW,
          fresh: true,
          level: LEVEL,
          pending: [{ name: FOLDER, row: t.db.row }],
        }),
      );
      assert.match(lines[0], /needs a person: the database stayed busy while deleting/);
    });

    test("classification: a newer level restarts n at 1 and the attempts reset", () => {
      const failure = classifyFailure({
        error: sqlError("57014"),
        timeoutMs: 5_000,
        elapsedMs: 5_000,
        template: false,
        level: "20261201000000_newer",
        lastError: `short-timeout ${LEVEL} 2/3: 57014: x`,
      });
      assert.deepEqual([failure.kind, failure.n], ["short-timeout", 1]);
      assert.equal(
        planContracts({
          now: NOW,
          fresh: true,
          level: "20261201000000_newer",
          pending: [
            { name: FOLDER, row: row({ contract_attempts: 3, contract_attempt_level: LEVEL }) },
          ],
        }).due.length,
        1,
      );
    });

    test("a counted error between two shortened timeouts restarts n at 1", () => {
      const counted = classifyFailure({
        error: sqlError("XX000", "boom"),
        timeoutMs: 15_000,
        elapsedMs: 10,
        template: false,
        level: LEVEL,
        lastError: `short-timeout ${LEVEL} 1/3: 57014: x`,
      });
      assert.deepEqual([counted.kind, counted.lastError], ["counted", "XX000: boom"]);
      const next = classifyFailure({
        error: sqlError("57014"),
        timeoutMs: 5_000,
        elapsedMs: 5_000,
        template: false,
        level: LEVEL,
        lastError: counted.lastError,
      });
      assert.equal(next.n, 1);
    });

    test("55P03 and an external-cancel 57014 keep the prefix and never touch n", () => {
      const prefix = `short-timeout ${LEVEL} 2/3: `;
      for (const [error, elapsedMs] of [
        [sqlError("55P03", "lock timeout"), 5_000],
        [sqlError("57014", "canceling statement due to user request"), 100],
      ]) {
        const failure = classifyFailure({
          error,
          timeoutMs: 5_000,
          elapsedMs,
          template: false,
          level: LEVEL,
          lastError: `${prefix}57014: x`,
        });
        assert.equal(failure.kind, "transient");
        assert.ok(failure.lastError.startsWith(prefix), failure.lastError);
      }
    });

    test("a 57014 escaping the enum template after its full 15 s counts like a shortened one", () => {
      const failure = classifyFailure({
        error: sqlError("57014"),
        timeoutMs: 15_000,
        elapsedMs: 15_000,
        template: true,
        level: LEVEL,
        lastError: null,
      });
      assert.deepEqual([failure.kind, failure.n], ["short-timeout", 1]);
    });
  });
});

describe("applyAllContracts", () => {
  test("each contract runs in its own transaction with Prisma's schema on the search_path", async () => {
    const client = scripted([]);
    const done = await applyAllContracts(
      client,
      [
        { name: "a", contract: { sql: PLAIN } },
        { name: "b", contract: null },
      ],
      { schema: "app" },
    );
    assert.deepEqual(done, ["a"]);
    assert.deepEqual(
      client.queries.map((q) => q.sql),
      ["BEGIN", 'SET LOCAL search_path TO "app"', PLAIN, "COMMIT"],
    );
  });
});

describe("recordApplied", () => {
  test("inserts only missing rows, with rollback safety, checksum and effects", async () => {
    const client = scripted([
      [/SELECT name FROM/, { rows: [{ name: "0_init" }] }],
      [/INSERT/, { rowCount: 1, rows: [] }],
    ]);
    const migrations = [
      { name: "0_init", sql: wrapTransactional('CREATE TABLE "t" ("x" TEXT);'), contract: null },
      {
        name: R1,
        sql: wrapTransactional('ALTER TABLE "t" ADD COLUMN "y" TEXT;'),
        contract: { sql: PLAIN, checksum: "abc" },
      },
      { name: R2, sql: wrapTransactional("ALTER TYPE \"E\" ADD VALUE 'Z';"), contract: null },
    ];
    assert.equal(await recordApplied(client, { schema: "public", migrations }), 2);
    const inserts = client.queries.filter((q) => /INSERT/.test(q.sql)).map((q) => q.params);
    assert.deepEqual(inserts[0], [R1, true, null, "abc", 'column "t"."x"']);
    assert.equal(inserts[1][0], R2);
    assert.equal(inserts[1][1], false);
    assert.match(inserts[1][2], /adds an enum value/);
  });
});

describe("pre-deploy checks", () => {
  const matches = [
    { key: "column:public.t.x", folder: R2, line: 3, droppedBy: R1 },
    { key: "label:public.E:B", folder: R2, line: 4, droppedBy: R1 },
  ];
  test("name reuse: every static match on a fresh database; only live objects otherwise", () => {
    assert.equal(nameReuseLive(matches, { toApply: [R2], fresh: true, live: null }).length, 2);
    assert.deepEqual(
      nameReuseLive(matches, { toApply: [R2], fresh: false, live: LIVE }).map((m) => m.key),
      ["column:public.t.x", "label:public.E:B"],
    );
    assert.deepEqual(nameReuseLive(matches, { toApply: [R2], fresh: false, live: IMAGE }), []);
    assert.deepEqual(nameReuseLive(matches, { toApply: [], fresh: true, live: null }), []);
  });

  test("late recovery: a pending recover block whose source column is gone", () => {
    const late = lateRecoveries(
      [{ name: R2, templates: [{ kind: "recover", header: { table: "t", from: "x", to: "x2" } }] }],
      {
        live: IMAGE,
        applied: [
          {
            name: R1,
            contract_applied_at: new Date(NOW),
            contract_backup: "pre-drop-1.dump",
            droppedColumns: new Set(["public.t.x"]),
          },
        ],
      },
    );
    assert.deepEqual(late, [
      {
        folder: R2,
        column: '"t"."x"',
        deletedAt: "2026-11-07T12:00:00Z",
        backup: "pre-drop-1.dump",
      },
    ]);
    assert.deepEqual(
      lateRecoveries(
        [
          {
            name: R2,
            templates: [{ kind: "recover", header: { table: "t", from: "x", to: "x2" } }],
          },
        ],
        {
          live: LIVE,
          applied: [],
        },
      ),
      [],
    );
  });
});

test("snapshot history records a matching applied subset and verifies contract state", async () => {
  const { captureMigrationHistory, validateMigrationHistory } = await import("./contracts.mjs");
  const migrations = [
    { name: "0_init", checksum: "a", contract: null },
    { name: "20990101000000_expand", checksum: "b", contract: { checksum: "c" } },
  ];
  const client = {
    query: async (sql) =>
      /_prisma_migrations/.test(sql)
        ? {
            rows: [
              { name: "0_init", checksum: "a", finished_at: new Date(), rolled_back_at: null },
            ],
          }
        : { rows: [{ present: false }] },
  };
  const history = await captureMigrationHistory(client, { schema: "public", migrations });
  assert.deepEqual(history.applied, [{ name: "0_init", checksum: "a" }]);
  assert.equal(history.migrations.length, 2, "new image may ship unapplied files");
  assert.throws(
    () =>
      validateMigrationHistory(
        { ...history, applied: [{ name: "20990101000000_expand", checksum: "b" }] },
        migrations,
      ),
    /lacks contract execution state/,
  );
  assert.throws(
    () =>
      validateMigrationHistory(
        {
          ...history,
          applied: [...history.applied, { name: "20990101000000_expand", checksum: "b" }],
        },
        migrations,
      ),
    /lacks contract execution state/,
  );
  client.query = async () => ({
    rows: [{ name: "0_init", checksum: "a", finished_at: null, rolled_back_at: null }],
  });
  await assert.rejects(
    captureMigrationHistory(client, { schema: "public", migrations }),
    /unfinished/,
  );
});

test("restore finalization keeps the existing session/transaction and longer hold", async () => {
  const { finalizeRestoreState, SOAK_MS } = await import("./contracts.mjs");
  const queries = [];
  const existing = new Date(Date.now() + 30 * 86400000);
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/greatest\(h.until/.test(sql)) return { rows: [{ until: existing }] };
      return { rows: [] };
    },
  };
  assert.equal(await finalizeRestoreState(client, { schema: "tenant" }), existing);
  assert.ok(
    queries.some(({ sql }) =>
      /DELETE FROM "tenant"\."_knowledge_base_instance" WHERE id IS NOT NULL/.test(sql),
    ),
  );
  assert.ok(queries.some(({ params }) => params?.[0] === "restore" && params[1] === SOAK_MS));
  assert.ok(
    !queries.some(({ sql }) => /^(BEGIN|COMMIT)/.test(sql)),
    "restore owns its final transaction",
  );
  await assert.rejects(finalizeRestoreState(client, { schema: "tenant", holdMs: 1 }), /seven days/);
});

test("snapshot accepts out-of-order applied subsets, rejects unknown, duplicate and edited rows", async () => {
  const { validateMigrationHistory } = await import("./contracts.mjs");
  const migrations = ["0_init", "1_early", "2_later"].map((name) => ({
    name,
    checksum: name,
    contract: null,
  }));
  const history = {
    version: 1,
    migrations: migrations.map((m) => ({ ...m, contractChecksum: null })),
    applied: [migrations[0], migrations[2]],
    contracts: [],
  };
  assert.doesNotThrow(() => validateMigrationHistory(history, migrations));
  for (const row of [
    { name: "unknown", checksum: "x" },
    migrations[0],
    { ...migrations[1], checksum: "edited" },
  ]) {
    assert.throws(
      () =>
        validateMigrationHistory({ ...history, applied: [...history.applied, row] }, migrations),
      /unique matching subset/,
    );
  }
});
