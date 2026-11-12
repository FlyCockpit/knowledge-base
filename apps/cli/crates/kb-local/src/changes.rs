//! Local atomic edits: `knowledge_changes_apply` (edit mode) and the
//! single-document wrappers `knowledge_documents_{create,update,delete}`
//! (CONTRACT "Atomic changes").
//!
//! One service, [`Store::apply_change_set`], serves all four tools:
//!
//! 1. **Upfront validation, before any effect** — shared kb/1 schema, 1..=32
//!    changes, no path named twice and no case-colliding writes, Markdown-only
//!    document paths, every inline body parsed (UTF-8, controls, front matter), total
//!    staged Markdown <= 16 MiB. READY uploads require actor/KB/kind/TTL
//!    binding; asset edits and imports share manifest and lineage validation.
//!    Then, under the store + sorted KB locks: authority, the
//!    target and its complete-HEAD `baseRevision`, per-path existence at that
//!    base (create needs absent, replace/delete need a file), and finally the
//!    shared whole-tree validator on the actual built commit. Any rejection
//!    leaves no journal row, ref, proposal row, counter or index effect
//!    (built objects stay unreachable garbage). A later retry with
//!    the same key is therefore evaluated afresh.
//! 2. **Routing** — `proposalNumber` names an active proposal the caller's
//!    actor owns (even for a write holder; unknown/closed -> NOT_FOUND,
//!    another actor's -> FORBIDDEN) and the base must be its HEAD. Otherwise
//!    a `write` holder targets main (base = main HEAD). A propose-only
//!    caller reuses its active (OPEN/CONFLICT) auto-PR (base = its HEAD) or
//!    opens the next per-KB number from current main.
//! 3. **Noop** — identical replacements only: a FINALIZED receipt with the
//!    exact `ApplyResult` (commitSha = target head, no commit/PR/number/
//!    index intent). An empty edit is INVALID_ARGUMENT.
//! 4. **Publication** — the PREPARED row is inserted complete (intended
//!    SHA, validated tree, delta, replay response), objects are fsynced,
//!    authority is rechecked and the target ref confirmed under the locks,
//!    COMMITTING is recorded, the single ref CAS runs, and one transaction
//!    finalizes: main head + desired-index epoch for main, or the proposal
//!    row / branch owner / number counter for a proposal (never an index
//!    effect). Recovery (`recovery.rs`) resolves a crash from the row's own
//!    ref.
//!
//! Replays recheck live authority (propose) before returning the stored
//! `ApplyResult` or stable failure. A profiled main publication uses its
//! operation UUID as the durable index job ID; proposals/noops never enqueue.
//!
//! Dream mode ([`crate::dream`]) is the same service: its
//! request checks run with the upfront validation, and its upserts are
//! planned against the doc-ID map of the pinned base (after routing, under
//! the locks) into create/replace edits, so every rule above — one commit,
//! optional one PR, zero effects on rejection, identical = noop — applies
//! unchanged. A proposed dream also carries its merged metadata + merge-guard
//! input in the proposal delta, persisted in the finalize transaction.

use std::collections::HashSet;

use kb_client::types::{
    ApplyKind, ApplyResult, Change, ChangesApply, ChangesApplyInput, ChangesMode,
    DocumentWriteInput, DocumentsCreate, DocumentsDelete, DocumentsDeleteInput, DocumentsUpdate,
    DreamMetadata, KbId, KbPath, Permission, Sha, TextInput, Uuid,
};
use ring::digest::{SHA1_FOR_LEGACY_USE_ONLY, digest};
use serde_json::Value;

use crate::assets::AssetDelta;
use crate::bases::check_input;
use crate::git_read::GitRepo;
use crate::git_write::{self, MAIN_REF, ObjectWriter, Scratch, TreeEdit};
use crate::journal::{
    Delta, Observer, Phase, Stage, code_from, commit_message, epoch_now, parse_key, request_hash,
};
use crate::locks::WriteGuard;
use crate::logical_merge::Kind;
use crate::manifest::{self, Policy};
use crate::markdown::{MarkdownIssueCode, parse_markdown};
use crate::pr_merge::ConflictItem;
use crate::proposals::{PrRow, ProposalDelta, proposal_ref};
use crate::state::{LocalPrincipal, new_uuid_v4, now_utc};
use crate::store::{Store, StoreError, constraint_to_conflict};
use crate::tree::{TreeError, validate_commit};
use kb_client::error::InvalidReason;

/// Maximum changes in one change set (CONTRACT: 32 operations).
pub const MAX_CHANGE_SET: usize = 32;
/// Total staged Markdown bytes of one change set (CONTRACT: 16 MiB).
pub const STAGED_MARKDOWN_MAX_BYTES: usize = 16 * 1024 * 1024;

const OP_CHANGES: &str = "CHANGES_APPLY";
const OP_DOC_CREATE: &str = "DOCUMENT_CREATE";
const OP_DOC_UPDATE: &str = "DOCUMENT_UPDATE";
const OP_DOC_DELETE: &str = "DOCUMENT_DELETE";

// ── Request model ───────────────────────────────────────────────────────────

/// One change set, as every entry point hands it to the shared service.
pub(crate) struct ChangeSet {
    pub(crate) operation: &'static str,
    pub(crate) kb: KbId,
    pub(crate) base: Sha,
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) proposal_number: Option<u64>,
    /// The PR head the caller read (precondition, server parity).
    pub(crate) proposal_head_sha: Option<Sha>,
    pub(crate) changes: Vec<Change>,
    pub(crate) source_session_ids: Vec<Uuid>,
    /// Dream mode: `changes` is empty and the edits come from the upserts.
    pub(crate) dream: Option<DreamMetadata>,
    pub(crate) hash: String,
    pub(crate) import: Option<(KbPath, kb_client::types::AssetSource)>,
}

/// A validated document edit: bytes to put, or `None` to delete.
struct Edit {
    /// JSON pointer of this change's member in the request (`field`).
    field: Option<String>,
    path: KbPath,
    kind: EditKind,
    /// Inline bytes; `None` for a delete or a not-yet-resolved upload.
    bytes: Option<Vec<u8>>,
    upload: Option<Uuid>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Create,
    Replace,
    Delete,
}

/// Where the change set publishes.
enum Target {
    Main,
    Proposal(Box<PrRow>),
    NewProposal(u64),
}

/// How a request against current main reaches an open proposal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    /// The request's base is the target's head: an ordinary edit.
    None,
    /// Main moved past the PR: replay it onto main (the move is the change).
    OntoMain,
    /// The PR sits on main with recorded conflicts: resolve some of them.
    Resolve,
    /// The PR sits on main with none recorded: apply on its head.
    OnHead,
}

pub(crate) fn hash_of(operation: &str, value: Value) -> String {
    let mut value = value;
    if let Value::Object(map) = &mut value {
        map.remove("idempotencyKey");
    }
    request_hash(&[
        format!("kb-local/{operation}/v1").as_bytes(),
        value.to_string().as_bytes(),
    ])
}

fn is_markdown_path(path: &KbPath) -> bool {
    path.as_str().ends_with(".md")
}

/// Git blob object ID of `bytes` (SHA-1 repositories).
fn blob_sha(bytes: &[u8]) -> String {
    let mut framed = format!("blob {}\0", bytes.len()).into_bytes();
    framed.extend_from_slice(bytes);
    digest(&SHA1_FOR_LEGACY_USE_ONLY, &framed)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn check_markdown(bytes: &[u8], field: Option<String>) -> Result<(), StoreError> {
    parse_markdown(bytes)
        .map(|_| ())
        .map_err(|issue| StoreError::invalid(markdown_reason(issue.code), field, issue.message))
}

/// Reason of a Markdown rejection.
fn markdown_reason(code: MarkdownIssueCode) -> InvalidReason {
    match code {
        MarkdownIssueCode::Control => InvalidReason::ControlCharacter,
        MarkdownIssueCode::Utf8 => InvalidReason::InvalidMarkdown,
        _ => InvalidReason::InvalidFrontMatter,
    }
}

/// The request pointer of change `index`'s `leaf` member: `/changes/<i>/…`
/// for `knowledge_changes_apply`, `/…` for the single-document tools.
fn change_field(set: &ChangeSet, index: usize, leaf: &str) -> Option<String> {
    if set.dream.is_some() {
        return None;
    }
    Some(if set.operation == OP_CHANGES {
        format!("/changes/{index}/{leaf}")
    } else {
        format!("/{leaf}")
    })
}

/// Reason + field of a whole-tree verdict on the candidate commit.
fn tree_rejection(set: &ChangeSet, violation: crate::tree::TreeViolation) -> StoreError {
    use crate::tree::TreeCode;
    let index = violation.path.as_deref().and_then(|path| {
        set.changes.iter().position(|change| {
            let changed = match change {
                Change::Create { path, .. }
                | Change::Replace { path, .. }
                | Change::Delete { path }
                | Change::AssetPut { path, .. }
                | Change::AssetRemove { path } => path,
            };
            // Case-fold match: a collision may be reported on the existing
            // spelling rather than the changed one.
            kb_client::casefold_path_key(changed.as_str()) == kb_client::casefold_path_key(path)
        })
    });
    let reason = match violation.code {
        _ if violation.cause.is_some() => violation.cause.unwrap_or(InvalidReason::Schema),
        TreeCode::Path if violation.message.starts_with("path case-folds") => {
            InvalidReason::PathCaseCollision
        }
        TreeCode::Path => match violation.path.as_deref().map(kb_client::check_kb_path) {
            Some(Err(
                kb_client::PathIssue::GitReserved | kb_client::PathIssue::WindowsReserved,
            )) => InvalidReason::ReservedPath,
            _ => InvalidReason::InvalidPath,
        },
        TreeCode::Markdown => InvalidReason::InvalidMarkdown,
        TreeCode::DocumentId => InvalidReason::DuplicateDocumentId,
        TreeCode::Sealed => InvalidReason::SealedReferenceRevoked,
        TreeCode::Budget => InvalidReason::TooLarge,
        _ => InvalidReason::Schema,
    };
    let leaf = if matches!(
        reason,
        InvalidReason::InvalidMarkdown
            | InvalidReason::InvalidFrontMatter
            | InvalidReason::DuplicateDocumentId
            | InvalidReason::SealedReferenceRevoked
    ) || (violation.code == TreeCode::Markdown
        && reason == InvalidReason::ControlCharacter)
    {
        "content"
    } else {
        "path"
    };
    StoreError::invalid(
        reason,
        index.and_then(|i| change_field(set, i, leaf)),
        violation.message,
    )
}

/// Pure, lock-free validation of the whole batch (step 1 of the module
/// docs, first half).
fn validate_edits(set: &ChangeSet) -> Result<(Vec<Edit>, Vec<AssetChangeOwned>), StoreError> {
    if let Some(dream) = &set.dream {
        if !set.changes.is_empty() {
            return Err(StoreError::InvalidArgument(
                "dream mode requires empty changes".into(),
            ));
        }
        let title = set.title.chars().count();
        if !(1..=200).contains(&title) {
            return Err(StoreError::InvalidArgument("title".into()));
        }
        crate::dream::validate_request(&set.title, &set.source_session_ids, dream)?;
        return Ok((Vec::new(), Vec::new()));
    }
    if let Some((path, source)) = &set.import {
        return Ok((
            Vec::new(),
            vec![AssetChangeOwned::Import(path.clone(), source.clone())],
        ));
    }
    if set.changes.is_empty() {
        return Err(StoreError::InvalidArgument(
            "edit mode requires at least one change".into(),
        ));
    }
    if set.changes.len() > MAX_CHANGE_SET {
        return Err(StoreError::invalid(
            InvalidReason::TooManyChanges,
            Some("/changes".into()),
            "at most 32 changes",
        ));
    }
    let title = set.title.chars().count();
    if !(1..=200).contains(&title) {
        return Err(StoreError::InvalidArgument("title".into()));
    }
    let mut sessions = HashSet::new();
    if set.source_session_ids.len() > 100
        || !set.source_session_ids.iter().all(|id| sessions.insert(id))
    {
        return Err(StoreError::InvalidArgument("sourceSessionIds".into()));
    }
    let mut seen = HashSet::new();
    let mut named = HashSet::new();
    let mut edits = Vec::new();
    let mut assets = Vec::new();
    let mut staged = 0usize;
    for (index, change) in set.changes.iter().enumerate() {
        let path = match change {
            Change::Create { path, .. }
            | Change::Replace { path, .. }
            | Change::Delete { path }
            | Change::AssetPut { path, .. }
            | Change::AssetRemove { path } => path,
        };
        // One path once per kind; removals may meet any case variant (a case
        // clash is resolved by removing one side), writes may not (their
        // result would collide). Same rule as the server.
        let asset = matches!(change, Change::AssetPut { .. } | Change::AssetRemove { .. });
        let removal = matches!(change, Change::Delete { .. } | Change::AssetRemove { .. });
        if !named.insert((asset, path.as_str().to_owned()))
            || (!removal && !seen.insert(kb_client::casefold_path_key(path.as_str())))
        {
            return Err(StoreError::invalid(
                InvalidReason::PathCaseCollision,
                change_field(set, index, "path"),
                "duplicate or case-colliding path",
            ));
        }
        let (kind, content) = match change {
            Change::Create { content, .. } => (EditKind::Create, Some(content)),
            Change::Replace { content, .. } => (EditKind::Replace, Some(content)),
            Change::Delete { .. } => (EditKind::Delete, None),
            Change::AssetPut { path, upload_id } => {
                assets.push(AssetChangeOwned::Put(path.clone(), upload_id.clone()));
                continue;
            }
            Change::AssetRemove { path } => {
                assets.push(AssetChangeOwned::Remove(
                    path.clone(),
                    change_field(set, index, "path"),
                ));
                continue;
            }
        };
        // A reserved root file or anything under `.assets/` (case-folded) is
        // never a document, whatever its extension (server parity).
        if is_reserved_document_path(path.as_str()) {
            return Err(StoreError::invalid(
                InvalidReason::ReservedPath,
                change_field(set, index, "path"),
                "the path is reserved for the knowledge base itself",
            ));
        }
        if !is_markdown_path(path) {
            return Err(StoreError::invalid(
                InvalidReason::NotMarkdownPath,
                change_field(set, index, "path"),
                "only markdown document paths are supported",
            ));
        }
        let (bytes, upload) = match content {
            None => (None, None),
            Some(TextInput::Markdown(inline)) => {
                let bytes = inline.markdown.as_bytes().to_vec();
                check_markdown(&bytes, change_field(set, index, "content/markdown"))?;
                staged = staged.saturating_add(bytes.len());
                (Some(bytes), None)
            }
            Some(TextInput::Upload(upload)) => (None, Some(upload.upload_id.clone())),
        };
        edits.push(Edit {
            field: change_field(set, index, "path"),
            path: path.clone(),
            kind,
            bytes,
            upload,
        });
    }
    if staged > STAGED_MARKDOWN_MAX_BYTES {
        return Err(StoreError::InvalidArgument(
            "staged markdown exceeds 16 MiB".into(),
        ));
    }
    Ok((edits, assets))
}

enum AssetChangeOwned {
    Put(KbPath, Uuid),
    /// The path and the pointer of the change naming it (field).
    Remove(KbPath, Option<String>),
    Import(KbPath, kb_client::types::AssetSource),
}

impl Store {
    // ── Entry points ───────────────────────────────────────────────────────

    /// `knowledge_changes_apply` (edit mode; see module docs).
    pub fn changes_apply(
        &self,
        principal: &LocalPrincipal,
        input: ChangesApplyInput,
    ) -> Result<ApplyResult, StoreError> {
        self.changes_apply_observed(principal, input, &mut |_| Ok(()))
    }

    /// [`Store::changes_apply`] with a stage observer (crash/fault seam).
    #[doc(hidden)]
    pub fn changes_apply_observed(
        &self,
        principal: &LocalPrincipal,
        mut input: ChangesApplyInput,
        observer: Observer<'_>,
    ) -> Result<ApplyResult, StoreError> {
        check_input::<ChangesApply>(&input)?;
        let dream = match (input.mode, input.dream.clone()) {
            (ChangesMode::Edit, None) => None,
            (ChangesMode::Dream, Some(dream)) => Some(dream),
            _ => {
                return Err(StoreError::InvalidArgument(
                    "dream metadata is required in dream mode only".into(),
                ));
            }
        };
        let title = input
            .title
            .clone()
            .unwrap_or_else(|| change_summary_title(&input.changes));
        // Like the server, hash the normalized edit: omitting its generated
        // title and explicitly supplying that same title are the same request.
        if input.mode == ChangesMode::Edit {
            input.title = Some(title.clone());
        }
        let hash = hash_of(OP_CHANGES, serde_json::to_value(&input).map_err(json_err)?);
        let set = ChangeSet {
            operation: OP_CHANGES,
            kb: input.kb_id,
            base: input.base_revision,
            key: input.idempotency_key.as_str().to_owned(),
            title,
            proposal_number: input.proposal_number,
            proposal_head_sha: input.proposal_head_sha.clone(),
            changes: input.changes,
            source_session_ids: input.source_session_ids,
            dream,
            hash,
            import: None,
        };
        self.apply_change_set(principal, set, observer)
    }

    /// `knowledge_documents_create`: one create edit.
    pub fn documents_create(
        &self,
        principal: &LocalPrincipal,
        input: DocumentWriteInput,
    ) -> Result<ApplyResult, StoreError> {
        check_input::<DocumentsCreate>(&input)?;
        self.document_write(principal, input, OP_DOC_CREATE)
    }

    /// `knowledge_documents_update`: one replace edit.
    pub fn documents_update(
        &self,
        principal: &LocalPrincipal,
        input: DocumentWriteInput,
    ) -> Result<ApplyResult, StoreError> {
        check_input::<DocumentsUpdate>(&input)?;
        self.document_write(principal, input, OP_DOC_UPDATE)
    }

    /// `knowledge_documents_delete`: one delete edit (`confirm: DELETE`).
    pub fn documents_delete(
        &self,
        principal: &LocalPrincipal,
        input: DocumentsDeleteInput,
    ) -> Result<ApplyResult, StoreError> {
        check_input::<DocumentsDelete>(&input)?;
        let hash = hash_of(
            OP_DOC_DELETE,
            serde_json::to_value(&input).map_err(json_err)?,
        );
        let set = ChangeSet {
            operation: OP_DOC_DELETE,
            kb: input.kb_id,
            base: input.base_revision,
            key: input.idempotency_key.as_str().to_owned(),
            title: wrapper_title(OP_DOC_DELETE, input.path.as_str()),
            proposal_number: input.proposal_number,
            proposal_head_sha: input.proposal_head_sha.clone(),
            changes: vec![Change::Delete { path: input.path }],
            source_session_ids: Vec::new(),
            dream: None,
            hash,
            import: None,
        };
        self.apply_change_set(principal, set, &mut |_| Ok(()))
    }

    fn document_write(
        &self,
        principal: &LocalPrincipal,
        input: DocumentWriteInput,
        operation: &'static str,
    ) -> Result<ApplyResult, StoreError> {
        let hash = hash_of(operation, serde_json::to_value(&input).map_err(json_err)?);
        let title = wrapper_title(operation, input.path.as_str());
        let change = if operation == OP_DOC_CREATE {
            Change::Create {
                path: input.path,
                content: input.content,
            }
        } else {
            Change::Replace {
                path: input.path,
                content: input.content,
            }
        };
        let set = ChangeSet {
            operation,
            kb: input.kb_id,
            base: input.base_revision,
            key: input.idempotency_key.as_str().to_owned(),
            title,
            proposal_number: input.proposal_number,
            proposal_head_sha: input.proposal_head_sha.clone(),
            changes: vec![change],
            source_session_ids: Vec::new(),
            dream: None,
            hash,
            import: None,
        };
        self.apply_change_set(principal, set, &mut |_| Ok(()))
    }

    // ── The shared service ─────────────────────────────────────────────────

    pub(crate) fn apply_change_set(
        &self,
        principal: &LocalPrincipal,
        set: ChangeSet,
        observer: Observer<'_>,
    ) -> Result<ApplyResult, StoreError> {
        let _deadline = crate::git_read::OperationDeadline::start();
        let key = parse_key(&set.key)?;
        let (mut edits, assets) = validate_edits(&set)?;
        let kb = set.kb.clone();
        let mut locked = vec![kb.clone()];
        if let Some((_, source)) = &set.import {
            locked.push(source.kb_id.clone());
        }
        let guard = self.lock_publication(&locked)?;
        let actor = principal.actor_key();
        // Unreadable -> NOT_FOUND, no propose -> FORBIDDEN, before any key
        // information is revealed.
        let bits = self.authorize(principal, &kb, Permission::Propose)?;
        let record = self.active_record(&kb)?;
        if let Some(known) = self.find_known(&actor, Some(&kb), set.operation, key.as_str())? {
            if known.request_hash != set.hash {
                return Err(StoreError::IdempotencyMismatch);
            }
            return match known.phase {
                Phase::Finalized => parse_apply_result(known.response.as_deref()),
                Phase::Aborted => Err(StoreError::OperationAborted(code_from(
                    known.failure.as_deref().unwrap_or(""),
                ))),
                Phase::Prepared | Phase::Committing => Err(StoreError::RecoveryRequired(format!(
                    "operation {} awaits repair",
                    known.op_id
                ))),
            };
        }
        let repo = GitRepo::for_kb(&self.paths, &kb)?;
        let main = record
            .head_sha
            .as_deref()
            .and_then(|s| Sha::parse(s).ok())
            .ok_or_else(|| StoreError::RecoveryRequired("active kb without head".into()))?;
        if git_write::read_main(&repo)?.as_ref() != Some(&main) {
            self.mark_repair(&kb)?;
            return Err(StoreError::RecoveryRequired(
                "main ref changed outside the store".into(),
            ));
        }
        let (target, step) =
            self.route(&repo, &set, &actor, bits.contains(Permission::Write), &main)?;
        let (ref_name, expected_old) = match &target {
            Target::Main => (MAIN_REF.to_owned(), Some(main.clone())),
            Target::Proposal(row) => (row.source_ref.clone(), Some(row.head_sha.clone())),
            Target::NewProposal(number) => (proposal_ref(*number), None),
        };
        if git_write::read_ref(&repo, &ref_name)? != expected_old {
            self.mark_repair(&kb)?;
            return Err(StoreError::RecoveryRequired(
                "proposal ref changed outside the store".into(),
            ));
        }
        // Dream upserts -> create/replace edits on the pinned base's doc-ID
        // map (provenance, sealed and credential checks; nothing written).
        if let Some(dream) = &set.dream {
            for planned in crate::dream::plan_upserts(&repo, &set.base, dream)? {
                check_markdown(&planned.bytes, None)?;
                edits.push(Edit {
                    field: None,
                    path: planned.path,
                    kind: if planned.exists {
                        EditKind::Replace
                    } else {
                        EditKind::Create
                    },
                    bytes: Some(planned.bytes),
                    upload: None,
                });
            }
        }
        let mut asset_delta = AssetDelta::default();
        for edit in &mut edits {
            if let Some(upload) = &edit.upload {
                let (_, bytes) = self.ready_upload(&actor, &kb, upload, "markdown")?;
                let field = edit
                    .field
                    .as_deref()
                    .map(|f| format!("{}/content", f.trim_end_matches("/path")));
                check_markdown(&bytes, field)?;
                asset_delta.upload(upload);
                edit.bytes = Some(bytes);
            }
        }
        if edits
            .iter()
            .filter_map(|e| e.bytes.as_ref())
            .map(Vec::len)
            .sum::<usize>()
            > STAGED_MARKDOWN_MAX_BYTES
        {
            return Err(StoreError::InvalidArgument(
                "staged markdown exceeds 16 MiB".into(),
            ));
        }
        // The tree this edit applies to (main for a move onto main, the
        // PR head for a resolution or an edit on it), the PR's conflicts
        // after it, and which of them this request resolves.
        let op_id = new_uuid_v4()?;
        // Planning runs in a disposable object store: merges, candidate
        // trees and commits, status checks. Only what a successful
        // publication needs is promoted into the canonical store, before
        // its PREPARED row; a rejected plan leaves the object set unchanged.
        let plan_scratch = Scratch::new(&self.paths, &op_id)?;
        let staged = repo.staged(&plan_scratch.objects_dir()?)?;
        let mut writer = ObjectWriter::new(&staged, &guard, plan_scratch);
        let row = match &target {
            Target::Proposal(row) => Some(row.as_ref().clone()),
            Target::Main | Target::NewProposal(_) => None,
        };
        let tree_rev = match (&row, step) {
            (_, Step::OntoMain) => main.clone(),
            (Some(row), Step::Resolve | Step::OnHead) => row.head_sha.clone(),
            _ => set.base.clone(),
        };
        let mut writes: HashSet<(Kind, String)> = edits
            .iter()
            .map(|e| (Kind::Document, e.path.as_str().to_owned()))
            .collect();
        for asset in &assets {
            let path = match asset {
                AssetChangeOwned::Put(path, _)
                | AssetChangeOwned::Import(path, _)
                | AssetChangeOwned::Remove(path, _) => path,
            };
            writes.insert((Kind::Asset, path.as_str().to_owned()));
        }
        let mut pending: Vec<ConflictItem> = row
            .as_ref()
            .map(|r| r.pending_conflicts.clone())
            .unwrap_or_default();
        let mut merged_tree = None;
        let mut source = crate::pr_merge::GitSource::new(&staged, &self.paths, &guard);
        let mut proposal_paths = Vec::new();
        if let Some(row) = &row {
            if set.proposal_number.is_none() || set.proposal_head_sha.is_none() {
                let merge_base = crate::pr_merge::merge_base(&repo, &main, &row.head_sha)?;
                proposal_paths = crate::pr_merge::changed_logical_paths(
                    &mut source,
                    &merge_base,
                    &row.head_sha,
                )?;
            }
            if step == Step::OntoMain {
                let merged = crate::pr_merge::merge_proposal_onto_main(
                    &mut source,
                    &main,
                    &row.head_sha,
                    true,
                    &pending,
                )?;
                // Conflicts still recorded from an earlier main stay (with the
                // revisions their saved choice lives at); new ones join. A
                // fresh finding of a recorded one as real lifts "standing".
                let found: Vec<ConflictItem> = merged
                    .conflicts
                    .iter()
                    .map(|c| {
                        match pending
                            .iter()
                            .find(|p| p.kind == c.kind && p.path == c.path)
                        {
                            Some(prior) => ConflictItem {
                                standing: prior.standing && c.standing,
                                ..prior.clone()
                            },
                            None => ConflictItem {
                                base_sha: merged.merge_base.clone(),
                                yours_sha: Some(row.head_sha.clone()),
                                ..ConflictItem::from_conflict(c)
                            },
                        }
                    })
                    .collect();
                pending = crate::pr_merge::union_conflicts(&pending, &found);
                merged_tree = Some(merged.tree);
            }
        }
        let progress = crate::logical_merge::remaining_conflicts(
            &pending,
            |c| (c.path.as_str(), c.kind, c.standing),
            |path, kind| writes.contains(&(kind, path.to_owned())),
        );
        if let Some(row) = &row {
            // One consent rule (server parity): a request
            // may overwrite a path the caller's PR changed — a plain change, a
            // fresh conflict or a recorded one, document or asset — only by
            // naming the PR with the head it read (`proposalNumber` +
            // `proposalHeadSha`, checked in `route`). Without that, every
            // such write clashes and nothing is applied.
            let mut protected: Vec<ConflictItem> = pending.clone();
            for (path, kind) in &proposal_paths {
                if !protected.iter().any(|p| p.kind == *kind && &p.path == path) {
                    protected.push(ConflictItem {
                        path: path.clone(),
                        kind: *kind,
                        standing: false,
                        base_sha: None,
                        yours_sha: None,
                    });
                }
            }
            let overwritten: Vec<ConflictItem> =
                if set.proposal_number.is_some() && set.proposal_head_sha.is_some() {
                    Vec::new()
                } else {
                    protected
                        .into_iter()
                        .filter(|p| writes.contains(&(p.kind, p.path.clone())))
                        .collect()
                };
            // A request against main must make progress on what clashes.
            if (!pending.is_empty() && progress.resolved.is_empty()) || !overwritten.is_empty() {
                let mut paths = overwritten;
                for item in &progress.unresolved {
                    if !paths
                        .iter()
                        .any(|p| p.kind == item.kind && p.path == item.path)
                    {
                        paths.push(item.clone());
                    }
                }
                return Err(crate::pr_merge::proposal_conflict_error(
                    &mut source,
                    &main,
                    &row.head_sha,
                    row.number,
                    &paths,
                )?);
            }
        }
        let resolving: HashSet<(Kind, String)> = progress
            .resolved
            .iter()
            .map(|c| (c.kind, c.path.clone()))
            .collect();
        let remaining = progress.remaining;
        let mut entries = match &merged_tree {
            Some(tree) => tree.assets.values().cloned().collect(),
            None => self.manifest_entries(&kb, &repo, &tree_rev)?,
        };
        let mut asset_paths = Vec::new();
        for asset in &assets {
            let (path, addition) = match asset {
                AssetChangeOwned::Put(path, id) => {
                    let (mut entry, _) = self.ready_upload(&actor, &kb, id, "asset")?;
                    entry.path = path.as_str().into();
                    asset_delta.upload(id);
                    asset_delta.lineages.push((entry.clone(), None));
                    (path, Some(entry))
                }
                AssetChangeOwned::Import(path, source) => {
                    let mut entry = self.import_entry(principal, source)?;
                    self.verify_asset_bytes(&entry)?;
                    entry.path = path.as_str().into();
                    asset_delta
                        .lineages
                        .push((entry.clone(), Some(source.clone())));
                    (path, Some(entry))
                }
                AssetChangeOwned::Remove(path, field) => {
                    if !entries.iter().any(|e| e.path == path.as_str())
                        && !resolving.contains(&(Kind::Asset, path.as_str().to_owned()))
                    {
                        return Err(StoreError::invalid(
                            InvalidReason::PathNotFound,
                            field.clone(),
                            "asset path does not exist",
                        ));
                    }
                    (path, None)
                }
            };
            entries.retain(|e| e.path != path.as_str());
            if let Some(entry) = addition {
                entries.push(entry);
            }
            asset_paths.push(path.clone());
        }
        self.check_lineage_quota(&kb, &asset_delta)?;
        crate::uploads::check_mutation_budget(&self.conn, &actor, kb.as_str(), self.now_ms())?;
        // All document/dream/asset wrappers converge here. Reserve headroom
        // before object/CAS scratch, then charge with the once-only intent.
        self.check_disk_admission(
            edits
                .iter()
                .filter_map(|e| e.bytes.as_ref())
                .map(|b| b.len() as u64)
                .sum::<u64>()
                + asset_delta
                    .lineages
                    .iter()
                    .map(|(e, _)| e.size)
                    .sum::<u64>(),
        )?;
        // Existence at the pinned base and identical-replacement detection.
        let mut tree = match &merged_tree {
            Some(merged) => {
                crate::pr_merge::tree_edit_for(TreeEdit::load(&repo, &main)?, &mut writer, merged)?
            }
            None => TreeEdit::load(&repo, &tree_rev)?,
        };
        let validation_base = tree.original_blobs().clone();
        let mut changed = asset_paths;
        for edit in &edits {
            let current = tree.lookup(&edit.path);
            let exists = matches!(current, Some(Ok(_)));
            // Every resolution is valid on a conflicted path whatever the
            // merged tree holds there: take either side's deletion, or
            // write the chosen version.
            let resolves = resolving.contains(&(Kind::Document, edit.path.as_str().to_owned()));
            match edit.kind {
                _ if resolves => {}
                EditKind::Create if current.is_some() => {
                    return Err(StoreError::PathExists {
                        field: edit.field.clone(),
                    });
                }
                EditKind::Replace | EditKind::Delete if !exists => {
                    return Err(StoreError::invalid(
                        InvalidReason::PathNotFound,
                        edit.field.clone(),
                        format!("path does not exist: {}", edit.path.as_str()),
                    ));
                }
                _ => {}
            }
            let identical = edit.kind == EditKind::Replace
                && matches!((current, &edit.bytes), (Some(Ok(sha)), Some(bytes)) if sha == blob_sha(bytes));
            if !identical {
                changed.push(edit.path.clone());
            }
        }
        // Resolving a recorded conflict is a change even when the chosen
        // version equals what the PR already holds ("keep mine"), and so is a
        // move onto main itself.
        for (_, path) in &resolving {
            let path = KbPath::parse(path).map_err(|_| manifest::unavailable())?;
            if !changed.contains(&path) {
                changed.push(path);
            }
        }
        if changed.is_empty() && step != Step::OntoMain {
            let proposal = match &target {
                Target::Proposal(row) => {
                    let mut checked = row.clone();
                    checked.merge_checked_sha = None;
                    checked.merge_checked_key = None;
                    self.refresh_merge_status(&kb, &repo, &guard, &main, &mut checked)?;
                    Some(checked.summary())
                }
                Target::Main | Target::NewProposal(_) => None,
            };
            return self.record_noop(&set, &actor, &target, key.as_str(), &asset_delta, proposal);
        }
        // Build ONE commit on the base and validate the whole actual tree
        // before anything is recorded.
        let title: String = set
            .title
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let message = match &set.dream {
            // Server parity: the dream subject and digest trailers only;
            // local operation/actor trailers follow.
            Some(dream) => format!(
                "{}\nKb-Operation-Id: {op_id}\nKb-Actor: {actor}\n",
                crate::dream::format_dream_commit_message(
                    &set.title,
                    &set.source_session_ids,
                    dream
                )
            ),
            None => commit_message(&title, &op_id, &actor),
        };
        // A move onto main keeps the proposal's previous head as a second
        // parent, so every recorded conflict's versions stay reachable.
        let parents: Vec<&Sha> = match (&row, step) {
            (Some(row), Step::OntoMain) => vec![&main, &row.head_sha],
            (Some(row), Step::Resolve | Step::OnHead) => vec![&row.head_sha],
            _ => vec![&set.base],
        };
        let (commit, validated_tree) = {
            for edit in &edits {
                match &edit.bytes {
                    Some(bytes) if edit.kind != EditKind::Delete => {
                        let blob = writer.blob(bytes)?;
                        tree.put(&edit.path, blob)?;
                    }
                    // A resolution may delete what the merged tree already lacks.
                    _ if !matches!(tree.lookup(&edit.path), Some(Ok(_)))
                        && resolving.contains(&(Kind::Document, edit.path.as_str().to_owned())) => {
                    }
                    _ => tree.delete(&edit.path)?,
                }
            }
            if !assets.is_empty() {
                let path = KbPath::parse(crate::tree::MANIFEST_PATH)
                    .map_err(|_| manifest::unavailable())?;
                tree.put(
                    &path,
                    writer.blob(&crate::tree::canonical_manifest_bytes(&entries))?,
                )?;
            }
            let root = tree.write(&mut writer)?;
            let commit = writer.commit_parents(&root, &parents, &message, epoch_now())?;
            let validated = match validate_commit(
                &staged,
                &commit,
                &Policy {
                    store: self,
                    kb: &kb,
                    pending: &asset_delta.entries(),
                    base: Some(&validation_base),
                },
            ) {
                Ok(validated) => validated,
                Err(TreeError::Invalid(violation)) => {
                    return Err(tree_rejection(&set, violation));
                }
                Err(TreeError::Git(error)) => return Err(error.into()),
            };
            (commit, validated.tree)
        };
        // A proposed dream persists its merged metadata + guard input.
        let dream_metadata = match (&set.dream, &target) {
            (Some(dream), Target::Proposal(row)) => Some(crate::dream::merge_persisted(
                row.dream_metadata.as_deref(),
                dream,
                &crate::dream::guard_touched_paths(&repo, &set.base, &row.base_sha, dream)?,
            )?),
            (Some(dream), Target::NewProposal(_)) => Some(crate::dream::merge_persisted(
                None,
                dream,
                &crate::dream::guard_touched_paths(&repo, &set.base, &main, dream)?,
            )?),
            _ => None,
        };
        // A receipt never reports an unchecked status. The new head (its
        // objects already written) is checked by the reviewed merge's own
        // validated plan against the main this lock holds, its own assets
        // trusted as they will be once finalized.
        let status = match &target {
            Target::Main => kb_client::types::PrStatus::Open,
            Target::Proposal(_) | Target::NewProposal(_) => {
                let stored = match &row {
                    Some(row) => crate::pull_requests::row_dream(row)?,
                    None => None,
                };
                let (number, title) = match (&target, &row) {
                    (_, Some(row)) => (row.number, row.title.clone()),
                    (Target::NewProposal(number), None) => (*number, set.title.clone()),
                    _ => (0, set.title.clone()),
                };
                self.merge_status(
                    &kb,
                    &staged,
                    &guard,
                    &main,
                    &crate::pull_requests::MergeSubject {
                        number,
                        title: &title,
                        head: &commit,
                        pending: &remaining,
                        dream: dream_metadata.as_ref().or(stored.as_ref()),
                        // Validated above against main itself (a move onto
                        // main or a new PR): the same policy, no second walk.
                        prevalidated: (tree_rev == main).then_some(&validated_tree),
                    },
                    &asset_delta.entries(),
                    &actor,
                )?
            }
        };
        // No merge reader outlives planning: publication spawns its own children.
        drop(source);
        let warnings = dangling_asset_links(&staged, &validated_tree, &assets)?;
        // The plan succeeded: promote exactly what the commit needs.
        let written = writer.promote(&commit, &parents)?;
        drop(writer);
        let proposal = match &target {
            Target::Main => None,
            Target::Proposal(row) => Some(ProposalDelta {
                number: row.number,
                // R3-W5: the PR keeps the title it was opened with.
                title: row.title.clone(),
                author: actor.clone(),
                source_ref: row.source_ref.clone(),
                is_auto: row.is_auto,
                // A PR moved onto main is based on that main.
                base_sha: if step == Step::OntoMain {
                    main.clone()
                } else {
                    row.base_sha.clone()
                },
                target_sha: main.clone(),
                version: row.version + 1,
                opened: false,
                dream: dream_metadata.clone(),
                status,
                policy_generation: self.sealed_policy_generation(&kb)?,
                pending: remaining.clone(),
            }),
            Target::NewProposal(number) => Some(ProposalDelta {
                number: *number,
                title: set.title.clone(),
                author: actor.clone(),
                source_ref: proposal_ref(*number),
                is_auto: true,
                base_sha: main.clone(),
                target_sha: main.clone(),
                version: 1,
                opened: true,
                dream: dream_metadata,
                status,
                policy_generation: self.sealed_policy_generation(&kb)?,
                pending: Vec::new(),
            }),
        };
        let updates_main = proposal.is_none();
        let result = ApplyResult {
            operation_id: op_id.clone(),
            kind: if updates_main {
                ApplyKind::Applied
            } else {
                ApplyKind::Proposed
            },
            commit_sha: commit.clone(),
            base_revision: set.base.clone(),
            proposal: proposal.as_ref().map(|p| p.summary(&commit)),
            changed_paths: changed,
            source_session_ids: set.source_session_ids.clone(),
            // A main publication always enqueues a generation (lexical-only
            // without a usable profile), whose job id is the operation id.
            index_job_id: updates_main.then(|| op_id.clone()),
            warnings,
        };
        let delta = Delta {
            head: commit.clone(),
            activate: false,
            updates_main,
            desired_epoch: if updates_main {
                record.desired_epoch + 1
            } else {
                record.desired_epoch
            },
            grant: None,
            proposal,
            review: None,
            assets: asset_delta,
        };
        let response = serde_json::to_string(&result).map_err(json_err)?;
        let tx = self.conn.unchecked_transaction()?;
        crate::uploads::charge_mutation(&tx, &actor, set.kb.as_str(), self.now_ms())?;
        tx.execute(
            "INSERT INTO operation_intents (op_id, actor_key, kb_id, operation, \
                 idempotency_key, request_hash, phase, ref_name, expected_old, intended_new, \
                 validated_tree, delta_json, response_json, created_at, dream_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PREPARED', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                op_id.as_str(),
                &actor,
                kb.as_str(),
                set.operation,
                key.as_str(),
                &set.hash,
                &ref_name,
                expected_old.as_ref().map(Sha::as_str),
                commit.as_str(),
                validated_tree.as_str(),
                delta.to_json(),
                &response,
                now_utc(),
                dream_receipt(&set),
            ],
        )
        .map_err(|e| constraint_to_conflict(e, "idempotency key already reserved"))?;
        delta.assets.bind(&tx, &op_id, &kb, &actor)?;
        tx.commit()?;
        let cas_result = (|| -> Result<(), StoreError> {
            for asset in &assets {
                if let AssetChangeOwned::Put(_, id) = asset {
                    let (entry, bytes) = self.ready_upload(&actor, &kb, id, "asset")?;
                    let hash = kb_client::types::ContentHash::parse(&entry.hash)
                        .map_err(|_| manifest::unavailable())?;
                    let mime = manifest::asset_ref(&entry)?.mime;
                    crate::cas::publish_cas_locked(
                        &self.paths,
                        std::io::Cursor::new(bytes),
                        &hash,
                        entry.size,
                        mime,
                        &guard,
                    )?;
                }
            }
            Ok(())
        })();
        if let Err(error) = cas_result {
            self.abort_intent(&op_id, &kb, false, error.protocol_code())?;
            return Err(error);
        }
        let publication = RefPublication {
            guard: &guard,
            repo: &repo,
            principal,
            op_id: &op_id,
            kb: &kb,
            ref_name: &ref_name,
            expected_old: expected_old.as_ref(),
            commit: &commit,
            updates_main,
            required: Permission::Propose,
            source: None,
            import: set.import.as_ref().map(|(_, source)| source),
        };
        self.publish_ref(&publication, &written, &delta, observer)?;
        Ok(result)
    }

    /// Step 2 of the module docs. A request against current main reaches
    /// the caller's open proposal: it moves the PR onto main when main
    /// moved past it, resolves recorded conflicts, or (a PR already on main
    /// with none recorded, R3-W6) applies on its head.
    fn route(
        &self,
        repo: &GitRepo,
        set: &ChangeSet,
        actor: &str,
        can_write: bool,
        main: &Sha,
    ) -> Result<(Target, Step), StoreError> {
        let stale = |head: &Sha, number: Option<u64>| StoreError::StaleBase {
            head_sha: head.clone(),
            proposal_number: number,
        };
        let continue_proposal = |row: PrRow| -> Result<(Target, Step), StoreError> {
            // The PR head the caller read: a PR that moved since is a stale
            // read whatever main did, so two editors never overwrite each other.
            if set
                .proposal_head_sha
                .as_ref()
                .is_some_and(|observed| observed != &row.head_sha)
            {
                return Err(stale(&row.head_sha, Some(row.number)));
            }
            if set.base == row.head_sha {
                return Ok((Target::Proposal(Box::new(row)), Step::None));
            }
            // Naming a PR against main needs the head that choice was made on.
            if set.proposal_number.is_some() && set.proposal_head_sha.is_none() {
                return Err(stale(&row.head_sha, Some(row.number)));
            }
            // A dream proposal is pinned to the main it was generated against:
            // neither a dream request nor an ordinary edit moves it (server
            // parity; the selected PR's stored metadata decides, not only the
            // request's mode).
            if set.dream.is_none()
                && row.dream_metadata.is_none()
                && &set.base == main
                && &row.head_sha != main
            {
                let step = if !crate::pr_merge::is_ancestor(repo, main, &row.head_sha)? {
                    Step::OntoMain
                } else if !row.pending_conflicts.is_empty() {
                    Step::Resolve
                } else {
                    Step::OnHead
                };
                return Ok((Target::Proposal(Box::new(row)), step));
            }
            Err(stale(&row.head_sha, Some(row.number)))
        };
        if let Some(number) = set.proposal_number {
            let row = self.pr_row(&set.kb, number)?.ok_or(StoreError::NotFound)?;
            let owned = self.branch_owner(&set.kb, &row.source_ref)?.as_deref() == Some(actor);
            if !row.is_active() {
                // The caller's own PR closed or merged since they read it:
                // the precondition answer (continue on current main). Anyone
                // else's terminal PR stays invisible.
                return Err(if owned {
                    stale(main, None)
                } else {
                    StoreError::NotFound
                });
            }
            if !owned {
                return Err(StoreError::Forbidden);
            }
            return continue_proposal(row);
        }
        // A PR head was read but no open PR of the caller's is the target.
        if set.proposal_head_sha.is_some()
            && set.proposal_number.is_none()
            && can_write
            && &set.base == main
        {
            return Err(stale(main, None));
        }
        if can_write {
            if &set.base == main {
                return Ok((Target::Main, Step::None));
            }
            // A write holder editing at the head of their own open proposal.
            if let Some(row) = self.active_pr_at_head(&set.kb, actor, &set.base)? {
                return continue_proposal(row);
            }
            return Err(stale(main, None));
        }
        if let Some(row) = self.active_auto_pr(&set.kb, actor)? {
            return continue_proposal(row);
        }
        if &set.base != main || set.proposal_head_sha.is_some() {
            return Err(stale(main, None));
        }
        Ok((
            Target::NewProposal(self.next_pr_number(&set.kb)?),
            Step::None,
        ))
    }

    /// A durable noop receipt: no commit, PR, number or index intent.
    fn record_noop(
        &self,
        set: &ChangeSet,
        actor: &str,
        target: &Target,
        key: &str,
        assets: &AssetDelta,
        proposal: Option<kb_client::types::PrSummary>,
    ) -> Result<ApplyResult, StoreError> {
        let op_id = new_uuid_v4()?;
        let result = ApplyResult {
            operation_id: op_id.clone(),
            kind: ApplyKind::Noop,
            // The revision the edit was evaluated on: the selected PR's head
            // (a request against main may reach it, R3-W6), else main.
            commit_sha: match target {
                Target::Proposal(row) => row.head_sha.clone(),
                Target::Main | Target::NewProposal(_) => set.base.clone(),
            },
            base_revision: set.base.clone(),
            proposal,
            changed_paths: Vec::new(),
            source_session_ids: set.source_session_ids.clone(),
            index_job_id: None,
            warnings: Vec::new(),
        };
        let now = now_utc();
        let tx = self.conn.unchecked_transaction()?;
        crate::uploads::charge_mutation(&tx, actor, set.kb.as_str(), self.now_ms())?;
        tx.execute(
            "INSERT INTO operation_intents (op_id, actor_key, kb_id, operation, \
                 idempotency_key, request_hash, phase, response_json, created_at, finished_at, \
                 dream_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'FINALIZED', ?7, ?8, ?8, ?9)",
            (
                op_id.as_str(),
                actor,
                set.kb.as_str(),
                set.operation,
                key,
                &set.hash,
                serde_json::to_string(&result).map_err(json_err)?,
                now,
                dream_receipt(set),
            ),
        )
        .map_err(|e| constraint_to_conflict(e, "idempotency key already reserved"))?;
        assets.bind(&tx, &op_id, &set.kb, actor)?;
        assets.finalize(&tx, &op_id, &set.kb, actor)?;
        tx.commit()?;
        Ok(result)
    }

    /// Step 4 of the module docs for a complete PREPARED row.
    pub(crate) fn publish_ref(
        &self,
        publication: &RefPublication<'_>,
        written: &[String],
        delta: &Delta,
        observer: Observer<'_>,
    ) -> Result<(), StoreError> {
        let RefPublication {
            guard,
            repo,
            op_id,
            kb,
            ref_name,
            expected_old,
            commit,
            ..
        } = *publication;
        let prepared = (|| -> Result<(), StoreError> {
            observer(Stage::Prepared)?;
            observer(Stage::SyncObjects)?;
            crate::git_read::OperationDeadline::check()?;
            git_write::sync_objects(repo, written)?;
            crate::git_read::OperationDeadline::check()
        })();
        if let Err(error) = prepared {
            let _ = self.abort_intent(op_id, kb, false, kb_client::ErrorCode::Conflict);
            return Err(error);
        }
        let committing = (|| -> Result<(), StoreError> {
            let bits = self.authorize(publication.principal, kb, publication.required)?;
            if publication.updates_main
                && publication.required == Permission::Propose
                && !bits.contains(Permission::Write)
            {
                return Err(StoreError::Forbidden);
            }
            if let Some((source, head)) = publication.source
                && git_write::read_ref(repo, source)?.as_ref() != Some(head)
            {
                self.mark_repair(kb)?;
                return Err(StoreError::RecoveryRequired(
                    "source changed outside the store".into(),
                ));
            }
            if git_write::read_ref(repo, ref_name)?.as_ref() != expected_old {
                self.mark_repair(kb)?;
                return Err(StoreError::RecoveryRequired(
                    "ref changed outside the store".into(),
                ));
            }
            if let Some(source) = publication.import {
                self.import_entry(publication.principal, source)?;
            }
            crate::git_read::OperationDeadline::check()?;
            crate::git_read::OperationDeadline::reserve_transport()?;
            let changed = self.conn.execute(
                "UPDATE operation_intents SET phase = 'COMMITTING' \
                 WHERE op_id = ?1 AND phase = 'PREPARED'",
                [op_id.as_str()],
            )?;
            if changed != 1 {
                return Err(StoreError::Internal("intent left PREPARED".into()));
            }
            Ok(())
        })();
        if let Err(error) = committing {
            if !matches!(error, StoreError::RecoveryRequired(_)) {
                let code = match error.protocol_code() {
                    kb_client::ErrorCode::Forbidden | kb_client::ErrorCode::NotFound => {
                        error.protocol_code()
                    }
                    _ => kb_client::ErrorCode::Conflict,
                };
                let _ = self.abort_intent(op_id, kb, false, code);
            }
            return Err(error);
        }
        // From here on: never success before FINALIZED; recovery resolves.
        observer(Stage::Committing)?;
        if !git_write::update_ref(repo, guard, ref_name, commit, expected_old)? {
            return Err(StoreError::StorageUnavailable(
                "ref update was refused; recovery will resolve the operation".into(),
            ));
        }
        observer(Stage::RefMoved)?;
        self.finalize_intent(op_id, kb, delta, observer)?;
        observer(Stage::Finalized)?;
        Ok(())
    }
}

pub(crate) struct RefPublication<'a> {
    pub(crate) guard: &'a WriteGuard,
    pub(crate) repo: &'a GitRepo,
    pub(crate) principal: &'a LocalPrincipal,
    pub(crate) op_id: &'a Uuid,
    pub(crate) kb: &'a KbId,
    pub(crate) ref_name: &'a str,
    pub(crate) expected_old: Option<&'a Sha>,
    pub(crate) commit: &'a Sha,
    pub(crate) updates_main: bool,
    pub(crate) required: Permission,
    pub(crate) source: Option<(&'a str, &'a Sha)>,
    pub(crate) import: Option<&'a kb_client::types::AssetSource>,
}

/// Informational receipt metadata of a dream change set.
fn dream_receipt(set: &ChangeSet) -> Option<String> {
    set.dream
        .as_ref()
        .map(|dream| crate::dream::receipt_json(dream, &set.source_session_ids))
}

/// Generate an omitted edit title, matching the server's `changeSummaryTitle`.
fn change_summary_title(changes: &[Change]) -> String {
    fn describe(change: &Change) -> (&'static str, &str, bool) {
        match change {
            Change::Create { path, .. } => ("Create", path.as_str(), false),
            Change::Replace { path, .. } => ("Update", path.as_str(), false),
            Change::Delete { path } => ("Delete", path.as_str(), false),
            Change::AssetPut { path, .. } => ("Add asset", path.as_str(), true),
            Change::AssetRemove { path } => ("Remove asset", path.as_str(), true),
        }
    }
    let Some(first) = changes.first() else {
        return "Update documents".into();
    };
    let (verb, path, _) = describe(first);
    let title = if changes.len() == 1 {
        format!("{verb} {path}")
    } else {
        let documents = changes.iter().all(|change| !describe(change).2);
        let same = changes.iter().all(|change| describe(change).0 == verb);
        format!(
            "{} {} {}",
            if documents && same { verb } else { "Change" },
            changes.len(),
            if documents { "documents" } else { "files" }
        )
    };
    if title.chars().count() <= 200 {
        title
    } else {
        format!("{}…", title.chars().take(199).collect::<String>())
    }
}

/// `Create|Update|Delete <path>`, bounded to 200 characters.
fn wrapper_title(operation: &str, path: &str) -> String {
    let verb = match operation {
        OP_DOC_CREATE => "Create",
        OP_DOC_DELETE => "Delete",
        _ => "Update",
    };
    let title = format!("{verb} {path}");
    if title.chars().count() <= 200 {
        return title;
    }
    let mut short: String = title.chars().take(199).collect();
    short.push('…');
    short
}

fn json_err(_: serde_json::Error) -> StoreError {
    StoreError::Internal("json encoding".into())
}

fn parse_apply_result(response: Option<&str>) -> Result<ApplyResult, StoreError> {
    serde_json::from_str(response.unwrap_or(""))
        .map_err(|_| StoreError::RecoveryRequired("journal response".into()))
}

/// L-22: documents of the resulting tree that still link to an asset this
/// change set removes (their images or links now dangle). Reads the tree
/// only when an asset is removed; bounded like every tree walk.
fn dangling_asset_links(
    repo: &GitRepo,
    tree: &Sha,
    assets: &[AssetChangeOwned],
) -> Result<Vec<kb_client::types::ApplyWarning>, StoreError> {
    use crate::git_read::{EntryKind, IncomingBudget, ObjectKind, WalkBudget, walk_tree};
    let removed = assets
        .iter()
        .filter_map(|a| match a {
            AssetChangeOwned::Remove(path, _) => Some(path.clone()),
            AssetChangeOwned::Put(..) | AssetChangeOwned::Import(..) => None,
        })
        .collect::<Vec<_>>();
    if removed.is_empty() {
        return Ok(Vec::new());
    }
    let limits = &crate::tree::TREE_LIMITS;
    let mut reader = repo.object_reader()?;
    let mut entries = walk_tree(
        &mut reader,
        tree,
        &mut WalkBudget::new(limits.max_entries),
        &mut IncomingBudget::new(
            limits.max_objects,
            limits.max_uncompressed_object_bytes,
            None,
        ),
    )?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let mut found: Vec<Vec<KbPath>> = vec![Vec::new(); removed.len()];
    for e in entries {
        let Ok(path) = KbPath::parse(&e.path) else {
            continue;
        };
        if e.kind != EntryKind::Blob || !is_markdown_path(&path) {
            continue;
        }
        let bytes = reader.read(&e.sha, ObjectKind::Blob, limits.max_markdown_bytes)?;
        let (Ok(text), Ok(parsed)) = (
            std::str::from_utf8(&bytes),
            crate::markdown::parse_markdown(&bytes),
        ) else {
            continue;
        };
        let body = text.get(parsed.body_start..).unwrap_or_default();
        let referenced = crate::manifest::referenced_paths(body, &e.path);
        for (i, asset) in removed.iter().enumerate() {
            if found[i].len() < 20 && referenced.contains(asset.as_str()) {
                found[i].push(path.clone());
            }
        }
    }
    Ok(removed
        .into_iter()
        .zip(found)
        .filter(|(_, by)| !by.is_empty())
        .map(|(path, referenced_by)| kb_client::types::ApplyWarning {
            code: kb_client::types::AssetStillReferencedCode,
            path,
            referenced_by,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_sha_matches_git() {
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(
            blob_sha(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
        assert_eq!(blob_sha(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn wrapper_titles_match_the_server() {
        assert_eq!(wrapper_title(OP_DOC_CREATE, "a.md"), "Create a.md");
        assert_eq!(wrapper_title(OP_DOC_DELETE, "a.md"), "Delete a.md");
        assert_eq!(
            wrapper_title(OP_DOC_UPDATE, "runbooks/postgres-failover.md"),
            "Update runbooks/postgres-failover.md"
        );
        let long = wrapper_title(OP_DOC_CREATE, &"é".repeat(300));
        assert_eq!(long.chars().count(), 200);
    }
}

/// `.gitignore`, `.assets/manifest.json` and anything else under `.assets/`,
/// compared case-folded (`packages/api/src/lib/kb/paths.ts`).
fn is_reserved_document_path(path: &str) -> bool {
    let key = kb_client::casefold_path_key(path);
    key == kb_client::casefold_path_key(".gitignore")
        || key.starts_with(&kb_client::casefold_path_key(".assets/"))
}

#[cfg(test)]
mod reserved_path_tests {
    #[test]
    fn reserved_document_paths_are_case_folded() {
        for path in [
            ".gitignore",
            ".GitIgnore",
            ".assets/x.md",
            ".ASSETS/manifest.json",
        ] {
            assert!(super::is_reserved_document_path(path), "{path}");
        }
        for path in ["notes/.assets/x.md", "assets/x.md", "x.md", ".assetsx/y.md"] {
            assert!(!super::is_reserved_document_path(path), "{path}");
        }
    }
}
