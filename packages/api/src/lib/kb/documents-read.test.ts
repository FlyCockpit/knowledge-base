import { createHash } from "node:crypto";
import type { PrismaClient } from "@knowledge-base/db/client";
import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";

import { stableFilterHash } from "./cursor";
import {
  isCommitReachable,
  readDocumentAtRevision,
  resolveMarkdownAssetReferences,
  resolvePinnedRevision,
} from "./documents-read";
import assetReferenceCases from "./fixtures/asset-reference-cases.json";
import { runGitAsync } from "./git-read";

vi.mock("@knowledge-base/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@knowledge-base/queue", () => ({}));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, createHash: vi.fn(original.createHash) };
});
vi.mock("./git-read", async (importOriginal) => {
  const original = await importOriginal<typeof import("./git-read")>();
  return { ...original, runGitAsync: vi.fn() };
});

describe("documents-read helpers", () => {
  it("has stable filter hashing for cursors", () => {
    expect(stableFilterHash({ prefix: "docs" })).toBe(stableFilterHash({ prefix: "docs" }));
    expect(stableFilterHash({ prefix: "docs" })).not.toBe(stableFilterHash({ prefix: "other" }));
  });
});

describe("document content hashing", () => {
  it.each(["", "猫 😀 e\u0301\n"])("hashes source bytes once per read: %j", async (markdown) => {
    const commitSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    const bytes = Buffer.from(markdown);
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const git = vi.mocked(runGitAsync);
    git.mockReset();
    git
      .mockResolvedValueOnce({ stdout: commitSha, stderr: "" })
      .mockResolvedValueOnce({
        stdout: Buffer.from(`100644 blob ${blobSha} ${bytes.length}\tnote.md\0`),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: bytes, stderr: "" });
    const hash = vi.mocked(createHash);
    hash.mockClear();
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const record = await readDocumentAtRevision({
        reposDir: "/unused",
        kbId: "test",
        commitSha,
        path: "note.md",
      });
      expect(record).toMatchObject({ markdown, contentHash: expectedHash, assetRefs: [] });
      expect(hash).toHaveBeenCalledExactlyOnceWith("sha256");
      // The response-size projection and returned record use the same digest.
      expect(stringify).toHaveBeenCalledWith(
        expect.objectContaining({ contentHash: expectedHash }),
      );
      expect(git).toHaveBeenCalledTimes(3);
    } finally {
      stringify.mockRestore();
      git.mockReset();
      hash.mockClear();
    }
  });
});

describe("markdown asset reference resolution", () => {
  const resolve = (markdown: string, documentPath: string): string[] =>
    [...resolveMarkdownAssetReferences(markdown, documentPath)].sort();

  it("matches plain relative links from a nested document", () => {
    const markdown = "![Example](images/example.png) and [doc](notes/a.md)";
    expect(resolve(markdown, "docs/readme.md")).toEqual([
      "docs/images/example.png",
      "docs/notes/a.md",
    ]);
  });

  it("matches root-relative, parent-relative, and query-bearing destinations", () => {
    const markdown = "![a](/assets/a.png) ![b](../media/b.webp) ![c](c.png?width=2#frag)";
    expect(resolve(markdown, "docs/note.md")).toEqual([
      "assets/a.png",
      "docs/c.png",
      "media/b.webp",
    ]);
  });

  it("ignores external URLs, fragments, and code spans", () => {
    const markdown = [
      "[site](https://example.com/x.png)",
      "[mail](mailto:a@b.example)",
      "[frag](#section)",
      "[proto-rel](//cdn.example.com/a.png)",
      "inline `[x](secret.png)` code",
      "```ts",
      "const url = '[fenced](fenced.png)';",
      "```",
      "[real](real.png)",
    ].join("\n");
    expect(resolve(markdown, "index.md")).toEqual(["real.png"]);
  });

  it.each(assetReferenceCases)(
    "resolves percent escapes atomically: $markdown",
    ({ markdown, paths }) => {
      expect(resolve(markdown, "index.md")).toEqual(paths);
    },
  );

  it("resolves reference definitions used by full-reference links and images", () => {
    const markdown = [
      "![Reference][image]",
      "also [a doc][DOC REF]",
      "",
      "[image]: images/ref.png",
      "[doc ref]: notes/deep%20dir/a.md",
    ].join("\n");
    expect(resolve(markdown, "index.md")).toEqual(["images/ref.png", "notes/deep dir/a.md"]);
  });

  it("resolves titles, angle destinations, and skips trailing junk after definitions", () => {
    const markdown = [
      '![t](<images/spaced name.png> "title")',
      "[t2](images/t2.png 'tip')",
      "[unused]: images/unused.png trailing junk makes this not a definition",
      "[unused][x]",
    ].join("\n");
    expect(resolve(markdown, "index.md")).toEqual(["images/spaced name.png", "images/t2.png"]);
  });

  it("resolves shortcut/collapsed references only when their definition exists", () => {
    const markdown = "[just text] and [another] here\n\n[another]: real/asset.png";
    expect(resolve(markdown, "index.md")).toEqual(["real/asset.png"]);
    expect(resolve("![pic][]\n\n[pic]: pic.png", "index.md")).toEqual(["pic.png"]);
  });
  it("ignores multi-backtick/multiline spans and fence-like text inside code", () => {
    const markdown =
      "``a `[fake](wrong.png)` b``\n`multi\n[fake](wrong2.png)`\n```\n``` trailing\n[fake](wrong3.png)\n```\n    [fake](wrong4.png)\n[real](right.png)";
    expect(resolve(markdown, "index.md")).toEqual(["right.png"]);
  });

  it("resolves asset links on lazy paragraph continuations but not indented code blocks", () => {
    expect(resolve("Some text\n    [lazy](images/lazy.png)", "index.md")).toEqual([
      "images/lazy.png",
    ]);
    expect(resolve("Some text\n\t[lazy-tab](images/lazy-tab.png)", "index.md")).toEqual([
      "images/lazy-tab.png",
    ]);
    expect(resolve("Some text\n\n    [code](images/code.png)", "index.md")).toEqual([]);
  });

  it("scans adversarial unmatched-bracket documents in bounded linear time", () => {
    const adversarial = `${"[".repeat(512 * 1024)}](tail.png)`;
    const start = process.threadCpuUsage();
    const refs = resolveMarkdownAssetReferences(adversarial, "index.md");
    const cpu = process.threadCpuUsage(start);
    const elapsed = cpu.user + cpu.system;
    // The pre-fix backtracking regex needed seconds at 64 KiB; the linear
    // scanner handles 512 KiB in milliseconds. Count this thread's actual CPU
    // work, excluding host descheduling; quadratic work still exceeds the same
    // two-second bound.
    expect(elapsed).toBeLessThan(2_000_000);
    expect([...refs]).toEqual(["tail.png"]);
  });

  it("scans adversarial nested failed inline parses in bounded linear time", () => {
    const unit = "[a](0[b](0[c](0";
    const adversarial = unit.repeat(8 * 1024);
    const start = process.threadCpuUsage();
    const refs = resolveMarkdownAssetReferences(adversarial, "index.md");
    const cpu = process.threadCpuUsage(start);
    const elapsed = cpu.user + cpu.system;
    expect(elapsed).toBeLessThan(2_000_000);
    expect(refs.size).toBe(0);
  });

  it("scans dense valid short links within the document work bound", () => {
    const source = "[x](a.png)\n".repeat(131_072);
    expect(source.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    const start = process.threadCpuUsage();
    expect(resolve(source, "index.md")).toEqual(["a.png"]);
    const cpu = process.threadCpuUsage(start);
    expect(cpu.user + cpu.system).toBeLessThan(2_000_000);
  });

  it("resolves long encoded URLs and normalizes a repeated definition only once", () => {
    const path = `${"a".repeat(460)}.png`;
    expect(resolve(`![pic](${"&#0000097;".repeat(460)}.png)`, "index.md")).toEqual([path]);
    const source = `${"![pic][ref]\n".repeat(10000)}\n[ref]: ${"./".repeat(120000)}pic.png`;
    expect(Buffer.byteLength(source)).toBeLessThan(2 * 1024 * 1024);
    const start = process.threadCpuUsage();
    expect(resolve(source, "index.md")).toEqual(["pic.png"]);
    const cpu = process.threadCpuUsage(start);
    expect(cpu.user + cpu.system).toBeLessThan(2_000_000);
  });

  it("scans adversarial unterminated reference labels and definitions linearly", () => {
    const labelRun = "b".repeat(4096);
    const adversarial = [
      `[a][${labelRun}`.repeat(256),
      `[def]: <${"c".repeat(4096)}`,
      "[x](real.png)",
    ].join("\n");
    const start = process.threadCpuUsage();
    const refs = resolveMarkdownAssetReferences(adversarial, "index.md");
    const cpu = process.threadCpuUsage(start);
    const elapsed = cpu.user + cpu.system;
    expect(elapsed).toBeLessThan(2_000_000);
    expect([...refs]).toEqual(["real.png"]);
  });
});

describe("sealed immutable source occurrence", () => {
  it("uses exact delimited bytes, including source code/frontmatter, without Markdown decoding", async () => {
    const { sourceHasSealedReference } = await import("./documents-read");
    const reference =
      "{{sealed:v1:knowledge_base:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002}}";
    for (const source of [reference, `---\nsecret: '${reference}'\n---\n`, `\`${reference}\``])
      expect(sourceHasSealedReference(source, reference)).toBe(true);
    for (const source of [
      "",
      reference.slice(2, -2),
      reference.toUpperCase(),
      reference.replace("{{", "&#123;&#123;"),
    ])
      expect(sourceHasSealedReference(source, reference)).toBe(false);
    expect(sourceHasSealedReference("arbitrary substring", "substring")).toBe(false);
  });
});

describe("retained revision reachability", () => {
  const sha = "a".repeat(40);
  it("accepts a proposal-only revision with one bounded retained-head query", async () => {
    const git = vi.mocked(runGitAsync).mockReset();
    git.mockResolvedValue({ stdout: "b".repeat(40), stderr: "" });
    expect(await resolvePinnedRevision("/repo", sha, "c".repeat(40))).toBe(sha);
    expect(git).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      ["for-each-ref", `--contains=${sha}`, "--count=1", "--format=%(objectname)", "refs/heads"],
      expect.objectContaining({ maxBuffer: 64 * 1024, deadlineAt: expect.any(Number) }),
    );
  });
  it("rejects an existing unreachable revision", async () => {
    const git = vi.mocked(runGitAsync).mockReset().mockResolvedValue({ stdout: "", stderr: "" });
    await expect(resolvePinnedRevision("/repo", sha, "c".repeat(40))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(git).toHaveBeenCalledOnce();
  });
  it("classifies unknown revisions as misses, preserving operational failures and cancellation", async () => {
    const git = vi.mocked(runGitAsync).mockReset();
    git.mockResolvedValueOnce({
      stdout: "",
      exitCode: 129,
      stderr: `error: no such commit ${sha}\n`,
    });
    expect(await isCommitReachable("/repo", sha)).toBe(false);
    git.mockResolvedValueOnce({
      stdout: "",
      exitCode: 128,
      stderr: "fatal: bad object refs/heads/main",
    });
    await expect(isCommitReachable("/repo", sha)).rejects.toMatchObject({
      code: 128,
      stderr: "fatal: bad object refs/heads/main",
    });
    git.mockResolvedValueOnce({
      stdout: "",
      exitCode: 129,
      stderr: `error: object ${sha} is a blob, not a commit\nerror: no such commit ${sha}\n`,
    });
    expect(await isCommitReachable("/repo", sha)).toBe(false);
    for (const error of [
      Object.assign(new Error("repository corrupt"), {
        code: 128,
        stderr: "fatal: bad object refs/heads/main",
      }),
      Object.assign(new Error("missing executable"), { code: "ENOENT" }),
      new DOMException("cancelled", "AbortError"),
    ]) {
      git.mockRejectedValueOnce(error);
      await expect(isCommitReachable("/repo", sha)).rejects.toBe(error);
    }
  });
  it("validates the SHA before dispatch and carries cancellation/deadline options", async () => {
    const git = vi.mocked(runGitAsync).mockReset();
    await expect(isCommitReachable("/repo", "--all")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(git).not.toHaveBeenCalled();
    git.mockResolvedValue({ stdout: "", stderr: "" });
    const signal = new AbortController().signal;
    const deadlineAt = Date.now() + 100;
    await isCommitReachable("/repo", sha, { signal, deadlineAt });
    expect(git).toHaveBeenCalledWith(
      "/repo",
      expect.any(Array),
      expect.objectContaining({ signal, deadlineAt }),
    );
  });
});
