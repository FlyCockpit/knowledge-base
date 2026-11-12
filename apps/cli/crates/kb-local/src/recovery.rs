//! Crash recovery of interrupted publications and read gating. Startup gates reads.
//!
//! Runs only under the store lock — at [`Store::open`] when no writer holds
//! it, at every write-lock acquisition, and from gated reads — so it never
//! races a live publication, and a crashed owner's still-running Git child
//! (which inherits the lock) has exited before it runs. For every
//! PREPARED/COMMITTING row, from the actual ref:
//!
//! * PREPARED: the CAS never ran. Abort (stable failure); if the ref is not
//!   the expected old value, the KB is also marked REPAIR_REQUIRED.
//! * COMMITTING, ref == intended: apply the persisted delta and FINALIZE,
//!   exactly once (guarded by the phase transition in one transaction).
//! * COMMITTING, ref == expected old: abort.
//! * any third value: mark the KB REPAIR_REQUIRED, leave the row and the ref
//!   untouched — never reset, never adopt.
//!
//! Object-only garbage of aborted operations stays unreachable.
//!
//! A publication's lock ([`Store::lock_publication`]) then bounds the packs
//! of the KBs it locked: a geometric rollup of the small packs under a
//! short budget, backed off durably when it is deferred.

use std::time::{Duration, Instant};

use kb_client::ErrorCode;
use kb_client::types::{KbId, Sha};

use crate::git_read::GitRepo;
use crate::git_write;
use crate::journal::{Delta, Phase};
use crate::locks::{self, WriteGuard};
use crate::store::{KbRecord, KbState, Store, StoreError};

/// Bound for a read waiting on the write lock to finish recovery
/// (lock acquisition max 5s).
pub const READ_GATE_TIMEOUT: Duration = Duration::from_secs(5);

/// Outcome counts of one recovery pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub finalized: usize,
    pub aborted: usize,
    pub repair_required: usize,
}

/// A durable record of a deferred or failed pack rollup of one KB
/// (`pack_consolidation`): the next rollup waits until the repository's
/// pressure (packs plus loose sample) reaches `retry_level`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsolidationDeferral {
    /// Protocol code of the deferral (`QUOTA_EXCEEDED` for disk headroom,
    /// `DEADLINE_EXCEEDED` for the pass budget, ...).
    pub code: String,
    pub level: u64,
    pub deferrals: u64,
    pub at_ms: u64,
}

/// Time a caller must have left, beyond the rollup budget, for a rollup to
/// start inside its call.
const CONSOLIDATE_MARGIN: Duration = Duration::from_secs(3);

fn deferral_row(r: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<ConsolidationDeferral> {
    Ok(ConsolidationDeferral {
        code: r.get(at)?,
        level: r.get::<_, i64>(at + 1)?.max(0) as u64,
        deferrals: r.get::<_, i64>(at + 2)?.max(0) as u64,
        at_ms: r.get::<_, i64>(at + 3)?.max(0) as u64,
    })
}

/// What one rollup attempt does to the back-off row.
#[derive(Debug, PartialEq, Eq)]
enum Settle {
    Nothing,
    /// Maintenance complete or no work remains: the back-off is over.
    Clear,
    /// Deferred or failed: record it.
    Record {
        code: &'static str,
        deferrals: u64,
    },
}

fn settle(
    deferred: Option<&ConsolidationDeferral>,
    result: &Result<git_write::ConsolidationOutcome, StoreError>,
) -> Settle {
    match (result, deferred) {
        (
            Ok(
                git_write::ConsolidationOutcome::Complete
                | git_write::ConsolidationOutcome::Progress
                | git_write::ConsolidationOutcome::NoWork,
            ),
            Some(_),
        ) => Settle::Clear,
        (
            Ok(
                git_write::ConsolidationOutcome::Complete
                | git_write::ConsolidationOutcome::Progress
                | git_write::ConsolidationOutcome::NoWork,
            ),
            None,
        ) => Settle::Nothing,
        (Err(e) | Ok(git_write::ConsolidationOutcome::CleanupPending(e)), _)
            if e.protocol_code() == ErrorCode::Cancelled =>
        {
            Settle::Nothing
        }
        (Err(e) | Ok(git_write::ConsolidationOutcome::CleanupPending(e)), d) => Settle::Record {
            code: e.protocol_code().as_str(),
            deferrals: d.map_or(1, |d| d.deferrals.saturating_add(1)),
        },
    }
}

impl ConsolidationDeferral {
    /// Back-off: each deferral doubles the growth a retry waits for.
    pub fn retry_level(&self) -> u64 {
        let step = (git_write::CONSOLIDATE_PACKS as u64) << self.deferrals.saturating_sub(1).min(4);
        self.level.saturating_add(step)
    }
}

impl Store {
    /// Resolve every unresolved journal row. Requires the store lock.
    pub fn recover(&self, guard: &WriteGuard) -> Result<RecoveryReport, StoreError> {
        self.check_guard(guard)?;
        crate::git_read::OperationDeadline::check()?;
        crate::uploads::sweep_transfers(&self.conn, &self.paths, self.now_ms())?;
        crate::git_read::OperationDeadline::check()?;
        crate::cas::recover_temps(&self.paths, guard)?;
        git_write::recover_scratch(&self.paths, &self.conn)?;
        crate::git_read::OperationDeadline::check()?;
        self.reconcile_unregistered_repos()?;
        self.recover_pending(guard, None)
    }

    /// [`Store::lock_write`] for a publication (commit, change set, PR
    /// merge), which then bounds the packs of the KBs it locked. The first
    /// requested KB is the publication destination and gets maintenance first;
    /// lock acquisition itself remains sorted.
    pub fn lock_publication(&self, kbs: &[KbId]) -> Result<WriteGuard, StoreError> {
        let guard = self.lock_write(kbs)?;
        self.consolidate_locked(&guard, kbs.first())?;
        Ok(guard)
    }

    /// At most one rollup ([`git_write::consolidate_objects`]) per
    /// publication lock, for the KBs it holds, inside its own budget, and
    /// only when the caller's deadline leaves that budget plus a margin (a
    /// caller short of time is never spent on maintenance). The outcome is
    /// recorded in `pack_consolidation`; fold failures and pending cleanup
    /// share retry spacing.
    /// The caller's own deadline or cancellation fails the lock unrecorded.
    pub(crate) fn consolidate_locked(
        &self,
        guard: &WriteGuard,
        preferred: Option<&KbId>,
    ) -> Result<(), StoreError> {
        self.consolidate_scheduled(guard, true, preferred)
    }

    /// Test hook: run the real fold/settlement under a held fence, with retry
    /// admission and its clock injected as ready. Functional progress tests
    /// need neither 128 extra packs nor a particular disk speed; budget kills
    /// are tested independently with a running child. Returns whether an intent
    /// remains, so a functional test can drain successive bounded batches.
    #[doc(hidden)]
    pub fn consolidate_now_for_tests(&self, guard: &WriteGuard) -> Result<bool, StoreError> {
        self.consolidate_scheduled(guard, false, None)?;
        for kb in guard.kb_ids() {
            if git_write::has_cleanup_intent(&self.conn, kb)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn consolidate_scheduled(
        &self,
        guard: &WriteGuard,
        scheduled: bool,
        preferred: Option<&KbId>,
    ) -> Result<(), StoreError> {
        self.check_guard(guard)?;
        let budget = git_write::CONSOLIDATE_BUDGET;
        if crate::git_read::OperationDeadline::remaining()
            .is_some_and(|left| left < budget + CONSOLIDATE_MARGIN)
        {
            return Ok(());
        }
        // One budget for all speculative probes and the one actual attempt.
        #[cfg(test)]
        let injected = crate::git_read::PACK_INSTALL_PROBE.with(|p| p.borrow().is_some())
            || git_write::AFTER_ROLLUP_INSTALL.with(|p| p.borrow().is_some())
            || git_write::BEFORE_PRUNE.with(|p| p.borrow().is_some())
            || git_write::BEFORE_ROLLUP_INTENT.with(|p| p.borrow().is_some())
            || git_write::AFTER_ROLLUP_INTENT.with(|p| p.borrow().is_some());
        #[cfg(not(test))]
        let injected = false;
        let maintenance_end = crate::git_read::OperationDeadline::now() + budget;
        // Lock order stays sorted; maintenance starts with the publication's
        // destination (the first requested KB), then probes the other locks.
        let ordered = preferred
            .into_iter()
            .chain(guard.kb_ids().iter().filter(|kb| Some(*kb) != preferred));
        for kb in ordered {
            let maintenance_budget = (scheduled && !injected).then(|| {
                crate::git_read::OperationDeadline::budget(
                    maintenance_end
                        .saturating_duration_since(crate::git_read::OperationDeadline::now()),
                )
            });
            if self.kb(kb)?.map(|kb| kb.state) != Some(KbState::Active) {
                continue;
            }
            let Ok(pressure) = git_write::Pressure::measure(&self.paths, &self.paths.repo_dir(kb))
            else {
                continue;
            };
            let deferred = self.pack_consolidation(kb)?;
            if !pressure.due() && !git_write::has_cleanup_intent(&self.conn, kb)? {
                // A prior failure can outlive the work (for example after
                // offline packing). No retry or reduced cap is needed to
                // leave that idle state: discard stale failure history.
                if deferred.is_some() {
                    self.conn.execute(
                        "DELETE FROM pack_consolidation WHERE kb_id=?1",
                        [kb.as_str()],
                    )?;
                }
                continue;
            }
            if scheduled
                && deferred
                    .as_ref()
                    .is_some_and(|d| pressure.level() < d.retry_level())
            {
                continue;
            }
            let result = git_write::consolidate_objects(
                &self.paths,
                kb,
                guard,
                &self.conn,
                &pressure,
                |bytes| self.check_disk_admission(bytes),
            );
            let no_work = matches!(result, Ok(git_write::ConsolidationOutcome::NoWork));
            drop(maintenance_budget);
            // Outside the nested budget: caller interruption is not a failed
            // maintenance attempt and must not change the retry history.
            crate::git_read::OperationDeadline::check()?;
            match settle(deferred.as_ref(), &result) {
                Settle::Nothing => {}
                Settle::Clear => {
                    self.conn.execute(
                        "DELETE FROM pack_consolidation WHERE kb_id=?1",
                        [kb.as_str()],
                    )?;
                }
                Settle::Record { code, deferrals } => {
                    self.conn.execute(
                        "INSERT INTO pack_consolidation(kb_id,code,level,deferrals,at_ms) VALUES(?1,?2,?3,?4,?5)
                         ON CONFLICT(kb_id) DO UPDATE SET code=excluded.code, level=excluded.level,
                           deferrals=excluded.deferrals, at_ms=excluded.at_ms",
                        rusqlite::params![
                            kb.as_str(),
                            code,
                            i64::try_from(pressure.level()).unwrap_or(i64::MAX),
                            i64::try_from(deferrals).unwrap_or(i64::MAX),
                            i64::try_from(self.now_ms()).unwrap_or(i64::MAX),
                        ],
                    )?;
                }
            }
            if !no_work {
                return crate::git_read::OperationDeadline::check();
            }
        }
        crate::git_read::OperationDeadline::check()
    }

    /// Recorded rollup deferrals, most recent first (diagnostics).
    pub fn pack_consolidation_deferrals(
        &self,
        limit: usize,
    ) -> Result<Vec<(KbId, ConsolidationDeferral)>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT kb_id,code,level,deferrals,at_ms FROM pack_consolidation ORDER BY at_ms DESC, kb_id LIMIT ?1",
        )?;
        let rows = stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            Ok((r.get::<_, String>(0)?, deferral_row(r, 1)?))
        })?;
        rows.map(|row| {
            let (kb, d) = row?;
            KbId::parse(&kb)
                .map(|kb| (kb, d))
                .map_err(|_| StoreError::RecoveryRequired("malformed kb id".into()))
        })
        .collect()
    }

    /// The recorded deferral of `kb`'s maintenance, including pending cleanup.
    pub fn pack_consolidation(
        &self,
        kb: &KbId,
    ) -> Result<Option<ConsolidationDeferral>, StoreError> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn
            .query_row(
                "SELECT code,level,deferrals,at_ms FROM pack_consolidation WHERE kb_id=?1",
                [kb.as_str()],
                |r| deferral_row(r, 0),
            )
            .optional()?)
    }

    /// The global fence excludes every publisher; scoped reads must settle
    /// their KB even when unrelated retained history fills earlier pages.
    fn recover_pending(
        &self,
        guard: &WriteGuard,
        kb: Option<&KbId>,
    ) -> Result<RecoveryReport, StoreError> {
        self.check_guard(guard)?;
        let mut report = RecoveryReport::default();
        let mut after = None;
        loop {
            let rows = self.pending(kb, after.as_ref())?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                after = Some(row.op_id.clone());
                crate::git_read::OperationDeadline::check()?;
                let create = row.operation == "KB_CREATE";
                let state = self.kb(&row.kb_id)?.map(|kb| kb.state);
                if state == Some(KbState::RepairRequired) {
                    report.repair_required += 1;
                    continue;
                }
                // A tombstone aborted every PREPARED row; a COMMITTING row can
                // only survive on a KB that was already REPAIR_REQUIRED, and it
                // stays for inspection (the retained repo is never touched).
                if state == Some(KbState::Tombstoned) && row.phase == Phase::Committing {
                    continue;
                }
                // PREPARED create never attempted a CAS and may not even have
                // initialized Git. Every other observation must succeed before
                // it can prove divergence or settle the intent.
                if create && row.phase == Phase::Prepared {
                    self.abort_intent(&row.op_id, &row.kb_id, true, ErrorCode::Conflict)?;
                    report.aborted += 1;
                    continue;
                }
                let repo = GitRepo::for_kb(&self.paths, &row.kb_id)?;
                let actual = git_write::read_ref(&repo, &row.ref_name)?;
                // A cancelled reader is not evidence of ref divergence.
                crate::git_read::OperationDeadline::check()?;
                match row.phase {
                    Phase::Prepared => {
                        self.abort_intent(&row.op_id, &row.kb_id, create, ErrorCode::Conflict)?;
                        report.aborted += 1;
                        // An uninitialized repository of an unpublished create is
                        // expected; anything else must still show the old ref.
                        let consistent = actual == row.expected_old;
                        if !consistent && !create {
                            self.mark_repair(&row.kb_id)?;
                            report.repair_required += 1;
                        }
                    }
                    Phase::Committing => {
                        // Only the exact pending CAS can own this Git temporary
                        // ref lock. All descendants are drained under `guard`.
                        if actual.is_some() && actual == row.intended_new {
                            git_write::recover_ref_lock(&self.paths, &repo, &row, guard)?;
                            git_write::sync_ref(&repo, &row.ref_name)?;
                            let delta = Delta::parse(row.delta.as_deref().unwrap_or(""))?;
                            self.finalize_intent(&row.op_id, &row.kb_id, &delta, &mut |_| Ok(()))?;
                            report.finalized += 1;
                        } else if actual == row.expected_old {
                            git_write::recover_ref_lock(&self.paths, &repo, &row, guard)?;
                            self.abort_intent(&row.op_id, &row.kb_id, create, ErrorCode::Conflict)?;
                            report.aborted += 1;
                        } else {
                            self.mark_repair(&row.kb_id)?;
                            report.repair_required += 1;
                        }
                    }
                    Phase::Finalized | Phase::Aborted => {}
                }
            }
        }
        Ok(report)
    }

    /// The two reservation callers create an EMPTY generated repository before
    /// their SQL commit. Git only runs after commit. A killed pre-commit owner
    /// therefore leaves this exact, safely identifiable empty directory class.
    fn reconcile_unregistered_repos(&self) -> Result<(), StoreError> {
        let parent = self.paths.root().join("repos");
        self.paths.check_no_follow(&parent)?;
        for entry in std::fs::read_dir(&parent).map_err(StoreError::Io)? {
            let entry = entry.map_err(StoreError::Io)?;
            let name = entry.file_name();
            let Some(id) = name
                .to_str()
                .and_then(|n| n.strip_prefix("kb_"))
                .and_then(|n| n.strip_suffix(".git"))
                .and_then(|n| KbId::parse(n).ok())
            else {
                return Err(StoreError::RecoveryRequired(
                    "unknown repository entry".into(),
                ));
            };
            if self.kb(&id)?.is_some() {
                continue;
            } // includes retained tombstones
            let path = entry.path();
            self.paths.check_no_follow(&path)?;
            let meta = std::fs::symlink_metadata(&path).map_err(StoreError::Io)?;
            if crate::paths::is_link(&meta) || !meta.is_dir() {
                return Err(StoreError::UnsafePath(
                    "unregistered repository is not a directory".into(),
                ));
            }
            crate::paths::ensure_dir(self.paths.root(), &["repos", &name.to_string_lossy()])?;
            // remove_dir is deliberately nonrecursive: unexpected data is
            // preserved for repair, including data added after our inspection.
            std::fs::remove_dir(&path).map_err(|_| {
                StoreError::RecoveryRequired("unregistered repository contains data".into())
            })?;
            crate::paths::sync_dir(&parent)?;
        }
        Ok(())
    }

    /// Whether `kb` has unresolved journal rows.
    fn has_pending(&self, kb: &KbId) -> Result<bool, StoreError> {
        Ok(!self.pending(Some(kb), None)?.is_empty())
    }

    /// Take the write lock for recovery, waiting at most
    /// [`READ_GATE_TIMEOUT`].
    fn lock_for_read_gate(&self, kb: &KbId) -> Result<WriteGuard, StoreError> {
        let deadline = Instant::now() + READ_GATE_TIMEOUT;
        loop {
            crate::git_read::OperationDeadline::check()?;
            if let Some(guard) = locks::acquire(&self.paths, std::slice::from_ref(kb), false)? {
                crate::git_read::OperationDeadline::check()?;
                return Ok(guard);
            }
            if Instant::now() >= deadline {
                return Err(StoreError::StorageUnavailable(
                    "knowledge base is being recovered".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Gated read of a live KB: interrupted publications of `kb` are
    /// resolved first (without waiting for a later write), and the actual
    /// main ref must equal the recorded head (an external edit marks the KB
    /// REPAIR_REQUIRED). CREATING/TOMBSTONED -> NOT_FOUND.
    pub fn read_kb(&self, kb: &KbId) -> Result<KbRecord, StoreError> {
        self.read_kb_sampled(kb, || Ok(()))
    }

    pub(crate) fn read_kb_locked(
        &self,
        guard: &WriteGuard,
        kb: &KbId,
    ) -> Result<KbRecord, StoreError> {
        self.check_guard(guard)?;
        self.recover_pending(guard, Some(kb))?;
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        match record.state {
            KbState::RepairRequired => {
                return Err(StoreError::RecoveryRequired(
                    "knowledge base needs repair".into(),
                ));
            }
            KbState::Creating | KbState::Tombstoned => return Err(StoreError::NotFound),
            KbState::Active => {}
        }
        let head = record
            .head_sha
            .as_deref()
            .and_then(|s| Sha::parse(s).ok())
            .ok_or_else(|| StoreError::RecoveryRequired("active kb without head".into()))?;
        if git_write::read_main(&GitRepo::for_kb(&self.paths, kb)?)?.as_ref() != Some(&head) {
            self.mark_repair(kb)?;
            return Err(StoreError::RecoveryRequired(
                "main ref changed outside the store".into(),
            ));
        }
        Ok(record)
    }

    fn read_kb_sampled(
        &self,
        kb: &KbId,
        sampled: impl FnOnce() -> Result<(), StoreError>,
    ) -> Result<KbRecord, StoreError> {
        if self.pending_index_recovery.get() {
            drop(self.lock_write(std::slice::from_ref(kb))?);
        }
        if self.has_pending(kb)? {
            let guard = self.lock_for_read_gate(kb)?;
            self.recover_pending(&guard, Some(kb))?;
            drop(guard);
        }
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        match record.state {
            KbState::Active => {}
            KbState::RepairRequired => {
                return Err(StoreError::RecoveryRequired(
                    "knowledge base needs repair".into(),
                ));
            }
            KbState::Creating | KbState::Tombstoned => return Err(StoreError::NotFound),
        }
        let head = record
            .head_sha
            .as_deref()
            .and_then(|s| Sha::parse(s).ok())
            .ok_or_else(|| StoreError::RecoveryRequired("active kb without head".into()))?;
        let repo = GitRepo::for_kb(&self.paths, kb)?;
        sampled()?;
        if git_write::read_main(&repo)?.as_ref() != Some(&head) {
            // Recheck under the lock (a writer may have just finalized).
            let guard = self.lock_for_read_gate(kb)?;
            // A publisher could have created COMMITTING after our initial
            // sample and then died. Recover under the classification fence.
            self.recover_pending(&guard, Some(kb))?;
            let fresh = self.kb(kb)?.ok_or(StoreError::NotFound)?;
            match fresh.state {
                KbState::Creating | KbState::Tombstoned => return Err(StoreError::NotFound),
                KbState::RepairRequired => {
                    return Err(StoreError::RecoveryRequired(
                        "knowledge base needs repair".into(),
                    ));
                }
                KbState::Active => {}
            }
            let recorded = fresh.head_sha.as_deref().and_then(|s| Sha::parse(s).ok());
            if fresh.state == KbState::Active && git_write::read_main(&repo)? == recorded {
                drop(guard);
                return Ok(fresh);
            }
            self.mark_repair(kb)?;
            drop(guard);
            return Err(StoreError::RecoveryRequired(
                "main ref changed outside the store".into(),
            ));
        }
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommitRequest, CreateKbRequest, FileChange, Stage};

    #[test]
    fn idle_lock_write_skips_directory_fsyncs_but_recovery_fences_changes() {
        let root = std::env::temp_dir().join(format!(
            "kb-recovery-sync-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = Store::open(&root).expect("fixture");
        let root = store.paths.root().to_path_buf();
        crate::paths::take_directory_syncs();
        for _ in 0..3 {
            drop(store.lock_write(&[]).expect("idle recovery"));
            assert!(crate::paths::take_directory_syncs().is_empty());
        }
        drop(
            store
                .try_lock_write(&[])
                .expect("idle nonblocking recovery"),
        );
        assert!(crate::paths::take_directory_syncs().is_empty());

        let tmp = root.join("assets/tmp");
        let uploads = store.paths.uploads_dir();
        let id = crate::state::new_uuid_v4().expect("fixture");
        let temp = tmp.join(format!("cas-{id}"));
        let scratch = uploads.join(format!("publish-{id}"));
        std::fs::write(&temp, b"abandoned").expect("fixture");
        crate::paths::create_private_dir(&scratch).expect("fixture");
        std::fs::write(scratch.join("input"), b"abandoned").expect("fixture");
        std::fs::write(tmp.join("foreign"), b"preserve").expect("fixture");
        std::fs::write(uploads.join("foreign"), b"preserve").expect("fixture");
        drop(store.lock_write(&[]).expect("remove abandoned entries"));
        assert!(!temp.exists());
        assert!(!scratch.exists());
        assert_eq!(
            crate::paths::take_directory_syncs(),
            vec![tmp.clone(), uploads]
        );
        drop(store.lock_write(&[]).expect("only foreign entries remain"));
        assert!(crate::paths::take_directory_syncs().is_empty());
        assert!(tmp.join("foreign").exists());

        std::fs::remove_file(tmp.join("foreign")).expect("fixture");
        std::fs::remove_dir(&tmp).expect("fixture");
        std::fs::remove_dir(root.join("assets")).expect("fixture");
        drop(
            store
                .lock_write(&[])
                .expect("recreate disposable directories"),
        );
        assert_eq!(
            crate::paths::take_directory_syncs(),
            vec![root.clone(), root.join("assets")],
            "each newly created entry must be fenced in its containing directory"
        );
        drop(
            store
                .lock_write(&[])
                .expect("durable directories already exist"),
        );
        assert!(crate::paths::take_directory_syncs().is_empty());
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn temp_recovery_fences_successful_removal_even_when_another_entry_fails() {
        let root = std::env::temp_dir().join(format!(
            "kb-recovery-sync-error-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = Store::open(&root).expect("fixture");
        let tmp = store.paths.root().join("assets/tmp");
        let temp = tmp.join(format!(
            "cas-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let link = tmp.join(format!(
            "cas-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        std::fs::write(&temp, b"abandoned").expect("fixture");
        std::os::unix::fs::symlink("foreign", &link).expect("fixture");
        crate::paths::take_directory_syncs();
        assert!(matches!(
            store.lock_write(&[]),
            Err(StoreError::UnsafePath(_))
        ));
        assert!(!temp.exists());
        assert_eq!(crate::paths::take_directory_syncs(), vec![tmp]);
        assert!(
            std::fs::symlink_metadata(link)
                .expect("preserved link")
                .is_symlink()
        );
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn read_snapshot_then_interrupted_publication_recovers_under_classification_fence() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("read-race fixture operation")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("r52b-read-race-{}-{nonce}", std::process::id()));
        let store = Store::open(&root).expect("read-race fixture operation");
        let created = store
            .create_kb(
                &store.owner(),
                CreateKbRequest {
                    name: "Race".into(),
                    slug: "race".into(),
                    description: "Read publication race fixture".into(),
                    idempotency_key: "race-create-00001".into(),
                },
            )
            .expect("read-race fixture operation");
        let request = CommitRequest {
            kb: created.kb_id.clone(),
            base_revision: created.commit_sha.clone(),
            idempotency_key: "race-commit-00001".into(),
            changes: vec![FileChange {
                path: "note.md".into(),
                content: Some(b"race\n".to_vec()),
            }],
        };
        // Execute the real publisher in the precise gap after the reader's
        // old registry/no-pending sample. Only scheduling is controlled.
        let fresh = store
            .read_kb_sampled(&created.kb_id, || {
                let result =
                    store.commit_files_observed(&store.owner(), request.clone(), &mut |stage| {
                        if stage == Stage::Finalizing {
                            return Err(StoreError::StorageUnavailable("interrupted".into()));
                        }
                        Ok(())
                    });
                assert!(result.is_err());
                Ok(())
            })
            .expect("read-race fixture operation");
        assert_eq!(fresh.state, KbState::Active);
        assert_eq!(fresh.desired_epoch, 2);
        let receipt = store
            .commit_files(&store.owner(), request)
            .expect("read-race fixture operation");
        assert_eq!(fresh.head_sha.as_deref(), Some(receipt.commit_sha.as_str()));
        assert_eq!(
            store
                .read_kb(&created.kb_id)
                .expect("read-race fixture operation")
                .desired_epoch,
            2
        );
        drop(store);
        std::fs::remove_dir_all(root).expect("read-race fixture operation");
    }
}

#[cfg(test)]
mod settle_tests {
    use super::*;

    fn row(level: u64, deferrals: u64) -> ConsolidationDeferral {
        ConsolidationDeferral {
            code: "DEADLINE_EXCEEDED".into(),
            level,
            deferrals,
            at_ms: 1,
        }
    }

    #[test]
    fn fold_failures_and_pending_cleanup_share_spacing_but_completion_clears_it() {
        assert_eq!(
            settle(None, &Ok(git_write::ConsolidationOutcome::Complete)),
            Settle::Nothing
        );
        assert_eq!(
            settle(
                Some(&row(8, 5)),
                &Ok(git_write::ConsolidationOutcome::Complete)
            ),
            Settle::Clear
        );
        assert_eq!(
            settle(Some(&row(8, 2)), &Err(StoreError::DeadlineExceeded)),
            Settle::Record {
                code: "DEADLINE_EXCEEDED",
                deferrals: 3
            }
        );
        assert_eq!(
            settle(
                Some(&row(8, 2)),
                &Err(StoreError::OperationAborted(ErrorCode::Cancelled))
            ),
            Settle::Nothing
        );
    }

    #[test]
    fn no_work_clears_stale_history_without_claiming_completed_maintenance() {
        assert_eq!(
            settle(
                Some(&row(27, 2)),
                &Ok(git_write::ConsolidationOutcome::NoWork)
            ),
            Settle::Clear
        );
    }

    #[test]
    fn pending_cleanup_is_not_a_failed_fold_or_a_completed_pass() {
        let pending = Ok(git_write::ConsolidationOutcome::CleanupPending(
            StoreError::DeadlineExceeded,
        ));
        assert_eq!(
            settle(None, &pending),
            Settle::Record {
                code: "DEADLINE_EXCEEDED",
                deferrals: 1
            }
        );
        assert_eq!(
            settle(Some(&row(27, 2)), &pending),
            Settle::Record {
                code: "DEADLINE_EXCEEDED",
                deferrals: 3
            }
        );
    }

    /// A due KB repository: eight equal unreachable one-blob packs.
    fn due_store(tag: &str) -> (std::path::PathBuf, Store, KbId) {
        use kb_client::{decode_input, types::BasesCreate};
        let base = std::env::temp_dir().join(format!(
            "kb-local-rollup-{tag}-{}",
            crate::state::new_uuid_v4().expect("id")
        ));
        let store = Store::open(&base.join("store")).expect("store");
        let kb = store
            .bases_create(
                &store.owner(),
                decode_input::<BasesCreate>(serde_json::json!({
                    "name": "Rollup", "slug": "rollup",
                    "description": "Rollup deadline fixture",
                    "idempotencyKey": "rollup-create-0001",
                }))
                .expect("input"),
            )
            .expect("kb")
            .kb
            .id;
        let repo = store.paths().repo_dir(&kb);
        for i in 0..git_write::CONSOLIDATE_PACKS {
            let git = |args: &[&str], input: String| {
                use std::io::Write;
                let mut child = std::process::Command::new("git")
                    // Fixture creation is not a durability test; the rollup
                    // below still uses the hardened, fsynced installer.
                    .args(["-c", "core.fsync=none"])
                    .arg("--git-dir")
                    .arg(&repo)
                    .args(args)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .spawn()
                    .expect("git");
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(input.as_bytes())
                    .unwrap();
                let out = child.wait_with_output().expect("git");
                assert!(out.status.success());
                String::from_utf8(out.stdout).unwrap().trim().to_owned()
            };
            let sha = git(&["hash-object", "-w", "--stdin"], format!("blob {i}\n"));
            let prefix = repo.join("objects/pack/pack");
            git(
                &["pack-objects", "-q", prefix.to_str().unwrap()],
                format!("{sha}\n"),
            );
        }
        let output = std::process::Command::new("git")
            .arg("--git-dir")
            .arg(&repo)
            .args(["prune-packed", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
        (base, store, kb)
    }

    fn packs(store: &Store, kb: &KbId) -> usize {
        git_write::Pressure::measure(store.paths(), &store.paths().repo_dir(kb))
            .expect("pressure")
            .packs
            .len()
    }

    /// m-r4b: a caller short of time (search's late locks, a nearly spent
    /// tool call) is never spent on a rollup; a cancelled caller fails
    /// without a rollup or a record; a caller with time attempts the rollup.
    #[test]
    fn a_rollup_never_spends_a_short_or_cancelled_callers_time() {
        use crate::git_read::OperationDeadline;
        let (base, store, kb) = due_store("deadline");
        let due = packs(&store, &kb);
        assert!(due >= git_write::CONSOLIDATE_PACKS);
        {
            let _short = OperationDeadline::for_test(git_write::CONSOLIDATE_BUDGET);
            drop(
                store
                    .lock_publication(std::slice::from_ref(&kb))
                    .expect("lock"),
            );
        }
        assert_eq!(packs(&store, &kb), due, "skipped for a short caller");
        assert_eq!(store.pack_consolidation(&kb).unwrap(), None, "unrecorded");
        {
            let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
            let _cancelled =
                OperationDeadline::bounded(Instant::now() + Duration::from_secs(60), cancel);
            let err = store
                .lock_publication(std::slice::from_ref(&kb))
                .expect_err("cancelled caller");
            assert_eq!(err.protocol_code(), ErrorCode::Cancelled);
        }
        assert_eq!(packs(&store, &kb), due);
        assert_eq!(store.pack_consolidation(&kb).unwrap(), None);
        {
            let _ample = OperationDeadline::for_test(Duration::from_secs(30));
            drop(
                store
                    .lock_publication(std::slice::from_ref(&kb))
                    .expect("lock"),
            );
        }
        assert!(
            packs(&store, &kb) < due || store.pack_consolidation(&kb).unwrap().is_some(),
            "an ample caller attempts maintenance (which may exhaust its own budget)"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    /// The feeder is parked after spawn: index-pack is live and has created
    /// tmp_pack_* in real publish scratch when its watchdog kills it.
    #[test]
    fn a_rollup_over_its_budget_kills_git_cleans_scratch_and_allows_the_lock() {
        interrupted_pack_install(Interruption::Budget);
    }

    #[test]
    fn cancellation_during_a_fold_does_not_count_as_a_failed_attempt() {
        interrupted_pack_install(Interruption::Cancellation);
    }

    #[test]
    fn a_callers_deadline_during_a_fold_does_not_count_as_a_failed_attempt() {
        interrupted_pack_install(Interruption::CallerDeadline);
    }

    #[derive(Clone, Copy)]
    enum Interruption {
        Budget,
        Cancellation,
        CallerDeadline,
    }

    fn interrupted_pack_install(interruption: Interruption) {
        use crate::git_read::{OperationDeadline, PACK_INSTALL_PROBE, PackInstallProbe};
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        };
        let (base, store, kb) = due_store("running-child");
        let due = packs(&store, &kb);
        let caller_interrupted = !matches!(interruption, Interruption::Budget);
        if caller_interrupted {
            store.conn.execute(
                "INSERT INTO pack_consolidation(kb_id,code,level,deferrals,at_ms) VALUES(?1,'QUOTA_EXCEEDED',0,1,0)",
                [kb.as_str()],
            ).unwrap();
        }
        let previous = store.pack_consolidation(&kb).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let scope =
            OperationDeadline::bounded(Instant::now() + Duration::from_secs(60), cancel.clone());
        let observed = Arc::new(Mutex::new(None));
        let caller_expiry = Arc::new(Mutex::new(None));
        PACK_INSTALL_PROBE.set(Some(PackInstallProbe {
            budget: (!matches!(interruption, Interruption::Cancellation)).then_some(Duration::ZERO),
            indexed: Box::new({
                let observed = observed.clone();
                let caller_expiry = caller_expiry.clone();
                move |child, scratch_pack| {
                    assert!(
                        child.lock().unwrap().try_wait().unwrap().is_none(),
                        "indexer is running"
                    );
                    let until = Instant::now() + Duration::from_secs(5);
                    loop {
                        if std::fs::read_dir(&scratch_pack).is_ok_and(|entries| {
                            entries.into_iter().any(|e| {
                                e.unwrap()
                                    .file_name()
                                    .to_string_lossy()
                                    .starts_with("tmp_pack_")
                            })
                        }) {
                            break;
                        }
                        assert!(Instant::now() < until, "indexer created its scratch pack");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    match interruption {
                        Interruption::Budget => {}
                        Interruption::Cancellation => cancel.store(true, Ordering::Release),
                        Interruption::CallerDeadline => {
                            *caller_expiry.lock().unwrap() =
                                Some(OperationDeadline::for_test(Duration::ZERO));
                        }
                    }
                    // Return without waiting/reaping: the real installer must
                    // drain the killed child before scratch can be removed.
                    *observed.lock().unwrap() = Some((child, scratch_pack));
                }
            }),
        }));
        let lock = store.lock_publication(std::slice::from_ref(&kb));
        if caller_interrupted {
            assert_eq!(
                lock.expect_err("caller interrupted").protocol_code(),
                if matches!(interruption, Interruption::Cancellation) {
                    ErrorCode::Cancelled
                } else {
                    ErrorCode::DeadlineExceeded
                }
            );
            assert_eq!(
                store.pack_consolidation(&kb).unwrap(),
                previous,
                "caller interruption preserves retry history"
            );
        } else {
            drop(lock.expect("maintenance timeout does not fail lock"));
            let recorded = store.pack_consolidation(&kb).unwrap().expect("recorded");
            assert_eq!(recorded.code, "DEADLINE_EXCEEDED");
            assert_eq!(recorded.deferrals, 1);
        }
        drop(caller_expiry.lock().unwrap().take());
        drop(scope);
        let (child, scratch_pack) = observed.lock().unwrap().take().expect("child was observed");
        let status = child.lock().unwrap().try_wait().unwrap().expect("reaped");
        assert!(!status.success(), "child was killed");
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9), "watchdog sent SIGKILL");
        }
        assert!(
            !scratch_pack.exists(),
            "scratch including tmp_pack_* removed"
        );
        assert_eq!(packs(&store, &kb), due, "no pack installed");
        assert!(
            !std::fs::read_dir(store.paths().uploads_dir())
                .unwrap()
                .any(|e| {
                    e.unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with("publish-")
                })
        );
        // Reentry really acquires the fence after both children were drained.
        drop(
            store
                .lock_write(std::slice::from_ref(&kb))
                .expect("reentry"),
        );
        drop(store);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn blocked_pack_retirement_reuses_the_install_across_publications_and_restart() {
        cleanup_retry(CleanupFault::Retirement);
    }

    #[test]
    fn blocked_pack_data_retirement_is_not_retried_by_orphan_recovery() {
        cleanup_retry(CleanupFault::PackData);
    }

    #[test]
    fn pruning_timeouts_reuse_the_install_across_publications_and_restart() {
        cleanup_retry(CleanupFault::Timeout);
    }

    #[cfg(unix)]
    #[test]
    fn failed_unlinks_with_successful_git_exit_reuse_the_rollup() {
        cleanup_retry(CleanupFault::Unlink);
    }

    #[derive(Clone, Copy)]
    enum CleanupFault {
        Retirement,
        PackData,
        Timeout,
        #[cfg(unix)]
        Unlink,
    }

    struct CleanupFixture(std::path::PathBuf);
    impl Drop for CleanupFixture {
        fn drop(&mut self) {
            git_write::BLOCK_RETIREMENT.set(false);
            git_write::BLOCK_PACK_DATA.set(false);
            git_write::BEFORE_PRUNE.set(None);
            git_write::AFTER_ROLLUP_INSTALL.set(None);
            git_write::BEFORE_ROLLUP_INTENT.set(None);
            git_write::AFTER_ROLLUP_INTENT.set(None);
            git_write::AFTER_RETIREMENT_UNLINK.set(None);
            #[cfg(unix)]
            fn restore_dirs(path: &std::path::Path) {
                use std::os::unix::fs::PermissionsExt;
                if path.is_dir() {
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
                    if let Ok(entries) = std::fs::read_dir(path) {
                        for entry in entries.flatten() {
                            restore_dirs(&entry.path());
                        }
                    }
                }
            }
            #[cfg(unix)]
            restore_dirs(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn cleanup_retry(fault: CleanupFault) {
        use crate::git_read::OperationDeadline;
        let (base, store, kb) = due_store("cleanup");
        let fixture = CleanupFixture(base);
        let mut store = store; // Drop the store before the fixture, including on unwind.
        // A genuinely loose, unreachable object to fold along with the packs.
        let repo = store.paths().repo_dir(&kb);
        let (bodies, publication_content) = match fault {
            #[cfg(unix)]
            CleanupFault::Unlink => {
                let mut bodies: Vec<_> = (0..)
                    .filter_map(|n| {
                        let body = format!("unlink sample {n}\n").into_bytes();
                        let header = format!("blob {}\0", body.len());
                        let digest = ring::digest::digest(
                            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
                            &[header.as_bytes(), &body].concat(),
                        );
                        (digest.as_ref()[0] == 0x17).then_some(body)
                    })
                    .take(git_write::CONSOLIDATE_LOOSE_SAMPLE + 1)
                    .collect();
                // Force a later publication to write into the blocked fan-out;
                // random commit/tree hashes used to hit this only occasionally.
                let publication_content = bodies.pop();
                (bodies, publication_content)
            }
            _ => (vec![b"unreachable cleanup object".to_vec()], None),
        };
        let mut loose = Vec::new();
        for body in bodies {
            use std::io::Write;
            let mut child = std::process::Command::new("git")
                .arg("--git-dir")
                .arg(&repo)
                .args(["hash-object", "-w", "--stdin"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(&body).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success());
            loose.push(String::from_utf8(out.stdout).unwrap().trim().to_owned());
        }
        let unreachable = loose[0].clone();
        git_write::ROLLUP_INSTALLS.set(0);
        git_write::RETIREMENT_ATTEMPTS.set(0);
        #[cfg(unix)]
        let blocked_dir = repo.join("objects").join(&unreachable[..2]);
        git_write::AFTER_ROLLUP_INSTALL.set(Some(Box::new({
            #[cfg(unix)]
            let blocked_dir = blocked_dir.clone();
            move || {
                match fault {
                    CleanupFault::Retirement => git_write::BLOCK_RETIREMENT.set(true),
                    CleanupFault::PackData => git_write::BLOCK_PACK_DATA.set(true),
                    CleanupFault::Timeout => {
                        git_write::BEFORE_PRUNE.set(Some(Box::new(|| {
                            OperationDeadline::for_test(Duration::ZERO)
                        })));
                    }
                    #[cfg(unix)]
                    CleanupFault::Unlink => {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &blocked_dir,
                            std::fs::Permissions::from_mode(0o500),
                        )
                        .unwrap();
                        let out = std::process::Command::new("git")
                            .arg("--git-dir")
                            .arg(blocked_dir.parent().unwrap().parent().unwrap())
                            .args(["prune-packed", "-q"])
                            .output()
                            .unwrap();
                        assert!(out.status.success(), "real Git exits zero");
                        assert!(String::from_utf8_lossy(&out.stderr).contains("unable to unlink"));
                        assert!(std::fs::read_dir(&blocked_dir).unwrap().next().is_some());
                    }
                }
                None
            }
        })));
        let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
        store.consolidate_now_for_tests(&guard).unwrap();
        drop(guard);
        assert_eq!(git_write::ROLLUP_INSTALLS.get(), 1);
        let deferred = store
            .pack_consolidation(&kb)
            .unwrap()
            .expect("cleanup debt recorded");
        assert_eq!(deferred.deferrals, 1);
        assert_eq!(
            deferred.code,
            match fault {
                CleanupFault::Timeout => "DEADLINE_EXCEEDED",
                _ => "STORAGE_UNAVAILABLE",
            }
        );
        let all_objects = || {
            let repo = GitRepo::open(&repo).unwrap();
            repo.run_command(
                repo.command([
                    "cat-file",
                    "--batch-all-objects",
                    "--batch-check=%(objectname)",
                ])
                .unwrap(),
                1 << 20,
            )
            .unwrap()
            .1
        };
        let before = all_objects();
        let mut head =
            Sha::parse(store.kb(&kb).unwrap().unwrap().head_sha.as_deref().unwrap()).unwrap();
        let mut publish = |store: &Store, n| {
            // The permission fault targets cleanup, not object creation. A new
            // publication may legitimately hash into the same fan-out directory.
            #[cfg(unix)]
            if matches!(fault, CleanupFault::Unlink) {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
            head = store
                .commit_files(
                    &store.owner(),
                    crate::CommitRequest {
                        kb: kb.clone(),
                        base_revision: head.clone(),
                        idempotency_key: format!("cleanup-publish-{n:06}"),
                        changes: vec![crate::FileChange {
                            path: format!("note{n}.md"),
                            content: Some(
                                publication_content
                                    .clone()
                                    .unwrap_or_else(|| format!("note {n}\n").into_bytes()),
                            ),
                        }],
                    },
                )
                .expect("cleanup cannot fail publication")
                .commit_sha;
            #[cfg(unix)]
            if matches!(fault, CleanupFault::Unlink) {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o500))
                    .unwrap();
            }
        };
        let entries_before = cleanup_entries(&store, &kb);
        assert!(entries_before > 0, "blocked cleanup retains the intent");
        let removals = git_write::RETIREMENT_ATTEMPTS.get();
        for n in 0..3 {
            publish(&store, n);
        }
        assert_eq!(store.pack_consolidation(&kb).unwrap(), Some(deferred));
        assert_eq!(
            git_write::RETIREMENT_ATTEMPTS.get(),
            removals,
            "no cleanup retry below admission level"
        );
        assert_eq!(git_write::ROLLUP_INSTALLS.get(), 1, "no repeated fold");
        assert_eq!(
            cleanup_entries(&store, &kb),
            entries_before,
            "spaced retries do not touch the intent"
        );
        // Simulate a crash after installation but before the deferral write:
        // reopen with no retry history. The independent SQLite intent survives.
        store
            .conn
            .execute(
                "DELETE FROM pack_consolidation WHERE kb_id=?1",
                [kb.as_str()],
            )
            .unwrap();
        let root = store.paths().root().to_path_buf();
        drop(store);
        store = Store::open(&root).unwrap();
        let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
        store.consolidate_now_for_tests(&guard).unwrap();
        drop(guard);
        let after_restart = store
            .pack_consolidation(&kb)
            .unwrap()
            .expect("cleanup resumed");
        for n in 3..6 {
            publish(&store, n);
        }
        assert_eq!(store.pack_consolidation(&kb).unwrap(), Some(after_restart));
        assert_eq!(
            git_write::ROLLUP_INSTALLS.get(),
            1,
            "restart reused installed pack"
        );
        git_write::BLOCK_RETIREMENT.set(false);
        git_write::BLOCK_PACK_DATA.set(false);
        git_write::BEFORE_PRUNE.set(None);
        #[cfg(unix)]
        if matches!(fault, CleanupFault::Unlink) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&blocked_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
        store.consolidate_now_for_tests(&guard).unwrap();
        drop(guard);
        assert_eq!(store.pack_consolidation(&kb).unwrap(), None);
        assert!(!git_write::has_cleanup_intent(&store.conn, &kb).unwrap());
        assert_eq!(
            git_write::ROLLUP_INSTALLS.get(),
            1,
            "cleanup never rebuilt covering pack"
        );
        let after = all_objects();
        for sha in before.split(|b| *b == b'\n').filter(|s| !s.is_empty()) {
            assert!(
                after.split(|b| *b == b'\n').any(|s| s == sha),
                "no object lost"
            );
        }
        let repo = GitRepo::for_kb(store.paths(), &kb).unwrap();
        assert!(
            repo.run_command(
                repo.command(["fsck", "--full", "--no-dangling"]).unwrap(),
                4096
            )
            .unwrap()
            .0
        );
        assert!(
            !repo
                .git_dir()
                .join("objects")
                .join(&unreachable[..2])
                .join(&unreachable[2..])
                .exists(),
            "original loose object pruned after packing"
        );
        drop(store);
        drop(fixture);
    }

    fn fixture_git(repo: &std::path::Path, args: &[&str], input: &[u8]) -> String {
        use std::io::Write;
        let mut child = std::process::Command::new("git")
            // Fixture construction needs no durability barriers. Maintenance
            // below still runs the real synced production installer.
            .args(["-c", "core.fsync=none"])
            .arg("--git-dir")
            .arg(repo)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn tiny_pack(repo: &std::path::Path, n: usize) {
        let sha = fixture_git(
            repo,
            &["hash-object", "-w", "--stdin"],
            format!("tiny {n}\n").as_bytes(),
        );
        fixture_git(
            repo,
            &[
                "pack-objects",
                "-q",
                repo.join("objects/pack/pack").to_str().unwrap(),
            ],
            format!("{sha}\n").as_bytes(),
        );
    }

    fn cleanup_entries(store: &Store, kb: &KbId) -> i64 {
        store
            .conn
            .query_row(
                "SELECT count(*) FROM pack_cleanup_entries WHERE kb_id=?1",
                [kb.as_str()],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn tombstone_purge_retires_all_pack_maintenance_state() {
        use kb_client::{decode_input, types::BasesDelete};

        // Exercise genuine pre-install, partially retired and deferred intents,
        // plus stale rows left by a purge completed before this lifecycle fix.
        for stage in 0..4 {
            let (base, mut store, kb) = due_store("intent-purge");
            let fixture = CleanupFixture(base);
            let root = store.paths().root().to_owned();
            let repo = store.paths().repo_dir(&kb);
            let indexes = store.paths().index_dir(&kb);
            for n in 0..300 {
                fixture_git(
                    &repo,
                    &["hash-object", "-w", "--stdin"],
                    format!("purge loose {n}\n").as_bytes(),
                );
            }
            match stage {
                0 => git_write::AFTER_ROLLUP_INTENT
                    .set(Some(Box::new(|| Err(StoreError::DeadlineExceeded)))),
                1 => {}
                _ => git_write::BLOCK_RETIREMENT.set(true),
            }
            let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
            assert!(store.consolidate_now_for_tests(&guard).unwrap());
            assert!(cleanup_entries(&store, &kb) > 0);
            if stage == 1 {
                assert!(cleanup_entries(&store, &kb) < 300, "batch made progress");
                git_write::BEFORE_PRUNE.set(Some(Box::new(|| {
                    crate::git_read::OperationDeadline::for_test(Duration::ZERO)
                })));
                assert!(store.consolidate_now_for_tests(&guard).unwrap());
            }
            assert!(store.pack_consolidation(&kb).unwrap().is_some());
            git_write::BLOCK_RETIREMENT.set(false);
            git_write::BEFORE_PRUNE.set(None);
            drop(guard);
            fixture_git(&repo, &["fsck", "--full", "--no-dangling"], b"");
            let deletion = decode_input::<BasesDelete>(serde_json::json!({
                "kbId": kb, "metadataVersion": 1, "confirm": "DELETE",
                "idempotencyKey": "delete-rollup-purge-0001",
            }))
            .unwrap();
            let receipt = store
                .bases_delete(&store.owner(), deletion.clone())
                .unwrap();
            if stage == 3 {
                let _guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
                for dir in [&repo, &indexes] {
                    if dir.exists() {
                        std::fs::remove_dir_all(dir).unwrap();
                    }
                }
                store
                    .conn
                    .execute("UPDATE kbs SET data_purged=1 WHERE id=?1", [kb.as_str()])
                    .unwrap();
            }
            // Purging must retain the registry tombstone and all receipts.
            let receipts = || {
                store
                    .conn
                    .query_row(
                        "SELECT count(*) FROM operation_intents WHERE kb_id=?1",
                        [kb.as_str()],
                        |r| r.get::<_, i64>(0),
                    )
                    .unwrap()
            };
            let before = receipts();
            store.sweep_disposable(None).unwrap();
            assert_eq!(receipts(), before);
            for pass in 0..2 {
                if pass == 1 {
                    drop(store);
                    store = Store::open(&root).unwrap();
                }
                let check = &store;
                check.sweep_disposable(None).unwrap();
                assert!(!repo.exists());
                assert!(!indexes.exists());
                let purged: bool = check
                    .conn
                    .query_row(
                        "SELECT state='TOMBSTONED' AND data_purged=1 FROM kbs WHERE id=?1",
                        [kb.as_str()],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert!(purged);
                for table in ["pack_cleanup", "pack_cleanup_entries", "pack_consolidation"] {
                    let remaining: i64 = check
                        .conn
                        .query_row(
                            &format!("SELECT count(*) FROM {table} WHERE kb_id=?1"),
                            [kb.as_str()],
                            |r| r.get(0),
                        )
                        .unwrap();
                    assert_eq!(remaining, 0, "stage {stage}, pass {pass}, table {table}");
                }
                assert_eq!(
                    check
                        .bases_delete(&check.owner(), deletion.clone())
                        .unwrap()
                        .operation_id,
                    receipt.operation_id
                );
            }
            drop(store);
            drop(fixture);
        }
    }

    #[test]
    fn hundreds_of_disjoint_packs_make_bounded_progress_through_scheduled_admission() {
        let (base, store, kb) = due_store("intent-bound");
        let fixture = CleanupFixture(base);
        let repo = store.paths().repo_dir(&kb);
        for n in 0..601 {
            tiny_pack(&repo, n);
        }
        fixture_git(&repo, &["prune-packed", "-q"], b"");
        for _ in 0..10 {
            let before = packs(&store, &kb);
            if before < git_write::CONSOLIDATE_PACKS {
                break;
            }
            git_write::CLEANUP_INDEX_OPENS.set(0);
            git_write::CLEANUP_ENTRIES.set(0);
            // Inject only the clock as ready, retaining real scheduled
            // admission, selection, children and cleanup work bounds.
            git_write::AFTER_ROLLUP_INSTALL.set(Some(Box::new(|| None)));
            drop(store.lock_publication(std::slice::from_ref(&kb)).unwrap());
            assert_eq!(
                git_write::CLEANUP_INDEX_OPENS.get(),
                1,
                "only the recorded covering index is opened for cleanup"
            );
            assert!(git_write::CLEANUP_ENTRIES.get() <= git_write::CLEANUP_BATCH);
            let after = packs(&store, &kb);
            assert!(after < before, "each admitted pass makes useful progress");
            assert!(
                before - after < git_write::CONSOLIDATE_MAX_PACKS,
                "fold selection is count bounded"
            );
            assert_eq!(store.pack_consolidation(&kb).unwrap(), None);
            if after >= git_write::CONSOLIDATE_PACKS {
                tiny_pack(&repo, 10_000 + before);
            }
        }
        assert!(packs(&store, &kb) < git_write::CONSOLIDATE_PACKS);
        fixture_git(&repo, &["fsck", "--full", "--no-dangling"], b"");
        drop(store);
        drop(fixture);
    }

    #[test]
    fn cleanup_intent_survives_every_fold_crash_boundary() {
        for stage in 0..3 {
            let (base, mut store, kb) = due_store("intent-crash");
            let fixture = CleanupFixture(base);
            let repo = store.paths().repo_dir(&kb);
            fixture_git(&repo, &["prune-packed", "-q"], b"");
            let before = packs(&store, &kb);
            match stage {
                0 => git_write::BEFORE_ROLLUP_INTENT
                    .set(Some(Box::new(|| Err(StoreError::DeadlineExceeded)))),
                1 => git_write::AFTER_ROLLUP_INTENT
                    .set(Some(Box::new(|| Err(StoreError::DeadlineExceeded)))),
                _ => git_write::AFTER_RETIREMENT_UNLINK
                    .set(Some(Box::new(|| Err(StoreError::DeadlineExceeded)))),
            }
            git_write::ROLLUP_INSTALLS.set(0);
            let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
            store.consolidate_now_for_tests(&guard).unwrap();
            drop(guard);
            assert_eq!(
                git_write::has_cleanup_intent(&store.conn, &kb).unwrap(),
                stage != 0
            );
            if stage < 2 {
                assert_eq!(
                    packs(&store, &kb),
                    before,
                    "no retirement before installation"
                );
            }
            let entries_before = cleanup_entries(&store, &kb);
            git_write::AFTER_RETIREMENT_UNLINK.set(None);
            let root = store.paths().root().to_owned();
            drop(store);
            store = Store::open(&root).unwrap();
            let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
            store.consolidate_now_for_tests(&guard).unwrap();
            if stage == 1 {
                assert!(
                    !git_write::has_cleanup_intent(&store.conn, &kb).unwrap(),
                    "missing covering pack drops the intent"
                );
                assert_eq!(packs(&store, &kb), before, "discard retires nothing");
                assert!(entries_before > 0);
                store.consolidate_now_for_tests(&guard).unwrap();
            }
            assert!(!git_write::has_cleanup_intent(&store.conn, &kb).unwrap());
            assert_eq!(
                git_write::ROLLUP_INSTALLS.get(),
                1,
                "installed covering pack is reused"
            );
            assert_eq!(packs(&store, &kb), 1);
            fixture_git(&repo, &["fsck", "--full", "--no-dangling"], b"");
            drop(guard);
            drop(store);
            drop(fixture);
        }
    }

    #[test]
    fn intent_cleanup_refuses_partial_coverage_before_any_retirement() {
        let (base, store, kb) = due_store("intent-coverage");
        let fixture = CleanupFixture(base);
        let repo = store.paths().repo_dir(&kb);
        git_write::AFTER_ROLLUP_INSTALL.set(Some(Box::new(|| {
            Some(crate::git_read::OperationDeadline::for_test(Duration::ZERO))
        })));
        let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
        store.consolidate_now_for_tests(&guard).unwrap();
        let before = packs(&store, &kb);
        let entries = cleanup_entries(&store, &kb);
        let extra = fixture_git(
            &repo,
            &["hash-object", "-w", "--stdin"],
            b"outside this fold\n",
        );
        let names: Vec<u8> = (0..20)
            .map(|i| u8::from_str_radix(&extra[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        store
            .conn
            .execute(
                "UPDATE pack_cleanup SET names=?2 WHERE kb_id=?1",
                rusqlite::params![kb.as_str(), names],
            )
            .unwrap();
        store.consolidate_now_for_tests(&guard).unwrap();
        assert_eq!(
            packs(&store, &kb),
            before,
            "no retirement on incomplete coverage"
        );
        assert_eq!(cleanup_entries(&store, &kb), entries);
        assert!(git_write::has_cleanup_intent(&store.conn, &kb).unwrap());
        assert_eq!(
            store.pack_consolidation(&kb).unwrap().unwrap().code,
            "STORAGE_UNAVAILABLE"
        );
        fixture_git(&repo, &["fsck", "--full", "--no-dangling"], b"");
        drop(guard);
        drop(store);
        drop(fixture);
    }

    #[test]
    fn intent_cleanup_advances_past_an_unchanged_unpacked_prefix_below_threshold() {
        let (base, store, kb) = due_store("intent-prefix");
        let fixture = CleanupFixture(base);
        let repo = store.paths().repo_dir(&kb);
        let mut tail = Vec::new();
        for n in 0..1_000 {
            tail.push(fixture_git(
                &repo,
                &["hash-object", "-w", "--stdin"],
                format!("tail {n}\n").as_bytes(),
            ));
        }
        git_write::BEFORE_PRUNE.set(Some(Box::new(|| {
            crate::git_read::OperationDeadline::for_test(Duration::ZERO)
        })));
        let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
        store.consolidate_now_for_tests(&guard).unwrap();
        assert_eq!(packs(&store, &kb), 1);
        git_write::BEFORE_PRUNE.set(None);
        let mut prefix = Vec::new();
        for n in 0.. {
            let body = format!("prefix {n}\n");
            let header = format!("blob {}\0", body.len());
            let digest = ring::digest::digest(
                &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
                &[header.as_bytes(), body.as_bytes()].concat(),
            );
            if digest.as_ref()[0] == 0 {
                prefix.push(fixture_git(
                    &repo,
                    &["hash-object", "-w", "--stdin"],
                    body.as_bytes(),
                ));
                if prefix.len() == 27 {
                    break;
                }
            }
        }
        assert!(
            !git_write::Pressure::measure(store.paths(), &repo)
                .unwrap()
                .due()
        );
        let mut previous = cleanup_entries(&store, &kb);
        assert!(previous >= 1_000);
        for _ in 0..10 {
            git_write::CLEANUP_ENTRIES.set(0);
            git_write::CLEANUP_INDEX_OPENS.set(0);
            let pending = store.consolidate_now_for_tests(&guard).unwrap();
            assert_eq!(git_write::CLEANUP_INDEX_OPENS.get(), 1);
            assert!(git_write::CLEANUP_ENTRIES.get() <= git_write::CLEANUP_BATCH);
            let remaining = cleanup_entries(&store, &kb);
            assert!(
                remaining < previous,
                "acknowledged entries advance every pass"
            );
            previous = remaining;
            if !pending {
                break;
            }
        }
        assert_eq!(previous, 0);
        for sha in tail {
            assert!(
                !repo
                    .join("objects")
                    .join(&sha[..2])
                    .join(&sha[2..])
                    .exists()
            );
        }
        for sha in prefix {
            assert!(
                repo.join("objects")
                    .join(&sha[..2])
                    .join(&sha[2..])
                    .exists()
            );
        }
        assert_eq!(store.pack_consolidation(&kb).unwrap(), None);
        fixture_git(&repo, &["fsck", "--full", "--no-dangling"], b"");
        drop(guard);
        drop(store);
        drop(fixture);
    }

    #[test]
    fn an_installed_rollup_defers_expired_retirement_and_resumes() {
        let (base, store, kb) = due_store("post-fold");
        store.conn.execute(
            "INSERT INTO pack_consolidation(kb_id,code,level,deferrals,at_ms) VALUES(?1,'DEADLINE_EXCEEDED',0,1,0)",
            [kb.as_str()],
        ).unwrap();
        let before = packs(&store, &kb);
        git_write::AFTER_ROLLUP_INSTALL.set(Some(Box::new(|| {
            Some(crate::git_read::OperationDeadline::for_test(Duration::ZERO))
        })));
        drop(
            store
                .lock_publication(std::slice::from_ref(&kb))
                .expect("lock"),
        );
        let pending = store
            .pack_consolidation(&kb)
            .unwrap()
            .expect("pruning deferred");
        assert_eq!(pending.code, "DEADLINE_EXCEEDED");
        assert_eq!(pending.deferrals, 2);
        assert!(
            packs(&store, &kb) == before + 1,
            "expired cleanup leaves every original and the covering pack installed"
        );
        let guard = store.lock_write(std::slice::from_ref(&kb)).unwrap();
        store.consolidate_now_for_tests(&guard).unwrap();
        drop(guard);
        assert_eq!(store.pack_consolidation(&kb).unwrap(), None);
        let repo = GitRepo::for_kb(store.paths(), &kb).unwrap();
        assert!(
            repo.run_command(
                repo.command(["fsck", "--full", "--no-dangling"]).unwrap(),
                4096
            )
            .unwrap()
            .0
        );
        drop(store);
        std::fs::remove_dir_all(base).unwrap();
    }
}
