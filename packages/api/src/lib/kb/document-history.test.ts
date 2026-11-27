import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  commitSubjectLine,
  FOLLOWED_LOG_ROW_MAX_BYTES,
  followedLogMaxBytes,
  historyActor,
  parseFollowedLog,
  prFileAttribution,
  readBlobProvenance,
  readCommitMessagesAsync,
  readDocumentHistory,
} from "./document-history";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv } from "./git-read";
import { initialMainTreeFiles } from "./git-write";
import type { LockQuery } from "./lock";
import type { TreeFileInput } from "./staged-tree";

const GRANT = "00000000-0000-4000-8000-0000000000aa";
const block = (actorKey: string, provenance?: string) =>
  [
    "Acted-by: someone",
    `Kb-Actor-Key: ${actorKey}`,
    ...(provenance ? [`Kb-Provenance: ${provenance}`] : []),
  ].join("\n");
const doc = (provenance: string | null, body: string): TreeFileInput => ({
  segments: ["notes", "a.md"],
  content: Buffer.from(
    provenance ? `---\nprovenance: ${provenance}\n---\n${body}\n` : `${body}\n`,
    "utf8",
  ),
});
const other = (body: string): TreeFileInput => ({
  segments: ["notes", "b.md"],
  content: Buffer.from(`---\nprovenance: agent\n---\n${body}\n`, "utf8"),
});

/** People and credentials, answered like `resolveActors`' two bounded reads. */
function actorsQuery(): LockQuery & { calls: string[] } {
  const calls: string[] = [];
  const query = (async (sql: string) => {
    calls.push(sql);
    if (sql.includes('FROM "user"')) return { rows: [{ id: "u1", name: "Ana" }], rowCount: 1 };
    return {
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
    };
  }) as LockQuery & { calls: string[] };
  query.calls = calls;
  return query;
}

describe("document history and PR attribution", () => {
  let repo: string;
  const c: Record<string, string> = {};
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kb-doc-history-"));
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const base = initialMainTreeFiles("History fixture");
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
    commit("create", "0".repeat(40), `Create a\n\n${block("user:u1", "human")}`, [
      doc("human", "one"),
    ]);
    commit("agent", c.create!, `Agent edit\n\n${block(`grant:${GRANT}`, "agent")}`, [
      doc("agent", "two"),
    ]);
    commit("other", c.agent!, `Other file\n\n${block(`grant:${GRANT}`, "agent")}`, [
      doc("agent", "two"),
      other("b"),
    ]);
    // A Git push: no server block, even though it looks like one in its body.
    commit("push", c.other!, "Pushed edit\n\nKb-Actor-Key: not-a-key", [
      doc("agent", "three"),
      other("b"),
    ]);
    commit("delete", c.push!, `Delete a\n\n${block("user:u1")}`, [other("b")]);
    commit("later", c.delete!, `Recreate a\n\n${block("user:u1", "human")}`, [
      doc("human", "again"),
      other("b"),
    ]);
  }, 120_000);
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const history = (cursor: string | null, limit: number, query = actorsQuery()) =>
    readDocumentHistory({
      repoPath: repo,
      headSha: c.delete!,
      path: "notes/a.md",
      cursor,
      limit,
      query,
    });

  it("pages the path's history newest first with provenance and trusted attribution", async () => {
    const first = await history(null, 2);
    expect(first.items.map((row) => row.sha)).toEqual([c.delete, c.push]);
    expect(first.items[0]).toMatchObject({
      subject: "Delete a",
      deleted: true,
      provenance: null,
      actor: { kind: "web", name: "Ana", via: null },
    });
    // A Git push carries no server block: unattributed, never the text it claims.
    expect(first.items[1]).toMatchObject({
      subject: "Pushed edit",
      deleted: false,
      provenance: "agent",
      actor: { kind: "unattributed", name: null, via: null },
    });
    expect(first.nextCursor).toBe(`v1.${c.delete}.2`);

    const second = await history(first.nextCursor, 2);
    // The unrelated commit touching only b.md is not part of a.md's history.
    expect(second.items.map((row) => row.sha)).toEqual([c.agent, c.create]);
    expect(second.items[0]).toMatchObject({
      provenance: "agent",
      actor: { kind: "credential", name: "Ana", via: "laptop" },
    });
    expect(second.items[1]).toMatchObject({
      provenance: "human",
      actor: { kind: "web", name: "Ana" },
    });
    expect(second.nextCursor).toBeNull();
    expect(new Date(second.items[1]!.committedAt).getTime()).toBe(1_800_000_060_000);
  });

  it("past the oldest row there is nothing older", async () => {
    await expect(history(`v1.${c.delete}.4`, 5)).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("keeps paging from the pinned head after main moves on", async () => {
    const first = await history(null, 2);
    // Main gains a newer commit; the next page still continues the first one.
    const second = await readDocumentHistory({
      repoPath: repo,
      headSha: c.later!,
      path: "notes/a.md",
      cursor: first.nextCursor,
      limit: 2,
      query: actorsQuery(),
    });
    expect(second.items.map((row) => row.sha)).toEqual([c.agent, c.create]);
  });

  it("refuses malformed cursors and a head that is not on main's history, and a malformed path", async () => {
    for (const cursor of [
      `v1.${"f".repeat(40)}.2`,
      "nope",
      c.push!,
      `v1.${c.delete}.0`,
      `v1.${c.delete}.02`,
      `v1.${c.delete}.10001`,
      `v1.${c.delete}.2.3`,
      `v1.${c.delete!.toUpperCase()}.2`,
      ` v1.${c.delete}.2`,
    ])
      await expect(history(cursor, 5), cursor).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    // A newer commit than the head being read is not on its history.
    await expect(
      readDocumentHistory({
        repoPath: repo,
        headSha: c.push!,
        path: "notes/a.md",
        cursor: `v1.${c.delete}.1`,
        limit: 5,
        query: actorsQuery(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      readDocumentHistory({
        repoPath: repo,
        headSha: c.delete!,
        path: "/etc/passwd",
        cursor: null,
        limit: 5,
        query: actorsQuery(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("bounds a page to 50 rows whatever limit it is asked for", async () => {
    const page = await history(null, 10_000);
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(page.items).toHaveLength(4);
  });

  it("never resolves actors for unattributed commits", async () => {
    const query = actorsQuery();
    const spy = vi.fn(query);
    await readDocumentHistory({
      repoPath: repo,
      headSha: c.push!,
      path: "notes/a.md",
      cursor: null,
      limit: 1,
      query: spy as unknown as LockQuery,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads commit messages by declared size", async () => {
    const messages = await readCommitMessagesAsync(repo, [c.push!, c.agent!], {});
    expect(messages.get(c.push!)).toBe("Pushed edit\n\nKb-Actor-Key: not-a-key\n");
    expect(messages.get(c.agent!)).toContain(`Kb-Actor-Key: grant:${GRANT}`);
  });

  it("gives each Markdown PR file both labels and the writer of its newest change", async () => {
    const blob = (commit: string, path: string) =>
      execFileSync("git", ["rev-parse", `${commit}:${path}`], {
        cwd: repo,
        env: hardenedGitEnv(),
        encoding: "utf8",
      }).trim();
    const result = await prFileAttribution({
      repoPath: repo,
      baseSha: c.create!,
      headSha: c.push!,
      files: [
        {
          path: "notes/a.md",
          beforeBlobSha: blob(c.create!, "notes/a.md"),
          afterBlobSha: blob(c.push!, "notes/a.md"),
        },
        { path: "notes/b.md", beforeBlobSha: null, afterBlobSha: blob(c.push!, "notes/b.md") },
        { path: "media/x.png", beforeBlobSha: null, afterBlobSha: blob(c.push!, "notes/b.md") },
      ],
      query: actorsQuery(),
    });
    expect(result.get("notes/a.md")).toEqual({
      beforeProvenance: "human",
      afterProvenance: "agent",
      // The newest change in the range was a Git push.
      writtenBy: { kind: "unattributed", name: null, via: null },
    });
    expect(result.get("notes/b.md")).toEqual({
      beforeProvenance: null,
      afterProvenance: "agent",
      writtenBy: { kind: "credential", name: "Ana", via: "laptop" },
    });
    expect(result.has("media/x.png")).toBe(false);
  });

  it("formats subjects as one bounded line and derives web vs credential from the key", () => {
    expect(commitSubjectLine("a\u0007b\r\nrest")).toBe("a b");
    expect(Array.from(commitSubjectLine("x".repeat(500)))).toHaveLength(200);
    const actors = new Map([[`grant:${GRANT}`, { userId: "u1", name: "Ana", via: "web" }]]);
    // A token named "web" is still a credential.
    expect(historyActor(`t\n\nKb-Actor-Key: grant:${GRANT}`, actors)).toEqual({
      kind: "credential",
      name: "Ana",
      via: "web",
    });
    expect(historyActor("t\n\nKb-Actor-Key: user:u9", new Map())).toEqual({
      kind: "web",
      name: null,
      via: null,
    });
    expect(historyActor("plain message", actors).kind).toBe("unattributed");
  });
});

describe("document identity in deleted history", () => {
  it.each([
    ["similar retained source", "# E5E two\n\nSecond doc.\n", "# gone\n\nto delete\n", true],
    ["identical retained source", "# Same\n\nDocument.\n", "# Same\n\nDocument.\n", true],
    ["similar removed source", "# Shared\n\nold\n", "# Shared\n\nnew\n", false],
    ["exact rename", "# Same\n\nDocument.\n", "# Same\n\nDocument.\n", false],
  ])("keeps %s lineage correct across pages", async (_, source, target, retained) => {
    const repo = mkdtempSync(join(tmpdir(), "kb-doc-history-identity-"));
    try {
      execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
      const base = initialMainTreeFiles("Identity fixture");
      const file = (name: string, body: string): TreeFileInput => ({
        segments: ["notes", name],
        content: Buffer.from(`---\nprovenance: human\n---\n${body}`),
      });
      let time = 1_800_200_000;
      const commit = (parentSha: string, message: string, files: TreeFileInput[]) =>
        writeGitFixtureCommit(repo, {
          parentSha,
          message,
          files: [...base, ...files],
          timestampSeconds: time++,
        });
      const original = commit("0".repeat(40), "Create source", [file("source.md", source)]);
      const created = commit(original, "Create target", [
        ...(retained ? [file("source.md", source)] : []),
        file("target.md", target),
      ]);
      const deleted = commit(created, "Delete target", retained ? [file("source.md", source)] : []);
      const expected = [
        [deleted, "notes/target.md", true],
        [created, "notes/target.md", false],
        ...(!retained && source === target ? [[original, "notes/source.md", false]] : []),
      ];
      for (const limit of [1, 2, 10]) {
        let cursor: string | null = null;
        const seen: unknown[] = [];
        for (let pages = 0; pages < 5; pages += 1) {
          const page = await readDocumentHistory({
            repoPath: repo,
            headSha: deleted,
            path: "notes/target.md",
            cursor,
            limit,
            query: actorsQuery(),
          });
          seen.push(...page.items.map((row) => [row.sha, row.path, row.deleted]));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        expect(cursor).toBeNull();
        expect(seen, `limit ${limit}`).toEqual(expected);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("history across a rename", () => {
  let repo: string;
  const c: Record<string, string> = {};
  const at = (segments: string[], provenance: string, body: string): TreeFileInput => ({
    segments,
    content: Buffer.from(`---\nprovenance: ${provenance}\n---\n${body}\n`, "utf8"),
  });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kb-doc-history-move-"));
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const base = initialMainTreeFiles("Move fixture");
    let time = 1_800_100_000;
    const commit = (name: string, parent: string, message: string, files: TreeFileInput[]) => {
      time += 60;
      c[name] = writeGitFixtureCommit(repo, {
        parentSha: parent,
        message,
        files: [...base, ...files],
        timestampSeconds: time,
      });
    };
    commit("create", "0".repeat(40), `Create a\n\n${block("user:u1", "human")}`, [
      at(["notes", "a.md"], "agent", "one"),
    ]);
    commit("edit", c.create!, `Edit a\n\n${block("user:u1", "human")}`, [
      at(["notes", "a.md"], "agent", "one two"),
    ]);
    // The web move: same bytes at the new path, one commit.
    commit("move", c.edit!, `Move notes/a.md to archive/b.md\n\n${block("user:u1")}`, [
      at(["archive", "b.md"], "agent", "one two"),
    ]);
    commit("after", c.move!, `Edit b\n\n${block("user:u1", "human")}`, [
      at(["archive", "b.md"], "human", "one two three"),
    ]);
  }, 120_000);
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });
  const history = (cursor: string | null, limit: number) =>
    readDocumentHistory({
      repoPath: repo,
      headSha: c.after!,
      path: "archive/b.md",
      cursor,
      limit,
      query: actorsQuery(),
    });

  it("follows the document past its move, each row at the path it had then", async () => {
    const all = await history(null, 10);
    expect(all.items.map((row) => [row.sha, row.path, row.deleted, row.provenance])).toEqual([
      [c.after, "archive/b.md", false, "human"],
      [c.move, "archive/b.md", false, "agent"],
      [c.edit, "notes/a.md", false, "agent"],
      [c.create, "notes/a.md", false, "agent"],
    ]);
  });

  it("pages across the move with every row once and the right paths", async () => {
    const first = await history(null, 2);
    expect(first.items.map((row) => row.path)).toEqual(["archive/b.md", "archive/b.md"]);
    const second = await history(first.nextCursor, 2);
    expect(second.items.map((row) => [row.sha, row.path])).toEqual([
      [c.edit, "notes/a.md"],
      [c.create, "notes/a.md"],
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("parses rename, plain and status-less rows of the followed log", () => {
    const sha = (n: number) => String(n).repeat(40);
    const out = [
      `\0${sha(1)} 100\0\nM\0x/b.md\0`,
      `\0${sha(2)} 99\0\nR100\0a.md\0x/b.md\0`,
      `\0${sha(3)} 98\0`,
      `\0${sha(4)} 97\0\nA\0a.md\0`,
    ].join("");
    expect(parseFollowedLog(out, "x/b.md").map((row) => row.path)).toEqual([
      "x/b.md",
      "x/b.md",
      "a.md",
      "a.md",
    ]);
    expect(() => parseFollowedLog("\0nonsense 1\0", "a.md")).toThrow();
  });

  it("sizes the log buffer for the deepest page of worst-case rename rows", () => {
    // Two 512-byte paths (the path limit), the widest time and a rename status.
    const longPath = (c: string) => `${c.repeat(509)}.md`;
    const row = `\0${"f".repeat(40)} ${"9".repeat(20)}\0\nR100\0${longPath("a")}\0${longPath("b")}\0`;
    expect(Buffer.byteLength(row)).toBeLessThanOrEqual(FOLLOWED_LOG_ROW_MAX_BYTES);
    // The deepest page reads offset 10 000 plus one page of 50 and one extra row.
    const rows = 10_000 + 51;
    expect(followedLogMaxBytes(rows)).toBeGreaterThanOrEqual(rows * Buffer.byteLength(row));
    expect(followedLogMaxBytes(rows)).toBeGreaterThan(8 * 1024 * 1024);
    expect(followedLogMaxBytes(1)).toBe(8 * 1024 * 1024);
    // Each rename row is at its new name.
    expect(parseFollowedLog(row.repeat(3), longPath("b")).map((r) => r.path)).toEqual([
      longPath("b"),
      longPath("b"),
      longPath("b"),
    ]);
  });
});

describe("merge commits in attribution", () => {
  let repo: string;
  const c: Record<string, string> = {};
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...hardenedGitEnv(),
        GIT_AUTHOR_DATE: "2027-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2027-01-01T00:00:00Z",
      },
      encoding: "utf8",
    }).trim();
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kb-doc-history-merge-"));
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const base = initialMainTreeFiles("Merge history fixture");
    let time = 1_800_000_000;
    const commit = (parent: string, message: string, files: TreeFileInput[]) => {
      time += 60;
      return writeGitFixtureCommit(repo, {
        parentSha: parent,
        message,
        files: [...base, ...files],
        timestampSeconds: time,
      });
    };
    c.create = commit("0".repeat(40), `Create a\n\n${block("user:u1", "human")}`, [
      doc("human", "one"),
    ]);
    // The PR: a credential's edit of a.md (and b.md) from the older main.
    c.pr = commit(c.create, `Agent edit\n\n${block(`grant:${GRANT}`, "agent")}`, [
      doc("agent", "two"),
      other("b"),
    ]);
    // Main moved on: a person edited a.md too.
    c.main = commit(c.create, `Person edit\n\n${block("user:u1", "human")}`, [
      doc("human", "main"),
    ]);
    // The PR moved onto main (main first, the old head second) with a person's
    // resolution of a.md that matches neither parent; b.md is the PR's own.
    const resolvedTree = git([
      "rev-parse",
      `${commit(c.main, "tree only", [doc("human", "resolved"), other("b")])}^{tree}`,
    ]);
    c.move = git([
      "commit-tree",
      resolvedTree,
      "-p",
      c.main,
      "-p",
      c.pr,
      "-m",
      `Update onto main\n\n${block("user:u1", "human")}`,
    ]);
  }, 120_000);
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });
  const blob = (commit: string, path: string) => git(["rev-parse", `${commit}:${path}`]);

  it("credits a move commit's own resolution to its writer, not the older edit", async () => {
    const result = await prFileAttribution({
      repoPath: repo,
      baseSha: c.main!,
      headSha: c.move!,
      files: [
        {
          path: "notes/a.md",
          beforeBlobSha: blob(c.main!, "notes/a.md"),
          afterBlobSha: blob(c.move!, "notes/a.md"),
        },
        { path: "notes/b.md", beforeBlobSha: null, afterBlobSha: blob(c.move!, "notes/b.md") },
      ],
      query: actorsQuery(),
    });
    expect(result.get("notes/a.md")).toEqual({
      beforeProvenance: "human",
      afterProvenance: "human",
      writtenBy: { kind: "web", name: "Ana", via: null },
    });
    // Taken unchanged from the old head: still the credential's edit.
    expect(result.get("notes/b.md")).toEqual({
      beforeProvenance: null,
      afterProvenance: "agent",
      writtenBy: { kind: "credential", name: "Ana", via: "laptop" },
    });
  });

  it("lists a merge that wrote the path in the path's history", async () => {
    const page = await readDocumentHistory({
      repoPath: repo,
      headSha: c.move!,
      path: "notes/a.md",
      cursor: null,
      limit: 10,
      query: actorsQuery(),
    });
    expect(page.items[0]).toMatchObject({
      sha: c.move,
      subject: "Update onto main",
      provenance: "human",
      actor: { kind: "web", name: "Ana" },
    });
    expect(page.items.map((row) => row.sha)).toEqual(
      expect.arrayContaining([c.move, c.main, c.pr, c.create]),
    );
  });

  it("pages across a merge whose parents both changed the path, every commit exactly once", async () => {
    for (const limit of [1, 2]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 10; pages += 1) {
        const page: Awaited<ReturnType<typeof readDocumentHistory>> = await readDocumentHistory({
          repoPath: repo,
          headSha: c.move!,
          path: "notes/a.md",
          cursor,
          limit,
          query: actorsQuery(),
        });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items.map((row) => row.sha));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(cursor, `limit ${limit}`).toBeNull();
      expect(seen[0]).toBe(c.move);
      expect([...seen].sort(), `limit ${limit}`).toEqual(
        [c.move!, c.main!, c.pr!, c.create!].sort(),
      );
    }
  });
});

describe("pushed commit timestamps", () => {
  it("shows a timestamp outside JavaScript's date range as unknown instead of failing the page", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kb-doc-history-far-"));
    try {
      execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
      const head = writeGitFixtureCommit(repo, {
        parentSha: "0".repeat(40),
        message: "Far future",
        files: [...initialMainTreeFiles("Far"), doc("agent", "far")],
        // Valid for Git, beyond JavaScript's Date range (a pusher chooses it).
        timestampSeconds: 10_000_000_000_000,
      });
      const page = await readDocumentHistory({
        repoPath: repo,
        headSha: head,
        path: "notes/a.md",
        cursor: null,
        limit: 5,
        query: actorsQuery(),
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.committedAt).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("provenance read budget", () => {
  it("leaves a blob it does not read unknown, never a false absent label", async () => {
    // Declared larger than any Markdown read: skipped before Git is asked for it.
    const labels = await readBlobProvenance(
      "/nonexistent",
      [{ sha: "a".repeat(40), size: 64 * 1024 * 1024 }],
      {},
    );
    expect(labels.has("a".repeat(40))).toBe(false);
  });
});

describe("large pushed commit messages", () => {
  it("never overflows a read: oversized messages are unattributed, small ones still read", async () => {
    const repo = mkdtempSync(join(tmpdir(), "kb-doc-history-big-"));
    try {
      execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
      let head = "0".repeat(40);
      const files = initialMainTreeFiles("Big");
      // Twenty 1 MiB messages: more than one read's buffer together.
      for (let i = 0; i < 20; i += 1)
        head = writeGitFixtureCommit(repo, {
          parentSha: head,
          message: `Big ${i}\n\n${"x".repeat(1024 * 1024)}\n`,
          files: [...files, doc("agent", `v${i}`)],
          timestampSeconds: 1_800_000_000 + 60 * i,
        });
      head = writeGitFixtureCommit(repo, {
        parentSha: head,
        message: `Small\n\n${block(`grant:${GRANT}`, "agent")}`,
        files: [...files, doc("agent", "last")],
        timestampSeconds: 1_800_000_000 + 60 * 20,
      });
      const page = await readDocumentHistory({
        repoPath: repo,
        headSha: head,
        path: "notes/a.md",
        cursor: null,
        limit: 50,
        query: actorsQuery(),
      });
      expect(page.items).toHaveLength(21);
      expect(page.items[0]!.subject).toBe("Small");
      expect(page.items[0]!.actor.kind).toBe("credential");
      expect(page.items.slice(1).every((row) => row.actor.kind === "unattributed")).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);
});
