import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeGitFixtureBlobPack, writeGitFixtureLooseBlob } from "./fixtures/git-objects";
import * as gitRead from "./git-read";
import { hardenedGitEnv } from "./git-read";
import {
  acknowledgeGitRollup,
  GIT_ROLLUP,
  gitRollupState,
  measureGitRollup,
  planGitRollup,
  recoverGitRollup,
  rollupGitObjects,
} from "./git-rollup";

vi.mock("./git-read", async (original) => ({ ...(await original<typeof import("./git-read")>()) }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const packs = (sizes: number[]) =>
  sizes.map((bytes, i) => ({ hash: i.toString(16).padStart(40, "0"), bytes }));
describe("geometric rollup planning", () => {
  it("matches the CLI split, cap and frozen-pack rule", () => {
    for (const [sizes, loose, cap, want] of [
      [[10, 40, 200, 1000], 0, 2000, 0],
      [[10, 40, 200, 1000], 9, 2000, 1],
      [[10, 30, 70, 200], 9, 2000, 4],
      [[10, 12, 40, 1000], 0, 2000, 3],
      [[10, 10, 10, 1000], 0, 25, 2],
      [[10, 10, GIT_ROLLUP.frozenBytes], 0, GIT_ROLLUP.maxBytes, 2],
    ] as const)
      expect(planGitRollup(packs([...sizes]), loose, cap)).toBe(want);
  });
  it("bounds pack count and rewriting over thousands of writes", () => {
    let sizes: number[] = [],
      rewrites = 0;
    for (let i = 0; i < 10_000; i++) {
      sizes.push(2048);
      sizes.sort((a, b) => a - b);
      if (sizes.filter((n) => n < GIT_ROLLUP.frozenBytes).length < GIT_ROLLUP.packs) continue;
      const roll = planGitRollup(packs(sizes), 0, GIT_ROLLUP.maxBytes);
      if (roll < 2) continue;
      const bytes = sizes.splice(0, roll).reduce((a, b) => a + b, 0);
      rewrites += bytes;
      sizes.push(bytes);
      expect(sizes.length).toBeLessThan(32);
    }
    expect(rewrites / (10_000 * 2048)).toBeLessThan(12);
  });
});

const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let syncPaths: string[] = [];
let root: string, repo: string;
const git = (args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd: repo,
    env: hardenedGitEnv(),
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
function blob(body: string) {
  return writeGitFixtureLooseBlob(repo, Buffer.from(body)).objectSha;
}
function addPacks(count: number) {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const pack = writeGitFixtureBlobPack(repo, Buffer.from(`unreachable ${i}`));
    names.push(pack.objectSha);
  }
  return names;
}
function assertObjects(names: string[]) {
  const answer = git(["cat-file", "--batch-check"], `${names.join("\n")}\n`).split("\n");
  expect(answer).toHaveLength(names.length);
  expect(answer.every((line, i) => new RegExp(`^${names[i]} blob [0-9]+$`).test(line))).toBe(true);
}
beforeEach(() => {
  syncPaths = [];
  // Failure injection tests protocol ordering, not drive latency. Keep real
  // Git and file contents; observe fsync fences without waiting on the shared
  // host's journal. The integration suite retains real fsyncs.
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await realFs.open(...args);
    vi.spyOn(file, "sync").mockImplementation(async () => {
      syncPaths.push(String(args[0]));
    });
    return file;
  });
  root = mkdtempSync(join(tmpdir(), "kb-rollup-test-"));
  repo = join(root, "repo.git");
  execFileSync("git", ["init", "--bare", "--template=", repo], { stdio: "ignore" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("real Git rollup", () => {
  it.each([GIT_ROLLUP.maxLooseBytes, GIT_ROLLUP.maxLooseBytes + 1])(
    "measures only actionable loose inputs at the individual byte boundary %i",
    async (bytes) => {
      const names = Array.from(
        { length: 27 },
        (_, i) => writeGitFixtureLooseBlob(repo, Buffer.from(`boundary ${i}`), "17").objectSha,
      );
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const st = await realFs.lstat(...args);
        if (String(args[0]).startsWith(join(repo, "objects/17/")) && st.isFile()) st.size = bytes;
        return st;
      });
      const eligible = bytes <= GIT_ROLLUP.maxLooseBytes;
      const pressure = await measureGitRollup(repo, {});
      expect(pressure).toMatchObject({ looseSample: eligible ? 27 : 0, due: eligible });
      expect(await rollupGitObjects(repo, pressure, {})).toBe(eligible);
      expect(
        names.filter((name) => !existsSync(join(repo, "objects/17", name.slice(2)))),
      ).toHaveLength(eligible ? 1 : 0);
      assertObjects(names);
    },
  );

  it("excludes byte-frozen and keep-marked packs from both pressure and selection", async () => {
    const frozen = writeGitFixtureBlobPack(repo, Buffer.from("frozen"));
    const kept = writeGitFixtureBlobPack(repo, Buffer.from("writer-owned"));
    const frozenPath = join(repo, "objects/pack", `pack-${frozen.hash}.pack`);
    const keptPath = join(repo, "objects/pack", `pack-${kept.hash}.pack`);
    writeFileSync(keptPath.replace(".pack", ".keep"), "");
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const st = await realFs.lstat(...args);
      if (String(args[0]) === frozenPath) st.size = GIT_ROLLUP.frozenBytes;
      return st;
    });
    const names = addPacks(7);
    expect(await measureGitRollup(repo, {})).toMatchObject({ due: false, level: 7 });
    names.push(writeGitFixtureBlobPack(repo, Buffer.from("eighth")).objectSha);
    const pressure = await measureGitRollup(repo, {});
    expect(pressure).toMatchObject({ due: true, level: 8 });
    expect(await rollupGitObjects(repo, pressure, {})).toBe(true);
    expect(existsSync(frozenPath)).toBe(true);
    expect(existsSync(keptPath)).toBe(true);
    assertObjects([...names, frozen.objectSha, kept.objectSha]);
    expect(await measureGitRollup(repo, {})).toMatchObject({ due: false, level: 1 });
  });

  it("skips an input that exceeds the remaining allowance and selects a later fitting blob", async () => {
    const names = ["first", "larger than remaining", "last"].map(
      (body) => writeGitFixtureLooseBlob(repo, Buffer.from(body), "17").objectSha,
    );
    const paths = names.map((name) => join(repo, "objects/17", name.slice(2)));
    const sizes = paths.map((path) => statSync(path).size);
    const budget = sizes[0]! + sizes[2]!;
    expect(sizes[1]!).toBeGreaterThan(sizes[2]!);
    // Force the adverse enumeration order without relying on filesystem order.
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const dir = await realFs.opendir(...args);
      if (String(args[0]) !== join(repo, "objects/17")) return dir;
      const entries: Dirent[] = [];
      for await (const entry of dir) entries.push(entry);
      entries.sort((a, b) => names.indexOf(`17${a.name}`) - names.indexOf(`17${b.name}`));
      return Object.assign(dir, {
        async *[Symbol.asyncIterator]() {
          yield* entries;
        },
      });
    });
    expect(await rollupGitObjects(repo, await measureGitRollup(repo, {}), {}, budget * 2)).toBe(
      true,
    );
    expect(paths.map((path) => existsSync(path))).toEqual([false, true, false]);
    assertObjects(names);
  });

  it.each(["name", "retained", "remaining"])(
    "cancels while skipping entries excluded by %s",
    async (kind) => {
      mkdirSync(join(repo, "objects/17"));
      for (let i = 0; i < 140; i++)
        writeFileSync(
          join(
            repo,
            "objects/17",
            kind === "name" ? `ignored-${i}` : i.toString(16).padStart(38, "0"),
          ),
          "",
        );
      if (kind !== "name") {
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const st = await realFs.lstat(...args);
          if (st.isFile()) st.size = kind === "retained" ? GIT_ROLLUP.maxLooseBytes + 1 : 1;
          return st;
        });
      }
      const abort = new AbortController();
      const checkpoint = gitRead.gitReadCheckpoint;
      let checks = 0;
      vi.spyOn(gitRead, "gitReadCheckpoint").mockImplementation(async (options) => {
        if (++checks === (kind === "remaining" ? 3 : 2)) abort.abort();
        await checkpoint(options);
      });
      const options = { signal: abort.signal };
      if (kind === "remaining")
        await expect(
          rollupGitObjects(repo, { packs: [], looseSample: 0, level: 0, due: false }, options, 0),
        ).rejects.toMatchObject({ code: "CANCELLED" });
      else
        await expect(measureGitRollup(repo, options)).rejects.toMatchObject({ code: "CANCELLED" });
      expect(checks).toBe(kind === "remaining" ? 3 : 2);
      expect(await gitRollupState(repo)).toBe("none");
    },
  );

  it("keeps selected work on scan exhaustion and bounds skipped-entry scans", async () => {
    const name = writeGitFixtureLooseBlob(repo, Buffer.from("scan work"), "17").objectSha;
    let visited = 0;
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const dir = await realFs.opendir(...args);
      if (String(args[0]) !== join(repo, "objects/17")) return dir;
      const entry = (await dir.read())!;
      return Object.assign(dir, {
        async *[Symbol.asyncIterator]() {
          try {
            yield entry;
            for (let i = 0; i < GIT_ROLLUP.maxObjects + 10; i++) {
              visited++;
              yield Object.assign(entry, { name: "ignored" });
            }
          } finally {
            await dir.close();
          }
        },
      });
    });
    const pressure = await measureGitRollup(repo, {});
    expect(pressure.looseSample).toBe(1);
    expect(visited).toBe(GIT_ROLLUP.maxObjects);
    visited = 0;
    expect(await rollupGitObjects(repo, pressure, {})).toBe(true);
    expect(visited).toBe(GIT_ROLLUP.maxObjects);
    assertObjects([name]);
  });

  it("kills and drains a native packing child on shutdown before removing scratch", async () => {
    const names = addPacks(8),
      abort = new AbortController();
    const original = await vi.importActual<typeof import("./git-read")>("./git-read");
    let packing = false;
    const hook = vi.spyOn(gitRead, "runGitAsync").mockImplementation((...args) => {
      const child = original.runGitAsync(...args);
      if (args[1][0] === "pack-objects") {
        packing = true;
        abort.abort(); // runGitAsync has spawned and registered the native child.
      }
      return child;
    });
    await expect(
      rollupGitObjects(repo, await measureGitRollup(repo, {}), { signal: abort.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(packing).toBe(true);
    expect(await gitRollupState(repo)).toBe("none");
    hook.mockRestore();
    expect(await rollupGitObjects(repo, await measureGitRollup(repo, {}), {})).toBe(true);
    assertObjects(names);
  });

  it("derives installed cleanup debt from disk and retries retirement without repacking", async () => {
    const names = addPacks(8);
    const blocked = vi
      .spyOn(fs, "unlink")
      .mockRejectedValue(Object.assign(new Error("busy reader"), { code: "EBUSY" }));
    await expect(rollupGitObjects(repo, await measureGitRollup(repo, {}), {})).rejects.toThrow(
      "busy reader",
    );
    expect(await gitRollupState(repo)).toBe("installed");
    const covering = readFileSync(join(repo, "objects/kb-rollup/roll.pack"));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(recoverGitRollup(repo, {})).rejects.toThrow("busy reader");
      expect(readFileSync(join(repo, "objects/kb-rollup/roll.pack"))).toEqual(covering);
      assertObjects(names);
    }
    blocked.mockRestore();
    expect(await recoverGitRollup(repo, {})).toBe(true);
    expect(await gitRollupState(repo)).toBe("done");
    await acknowledgeGitRollup(repo);
    expect(await gitRollupState(repo)).toBe("none");
    assertObjects(names);
  });

  it("folds small packs, keeps every unreachable object and serves an already-open reader", async () => {
    const names = addPacks(12);
    const reader = spawn("git", ["cat-file", "--batch"], {
      cwd: repo,
      env: hardenedGitEnv(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const read = (name: string) =>
      new Promise<string>((resolve) => {
        let output = "";
        const collect = (chunk: Buffer) => {
          output += chunk.toString();
          const headerEnd = output.indexOf("\n");
          const size = Number(output.slice(0, headerEnd).split(" ")[2]);
          if (headerEnd < 0 || output.length < headerEnd + 1 + size + 1) return;
          reader.stdout.off("data", collect);
          resolve(output);
        };
        reader.stdout.on("data", collect);
        reader.stdin.write(`${name}\n`);
      });
    const closed = new Promise<void>((resolve) => reader.once("close", () => resolve()));
    try {
      expect(await read(names[0]!)).toContain(" blob ");
      const pressure = await measureGitRollup(repo, {});
      expect(pressure.due).toBe(true);
      expect(await rollupGitObjects(repo, pressure, {})).toBe(true);
      expect(
        readdirSync(join(repo, "objects/pack")).filter((n) => n.endsWith(".pack")),
      ).toHaveLength(1);
      for (const [i, name] of names.entries())
        expect(await read(name)).toBe(
          `${name} blob ${Buffer.byteLength(`unreachable ${i}`)}\nunreachable ${i}\n`,
        );
      assertObjects(names);
      const installed = readdirSync(join(repo, "objects/pack")).find((n) => n.endsWith(".pack"))!;
      const dataFence = syncPaths.indexOf(join(repo, "objects/pack", installed));
      const indexFence = syncPaths.indexOf(
        join(repo, "objects/pack", installed.replace(".pack", ".idx")),
      );
      expect(syncPaths.indexOf(join(repo, "objects/kb-rollup/intent.tmp"))).toBeLessThan(dataFence);
      expect(dataFence).toBeLessThan(indexFence);
      expect(syncPaths.slice(dataFence + 1, indexFence)).toContain(join(repo, "objects/pack"));
    } finally {
      reader.stdin.end();
      await closed;
    }
    expect(existsSync(join(repo, "objects/kb-rollup"))).toBe(false);
  });
  it("packs bounded loose objects, including objects unreachable from every ref", async () => {
    const names: string[] = [];
    // Populate exactly the trigger bucket as well as the rest of the fanout.
    for (let n = 0, sample = 0; sample < GIT_ROLLUP.looseSample; n++) {
      const body = `loose ${n}`,
        hash = createHash("sha1").update(`blob ${body.length}\0${body}`).digest("hex");
      if (hash.startsWith("17")) {
        names.push(blob(body));
        sample++;
      }
    }
    names.push(blob("other bucket"));
    const pressure = await measureGitRollup(repo, {});
    expect(pressure.due).toBe(true);
    const sizes = new Map(
      names.map((name) => [
        name,
        statSync(join(repo, "objects", name.slice(0, 2), name.slice(2))).size,
      ]),
    );
    await rollupGitObjects(repo, pressure, {}, 128);
    const folded = names.filter(
      (name) => !existsSync(join(repo, "objects", name.slice(0, 2), name.slice(2))),
    );
    expect(folded.length).toBeGreaterThan(0);
    expect(folded.length).toBeLessThan(names.length);
    expect(folded.reduce((bytes, name) => bytes + sizes.get(name)!, 0)).toBeLessThanOrEqual(64);
    assertObjects(names);
    await rollupGitObjects(repo, await measureGitRollup(repo, {}), {});
    assertObjects(names);
    expect((await measureGitRollup(repo, {})).looseSample).toBe(0);
    for (const name of names)
      expect(existsSync(join(repo, "objects", name.slice(0, 2), name.slice(2)))).toBe(false);
  });
  it.each(["install", "retire", "discard"])(
    "recovers interruption during %s with all objects intact",
    async (stage) => {
      const names = addPacks(9),
        pressure = await measureGitRollup(repo, {});
      let interrupted = false;
      if (stage === "install") {
        const real = fs.link;
        vi.spyOn(fs, "link").mockImplementation(async (...args) => {
          await real(...args);
          if (!interrupted) {
            interrupted = true;
            throw new Error("power loss after data install");
          }
        });
      } else if (stage === "retire") {
        const real = fs.unlink;
        vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
          await real(...args);
          if (!interrupted && String(args[0]).endsWith(".idx")) {
            interrupted = true;
            throw new Error("power loss after index retirement");
          }
        });
      } else {
        const real = fs.unlink;
        vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
          if (!interrupted && String(args[0]).includes("kb-rollup-done/")) {
            interrupted = true;
            throw new Error("power loss during scratch disposal");
          }
          await real(...args);
        });
      }
      await expect(rollupGitObjects(repo, pressure, {})).rejects.toThrow("power loss");
      // Remove only the fault: recovery still observes the unit test's fsync
      // fences. The integration suite exercises their real disk durability.
      if (stage === "install") vi.mocked(fs.link).mockRestore();
      else if (stage === "retire") vi.mocked(fs.unlink).mockRestore();
      else vi.mocked(fs.unlink).mockRestore();
      assertObjects(names);
      expect(await recoverGitRollup(repo, {})).toBe(true);
      assertObjects(names);
      expect(existsSync(join(repo, "objects/kb-rollup"))).toBe(false);
      expect(await gitRollupState(repo)).toBe("done");
      await acknowledgeGitRollup(repo);
      expect(existsSync(join(repo, "objects/kb-rollup-done"))).toBe(false);
    },
  );
  it("refuses corrupt input before deleting anything", async () => {
    const names = addPacks(8),
      pressure = await measureGitRollup(repo, {});
    const index = join(repo, "objects/pack", `pack-${pressure.packs[0]!.hash}.idx`);
    const bytes = readFileSync(index);
    bytes[1040] = bytes[1040]! ^ 1;
    rmSync(index);
    writeFileSync(index, bytes);
    await expect(rollupGitObjects(repo, pressure, {})).rejects.toThrow("Invalid rollup index");
    expect(readdirSync(join(repo, "objects/pack")).filter((n) => n.endsWith(".pack"))).toHaveLength(
      8,
    );
    expect(names).toHaveLength(8);
  });
  it("recovers interrupted loose-object retirement without losing unpublished data", async () => {
    const names = Array.from({ length: 8 }, (_, i) => blob(`unpublished ${i}`));
    const pressure = await measureGitRollup(repo, {});
    const realUnlink = fs.unlink;
    let interrupted = false;
    const fault = vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
      await realUnlink(...args);
      if (!interrupted) {
        interrupted = true;
        throw new Error("power loss during loose retirement");
      }
    });
    await expect(rollupGitObjects(repo, pressure, {})).rejects.toThrow("power loss");
    fault.mockRestore();
    assertObjects(names);
    expect(await recoverGitRollup(repo, {})).toBe(true);
    for (const [i, name] of names.entries()) {
      expect(git(["cat-file", "blob", name])).toBe(`unpublished ${i}`);
      expect(existsSync(join(repo, "objects", name.slice(0, 2), name.slice(2)))).toBe(false);
    }
    expect(existsSync(join(repo, "objects/kb-rollup"))).toBe(false);
  });
  it("makes bounded multi-pass progress on count-dense packs as publication continues", async () => {
    const names: string[] = [];
    let serial = 0;
    const publish = (count: number) => {
      for (let p = 0; p < count; p++) {
        const tag = serial++;
        const pack = writeGitFixtureBlobPack(
          repo,
          Array.from({ length: 26_000 }, (_, i) => Buffer.from(`dense ${tag}/${i}`)),
        );
        names.push(...pack.objectShas);
      }
    };
    publish(8); // 208,000 actual objects, far below the byte cap.
    for (let pass = 0; pass < 2; pass++) {
      const pressure = await measureGitRollup(repo, {});
      expect(pressure.due).toBe(true);
      const selected = planGitRollup(pressure.packs, 0, GIT_ROLLUP.maxBytes);
      expect(selected).toBeGreaterThanOrEqual(2);
      expect(
        pressure.packs.slice(0, selected).reduce((n, p) => n + p.objects!, 0),
      ).toBeLessThanOrEqual(GIT_ROLLUP.maxObjects);
      expect(await rollupGitObjects(repo, pressure, {})).toBe(true);
      const remaining = await measureGitRollup(repo, {});
      expect(remaining.packs.length).toBeLessThan(GIT_ROLLUP.packs);
      // Frozen count-dense packs never reenter planning on subsequent passes.
      expect(remaining.packs.every((p) => p.objects! < GIT_ROLLUP.frozenObjects)).toBe(true);
      for (let start = 0; start < names.length; start += 10_000)
        assertObjects(names.slice(start, start + 10_000));
      if (pass < 1) publish(7);
    }
    expect(git(["fsck", "--full", "--no-dangling"])).not.toContain("missing");
  }, 120_000);
});
