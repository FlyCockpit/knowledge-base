import { MCP_TOOL_GROUPS, MCP_TOOL_PRESETS } from "@knowledge-base/auth/mcp-tool-groups";
import type { Permission } from "../permissions";
import { kbReadToolSchemas } from "./reads";
import { kbWriteToolSchemas } from "./writes";

export type KbMcpScope = "mcp:read" | "mcp:write";

export type KbToolConfirm = "DELETE" | "RUN" | "MERGE" | "CLOSE";

export type KbMinimumAccess =
  | { kind: "permission"; bit: Permission }
  | { kind: "owner_manage" }
  | { kind: "global_allow_create" }
  | { kind: "propose_or_write" }
  | { kind: "sealed_grant" }
  | { kind: "author_with_propose" }
  | { kind: "any_of"; of: readonly KbMinimumAccess[] };

export type KbToolDecisionVariant = {
  decision: "merge" | "close";
  minimumAccess: KbMinimumAccess;
  confirm: KbToolConfirm;
};

/**
 * Tool groups a connection can be granted, in display order. Groups and the
 * presets built on them are a closed set; adding one is additive. The list is
 * owned by `@knowledge-base/auth/mcp-tool-groups`, which validates stored grants.
 */
export const KB_TOOL_GROUPS = MCP_TOOL_GROUPS;

/**
 * Named group sets (Read, Propose edits, Direct edits). Emitted into the
 * protocol artifact so the CLI's local `--tools` flag reads the same presets.
 */
export const KB_TOOL_PRESETS = MCP_TOOL_PRESETS;

export type KbToolGroup = (typeof KB_TOOL_GROUPS)[number];

export type KbToolCatalogEntry = {
  name: string;
  /**
   * Groups that make this tool available: any one of them suffices. Empty for
   * the supporting tools (KB discovery and revision lookup), which belong to
   * no group. The upload tools serve both `edit` (Markdown) and `assets`
   * (asset) uploads; each call's `kind` is checked against the groups.
   */
  groups: readonly KbToolGroup[];
  /** Advertised in tools/list by the server and the `kb` CLI. */
  description: string;
  minimumAccess: KbMinimumAccess;
  requiredMcpScope: KbMcpScope;
  readOnly: boolean;
  confirm?: KbToolConfirm;
  decisionVariants?: readonly KbToolDecisionVariant[];
};

/** Explicit enumeration — release gate compares this set to CONTRACT rows. */
export const KB_TOOL_NAMES = [
  "knowledge_bases_list",
  "knowledge_bases_get",
  "knowledge_bases_create",
  "knowledge_bases_update",
  "knowledge_bases_delete",
  "knowledge_documents_list",
  "knowledge_documents_get",
  "knowledge_search",
  "knowledge_structured_search",
  "knowledge_changes_apply",
  "knowledge_documents_create",
  "knowledge_documents_update",
  "knowledge_documents_delete",
  "knowledge_upload_begin",
  "knowledge_upload_write",
  "knowledge_upload_finish",
  "knowledge_assets_put",
  "knowledge_assets_import",
  "knowledge_assets_list",
  "knowledge_export_prepare",
  "knowledge_transfer_read",
  "knowledge_export_complete",
  "knowledge_index_status",
  "knowledge_index_rebuild",
  "knowledge_embedding_profile_get",
  "knowledge_embedding_profile_set",
  "knowledge_pull_requests_list",
  "knowledge_pull_requests_get",
  "knowledge_pull_requests_create",
  "knowledge_pull_requests_review",
  "knowledge_sealed_resolve",
] as const;

export type KbToolName = (typeof KB_TOOL_NAMES)[number];

export const FORBIDDEN_TOOL_NAME_FRAGMENTS = ["provider-secret", "mirror-control"] as const;

export const KB_TOOL_CATALOG: Record<KbToolName, KbToolCatalogEntry> = {
  knowledge_bases_list: {
    name: "knowledge_bases_list",
    groups: [],
    description:
      "List the knowledge bases this credential can read, with each one's ID, name, head revision and your capabilities. Paginated: pass nextCursor back as cursor.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_bases_get: {
    name: "knowledge_bases_get",
    groups: [],
    description:
      "Get one knowledge base's metadata (name, description, head revision, metadataVersion, capabilities) and its search-index status.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_bases_create: {
    name: "knowledge_bases_create",
    groups: ["kb_admin"],
    description:
      "Create a new knowledge base from a name, URL slug and description. Available only when the credential was approved to create knowledge bases.",
    minimumAccess: { kind: "global_allow_create" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_bases_update: {
    name: "knowledge_bases_update",
    groups: ["kb_admin"],
    description:
      "Rename a knowledge base or change its description. Pass the current metadataVersion from knowledge_bases_get; a stale version is rejected.",
    minimumAccess: { kind: "permission", bit: "manage" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_bases_delete: {
    name: "knowledge_bases_delete",
    groups: ["kb_admin"],
    description:
      'Tombstone a knowledge base. Owner only; requires the current metadataVersion and confirm "DELETE".',
    minimumAccess: { kind: "owner_manage" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
    confirm: "DELETE",
  },
  knowledge_documents_list: {
    name: "knowledge_documents_list",
    groups: ["read"],
    description:
      "List Markdown document paths, optionally under a path prefix. Reads main unless rev pins a commit. Paginated: pass nextCursor back as cursor.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_documents_get: {
    name: "knowledge_documents_get",
    groups: ["read"],
    description:
      "Read one Markdown document by path: raw Markdown, parsed front matter, the commit it was read at, citations and referenced assets. Reads main unless rev pins a commit.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_search: {
    name: "knowledge_search",
    groups: ["read"],
    description:
      "Hybrid full-text and semantic search over a knowledge base's indexed main branch. Returns ranked snippets with paths and citations; narrow with pathPrefix or documentId. Compare indexedCommitSha with headSha if recent edits seem missing.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_structured_search: {
    name: "knowledge_structured_search",
    groups: ["read"],
    description:
      "Filter documents by front matter: type, title, tags, a timestamp range or exact column values, optionally with a text query. Use for metadata lookups; use knowledge_search for meaning-based search.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_changes_apply: {
    name: "knowledge_changes_apply",
    groups: ["edit"],
    description:
      'Apply up to 32 document and asset changes as one atomic commit. Each successful call commits: apply the first 32 changes now, then send the rest in another call using the returned commit as baseRevision. Mode "edit" takes create, replace, delete, assetPut and assetRemove operations; mode "dream" writes a consolidation of the listed source sessions. Pass the baseRevision you read and an idempotencyKey. Write access commits to main; propose-only access commits to your automatic pull request. To update your open pull request, pass its head or current main as baseRevision: against main it moves onto main if main moved, and a CONFLICT lists any paths to write in full (rewriting a path the pull request changed also needs its proposalNumber, with proposalHeadSha set to the head you read). Never write secrets (API keys, tokens, passwords) as plain text: store them as sealed values and write only the sealed reference.',
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_documents_create: {
    name: "knowledge_documents_create",
    groups: ["edit"],
    description:
      "Create one Markdown document at a new path. Pass the baseRevision you read and an idempotencyKey. Write access commits to main; propose-only access commits to your automatic pull request. Never write secrets (API keys, tokens, passwords) as plain text: store them as sealed values and write only the sealed reference.",
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_documents_update: {
    name: "knowledge_documents_update",
    groups: ["edit"],
    description:
      "Replace one existing Markdown document's full content. Pass the baseRevision you read and an idempotencyKey. Write access commits to main; propose-only access commits to your automatic pull request. Never write secrets (API keys, tokens, passwords) as plain text: store them as sealed values and write only the sealed reference.",
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_documents_delete: {
    name: "knowledge_documents_delete",
    groups: ["edit"],
    description:
      'Delete one Markdown document. Requires confirm "DELETE", the baseRevision you read and an idempotencyKey. Write access commits to main; propose-only access commits to your automatic pull request.',
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
    confirm: "DELETE",
  },
  knowledge_upload_begin: {
    name: "knowledge_upload_begin",
    groups: ["edit", "assets"],
    description:
      "Start a chunked upload of a Markdown file or asset, declaring its kind, size, sha256 contentHash and MIME type. Returns an uploadId and the maximum chunk size. Continue with knowledge_upload_write, then knowledge_upload_finish. Never write secrets (API keys, tokens, passwords) as plain text: store them as sealed values and write only the sealed reference.",
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_upload_write: {
    name: "knowledge_upload_write",
    groups: ["edit", "assets"],
    description:
      "Send the next chunk of an upload as base64 at the current byte offset. Returns the next offset.",
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_upload_finish: {
    name: "knowledge_upload_finish",
    groups: ["edit", "assets"],
    description:
      "Finish an upload after all bytes are written; the server verifies size and hash. Then reference the uploadId from knowledge_assets_put or an assetPut change.",
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_assets_put: {
    name: "knowledge_assets_put",
    groups: ["assets"],
    description:
      "Add a finished upload as an asset at a path. Pass the baseRevision you read and an idempotencyKey. Write access commits to main; propose-only access commits to your automatic pull request.",
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_assets_import: {
    name: "knowledge_assets_import",
    groups: ["assets"],
    description:
      "Copy an existing asset, by sha256 hash at a given revision, from a knowledge base you can read into this one at a path. Same commit rules as knowledge_assets_put.",
    minimumAccess: { kind: "propose_or_write" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_assets_list: {
    name: "knowledge_assets_list",
    groups: ["assets"],
    description:
      "List assets with their path, hash, size and MIME type. Reads main unless rev pins a commit. Paginated: pass nextCursor back as cursor.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_export_prepare: {
    name: "knowledge_export_prepare",
    groups: ["export"],
    description:
      'Prepare a ZIP export: kind "whole" for documents and assets, or "assets" for assets only. Returns a transferId to read with knowledge_transfer_read and release with knowledge_export_complete.',
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_transfer_read: {
    name: "knowledge_transfer_read",
    groups: ["export"],
    description:
      "Read a prepared export as base64 chunks from a byte offset. Repeat with nextOffset until eof is true.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_export_complete: {
    name: "knowledge_export_complete",
    groups: ["export"],
    description: "Release a prepared export after you finish reading it.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_index_status: {
    name: "knowledge_index_status",
    groups: ["index_admin"],
    description:
      "Show whether the search index is current: indexed commit versus head, build state, freshness and any error code.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_index_rebuild: {
    name: "knowledge_index_rebuild",
    groups: ["index_admin"],
    description: 'Request a full rebuild of the search index. Requires confirm "RUN".',
    minimumAccess: { kind: "permission", bit: "manage" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
    confirm: "RUN",
  },
  knowledge_embedding_profile_get: {
    name: "knowledge_embedding_profile_get",
    groups: ["index_admin"],
    description:
      "Show the embedding provider and revision used for semantic search, with the index status.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_embedding_profile_set: {
    name: "knowledge_embedding_profile_set",
    groups: ["index_admin"],
    description:
      'Switch the embedding provider, which rebuilds the search index. Pass a registered providerId with its revision, or providerId "builtin" for the built-in model (revision optional). Requires confirm "RUN".',
    minimumAccess: { kind: "permission", bit: "manage" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
    confirm: "RUN",
  },
  knowledge_pull_requests_list: {
    name: "knowledge_pull_requests_list",
    groups: ["pull_requests"],
    description:
      "List pull requests, optionally filtered by status (OPEN, CONFLICT, CLOSED, MERGED). Paginated: pass nextCursor back as cursor.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_pull_requests_get: {
    name: "knowledge_pull_requests_get",
    groups: ["pull_requests"],
    description:
      "Get one pull request with its before/after Markdown diff and touched assets. The diff is paged; fetch every page before reviewing.",
    minimumAccess: { kind: "permission", bit: "read" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
  knowledge_pull_requests_create: {
    name: "knowledge_pull_requests_create",
    groups: ["pull_requests"],
    description:
      "Open a pull request from a branch you own into main. Pass the expected head and main SHAs and a title.",
    minimumAccess: { kind: "permission", bit: "propose" },
    requiredMcpScope: "mcp:write",
    readOnly: false,
  },
  knowledge_pull_requests_review: {
    name: "knowledge_pull_requests_review",
    groups: ["pull_requests"],
    description:
      'Merge or close a pull request. Merging needs review permission, confirm "MERGE" and the head and target SHAs from the diff you reviewed. Closing needs confirm "CLOSE"; an author with propose access may close their own, from any of their credentials.',
    minimumAccess: {
      kind: "any_of",
      of: [{ kind: "permission", bit: "review" }, { kind: "author_with_propose" }],
    },
    requiredMcpScope: "mcp:write",
    readOnly: false,
    decisionVariants: [
      {
        decision: "merge",
        minimumAccess: { kind: "permission", bit: "review" },
        confirm: "MERGE",
      },
      {
        decision: "close",
        minimumAccess: {
          kind: "any_of",
          of: [{ kind: "permission", bit: "review" }, { kind: "author_with_propose" }],
        },
        confirm: "CLOSE",
      },
    ],
  },
  knowledge_sealed_resolve: {
    name: "knowledge_sealed_resolve",
    groups: ["sealed"],
    description:
      "Resolve a sealed-value reference found in a document into ciphertext encrypted for your approved recipient key. Plaintext is never returned.",
    minimumAccess: { kind: "sealed_grant" },
    requiredMcpScope: "mcp:read",
    readOnly: true,
  },
};

export function assertCatalogMatchesSchemas(): void {
  const schemaNames = new Set([
    ...Object.keys(kbReadToolSchemas),
    ...Object.keys(kbWriteToolSchemas),
  ]);
  const catalogNames = new Set(KB_TOOL_NAMES);
  if (schemaNames.size !== catalogNames.size) {
    throw new Error("catalog/schema tool count mismatch");
  }
  for (const name of KB_TOOL_NAMES) {
    if (!schemaNames.has(name)) {
      throw new Error(`missing schema for catalog tool ${name}`);
    }
  }
  for (const name of schemaNames) {
    if (!catalogNames.has(name as KbToolName)) {
      throw new Error(`schema without catalog row: ${name}`);
    }
  }
}

export function assertForbiddenNamesAbsent(): void {
  for (const name of KB_TOOL_NAMES) {
    if (name.includes("share")) {
      throw new Error(`control-plane share tool must not appear in catalog: ${name}`);
    }
    if (name.includes("transfer") && name !== "knowledge_transfer_read") {
      throw new Error(`control-plane transfer tool must not appear in catalog: ${name}`);
    }
    for (const fragment of FORBIDDEN_TOOL_NAME_FRAGMENTS) {
      if (name.includes(fragment)) {
        throw new Error(`forbidden tool name fragment ${fragment} in ${name}`);
      }
    }
  }
}

export function assertWriteToolsRequireMcpWrite(): void {
  for (const entry of Object.values(KB_TOOL_CATALOG)) {
    if (!entry.readOnly && entry.requiredMcpScope !== "mcp:write") {
      throw new Error(`write tool ${entry.name} must require mcp:write`);
    }
  }
}

/**
 * Every tool lists known groups at most once, in KB_TOOL_GROUPS order; every
 * group governs at least one tool; supporting (group-less) tools are reads.
 */
export function assertToolGroupsWellFormed(): void {
  const governed = new Set<KbToolGroup>();
  for (const entry of Object.values(KB_TOOL_CATALOG)) {
    const order = entry.groups.map((group) => KB_TOOL_GROUPS.indexOf(group));
    if (order.some((index, i) => index < 0 || (i > 0 && index <= (order[i - 1] ?? -1)))) {
      throw new Error(`tool ${entry.name} must list known groups once, in KB_TOOL_GROUPS order`);
    }
    if (entry.groups.length === 0 && !entry.readOnly) {
      throw new Error(`supporting tool ${entry.name} must be read-only`);
    }
    for (const group of entry.groups) governed.add(group);
  }
  for (const group of KB_TOOL_GROUPS) {
    if (!governed.has(group)) throw new Error(`tool group ${group} governs no tool`);
  }
}

/**
 * Decision-variant tools must describe every operation exactly: the fixed
 * top-level confirm is replaced by per-decision authority and confirmation.
 */
export function assertDecisionVariantsWellFormed(): void {
  for (const entry of Object.values(KB_TOOL_CATALOG)) {
    if (entry.decisionVariants === undefined) continue;
    if (entry.confirm !== undefined) {
      throw new Error(`decision-variant tool ${entry.name} must not carry a fixed confirm`);
    }
    if (entry.decisionVariants.length === 0) {
      throw new Error(`decision-variant tool ${entry.name} lists no decisions`);
    }
    const decisions = new Set(entry.decisionVariants.map((variant) => variant.decision));
    if (decisions.size !== entry.decisionVariants.length) {
      throw new Error(`decision-variant tool ${entry.name} repeats a decision`);
    }
  }
}

/** Binding inventory and logical audit classification; no executable router gateway. */
export const KB_TOOL_BINDINGS: Record<
  KbToolName,
  { domain: string; rpc: string | null; audit: string }
> = {
  knowledge_bases_list: { domain: "bases.listKnowledgeBases", rpc: "kbs.list", audit: "read-only" },
  knowledge_bases_get: {
    domain: "bases.getKnowledgeBaseAttachment + index-status.getIndexProfile",
    rpc: "kbs.get",
    audit: "read-only",
  },
  knowledge_bases_create: {
    domain: "bases.createKnowledgeBaseAsGrant",
    rpc: "kbs.create",
    audit: "kb_create",
  },
  knowledge_bases_update: {
    domain: "bases.updateKnowledgeBase",
    rpc: "kbs.update",
    audit: "kb_update",
  },
  knowledge_bases_delete: {
    domain: "bases.deleteKnowledgeBase",
    rpc: "kbs.delete",
    audit: "kb_tombstone",
  },
  knowledge_documents_list: {
    domain: "documents-read.listDocumentsAtRevision",
    rpc: "documents.list",
    audit: "read-only",
  },
  knowledge_documents_get: {
    domain: "documents-read.readDocumentAtRevision",
    rpc: "documents.get",
    audit: "read-only",
  },
  knowledge_search: {
    domain: "search.searchKnowledgeBase",
    rpc: "search.hybrid",
    audit: "read-only",
  },
  knowledge_structured_search: {
    domain: "structured-search.structuredSearchKnowledgeBase",
    rpc: "search.structured",
    audit: "read-only",
  },
  knowledge_changes_apply: {
    domain: "changes.createChangesPublication",
    rpc: null,
    audit: "changes_apply; proposal: pr_create/pr_source_advance; noop: receipt only",
  },
  knowledge_documents_create: {
    domain: "changes.changesPublicationForDocument",
    rpc: "documents.create",
    audit: "changes_apply; proposal: pr_create/pr_source_advance",
  },
  knowledge_documents_update: {
    domain: "changes.changesPublicationForDocument",
    rpc: "documents.update",
    audit: "changes_apply; proposal: pr_create/pr_source_advance",
  },
  knowledge_documents_delete: {
    domain: "changes.changesPublicationForDocument",
    rpc: "documents.delete",
    audit: "changes_apply; proposal: pr_create/pr_source_advance",
  },
  knowledge_upload_begin: {
    domain: "uploads.uploadBegin",
    rpc: "kbUploads.begin",
    audit: "staging receipt; content publication audited by changes_apply",
  },
  knowledge_upload_write: {
    domain: "uploads.uploadWrite",
    rpc: "kbUploads.write",
    audit: "staging continuation; content publication audited by changes_apply",
  },
  knowledge_upload_finish: {
    domain: "uploads.uploadFinish",
    rpc: "kbUploads.finish",
    audit: "staging completion; content publication audited by changes_apply",
  },
  knowledge_assets_put: {
    domain: "assets.mutateAsset(put)",
    rpc: "kbAssets.put",
    audit: "changes_apply",
  },
  knowledge_assets_import: {
    domain: "assets.mutateAsset(import)",
    rpc: "kbAssets.import",
    audit: "changes_apply",
  },
  knowledge_assets_list: { domain: "assets.listAssets", rpc: "kbAssets.list", audit: "read-only" },
  knowledge_export_prepare: {
    domain: "exports.prepareExport",
    rpc: "kbExports.prepare",
    audit: "read-only KB; export_prepare artifact",
  },
  knowledge_transfer_read: {
    domain: "transfers.readTransfer",
    rpc: "kbExports.read",
    audit: "read-only",
  },
  knowledge_export_complete: {
    domain: "transfers.completeExport",
    rpc: "kbExports.complete",
    audit: "read-only KB; releases the actor's own export artifact",
  },
  knowledge_index_status: {
    domain: "index-status.getIndexProfile",
    rpc: "kbIndex.status",
    audit: "read-only",
  },
  knowledge_index_rebuild: {
    domain: "generations.requestIndexBuild",
    rpc: "kbIndex.rebuild",
    audit: "generation_retry",
  },
  knowledge_embedding_profile_get: {
    domain: "index-status.getIndexProfile",
    rpc: "kbIndex.profile",
    audit: "read-only",
  },
  knowledge_embedding_profile_set: {
    domain: "generations.requestIndexBuild",
    rpc: "kbIndex.setProfile",
    audit: "provider_attach",
  },
  knowledge_pull_requests_list: {
    domain: "pull-requests.listPullRequests",
    rpc: "pullRequests.list",
    audit: "read-only",
  },
  knowledge_pull_requests_get: {
    domain: "pull-requests.getPullRequest",
    rpc: "pullRequests.get",
    audit: "read-only",
  },
  knowledge_pull_requests_create: {
    domain: "pull-requests.mutatePullRequest(create)",
    rpc: "pullRequests.create",
    audit: "pr_create",
  },
  knowledge_pull_requests_review: {
    domain: "pull-requests.mutatePullRequest(review)",
    rpc: "pullRequests.review",
    audit: "pr_merge/pr_close",
  },
  knowledge_sealed_resolve: {
    domain: "sealed-resolve.resolveSealedReference",
    rpc: null,
    audit: "read-only; recipient ciphertext only",
  },
};
