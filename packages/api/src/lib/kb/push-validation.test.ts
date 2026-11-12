import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hardenedGitEnv } from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import { KB_MANIFEST_MAX_ENTRIES } from "./manifest";
import {
  inspectPushRequest,
  isPushRefusalCode,
  KB_MAX_LOGICAL_CHANGES,
  PUSH_REFUSALS,
  PushRefusedError,
  parsePushCommands,
  parsePushObjectFiles,
  parsePushTouched,
  retainedPushObjectBytes,
  syncPushObjects,
  validatePush,
  ZERO_SHA,
} from "./push-validation";

describe("push quarantine retention inventory", () => {
  const loose = `ab/${"c".repeat(38)}`,
    packed = `pack/pack-${"d".repeat(40)}.pack`;
  const files = [
    { path: loose, bytes: 5 },
    { path: packed, bytes: 4 },
  ];
  const cases = ["empty", "discarded", "partial", "complete", "corrupt", "symlink"] as const;
  let root: string | undefined;
  let setup: Promise<void> | undefined;
  beforeAll(() => {
    // Fixture writes have their own lifecycle. Each inventory/retention action
    // keeps the unchanged test deadline and executes against real filesystem I/O.
    setup = (async () => {
      root = await mkdtemp(join(tmpdir(), "kb-push-inventory-"));
      const ownedRoot = root;
      const preparations = await Promise.allSettled(
        cases.map(async (state) => {
          const repo = join(ownedRoot, state);
          const objects = join(repo, "objects"),
            incoming = join(objects, "incoming");
          await mkdir(join(incoming, "ab"), { recursive: true });
          await mkdir(join(incoming, "pack"));
          if (state === "empty") return;
          await writeFile(join(incoming, loose), "loose");
          await writeFile(join(incoming, packed), "pack");
          await writeFile(join(incoming, packed.replace(".pack", ".keep")), "temporary lock");
          if (state === "symlink") {
            await mkdir(join(repo, "outside"));
            await symlink(join(repo, "outside"), join(objects, "ab"));
            return;
          }
          if (state === "discarded") return;
          await mkdir(join(objects, "ab"));
          await writeFile(join(objects, loose), "loose");
          if (state === "partial") return;
          await mkdir(join(objects, "pack"));
          await writeFile(join(objects, packed), state === "corrupt" ? "corrupt size" : "pack");
        }),
      );
      const failures = preparations.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Inventory fixture setup failed");
      // Start measurement from a durable directory baseline, rather than
      // charging fixture-creation journal work to the first inventory action.
      const directory = await open(ownedRoot, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    })();
    return setup;
  });
  afterAll(async () => {
    // A timed-out setup still owns its writes; join them before removing our root.
    await setup?.catch(() => {});
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(cases)("measures %s quarantine/canonical files", (state) => {
    if (!root) throw new Error("Inventory fixture is not ready");
    const repo = join(root, state);
    const objects = join(repo, "objects"),
      incoming = join(objects, "incoming");
    if (state === "corrupt" || state === "symlink") {
      expect(() => retainedPushObjectBytes(repo, files)).toThrow();
      return;
    }
    const expected =
      state === "discarded" ? files : state === "partial" ? [{ path: packed, bytes: 4 }] : [];
    // Persistent loose/pack files are charged once; receive-pack's .keep is excluded.
    expect(syncPushObjects(incoming, objects)).toEqual(expected);
    expect(retainedPushObjectBytes(repo, state === "empty" ? [] : files)).toBe(
      state === "partial" ? 5 : state === "complete" ? 9 : 0,
    );
  });
  it("rejects malformed/traversing inventories and temporary keep files", () => {
    for (const value of [
      null,
      [{ path: "../outside", bytes: 1 }],
      [{ path: loose, bytes: -1 }],
      [{ path: packed.replace(".pack", ".keep"), bytes: 43 }],
      Array(100009).fill({}),
    ])
      expect(() => parsePushObjectFiles(value)).toThrow();
  });
});

const old = "1".repeat(40),
  next = "2".repeat(40),
  zero = "0".repeat(40);
const command = `${old} ${next} refs/heads/main`;
function request(pack: Buffer, commands = [command]) {
  const lines = commands.map((line, i) => {
    const body = `${line}${i === 0 ? "\0report-status side-band-64k" : ""}\n`;
    return Buffer.from(`${(Buffer.byteLength(body) + 4).toString(16).padStart(4, "0")}${body}`);
  });
  return Buffer.concat([...lines, Buffer.from("0000"), pack]);
}
function pack(body: Buffer, count = 1) {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  let size = body.length;
  const entry = [(3 << 4) | (size & 15)];
  size = Math.floor(size / 16);
  if (size) entry[0]! |= 128;
  while (size) {
    const byte = size & 127;
    size = Math.floor(size / 128);
    entry.push(byte | (size ? 128 : 0));
  }
  const data = Buffer.concat([header, Buffer.from(entry), deflateSync(body)]);
  return Buffer.concat([data, createHash("sha1").update(data).digest()]);
}
describe("single-ref push admission and pack preflight", () => {
  it("accepts one main command and an empty pack", () => {
    const header = Buffer.from("5041434b0000000200000000", "hex");
    const empty = Buffer.concat([header, createHash("sha1").update(header).digest()]);
    expect(inspectPushRequest(request(empty))).toEqual({
      oldSha: old,
      newSha: next,
      refName: "refs/heads/main",
    });
    expect(inspectPushRequest(request(pack(Buffer.from("markdown"))))).toEqual(
      parsePushCommands(`${command}\n`),
    );
  });
  // Each case is wrapped once more: it.each spreads an inner array into arguments, so
  // a bare `[]` would silently fall back to the default single valid command.
  it.each<[string[]]>([[[]], [[command, command]], [[command, `${old} ${next} refs/heads/topic`]]])(
    "rejects zero or multiple commands before pack work: %j",
    (lines) => {
      expect(() => inspectPushRequest(request(Buffer.alloc(0), lines))).toThrow(PushRefusedError);
    },
  );
  it.each([
    `refs/heads/pr/1`,
    "refs/tags/v1",
    "refs/replace/x",
    "refs/remotes/x",
    "refs/heads/a..b",
    "refs/heads/.hidden",
    "refs/heads/a.lock",
  ])("rejects reserved/invalid namespace %s", (ref) => {
    expect(() => parsePushCommands(`${old} ${next} ${ref}\n`)).toThrow();
  });
  it.each([
    ["refs/tags/v1+build", "INVALID_NAMESPACE"],
    ["refs/tags/版本+1", "INVALID_NAMESPACE"],
    ["refs/tags/a b", "INVALID_NAMESPACE"],
    [`refs/tags/${"x".repeat(300)}+é`, "INVALID_NAMESPACE"],
    ["refs/heads/other+name", "INVALID_REF"],
    ["refs/heads/café", "INVALID_REF"],
  ])("retains Git-valid wire identity %s when refusing policy", (ref, refusal) => {
    execFileSync("git", ["check-ref-format", ref]);
    expect(() => parsePushCommands(`${old} ${next} ${ref}\n`)).toThrow(
      expect.objectContaining({ refusal, refs: [ref] }),
    );
  });
  it("retains every identity in a multi-ref push outside the product alphabet", () => {
    const refs = ["refs/heads/topic", "refs/tags/v1+build", "refs/heads/分支+1"];
    for (const ref of refs) execFileSync("git", ["check-ref-format", ref]);
    expect(() => parsePushCommands(refs.map((ref) => `${old} ${next} ${ref}\n`).join(""))).toThrow(
      expect.objectContaining({ refusal: "MULTIPLE_REFS", refs }),
    );
  });
  it("rejects deletion/noop and permits creation of a user branch", () => {
    expect(() => parsePushCommands(`${old} ${zero} refs/heads/topic\n`)).toThrow();
    expect(() => parsePushCommands(`${old} ${old} refs/heads/main\n`)).toThrow();
    expect(parsePushCommands(`${zero} ${next} refs/heads/topic\n`).oldSha).toBe(zero);
  });
  it("rejects object count above 100000 before decompression", () => {
    expect(() => inspectPushRequest(request(pack(Buffer.alloc(0), 100001)))).toThrow();
  });
  it("stops a compressed object exceeding 128 MiB before backend publication", () => {
    expect(() => inspectPushRequest(request(pack(Buffer.alloc(128 * 1024 * 1024 + 1))))).toThrow();
  });
  it("rejects corrupt/truncated packs and extra bytes", () => {
    const good = pack(Buffer.from("ok"));
    for (const bad of [
      good.subarray(0, -1),
      Buffer.concat([good, Buffer.from("x")]),
      Buffer.alloc(20),
    ])
      expect(() => inspectPushRequest(request(bad))).toThrow();
  });
});

describe("logical writes of a branch update", () => {
  it("are bounded by logical limits, not the physical entry count", () => {
    // Every document and every asset entry removed and as many added.
    expect(KB_MAX_LOGICAL_CHANGES).toBe(2 * (KB_TREE_LIMITS.maxFiles + KB_MANIFEST_MAX_ENTRIES));
    const renames = [
      ...Array.from({ length: KB_MANIFEST_MAX_ENTRIES }, (_, n) => ({
        kind: "asset" as const,
        path: `old/${n}.png`,
      })),
      ...Array.from({ length: KB_MANIFEST_MAX_ENTRIES }, (_, n) => ({
        kind: "asset" as const,
        path: `new/${n}.png`,
      })),
      { kind: "document" as const, path: "index.md" },
    ];
    expect(renames.length).toBeGreaterThan(2 * KB_TREE_LIMITS.maxEntries);
    expect(parsePushTouched(renames)).toHaveLength(renames.length);
    const over = Array.from({ length: KB_MAX_LOGICAL_CHANGES + 1 }, (_, n) => ({
      kind: "document" as const,
      path: `d/${n}.md`,
    }));
    expect(() => parsePushTouched(over)).toThrow();
    expect(() => parsePushTouched([{ kind: "folder", path: "a.md" }])).toThrow();
    expect(() => parsePushTouched([{ kind: "asset", path: "../a.md" }])).toThrow();
  });
});

describe("push ancestry (R3-W10)", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...hardenedGitEnv(),
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    }).trim();
  const commit = async (path: string, body: string, parent?: string) => {
    if (parent) git("checkout", "--quiet", "--detach", parent);
    await writeFile(join(repo, path), body);
    git("add", path);
    git("commit", "--quiet", "-m", `edit ${path}`);
    return git("rev-parse", "HEAD");
  };
  let oldMain: string, main: string, branch: string, orphan: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "kb-push-ancestry-"));
    git("init", "--quiet", "--initial-branch=main");
    // A minimal valid KB tree (validate-tree's required root files).
    const seed = async () => {
      await writeFile(join(repo, "index.md"), "# Notes\n");
      await writeFile(join(repo, ".gitignore"), "# kb managed\n");
      await mkdir(join(repo, ".assets"), { recursive: true });
      await writeFile(join(repo, ".assets/manifest.json"), '{"version":1,"entries":[]}\n');
      git("add", "index.md", ".gitignore", ".assets/manifest.json");
    };
    await seed();
    oldMain = await commit("a.md", "# A\n");
    main = await commit("b.md", "# B\n");
    // A teammate's commit landed after this branch started from the older main.
    branch = await commit("c.md", "# C\n", oldMain);
    git("checkout", "--quiet", "--orphan", "unrelated");
    git("rm", "-r", "--quiet", "--cached", ".");
    await seed();
    orphan = await commit("z.md", "# Z\n");
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const push = (oldSha: string, newSha: string, mainSha = main) =>
    validatePush({ repoPath: repo }, { oldSha, newSha, refName: "refs/heads/topic" }, mainSha);

  it("accepts a new branch started from an older main", async () => {
    await expect(push(ZERO_SHA, branch)).resolves.toMatchObject({ ok: true });
  });

  it("accepts a new branch from the current main", async () => {
    await expect(push(ZERO_SHA, main)).resolves.toMatchObject({ ok: true });
  });

  it("refuses unrelated history with a readable reason", async () => {
    const error = await push(ZERO_SHA, orphan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as PushRefusedError).refusal).toBe("UNRELATED_HISTORY");
    expect((error as Error).message).toBe(PUSH_REFUSALS.UNRELATED_HISTORY);
  });

  it("refuses a non-fast-forward update with a readable reason", async () => {
    const error = await push(main, branch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as PushRefusedError).refusal).toBe("NON_FAST_FORWARD");
  });

  it("keeps a git failure a failure, never a refusal", async () => {
    const error = await push(ZERO_SHA, "f".repeat(40)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PushRefusedError);
  });

  it("knows exactly its refusal codes", () => {
    expect(isPushRefusalCode("NON_FAST_FORWARD")).toBe(true);
    expect(isPushRefusalCode("toString")).toBe(false);
    expect(isPushRefusalCode(undefined)).toBe(false);
  });
});
