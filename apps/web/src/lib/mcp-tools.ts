import type { McpToolGroup } from "@knowledge-base/auth/mcp-tool-groups";

import type { KbBit } from "@/hooks/use-mcp-consent";

/**
 * The kb/1 tools as the credential pickers preview them: name, the groups that
 * make each available (none = a supporting tool every connection may call),
 * whether it only reads, and the KB permissions any one of which makes it
 * usable on a knowledge base (null: not KB-scoped; creation needs allowCreate).
 * Mirrors `KB_TOOL_CATALOG` in catalog order without bundling its schemas
 * (test-enforced).
 */
export const MCP_TOOLS: readonly {
  name: string;
  groups: readonly McpToolGroup[];
  readOnly: boolean;
  kbBits: readonly KbBit[] | null;
}[] = [
  { name: "knowledge_bases_list", groups: [], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_bases_get", groups: [], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_bases_create", groups: ["kb_admin"], readOnly: false, kbBits: null },
  { name: "knowledge_bases_update", groups: ["kb_admin"], readOnly: false, kbBits: ["manage"] },
  { name: "knowledge_bases_delete", groups: ["kb_admin"], readOnly: false, kbBits: ["manage"] },
  { name: "knowledge_documents_list", groups: ["read"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_documents_get", groups: ["read"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_search", groups: ["read"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_structured_search", groups: ["read"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_changes_apply", groups: ["edit"], readOnly: false, kbBits: ["propose"] },
  { name: "knowledge_documents_create", groups: ["edit"], readOnly: false, kbBits: ["propose"] },
  { name: "knowledge_documents_update", groups: ["edit"], readOnly: false, kbBits: ["propose"] },
  { name: "knowledge_documents_delete", groups: ["edit"], readOnly: false, kbBits: ["propose"] },
  {
    name: "knowledge_upload_begin",
    groups: ["edit", "assets"],
    readOnly: false,
    kbBits: ["propose"],
  },
  {
    name: "knowledge_upload_write",
    groups: ["edit", "assets"],
    readOnly: false,
    kbBits: ["propose"],
  },
  {
    name: "knowledge_upload_finish",
    groups: ["edit", "assets"],
    readOnly: false,
    kbBits: ["propose"],
  },
  { name: "knowledge_assets_put", groups: ["assets"], readOnly: false, kbBits: ["propose"] },
  { name: "knowledge_assets_import", groups: ["assets"], readOnly: false, kbBits: ["propose"] },
  { name: "knowledge_assets_list", groups: ["assets"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_export_prepare", groups: ["export"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_transfer_read", groups: ["export"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_export_complete", groups: ["export"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_index_status", groups: ["index_admin"], readOnly: true, kbBits: ["read"] },
  { name: "knowledge_index_rebuild", groups: ["index_admin"], readOnly: false, kbBits: ["manage"] },
  {
    name: "knowledge_embedding_profile_get",
    groups: ["index_admin"],
    readOnly: true,
    kbBits: ["read"],
  },
  {
    name: "knowledge_embedding_profile_set",
    groups: ["index_admin"],
    readOnly: false,
    kbBits: ["manage"],
  },
  {
    name: "knowledge_pull_requests_list",
    groups: ["pull_requests"],
    readOnly: true,
    kbBits: ["read"],
  },
  {
    name: "knowledge_pull_requests_get",
    groups: ["pull_requests"],
    readOnly: true,
    kbBits: ["read"],
  },
  {
    name: "knowledge_pull_requests_create",
    groups: ["pull_requests"],
    readOnly: false,
    kbBits: ["propose"],
  },
  {
    name: "knowledge_pull_requests_review",
    groups: ["pull_requests"],
    readOnly: false,
    kbBits: ["review", "propose"],
  },
  { name: "knowledge_sealed_resolve", groups: ["sealed"], readOnly: true, kbBits: ["read"] },
];

const IMPLIED: Record<KbBit, readonly KbBit[]> = {
  read: ["read"],
  propose: ["read", "propose"],
  write: ["read", "propose", "write"],
  review: ["read", "review"],
  manage: ["read", "propose", "write", "review", "manage"],
};
const expand = (bits: readonly KbBit[]) => new Set(bits.flatMap((bit) => IMPLIED[bit]));

export type ToolPreview = {
  /** Group tools the connection can call on at least one selected or created KB. */
  tools: string[];
  /** Selected tools that change data but the credential lacks `mcp:write`. */
  needWrite: string[];
  /** Selected tools no selected (or created) knowledge base has permission for. */
  noEligibleKb: string[];
  /** Supporting tools, available with any groups. */
  supporting: string[];
  /** Group overlaps and prerequisites worth calling out. */
  notes: (
    | "editWithoutAssets"
    | "assetsWithoutEdit"
    | "writeScopeMissing"
    | "noEligibleKb"
    | "createNotAllowed"
  )[];
};

/**
 * What an agent on this selection can call, given its groups, scopes and the
 * KB permissions selected (expanded, as the server does). Calls are always
 * checked by the server; this only describes them.
 */
export function previewTools(input: {
  groups: readonly McpToolGroup[];
  writeScope: boolean;
  allowCreate: boolean;
  kbBits: readonly (readonly KbBit[])[];
  createdKbBits: readonly KbBit[];
}): ToolPreview {
  const has = (group: McpToolGroup) => input.groups.includes(group);
  const held = [...input.kbBits, ...(input.allowCreate ? [input.createdKbBits] : [])].map(expand);
  const eligible = (tool: (typeof MCP_TOOLS)[number]) =>
    tool.kbBits === null
      ? input.allowCreate
      : held.some((bits) => tool.kbBits!.some((bit) => bits.has(bit)));
  const selected = MCP_TOOLS.filter(
    (tool) => tool.groups.length > 0 && tool.groups.some((group) => has(group)),
  );
  const needWrite = input.writeScope
    ? []
    : selected.filter((tool) => !tool.readOnly).map((tool) => tool.name);
  const noEligibleKb = selected
    .filter((tool) => !needWrite.includes(tool.name) && !eligible(tool))
    .map((tool) => tool.name);
  const notes: ToolPreview["notes"] = [];
  if (has("edit") && !has("assets")) notes.push("editWithoutAssets");
  if (has("assets") && !has("edit")) notes.push("assetsWithoutEdit");
  if (needWrite.length > 0) notes.push("writeScopeMissing");
  if (noEligibleKb.length > 0) notes.push("noEligibleKb");
  if (has("kb_admin") && !input.allowCreate) notes.push("createNotAllowed");
  return {
    tools: selected
      .filter((tool) => !needWrite.includes(tool.name) && !noEligibleKb.includes(tool.name))
      .map((tool) => tool.name),
    needWrite,
    noEligibleKb,
    supporting: MCP_TOOLS.filter((tool) => tool.groups.length === 0).map((tool) => tool.name),
    notes,
  };
}
