import { describe, expect, it } from "vitest";
import { danglingAssetLinks, walkGitTreeAtCommit } from "./changes-plan";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text, "utf8")]));

describe("L-22 asset removal warnings", () => {
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
