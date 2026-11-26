import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv } from "./git-read";
import { initialMainTreeFiles } from "./git-write";
import type { LockQuery } from "./lock";
import { parseNameStatus, readRecentChanges } from "./recent-changes";
import type { TreeFileInput } from "./staged-tree";

const GRANT = "00000000-0000-4000-8000-0000000000aa";
const block = (actorKey: string) => ["Acted-by: someone", `Kb-Actor-Key: ${actorKey}`].join("\n");
const file = (path: string, body: string): TreeFileInput => ({
  segments: path.split("/"),
  content: Buffer.from(`${body}\n`, "utf8"),
});

/** People and credentials, answered like `resolveActors`' two bounded reads. */
const actorsQuery = (() => async (sql: string) =>
  sql.includes('FROM "user"')
    ? { rows: [{ id: "u1", name: "Ana" }], rowCount: 1 }
    : {
        rows: [
          {
            id: GRANT,
            userId: "u1",
            userName: "Ana",
            tokenName: "laptop",
            clientName: null,
            clientId: "pat",
          },
        ],
        rowCount: 1,
      }) as unknown as () => LockQuery;

describe("recent changes", () => {
  let repo: string;
  const c: Record<string, string> = {};
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kb-recent-changes-"));
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const base = initialMainTreeFiles("Recent fixture");
    let time = 1_800_000_000;
    const long = "a body long enough for rename detection to pair the two paths\n".repeat(8);
    const commit = (name: string, parent: string, message: string, files: TreeFileInput[]) => {
      time += 60;
      c[name] = writeGitFixtureCommit(repo, {
        parentSha: parent,
        message,
        files: [...base, ...files],
        timestampSeconds: time,
      });
    };
    commit("create", "0".repeat(40), `Create\n\n${block("user:u1")}`, [
      file("a.md", long),
      file("notes/b.md", "b"),
    ]);
    commit("agent", c.create!, `Agent edit\n\n${block(`grant:${GRANT}`)}`, [
      file("a.md", `${long}more`),
      file("notes/b.md", "b"),
    ]);
    commit("move", c.agent!, `Rename a.md\n\n${block("user:u1")}`, [
      file("moved/a.md", `${long}more`),
      file("notes/b.md", "b"),
    ]);
    // Not a document change: left out of the feed.
    commit("text", c.move!, `Notes\n\n${block("user:u1")}`, [
      file("moved/a.md", `${long}more`),
      file("notes/b.md", "b"),
      file("notes.txt", "t"),
    ]);
    // A Git push: no trusted server block, even though its body imitates one.
    commit("push", c.text!, "Pushed\n\nKb-Actor-Key: not-a-key", [
      file("moved/a.md", `${long}more`),
      file("notes.txt", "t"),
      file("c.md", "c"),
    ]);
  }, 120_000);
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const read = (cursor: string | null, limit: number, headSha = c.push!) =>
    readRecentChanges({ repoPath: repo, headSha, cursor, limit, query: actorsQuery() });

  it("lists document commits newest first with attribution and changes", async () => {
    const page = await read(null, 10);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((row) => row.sha)).toEqual([c.push, c.move, c.agent, c.create]);
    const [push, move, agent, create] = page.items;
    expect(push).toMatchObject({
      subject: "Pushed",
      actor: { kind: "unknown", label: null, via: null },
      morePaths: 0,
      pathsUnknown: false,
    });
    expect(push!.paths).toEqual(
      expect.arrayContaining([
        { path: "c.md", change: "added" },
        { path: "notes/b.md", change: "deleted" },
      ]),
    );
    expect(push!.paths).toHaveLength(2);
    expect(move).toMatchObject({
      actor: { kind: "human", label: "Ana" },
      paths: [{ path: "moved/a.md", change: "renamed", from: "a.md" }],
    });
    expect(agent).toMatchObject({
      actor: { kind: "agent", label: "Ana", via: "laptop" },
      paths: [{ path: "a.md", change: "modified" }],
    });
    expect(create!.actor.kind).toBe("human");
    expect(create!.paths).toEqual(
      expect.arrayContaining([
        { path: "a.md", change: "added" },
        { path: "notes/b.md", change: "added" },
        { path: "index.md", change: "added" },
      ]),
    );
    expect(create!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("pages from the pinned head without repeating rows", async () => {
    const first = await read(null, 2);
    expect(first.items.map((row) => row.sha)).toEqual([c.push, c.move]);
    expect(first.nextCursor).toBe(`v1.${c.push}.2`);
    const second = await read(first.nextCursor, 2);
    expect(second.items.map((row) => row.sha)).toEqual([c.agent, c.create]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a cursor that is malformed or not on main's history", async () => {
    await expect(read("v1.nope.2", 2)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(read(`v1.${"f".repeat(40)}.2`, 2)).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(read(`v1.${c.push}.99999`, 2)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("keeps only document paths in a name-status listing", () => {
    expect(
      parseNameStatus(
        [
          "M",
          "a.md",
          "A",
          "x.txt",
          "R100",
          "old.md",
          "new.md",
          "R090",
          "doc.md",
          "doc.txt",
          "R095",
          "doc.txt",
          "doc2.md",
          "D",
          ".assets/x.md",
          "C100",
          "a.md",
          "copy.md",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      { path: "a.md", change: "modified" },
      { path: "new.md", change: "renamed", from: "old.md" },
      { path: "doc.md", change: "deleted" },
      { path: "doc2.md", change: "added" },
      { path: "copy.md", change: "added" },
    ]);
    expect(() => parseNameStatus("Q\0a.md\0")).toThrow();
  });
});
