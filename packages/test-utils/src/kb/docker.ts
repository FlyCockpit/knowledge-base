/** Named Docker fixtures retain ownership even when their CLI times out. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Reuse the runner's ownership label; standalone fixtures own their process.
const runnerProject = process.env.KB_TEST_PROJECT ?? "";
const fixtureProject = /^kb-test-[a-z0-9-]+-\d+-[0-9a-f]{6}$/.test(runnerProject)
  ? runnerProject
  : `kb-test-fixture-${process.pid}-${randomBytes(3).toString("hex")}`;

export function dockerFixtureLabels(): string[] {
  return ["--label", `io.knowledge-base.test-project=${fixtureProject}`];
}

export async function removeDockerContainer(name: string): Promise<void> {
  if (!/^kb-[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid owned Docker fixture name");
  try {
    await exec("docker", ["rm", "--force", name], { timeout: 60_000 });
  } catch (error) {
    // --rm may already have removed a successful foreground container.
    if (
      !(error instanceof Error) ||
      !Reflect.get(error, "stderr")?.includes(`No such container: ${name}`)
    )
      throw error;
  }
  const remaining = await exec(
    "docker",
    ["ps", "--all", "--quiet", "--filter", `name=^/${name}$`],
    { timeout: 60_000 },
  );
  if (remaining.stdout.trim()) throw new Error(`Docker fixture survived cleanup: ${name}`);
}

const pendingFixtures = new Set<Promise<void>>();
const cleanupFailures: unknown[] = [];

function recordCleanupFailure(error: unknown): never {
  cleanupFailures.push(error);
  throw error;
}

/** Join actions abandoned by a test deadline before the suite exits. */
export async function drainDockerFixtures(): Promise<void> {
  // An abandoned callback may start its next fixture as the first action
  // settles. Recheck the registry after joining each complete lifecycle.
  while (pendingFixtures.size) await Promise.all([...pendingFixtures]);
  const failures = cleanupFailures.splice(0);
  if (failures.length) throw new AggregateError(failures, "Docker fixture cleanup failed");
}

export function withDockerContainer<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  if (!/^kb-[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid owned Docker fixture name");
  // Register before invoking the action, including synchronous native clients.
  const action = Promise.resolve().then(async () => {
    try {
      return await run();
    } finally {
      await removeDockerContainer(name).catch(recordCleanupFailure);
    }
  });
  const settled = action
    .then(
      () => {},
      () => {},
    )
    .finally(() => pendingFixtures.delete(settled));
  pendingFixtures.add(settled);
  return action;
}
