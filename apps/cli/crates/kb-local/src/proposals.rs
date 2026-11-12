//! Local proposal (pull request) rows and branch ownership (CONTRACT
//! `PrSummary`).
//!
//! * Numbers are per KB: `kbs.next_pr_number` moves from N to N + 1 by CAS
//!   in the SAME finalize transaction that inserts proposal N, its branch
//!   owner and marks the journal row FINALIZED — so an aborted reservation
//!   burns no number, and two processes serialize on the KB lock.
//! * `refs/heads/pr/<n>` is server-owned: its [`branch_owners`] row names the
//!   author, and the PR row references `(kb, ref, author)` by composite
//!   foreign key, so a PR's author IS its branch owner by construction.
//! * One active (OPEN/CONFLICT) auto-PR per actor + KB (partial unique
//!   index); CLOSED/MERGED rows, their identity and branch owners are
//!   immutable (SQL triggers) and never deleted.
//!
//! The authorized list/get/create/review data plane lives in `pull_requests`.
//!
//! [`branch_owners`]: ../../src/db/0001_initial.sql

use kb_client::types::{KbId, MainBranch, PrStatus, PrSummary, Sha};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::locks::WriteGuard;
use crate::pr_merge::ConflictItem;
use crate::state::now_utc;
use crate::store::{Store, StoreError, constraint_to_conflict};

/// Prefix of server-owned proposal branches.
pub const PR_REF_PREFIX: &str = "refs/heads/pr/";

/// `refs/heads/pr/<number>`.
pub fn proposal_ref(number: u64) -> String {
    format!("{PR_REF_PREFIX}{number}")
}

pub(crate) fn status_text(status: PrStatus) -> &'static str {
    match status {
        PrStatus::Open => "OPEN",
        PrStatus::Conflict => "CONFLICT",
        PrStatus::Closed => "CLOSED",
        PrStatus::Merged => "MERGED",
    }
}

pub(crate) fn parse_status(text: &str) -> Result<PrStatus, StoreError> {
    Ok(match text {
        "OPEN" => PrStatus::Open,
        "CONFLICT" => PrStatus::Conflict,
        "CLOSED" => PrStatus::Closed,
        "MERGED" => PrStatus::Merged,
        _ => {
            return Err(StoreError::RecoveryRequired(
                "unknown proposal status".into(),
            ));
        }
    })
}

/// A `pull_requests` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PrRow {
    pub number: u64,
    pub title: String,
    pub source_ref: String,
    pub base_sha: Sha,
    pub head_sha: Sha,
    pub target_sha: Sha,
    pub status: PrStatus,
    pub author: String,
    pub is_auto: bool,
    pub version: u64,
    pub merge_commit_sha: Option<Sha>,
    /// Persisted dream metadata + merge-guard input (JSON), if any.
    pub dream_metadata: Option<String>,
    /// The main the stored OPEN/CONFLICT was computed against.
    pub merge_checked_sha: Option<Sha>,
    pub merge_checked_key: Option<String>,
    /// Conflicts recorded by a move onto main and not resolved yet.
    pub pending_conflicts: Vec<ConflictItem>,
}

impl PrRow {
    pub(crate) fn is_active(&self) -> bool {
        matches!(self.status, PrStatus::Open | PrStatus::Conflict)
    }

    /// The protocol summary. An open PR's status and target come from one
    /// snapshot: `targetSha` is the main its status was computed
    /// against, never a different, live main.
    pub(crate) fn summary(&self) -> PrSummary {
        let target = match (&self.merge_checked_sha, self.is_active()) {
            (Some(checked), true) => checked.clone(),
            _ => self.target_sha.clone(),
        };
        PrSummary {
            number: self.number,
            title: self.title.clone(),
            source_branch: branch_label(&self.source_ref),
            target_branch: MainBranch,
            base_sha: self.base_sha.clone(),
            head_sha: self.head_sha.clone(),
            target_sha: target,
            status: self.status,
            author_actor_key: self.author.clone(),
            version: self.version,
            merge_commit_sha: self.merge_commit_sha.clone(),
        }
    }
}

/// Protocol branch label: the ref relative to `refs/heads/` (`pr/<n>`).
pub(crate) fn branch_label(ref_name: &str) -> String {
    ref_name
        .strip_prefix("refs/heads/")
        .unwrap_or(ref_name)
        .to_owned()
}

pub(crate) const SELECT_PR: &str = "SELECT number, title, source_ref, base_sha, head_sha, target_sha, status, \
     author_actor_key, is_auto_pr, version, merge_commit_sha, dream_metadata, merge_checked_sha, \
     pending_conflicts, merge_checked_key FROM pull_requests";

pub(crate) type RawPr = (
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

pub(crate) fn raw_pr(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawPr> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
    ))
}

pub(crate) fn into_row(raw: RawPr) -> Result<PrRow, StoreError> {
    let bad = || StoreError::RecoveryRequired("malformed proposal row".into());
    let sha = |text: &str| Sha::parse(text).map_err(|_| bad());
    let (
        number,
        title,
        source_ref,
        base,
        head,
        target,
        status,
        author,
        auto,
        version,
        merge,
        dream,
        checked,
        pending,
        checked_key,
    ) = raw;
    Ok(PrRow {
        number: u64::try_from(number).map_err(|_| bad())?,
        title,
        source_ref,
        base_sha: sha(&base)?,
        head_sha: sha(&head)?,
        target_sha: sha(&target)?,
        status: parse_status(&status)?,
        author,
        is_auto: auto != 0,
        version: u64::try_from(version).map_err(|_| bad())?,
        merge_commit_sha: merge.as_deref().map(sha).transpose()?,
        dream_metadata: dream,
        merge_checked_sha: checked.as_deref().map(sha).transpose()?,
        merge_checked_key: checked_key,
        pending_conflicts: serde_json::from_str(&pending).map_err(|_| bad())?,
    })
}

/// Proposal effects of one change-set publication, applied in its
/// finalize transaction (persisted in the journal delta for recovery).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProposalDelta {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_ref: String,
    pub is_auto: bool,
    /// The proposal's main base: its original one, or the main it moved
    /// onto.
    pub base_sha: Sha,
    /// Main at publication (unchanged while the KB lock is held).
    pub target_sha: Sha,
    /// Version after this publication (1 = newly opened).
    pub version: u64,
    /// Newly allocated: bump `next_pr_number`, insert owner + PR rows.
    pub opened: bool,
    /// A dream's merged metadata + merge-guard input to persist (the row
    /// keeps its previous value when `None`).
    pub dream: Option<Value>,
    /// The status of the new head against `target_sha`.
    pub status: PrStatus,
    pub policy_generation: i64,
    /// The conflicts the PR still has to resolve after this publication.
    pub pending: Vec<ConflictItem>,
}

impl ProposalDelta {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "number": self.number,
            "title": self.title,
            "author": self.author,
            "sourceRef": self.source_ref,
            "isAuto": self.is_auto,
            "baseSha": self.base_sha.as_str(),
            "targetSha": self.target_sha.as_str(),
            "version": self.version,
            "opened": self.opened,
            "dream": self.dream,
            "status": status_text(self.status),
            "policyGeneration": self.policy_generation,
            "pending": self.pending,
        })
    }

    pub(crate) fn parse(value: &Value) -> Result<ProposalDelta, StoreError> {
        let bad = || StoreError::RecoveryRequired("journal proposal delta".into());
        let text = |key: &str| value.get(key).and_then(Value::as_str).ok_or_else(bad);
        let int = |key: &str| value.get(key).and_then(Value::as_u64).ok_or_else(bad);
        Ok(ProposalDelta {
            number: int("number")?,
            title: text("title")?.to_owned(),
            author: text("author")?.to_owned(),
            source_ref: text("sourceRef")?.to_owned(),
            is_auto: value
                .get("isAuto")
                .and_then(Value::as_bool)
                .ok_or_else(bad)?,
            base_sha: Sha::parse(text("baseSha")?).map_err(|_| bad())?,
            target_sha: Sha::parse(text("targetSha")?).map_err(|_| bad())?,
            version: int("version")?,
            opened: value
                .get("opened")
                .and_then(Value::as_bool)
                .ok_or_else(bad)?,
            dream: match value.get("dream") {
                None | Some(Value::Null) => None,
                Some(dream @ Value::Object(_)) => Some(dream.clone()),
                Some(_) => return Err(bad()),
            },
            status: match parse_status(text("status")?)? {
                status @ (PrStatus::Open | PrStatus::Conflict) => status,
                _ => return Err(bad()),
            },
            policy_generation: value
                .get("policyGeneration")
                .and_then(Value::as_i64)
                .filter(|v| *v >= 0)
                .ok_or_else(bad)?,
            pending: serde_json::from_value(value.get("pending").cloned().ok_or_else(bad)?)
                .map_err(|_| bad())?,
        })
    }

    /// The `PrSummary` this delta produces for `head`.
    pub(crate) fn summary(&self, head: &Sha) -> PrSummary {
        PrSummary {
            number: self.number,
            title: self.title.clone(),
            source_branch: branch_label(&self.source_ref),
            target_branch: MainBranch,
            base_sha: self.base_sha.clone(),
            head_sha: head.clone(),
            target_sha: self.target_sha.clone(),
            status: self.status,
            author_actor_key: self.author.clone(),
            version: self.version,
            merge_commit_sha: None,
        }
    }
}

pub(crate) fn to_i64(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::InvalidArgument("number out of range".into()))
}

/// Apply `delta` for a publication whose proposal ref now points at `head`.
/// Every statement must affect exactly one row, or the whole finalize
/// transaction is refused.
pub(crate) fn apply_proposal_delta(
    tx: &rusqlite::Transaction<'_>,
    kb: &KbId,
    head: &Sha,
    delta: &ProposalDelta,
) -> Result<(), StoreError> {
    let disagree = || StoreError::RecoveryRequired("journal and proposal rows disagree".into());
    let number = to_i64(delta.number)?;
    let version = to_i64(delta.version)?;
    let source = &delta.source_ref;
    let now = now_utc();
    let dream = delta.dream.as_ref().map(Value::to_string);
    let status = status_text(delta.status);
    let pending = serde_json::to_string(&delta.pending)
        .map_err(|_| StoreError::Internal("pending conflicts".into()))?;
    if delta.opened {
        let bumped = tx.execute(
            "UPDATE kbs SET next_pr_number = ?2 + 1 WHERE id = ?1 AND next_pr_number = ?2",
            (kb.as_str(), number),
        )?;
        if bumped != 1 || delta.version != 1 {
            return Err(disagree());
        }
        if delta.is_auto {
            tx.execute(
                "INSERT INTO branch_owners (kb_id, ref_name, owner_actor_key, purpose, created_at) \
             VALUES (?1, ?2, ?3, 'AUTO_PR', ?4)",
                (kb.as_str(), &source, &delta.author, &now),
            )?;
        }
        tx.execute(
            "INSERT INTO pull_requests (kb_id, number, title, source_ref, base_sha, head_sha, \
             target_sha, status, author_actor_key, is_auto_pr, version, created_at, updated_at, \
             dream_metadata, merge_checked_sha, pending_conflicts, merge_checked_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, \
             ?7, ?12, ?8, ?11, 1, ?9, ?9, ?10, ?7, ?13, ?14)",
            rusqlite::params![
                kb.as_str(),
                number,
                &delta.title,
                &source,
                delta.base_sha.as_str(),
                head.as_str(),
                delta.target_sha.as_str(),
                &delta.author,
                &now,
                &dream,
                delta.is_auto,
                status,
                &pending,
                crate::pull_requests::mergeability_key(&delta.target_sha, delta.policy_generation, Some((head, delta.version))),
            ],
        )?;
        return Ok(());
    }
    // R3-W5: an update keeps the PR's title; its own title is only that
    // commit's message. A move onto main also moves the base.
    let advanced = tx.execute(
        "UPDATE pull_requests SET base_sha = ?4, head_sha = ?5, target_sha = ?6, status = ?10, \
         version = ?3, updated_at = ?8, dream_metadata = COALESCE(?9, dream_metadata), \
         merge_checked_sha = ?6, pending_conflicts = ?11, merge_checked_key = ?12 WHERE kb_id = ?1 AND number = ?2 \
         AND version = ?3 - 1 AND author_actor_key = ?7 AND status IN ('OPEN', 'CONFLICT')",
        rusqlite::params![
            kb.as_str(),
            number,
            version,
            delta.base_sha.as_str(),
            head.as_str(),
            delta.target_sha.as_str(),
            &delta.author,
            &now,
            &dream,
            status,
            &pending,
            crate::pull_requests::mergeability_key(&delta.target_sha, delta.policy_generation, Some((head, delta.version))),
        ],
    )?;
    if advanced != 1 {
        return Err(disagree());
    }
    Ok(())
}

impl Store {
    pub(crate) fn pr_row(&self, kb: &KbId, number: u64) -> Result<Option<PrRow>, StoreError> {
        let Ok(number) = i64::try_from(number) else {
            return Ok(None);
        };
        self.conn
            .query_row(
                &format!("{SELECT_PR} WHERE kb_id = ?1 AND number = ?2"),
                (kb.as_str(), number),
                raw_pr,
            )
            .optional()?
            .map(into_row)
            .transpose()
    }

    /// The actor's active (OPEN/CONFLICT) auto-PR on `kb`, if any.
    pub(crate) fn active_auto_pr(
        &self,
        kb: &KbId,
        actor: &str,
    ) -> Result<Option<PrRow>, StoreError> {
        self.conn
            .query_row(
                &format!(
                    "{SELECT_PR} WHERE kb_id = ?1 AND author_actor_key = ?2 AND is_auto_pr = 1 \
                     AND status IN ('OPEN', 'CONFLICT')"
                ),
                (kb.as_str(), actor),
                raw_pr,
            )
            .optional()?
            .map(into_row)
            .transpose()
    }

    /// The actor's own active proposal whose head is `head` (newest first).
    /// Ownership is filtered in SQL before the bound, so another actor's PR
    /// at the same head can never hide the caller's own.
    pub(crate) fn active_pr_at_head(
        &self,
        kb: &KbId,
        actor: &str,
        head: &Sha,
    ) -> Result<Option<PrRow>, StoreError> {
        self.conn
            .query_row(
                &format!(
                    "{SELECT_PR} WHERE kb_id = ?1 AND head_sha = ?2 AND status IN ('OPEN', 'CONFLICT') \
                     AND source_ref IN (SELECT ref_name FROM branch_owners \
                                         WHERE kb_id = ?1 AND owner_actor_key = ?3) \
                     ORDER BY number DESC LIMIT 1"
                ),
                (kb.as_str(), head.as_str(), actor),
                raw_pr,
            )
            .optional()?
            .map(into_row)
            .transpose()
    }

    /// Owning actor of branch `ref_name` of `kb`.
    pub(crate) fn branch_owner(
        &self,
        kb: &KbId,
        ref_name: &str,
    ) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT owner_actor_key FROM branch_owners WHERE kb_id = ?1 AND ref_name = ?2",
                (kb.as_str(), ref_name),
                |row| row.get(0),
            )
            .optional()?)
    }

    /// The number the next newly opened proposal of `kb` receives.
    pub(crate) fn next_pr_number(&self, kb: &KbId) -> Result<u64, StoreError> {
        let next: i64 = self.conn.query_row(
            "SELECT next_pr_number FROM kbs WHERE id = ?1",
            [kb.as_str()],
            |row| row.get(0),
        )?;
        u64::try_from(next).map_err(|_| StoreError::RecoveryRequired("proposal counter".into()))
    }

    /// Unauthenticated inspection of proposal `number` of `kb` (tests and
    /// local tooling; tool callers use `pull_requests_get`).
    pub fn proposal(&self, kb: &KbId, number: u64) -> Result<Option<PrSummary>, StoreError> {
        Ok(self.pr_row(kb, number)?.map(|row| row.summary()))
    }

    /// Force a proposal's status (tests only).
    /// Terminal (CLOSED/MERGED) rows are immutable: changing one is a
    /// CONFLICT raised by the schema itself.
    #[doc(hidden)]
    pub fn set_proposal_status_for_tests(
        &self,
        guard: &WriteGuard,
        kb: &KbId,
        number: u64,
        status: PrStatus,
    ) -> Result<(), StoreError> {
        self.check_guard(guard)?;
        let row = self.pr_row(kb, number)?.ok_or(StoreError::NotFound)?;
        let merge = (status == PrStatus::Merged).then(|| row.head_sha.as_str().to_owned());
        let changed = self
            .conn
            .execute(
                "UPDATE pull_requests SET status = ?3, merge_commit_sha = ?4, updated_at = ?5 \
                 WHERE kb_id = ?1 AND number = ?2",
                (
                    kb.as_str(),
                    to_i64(number)?,
                    status_text(status),
                    merge,
                    now_utc(),
                ),
            )
            .map_err(|e| constraint_to_conflict(e, "proposal is immutable"))?;
        if changed != 1 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
}
