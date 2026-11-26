import { describe, expect, it } from "vitest";

import { documentPathIssue, pathIssueFromReason } from "./document-path";

describe("documentPathIssue", () => {
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
    ["notes\\a.md", "characters"],
    ["notes/a\u0007.md", "characters"],
    ["notes/what?.md", "portable"],
    ["notes/a .md", "portable"],
    [".git/a.md", "reserved"],
    ["con.md", "reserved"],
    [".assets/a.md", "reserved"],
    [`${"a/".repeat(32)}a.md`, "tooDeep"],
    [`${"a".repeat(510)}.md`, "tooLong"],
  ] as const)("%j → %s", (path, issue) => {
    expect(documentPathIssue(path)).toBe(issue);
  });

  it("accepts a decomposed name, which is saved composed", () => {
    expect(documentPathIssue("café.md")).toBeNull();
  });
});

describe("pathIssueFromReason", () => {
  it("maps the server's closed reasons and nothing else", () => {
    expect(pathIssueFromReason("NOT_MARKDOWN_PATH")).toBe("notMarkdown");
    expect(pathIssueFromReason("PATH_EXISTS")).toBe("exists");
    expect(pathIssueFromReason("PATH_CASE_COLLISION")).toBe("caseCollision");
    expect(pathIssueFromReason("whatever")).toBe("invalid");
  });
});
