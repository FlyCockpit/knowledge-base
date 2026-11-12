import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, it } from "vitest";

/** Own and drain real Git preparation separately from the action deadline. */
export function gitFixtureTests<T>(prefix: string, prepare: (root: string) => T | Promise<T>) {
  let reposDir: string | undefined;
  let fixture: T | undefined;
  let setup: Promise<void> | undefined;
  let action: Promise<void> | undefined;
  beforeAll(() => {
    setup = (async () => {
      const root = mkdtempSync(join(tmpdir(), prefix));
      reposDir = root;
      fixture = await prepare(root);
    })();
    return setup;
  }, 180_000);
  afterEach(async () => {
    // Timeout does not release ownership of still-running native work.
    await action?.catch(() => {});
    action = undefined;
  }, 180_000);
  afterAll(async () => {
    await setup?.catch(() => {});
    await action?.catch(() => {});
    if (reposDir) rmSync(reposDir, { recursive: true, force: true });
  }, 180_000);
  return (
    name: string,
    run: (fixture: T) => void | Promise<void>,
    options: { timeout?: number } = {},
  ) => {
    it(name, options, () => {
      action = Promise.resolve().then(() => {
        if (!fixture) throw new Error("Git fixture is not ready");
        return run(fixture);
      });
      return action;
    });
  };
}
