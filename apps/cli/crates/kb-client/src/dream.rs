//! Atomic dream apply (Cockpit `RemoteSink.apply`, CONTRACT "Atomic changes
//! and dreaming").
//!
//! A [`DreamChangeSet`] becomes exactly ONE `knowledge_changes_apply`
//! (`mode: "dream"`) call carrying every upsert, the source session ids and
//! the model provenance. The client never splits a change set, never loops
//! per document and never invents a server dream watermark.
//!
//! The base revision is pinned once from `knowledge_bases_get` and, together
//! with the caller's idempotency key, frozen in a [`PreparedDream`]; every
//! retry resends the byte-identical arguments.
//!
//! # Outcomes and the consumer ledger
//!
//! * [`DreamOutcome::Applied`] — committed to main.
//! * [`DreamOutcome::Noop`] — main is unchanged; durable receipt, no commit.
//! * [`DreamOutcome::ProposalNoop`] — the active proposal is unchanged;
//!   the consumer ledger remains deferred until that proposal merges.
//! * [`DreamOutcome::Proposed`] — the caller lacks `write`, so the dream is a
//!   pull request. **It is deferred, not committed**: main is unchanged and
//!   the consumer ledger must not advance until that proposal merges.
//!
//! Only `Applied` and `Noop` report
//! [`DreamOutcome::advances_consumer_ledger`]. Stale bases, failures and
//! inconsistent server answers are errors, never a success value.

use std::collections::HashSet;
use std::fmt;

use crate::client::{CallControl, ClientError, McpClient};
use crate::error::{ErrorCode, ErrorDetails, KbError};
use crate::types::{
    ApplyKind, ApplyResult, BasesGet, ChangesApply, ChangesApplyInput, ChangesMode, DreamMetadata,
    DreamModel, DreamUpsert, IdempotencyKey, KbId, KbRef, Sha, True, Uuid,
};

/// Cockpit `ConceptUpsert`: `{id, type, title, body, citations, provenance}`.
pub type ConceptUpsert = DreamUpsert;

/// Maximum upserts in one dream; larger sets are refused, never split.
pub const DREAM_MAX_UPSERTS: usize = 8;
/// Maximum source sessions in one dream, matching the shared tool schema.
pub const DREAM_MAX_SOURCE_SESSIONS: usize = 100;
/// Inline upsert body cap (UTF-8 bytes).
pub const DREAM_BODY_MAX_BYTES: usize = 64 * 1024;
/// Attempts (first + retries) used by [`apply_dream`].
pub const DREAM_MAX_ATTEMPTS: u32 = 3;
const DEFAULT_TITLE: &str = "Dream consolidation";
const TITLE_MAX_CHARS: usize = 200;

/// One dream: Cockpit's `DreamChangeSet` plus the resolved dream model.
#[derive(Clone, Debug, PartialEq)]
pub struct DreamChangeSet {
    pub knowledge_base_id: KbId,
    /// Informational provenance, never delegated identity.
    pub source_session_ids: Vec<Uuid>,
    pub upserts: Vec<ConceptUpsert>,
    pub model: DreamModel,
    /// Commit/proposal title; defaults to `"Dream consolidation"`.
    pub title: Option<String>,
}

/// Why a dream did not produce an outcome. None of these is success.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DreamError {
    /// Refused locally before any request (`&'static str` names the rule).
    InvalidChangeSet(&'static str),
    /// The KB has no HEAD to pin.
    NoHead,
    /// The pinned base is no longer the target HEAD (`CONFLICT`).
    Stale {
        head_sha: Option<Sha>,
    },
    /// The server's answer contradicts the request or its own kind.
    InvalidOutcome(&'static str),
    Client(ClientError),
}

impl fmt::Display for DreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DreamError::InvalidChangeSet(rule) => write!(f, "invalid dream change set: {rule}"),
            DreamError::NoHead => f.write_str("kb has no head revision to dream against"),
            DreamError::Stale { .. } => f.write_str("kb changed since the dream base was pinned"),
            DreamError::InvalidOutcome(rule) => write!(f, "inconsistent dream result: {rule}"),
            DreamError::Client(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for DreamError {}

impl From<ClientError> for DreamError {
    fn from(error: ClientError) -> Self {
        if let ClientError::Kb(KbError::Tool(tool)) = &error
            && tool.code() == ErrorCode::Conflict
        {
            let head_sha = match tool.details() {
                ErrorDetails::Conflict { head_sha, .. } => Some(head_sha.clone()),
                ErrorDetails::ProposalConflict(conflict) => Some(conflict.head_sha.clone()),
                _ => None,
            };
            return DreamError::Stale { head_sha };
        }
        DreamError::Client(error)
    }
}

/// The server's verdict on one dream.
#[derive(Clone, Debug, PartialEq)]
pub enum DreamOutcome {
    /// Committed to main.
    Applied(ApplyResult),
    /// Main is unchanged; durable receipt only.
    Noop(ApplyResult),
    /// The active proposal is unchanged; deferred until it merges.
    ProposalNoop(ApplyResult),
    /// Deferred as a pull request; main unchanged until it merges.
    Proposed(ApplyResult),
}

impl DreamOutcome {
    /// Whether the host may advance its consumer ledger for the source
    /// sessions now. `Proposed` and `ProposalNoop` are deferred until merge.
    pub fn advances_consumer_ledger(&self) -> bool {
        matches!(self, DreamOutcome::Applied(_) | DreamOutcome::Noop(_))
    }

    pub fn result(&self) -> &ApplyResult {
        match self {
            DreamOutcome::Applied(r)
            | DreamOutcome::Noop(r)
            | DreamOutcome::ProposalNoop(r)
            | DreamOutcome::Proposed(r) => r,
        }
    }
}

/// A dream with its base revision and idempotency key frozen. Resubmitting
/// the same `PreparedDream` is always a retry of the same operation.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedDream {
    input: ChangesApplyInput,
}

impl PreparedDream {
    /// Validate `set` and freeze it against `base_revision` and `key`.
    pub fn new(
        set: &DreamChangeSet,
        base_revision: Sha,
        key: IdempotencyKey,
    ) -> Result<Self, DreamError> {
        validate(set)?;
        let title = set.title.clone().unwrap_or_else(|| DEFAULT_TITLE.into());
        let input = ChangesApplyInput {
            kb_id: set.knowledge_base_id.clone(),
            base_revision,
            idempotency_key: key,
            mode: ChangesMode::Dream,
            proposal_number: None,
            proposal_head_sha: None,
            title: Some(title),
            changes: Vec::new(),
            source_session_ids: set.source_session_ids.clone(),
            dream: Some(DreamMetadata {
                model: set.model.clone(),
                redaction_applied: True,
                upserts: set.upserts.clone(),
            }),
        };
        crate::encode_input::<ChangesApply>(&input)
            .map_err(|_| DreamError::InvalidChangeSet("kb/1 contract"))?;
        Ok(PreparedDream { input })
    }

    /// Freeze a new request explicitly targeting the proposal and head the
    /// caller observed. Construct this before submitting; retries reuse it.
    pub fn new_for_proposal(
        set: &DreamChangeSet,
        base_revision: Sha,
        key: IdempotencyKey,
        proposal_number: u64,
        proposal_head_sha: Sha,
    ) -> Result<Self, DreamError> {
        let mut prepared = Self::new(set, base_revision, key)?;
        prepared.input.proposal_number = Some(proposal_number);
        prepared.input.proposal_head_sha = Some(proposal_head_sha);
        crate::encode_input::<ChangesApply>(&prepared.input)
            .map_err(|_| DreamError::InvalidChangeSet("kb/1 contract"))?;
        Ok(prepared)
    }

    pub fn base_revision(&self) -> &Sha {
        &self.input.base_revision
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.input.idempotency_key
    }

    /// The exact `knowledge_changes_apply` arguments.
    pub fn input(&self) -> &ChangesApplyInput {
        &self.input
    }
}

fn validate(set: &DreamChangeSet) -> Result<(), DreamError> {
    let bad = |rule| Err(DreamError::InvalidChangeSet(rule));
    if set.upserts.len() > DREAM_MAX_UPSERTS {
        return bad("more than 8 upserts");
    }
    let mut ids = HashSet::new();
    for upsert in &set.upserts {
        if !ids.insert(upsert.id.as_str()) {
            return bad("duplicate concept id");
        }
        if upsert.body.len() > DREAM_BODY_MAX_BYTES {
            return bad("upsert body over 64 KiB");
        }
    }
    if set.source_session_ids.len() > DREAM_MAX_SOURCE_SESSIONS {
        return bad("more than 100 source sessions");
    }
    let sessions: HashSet<&str> = set.source_session_ids.iter().map(Uuid::as_str).collect();
    if sessions.len() != set.source_session_ids.len() {
        return bad("duplicate source session id");
    }
    if set.source_session_ids.is_empty() && !set.upserts.is_empty() {
        return bad("upserts without source sessions");
    }
    if let Some(title) = &set.title
        && (title.is_empty() || title.chars().count() > TITLE_MAX_CHARS)
    {
        return bad("title must be 1..200 characters");
    }
    Ok(())
}

/// Validate `set`, then pin the KB's current HEAD as the base revision.
pub async fn prepare_dream(
    client: &McpClient,
    set: &DreamChangeSet,
    key: IdempotencyKey,
    ctl: &CallControl,
) -> Result<PreparedDream, DreamError> {
    validate(set)?;
    let input = KbRef {
        kb_id: set.knowledge_base_id.clone(),
    };
    let out = client.call::<BasesGet>(&input, ctl).await?;
    if out.kb.id != set.knowledge_base_id {
        return Err(DreamError::InvalidOutcome("head pinned from another kb"));
    }
    let head = out.kb.head_sha;
    PreparedDream::new(set, head, key)
}

/// Send the one `knowledge_changes_apply` call (retrying retryable failures
/// with identical arguments, up to `max_attempts`) and classify the result.
pub async fn submit_dream(
    client: &McpClient,
    prepared: &PreparedDream,
    ctl: &CallControl,
    max_attempts: u32,
) -> Result<DreamOutcome, DreamError> {
    let result = client
        .call_with_retry::<ChangesApply>(&prepared.input, ctl, max_attempts.max(1))
        .await?;
    classify(prepared, result)
}

/// [`prepare_dream`] + [`submit_dream`] with [`DREAM_MAX_ATTEMPTS`]. To retry
/// after this returns an error, keep a [`PreparedDream`] instead so the base
/// stays pinned.
pub async fn apply_dream(
    client: &McpClient,
    set: &DreamChangeSet,
    key: IdempotencyKey,
    ctl: &CallControl,
) -> Result<DreamOutcome, DreamError> {
    let prepared = prepare_dream(client, set, key, ctl).await?;
    submit_dream(client, &prepared, ctl, DREAM_MAX_ATTEMPTS).await
}

fn classify(prepared: &PreparedDream, result: ApplyResult) -> Result<DreamOutcome, DreamError> {
    let bad = |rule| Err(DreamError::InvalidOutcome(rule));
    if &result.base_revision != prepared.base_revision() {
        return bad("base revision differs from the pinned base");
    }
    if result.source_session_ids != prepared.input.source_session_ids {
        return bad("source session ids differ from the request");
    }
    match result.kind {
        ApplyKind::Applied => {
            if result.proposal.is_some() {
                return bad("applied result carries a proposal");
            }
            if &result.commit_sha == prepared.base_revision() {
                return bad("applied result has no new commit");
            }
            Ok(DreamOutcome::Applied(result))
        }
        ApplyKind::Noop => {
            if &result.commit_sha != prepared.base_revision() {
                return bad("noop commit differs from the pinned target");
            }
            if result.index_job_id.is_some() || !result.changed_paths.is_empty() {
                return bad("noop result reports changes");
            }
            if let Some(proposal) = &result.proposal {
                if proposal.head_sha != result.commit_sha {
                    return bad("noop commit is not the proposal head");
                }
                if !matches!(
                    proposal.status,
                    crate::types::PrStatus::Open | crate::types::PrStatus::Conflict
                ) {
                    return bad("noop proposal is not active");
                }
                return Ok(DreamOutcome::ProposalNoop(result));
            }
            Ok(DreamOutcome::Noop(result))
        }
        ApplyKind::Proposed => {
            let Some(proposal) = &result.proposal else {
                return bad("proposed result without a proposal");
            };
            if result.index_job_id.is_some() {
                return bad("proposed result scheduled an index job");
            }
            if proposal.head_sha != result.commit_sha {
                return bad("proposed commit is not the proposal head");
            }
            Ok(DreamOutcome::Proposed(result))
        }
    }
}
