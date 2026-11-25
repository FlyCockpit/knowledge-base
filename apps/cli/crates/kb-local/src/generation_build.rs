//! Building and serving one generation: claim (a semantic build only after
//! its lexical companion), activation of a built file under the store fence
//! and its cancellation-file lock, read leases of the active file, and the
//! ends of an attempt (interrupted, failed, lost or repaired file).
use crate::generations::{
    AttemptEnd, BUILTIN_BUILD_SLOTS, BuildDeadline, BuiltGeneration, EXTERNAL_BUILD_SLOTS,
    GenerationCancellation, GenerationReadError, GenerationSnapshot, MAX_STALLED_ATTEMPTS, Phase,
    SERVE_DESIRED, Serve, completion_permit, kb_permit, ms, read_permit, serve_rank_sql,
    states_sql,
};
use crate::{LocalPrincipal, Store, StoreError, locks, paths, state};
use kb_client::types::*;
use rusqlite::{Connection, OptionalExtension};
use std::fs::{File, OpenOptions};
use std::time::Duration;

pub struct BuildAttempt {
    pub(crate) snapshot: GenerationSnapshot,
    pub(crate) token: String,
    pub(crate) root: std::path::PathBuf,
    pub(crate) until: BuildDeadline,
    /// Set once this attempt embedded at least one batch (or needs no
    /// embedding): an interruption then never counts as a stall.
    pub(crate) progressed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(crate) cancel: GenerationCancellation,
    pub(crate) _completion: locks::CredentialFence,
    _kb: locks::CredentialFence,
    _slot: locks::CredentialFence,
}
impl BuildAttempt {
    pub fn cancellation(&self) -> GenerationCancellation {
        self.cancel.clone()
    }
    pub fn cancel(&self) -> Result<(), StoreError> {
        self.cancel.cancel()
    }
    pub fn snapshot(&self) -> &GenerationSnapshot {
        &self.snapshot
    }
}
pub struct GenerationReadLease {
    pub snapshot: GenerationSnapshot,
    conn: Connection,
    meta: crate::index_format::FileMeta,
    _lock: File,
    id: String,
    paths: crate::StorePaths,
}
impl Drop for GenerationReadLease {
    fn drop(&mut self) {
        // OS shared lock remains held through metadata release; a failed cleanup
        // is bounded by the 90-second TTL, and retention still tries the OS lock.
        if let Ok(db) = state::open_existing(&self.paths.state_db()) {
            let _ = db.busy_timeout(Duration::ZERO);
            let _ = db.execute("DELETE FROM generation_leases WHERE id=?1", [&self.id]);
        }
    }
}
impl GenerationReadLease {
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
    pub(crate) fn connection_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
    /// The verified `meta` row of the leased file.
    pub fn meta(&self) -> &crate::index_format::FileMeta {
        &self.meta
    }
}

impl Store {
    pub fn claim_generation(
        &self,
        id: &KbId,
        timeout: Duration,
    ) -> Result<BuildAttempt, StoreError> {
        let snapshot = self.generation_snapshot(id)?;
        // A semantic build depends on its lexical companion explicitly —
        // it is not claimed (so it never holds the KB permit through
        // embedding) until the dependency is SATISFIED: the companion is
        // COMPLETE or reached a terminal outcome. Attempt liveness is a
        // different question: an expired companion attempt means "recover
        // now", never "done".
        let unfinished = self.unfinished_companion(&snapshot)?;
        if matches!(unfinished, Some((_, ref state)) if state == IndexState::Pending.as_str()) {
            return Err(StoreError::RateLimited(1));
        }
        let kb = locks::try_named_model_lock(&self.paths, &kb_permit(&snapshot.kb_id))?
            .ok_or(StoreError::RateLimited(1))?;
        // Under the KB build permit no companion builder can be live, and
        // `reconcile_indexes` cannot take the permit now: an abandoned
        // companion attempt is requeued here, under it, and this semantic
        // claim defers until the companion really completes.
        if let Some((companion, _)) = self.unfinished_companion(&snapshot)? {
            let _guard = self.lock_write(std::slice::from_ref(&snapshot.kb_id))?;
            let companion = self.generation_snapshot(&companion)?;
            self.interrupt_generation(&companion, None, AttemptEnd::Interrupted)?;
            return Err(StoreError::RateLimited(1));
        }
        // Built-in builds of different KBs do not queue behind one
        // store-wide permit. The one shared worker runs one inference at
        // a time and serves concurrent builds batch by batch, so a small
        // incremental build finishes between a large build's batches instead
        // of waiting for all of it. Built-in and external builds each have
        // their own bounded slots.
        let slots = if snapshot.builtin().is_some() {
            ("index-builtin", BUILTIN_BUILD_SLOTS)
        } else {
            ("index-slot", EXTERNAL_BUILD_SLOTS)
        };
        let slot = (0..slots.1)
            .find_map(|i| {
                match locks::try_named_model_lock(&self.paths, &format!("{}-{i}.lock", slots.0)) {
                    Ok(Some(p)) => Some(Ok(p)),
                    Ok(None) => None,
                    Err(e) => Some(Err(e)),
                }
            })
            .transpose()?
            .ok_or(StoreError::RateLimited(1))?;
        let _guard = self.lock_write(std::slice::from_ref(&snapshot.kb_id))?;
        // Repair/recovery gates precede every claim-state shortcut or settlement.
        self.read_kb_locked(&_guard, &snapshot.kb_id)?;
        let completion = locks::try_named_model_lock(&self.paths, &completion_permit(id))?
            .ok_or(StoreError::RateLimited(1))?;
        let timeout = timeout.min(Duration::from_secs(900));
        let token = state::new_uuid_v4()?.to_string();
        let pending: bool = self.conn.query_row(
            "SELECT state='PENDING' FROM index_generations WHERE id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        if !pending {
            return Err(StoreError::IndexUnavailable);
        }
        // Only this still-PENDING identity may be settled. Never fail a running
        // attempt or a successor. Store/KB and completion fences precede SQLite.
        if !self.desired_matches(&snapshot)? {
            self.settle_pending_generation(id, "SUPERSEDED", "CANCELLED")?;
            return Err(StoreError::IndexUnavailable);
        }
        if !self.generation_live(&snapshot, true)? {
            // A runtime config probe is transient: its completion owns the
            // model/desired transition. Revoked or stale pins cannot build.
            if snapshot.builtin().is_some() && self.model_state()?.reloading {
                return Err(StoreError::RateLimited(1));
            }
            if self.profile_probing(snapshot.hybrid_profile()?)? {
                return Err(StoreError::RateLimited(1));
            }
            self.settle_pending_generation(id, "FAILED", "FAILED")?;
            return Err(StoreError::IndexUnavailable);
        }
        // Pinned to another native runtime (a `kb` of another version shares
        // this store): only a process of that runtime may embed for it; this
        // one leaves it pending, never fails it.
        if snapshot
            .builtin()
            .is_some_and(|b| b.runtime_identity != self.runtime_identity())
        {
            return Err(StoreError::RateLimited(1));
        }
        // This new claimant exclusively owns the KB writer permit. Previous
        // terminal attempts cannot still write, including an error path that
        // was unable to obtain the store fence for its final ledger release.
        self.conn.execute("UPDATE index_generations SET reserved_bytes=0 WHERE kb_id=?1 AND id<>?2 AND reserved_bytes>0 AND state IN ('COMPLETE','SUPERSEDED','FAILED')", (snapshot.kb_id.as_str(), id.as_str()))?;
        self.check_disk_admission(0)?;
        self.paths.ensure_index_dir(&snapshot.kb_id)?;
        let cancel = GenerationCancellation::for_generation(&self.paths, &snapshot);
        let _intent = cancel.create()?;
        paths::sync_dir(&self.paths.index_dir(&snapshot.kb_id))?;
        let tx = self.conn.unchecked_transaction()?;
        if tx.execute("UPDATE index_generations SET state='BUILDING',attempt=?2,attempt_until_ms=?3 WHERE id=?1 AND state='PENDING'",(id.as_str(),&token,ms(self.now_ms().saturating_add(timeout.as_millis() as u64))))?!=1{return Err(StoreError::IndexUnavailable)}
        tx.execute(
            "UPDATE index_jobs SET state='RUNNING' WHERE generation_id=?1",
            [id.as_str()],
        )?;
        tx.commit()?;
        Ok(BuildAttempt {
            snapshot,
            token,
            root: self.paths.root().into(),
            until: BuildDeadline::new(timeout),
            progressed: Default::default(),
            cancel,
            _completion: completion,
            _kb: kb,
            _slot: slot,
        })
    }
    fn settle_pending_generation(
        &self,
        id: &KbId,
        state: &str,
        job_state: &str,
    ) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        if tx.execute("UPDATE index_generations SET state=?2,error_code='INDEX_UNAVAILABLE',finished_ms=?3 WHERE id=?1 AND state='PENDING'", (id.as_str(), state, ms(self.now_ms())))? == 1 {
            tx.execute("UPDATE index_jobs SET state=?2 WHERE generation_id=?1 AND state='PENDING'", (id.as_str(), job_state))?;
            if state == "FAILED" {
                tx.execute("INSERT INTO index_events VALUES(?1,?2,'generation_fail')", (crate::state::new_uuid_v4()?.as_str(), id.as_str()))?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    /// Whether `s` is still current work for its KB (it may build, complete
    /// and be held): `serve(s)` is not [`Serve::Stale`].
    pub(crate) fn desired_matches(&self, s: &GenerationSnapshot) -> Result<bool, StoreError> {
        Ok(!matches!(self.serve(s)?, Serve::Stale))
    }
    /// Dependency (a completion question, not liveness): the lexical
    /// companion this semantic generation waits for (same KB, the epoch just
    /// below it) and its state while it is not yet COMPLETE or terminal.
    fn unfinished_companion(
        &self,
        s: &GenerationSnapshot,
    ) -> Result<Option<(KbId, String)>, StoreError> {
        if s.is_lexical() {
            return Ok(None);
        }
        let row: Option<(String, String)> = self.conn.query_row(&format!("SELECT id,state FROM index_generations WHERE kb_id=?1 AND epoch=?2 AND state IN ({}) AND json_type(snapshot_json,'$.profile') IS NOT 'object'", states_sql(&[Phase::Queued, Phase::InProgress])),(s.kb_id.as_str(),s.epoch-1),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        row.map(|(id, state)| {
            Ok((
                KbId::parse(&id).map_err(|_| StoreError::IndexUnavailable)?,
                state,
            ))
        })
        .transpose()
    }
    pub(crate) fn attempt_live(
        &self,
        s: &GenerationSnapshot,
        token: &str,
    ) -> Result<bool, StoreError> {
        Ok(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM index_generations WHERE id=?1 AND attempt=?2 AND attempt_until_ms>?3 AND state IN ('BUILDING','INDEXING','COMPLETE'))",(s.id.as_str(),token,ms(self.now_ms())),|r|r.get(0))?)
    }
    pub fn activate_built(&self, b: BuiltGeneration) -> Result<bool, StoreError> {
        self.activate_built_observed(b, &mut |_| Ok(()))
    }
    #[doc(hidden)]
    pub fn activate_built_observed(
        &self,
        b: BuiltGeneration,
        observer: &mut dyn FnMut(crate::index::BuildStage) -> Result<(), StoreError>,
    ) -> Result<bool, StoreError> {
        if self.paths.root() != b.root {
            return Err(StoreError::LockNotHeld);
        }
        let _guard = self.lock_write(std::slice::from_ref(&b.snapshot.kb_id))?;
        observer(crate::index::BuildStage::BeforeActivate)?;
        self.activate_built_locked(&_guard, b, observer)
    }
    pub(crate) fn activate_built_locked(
        &self,
        guard: &locks::WriteGuard,
        b: BuiltGeneration,
        observer: &mut dyn FnMut(crate::index::BuildStage) -> Result<(), StoreError>,
    ) -> Result<bool, StoreError> {
        let s = &b.snapshot;
        match self.read_kb_locked(guard, &s.kb_id) {
            Ok(_) => {}
            Err(StoreError::NotFound) => return Ok(false),
            Err(e) => return Err(e),
        }
        let tx = self.conn.unchecked_transaction()?;
        let complete: bool = tx.query_row(
            "SELECT state='COMPLETE' FROM index_generations WHERE id=?1",
            [s.id.as_str()],
            |r| r.get(0),
        )?;
        // Generation vs attempt outcomes: only newer desired work replaces a
        // completed generation (SUPERSEDED). Anything about this attempt — its
        // deadline, a host cancellation, a transferred identity — or a
        // transiently unusable profile leaves it COMPLETE for recovery to
        // activate under a fresh attempt (`recover_completed_indexes`).
        if !complete {
            return Ok(false);
        }
        match self.serve(s)? {
            Serve::Activate => {}
            Serve::Stale => {
                tx.execute("UPDATE index_generations SET state='SUPERSEDED',finished_ms=?3 WHERE id=?1 AND attempt=?2 AND state='COMPLETE' AND NOT EXISTS(SELECT 1 FROM kbs WHERE active_generation_id=?1)",(s.id.as_str(),&b.token,ms(self.now_ms())))?;
                tx.commit()?;
                return Ok(false);
            }
        }
        let usable = self.generation_live(s, true)?;
        if !usable
            && !matches!(
                self.serve_order(&s.id, &s.kb_id, &s.owner_id)?,
                Some((SERVE_DESIRED, _))
            )
        {
            // An unusable profile is retried only for the head's desired work;
            // anything else it would have served is replaced.
            tx.execute("UPDATE index_generations SET state='SUPERSEDED',finished_ms=?3 WHERE id=?1 AND attempt=?2 AND state='COMPLETE' AND NOT EXISTS(SELECT 1 FROM kbs WHERE active_generation_id=?1)",(s.id.as_str(),&b.token,ms(self.now_ms())))?;
            tx.commit()?;
            return Ok(false);
        }
        if b.until.expired()
            || b.cancel.is_cancelled()
            || !usable
            || !self.attempt_live(s, &b.token)?
        {
            return Ok(false);
        }
        // `meta` is written last in the file's only transaction: a verified
        // meta row is the file's completion marker.
        drop(self.open_generation_file(s)?);
        observer(crate::index::BuildStage::BeforeActivationCas)?;
        // File IO can cross an attempt deadline or receive cancellation. State
        // authority/profile stay fenced by this store lock and transaction.
        let mut cancellation = b.cancel.lock()?;
        if b.until.expired()
            || b.cancel.is_cancelled()
            || cancellation.cancelled()?
            || !self.attempt_live(s, &b.token)?
        {
            return Ok(false);
        }
        // `desired_matches` (the serve invariant) held above, under this
        // store fence. The retired generation's retention counts from now.
        tx.execute("UPDATE index_generations SET finished_ms=?2 WHERE id=(SELECT active_generation_id FROM kbs WHERE id=?1) AND id<>?3",(s.kb_id.as_str(),ms(self.now_ms()),s.id.as_str()))?;
        let desired: bool = tx
            .query_row(
                "SELECT desired_generation_id IS ?2 FROM kbs WHERE id=?1",
                (s.kb_id.as_str(), s.id.as_str()),
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false);
        let changed=tx.execute("UPDATE kbs SET active_generation_id=?2,index_rebuild_required=CASE WHEN desired_generation_id=?2 THEN 0 ELSE index_rebuild_required END WHERE id=?1 AND state='ACTIVE'",(s.kb_id.as_str(),s.id.as_str()))?;
        // A completed generation below the new active serve rank can never
        // activate again. Settle it now so idle retention can remove its
        // cancellation intent without waiting for another KB publication.
        tx.execute(
            &format!("UPDATE index_generations AS g SET state='SUPERSEDED',finished_ms=?2 WHERE g.kb_id=?1 AND g.state='COMPLETE' AND g.id<>?3 AND EXISTS (SELECT 1 FROM kbs k JOIN index_generations a ON a.id=k.active_generation_id WHERE k.id=g.kb_id AND ({},a.epoch)>=({},g.epoch))", serve_rank_sql("a"), serve_rank_sql("g")),
            (s.kb_id.as_str(), ms(self.now_ms()), s.id.as_str()),
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO index_events VALUES(?1,?2,'generation_activate')",
            (&b.token, s.id.as_str()),
        )?;
        tx.commit()?;
        // The desired generation's active file now holds every
        // checkpointed vector. A non-desired generation that serves meanwhile
        // leaves the cache to the desired build still to come.
        if changed == 1 && desired && !s.is_lexical() {
            crate::vector_cache::VectorCache::remove(&self.paths, &s.kb_id)?;
        }
        Ok(changed == 1)
    }
    pub fn lease_active_generation(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
    ) -> Result<GenerationReadLease, StoreError> {
        let guard = self.lock_write(std::slice::from_ref(kb))?;
        self.lease_generation_locked(p, kb, None, &guard)
            .map_err(GenerationReadError::into_store_error)
    }
    pub(crate) fn lease_generation_locked(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        requested: Option<&KbId>,
        guard: &crate::WriteGuard,
    ) -> Result<GenerationReadLease, GenerationReadError> {
        self.check_guard(guard)?;
        self.authorize(p, kb, Permission::Read)?;
        let record = self.read_kb_locked(guard, kb)?;
        let id = requested
            .cloned()
            .or(record.active_generation_id)
            .ok_or(StoreError::IndexUnavailable)?;
        let s = self.generation_snapshot(&id)?;
        let readable: bool = self.conn.query_row("SELECT kb_id=?2 AND reclaimed=0 AND state IN ('COMPLETE','SUPERSEDED') FROM index_generations WHERE id=?1",(id.as_str(),kb.as_str()),|r|r.get(0))?;
        // A hybrid generation whose profile cannot embed now is still leased:
        // search serves its FTS5 arm and decides the mode itself.
        if !readable {
            return Err(StoreError::IndexUnavailable.into());
        }
        let path = self.paths.locks_dir().join(read_permit(&id));
        let lock = paths::open_no_follow(
            &path,
            OpenOptions::new().read(true).write(true).create(true),
        )?;
        lock.lock_shared().map_err(StoreError::Io)?;
        let (conn, meta) = match self.open_generation_file(&s) {
            Ok(opened) => opened,
            Err(e) => {
                // An unreadable active file heals: it is lost and
                // rebuilt (companion first) instead of failing every search.
                if requested.is_none() && self.generation_file_unreadable(kb, &id, true) {
                    drop(lock);
                    self.lose_generation_file(kb, &id)?;
                    return Err(GenerationReadError::Repaired(id));
                }
                return Err(e.into());
            }
        };
        let lease_id = state::new_uuid_v4()?.to_string();
        self.conn.execute(
            "INSERT INTO generation_leases VALUES(?1,?2,?3)",
            (
                lease_id.as_str(),
                id.as_str(),
                ms(self.now_ms().saturating_add(90_000)),
            ),
        )?;
        Ok(GenerationReadLease {
            snapshot: s,
            conn,
            meta,
            _lock: lock,
            id: lease_id,
            paths: self.paths.clone(),
        })
    }
    /// Whether a published generation file is proven
    /// unable to serve: damaged (header, pages, integrity) or not the index
    /// its generation describes (meta, format, schema). `deep` verifies the
    /// whole contract with `quick_check`; otherwise only the header. A
    /// failure that proves nothing (I/O, locking, a missing file, the state
    /// database) never retires a file.
    pub(crate) fn generation_file_unreadable(&self, kb: &KbId, id: &KbId, deep: bool) -> bool {
        let path = self.paths.index_file(kb, id);
        if self.paths.check_no_follow(&path).is_err() {
            return false;
        }
        if !deep {
            let Ok(mut file) = paths::open_no_follow(&path, OpenOptions::new().read(true)) else {
                return false;
            };
            return matches!(crate::index_format::header_valid(&mut file), Ok(false));
        }
        let Ok(s) = self.generation_snapshot(id) else {
            return false;
        };
        if s.kb_id != *kb || !path.is_file() {
            return false;
        }
        matches!(
            self.verify_generation_file(&s, true),
            Err(crate::index::FileFault::Corrupt | crate::index::FileFault::Contract)
        )
    }
    /// Durable repair evidence follows the exact generation even after
    /// recovery restores a companion or activation supersedes a reader.
    pub(crate) fn generation_read_repaired(
        &self,
        s: &GenerationSnapshot,
    ) -> Result<(), GenerationReadError> {
        let repaired: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM index_generations WHERE id=?1 AND kb_id=?2 AND state='FAILED' AND error_code='INDEX_FILE_LOST')",
            (s.id.as_str(), s.kb_id.as_str()),
            |r| r.get(0),
        )?;
        if repaired {
            return Err(GenerationReadError::Repaired(s.id.clone()));
        }
        Ok(())
    }
    /// Retire the file actually diagnosed, never a healthy successor. If it
    /// still serves, restore its lexical companion and schedule a rebuild;
    /// otherwise only fail this superseded generation. Caller owns the store
    /// fence. Existing reader leases continue to protect the retired file.
    pub(crate) fn lose_generation_file(&self, kb: &KbId, id: &KbId) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE index_generations SET state='FAILED',error_code='INDEX_FILE_LOST',finished_ms=?3 WHERE id=?1 AND kb_id=?2 AND state IN ('COMPLETE','SUPERSEDED')",(id.as_str(),kb.as_str(),ms(self.now_ms())))?;
        if tx.execute("UPDATE kbs SET active_generation_id=NULL,index_rebuild_required=1,desired_epoch=desired_epoch+1 WHERE id=?1 AND active_generation_id=?2",(kb.as_str(),id.as_str()))? == 0 {
            tx.commit()?;
            return Ok(());
        }
        // A retained lexical file of this head already satisfies the companion
        // dependency. Verify it before restoring its pointer; never rebuild an
        // identical companion merely because the semantic file was lost.
        let mut after = String::new();
        loop {
            let candidate: Option<String> = self.conn.query_row(
                "SELECT g.id FROM index_generations g JOIN kbs k ON k.id=g.kb_id WHERE k.id=?1 AND g.commit_sha=k.head_sha AND g.state IN ('COMPLETE','SUPERSEDED') AND g.reclaimed=0 AND json_type(g.snapshot_json,'$.profile') IS NOT 'object' AND g.id>?2 ORDER BY g.id LIMIT 1",
                (kb.as_str(), &after), |r| r.get(0),
            ).optional()?;
            let Some(id) = candidate else { break };
            after = id.clone();
            let id = KbId::parse(&id).map_err(|_| StoreError::IndexUnavailable)?;
            let snapshot = self.generation_snapshot(&id)?;
            if self.verify_generation_file(&snapshot, true).is_ok() {
                tx.execute(
                    "UPDATE index_generations SET state='COMPLETE' WHERE id=?1",
                    [id.as_str()],
                )?;
                tx.execute(
                    "UPDATE kbs SET active_generation_id=?2 WHERE id=?1",
                    (kb.as_str(), id.as_str()),
                )?;
                break;
            }
        }
        self.enqueue_generation(kb, &state::new_uuid_v4()?)?;
        tx.commit()?;
        Ok(())
    }
    /// An attempt ended by shutdown, its no-progress watchdog
    /// or its process exiting goes back to PENDING (the next claim resumes
    /// from the KB's vector checkpoint). An attempt that embedded nothing
    /// counts as a stall; [`MAX_STALLED_ATTEMPTS`] in a row fail it. Caller
    /// owns the store fence and the KB build permit (no live writer).
    pub(crate) fn interrupt_generation(
        &self,
        s: &GenerationSnapshot,
        token: Option<&str>,
        progress: AttemptEnd,
    ) -> Result<(), StoreError> {
        let stalls = match (&s.profile, progress) {
            // The host going away is not the build's fault: never a stall.
            (_, AttemptEnd::Interrupted) | (None, _) => 0,
            (Some(pin), AttemptEnd::WatchdogExpired { progressed }) => {
                crate::vector_cache::VectorCache::record_attempt(
                    &self.paths,
                    &s.kb_id,
                    &s.id,
                    pin,
                    progressed,
                )?
            }
        };
        if stalls >= MAX_STALLED_ATTEMPTS {
            return self.fail_generation(&s.id, token, "INDEX_BUILD_STALLED");
        }
        // A superseded (or otherwise settled) generation is never resurrected.
        let tx = self.conn.unchecked_transaction()?;
        // Every in-progress state (derived from the state machine) requeues.
        if tx.execute(&format!("UPDATE index_generations SET state='PENDING',attempt=NULL,attempt_until_ms=0,reserved_bytes=0 WHERE id=?1 AND (?2 IS NULL OR attempt=?2) AND state IN ({})", states_sql(&[Phase::InProgress])),(s.id.as_str(),token))?==1 {
            tx.execute("UPDATE index_jobs SET state='PENDING' WHERE generation_id=?1 AND state='RUNNING'",[s.id.as_str()])?;
        } else {
            tx.execute("UPDATE index_generations SET reserved_bytes=0 WHERE id=?1 AND (?2 IS NULL OR attempt=?2)", (s.id.as_str(), token))?;
        }
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn fail_generation(
        &self,
        id: &KbId,
        token: Option<&str>,
        code: &str,
    ) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        if tx.execute("UPDATE index_generations SET state='FAILED',reserved_bytes=0,error_code=?3,finished_ms=?4 WHERE id=?1 AND (?2 IS NULL OR attempt=?2) AND state IN ('BUILDING','INDEXING')",(id.as_str(),token,code,ms(self.now_ms())))?==1 {
            tx.execute("UPDATE index_jobs SET state='FAILED' WHERE generation_id=?1",[id.as_str()])?;
            tx.execute("INSERT INTO index_events VALUES(?1,?2,'generation_fail')",(state::new_uuid_v4()?.as_str(),id.as_str()))?;
        }
        // A successor can already have labelled a still-owned writer
        // SUPERSEDED. Its file IO is now closed; release its promise even when
        // the failure transition above intentionally cannot change that state.
        tx.execute("UPDATE index_generations SET reserved_bytes=0 WHERE id=?1 AND (?2 IS NULL OR attempt=?2)", (id.as_str(), token))?;
        tx.commit()?;
        Ok(())
    }
}
