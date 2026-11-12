import {
  KB_TOOL_CATALOG,
  KB_TOOL_NAMES,
  type KbMinimumAccess,
} from "@knowledge-base/api/lib/kb/protocol/catalog";
import { describe, expect, it } from "vitest";

import { MCP_TOOLS, previewTools } from "@/lib/mcp-tools";

/** The KB permissions any one of which satisfies a catalog minimum (null: not KB-scoped). */
function kbBitsFor(access: KbMinimumAccess): string[] | null {
  switch (access.kind) {
    case "permission":
      return [access.bit];
    case "owner_manage":
      return ["manage"];
    case "propose_or_write":
    case "author_with_propose":
      return ["propose"];
    case "sealed_grant":
      return ["read"];
    case "global_allow_create":
      return null;
    case "any_of":
      return access.of.flatMap((alternative) => kbBitsFor(alternative) ?? []);
  }
}

const none = { writeScope: true, allowCreate: false, kbBits: [], createdKbBits: [] };

describe("MCP tool preview", () => {
  it("mirrors the kb/1 catalog exactly, in catalog order", () => {
    expect(MCP_TOOLS).toEqual(
      KB_TOOL_NAMES.map((name) => ({
        name,
        groups: [...KB_TOOL_CATALOG[name].groups],
        readOnly: KB_TOOL_CATALOG[name].readOnly,
        kbBits: kbBitsFor(KB_TOOL_CATALOG[name].minimumAccess),
      })),
    );
  });

  it("a read-only connection on one readable KB sees the four read tools plus supporting tools", () => {
    expect(
      previewTools({ ...none, groups: ["read"], writeScope: false, kbBits: [["read"]] }),
    ).toEqual({
      tools: [
        "knowledge_documents_list",
        "knowledge_documents_get",
        "knowledge_search",
        "knowledge_structured_search",
      ],
      needWrite: [],
      noEligibleKb: [],
      supporting: ["knowledge_bases_list", "knowledge_bases_get"],
      notes: [],
    });
  });

  it("index admin tools that need Manage are unavailable on a Read-only KB, available on Manage", () => {
    const read = previewTools({ ...none, groups: ["index_admin"], kbBits: [["read"]] });
    expect(read.tools).toEqual(["knowledge_index_status", "knowledge_embedding_profile_get"]);
    expect(read.noEligibleKb).toEqual([
      "knowledge_index_rebuild",
      "knowledge_embedding_profile_set",
    ]);
    expect(read.notes).toEqual(["noEligibleKb"]);
    const manage = previewTools({ ...none, groups: ["index_admin"], kbBits: [["manage"]] });
    expect(manage.tools).toContain("knowledge_index_rebuild");
    expect(manage.noEligibleKb).toEqual([]);
  });

  it("counts permissions on knowledge bases the credential creates", () => {
    const created = previewTools({
      ...none,
      groups: ["edit", "kb_admin"],
      allowCreate: true,
      createdKbBits: ["read", "propose"],
    });
    expect(created.tools).toContain("knowledge_documents_create");
    expect(created.tools).toContain("knowledge_bases_create");
    expect(created.noEligibleKb).toEqual(["knowledge_bases_update", "knowledge_bases_delete"]);
  });

  it("calls out overlaps and missing prerequisites", () => {
    const edit = previewTools({ ...none, groups: ["read", "edit"], kbBits: [["write"]] });
    expect(edit.notes).toEqual(["editWithoutAssets"]);
    expect(edit.tools).toContain("knowledge_upload_begin");
    expect(previewTools({ ...none, groups: ["assets"], kbBits: [["write"]] }).notes).toEqual([
      "assetsWithoutEdit",
    ]);
    const noWrite = previewTools({ ...none, groups: ["edit", "kb_admin"], writeScope: false });
    expect(noWrite.tools).toEqual([]);
    expect(noWrite.needWrite).toContain("knowledge_changes_apply");
    expect(noWrite.notes).toEqual(["editWithoutAssets", "writeScopeMissing", "createNotAllowed"]);
  });
});
