import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deletedScanCapped,
  parseDeletionLog,
  readDeletedDocuments,
  selectDeleted,
} from "./deleted-documents";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv } from "./git-read";
import { initialMainTreeFiles } from "./git-write";
import type { LockQuery } from "./lock";
import type { TreeFileInput } from "./staged-tree";

const file = (path: string, body: string): TreeFileInput => ({
  segments: path.split("/"),
  content: Buffer.from(`${body}\n`, "utf8"),
});

/** People, answered like `resolveActors`' bounded read. */
const actorsQuery = (() => async (sql: string) =>
  sql.includes('FROM "user"')
    ? { rows: [{ id: "u1", name: "Ana" }], rowCount: 1 }
    : { rows: [], rowCount: 0 }) as unknown as () => LockQuery;

describe("deleted documents", () => {
  let repo: string;
  const c: Record<string, string> = {};
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kb-deleted-docs-"));
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const base = initialMainTreeFiles("Deleted fixture");
    let time = 1_800_000_000;
    const commit = (name: string, parent: string, message: string, files: TreeFileInput[]) => {
      time += 60;
      c[name] = writeGitFixtureCommit(repo, {
        parentSha: parent,
        message,
        files: [...base, ...files],
        timestampSeconds: time,
      });
    };
    const web = "Acted-by: someone\nKb-Actor-Key: user:u1";
    commit("create", "0".repeat(40), "Create", [
      file("a.md", "a"),
      file("notes/b.md", "b"),
      file("notes/c.md", "c"),
      file("data.txt", "not a document"),
    ]);
    commit("dropA", c.create!, `Delete a.md\n\n${web}`, [
      file("notes/b.md", "b"),
      file("notes/c.md", "c"),
      file("data.txt", "not a document"),
    ]);
    // a.md comes back, then goes again: one row, at the later deletion.
    commit("backA", c.dropA!, "Recreate a.md", [
      file("a.md", "a again"),
      file("notes/b.md", "b"),
      file("notes/c.md", "c"),
      file("data.txt", "not a document"),
    ]);
    commit("dropMany", c.backA!, "Delete several (a Git push)", [file("notes/c.md", "c")]);
    // c.md is deleted, then recreated: main has it, so it is not listed.
    commit("dropC", c.dropMany!, `Delete c.md\n\n${web}`, []);
    commit("backC", c.dropC!, "Recreate c.md", [file("notes/c.md", "c2")]);
  }, 120_000);
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  /** An hour after the fixture's commits: all of them are in the window. */
  const NOW = (1_800_000_000 + 3600) * 1000;
  const SINCE = NOW / 1000 - 30 * 86_400;
  const read = (cursor: string | null, limit: number, headSha = c.backC!, now = NOW) =>
    readDeletedDocuments({ repoPath: repo, headSha, cursor, limit, query: actorsQuery(), now });

  it("lists each deleted document once, newest deletion first, with its last revision", async () => {
    const page = await read(null, 10);
    expect(page.nextCursor).toBeNull();
    expect(page).toMatchObject({ windowDays: 30, capped: false });
    expect(page.items).toEqual([
      {
        path: "a.md",
        deletedSha: c.dropMany,
        revision: c.backA,
        deletedAt: expect.any(String),
        actor: { kind: "unattributed", name: null, via: null },
      },
      {
        path: "notes/b.md",
        deletedSha: c.dropMany,
        revision: c.backA,
        deletedAt: expect.any(String),
        actor: { kind: "unattributed", name: null, via: null },
      },
    ]);
  });

  it("attributes a web deletion and keeps a document main no longer has", async () => {
    // At dropC, c.md is deleted (by Ana, in the web app) and not yet back.
    const page = await read(null, 10, c.dropC!);
    expect(page.items.map((row) => row.path)).toEqual(["notes/c.md", "a.md", "notes/b.md"]);
    expect(page.items[0]).toMatchObject({
      deletedSha: c.dropC,
      revision: c.dropMany,
      actor: { kind: "web", name: "Ana", via: null },
    });
  });

  it("pages from the pinned head without repeating a row", async () => {
    const first = await read(null, 1, c.dropC!);
    expect(first.items.map((row) => row.path)).toEqual(["notes/c.md"]);
    expect(first.nextCursor).toBe(`v2.${c.dropC}.${SINCE}.1`);
    // A later head (c.md recreated) does not shift the pinned pages.
    const second = await readDeletedDocuments({
      repoPath: repo,
      headSha: c.backC!,
      cursor: first.nextCursor,
      limit: 1,
      query: actorsQuery(),
      now: NOW + 60_000,
    });
    expect(second.items.map((row) => row.path)).toEqual(["a.md"]);
    const third = await read(second.nextCursor, 1);
    expect(third.items.map((row) => row.path)).toEqual(["notes/b.md"]);
    expect(third.nextCursor).toBeNull();
  });

  it("refuses a cursor whose head is not on main's history or is not canonical", async () => {
    await expect(read(`v2.${"f".repeat(40)}.${SINCE}.1`, 1)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(read(`v2.${c.backC}.${SINCE}.01`, 1)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(read(`v2.${c.backC}.${SINCE}.0`, 1)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    // The old format, and a window start the list never handed out.
    await expect(read(`v1.${c.backC}.1`, 1)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(read(`v2.${c.backC}.${SINCE - 2 * 86_400}.1`, 1)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(read(`v2.${c.backC}.0.1`, 1)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("lists only the last 30 days; an older deletion is still found by its path", async () => {
    // 30 days after dropMany (a.md, b.md), but within 30 days of dropC (c.md).
    const later = (1_800_000_000 + 4 * 60 + 30 * 86_400 + 30) * 1000;
    const page = await read(null, 10, c.dropC!, later);
    expect(page.items.map((row) => row.path)).toEqual(["notes/c.md"]);
    expect(page).toMatchObject({ nextCursor: null, windowDays: 30, capped: false });
    const own = await readDeletedDocuments({
      repoPath: repo,
      headSha: c.dropC!,
      cursor: null,
      limit: 1,
      query: actorsQuery(),
      now: later,
      path: "notes/b.md",
    });
    expect(own.items).toMatchObject([{ path: "notes/b.md", deletedSha: c.dropMany }]);
    expect(own.windowDays).toBeNull();
    // Long after everything: an empty window, not an error.
    const empty = await read(null, 10, c.dropC!, later + 60 * 86_400_000);
    expect(empty.items).toEqual([]);
  });

  it("lists a document a merge deleted, at the merge, with main's previous state", async () => {
    const base = initialMainTreeFiles("Deleted fixture");
    const at = (name: string, parent: string, files: TreeFileInput[]) =>
      writeGitFixtureCommit(repo, {
        parentSha: parent,
        message: name,
        files: [...base, ...files],
        timestampSeconds: 1_900_000_000,
      });
    const keep = file("notes/c.md", "c2");
    const mainX = at("Add x.md on main", c.backC!, [keep, file("x.md", "x")]);
    const branch = at("Branch work", c.backC!, [keep, file("y.md", "y")]);
    // The merge's tree drops x.md, which main had: a deletion only the merge makes.
    const tree = execFileSync(
      "git",
      ["rev-parse", `${at("tmp", c.backC!, [keep, file("y.md", "y")])}^{tree}`],
      {
        cwd: repo,
        env: hardenedGitEnv(),
        encoding: "utf8",
      },
    ).trim();
    const merge = execFileSync(
      "git",
      ["commit-tree", tree, "-p", mainX, "-p", branch, "-m", "Move the proposal onto main"],
      {
        cwd: repo,
        env: {
          ...hardenedGitEnv(),
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
          GIT_AUTHOR_DATE: "1900000100 +0000",
          GIT_COMMITTER_DATE: "1900000100 +0000",
        },
        encoding: "utf8",
      },
    ).trim();
    const page = await read(null, 10, merge);
    expect(page.items[0]).toMatchObject({ path: "x.md", deletedSha: merge, revision: mainX });
    // A document's own page asks for its path only: the same row.
    const own = (path: string) =>
      readDeletedDocuments({
        repoPath: repo,
        headSha: merge,
        cursor: null,
        limit: 1,
        query: actorsQuery(),
        path,
      });
    const mine = await own("x.md");
    expect(mine.items).toEqual([page.items[0]]);
    expect(mine.nextCursor).toBeNull();
    await expect(own("../x.md")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("finds a deletion in the window behind a commit with an older time", async () => {
    const base = initialMainTreeFiles("Deleted fixture");
    const keep = file("notes/c.md", "c2");
    const at = (message: string, parent: string, files: TreeFileInput[], time: number) =>
      writeGitFixtureCommit(repo, {
        parentSha: parent,
        message,
        files: [...base, ...files],
        timestampSeconds: time,
      });
    const recent = 1_800_000_000 + 86_400;
    const added = at("Add z.md", c.backC!, [keep, file("z.md", "z")], recent);
    const dropZ = at("Delete z.md", added, [keep], recent + 60);
    // A commit whose clock was 40 days behind, then newer work on top.
    const skewed = at("Skewed clock", dropZ, [keep, file("s.md", "s")], recent - 40 * 86_400);
    const head = at("Later", skewed, [keep, file("s.md", "s2")], recent + 120);
    const page = await read(null, 10, head, (recent + 3600) * 1000);
    expect(page.items.map((row) => row.path)).toEqual(["z.md", "a.md", "notes/b.md"]);
  });

  it("caps the rows, not the paths seen: recreated paths never hide a deleted one", async () => {
    const deletion = (path: string, n: number) => ({
      path,
      deletedSha: String(n).padStart(40, "0"),
      revision: String(n + 1).padStart(40, "0"),
      deletedAt: null,
    });
    // Three recreated paths come first, then the one still deleted.
    const deletions = [
      deletion("r1.md", 1),
      deletion("r2.md", 2),
      deletion("r1.md", 3),
      deletion("r3.md", 4),
      deletion("gone.md", 5),
      deletion("gone2.md", 6),
    ];
    const checked: string[][] = [];
    const present = async (paths: string[]) => {
      checked.push(paths);
      return new Set(paths.filter((path) => path.startsWith("r")));
    };
    const rows = await selectDeleted(deletions, present, { rowsMax: 1, checkMax: 10, chunk: 2 });
    expect(rows.map((row) => row.path)).toEqual(["gone.md"]);
    // Chunked checks stop once the rows are found.
    expect(checked).toEqual([
      ["r1.md", "r2.md"],
      ["r3.md", "gone.md"],
    ]);
    // Bounded work: at most `checkMax` distinct paths are checked.
    const bounded = await selectDeleted(deletions, present, { rowsMax: 5, checkMax: 3, chunk: 2 });
    expect(bounded).toEqual([]);
  });

  it("parses only exact headers and skips names no page could open", () => {
    const sha = "1".repeat(40);
    const parent = "2".repeat(40);
    const log = [
      `\x1e${sha} ${parent} 1800000000`,
      "\nD",
      "ok.md",
      "D",
      "../escape.md",
      "D",
      "data.txt",
      "D",
      ".assets/manifest.json",
      // An exact rename: a "moved away" marker for its old name, not a deletion.
      "R100",
      "old.md",
      "new.md",
      "",
      // A merge (two parents): its diff is against the first parent.
      `\x1e${"3".repeat(40)} ${parent} ${sha} 1800000060`,
      "\nD",
      "merged.md",
      "",
      // A root commit deletes nothing.
      `\x1e${"4".repeat(40)} 1800000120`,
      "\nD",
      "root.md",
      "",
    ].join("\0");
    expect(parseDeletionLog(log)).toEqual([
      { path: "ok.md", deletedSha: sha, revision: parent, deletedAt: expect.any(String) },
      {
        path: "old.md",
        deletedSha: sha,
        revision: parent,
        deletedAt: expect.any(String),
        moved: true,
      },
      {
        path: "merged.md",
        deletedSha: "3".repeat(40),
        revision: parent,
        deletedAt: expect.any(String),
      },
    ]);
    expect(() => parseDeletionLog("\x1enot a header\0")).toThrow("invalid deletion log header");
  });
});

describe("a rename is not a deletion", () => {
  let repo: string;
  const c: Record<string, string> = {};
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kb-deleted-moves-"));
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const base = initialMainTreeFiles("Move fixture");
    let time = 1_800_000_000;
    const commit = (name: string, parent: string, message: string, files: TreeFileInput[]) => {
      time += 60;
      c[name] = writeGitFixtureCommit(repo, {
        parentSha: parent,
        message,
        files: [...base, ...files],
        timestampSeconds: time,
      });
    };
    const long = "line\n".repeat(40);
    commit("create", "0".repeat(40), "Create", [
      file("notes/a.md", `# A\n${long}`),
      file("notes/c.md", `# C\n${long}`),
      file("notes/e.md", `# E0\n${long}`),
      file("notes/g.md", `# G0\n${long}`),
    ]);
    // One commit: a.md moves (same bytes, the web move), c.md is deleted while
    // a similar but different d.md is added: c.md is still a deletion.
    commit("move", c.create!, "Move notes/a.md to archive/b.md", [
      file("archive/b.md", `# A\n${long}`),
      file("notes/d.md", `# D\n${long}`),
      file("notes/e.md", `# E0\n${long}`),
      file("notes/g.md", `# G0\n${long}`),
    ]);
    // e.md is deleted, recreated, then renamed away: it lives on as f.md.
    commit("eDrop", c.move!, "Delete notes/e.md", [
      file("archive/b.md", `# A\n${long}`),
      file("notes/d.md", `# D\n${long}`),
      file("notes/g.md", `# G0\n${long}`),
    ]);
    commit("eBack", c.eDrop!, "Recreate notes/e.md", [
      file("archive/b.md", `# A\n${long}`),
      file("notes/d.md", `# D\n${long}`),
      file("notes/e.md", `# E\n${long}`),
      file("notes/g.md", `# G0\n${long}`),
    ]);
    commit("eMove", c.eBack!, "Move notes/e.md to notes/f.md", [
      file("archive/b.md", `# A\n${long}`),
      file("notes/d.md", `# D\n${long}`),
      file("notes/f.md", `# E\n${long}`),
      file("notes/g.md", `# G0\n${long}`),
    ]);
    // g.md: deleted (recent), recreated, then renamed in a commit whose own
    // time is long before the window (a pushed commit's clock): still hidden.
    const keep = [
      file("archive/b.md", `# A\n${long}`),
      file("notes/d.md", `# D\n${long}`),
      file("notes/f.md", `# E\n${long}`),
    ];
    commit("gDrop", c.eMove!, "Delete notes/g.md", keep);
    commit("gBack", c.gDrop!, "Recreate notes/g.md", [...keep, file("notes/g.md", `# G\n${long}`)]);
    c.gMove = writeGitFixtureCommit(repo, {
      parentSha: c.gBack!,
      message: "Move notes/g.md to notes/h.md",
      files: [...base, ...keep, file("notes/h.md", `# G\n${long}`)],
      timestampSeconds: 1_700_000_000,
    });
    // k.md: deleted (recent), recreated, then deleted again by a backdated
    // commit: its latest deletion is the backdated one, outside the window.
    const keep2 = [...keep, file("notes/h.md", `# G\n${long}`)];
    commit("kAdd", c.gMove!, "Add notes/k.md", [...keep2, file("notes/k.md", `# K0\n${long}`)]);
    commit("kDrop", c.kAdd!, "Delete notes/k.md", keep2);
    commit("kBack", c.kDrop!, "Recreate notes/k.md", [
      ...keep2,
      file("notes/k.md", `# K1\n${long}`),
    ]);
    c.kDropOld = writeGitFixtureCommit(repo, {
      parentSha: c.kBack!,
      message: "Delete notes/k.md (backdated)",
      files: [...base, ...keep2],
      timestampSeconds: 1_700_000_100,
    });
  }, 120_000);
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });
  const NOW = (1_800_000_000 + 3600) * 1000;
  const read = (path?: string) =>
    readDeletedDocuments({
      repoPath: repo,
      headSha: c.kDropOld!,
      cursor: null,
      limit: 10,
      query: actorsQuery(),
      now: NOW,
      ...(path === undefined ? {} : { path }),
    });

  it("reports a possibly incomplete list whenever a bound is reached, whatever the commit times", () => {
    expect(deletedScanCapped(999, 0)).toBe(false);
    expect(deletedScanCapped(1000, 0)).toBe(true);
    expect(deletedScanCapped(10, 10_000)).toBe(true);
  });

  it("lists the deleted document but not the moved ones", async () => {
    // e.md's and g.md's older deletions are not shown: each was recreated and
    // then moved (g.md's move carries a commit time long before the window).
    // k.md's latest deletion is backdated outside the window: its older,
    // in-window deletion (a stale revision) is not listed either.
    const page = await read();
    expect(page.items.map((row) => row.path)).toEqual(["notes/c.md"]);
    expect(page.capped).toBe(false);
  });

  it("finds no deletion for a moved path, and still finds a real one, by path", async () => {
    expect((await read("notes/a.md")).items).toEqual([]);
    expect((await read("notes/e.md")).items).toEqual([]);
    expect((await read("notes/g.md")).items).toEqual([]);
    // By path (no window): k.md's latest deletion, the backdated one.
    expect((await read("notes/k.md")).items).toMatchObject([
      { path: "notes/k.md", deletedSha: c.kDropOld, revision: c.kBack },
    ]);
    expect((await read("notes/c.md")).items).toMatchObject([
      { path: "notes/c.md", deletedSha: c.move, revision: c.create },
    ]);
  });
});
