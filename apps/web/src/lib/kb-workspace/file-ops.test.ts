import { describe, expect, it } from "vitest";

import {
  ASSET_MAX_BYTES,
  DOCUMENT_STAGED_ASSETS_MAX,
  STAGED_MARKDOWN_MAX_BYTES,
} from "@/hooks/use-kb-editor";
import {
  canDrop,
  documentName,
  dropDraft,
  folderOf,
  joinPath,
  movedPath,
  nameOf,
  pathIssue,
  planUpload,
  renamedPath,
} from "./file-ops";

describe("path helpers", () => {
  it("joins folders and names, root included", () => {
    expect(joinPath("", "a.md")).toBe("a.md");
    expect(joinPath("guides/", "a.md")).toBe("guides/a.md");
    expect(joinPath("guides", "a.md")).toBe("guides/a.md");
    expect(joinPath("guides/", "/a.md")).toBe("guides/a.md");
    expect(joinPath("guides/", "deep/a.md")).toBe("guides/deep/a.md");
  });
  it("splits a path into folder and name", () => {
    expect(folderOf("a/b/c.md")).toBe("a/b/");
    expect(folderOf("c.md")).toBe("");
    expect(nameOf("a/b/c.md")).toBe("c.md");
  });
  it("makes typed names document names", () => {
    expect(documentName("  Notes ")).toBe("Notes.md");
    expect(documentName("plan.MD")).toBe("plan.MD");
    expect(documentName("   ")).toBe("");
  });
  it("renames in place and moves keeping the name", () => {
    expect(renamedPath("guides/old.md", "new")).toBe("guides/new.md");
    expect(renamedPath("old.md", "new.md")).toBe("new.md");
    expect(movedPath("guides/a.md", "")).toBe("a.md");
    expect(movedPath("a.md", "guides/deep/")).toBe("guides/deep/a.md");
  });
});

describe("canDrop", () => {
  it("moves files into another folder only", () => {
    expect(canDrop({ kind: "file", path: "a/x.md" }, "b/")).toBe(true);
    expect(canDrop({ kind: "file", path: "a/x.md" }, "")).toBe(true);
    expect(canDrop({ kind: "file", path: "a/x.md" }, "a/")).toBe(false);
    expect(canDrop({ kind: "file", path: "x.md" }, "")).toBe(false);
    expect(canDrop({ kind: "file", path: "x.md" }, "not-a-folder")).toBe(false);
  });
  it("never moves folders (one commit per document)", () => {
    expect(canDrop({ kind: "folder", path: "a/" }, "b/")).toBe(false);
    expect(canDrop({ kind: "folder", path: "a/" }, "a/b/")).toBe(false);
  });
});

describe("pathIssue (the server's rule)", () => {
  it.each([
    ["notes/meeting.md", null],
    ["index.md", null],
    ["Onboarding checklist", "notMarkdown"],
    ["notes/plan.txt", "notMarkdown"],
    ["", "empty"],
    ["/notes/a.md", "absolute"],
    ["C:notes.md", "absolute"],
    ["notes//a.md", "segment"],
    ["notes/../a.md", "segment"],
    ["notes/./a.md", "segment"],
    ["notes\\a.md", "characters"],
    ["notes/a\u0007.md", "characters"],
    ["notes/what?.md", "portable"],
    ["notes/a .md", "portable"],
    [" a.md", "portable"],
    [".git/a.md", "reserved"],
    ["con.md", "reserved"],
    [".assets/a.md", "reserved"],
    [`${"a/".repeat(32)}a.md`, "tooDeep"],
    [`${"a".repeat(510)}.md`, "tooLong"],
  ] as const)("%j → %s", (path, issue) => {
    expect(pathIssue(path)).toBe(issue);
  });
  it("accepts a decomposed name (saved composed)", () => {
    expect(pathIssue("café.md")).toBeNull();
  });
  it("reports a taken path, also in another case", () => {
    const existing = new Set(["guides/Setup.md"]);
    expect(pathIssue("guides/Setup.md", existing)).toBe("exists");
    expect(pathIssue("guides/setup.md", existing)).toBe("exists");
    expect(pathIssue("guides/other.md", existing)).toBeNull();
  });
});

describe("planUpload", () => {
  const md = (name: string, size = 10) => ({ name, type: "text/markdown", size });
  it("opens the first Markdown file as a document in the folder, one per drop", () => {
    expect(
      planUpload([md("a.md"), { name: "b.md", type: "", size: 5 }], "notes/", new Set()),
    ).toEqual([
      { file: md("a.md"), kind: "document", path: "notes/a.md" },
      { file: { name: "b.md", type: "", size: 5 }, kind: "refused", reason: "oneAtATime" },
    ]);
  });
  it("refuses existing names (in any case) before counting the drop's document", () => {
    const plan = planUpload([md("A.md"), md("b.md"), md("c.md")], "", new Set(["a.md"]));
    expect(plan.map((p) => (p.kind === "refused" ? p.reason : p.kind))).toEqual([
      "exists",
      "document",
      "oneAtATime",
    ]);
  });
  it("keeps the app's size limits and supported image types", () => {
    const plan = planUpload(
      [
        md("big.md", STAGED_MARKDOWN_MAX_BYTES + 1),
        { name: "p.png", type: "image/png", size: 100 },
        { name: "huge.png", type: "image/png", size: ASSET_MAX_BYTES + 1 },
        { name: "v.mp4", type: "video/mp4", size: 100 },
        { name: "what?.md", type: "text/markdown", size: 3 },
      ],
      "",
      new Set(),
    );
    expect(
      plan.map((p) => (p.kind === "refused" ? `${p.reason}:${p.issue ?? ""}` : p.kind)),
    ).toEqual(["tooLarge:", "image", "tooLarge:", "type:", "path:portable"]);
  });
});

describe("planUpload image count", () => {
  it("stages at most as many images as one save takes, and names the rest", () => {
    const pngs = Array.from({ length: DOCUMENT_STAGED_ASSETS_MAX + 1 }, (_, i) => ({
      name: `p${i}.png`,
      type: "image/png",
      size: 10,
    }));
    const plan = planUpload(pngs, "", new Set());
    expect(plan.filter((p) => p.kind === "image")).toHaveLength(DOCUMENT_STAGED_ASSETS_MAX);
    expect(plan.at(-1)).toMatchObject({ kind: "refused", reason: "tooManyImages" });
  });
});

describe("dropDraft", () => {
  const png = (name: string) => ({ name, type: "image/png", size: 100 });
  const md = (name: string) => ({ name, type: "text/markdown", size: 10 });
  it("uses the Markdown file's path and stages every image into it", () => {
    const plan = planUpload([png("a.png"), md("notes.md"), png("b.png")], "x/", new Set());
    expect(dropDraft(plan, "x/")).toEqual({ path: "x/notes.md", markdown: 1, images: [0, 2] });
  });
  it("names an images-only draft after the first image", () => {
    const plan = planUpload([png("photo.v2.png"), png("b.png")], "", new Set());
    expect(dropDraft(plan, "")).toEqual({ path: "photo.v2.md", markdown: null, images: [0, 1] });
  });
  it("opens nothing when every file is refused", () => {
    const plan = planUpload([{ name: "v.mp4", type: "video/mp4", size: 1 }], "", new Set());
    expect(dropDraft(plan, "")).toBeNull();
  });
});
