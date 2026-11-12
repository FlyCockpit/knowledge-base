/**
 * Audit map: every operation the application exposes — oRPC leaves, MCP tools,
 * durable job kinds, BullMQ queues and non-RPC HTTP/operator surfaces — is either tied to
 * named audit events (one logical event per operation finalize; execution attempts carry
 * their own attempt/job id) or explicitly classified. Coverage tests enumerate the actual
 * registries (router AST inventory, tool catalog, Prisma enum, QUEUE_NAMES) against this
 * map, so a new unclassified operation fails CI. Reads are never body-logged.
 */

export type AuditClassification =
  | {
      class: "audited";
      events: readonly string[];
      /** Source template producing a derived event name (e.g. `MIRROR_${action}_REQUEST`). */
      derivedFrom?: string;
    }
  | { class: "read-only"; events?: undefined; derivedFrom?: undefined }
  | {
      /** Mutates only non-KB, per-user or operator state outside the KB audit trail. */
      class: "out-of-band";
      reason: string;
      events?: undefined;
      derivedFrom?: undefined;
    };

const audited = (...events: string[]): AuditClassification => ({ class: "audited", events });
const read: AuditClassification = { class: "read-only" };
const outOfBand = (reason: string): AuditClassification => ({ class: "out-of-band", reason });

const CHANGES = audited("changes_apply", "pr_create", "pr_source_advance");
const UPLOAD = audited("upload_begin", "upload_finish");
const MIRROR_REQUEST: AuditClassification = {
  class: "audited",
  events: ["mirror_push_request", "mirror_activate_request"],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source template the coverage test matches.
  derivedFrom: "`MIRROR_${action}_REQUEST`",
};

export const AUDIT_MAP: Readonly<Record<string, AuditClassification>> = {
  // --- oRPC leaves -------------------------------------------------------------------
  "rpc:appConfig": read,
  "rpc:health.check": read,
  "rpc:auth.passwordCapabilities": read,
  "rpc:auth.verifyEmailTransport": read,
  "rpc:auth.updateLocale": outOfBand("per-user browser preference"),
  "rpc:cliCredentials.selectDeviceIntent": audited("device_approve", "device_deny"),
  "rpc:cliCredentials.exchangeDeviceCode": audited("pat_mint"),
  "rpc:cliCredentials.registerDeviceRecipient": outOfBand(
    "pending device public-key descriptor only; grants no capability; subsequent human approval and PAT mint are audited",
  ),
  "rpc:documents.list": read,
  "rpc:documents.get": read,
  "rpc:documents.create": CHANGES,
  "rpc:documents.update": CHANGES,
  "rpc:documents.delete": CHANGES,
  "rpc:embeddingProviders.create": audited("provider_create"),
  "rpc:embeddingProviders.probe": audited("provider_probe"),
  "rpc:embeddingProviders.revoke": audited("provider_revoke"),
  "rpc:embeddingProviders.listMine": read,
  "rpc:embeddingProviders.listSystem": read,
  "rpc:kbAssets.put": audited("changes_apply"),
  "rpc:kbAssets.import": audited("changes_apply"),
  "rpc:kbAssets.list": read,
  "rpc:kbExports.prepare": audited("export_prepare"),
  "rpc:kbExports.read": read,
  "rpc:kbExports.complete": read,
  "rpc:kbIndex.status": read,
  "rpc:kbIndex.profile": read,
  "rpc:kbIndex.rebuild": audited("generation_retry"),
  "rpc:kbIndex.setProfile": audited("provider_attach"),
  "rpc:kbIndex.settings": read,
  "rpc:kbIndex.chunkCeiling": read,
  "rpc:kbIndex.setQuantization": audited("index_quantization_set"),
  "rpc:kbIndex.setChunkLimit": audited("index_chunk_limit_set"),
  "rpc:kbIndex.setChunkCeiling": audited("index_chunk_ceiling_set"),
  "rpc:kbMirror.status": read,
  "rpc:kbMirror.configure": audited("mirror_configure"),
  "rpc:kbMirror.rotate": audited("mirror_rotate"),
  "rpc:kbMirror.disconnect": audited("mirror_disconnect"),
  "rpc:kbMirror.activate": MIRROR_REQUEST,
  "rpc:kbMirror.push": MIRROR_REQUEST,
  "rpc:kbModel.status": read,
  "rpc:kbModel.attachedKnowledgeBases": read,
  "rpc:kbModel.enable": audited("model_enable"),
  "rpc:kbModel.disable": audited("model_disable"),
  "rpc:kbModel.remove": audited("model_remove"),
  "rpc:kbModel.setRuntimeConfig": audited("model_runtime_config"),
  "rpc:kbSealed.enroll": audited("sealed_enroll"),
  "rpc:kbSealed.grant": audited("sealed_grant"),
  "rpc:kbSealed.revoke": audited("sealed_revoke"),
  "rpc:kbUploads.begin": UPLOAD,
  "rpc:kbUploads.write": UPLOAD,
  "rpc:kbUploads.finish": UPLOAD,
  "rpc:kbs.list": read,
  "rpc:kbs.get": read,
  "rpc:kbs.create": audited("kb_create"),
  "rpc:kbs.update": audited("kb_update"),
  "rpc:kbs.delete": audited("kb_tombstone"),
  "rpc:kbs.shareList": read,
  "rpc:kbs.shareInvite": audited("share_invite"),
  "rpc:kbs.shareAccept": audited("share_accept"),
  "rpc:kbs.shareRevoke": audited("share_revoke"),
  "rpc:kbs.shareUpdate": audited("share_update"),
  "rpc:kbs.shareSetSealedValues": audited("share_sealed_values_set"),
  "rpc:kbs.transferRequest": audited("transfer_request"),
  "rpc:kbs.transferAccept": audited("transfer_accept", "transfer_former_owner_share"),
  "rpc:mcpConsent.prepare": read,
  "rpc:mcpConsent.approve": audited("MCP_CONSENT_APPROVED", "MCP_GRANT_ELEVATION_ENDED"),
  "rpc:mcpGrants.listMine": read,
  "rpc:mcpGrants.listAclMine": read,
  "rpc:mcpGrants.updateMine": audited(
    "MCP_GRANT_WIDENED",
    "MCP_GRANT_NARROWED",
    "MCP_GRANT_ELEVATED",
    "MCP_GRANT_ELEVATION_ENDED",
  ),
  "rpc:mcpGrants.endElevationMine": audited("MCP_GRANT_ELEVATION_ENDED"),
  "rpc:mcpGrants.countActiveMine": read,
  "rpc:mcpGrants.revokeMine": audited("grant_revoke"),
  "rpc:mcpGrants.revokeAllMine": audited("grant_revoke"),
  "rpc:mcpTokens.create": audited("pat_mint"),
  "rpc:mcpTokens.listMine": read,
  "rpc:mcpTokens.revokeMine": audited("pat_revoke"),
  "rpc:pullRequests.list": read,
  "rpc:pullRequests.get": read,
  "rpc:pullRequests.conflicts": read,
  "rpc:pullRequests.forDocument": read,
  "rpc:pullRequests.create": audited("pr_create"),
  "rpc:pullRequests.review": audited("pr_merge", "pr_close"),
  "rpc:push.subscribe": outOfBand("per-user web push subscription"),
  "rpc:push.unsubscribe": outOfBand("per-user web push subscription"),
  "rpc:push.send": outOfBand("instance notification broadcast; no KB effect"),
  "rpc:push.vapidPublicKey": read,
  "rpc:queue.backupStatus": read,
  "rpc:queue.enqueueEcho": outOfBand("instance diagnostics"),
  "rpc:queue.getJob": read,
  "rpc:queue.listFailed": read,
  "rpc:queue.auditExport": read,
  "rpc:search.hybrid": read,
  "rpc:search.structured": read,
  "rpc:settings.getAll": read,
  "rpc:settings.adminSetupStatus": read,
  "rpc:settings.myNotificationPreferences": read,
  "rpc:settings.updateMyNotificationPreferences": outOfBand("per-user preference"),
  "rpc:settings.update": outOfBand(
    "instance settings; grant sweeps it triggers are audited as grant_revoke",
  ),
  "rpc:users.list": read,
  "rpc:users.invite": outOfBand("Better Auth admin invitation (instance administration)"),
  "rpc:users.setRole": outOfBand("Better Auth admin role (instance administration)"),
  "rpc:users.archive": outOfBand(
    "Better Auth ban; grant suspension/revocation it triggers is audited as grant_revoke",
  ),
  "rpc:users.unarchive": outOfBand("ban lift; never resurrects revoked grants"),
  "rpc:users.remove": audited("account_remove", "kb_tombstone"),
  "rpc:users.removeForce": audited("account_remove", "kb_tombstone"),

  // --- MCP tools (kb/1 data plane) -----------------------------------------------------
  "mcp:knowledge_bases_list": read,
  "mcp:knowledge_bases_get": read,
  "mcp:knowledge_bases_create": audited("kb_create"),
  "mcp:knowledge_bases_update": audited("kb_update"),
  "mcp:knowledge_bases_delete": audited("kb_tombstone"),
  "mcp:knowledge_documents_list": read,
  "mcp:knowledge_documents_get": read,
  "mcp:knowledge_search": read,
  "mcp:knowledge_structured_search": read,
  "mcp:knowledge_changes_apply": CHANGES,
  "mcp:knowledge_documents_create": CHANGES,
  "mcp:knowledge_documents_update": CHANGES,
  "mcp:knowledge_documents_delete": CHANGES,
  "mcp:knowledge_upload_begin": UPLOAD,
  "mcp:knowledge_upload_write": UPLOAD,
  "mcp:knowledge_upload_finish": UPLOAD,
  "mcp:knowledge_assets_put": audited("changes_apply"),
  "mcp:knowledge_assets_import": audited("changes_apply"),
  "mcp:knowledge_assets_list": read,
  "mcp:knowledge_export_prepare": audited("export_prepare"),
  "mcp:knowledge_transfer_read": read,
  "mcp:knowledge_export_complete": read,
  "mcp:knowledge_index_status": read,
  "mcp:knowledge_index_rebuild": audited("generation_retry"),
  "mcp:knowledge_embedding_profile_get": read,
  "mcp:knowledge_embedding_profile_set": audited("provider_attach"),
  "mcp:knowledge_pull_requests_list": read,
  "mcp:knowledge_pull_requests_get": read,
  "mcp:knowledge_pull_requests_create": audited("pr_create"),
  "mcp:knowledge_pull_requests_review": audited("pr_merge", "pr_close"),
  "mcp:knowledge_sealed_resolve": read,

  // --- Durable job kinds (attempts are fenced; the logical event is keyed by job/epoch) --
  "job:PROBE": outOfBand("integration echo probe"),
  "job:PROVIDER_PROBE": audited("provider_probe"),
  "job:INDEX_KB": audited("generation_activate", "generation_fail"),
  "job:QUERY_EMBEDDING": read,
  "job:PUSH_MIRROR": audited("mirror_attempt"),
  "job:DOWNLOAD_MODEL": audited("model_download"),
  "job:KB_EMAIL": outOfBand("delivery of an already-audited invite/transfer"),

  // --- BullMQ queues --------------------------------------------------------------------
  "queue:echo": outOfBand("instance diagnostics"),
  "queue:seed": outOfBand("developer seed"),
  "queue:reap-expired-auth-tokens": outOfBand("credential artifact retention"),
  "queue:check-backup-freshness": read,
  "queue:notify-data-deletions": outOfBand("migration deletion notice delivery"),
  "queue:durable-probe": outOfBand("integration echo probe"),
  "queue:provider-probe": audited("provider_probe"),
  "queue:index-kb": audited("generation_activate", "generation_fail"),
  "queue:query-embedding": read,
  "queue:push-mirror": audited("mirror_attempt"),
  "queue:download-model": audited("model_download"),
  "queue:kb-email": outOfBand("delivery of an already-audited invite/transfer"),
  "queue:kb-retention": outOfBand("bounded retention"),
  "queue:kb-git-rollup": outOfBand("object compaction only; preserves all objects and refs"),

  // --- Non-RPC surfaces ----------------------------------------------------------------
  "http:git-push": audited("git_push"),
  "http:git-fetch": read,
  "http:mcp-sealed-resolve-denial": audited("sealed_resolve_denied"),
  "http:asset-download": read,
  "ops:backup": outOfBand("server image; operator log and backup heartbeat"),
  "ops:restore": outOfBand("server image; confirmed offline restore"),
};

/** Every operation the map must cover for the given actual router inventory. */
export function auditOperationsFor(input: { rpcLeaves: readonly string[] }): string[] {
  const fixed = Object.keys(AUDIT_MAP).filter((op) => !op.startsWith("rpc:"));
  return [...input.rpcLeaves.map((leaf) => `rpc:${leaf}`), ...fixed].sort();
}

/**
 * Fails on an operation with no classification and on a stale oRPC classification. The
 * fixed (tool/job/queue/HTTP) keys are checked against their registries by the tests.
 */
export function assertAuditCoverage(input: { rpcLeaves: readonly string[] }): void {
  const unclassified = input.rpcLeaves.filter((leaf) => !AUDIT_MAP[`rpc:${leaf}`]);
  if (unclassified.length > 0)
    throw new Error(`Unclassified operation(s) in the audit map: ${unclassified.join(", ")}`);
  const live = new Set(input.rpcLeaves.map((leaf) => `rpc:${leaf}`));
  const stale = Object.keys(AUDIT_MAP).filter((op) => op.startsWith("rpc:") && !live.has(op));
  if (stale.length > 0) throw new Error(`Stale audit map classification(s): ${stale.join(", ")}`);
}
