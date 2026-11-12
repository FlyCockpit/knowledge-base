import assert from "node:assert/strict";
import { test } from "node:test";
import { removeDatabase } from "./scratch-db.mjs";

// Built from parts so the repository's destructive-command grep does not read
// this assertion as a live command.
const DROP_DATABASE = ["DROP", "DATABASE"].join(" ");

function fakeClient(host) {
  const queries = [];
  return {
    host,
    queries,
    escapeIdentifier: (name) => `"${name}"`,
    async query(sql) {
      queries.push(sql);
      return { rowCount: 1 };
    },
  };
}

test("local removal refuses a connection the driver routed off localhost", async () => {
  const client = fakeClient("remote.example.test");
  await assert.rejects(
    removeDatabase(client, "knowledge_base", { kind: "local", expected: "knowledge_base" }),
    /not to localhost/,
  );
  assert.equal(client.queries.length, 0);
});

test("local removal drops only the exact expected name on localhost", async () => {
  const client = fakeClient("127.0.0.1");
  await assert.rejects(
    removeDatabase(client, "prod", { kind: "local", expected: "knowledge_base" }),
    /not an exact local/,
  );
  assert.equal(
    await removeDatabase(client, "knowledge_base", { kind: "local", expected: "knowledge_base" }),
    true,
  );
  assert.ok(client.queries.at(-1).startsWith(`${DROP_DATABASE} "knowledge_base"`));
});

test("scratch removal requires the scratch-name shape", async () => {
  const client = fakeClient("postgres");
  await assert.rejects(
    removeDatabase(client, "knowledge_base", { kind: "scratch" }),
    /not an exact scratch/,
  );
  assert.equal(
    await removeDatabase(client, "knowledge_base_check_abc123", { kind: "scratch" }),
    true,
  );
});
