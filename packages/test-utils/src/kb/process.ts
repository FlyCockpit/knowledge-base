import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, openSync, readFileSync, readlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { buildArtifactPath, requireBuiltArtifact } from "./build-artifacts.mjs";

const owners = new Set<Promise<void>>();
const releases = new Set<() => void>();

/** Own a discovered Linux descendant through a kernel handle, never a later PID lookup. */
export async function ownProcess(pid: number, expected?: string, fixtureRoot?: string) {
  // Pin /proc before any asynchronous hand-off can delay capture.
  let directory: number;
  try {
    directory = openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let identity: string;
  try {
    if (
      fixtureRoot !== undefined &&
      readlinkSync(`/proc/self/fd/${directory}/cwd`) !== fixtureRoot
    ) {
      closeSync(directory);
      return undefined;
    }
    const stat = readFileSync(`/proc/self/fd/${directory}/stat`, "utf8");
    identity = expected ?? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
  } catch (error) {
    closeSync(directory);
    if (
      error instanceof Error &&
      "code" in error &&
      ["ESRCH", "ENOENT"].includes(String(error.code))
    )
      return undefined;
    throw error;
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      requireBuiltArtifact(
        buildArtifactPath("process-owner"),
        `pnpm test:kb --build-only ${process.env.KB_TEST_SUITE ?? "fence"}`,
      ),
      [String(pid), identity],
      {
        stdio: ["pipe", "pipe", "pipe", directory],
      },
    );
  } finally {
    closeSync(directory);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    child.stdin?.end();
  };
  releases.add(release);
  let errorText = "";
  child.stderr?.on("data", (chunk) => {
    errorText += chunk.toString();
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`process owner exited ${code}: ${errorText}`)),
    );
  });
  // Keep failures observed, but retain the actual result for teardown.
  void closed.catch(() => {});
  owners.add(closed);
  void closed.finally(() => releases.delete(release)).catch(() => {});
  const reader = createInterface({ input: child.stdout! });
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("process owner readiness timed out")),
        15_000,
      );
      const finish = (value: string) => {
        clearTimeout(timer);
        resolve(value);
      };
      reader.once("line", finish);
      void closed.then(
        () => finish("STALE"),
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    if (ready !== "READY") {
      await closed;
      return undefined;
    }
    return {
      done: closed,
      async kill() {
        release();
        await closed;
      },
    };
  } catch (error) {
    release();
    await closed;
    throw error;
  } finally {
    reader.close();
  }
}

export async function drainProcessFixtures(): Promise<void> {
  for (const release of releases) release();
  const results = await Promise.allSettled(owners);
  owners.clear();
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

export type TrackedChild = {
  child: ChildProcess;
  pid: number;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export function spawnProcessGroup(
  file: string,
  args: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    stdio?: ("pipe" | "ignore")[];
    detached?: boolean;
  },
): TrackedChild {
  const child = spawn(file, args, {
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    stdio: options?.stdio ?? ["ignore", "ignore", "ignore"],
    detached: options?.detached ?? true,
  });
  const pid = child.pid;
  if (pid == null) throw new Error(`Failed to spawn ${file}`);
  const done = once(child, "exit").then(([code, signal]) => ({
    code: typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? (signal as NodeJS.Signals) : null,
  }));
  return { child, pid, done };
}

export async function reapProcessTree(
  tracked: TrackedChild,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const { child, pid } = tracked;
  if (child.exitCode != null || child.signalCode != null) return tracked.done;
  const tryKill = (target: number, sig: NodeJS.Signals) => {
    try {
      process.kill(target, sig);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return false;
    }
  };
  const signalTree = (sig: NodeJS.Signals) => {
    tryKill(-pid, sig) || tryKill(pid, sig);
  };
  signalTree(signal);
  const result = await Promise.race([
    tracked.done,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 5_000);
    }),
  ]);
  if (result !== "timeout") return result;
  signalTree("SIGKILL");
  return tracked.done;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
