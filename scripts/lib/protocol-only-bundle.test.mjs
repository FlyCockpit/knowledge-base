import assert from "node:assert/strict";
import { test } from "node:test";

import { protocolOnlyViolations } from "./protocol-only-bundle.mjs";

const LOG = "/repo/packages/env/src/log.ts";
const chunk = (fileName, rest = {}) => ({
  type: "chunk",
  fileName,
  moduleIds: [],
  imports: [],
  dynamicImports: [],
  ...rest,
});
const base = [
  chunk("service.mjs", { name: "service", isEntry: true, dynamicImports: ["index.mjs"] }),
  chunk("index.mjs", { imports: ["log.mjs"] }),
  chunk("log.mjs", { moduleIds: [LOG] }),
  chunk("shared.mjs", { moduleIds: ["/repo/packages/env/src/log-record.ts"] }),
];

test("a protocol entry whose chunks never contain the logger passes", () => {
  const hook = chunk("hook.mjs", { name: "hook", isEntry: true, imports: ["shared.mjs"] });
  assert.deepEqual(protocolOnlyViolations([...base, hook], ["hook"], "service"), []);
});

test("the logger reached through static or dynamic chunk imports fails, with its path", () => {
  for (const edge of ["imports", "dynamicImports"]) {
    const hook = chunk("hook.mjs", { name: "hook", isEntry: true, [edge]: ["mid.mjs"] });
    const mid = chunk("mid.mjs", { dynamicImports: ["log.mjs"] });
    assert.deepEqual(protocolOnlyViolations([...base, hook, mid], ["hook"], "service"), [
      'protocol-only entry "hook" loads the logger: hook.mjs -> mid.mjs -> log.mjs',
    ]);
  }
});

test("a missing entry or a walk that cannot see the logger fails closed", () => {
  assert.deepEqual(protocolOnlyViolations(base, ["hook"], "service"), [
    'no "hook" entry chunk in the build output',
  ]);
  const blind = base.map((c) => ({ ...c, moduleIds: undefined }));
  const hook = chunk("hook.mjs", { name: "hook", isEntry: true });
  assert.deepEqual(protocolOnlyViolations([...blind, hook], ["hook"], "service"), [
    'the "service" entry does not reach the logger: the check is blind',
  ]);
});
