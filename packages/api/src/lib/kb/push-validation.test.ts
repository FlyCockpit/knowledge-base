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
  const commit = async (path: string, body: string, parent?: string, message = `edit ${path}`) => {
    if (parent) git("checkout", "--quiet", "--detach", parent);
    await writeFile(join(repo, path), body);
    git("add", path);
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  /** Markdown a credential pushes says `provenance: agent`. */
  const agent = (text: string) => `---\nprovenance: agent\n---\n${text}`;
  let oldMain: string, main: string, branch: string, orphan: string;
  let human: string, dream: string, trailer: string, mergedMain: string;
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
    branch = await commit("c.md", agent("# C\n"), oldMain);
    // Pushed Markdown claiming a person's or a dream's label, or no label.
    human = await commit("h.md", "---\nprovenance: human\n---\n# H\n", oldMain);
    dream = await commit("d.md", "---\nprovenance: dream\n---\n# D\n", oldMain);
    // A pushed commit posing as the server's attribution block.
    trailer = await commit(
      "t.md",
      agent("# T\n"),
      oldMain,
      "edit t.md\n\nActed-by: Someone via web\nKb-Actor-Key: user:someone",
    );
    // Merging current main in: main's own (server) commits stay trusted parents.
    git("checkout", "--quiet", "--detach", branch);
    git("merge", "--quiet", "--no-edit", "-m", "merge main", main);
    mergedMain = git("rev-parse", "HEAD");
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

  it("refuses pushed Markdown not labelled agent, naming the path", async () => {
    for (const [tip, path] of [
      [human, "h.md"],
      [dream, "d.md"],
    ] as const) {
      const error = await push(ZERO_SHA, tip).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PushRefusedError);
      expect((error as PushRefusedError).refusal).toBe("PROVENANCE");
      expect((error as PushRefusedError).detail).toEqual({ code: "TREE_PROVENANCE", path });
    }
  });

  it("refuses a pushed commit carrying the server's attribution trailers", async () => {
    const error = await push(ZERO_SHA, trailer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PushRefusedError);
    expect((error as PushRefusedError).refusal).toBe("RESERVED_TRAILER");
  });

  it("trusts commits an existing ref reaches when a branch merges main", async () => {
    // b.md (unlabelled, from main) is not the pusher's write: only the merge is new.
    await expect(push(ZERO_SHA, mergedMain)).resolves.toMatchObject({ ok: true });
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

  describe("three-way merge authorship", () => {
    const humanDoc = (text: string) => `---\nprovenance: human\n---\n${text}`;
    let humanV1: string, mainV2: string, side: string;
    beforeAll(async () => {
      // Trusted history (an existing ref reaches it): a person wrote h2.md,
      // then edited it again on main.
      git("checkout", "--quiet", "--force", "--detach", main);
      humanV1 = await commit("h2.md", humanDoc("# H2 v1\n"), main);
      mainV2 = await commit("h2.md", humanDoc("# H2 v2\n"), humanV1);
      git("update-ref", "refs/heads/main-v2", mainV2);
      // A credential's branch from the older main: an agent document only.
      side = await commit("s.md", agent("# S\n"), humanV1);
    });
    const mergeOf = (parents: string[], tree: string, message: string) =>
      git("commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message);

    it("refuses restoring an old human version through an obsolete second parent", async () => {
      // First parent is current main, second an older ancestor; the tree
      // takes the ancestor's h2.md: equal to a parent, yet a restoration.
      git("checkout", "--quiet", "--detach", mainV2);
      await writeFile(join(repo, "h2.md"), humanDoc("# H2 v1\n"));
      git("add", "h2.md");
      const restore = mergeOf([mainV2, humanV1], git("write-tree"), "restore");
      git("checkout", "--quiet", "--force", "--detach", mainV2);
      const error = await push(ZERO_SHA, restore, mainV2).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PushRefusedError);
      expect((error as PushRefusedError).refusal).toBe("PROVENANCE");
      expect((error as PushRefusedError).detail).toEqual({
        code: "TREE_PROVENANCE",
        path: "h2.md",
      });
    });

    it("accepts a clean merge of a side branch's agent change into main", async () => {
      // main first: s.md comes from the side (only it changed s.md) and
      // h2.md is main's own, unchanged by the side since the merge base.
      git("checkout", "--quiet", "--detach", mainV2);
      git("merge", "--quiet", "--no-edit", "-m", "merge side", side);
      const merged = git("rev-parse", "HEAD");
      expect(readParents(merged)).toEqual([mainV2, side]);
      await expect(push(ZERO_SHA, merged, mainV2)).resolves.toMatchObject({ ok: true });
    });

    it("accepts merging current main into a branch", async () => {
      // Branch first: h2.md v2 comes from main, which alone changed it.
      git("checkout", "--quiet", "--detach", side);
      git("merge", "--quiet", "--no-edit", "-m", "merge main", mainV2);
      const merged = git("rev-parse", "HEAD");
      expect(readParents(merged)).toEqual([side, mainV2]);
      await expect(push(ZERO_SHA, merged, mainV2)).resolves.toMatchObject({ ok: true });
    });

    it("refuses a reversed-parent merge restoring an older dream version over main", async () => {
      // Trusted history: p.md was a dream document, then a person edited it
      // on main. A merge naming the old dream commit FIRST and current main
      // second, with the dream commit's tree, equals its first parent's
      // blob, yet it reverts the person's edit: the baseline is the parent
      // connected to the previous tip, whatever the order.
      git("checkout", "--quiet", "--force", "--detach", mainV2);
      const dreamA = await commit("p.md", "---\nprovenance: dream\n---\n# P\n", mainV2);
      const humanB = await commit("p.md", humanDoc("# P edited\n"), dreamA);
      git("update-ref", "refs/heads/main-p", humanB);
      const attack = mergeOf([dreamA, humanB], git("rev-parse", `${dreamA}^{tree}`), "reverse");
      expect(readParents(attack)).toEqual([dreamA, humanB]);
      for (const [oldSha, mainSha] of [
        [humanB, humanB],
        [ZERO_SHA, humanB],
      ] as const) {
        const error = await push(oldSha, attack, mainSha).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PushRefusedError);
        expect((error as PushRefusedError).refusal).toBe("PROVENANCE");
        expect((error as PushRefusedError).detail).toEqual({
          code: "TREE_PROVENANCE",
          path: "p.md",
        });
      }
    });

    it("accepts merging main into a branch as an update of that branch", async () => {
      // The branch's previous tip is the baseline; main alone changed h2.md.
      git("checkout", "--quiet", "--force", "--detach", side);
      git("merge", "--quiet", "--no-edit", "-m", "merge main", mainV2);
      const merged = git("rev-parse", "HEAD");
      expect(readParents(merged)).toEqual([side, mainV2]);
      await expect(push(side, merged, mainV2)).resolves.toMatchObject({ ok: true });
    });

    it("accepts an ordinary fast-forward of agent edits", async () => {
      git("checkout", "--quiet", "--force", "--detach", side);
      const next = await commit("s.md", agent("# S v2\n"), side);
      const after = await commit("f.md", agent("# F\n"), next);
      await expect(push(side, after, mainV2)).resolves.toMatchObject({ ok: true });
    });

    const readParents = (sha: string) =>
      git("rev-list", "--parents", "--max-count=1", sha).split(" ").slice(1);
  });

  it("knows exactly its refusal codes", () => {
    expect(isPushRefusalCode("NON_FAST_FORWARD")).toBe(true);
    expect(isPushRefusalCode("toString")).toBe(false);
    expect(isPushRefusalCode(undefined)).toBe(false);
  });
});
