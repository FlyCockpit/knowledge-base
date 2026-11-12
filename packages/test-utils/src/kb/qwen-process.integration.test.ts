/**
 * Real-process Qwen child lifecycle. The parent is the real
 * supervisor; children are real OS processes forked through the compiled native
 * guard. A small fake child (fake-qwen.child.mjs) replaces the model so clocks
 * and barriers are deterministic. Exit evidence is /proc state, never a kill spy.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildArtifactPath, requireBuiltArtifact } from "./build-artifacts.mjs";
import { drainProcessFixtures, ownProcess } from "./process";

type Purpose = "query" | "document";
type Supervisor = {
  embed(input: {
    purpose: Purpose;
    texts: string[];
    runtime: {
      modelId: string;
      epoch: number;
      config: { contextTokens: number; kvKeyType: string; kvValueType: string };
    };
    signal?: AbortSignal;
  }): Promise<number[][]>;
  probe(
    runtime: ReturnType<typeof rt>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ peakRssBytes: number | null }>;
  suspend(): Promise<void>;
  resume(): void;
  countTokens(input: {
    purpose: Purpose;
    texts: string[];
    runtime: ReturnType<typeof rt>;
    signal?: AbortSignal;
  }): Promise<unknown>;
  disable(): Promise<void>;
  close(): Promise<void>;
  snapshot(): { pid: number | null; spawns: number };
};
type Clock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
/** A READY model epoch plus the admin runtime config it runs under. */
const rt = (epoch: number) => ({
  modelId: "qwen3-embedding-0.6b-q8_0",
  epoch,
  config: { contextTokens: 4096, kvKeyType: "f16", kvValueType: "f16" } as const,
});
// Dynamic module URL keeps this composite TS project inside its root.
const lifecycle = (await import(
  new URL("../../../../apps/worker/src/lib/qwen-lifecycle.ts", import.meta.url).href
)) as {
  QWEN_IDLE_MS: number;
  QwenDisabledError: new () => Error;
  createQwenSupervisor(options: Record<string, unknown>): Supervisor;
};

const FAKE_CHILD = join(import.meta.dirname, "fake-qwen.child.mjs");
const PARENT_CHILD = join(import.meta.dirname, "qwen-parent.child.ts");

const dirs: string[] = [];
const supervisors: Supervisor[] = [];
const ownedChildren: Array<{ child: ChildProcess; done: Promise<unknown> }> = [];
let guard = "";

function tmp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** OS evidence: "gone" means no /proc entry at all (reaped). */
function procState(pid: number): "gone" | "zombie" | "alive" {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z" ? "zombie" : "alive";
  } catch {
    return "gone";
  }
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

async function until(check: () => boolean, ms = 5_000, what = "condition") {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function manualClock(): Clock & { fire(): void } {
  const timers = new Map<number, () => void>();
  let id = 0;
  return {
    setTimeout(fn, _ms) {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    fire() {
      for (const [key, fn] of [...timers]) {
        timers.delete(key);
        fn();
      }
    },
  };
}

function make(mode: string, extra: Record<string, unknown> = {}) {
  const dir = tmp("kb-qwen-proc-");
  const clock = manualClock();
  const supervisor = lifecycle.createQwenSupervisor({
    guardPath: guard,
    childEntry: FAKE_CHILD,
    modelPath: "/nonexistent/model.gguf",
    childEnv: { FAKE_QWEN_DIR: dir, FAKE_QWEN_MODE: mode },
    clock,
    spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawn(command, args, options);
      const done = once(child, "close");
      void done.catch(() => {});
      ownedChildren.push({ child, done });
      return child;
    },
    termGraceMs: 300,
    lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
    ...extra,
  });
  supervisors.push(supervisor);
  const track = () => {
    const pid = supervisor.snapshot().pid;
    return pid;
  };
  return { dir, clock, supervisor, track };
}

const embeds = (dir: string) =>
  existsSync(join(dir, "embeds.log"))
    ? readFileSync(join(dir, "embeds.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [pid, token, texts] = line.split(" ");
          return { pid: Number(pid), token, texts };
        })
    : [];

beforeAll(() => {
  guard = requireBuiltArtifact(
    buildArtifactPath("child-guard"),
    "pnpm test:kb --build-only qwen-process",
  );
});

afterEach(async () => {
  const drains = await Promise.allSettled(
    supervisors.splice(0).map((supervisor) => supervisor.close()),
  );
  // Retained ChildProcess handles are signalled only before their exit. Reaped
  // PIDs are observations, never cleanup authority. Orphans use a kernel pidfd.
  for (const { child, done } of ownedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await done;
  }
  await drainProcessFixtures();
  for (const result of drains) if (result.status === "rejected") throw result.reason;
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("native guard", () => {
  it("execs in place under the expected parent and refuses a wrong parent PID", () => {
    const ok = execFileSync(guard, [String(process.pid), "/bin/sh", "-c", "echo $$ $PPID"], {
      encoding: "utf8",
    });
    const [, ppid] = ok.trim().split(" ");
    expect(Number(ppid)).toBe(process.pid);
    let status = 0;
    try {
      execFileSync(guard, ["1", "/bin/true"], { stdio: "ignore" });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(70);
    let usage = 0;
    try {
      execFileSync(guard, [String(process.pid), "true"], { stdio: "ignore" });
    } catch (error) {
      usage = (error as { status: number }).status;
    }
    expect(usage).toBe(64);
  });
});

describe("qwen child real processes", () => {
  it("idle exit: child leaves the process table, then the next job reloads a new PID", async () => {
    const { supervisor, clock, track, dir } = make("");
    await supervisor.embed({ purpose: "query", texts: ["first"], runtime: rt(1) });
    const first = track();
    expect(first).toBeTypeOf("number");
    expect(procState(first!)).toBe("alive");
    expect(cmdline(first!)).toContain("fake-qwen.child.mjs"); // guard exec'd in place
    clock.fire(); // the 15m idle timer (deterministic clock)
    await until(() => supervisor.snapshot().pid === null, 5_000, "idle stop");
    expect(procState(first!)).toBe("gone");

    await supervisor.embed({ purpose: "query", texts: ["second"], runtime: rt(1) });
    const second = track();
    expect(second).not.toBe(first);
    expect(procState(second!)).toBe("alive");
    expect(procState(first!)).toBe("gone");
    expect(supervisor.snapshot().spawns).toBe(2);
    expect(embeds(dir).map((e) => e.pid)).toEqual([first, second]);
  });

  it("parent SIGKILL: the native guard kills a disconnect/TERM-ignoring child", async () => {
    const dir = tmp("kb-qwen-parent-");
    const parent = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), PARENT_CHILD], {
      env: {
        ...process.env,
        QWEN_GUARD: guard,
        QWEN_CHILD: FAKE_CHILD,
        FAKE_QWEN_DIR: dir,
        FAKE_QWEN_MODE: "stubborn,ignore-disconnect",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const parentExit = once(parent, "exit");
    try {
      const line = await new Promise<string>((resolveLine, reject) => {
        const rl = createInterface({ input: parent.stdout! });
        rl.once("line", resolveLine);
        parent.once("exit", () => reject(new Error("parent exited early")));
      });
      const childPid = (JSON.parse(line) as { childPid: number }).childPid;
      const orphan = await ownProcess(childPid);
      expect(orphan).toBeDefined();
      expect(procState(childPid)).toBe("alive");
      parent.kill("SIGKILL");
      // Zombie-until-init-reaps is dead: no code runs; accept only not-alive.
      await until(() => procState(childPid) !== "alive", 5_000, "orphan death");
      expect(procState(childPid)).not.toBe("alive");
      await orphan?.kill();
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      await parentExit;
    }
  });

  it("disable while loading kills and reaps the loading child; nothing is dispatched", async () => {
    const { supervisor, dir } = make("hold-load");
    const pending = supervisor.embed({ purpose: "document", texts: ["x"], runtime: rt(1) });
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await until(() => supervisor.snapshot().pid !== null, 5_000, "spawn");
    const pid = supervisor.snapshot().pid!;
    await until(() => existsSync(join(dir, `loading.${pid}`)), 5_000, "loading barrier");
    await supervisor.disable();
    expect(procState(pid)).toBe("gone");
    expect(await outcome).toBeInstanceOf(lifecycle.QwenDisabledError);
    expect(embeds(dir)).toEqual([]);
  });

  it("disable while running kills the executing child; the result never arrives", async () => {
    const { supervisor, dir } = make("hold-embed");
    const outcome = supervisor.embed({ purpose: "document", texts: ["x"], runtime: rt(1) }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    await until(() => embeds(dir).length === 1, 5_000, "embed dispatch");
    const pid = embeds(dir)[0]!.pid;
    await until(() => existsSync(join(dir, `embedding.${pid}`)), 5_000, "embed barrier");
    await supervisor.disable();
    writeFileSync(join(dir, "release-embed"), "");
    expect(procState(pid)).toBe("gone");
    expect(await outcome).toBeInstanceOf(lifecycle.QwenDisabledError);
  });

  it("a TERM- and shutdown-resistant idle child is SIGKILLed after the grace and reaped", async () => {
    const { supervisor, clock, track } = make("stubborn");
    await supervisor.embed({ purpose: "query", texts: ["a"], runtime: rt(1) });
    const pid = track()!;
    const started = Date.now();
    clock.fire();
    await until(() => supervisor.snapshot().pid === null, 5_000, "forced stop");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250); // waited the grace first
    expect(procState(pid)).toBe("gone");
  });

  it("crash retries the same request once on a new child and discards stale replies", async () => {
    const { supervisor, dir, track } = make("crash-once,stale-first");
    const [vector] = await supervisor.embed({
      purpose: "document",
      texts: ["same-request"],
      runtime: rt(1),
    });
    const survivor = track()!;
    const log = embeds(dir);
    expect(log).toHaveLength(2);
    const crashed = Number(readFileSync(join(dir, "crashed"), "utf8"));
    expect(log[0]).toMatchObject({ pid: crashed, texts: "same-request" });
    expect(log[1]).toMatchObject({ pid: survivor, texts: "same-request" });
    expect(log[1]?.token).not.toBe(log[0]?.token);
    expect(procState(crashed)).toBe("gone");
    // The survivor sent a stale-token reply first; only the fenced reply counts,
    // and it carries the survivor's PID signature (v[1]/v[0] = pid%997+1).
    expect(Math.round(vector![1]! / vector![0]!)).toBe((survivor % 997) + 1);
  });

  it("a second crash of the same request fails visibly without a third attempt", async () => {
    // hold-embed keeps each attempt executing until the test kills it.
    const { supervisor, dir } = make("hold-embed");
    const outcome = supervisor
      .embed({ purpose: "document", texts: ["doomed"], runtime: rt(1) })
      .then(
        () => "resolved",
        (error: unknown) => error,
      );
    for (let attempt = 1; attempt <= 2; attempt++) {
      await until(() => embeds(dir).length === attempt, 5_000, `attempt ${attempt}`);
      const pid = embeds(dir)[attempt - 1]!.pid;
      const owned = ownedChildren.find(({ child }) => child.pid === pid);
      expect(owned).toBeDefined();
      if (owned!.child.exitCode === null && owned!.child.signalCode === null)
        owned!.child.kill("SIGKILL");
    }
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("QwenChildCrashedError");
    expect(embeds(dir)).toHaveLength(2);
    expect(supervisor.snapshot().pid).toBeNull();
  });
});

it("current-worker admission fences initial capability, READY reload and token-measurement loads and releases rejected holds", async () => {
  let budget: number | null = 512 * 1024 ** 2;
  let acquired = 0,
    released = 0;
  const { supervisor, clock } = make("", {
    budgetBytes: () => budget,
    lease: {
      acquire: async () => {
        acquired++;
        return true;
      },
      renew: async () => true,
      release: async () => {
        released++;
      },
    },
  });
  await expect(
    supervisor.embed({ purpose: "query", texts: ["blocked"], runtime: rt(1) }),
  ).rejects.toThrow(/provider unavailable/);
  await expect(
    supervisor.countTokens({ purpose: "document", texts: ["blocked"], runtime: rt(1) }),
  ).rejects.toThrow(/provider unavailable/);
  await expect(supervisor.probe(rt(1))).rejects.toThrow();
  expect(supervisor.snapshot().spawns).toBe(0);
  expect(released).toBe(acquired);
  budget = 8 * 1024 ** 3;
  await expect(
    supervisor.embed({ purpose: "query", texts: ["admitted"], runtime: rt(1) }),
  ).resolves.toHaveLength(1);
  const pid = supervisor.snapshot().pid!;
  budget = 2 * 1024 ** 3;
  await expect(supervisor.probe(rt(1))).rejects.toThrow();
  expect(supervisor.snapshot().pid).toBe(pid);
  expect(supervisor.snapshot().spawns).toBe(1);
  await expect(
    supervisor.embed({ purpose: "query", texts: ["last good child"], runtime: rt(1) }),
  ).resolves.toHaveLength(1);
  clock.fire();
  await until(() => procState(pid) === "gone", 5000, "idle child reaped");
  budget = null;
  await expect(
    supervisor.embed({ purpose: "query", texts: ["unknown reload"], runtime: rt(1) }),
  ).rejects.toThrow(/provider unavailable/);
  budget = 512 * 1024 ** 2;
  await expect(
    supervisor.embed({ purpose: "query", texts: ["blocked reload"], runtime: rt(1) }),
  ).rejects.toThrow(/provider unavailable/);
  expect(supervisor.snapshot().spawns).toBe(1);
  budget = 8 * 1024 ** 3;
  await expect(supervisor.probe(rt(1))).resolves.toMatchObject({ peakRssBytes: null });
  await expect(
    supervisor.embed({ purpose: "query", texts: ["recovered"], runtime: rt(1) }),
  ).resolves.toHaveLength(1);
  await supervisor.close();
  expect(released).toBe(acquired);
});

describe("R45 cancellation and ownership at real child boundaries", () => {
  it.each(["query", "document", "count"] as const)(
    "aborts an admitted %s during load and execution, reaps before settlement, and admits a successor",
    async (operation) => {
      for (const phase of ["load", "execute"] as const) {
        let released = 0;
        const { supervisor, dir } = make(
          phase === "load" ? "hold-load" : operation === "count" ? "hold-count" : "hold-embed",
          {
            lease: {
              acquire: async () => true,
              renew: async () => true,
              release: async () => {
                released++;
              },
            },
          },
        );
        const controller = new AbortController();
        const input = {
          purpose: operation === "query" ? ("query" as const) : ("document" as const),
          texts: ["cancel"],
          runtime: rt(1),
          signal: controller.signal,
        };
        const pending = (
          operation === "count" ? supervisor.countTokens(input) : supervisor.embed(input)
        ).catch((error: unknown) => error);
        await until(() => supervisor.snapshot().pid !== null);
        const pid = supervisor.snapshot().pid!;
        const marker =
          phase === "load" ? "loading" : operation === "count" ? "counting" : "embedding";
        await until(() => existsSync(join(dir, `${marker}.${pid}`)));
        controller.abort();
        const result = await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(() => resolve("NOT_CANCELLED"), 2000)),
        ]);
        expect(result).toBeInstanceOf(Error);
        expect(procState(pid)).toBe("gone");
        expect(released).toBe(1);
        // Late producer work cannot arrive; a new attempt receives a fresh child.
        for (const stage of ["load", "embed", "count"])
          writeFileSync(join(dir, `release-${stage}`), "");
        await expect(
          supervisor.embed({ purpose: "query", texts: ["successor"], runtime: rt(1) }),
        ).resolves.toHaveLength(1);
        expect(supervisor.snapshot().pid).not.toBe(pid);
        await supervisor.close();
        expect(released).toBe(2);
      }
    },
  );

  it("bounds load/execute/count without a caller timeout or signal", async () => {
    for (const mode of ["hold-load", "hold-embed", "hold-count"]) {
      const { supervisor } = make(mode, { servingTimeoutMs: 1000 });
      const input = { purpose: "document" as const, texts: ["deadline"], runtime: rt(1) };
      const pending = (
        mode === "hold-count" ? supervisor.countTokens(input) : supervisor.embed(input)
      ).catch((error: unknown) => error);
      await until(() => supervisor.snapshot().pid !== null);
      const pid = supervisor.snapshot().pid!;
      const result = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve("NO_DEADLINE"), 3000)),
      ]);
      expect(result).toBeInstanceOf(Error);
      expect(procState(pid)).toBe("gone");
      expect(supervisor.snapshot().spawns).toBe(1); // a timeout never consumes a crash retry
    }
  });

  it.each(["hold-load", "hold-probe"])(
    "close joins the %s probe and releases only after its OS exit",
    async (mode) => {
      let released = false;
      const { supervisor, dir } = make(mode, {
        lease: {
          acquire: async () => true,
          renew: async () => true,
          release: async () => {
            expect(
              ownedChildren.every(
                ({ child }) => child.exitCode !== null || child.signalCode !== null,
              ),
            ).toBe(true);
            released = true;
          },
        },
      });
      const pending = supervisor.probe(rt(1)).catch((error: unknown) => error);
      const marker = mode === "hold-load" ? "loading" : "probing";
      await until(() =>
        ownedChildren.some(
          ({ child }) => child.pid && existsSync(join(dir, `${marker}.${child.pid}`)),
        ),
      );
      const pid = ownedChildren.at(-1)!.child.pid!;
      await expect(supervisor.probe(rt(1))).rejects.toThrow(); // one isolated probe at a time
      await supervisor.close();
      expect(await pending).toBeInstanceOf(Error);
      expect(procState(pid)).toBe("gone");
      expect(released).toBe(true);
      await expect(supervisor.probe(rt(1))).rejects.toThrow();
    },
  );

  it("joins cancellation/close during acquisition and never spawns a late probe or serving child", async () => {
    for (const operation of ["probe", "embed"] as const) {
      const acquire = Promise.withResolvers<boolean>();
      let acquiring = false,
        released = 0;
      const { supervisor } = make("", {
        lease: {
          acquire: async () => {
            acquiring = true;
            return acquire.promise;
          },
          renew: async () => true,
          release: async () => {
            released++;
          },
        },
      });
      const controller = new AbortController();
      const pending = (
        operation === "probe"
          ? supervisor.probe(rt(1), { signal: controller.signal })
          : supervisor.embed({
              purpose: "query",
              texts: ["cancel"],
              runtime: rt(1),
              signal: controller.signal,
            })
      ).catch((error: unknown) => error);
      await until(() => acquiring);
      controller.abort();
      let closed = false;
      const close = supervisor.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false); // unjoined acquisition still owns its potential effect
      acquire.resolve(true);
      await close;
      expect(await pending).toBeInstanceOf(Error);
      expect(supervisor.snapshot().spawns).toBe(0);
      expect(released).toBe(1);
    }
  });

  it("runtime wrapper deadline in max-context execution settles only after the real probe is reaped", async () => {
    const { probeQwenRuntime } = await import(
      new URL("../../../../apps/worker/src/lib/qwen-probe.ts", import.meta.url).href
    );
    const dir = tmp("kb-qwen-wrapper-");
    const run = probeQwenRuntime({
      guardPath: guard,
      childEntry: FAKE_CHILD,
      modelPath: "/nonexistent/model.gguf",
      config: rt(1).config,
      budgetBytes: () => 64 * 1024 ** 3,
      childEnv: { FAKE_QWEN_DIR: dir, FAKE_QWEN_MODE: "hold-probe" },
      timeoutMs: 1000,
      spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        const child = spawn(command, args, options);
        const done = once(child, "close");
        void done.catch(() => {});
        ownedChildren.push({ child, done });
        return child;
      },
    }).catch((error: unknown) => error);
    await until(() =>
      ownedChildren.some(({ child }) => child.pid && existsSync(join(dir, `probing.${child.pid}`))),
    );
    const pid = ownedChildren.at(-1)!.child.pid!;
    expect(await run).toMatchObject({ code: "MODEL_RUNTIME_UNSUPPORTED" });
    expect(procState(pid)).toBe("gone");
    expect(
      ownedChildren.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
    ).toBe(true);
  });

  it("orphan ownership rejects a stale birth identity without signalling the live fixture", async () => {
    const { supervisor } = make("");
    await supervisor.embed({ purpose: "query", texts: ["alive"], runtime: rt(1) });
    const pid = supervisor.snapshot().pid!;
    expect(await ownProcess(pid, "0")).toBeUndefined();
    expect(procState(pid)).toBe("alive");
    await supervisor.close();
    expect(procState(pid)).toBe("gone");
  });
});

it("R45 cancelling a side-by-side probe preserves serving and its shared lease", async () => {
  let acquired = 0,
    released = 0;
  const { supervisor, dir } = make("hold-probe", {
    budgetBytes: () => 64 * 1024 ** 3,
    lease: {
      acquire: async () => {
        acquired++;
        return true;
      },
      renew: async () => true,
      release: async () => {
        released++;
      },
    },
  });
  await supervisor.embed({ purpose: "query", texts: ["warm"], runtime: rt(1) });
  const servingPid = supervisor.snapshot().pid!;
  const controller = new AbortController();
  const probe = supervisor
    .probe(rt(1), { signal: controller.signal })
    .catch((error: unknown) => error);
  await until(() =>
    ownedChildren.some(({ child }) => child.pid && existsSync(join(dir, `probing.${child.pid}`))),
  );
  const probePid = ownedChildren.at(-1)!.child.pid!;
  controller.abort();
  expect(await probe).toBeInstanceOf(Error);
  expect(procState(probePid)).toBe("gone");
  expect(procState(servingPid)).toBe("alive");
  expect(acquired).toBe(1);
  expect(released).toBe(0);
  await expect(
    supervisor.embed({ purpose: "query", texts: ["still serving"], runtime: rt(1) }),
  ).resolves.toHaveLength(1);
  expect(supervisor.snapshot().pid).toBe(servingPid);
  await supervisor.close();
  expect(released).toBe(1);
});

it("R45 runtime verification refuses precancellation and a successful verification reaps both children", async () => {
  const { probeQwenRuntime } = await import(
    new URL("../../../../apps/worker/src/lib/qwen-probe.ts", import.meta.url).href
  );
  const dir = tmp("kb-qwen-runtime-inverse-");
  const controller = new AbortController();
  const options = {
    guardPath: guard,
    childEntry: FAKE_CHILD,
    modelPath: "/nonexistent/model.gguf",
    config: rt(1).config,
    budgetBytes: () => 64 * 1024 ** 3,
    childEnv: { FAKE_QWEN_DIR: dir },
    spawn: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawn(command, args, options);
      const done = once(child, "close");
      void done.catch(() => {});
      ownedChildren.push({ child, done });
      return child;
    },
  };
  await expect(probeQwenRuntime({ ...options, signal: controller.signal })).resolves.toEqual({
    dimensions: 1024,
    peakRssBytes: null,
  });
  expect(ownedChildren).toHaveLength(2);
  expect(
    ownedChildren.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
  ).toBe(true);
  controller.abort();
  await expect(probeQwenRuntime({ ...options, signal: controller.signal })).rejects.toMatchObject({
    code: "MODEL_CANCELLED",
  });
  expect(ownedChildren).toHaveLength(2);
});
