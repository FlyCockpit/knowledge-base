import assert from "node:assert/strict";
import { test } from "node:test";
import { containerPrefix } from "./test-migrations.mjs";

test("the throwaway container: the flag replaces the name, TEST_CONTAINER_PREFIX goes in front", () => {
  assert.equal(containerPrefix([], {}), "knowledge-base-test-migrations");
  assert.equal(
    containerPrefix([], { TEST_CONTAINER_PREFIX: "" }),
    "knowledge-base-test-migrations",
  );
  assert.equal(
    containerPrefix([], { TEST_CONTAINER_PREFIX: "ci-x" }),
    "ci-x-knowledge-base-test-migrations",
  );
  assert.equal(
    containerPrefix([], { TEST_CONTAINER_PREFIX: "ci-x-" }),
    "ci-x-knowledge-base-test-migrations",
  );
  // The flag wins over the variable.
  assert.equal(
    containerPrefix(["node", "x", "--container-prefix", "ci-2"], {
      TEST_CONTAINER_PREFIX: "ci-x",
    }),
    "ci-2",
  );
  for (const bad of ["Bad_Prefix", "kb-x", "a-kb-test", "-x", "x".repeat(33)])
    assert.throws(
      () => containerPrefix([], { TEST_CONTAINER_PREFIX: bad }),
      /TEST_CONTAINER_PREFIX must be/,
      bad,
    );
  assert.throws(
    () => containerPrefix(["node", "x", "--container-prefix"], {}),
    /--container-prefix/,
  );
});
