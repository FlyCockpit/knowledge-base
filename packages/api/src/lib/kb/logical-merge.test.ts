import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialMainTreeFiles } from "./git-write";
import {
  type BlobReader,
  gitBlobSha,
  type LogicalConflict,
  type LogicalTree,
  logicalTreeOf,
  mergeLogicalTrees,
  treeInputsOf,
} from "./logical-merge";
import { type AssetManifestEntry, canonicalManifestBytes } from "./manifest";
import { changePathsCollide } from "./protocol/writes";
import { stageCommitWithTreeFiles } from "./staged-tree";
import { measureStagedTree, validateStagedCommitTree } from "./validate-tree";

const store = new Map<string, Buffer>();
const read: BlobReader = async (sha) => {
  const bytes = store.get(sha);
  if (!bytes) throw new Error(`missing blob ${sha}`);
  return bytes;
};
const blob = (text: string | Buffer) => {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const sha = gitBlobSha(bytes);
  store.set(sha, bytes);
  return sha;
};
const asset = (path: string, n: number): AssetManifestEntry => ({
  path,
  hash: `sha256:${String(n).padStart(64, "0")}`,
  size: 10 + n,
  mime: "image/png",
});
type Spec = { docs?: Record<string, string>; assets?: AssetManifestEntry[] };
const BASE_FILES = initialMainTreeFiles("Logical merge fixture");
async function tree(spec: Spec): Promise<LogicalTree> {
  const entries = new Map<string, { sha: string; size: number }>();
  const put = (path: string, bytes: Buffer | string) => {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    entries.set(path, { sha: blob(buffer), size: buffer.length });
  };
  for (const file of BASE_FILES) put(file.segments.join("/"), file.content);
  for (const [path, text] of Object.entries(spec.docs ?? {})) put(path, text);
  put(".assets/manifest.json", canonicalManifestBytes({ version: 1, entries: spec.assets ?? [] }));
  const logical = await logicalTreeOf(entries, read);
  if (!logical) throw new Error("fixture manifest");
  return logical;
}
const noLineMerge = async () => null;
const merge = async (base: Spec, main: Spec, proposal: Spec) =>
  mergeLogicalTrees({
    base: await tree(base),
    main: await tree(main),
    proposal: await tree(proposal),
    mergeText: noLineMerge,
    read,
  });
/** The validator's own totals for a logical tree (every blob staged by content). */
function measured(t: LogicalTree) {
  const files = treeInputsOf(t).map((input) =>
    input.blobSha ? { segments: input.segments, content: store.get(input.blobSha)! } : input,
  );
  return measureStagedTree(
    stageCommitWithTreeFiles({ parentSha: "a".repeat(40), message: "m", files }),
  );
}
/** Whether a logical tree passes the whole-tree rules (assets trusted as listed). */
async function valid(t: LogicalTree): Promise<boolean> {
  const files = treeInputsOf(t).map((input) =>
    input.blobSha ? { segments: input.segments, content: store.get(input.blobSha)! } : input,
  );
  const staged = stageCommitWithTreeFiles({ parentSha: "a".repeat(40), message: "m", files });
  const entries = [...t.assets.values()];
  return validateStagedCommitTree(staged, {
    trustedBlobs: new Map(entries.map((e) => [e.hash, { size: e.size, mime: e.mime }])),
    lineageHashes: new Set(entries.map((e) => e.hash)),
    validateSealedReferences: () => null,
  }).ok;
}
const id = (key: string, body = key) => `---\nid: ${key}\n---\n# ${body}\n`;

describe("logical three-way merge", () => {
  it("reports every duplicated document id, not just the first", async () => {
    const nine = Array.from({ length: 9 }, (_, n) => n);
    const result = await merge(
      {},
      { docs: Object.fromEntries(nine.map((n) => [`main/m${n}.md`, id(`k${n}`, "main")])) },
      { docs: Object.fromEntries(nine.map((n) => [`pr/b${n}.md`, id(`k${n}`, "pr")])) },
    );
    // Both holders of each id: restoring either side's document needs the other gone.
    expect(result.conflicts).toEqual([
      ...nine.map(
        (n): LogicalConflict => ({ path: `main/m${n}.md`, kind: "document", standing: true }),
      ),
      ...nine.map((n): LogicalConflict => ({ path: `pr/b${n}.md`, kind: "document" })),
    ]);
    expect(await valid(result.tree)).toBe(true);
  });

  it("types .md-named assets as assets, including a case collision and a same-path clash", async () => {
    const collision = await merge(
      {},
      { assets: [asset("media/A.md", 1)] },
      { assets: [asset("media/a.md", 2)] },
    );
    expect(collision.conflicts).toEqual([
      { path: "media/A.md", kind: "asset", standing: true },
      { path: "media/a.md", kind: "asset" },
    ]);
    expect(await valid(collision.tree)).toBe(true);
    const samePath = await merge(
      {},
      { assets: [asset("media/x.md", 3)] },
      { assets: [asset("media/x.md", 4)] },
    );
    expect(samePath.conflicts).toEqual([{ path: "media/x.md", kind: "asset" }]);
    // The PR's entry is kept while the clash is unresolved.
    expect(samePath.tree.assets.get("media/x.md")).toEqual(asset("media/x.md", 4));
  });

  it("names the real logical path for file-vs-directory, both ways", async () => {
    const dirOnPr = await merge(
      {},
      { docs: { "foo.md": "main" } },
      { docs: { "foo.md/bar.md": "pr" } },
    );
    expect(dirOnPr.conflicts).toEqual([
      { path: "foo.md", kind: "document", standing: true },
      { path: "foo.md/bar.md", kind: "document" },
    ]);
    expect(await valid(dirOnPr.tree)).toBe(true);
    const fileOnPr = await merge(
      {},
      { docs: { "foo.md/bar.md": "main" } },
      { docs: { "foo.md": "pr" } },
    );
    expect(fileOnPr.conflicts).toEqual([
      { path: "foo.md", kind: "document" },
      { path: "foo.md/bar.md", kind: "document", standing: true },
    ]);
    expect(await valid(fileOnPr.tree)).toBe(true);
    for (const result of [dirOnPr, fileOnPr])
      for (const c of result.conflicts) expect(c.path).not.toMatch(/~/);
  });

  it("stays linear and yields near the tree limits (8,000 entries)", async () => {
    const many = (prefix: string, count: number, offset = 0) =>
      Array.from({ length: count }, (_, n) => asset(`${prefix}/a${n}.png`, offset + n));
    const docs = (prefix: string, count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, n) => [`${prefix}/d${n}.md`, id(`${prefix}-${n}`)]),
      );
    const main: Spec = { assets: many("main", 4000), docs: docs("main", 500) };
    const proposal: Spec = {
      assets: [...many("main", 4000), ...many("pr", 4000, 5000)],
      docs: { ...docs("main", 500), ...docs("pr", 500) },
    };
    const trees = {
      base: await tree(main),
      main: await tree(main),
      proposal: await tree(proposal),
    };
    let yields = 0;
    const started = performance.now();
    const result = await mergeLogicalTrees({
      ...trees,
      mergeText: noLineMerge,
      read,
      checkpoint: async () => {
        yields += 1;
      },
    });
    const elapsed = performance.now() - started;
    expect(result.conflicts).toEqual([]);
    expect(result.tree.assets.size).toBe(8000);
    // Quadratic structural checking took seconds here; linear takes well under one.
    expect(elapsed).toBeLessThan(2500);
    expect(yields).toBeGreaterThan(30);
    // Staging a flat directory near the file limit is linear too.
    const flat = Array.from({ length: 8000 }, (_, n) => ({
      segments: ["flat", `f${n}.md`],
      content: Buffer.from(`# ${n}\n`),
    }));
    const stagingStarted = performance.now();
    stageCommitWithTreeFiles({ parentSha: "a".repeat(40), message: "m", files: flat });
    expect(performance.now() - stagingStarted).toBeLessThan(2500);
    // A failing checkpoint (cancellation) stops the merge.
    await expect(
      mergeLogicalTrees({
        ...trees,
        mergeText: noLineMerge,
        read,
        checkpoint: async () => {
          throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("cancelled");
  });

  it("treats every repository limit as a merge constraint, across the boundary", async () => {
    const assets = (prefix: string, count: number, offset = 0) =>
      Array.from({ length: count }, (_, n) => asset(`${prefix}/a${n}.png`, offset + n));
    const extra = asset("pr/extra.png", 99_999);
    // At the manifest limit: one independent proposal asset more is a conflict.
    const full = await merge({}, { assets: assets("main", 8192) }, { assets: [extra] });
    expect(full.conflicts).toEqual([{ path: "pr/extra.png", kind: "asset" }]);
    expect(full.tree.assets.size).toBe(8192);
    expect(await valid(full.tree)).toBe(true);
    // One below the limit: it fits and nothing clashes.
    const fits = await merge({}, { assets: assets("main", 8191) }, { assets: [extra] });
    expect(fits.conflicts).toEqual([]);
    expect(fits.tree.assets.size).toBe(8192);
    // The file limit: main is at 4,096 files; of two added documents the
    // latest-sorted gives way.
    const docs = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, n) => [`main/d${n}.md`, `# ${n}\n`]));
    // 4,095 files: .gitignore, manifest, index.md and 4,092 documents.
    const atFiles = await merge(
      {},
      { docs: docs(4092) },
      { docs: { "pr/a.md": "a\n", "pr/b.md": "b\n" } },
    );
    expect(atFiles.conflicts).toEqual([{ path: "pr/b.md", kind: "document" }]);
    for (const result of [full, fits, atFiles])
      expect(result.totals).toEqual(measured(result.tree));
    expect(await valid(atFiles.tree)).toBe(true);
  });

  it("counts the root tree like the validator: two flat additions at 8,191 entries", async () => {
    // 5 fixed entries (root, .assets, index.md, .gitignore, manifest), 264
    // chains of 30 directories and a file, and one document in its own directory.
    const chain = (n: number) =>
      `${Array.from({ length: 30 }, (_, d) => (d === 0 ? `c${n}` : "d")).join("/")}/x.md`;
    const docs: Record<string, string> = { "solo/x.md": "solo\n" };
    for (let n = 0; n < 264; n += 1) docs[chain(n)] = `${n}\n`;
    const baseTree = await tree({ docs });
    expect(measured(baseTree).entries).toBe(8191);
    const main = { docs: { ...docs, "m.md": "main\n" } };
    const proposal = { docs: { ...docs, "p.md": "proposal\n" } };
    expect(measured(await tree(main)).entries).toBe(8192);
    expect(await valid(await tree(proposal))).toBe(true);
    const result = await merge({ docs }, main, proposal);
    expect(result.conflicts).toEqual([{ path: "p.md", kind: "document" }]);
    expect(result.totals).toEqual(measured(result.tree));
    expect(result.totals.entries).toBe(8192);
    expect(await valid(result.tree)).toBe(true);
  });

  it("settles cascading fallbacks with a worklist (id shift across 4,000 documents)", async () => {
    // Base ids k0…kN-1; the proposal shifts every document to the next id;
    // main adds kN. Each fallback evicts exactly one more document.
    const n = 4000;
    const doc = (i: number, key: number) => `---\nid: k${key}\n---\n# ${i}\n`;
    const baseDocs = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`d/${String(i).padStart(5, "0")}.md`, doc(i, i)]),
    );
    const proposalDocs = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`d/${String(i).padStart(5, "0")}.md`, doc(i, i + 1)]),
    );
    const mainDocs = { ...baseDocs, "main/new.md": doc(-1, n) };
    const trees = {
      base: await tree({ docs: baseDocs }),
      main: await tree({ docs: mainDocs }),
      proposal: await tree({ docs: proposalDocs }),
    };
    let single = 0;
    let batches = 0;
    const started = performance.now();
    const result = await mergeLogicalTrees({
      ...trees,
      mergeText: noLineMerge,
      read: (sha) => {
        single += 1;
        return read(sha);
      },
      readMany: async (shas) => {
        batches += 1;
        return new Map(await Promise.all(shas.map(async (sha) => [sha, await read(sha)] as const)));
      },
    });
    const elapsed = performance.now() - started;
    // Main's fallback versions are batched with the rest: no read one by one.
    expect(single).toBe(0);
    expect(batches).toBeLessThanOrEqual(3);
    // Every shifted document, and main's new holder of the last id.
    expect(result.conflicts).toHaveLength(n + 1);
    expect(await valid(result.tree)).toBe(true);
    // A full pass per fallback took tens of seconds here.
    expect(elapsed).toBeLessThan(3000);
  });

  it("limits use signed contributions and recheck to a fixpoint (manifest and tree bytes)", async () => {
    const long = (n: number) => `m/${"p".repeat(420)}${String(n).padStart(6, "0")}.png`;
    const big = (path: string, n: number) => ({ ...asset(path, n), size: 1_000_000 + n });
    const small = (path: string, n: number) => ({ ...asset(path, n), size: 1 + (n % 9) });
    const manifestSize = (entries: AssetManifestEntry[]) =>
      canonicalManifestBytes({ version: 1, entries }).length;
    const limit = 2 * 1024 * 1024;
    // Main fills the manifest to within one entry of its byte limit.
    // All entries have the same length, so the count follows from one entry's bytes.
    const entryBytes = manifestSize([big(long(0), 0)]) - manifestSize([]) + 1;
    const count = Math.floor((limit - 300 - manifestSize([])) / entryBytes);
    const mainAssets = Array.from({ length: count }, (_, n) => big(long(n), n));
    const room = limit - manifestSize(mainAssets);
    // The proposal adds three entries and shrinks just enough others (6 bytes
    // each) that two of the three fit and the third does not.
    const additions = [0, 1, 2].map((n) => big(`a/${"q".repeat(420)}${n}.png`, 900_000 + n));
    const added = manifestSize(additions.slice(0, 1)) - manifestSize([]) + 1;
    const shrinkCount = Math.ceil((2 * added - room) / 6);
    const shrunk = mainAssets.map((e, n) => (n < shrinkCount ? small(e.path, n) : e));
    expect(manifestSize([...shrunk, ...additions.slice(0, 2)])).toBeLessThanOrEqual(limit);
    expect(manifestSize([...shrunk, ...additions])).toBeGreaterThan(limit);
    const result = await merge(
      { assets: mainAssets },
      { assets: mainAssets },
      { assets: [...shrunk, ...additions] },
    );
    // Only the latest-sorted addition gives way; the shrinking replacements stay.
    expect(result.conflicts).toEqual([{ path: additions[2]!.path, kind: "asset" }]);
    expect(manifestSize([...result.tree.assets.values()])).toBeLessThanOrEqual(limit);
    expect(result.tree.assets.get(shrunk[0]!.path)).toEqual(shrunk[0]);
    expect(await valid(result.tree)).toBe(true);

    // Tree bytes count the manifest too: freed manifest bytes make room for a document.
    const treeLimit = 64 * 1024 * 1024;
    const fixed = (await tree({ assets: mainAssets })).managed;
    const used =
      [...fixed.values()].reduce((sum, b) => sum + (b.size ?? 0), 0) +
      Buffer.byteLength(BASE_FILES.find((f) => f.segments[0] === "index.md")!.content) +
      manifestSize(mainAssets);
    const filler: Record<string, string> = {};
    let rest = treeLimit - used - 200;
    for (let n = 0; rest > 0; n += 1) {
      const size = Math.min(rest, 2 * 1024 * 1024 - 64);
      filler[`fill/${n}.md`] = `# ${n}\n${"x".repeat(size - `# ${n}\n`.length)}`;
      rest -= size;
    }
    const mainSpec = { assets: mainAssets, docs: filler };
    const freedFits = await merge(mainSpec, mainSpec, {
      assets: shrunk,
      docs: { ...filler, "new/fits.md": "y".repeat(500) },
    });
    // 200 bytes of room plus the bytes the shrinking freed: a 500-byte document fits.
    expect(freedFits.conflicts).toEqual([]);
    const tooBig = await merge(mainSpec, mainSpec, {
      assets: shrunk,
      docs: { ...filler, "new/large.md": "y".repeat(2000) },
    });
    expect(tooBig.conflicts).toEqual([{ path: "new/large.md", kind: "document" }]);
  });

  it("admits dense directory-case clashes in linear time (8,000 assets)", async () => {
    const mainAssets = Array.from({ length: 4000 }, (_, n) => asset(`Foo/a${n}.png`, n));
    const proposalAssets = [
      ...mainAssets,
      ...Array.from({ length: 4000 }, (_, n) => asset(`foo/b${n}.png`, 10_000 + n)),
    ];
    const trees = {
      base: await tree({ assets: mainAssets }),
      main: await tree({ assets: mainAssets }),
      proposal: await tree({ assets: proposalAssets }),
    };
    const started = performance.now();
    const result = await mergeLogicalTrees({ ...trees, mergeText: noLineMerge, read });
    expect(performance.now() - started).toBeLessThan(2000);
    // The proposal's entries, and main's: each holds the clashing directory spelling.
    expect(result.conflicts).toHaveLength(8000);
    expect(await valid(result.tree)).toBe(true);
  });

  it("property: every resolution choice, in any order and in steps, reaches a valid, fully reported state", async () => {
    // Small, collision-prone universes of paths and contents.
    const docPaths = ["a.md", "A.md", "b.md", "d.md", "d.md/x.md", "e/f.md", "E/g.md", "m/a.md"];
    const docBodies = ["one\n", "two\n", id("k1"), id("k2"), id("k1", "other"), id("k2", "other")];
    const assetPaths = ["m/a.md", "m/A.md", "m/p.png", "a.md", "A.md", "e", "d.md"];
    let seed = 20261024;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const randomSpec = (from: Spec): Spec => {
      const docs = { ...(from.docs ?? {}) };
      const assets = new Map((from.assets ?? []).map((e) => [e.path, e]));
      for (let i = 1 + random(5); i > 0; i -= 1) {
        const path = docPaths[random(docPaths.length)]!;
        if (random(3) === 0) delete docs[path];
        else docs[path] = docBodies[random(docBodies.length)]!;
      }
      for (let i = random(4); i > 0; i -= 1) {
        const path = assetPaths[random(assetPaths.length)]!;
        if (random(3) === 0) assets.delete(path);
        else assets.set(path, asset(path, random(4)));
      }
      return { docs, assets: [...assets.values()] };
    };
    const validSpec = async (from: Spec) => {
      for (;;) {
        const spec = randomSpec(from);
        if (await valid(await tree(spec))) return spec;
      }
    };
    type Choice = "main" | "mine" | "delete";
    const CHOICES: Choice[] = ["main", "mine", "delete"];
    /** The provisional tree with some conflicts resolved (the rest as provisional or removed). */
    const apply = (
      provisional: LogicalTree,
      sides: { main: LogicalTree; mine: LogicalTree },
      picks: readonly [LogicalConflict, Choice | "absent"][],
    ): LogicalTree => {
      const out: LogicalTree = {
        documents: new Map(provisional.documents),
        assets: new Map(provisional.assets),
        managed: provisional.managed,
      };
      for (const [c, choice] of picks) {
        const map = (c.kind === "document" ? out.documents : out.assets) as Map<string, unknown>;
        const side = choice === "main" ? sides.main : choice === "mine" ? sides.mine : undefined;
        const value = side
          ? c.kind === "document"
            ? side.documents.get(c.path)
            : side.assets.get(c.path)
          : undefined;
        if (value) map.set(c.path, value);
        else map.delete(c.path);
      }
      return out;
    };
    /** A resolution request's ops: a removal for an absent choice, a write otherwise. */
    const opsOf = (
      sides: { main: LogicalTree; mine: LogicalTree },
      picks: readonly [LogicalConflict, Choice][],
    ) =>
      picks.map(([c, choice]) => {
        const side = choice === "main" ? sides.main : choice === "mine" ? sides.mine : undefined;
        const present = side
          ? c.kind === "document"
            ? side.documents.has(c.path)
            : side.assets.has(c.path)
          : false;
        const op =
          c.kind === "document"
            ? present
              ? "replace"
              : "delete"
            : present
              ? "assetPut"
              : "assetRemove";
        return { op, path: c.path };
      });
    let withConflicts = 0;
    let multiple = 0;
    for (let trial = 0; trial < 600; trial += 1) {
      const base = await validSpec({});
      const [main, proposal] = [await validSpec(base), await validSpec(base)];
      const result = await merge(base, main, proposal);
      const at = `trial ${trial}`;
      // The provisional tree is always valid, so unresolved conflicts can be recorded.
      expect(await valid(result.tree), at).toBe(true);
      // The merge's accounting is the validator's, exactly.
      expect(result.totals, at).toEqual(measured(result.tree));
      if (result.conflicts.length === 0) continue;
      withConflicts += 1;
      const sides = { main: await tree(main), mine: await tree(proposal) };
      // 1. Nothing unreported: any single choice is valid against every entry
      // that is not a conflict (only other conflicts can stand in its way).
      const othersRemoved = (keep: LogicalConflict) =>
        result.conflicts
          .filter((c) => c !== keep)
          .map((c): [LogicalConflict, "absent"] => [c, "absent"]);
      for (const c of result.conflicts)
        for (const choice of CHOICES)
          expect(
            await valid(apply(result.tree, sides, [...othersRemoved(c), [c, choice]])),
            `${at}: ${c.kind} ${c.path} → ${choice}`,
          ).toBe(true);
      if (result.conflicts.length > 1) multiple += 1;
      // Standing (main's own) entries resolve by themselves once the rest are:
      // any main-or-delete choice for the others leaves a valid tree.
      for (const other of ["main", "delete"] as const) {
        const picks = result.conflicts.map((c): [LogicalConflict, Choice] => [
          c,
          c.standing ? "main" : other,
        ]);
        expect(await valid(apply(result.tree, sides, picks)), `${at}: standing`).toBe(true);
      }
      // 2. Every combination of choices (random ones, plus all-main/all-mine/all-delete).
      const assignments: Choice[][] = [
        result.conflicts.map(() => "main"),
        result.conflicts.map(() => "mine"),
        result.conflicts.map(() => "delete"),
        ...Array.from({ length: 6 }, () => result.conflicts.map(() => CHOICES[random(3)]!)),
      ];
      for (const assignment of assignments) {
        const picks = result.conflicts.map((c, i): [LogicalConflict, Choice] => [
          c,
          assignment[i]!,
        ]);
        const final = apply(result.tree, sides, picks);
        if (!(await valid(final))) continue; // the caller's own clash between conflicts
        // In one request: the request rules admit it.
        expect(changePathsCollide(opsOf(sides, picks)), `${at}: one request`).toBe(false);
        // In progressive steps, in a random order: removals alone are always
        // valid steps, and any step the tree refuses joins the next one.
        const order = picks.slice().sort(() => random(3) - 1);
        let applied: [LogicalConflict, Choice][] = [];
        let carried: [LogicalConflict, Choice][] = [];
        for (const pick of order) {
          carried.push(pick);
          if (random(2) === 0 && pick !== order.at(-1)) continue;
          expect(changePathsCollide(opsOf(sides, carried)), `${at}: step`).toBe(false);
          const state = apply(result.tree, sides, [...applied, ...carried]);
          if (await valid(state)) {
            applied = [...applied, ...carried];
            carried = [];
          }
        }
        expect(carried, `${at}: steps end applied`).toEqual([]);
        // The resolved head merges into main with nothing left to resolve.
        const again = await mergeLogicalTrees({
          base: sides.main,
          main: sides.main,
          proposal: final,
          mergeText: noLineMerge,
          read,
        });
        expect(again.conflicts, at).toEqual([]);
      }
    }
    expect(withConflicts).toBeGreaterThanOrEqual(100);
    expect(multiple).toBeGreaterThanOrEqual(3);
  });

  it("property: progressive resolution interleaved with main moves never strands a recorded choice", async () => {
    const docPaths = ["a.md", "A.md", "b.md", "c.md", "d.md", "d.md/x.md", "e/f.md", "E/g.md"];
    const docBodies = ["one\n", id("k1"), id("k2"), id("k1", "other"), id("k2", "other")];
    const assetPaths = ["a.md", "A.md", "m/p.png", "e", "c.md"];
    let seed = 7;
    // The high bits: an LCG's low bits cycle quickly.
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n;
    };
    const mutate = (from: Spec): Spec => {
      const docs = { ...(from.docs ?? {}) };
      const assets = new Map((from.assets ?? []).map((e) => [e.path, e]));
      for (let i = 2 + random(4); i > 0; i -= 1) {
        const path = docPaths[random(docPaths.length)]!;
        const roll = random(4);
        if (roll === 0) delete docs[path];
        else if (roll === 1 && docs[path]) {
          // A rename: the same body (and id) moves to another path.
          const to = docPaths[random(docPaths.length)]!;
          docs[to] = docs[path]!;
          delete docs[path];
        } else docs[path] = docBodies[random(docBodies.length)]!;
      }
      for (let i = random(3); i > 0; i -= 1) {
        const path = assetPaths[random(assetPaths.length)]!;
        if (random(3) === 0) assets.delete(path);
        else assets.set(path, asset(path, random(4)));
      }
      return { docs, assets: [...assets.values()] };
    };
    const validFrom = async (from: Spec) => {
      for (;;) {
        const spec = mutate(from);
        if (await valid(await tree(spec))) return spec;
      }
    };
    const valueIn = (t: LogicalTree, c: LogicalConflict) =>
      c.kind === "document" ? t.documents.get(c.path) : t.assets.get(c.path);
    const withValue = (t: LogicalTree, c: LogicalConflict, value: unknown): LogicalTree => {
      const out: LogicalTree = {
        documents: new Map(t.documents),
        assets: new Map(t.assets),
        managed: t.managed,
      };
      const map = (c.kind === "document" ? out.documents : out.assets) as Map<string, unknown>;
      if (value) map.set(c.path, value);
      else map.delete(c.path);
      return out;
    };
    const without = (t: LogicalTree, cs: readonly LogicalConflict[]) =>
      cs.reduce((acc, c) => withValue(acc, c, undefined), t);
    let checked = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const base = await validFrom({});
      const [main, proposal] = [await validFrom(base), await validFrom(base)];
      const [mainTree, mine] = [await tree(main), await tree(proposal)];
      const first = await merge(base, main, proposal);
      if (first.conflicts.length === 0) continue;
      // Resolve a random part with random choices (kept only while valid).
      let head = first.tree;
      const left: LogicalConflict[] = [];
      for (const c of first.conflicts) {
        const pick = random(5);
        const value = pick === 0 ? valueIn(mainTree, c) : pick === 1 ? valueIn(mine, c) : null;
        const next = pick < 3 ? withValue(head, c, value ?? undefined) : null;
        if (next && (await valid(next))) head = next;
        else left.push(c);
      }
      if (left.length === 0) continue;
      // Main moves on (edits, renames, id changes); the PR moves onto it.
      const moved = await tree(await validFrom(main));
      const second = await mergeLogicalTrees({
        base: mainTree,
        main: moved,
        proposal: head,
        mergeText: noLineMerge,
        read,
        recorded: left.map((c) => {
          const saved = valueIn(mine, c);
          return { ...c, choices: saved ? [saved] : [] };
        }),
      });
      const at = `trial ${trial}`;
      expect(await valid(second.tree), at).toBe(true);
      // Every recorded conflict is still reported.
      for (const c of left)
        expect(
          second.conflicts.some((x) => x.kind === c.kind && x.path === c.path),
          `${at}: ${c.kind} ${c.path} kept`,
        ).toBe(true);
      // Every choice — main's, the PR head's, the saved one, deletion — is
      // valid against every unreported entry.
      const rest = without(second.tree, second.conflicts);
      for (const c of second.conflicts) {
        const saved = left.some((x) => x.kind === c.kind && x.path === c.path)
          ? valueIn(mine, c)
          : undefined;
        for (const value of [valueIn(moved, c), valueIn(head, c), saved, undefined]) {
          checked += 1;
          expect(await valid(withValue(rest, c, value)), `${at}: ${c.kind} ${c.path}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(100);
  });

  it("reports what a deleted conflict's restoration would collide with (document vs asset)", async () => {
    // Base A.md; main edits it; the proposal deletes it and adds asset a.md.
    const result = await merge(
      { docs: { "A.md": "base\n" } },
      { docs: { "A.md": "main\n" } },
      { docs: {}, assets: [asset("a.md", 1)] },
    );
    expect(result.conflicts).toEqual([
      { path: "A.md", kind: "document" },
      { path: "a.md", kind: "asset" },
    ]);
  });

  it("reports the main entry a proposal's choice would duplicate an id with", async () => {
    const result = await merge(
      {},
      { docs: { "c.md": id("k1") } },
      { docs: { "b.md": id("k1", "mine") } },
    );
    expect(result.conflicts).toEqual([
      { path: "b.md", kind: "document" },
      { path: "c.md", kind: "document", standing: true },
    ]);
  });
});

/**
 * The corpus kb-local's `logical_merge.rs` runs too (its `shared_corpus` test):
 * the same inputs must produce the same conflicts, tree and totals on both
 * sides, so the server and the local store can never drift.
 */
describe("shared logical-merge corpus (server and kb-local parity)", () => {
  type FixtureSpec = {
    docs?: Record<string, string>;
    assets?: AssetManifestEntry[];
    bulk?: number;
  };
  type FixtureCase = {
    name: string;
    base: FixtureSpec;
    main: FixtureSpec;
    proposal: FixtureSpec;
    lineMerges?: Record<string, string | null>;
    recorded?: {
      path: string;
      kind: "document" | "asset";
      standing?: true;
      choice: string | AssetManifestEntry | null;
    }[];
    expect: {
      conflicts: LogicalConflict[];
      documents: Record<string, string>;
      bulkDocuments?: number;
      assets: AssetManifestEntry[];
      totals: unknown;
    };
  };
  const corpus = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures/logical-merge-cases.json"),
      "utf8",
    ),
  ) as { gitignore: string; index: string; cases: FixtureCase[] };
  const fixtureTree = async (spec: FixtureSpec) => {
    const entries = new Map<string, { sha: string; size: number }>();
    const put = (path: string, text: string) =>
      entries.set(path, { sha: blob(text), size: Buffer.byteLength(text) });
    put(".gitignore", corpus.gitignore);
    put("index.md", corpus.index);
    for (let i = 0; i < (spec.bulk ?? 0); i += 1)
      put(`bulk/d${String(i).padStart(4, "0")}.md`, "x\n");
    for (const [path, text] of Object.entries(spec.docs ?? {})) put(path, text);
    entries.set(".assets/manifest.json", {
      sha: blob(canonicalManifestBytes({ version: 1, entries: spec.assets ?? [] })),
      size: canonicalManifestBytes({ version: 1, entries: spec.assets ?? [] }).length,
    });
    const logical = await logicalTreeOf(entries, read);
    if (!logical) throw new Error("fixture manifest");
    return logical;
  };
  it("has cases with and without conflicts", () => {
    expect(corpus.cases.filter((c) => c.expect.conflicts.length > 0).length).toBeGreaterThan(80);
    expect(corpus.cases.filter((c) => c.expect.conflicts.length === 0).length).toBeGreaterThan(5);
  });
  for (const fixture of corpus.cases)
    it(fixture.name, async () => {
      const result = await mergeLogicalTrees({
        base: await fixtureTree(fixture.base),
        main: await fixtureTree(fixture.main),
        proposal: await fixtureTree(fixture.proposal),
        read,
        recorded: (fixture.recorded ?? []).map((r) => ({
          path: r.path,
          kind: r.kind,
          ...(r.standing ? { standing: true as const } : {}),
          choices:
            r.choice === null
              ? []
              : typeof r.choice === "string"
                ? [{ sha: blob(r.choice), size: Buffer.byteLength(r.choice) }]
                : [r.choice],
        })),
        mergeTexts: async (items) =>
          new Map(
            items.map((item) => {
              const merged = fixture.lineMerges?.[item.path];
              return [item.path, typeof merged === "string" ? Buffer.from(merged) : null];
            }),
          ),
      });
      const documents: Record<string, string> = {};
      let bulk = 0;
      for (const [path, b] of result.tree.documents) {
        if (path.startsWith("bulk/")) bulk += 1;
        else if (path !== "index.md")
          documents[path] = (b.bytes ?? (await read(b.sha))).toString("utf8");
      }
      expect({
        conflicts: result.conflicts,
        documents,
        ...(bulk ? { bulkDocuments: bulk } : {}),
        assets: [...result.tree.assets.values()],
        totals: result.totals,
      }).toEqual(fixture.expect);
    });
});
