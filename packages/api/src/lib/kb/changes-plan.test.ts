import { describe, expect, it } from "vitest";
import { danglingAssetLinks, walkGitTreeAtCommit } from "./changes-plan";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text, "utf8")]));

describe("asset removal warnings", () => {
  it("lists the documents that still link to a removed asset", () => {
    expect(
      danglingAssetLinks(
        files({
          "notes/a.md": "![a](../img/a.png)",
          "b.md": "[see](img/a.png) and `img/a.png` in code",
          "c.md": "unrelated",
          ".assets/manifest.json": "{}",
        }),
        ["img/a.png", "img/unused.png"],
      ),
    ).toEqual([
      { code: "ASSET_STILL_REFERENCED", path: "img/a.png", referencedBy: ["b.md", "notes/a.md"] },
    ]);
  });
  it("is empty without removals or remaining references", () => {
    expect(danglingAssetLinks(files({ "a.md": "![a](a.png)" }), [])).toEqual([]);
    expect(danglingAssetLinks(files({ "a.md": "no links" }), ["a.png"])).toEqual([]);
  });
});

describe("provenance-only rewrites", () => {
  const human = "---\nid: h\nprovenance: human\n---\n# Person\n\nText.\n";
  const plan = (
    markdown: string,
    options: { op?: "create" | "replace"; resolving?: boolean; stored?: string } = {},
  ) =>
    walkGitTreeAtCommit({
      repoPath: "/nonexistent",
      baseRevision: "0".repeat(40),
      baseFiles: files({
        ".gitignore": "# kb managed\n",
        ".assets/manifest.json": '{"version":1,"entries":[]}\n',
        "h.md": options.stored ?? human,
      }),
      changes: [{ op: options.op ?? "replace", path: "h.md", content: { markdown } }],
      stamp: "agent",
      ...(options.resolving
        ? { resolving: { documents: new Set(["h.md"]), assets: new Set<string>() } }
        : {}),
    });
  const written = (result: Awaited<ReturnType<typeof plan>>) => {
    if (!result.ok) throw new Error(result.message);
    const file = result.files.find((f) => f.segments.join("/") === "h.md");
    return { changedPaths: result.changedPaths, text: file?.content.toString("utf8") };
  };

  it("keeps a person's document when only a quoted label changes", async () => {
    const quoted = '---\nid: h\nprovenance: "agent"\n---\n# Person\n\nText.\n';
    expect(written(await plan(quoted))).toEqual({ changedPaths: [], text: human });
  });

  it("keeps a person's document when only an escaped-key label changes", async () => {
    const escaped = '---\nid: h\n"\\x70rovenance": agent\n---\n# Person\n\nText.\n';
    expect(written(await plan(escaped))).toEqual({ changedPaths: [], text: human });
  });

  it("stamps a real body change as the credential's", async () => {
    const edited = "---\nid: h\nprovenance: human\n---\n# Person\n\nEdited.\n";
    expect(written(await plan(edited))).toEqual({
      changedPaths: ["h.md"],
      text: "---\nid: h\nprovenance: agent\n---\n# Person\n\nEdited.\n",
    });
  });

  it("publishes and stamps a comment-only front-matter edit", async () => {
    const stored = "---\nid: h\ntitle: T # old\nprovenance: human\n---\n# Person\n";
    const edited = "---\nid: h\ntitle: T # new\nprovenance: human\n---\n# Person\n";
    expect(written(await plan(edited, { stored }))).toEqual({
      changedPaths: ["h.md"],
      text: "---\nid: h\ntitle: T # new\nprovenance: agent\n---\n# Person\n",
    });
  });

  it("does not treat a block-scalar label as a provenance-only change", async () => {
    // The header line alone parses as `provenance`, but its value line stays
    // and differs; the write is a real one, and its label cannot be stamped.
    const block = "---\nid: h\nprovenance: |\n  agent\n---\n# Person\n\nText.\n";
    const result = await plan(block);
    expect(result).toMatchObject({ ok: false, reason: "SCHEMA", key: "content" });
  });

  it("keeps the stored document when a create resolving a conflict changes only the label", async () => {
    const quoted = '---\nid: h\nprovenance: "agent"\n---\n# Person\n\nText.\n';
    // The conflict is still resolved (a change), but the person's bytes stay.
    expect(written(await plan(quoted, { op: "create", resolving: true }))).toEqual({
      changedPaths: ["h.md"],
      text: human,
    });
  });

  it("stamps a create resolving a conflict with a real change", async () => {
    const edited = "---\nid: h\nprovenance: human\n---\n# Person\n\nEdited.\n";
    expect(written(await plan(edited, { op: "create", resolving: true }))).toEqual({
      changedPaths: ["h.md"],
      text: "---\nid: h\nprovenance: agent\n---\n# Person\n\nEdited.\n",
    });
  });
});

describe("document moves (browser rename/move)", () => {
  const agentDoc = "---\nid: d1\nprovenance: agent\n---\n# Runbook\n\n![diagram](img/flow.png)\n";
  const image = {
    path: "notes/img/flow.png",
    hash: `sha256:${"a".repeat(64)}`,
    size: 3,
    mime: "image/png",
  };
  const tree = (extra: Record<string, string> = {}) =>
    files({
      ".gitignore": "# kb managed\n",
      ".assets/manifest.json": `${JSON.stringify({ version: 1, entries: [image] })}\n`,
      "notes/run.md": agentDoc,
      "notes/plain.md":
        "# Plain\n\n![root](/notes/img/flow.png) [web](https://example.com/x.png)\n",
      ...extra,
    });
  const move = (path: string, toPath: string, extra?: Record<string, string>) =>
    walkGitTreeAtCommit({
      repoPath: "/nonexistent",
      baseRevision: "0".repeat(40),
      baseFiles: tree(extra),
      changes: [{ op: "move", path, toPath }],
      // A person's web edit stamps `human`: a move must still not restamp.
      stamp: "human",
    });
  const at = (result: Awaited<ReturnType<typeof move>>, path: string) => {
    if (!result.ok) throw new Error(result.message);
    return result.files.find((f) => f.segments.join("/") === path)?.content.toString("utf8");
  };

  it("keeps the bytes exactly, provenance included, and removes the old path", async () => {
    const result = await move("notes/run.md", "notes/runbook.md");
    expect(result).toMatchObject({ ok: true, noop: false });
    if (!result.ok) return;
    expect(result.changedPaths).toEqual(["notes/run.md", "notes/runbook.md"]);
    expect(at(result, "notes/runbook.md")).toBe(agentDoc);
    expect(at(result, "notes/run.md")).toBeUndefined();
  });

  it("moves a document with only root-relative or external links to another folder", async () => {
    const result = await move("notes/plain.md", "archive/2026/plain.md");
    expect(at(result, "archive/2026/plain.md")).toContain("# Plain");
    expect(at(result, "notes/plain.md")).toBeUndefined();
  });

  it("refuses a target that already exists", async () => {
    expect(await move("notes/run.md", "notes/plain.md")).toMatchObject({
      ok: false,
      reason: "PATH_EXISTS",
      changeIndex: 0,
      key: "toPath",
    });
  });

  it("refuses a source that does not exist", async () => {
    expect(await move("notes/missing.md", "notes/new.md")).toMatchObject({
      ok: false,
      reason: "PATH_NOT_FOUND",
      key: "path",
    });
  });

  it("applies the create path rules to the target", async () => {
    expect(await move("notes/run.md", "notes/run.txt")).toMatchObject({
      ok: false,
      reason: "NOT_MARKDOWN_PATH",
      key: "toPath",
    });
    expect(await move("notes/run.md", ".assets/run.md")).toMatchObject({
      ok: false,
      reason: "RESERVED_PATH",
      key: "toPath",
    });
    expect(await move("notes/run.md", "../run.md")).toMatchObject({ ok: false, key: "toPath" });
  });

  it("refuses a move to the document's own path", async () => {
    expect(await move("notes/run.md", "notes/run.md")).toMatchObject({
      ok: false,
      reason: "INVALID_PATH",
      key: "toPath",
    });
  });

  it("refuses a folder change that would break a relative image link", async () => {
    expect(await move("notes/run.md", "archive/run.md")).toMatchObject({
      ok: false,
      reason: "MOVE_BREAKS_ASSET_LINKS",
      key: "toPath",
    });
  });

  it("checks each link on its own: a root-relative link to the same image does not save a relative one", async () => {
    expect(
      await move("notes/mixed.md", "archive/mixed.md", {
        "notes/mixed.md": "![a](img/flow.png)\n![b](/notes/img/flow.png)\n",
      }),
    ).toMatchObject({ ok: false, reason: "MOVE_BREAKS_ASSET_LINKS", key: "toPath" });
    // Through a used reference definition too.
    expect(
      await move("notes/ref.md", "archive/ref.md", {
        "notes/ref.md": "![a][pic]\n\n[pic]: img/flow.png\n",
      }),
    ).toMatchObject({ ok: false, reason: "MOVE_BREAKS_ASSET_LINKS" });
  });

  it("allows a rename in the same folder whatever the document links", async () => {
    expect(at(await move("notes/run.md", "notes/renamed.md"), "notes/renamed.md")).toBe(agentDoc);
  });

  it("ignores relative links that reach no asset today", async () => {
    const result = await move("notes/dangling.md", "archive/dangling.md", {
      "notes/dangling.md": "![gone](img/missing.png)\n",
    });
    expect(at(result, "archive/dangling.md")).toBe("![gone](img/missing.png)\n");
  });
});
