import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireBuiltArtifact } from "../../../../test-utils/src/kb/build-artifacts.mjs";
import {
  createPushSpooler,
  PUSH_MAX_BYTES,
  recoverPushSpools,
  sweepAbandonedPushSpools,
} from "./push-spool";

const dirs: string[] = [];
const uuidFault = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => uuidFault.value ?? actual.randomUUID() };
});
afterEach(async () => {
  uuidFault.value = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(options: { maxBytes?: number; totalMs?: number; idleMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kb-spool-test-"));
  dirs.push(root);
  return { root, spooler: createPushSpooler({ root, ...options }) };
}
function request(body: BodyInit | null, signal?: AbortSignal, length?: string) {
  return new Request("http://localhost/git/test.git/git-receive-pack", {
    method: "POST",
    body,
    signal,
    headers: length ? { "content-length": length } : {},
    duplex: "half",
  } as RequestInit);
}
function blocked(signal?: AbortSignal) {
  return request(new ReadableStream(), signal);
}

describe("receive transport spool before locks", () => {
  it("reclaims SIGKILL upload debris only after the native fence excludes its live owner", async () => {
    const repo = resolve(import.meta.dirname, "../../../../..");
    const native = join(repo, "apps/server/native");
    requireBuiltArtifact(join(native, "kb-supervisor"), "pnpm test:kb --build-only git-http");
    // The supervisor fences <KB_DATA_ROOT>/repos; the repos root is a child.
    const dataRoot = mkdtempSync(join(tmpdir(), "kb-spool-crash-test-"));
    const root = join(dataRoot, "repos");
    mkdirSync(join(root, ".private"), { recursive: true });
    const source = pathToFileURL(join(repo, "packages/api/src/lib/kb/push-spool.ts")).href;
    const fence = pathToFileURL(join(repo, "apps/server/src/kb-process.ts")).href;
    const fixture = join(root, "fixture.mts");
    writeFileSync(
      fixture,
      `
import assert from "node:assert/strict";
import { writeFileSync, readdirSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createPushSpooler, recoverPushSpools } from ${JSON.stringify(source)};
import { assertProcessFence, pingProcessFence } from ${JSON.stringify(fence)};
const root = process.env.KB_DATA_ROOT + "/repos";
await pingProcessFence();
await recoverPushSpools(root, assertProcessFence);
writeFileSync(root + "/recovered-" + process.env.MODE, "yes");
const spooler = createPushSpooler({ root });
if (process.env.MODE === "upload") {
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024)); } });
  void spooler.spool(new Request("http://localhost", { method: "POST", body, duplex: "half" }), "user").catch(() => {});
  for (;;) {
    const files = readdirSync(root + "/.private/tmp").filter(n => n.startsWith("git-"));
    if (files.some(n => statSync(root + "/.private/tmp/" + n).size === 1024 * 1024)) break;
    await delay(10);
  }
  writeFileSync(root + "/written", String(process.pid));
  setInterval(() => {}, 1000);
} else {
  assert.deepEqual(readdirSync(root + "/.private/tmp"), ["unrelated"]);
  const full = await spooler.spool(new Request("http://localhost", { method: "POST", body: "successor" }), "user");
  assert.equal(full.size, 9);
  await full.dispose();
  assert.equal(spooler.outstanding, 0);
  assert.deepEqual(readdirSync(root + "/.private/tmp"), ["unrelated"]);
  process.exit(0);
}
`,
    );
    const start = (mode: string) => {
      const child = spawn(
        join(native, "kb-supervisor"),
        [
          "--",
          process.execPath,
          "--import",
          join(repo, "node_modules/tsx/dist/loader.mjs"),
          fixture,
        ],
        {
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            KB_DATA_ROOT: dataRoot,
            MODE: mode,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      return {
        child,
        exit: new Promise<number | null>((done) => child.once("exit", done)),
        output: () => output,
      };
    };
    const owner = start("upload");
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(join(root, "written"))) {
        if (owner.child.exitCode !== null || Date.now() > deadline) throw new Error(owner.output());
        await delay(20);
      }
      await writeFile(join(root, ".private/tmp/unrelated"), "keep");
      const contender = start("live-contender");
      // The held fence is its own typed record and exit status.
      expect(await contender.exit).toBe(85);
      expect(contender.output()).toContain('"reason":"FENCE_HELD"');
      expect(existsSync(join(root, "recovered-live-contender"))).toBe(false);
      expect(
        (await readdir(join(root, ".private/tmp"))).filter((n) => n.startsWith("git-")),
      ).toHaveLength(1);
      process.kill(Number(readFileSync(join(root, "written"), "utf8")), "SIGKILL");
      await owner.exit;
      expect(
        (await readdir(join(root, ".private/tmp"))).filter((n) => n.startsWith("git-")),
      ).toHaveLength(1);
      const successor = start("successor");
      expect(await successor.exit, successor.output()).toBe(0);
      expect(await readFile(join(root, ".private/tmp/unrelated"), "utf8")).toBe("keep");
    } finally {
      if (owner.child.exitCode === null) {
        owner.child.kill("SIGTERM");
        await owner.exit;
      }
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 25000);
  it("recovers only generated abandoned files, supports empty recovery and rejects a missing fence", async () => {
    const { root, spooler } = await fixture();
    await recoverPushSpools(root, () => {});
    const tmp = join(root, ".private/tmp");
    const abandoned = `git-${randomUUID()}`;
    await writeFile(join(tmp, abandoned), "abandoned");
    await writeFile(join(tmp, "export-unrelated"), "keep");
    await writeFile(join(tmp, "git-not-a-uuid"), "keep");
    await expect(
      recoverPushSpools(root, () => {
        throw new Error("no fence");
      }),
    ).rejects.toThrow("no fence");
    expect(await readFile(join(tmp, abandoned), "utf8")).toBe("abandoned");
    await recoverPushSpools(root, () => {});
    expect((await readdir(tmp)).sort()).toEqual(["export-unrelated", "git-not-a-uuid"]);
    const next = await spooler.spool(request("successor"), "u");
    expect(next.size).toBe(9);
    await next.dispose();
    expect(spooler.outstanding).toBe(0);
    await recoverPushSpools(root, () => {});
    expect((await readdir(tmp)).sort()).toEqual(["export-unrelated", "git-not-a-uuid"]);
  });
  it.each(["root", "private", "tmp", "leaf"])(
    "recovery refuses a symlink at %s without touching its target",
    async (site) => {
      const { root } = await fixture();
      const target = await mkdtemp(join(tmpdir(), "kb-spool-target-"));
      dirs.push(target);
      const name = `git-${randomUUID()}`;
      await writeFile(join(target, name), "keep");
      let recoverRoot = root;
      if (site === "root") {
        recoverRoot = join(root, "link");
        await symlink(target, recoverRoot);
      } else if (site === "private") {
        await symlink(target, join(root, ".private"));
      } else {
        await mkdir(join(root, ".private"));
        if (site === "tmp") await symlink(target, join(root, ".private/tmp"));
        else {
          await mkdir(join(root, ".private/tmp"));
          await symlink(join(target, name), join(root, ".private/tmp", name));
        }
      }
      await expect(recoverPushSpools(recoverRoot, () => {})).rejects.toThrow();
      expect(await readFile(join(target, name), "utf8")).toBe("keep");
    },
  );
  it("a rejected name collision preserves the live owner and permits later reuse", async () => {
    const { root, spooler } = await fixture();
    uuidFault.value = "11111111-1111-4111-8111-111111111111";
    const ready = await spooler.spool(request("first"), "u");
    try {
      await expect(spooler.spool(request("second"), "u")).rejects.toThrow("SPOOL_NAME_CONFLICT");
      sweepAbandonedPushSpools(root, () => {});
      expect(await readdir(join(root, ".private/tmp"))).toHaveLength(1);
      expect(spooler.outstanding).toBe(1);
      expect((await ready.file.readFile()).toString()).toBe("first");
    } finally {
      await ready.dispose();
    }
    const reused = await spooler.spool(request("reused"), "u");
    await reused.dispose();
    expect(spooler.outstanding).toBe(0);
  });
  it("sweeps abandoned files while preserving in-progress and ready spools across spoolers", async () => {
    const { root, spooler } = await fixture();
    const other = createPushSpooler({ root });
    const abort = new AbortController();
    const pending = other.spool(blocked(abort.signal), "pending");
    const ready = await spooler.spool(request("ready"), "ready");
    const abandoned = join(root, `.private/tmp/git-${randomUUID()}`);
    const sibling = join(root, ".private/tmp/upload-unrelated");
    await writeFile(abandoned, "abandoned");
    await writeFile(sibling, "sibling");
    expect(() =>
      sweepAbandonedPushSpools(root, () => {
        throw new Error("no fence");
      }),
    ).toThrow("no fence");
    expect(await readFile(abandoned, "utf8")).toBe("abandoned");
    sweepAbandonedPushSpools(root, () => {});
    sweepAbandonedPushSpools(root, () => {});
    expect(await readdir(join(root, ".private/tmp"))).toHaveLength(3);
    expect((await ready.file.readFile()).toString()).toBe("ready");
    expect(await readFile(sibling, "utf8")).toBe("sibling");
    abort.abort();
    await expect(pending).rejects.toMatchObject({ status: 408 });
    await ready.dispose();
    expect(await readdir(join(root, ".private/tmp"))).toEqual(["upload-unrelated"]);
  });
  it("supports the empty/default body and counts bytes in a private no-follow file", async () => {
    const { spooler } = await fixture();
    expect(PUSH_MAX_BYTES).toBe(50 * 1024 * 1024);
    const empty = await spooler.spool(request(null), "u");
    expect(empty.size).toBe(0);
    await empty.dispose();
    const full = await spooler.spool(request("payload"), "u");
    expect(full.size).toBe(7);
    expect((await full.file.stat()).mode & 0o777).toBe(0o600);
    expect((await full.file.readFile()).toString()).toBe("payload");
    await full.dispose();
    await full.dispose();
    expect(spooler.outstanding).toBe(0);
  });
  it.each([undefined, "1", "100"])(
    "enforces actual chunked bytes regardless declared length %s",
    async (length) => {
      const { root, spooler } = await fixture({ maxBytes: 8 });
      await expect(
        spooler.spool(request("123456789", undefined, length), "u"),
      ).rejects.toMatchObject({ status: 413 });
      expect(spooler.outstanding).toBe(0);
      expect(await readdir(join(root, ".private/tmp"))).toEqual([]);
    },
  );
  it("accepts >10 MiB without the generic body cap", async () => {
    const { spooler } = await fixture();
    const full = await spooler.spool(request(new Uint8Array(11 * 1024 * 1024)), "u");
    expect(full.size).toBe(11 * 1024 * 1024);
    await full.dispose();
  });
  it("two per user/four server permits release on disconnect, including pre-abort", async () => {
    const { spooler } = await fixture();
    const aborts = Array.from({ length: 4 }, () => new AbortController());
    const work = aborts.map((abort, i) => spooler.spool(blocked(abort.signal), i < 2 ? "a" : "b"));
    const settled = Promise.allSettled(work);
    await expect(spooler.spool(blocked(), "a")).rejects.toMatchObject({ status: 429 });
    await expect(spooler.spool(blocked(), "c")).rejects.toMatchObject({ status: 429 });
    for (const abort of aborts) abort.abort();
    expect((await settled).every((r) => r.status === "rejected")).toBe(true);
    expect(spooler.outstanding).toBe(0);
    const good = await spooler.spool(request("ok"), "a");
    await good.dispose();
  });
  it.each([{ idleMs: 15 }, { totalMs: 15 }])(
    "timeouts reclaim files and permits %o",
    async (options) => {
      const { root, spooler } = await fixture(options);
      await expect(spooler.spool(blocked(), "u")).rejects.toMatchObject({ status: 408 });
      expect(spooler.outstanding).toBe(0);
      expect(await readdir(join(root, ".private/tmp"))).toEqual([]);
    },
  );
  it("rejects a symlinked private directory without touching the target", async () => {
    const { root, spooler } = await fixture();
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(root, ".private"));
    await expect(spooler.spool(request("data"), "u")).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
    expect(spooler.outstanding).toBe(0);
    await expect(readFile(join(target, "data"))).rejects.toThrow();
  });
});
