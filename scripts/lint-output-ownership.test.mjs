/**
 * R3-W3: the logger writes the dedicated channel; the output supervisor alone
 * publishes process output. `.oxlintrc.json` enforces direct usage with
 * standard rules as fast developer feedback. Aliases and CommonJS loading
 * are covered by runtime ownership, not an expanding lint blacklist.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const RUNTIME_ONLY = {
  processAlias:
    "const p = process; export const f = (error: Error) => p.stderr.write(error.stack!);",
  requireProcess:
    'const { stderr } = require("node:process"); export const f = (error: Error) => stderr.write(error.stack!);',
};
const BYPASSES = {
  call: "export const f = (caught: unknown) => console.error(caught);",
  computed: 'export const f = (x: unknown) => console["error"](x);',
  destructured: "const { error: log } = console;\nexport const f = (x: unknown) => log(x);",
  aliased: "const log = console.warn;\nexport const f = (x: unknown) => log(x);",
  globalThis: "export const f = (x: unknown) => globalThis.console.log(x);",
  stderr: "export const f = (x: unknown) => process.stderr.write(String(x));",
  stdoutComputed: 'export const f = () => process["stdout"].write("x");',
  streamDestructured: 'const { stderr } = process;\nexport const f = () => stderr.write("x");',
  importedStream:
    'import { stderr } from "node:process";\nexport const f = () => stderr.write("x");',
  defaultProcess: 'import p from "node:process";\nexport const f = () => p.stderr.write("x");',
  namespaceProcess:
    'import * as p from "node:process";\nexport const f = () => p.stdout.write("x");',
  importedConsole: 'import { Console } from "node:console";\nexport const c = Console;',
};

function lint(dir) {
  try {
    // oxlint picks its default formatter from the environment; the one-line unix format keeps the assertions stable.
    execFileSync("pnpm", ["exec", "oxlint", "--format", "unix", relative(ROOT, dir)], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return "";
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

for (const pkg of [
  "apps/server/src",
  "apps/worker/src",
  "packages/api/src",
  "packages/auth/src",
  "packages/queue/src",
  "packages/mailer/src",
  "packages/db/src",
  "packages/env/src",
  "packages/locales/src",
  "packages/i18n-translate/src",
]) {
  test(`${pkg}: direct output gets lint feedback; aliases belong to the runtime boundary`, () => {
    const dir = mkdtempSync(join(ROOT, pkg, "zz-output-probe-"));
    try {
      for (const [name, source] of Object.entries(BYPASSES))
        writeFileSync(join(dir, `${name}.ts`), `${source}\n`);
      for (const [name, source] of Object.entries(RUNTIME_ONLY))
        writeFileSync(join(dir, `${name}.ts`), `${source}\n`);
      const out = lint(dir);
      for (const name of Object.keys(BYPASSES))
        assert.match(
          out,
          new RegExp(`${name}\\.ts.*no-restricted`),
          `${pkg}: ${name} not rejected`,
        );
      for (const name of Object.keys(RUNTIME_ONLY))
        assert.doesNotMatch(out, new RegExp(`${name}\\.ts.*no-restricted`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the repository passes, only the logger channel and output supervisor may write", () => {
  assert.equal(lint(join(ROOT, "packages/env/src/log.ts")), "");
  assert.equal(lint(join(ROOT, "packages/env/src/service-output.ts")), "");
  const out = lint(ROOT);
  assert.equal(out, "");
});
