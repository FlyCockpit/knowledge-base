//! Upkeep of the store's generations outside a build: re-pinning built-in KBs
//! after a runtime change (once per launch), recovery of completed but
//! unactivated generations and of index files at open, and the retention
//! sweeps of disposable scratch, lock leftovers and superseded rows.
use crate::generations::{
    AttemptEnd, BuildDeadline, BuiltGeneration, GenerationCancellation, Phase, PinRuntime,
    ProfileSnapshot, Serve, completion_permit, decode, json, kb_permit, ms, phase, read_permit,
    serve_rank_sql, states_sql,
};
use crate::{Store, StoreError, locks, paths, state};
use kb_client::types::*;
use rusqlite::OptionalExtension;
use std::fs::OpenOptions;
use std::time::Duration;

/// Activation budget of a recovered completion (fresh attempt identity).
const RECOVERED_ACTIVATION: Duration = Duration::from_secs(60);
/// Whether a generation's scratch (`.tmp`, `.tmp-journal`) or cancellation
/// intent may be deleted, given its state, once the owning permits are held.
/// Scratch has no reader outside a live attempt; the intent is read by the
/// activation of a COMPLETE generation, so it stays until that generation is
/// active (then nothing reads it; a recovered activation recreates it).
fn generation_file_disposable(state: Option<&str>, cancel_intent: bool, active: bool) -> bool {
    let Some(state) = state else {
        return true; // no row: nothing can own it
    };
    let Ok(state) = serde_json::from_value::<IndexState>(serde_json::Value::String(state.into()))
    else {
        return false; // unknown state: keep (recovery decides)
    };
    match phase(state) {
        // Its attempt's writer owns both.
        Phase::InProgress => false,
        // A completion may still activate (or recover) through its intent.
        Phase::Terminal if state == IndexState::Complete => !cancel_intent || active,
        Phase::Queued | Phase::Terminal => true,
    }
}
/// SQL: generation `g` was embedded under a built-in runtime other than
/// the identity bound to parameter `?{param}`.
fn stale_builtin_sql(g: &str, param: u8) -> String {
    format!(
        "(json_type({g}.snapshot_json,'$.profile.builtin')='object' AND json_extract({g}.snapshot_json,'$.profile.builtin.runtimeIdentity') IS NOT ?{param})"
    )
}

/// Where [`Store::sweep_disposable`] continues: after this (KB, scratch
/// file name) and after this tombstoned KB. `None` from a sweep ends a pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepCursor {
    scratch: Option<(KbId, String)>,
    tombstone: Option<KbId>,
    /// After this lock file name.
    locks: Option<String>,
}

impl Store {
    /// Model promotion/rollback caller owns the store fence and transaction.
    /// Re-pins every built-in KB whose pin is not the live configuration
    /// under `runtime`'s rule (see [`PinRuntime`]).
    pub(crate) fn schedule_builtin_rebuilds(&self, runtime: PinRuntime) -> Result<(), StoreError> {
        let live = self.model_state()?;
        if !live.enabled || live.reloading {
            return Ok(());
        }
        let mut after = None;
        loop {
            let rows = self.live_kbs_after(after.as_deref())?;
            if rows.is_empty() {
                break;
            }
            for k in rows {
                after = Some(k.id.to_string());
                if k.state != crate::KbState::Active {
                    continue;
                }
                let raw: Option<String> = self.conn.query_row(
                    "SELECT profile_json FROM kbs WHERE id=?1",
                    [k.id.as_str()],
                    |r| r.get(0),
                )?;
                if let Some(raw) = raw {
                    let pin: ProfileSnapshot = decode(&raw)?;
                    let Some(b) = &pin.builtin else {
                        continue;
                    };
                    let target = match runtime {
                        PinRuntime::Current => live.clone(),
                        PinRuntime::Kept => crate::qwen::ModelState {
                            runtime_identity: b.runtime_identity.clone(),
                            ..live.clone()
                        },
                    };
                    if b != &target {
                        let pin = Self::builtin_pin(&pin.provider_id, target, live.epoch + 1)?;
                        // A warm probe/restart changes runtime fencing, not the
                        // embedding. Refresh future job pins without rebuilding
                        // an already current, compatible active generation.
                        // A lexical active generation is never a compatible embedding.
                        let current: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM kbs k JOIN index_generations g ON g.id=k.active_generation_id WHERE k.id=?1 AND k.active_generation_id=k.desired_generation_id AND g.state='COMPLETE' AND g.commit_sha=k.head_sha AND json_type(g.snapshot_json,'$.profile')='object')",[k.id.as_str()],|r|r.get(0))?;
                        let previous: ProfileSnapshot = decode(&raw)?;
                        if current && previous.fingerprint == pin.fingerprint {
                            self.conn.execute(
                                "UPDATE kbs SET profile_json=?2 WHERE id=?1",
                                (k.id.as_str(), json(&pin)?),
                            )?;
                        } else {
                            self.conn.execute("UPDATE kbs SET profile_json=?2,desired_epoch=desired_epoch+1 WHERE id=?1",(k.id.as_str(),json(&pin)?))?;
                            self.enqueue_generation(&k.id, &state::new_uuid_v4()?)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    /// Upgrade reconcile (store guard held): a KB pinned to the built-in
    /// under another native runtime (a CLI upgrade changed
    /// [`crate::qwen::runtime_identity`]) is re-pinned to the current one and
    /// its generation re-embedded, exactly as for a model change. Until the
    /// new generation activates, its old one serves keyword search only
    /// (`EMBEDDING_MODEL_CHANGED`): old document vectors never meet query
    /// vectors from another runtime. A disabled or reloading built-in is
    /// left alone; its next enable or probe completion schedules the same
    /// rebuilds. Once per launch ([`Store::open`]; when the open could not
    /// take the store lock, the first lock of any handle sharing that
    /// launch's [`crate::RuntimeReconcile`]): a `kb` of another version still
    /// serving this store never re-pins on its own reopens or locks, so two
    /// versions cannot keep replacing each other's rebuilds.
    pub(crate) fn reconcile_builtin_runtime(
        &self,
        guard: &locks::WriteGuard,
    ) -> Result<(), StoreError> {
        let owed = self.runtime_reconcile.borrow().clone();
        if !owed.pending() {
            return Ok(());
        }
        self.check_guard(guard)?;
        let live = self.model_state()?;
        if !live.enabled || live.reloading {
            owed.settle(guard);
            return Ok(());
        }
        let stale: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM kbs WHERE state='ACTIVE' AND json_type(profile_json,'$.builtin')='object' AND json_extract(profile_json,'$.builtin.runtimeIdentity') IS NOT ?1)",
            [&live.runtime_identity],
            |r| r.get(0),
        )?;
        if !stale {
            owed.settle(guard);
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        self.schedule_builtin_rebuilds(PinRuntime::Current)?;
        tx.commit()?;
        owed.settle(guard);
        Ok(())
    }
    /// Live KBs on the built-in whose re-embedding after a runtime change
    /// is still due: their pin, or a generation of theirs, names another
    /// runtime, and no semantic generation of this runtime serves them yet
    /// (they search by keyword meanwhile). The work an upgrade reconcile
    /// ([`Store::reconcile_builtin_runtime`]) schedules, whether or not it
    /// has run yet. None while the built-in is disabled (nothing re-embeds
    /// until it is enabled again).
    pub fn builtin_runtime_stale_kbs(&self) -> Result<Vec<KbId>, StoreError> {
        if !self.model_state()?.enabled {
            return Ok(Vec::new());
        }
        // pagination:audited — bounded by the live-KB quota (`limits.rs`).
        let mut q = self.conn.prepare(&format!(
            "SELECT k.id FROM kbs k WHERE k.state='ACTIVE' AND json_type(k.profile_json,'$.builtin')='object' \
             AND (json_extract(k.profile_json,'$.builtin.runtimeIdentity') IS NOT ?1 \
                  OR EXISTS(SELECT 1 FROM index_generations g WHERE g.kb_id=k.id AND {})) \
             AND NOT EXISTS(SELECT 1 FROM index_generations a WHERE a.id=k.active_generation_id \
                  AND json_type(a.snapshot_json,'$.profile')='object' AND NOT {}) ORDER BY k.id",
            stale_builtin_sql("g", 1),
            stale_builtin_sql("a", 1)
        ))?;
        let ids = q
            .query_map([self.runtime_identity()], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| KbId::parse(id).map_err(|_| StoreError::IndexUnavailable))
            .collect()
    }
    /// Whether this handle still owes a launch reconcile (the open could not
    /// take the store lock, and no handle sharing it has run it since).
    pub fn runtime_reconcile_pending(&self) -> bool {
        self.runtime_reconcile.borrow().pending()
    }
    /// This handle's launch reconcile, for the handles the same process
    /// reopens to share ([`Store::share_runtime_reconcile`]).
    pub fn runtime_reconcile(&self) -> crate::store::RuntimeReconcile {
        self.runtime_reconcile.borrow().clone()
    }
    /// Run `launch`'s reconcile at this handle's store locks while it is
    /// owed: a reopened handle of the launching process. One owing for every
    /// sharing handle, settled by whichever runs it first.
    pub fn share_runtime_reconcile(&self, launch: &crate::store::RuntimeReconcile) {
        *self.runtime_reconcile.borrow_mut() = launch.clone();
    }
    /// Whether `kb`'s re-embedding after a runtime change is over: it is no
    /// longer live, or a semantic generation not embedded under another
    /// built-in runtime serves it (a lexical companion does not count).
    pub fn builtin_runtime_reembedded(&self, kb: &KbId) -> Result<bool, StoreError> {
        Ok(self.conn.query_row(
            &format!(
                "SELECT NOT EXISTS(SELECT 1 FROM kbs k WHERE k.id=?1 AND k.state='ACTIVE') OR EXISTS(SELECT 1 FROM kbs k JOIN index_generations g ON g.id=k.active_generation_id WHERE k.id=?1 AND json_type(g.snapshot_json,'$.profile')='object' AND NOT {})",
                stale_builtin_sql("g", 2)
            ),
            (kb.as_str(), self.runtime_identity()),
            |r| r.get(0),
        )?)
    }
    pub(crate) fn recover_completed_indexes(
        &self,
        guard: &locks::WriteGuard,
    ) -> Result<(), StoreError> {
        self.check_guard(guard)?;
        let mut after = None;
        loop {
            let rows = self.live_kbs_after(after.as_deref())?;
            if rows.is_empty() {
                break;
            }
            for kb in rows {
                after = Some(kb.id.to_string());
                // Every completed, unactivated generation in the serve order
                // (rank, then epoch, highest first); a deferred or refused
                // activation tries the next.
                let rows: Vec<(String, String)> = {
                    let mut q=self.conn.prepare(&format!("SELECT g.id,g.attempt FROM kbs k JOIN index_generations g ON g.kb_id=k.id WHERE k.id=?1 AND k.state='ACTIVE' AND g.state='COMPLETE' AND g.reclaimed=0 AND (k.active_generation_id IS NULL OR k.active_generation_id<>g.id) ORDER BY {} DESC,g.epoch DESC LIMIT 8", serve_rank_sql("g")))?;
                    q.query_map([kb.id.as_str()], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<Result<_, _>>()?
                };
                for (id, token) in rows {
                    let id = KbId::parse(&id).map_err(|_| StoreError::IndexUnavailable)?;
                    let snapshot = self.generation_snapshot(&id)?;
                    if !matches!(self.serve(&snapshot)?, Serve::Activate) {
                        continue;
                    }
                    // A needed completion whose file is gone never blocks the
                    // store: it fails (INDEX_FILE_LOST) and the KB is
                    // rescheduled (companion first), like a lost active file.
                    let file = self.paths.index_file(&kb.id, &id);
                    if self.paths.check_no_follow(&file).is_err() || !file.is_file() {
                        let tx = self.conn.unchecked_transaction()?;
                        tx.execute("UPDATE index_generations SET state='FAILED',error_code='INDEX_FILE_LOST',finished_ms=?2 WHERE id=?1 AND state='COMPLETE'",(id.as_str(),ms(self.now_ms())))?;
                        tx.execute("UPDATE kbs SET index_rebuild_required=1,desired_epoch=desired_epoch+1 WHERE id=?1",[kb.id.as_str()])?;
                        self.enqueue_generation(&kb.id, &state::new_uuid_v4()?)?;
                        tx.commit()?;
                        break;
                    }
                    let Some(completion) =
                        locks::try_named_model_lock(&self.paths, &completion_permit(&id))?
                    else {
                        continue;
                    };
                    match self.read_kb_locked(guard, &kb.id) {
                        Ok(_) => {}
                        Err(StoreError::RecoveryRequired(_) | StoreError::NotFound) => break,
                        Err(e) => return Err(e),
                    }
                    // The drained completion permit transfers ownership; stale
                    // capabilities can neither activate nor terminalize it.
                    // A fresh attempt identity and deadline: the old attempt's
                    // expiry or host cancellation never decides still-desired
                    // work (its cancellation intent is reset under the store
                    // fence and the drained completion permit).
                    let successor = state::new_uuid_v4()?.to_string();
                    if self.conn.execute("UPDATE index_generations SET attempt=?3,attempt_until_ms=?4 WHERE id=?1 AND attempt=?2 AND state='COMPLETE'", (id.as_str(), token, &successor, ms(self.now_ms().saturating_add(RECOVERED_ACTIVATION.as_millis() as u64))))? != 1 { continue; }
                    let snapshot = self.generation_snapshot(&id)?;
                    let cancel = GenerationCancellation::for_generation(&self.paths, &snapshot);
                    cancel.reset()?;
                    let b = BuiltGeneration {
                        snapshot,
                        token: successor,
                        root: self.paths.root().into(),
                        until: BuildDeadline::fixed(RECOVERED_ACTIVATION),
                        cancel,
                        _completion: completion,
                    };
                    if self.activate_built_locked(guard, b, &mut |_| Ok(()))? {
                        break;
                    }
                }
            }
        }
        Ok(())
    }
    /// Called only under the store fence, never while retaining a live reader.
    /// Invariant 2 of the build checkpoint (vector_cache.rs), the one place it
    /// is enforced: under the KB build permit, `vectors.sqlite` is reclaimed
    /// unless the KB's desired generation is resumable semantic work (queued,
    /// or in progress and abandoned since the permit is free) of the
    /// checkpoint's own profile. Covers supersession, revocation, lexical
    /// activation, retention and KB removal alike.
    pub(crate) fn reconcile_checkpoint(&self, kb: &KbId) -> Result<(), StoreError> {
        if !crate::vector_cache::VectorCache::exists(&self.paths, kb) {
            return Ok(());
        }
        let Some(_permit) = locks::try_named_model_lock(&self.paths, &kb_permit(kb))? else {
            // A live build owns it; it prunes its own checkpoint.
            return Ok(());
        };
        let desired: Option<String> = self.conn.query_row(&format!("SELECT g.id FROM kbs k JOIN index_generations g ON g.id=k.desired_generation_id WHERE k.id=?1 AND k.state='ACTIVE' AND g.state IN ({})", states_sql(&[Phase::Queued, Phase::InProgress])),[kb.as_str()],|r|r.get(0)).optional()?;
        let keep = match desired {
            Some(id) => {
                let id = KbId::parse(&id).map_err(|_| StoreError::IndexUnavailable)?;
                match self.generation_snapshot(&id)?.profile {
                    Some(pin) => {
                        crate::vector_cache::VectorCache::profile_of(&self.paths, kb)?
                            == Some((pin.fingerprint.clone(), pin.dimensions as i64))
                    }
                    None => false,
                }
            }
            None => false,
        };
        if !keep {
            crate::vector_cache::VectorCache::remove(&self.paths, kb)?;
        }
        Ok(())
    }
    pub(crate) fn reconcile_indexes(&self) -> Result<(), StoreError> {
        let mut after = String::new();
        loop {
            let mut q=self.conn.prepare("SELECT id FROM index_generations WHERE id>?1 AND (state IN ('BUILDING','INDEXING') OR reserved_bytes>0) ORDER BY id LIMIT 100")?;
            let ids = q
                .query_map([&after], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            if ids.is_empty() {
                break;
            }
            for id in ids {
                after = id.clone();
                let s = self.generation_snapshot(
                    &KbId::parse(&id).map_err(|_| StoreError::IndexUnavailable)?,
                )?;
                if let Some(_drained) =
                    locks::try_named_model_lock(&self.paths, &kb_permit(&s.kb_id))?
                {
                    // The owning process exited mid-build: a host
                    // interruption, retried from the checkpoint, never a stall.
                    self.interrupt_generation(&s, None, AttemptEnd::Interrupted)?;
                }
            }
        }
        let mut after = None;
        loop {
            let rows = self.live_kbs_after(after.as_deref())?;
            if rows.is_empty() {
                break;
            }
            for k in rows {
                after = Some(k.id.to_string());
                self.reconcile_checkpoint(&k.id)?;
                if k.state != crate::KbState::Active {
                    continue;
                }
                let active_missing = if let Some(id) = &k.active_generation_id {
                    let path = self.paths.index_file(&k.id, id);
                    self.paths.check_no_follow(&path).is_err() || !path.is_file()
                } else {
                    false
                };
                // An active file that is no longer an index (a damaged
                // header) is lost like a missing one, and its generation
                // fails so that completion recovery never re-activates it.
                let active_corrupt = !active_missing
                    && k.active_generation_id
                        .as_ref()
                        .is_some_and(|id| self.generation_file_unreadable(&k.id, id, false));
                if active_missing || active_corrupt {
                    if let Some(id) = &k.active_generation_id {
                        self.lose_generation_file(&k.id, id)?;
                    }
                    continue;
                }
                let candidate: Option<String> = self.conn.query_row("SELECT g.id FROM kbs k JOIN index_generations g ON k.desired_generation_id=g.id WHERE k.id=?1 AND g.state='COMPLETE'",[k.id.as_str()],|r|r.get(0)).optional()?;
                let candidate_missing = candidate.as_ref().is_some_and(|id| {
                    KbId::parse(id).is_ok_and(|id| {
                        let path = self.paths.index_file(&k.id, &id);
                        self.paths.check_no_follow(&path).is_err() || !path.is_file()
                    })
                });
                if candidate_missing {
                    let tx = self.conn.unchecked_transaction()?;
                    tx.execute("UPDATE index_generations SET state='FAILED',error_code='INDEX_FILE_LOST',finished_ms=?2 WHERE id=?1",(candidate,ms(self.now_ms())))?;
                    tx.execute("UPDATE index_jobs SET state='FAILED' WHERE generation_id=(SELECT desired_generation_id FROM kbs WHERE id=?1)",[k.id.as_str()])?;
                    tx.execute("UPDATE kbs SET index_rebuild_required=1,desired_epoch=desired_epoch+1 WHERE id=?1",[k.id.as_str()])?;
                    self.enqueue_generation(&k.id, &state::new_uuid_v4()?)?;
                    tx.commit()?;
                }
            }
        }
        Ok(())
    }
    /// Dead scratch and tombstoned KB data, removed without
    /// waiting for generation retention. Bounded per call (200 scratch
    /// names, five tombstones), resuming after `cursor`; a host runs it with
    /// each retention pass and carries the returned cursor (`None`: the pass
    /// is complete). Returns the number of removed entries.
    ///
    /// * `<gen>.tmp` and `<gen>.tmp-journal` of a generation that is not
    ///   building, under the KB's build permit (no live writer): a resumed
    ///   attempt discards its old scratch anyway.
    /// * `<gen>.sqlite.cancel` of a generation that can no longer activate
    ///   (not building and not COMPLETE), under the KB's build permit, its
    ///   completion permit and the intent's own lock. A COMPLETE generation's
    ///   activation and completion recovery read it; reclamation removes it.
    /// * A tombstoned KB's repository and index directory, once it has no
    ///   unfinished publication intent (its receipts stay in `state.sqlite`):
    ///   one keyset page of at most five per call, after the cursor's KB.
    pub fn sweep_disposable(
        &self,
        cursor: Option<&SweepCursor>,
    ) -> Result<(usize, Option<SweepCursor>), StoreError> {
        let after = cursor.and_then(|c| c.tombstone.as_ref());
        const MAX_FILES: usize = 200;
        const MAX_KBS: usize = 5;
        let mut removed = 0;
        let indexes = self.paths.root().join("indexes");
        self.paths.check_no_follow(&indexes)?;
        // One bounded page of scratch names in (KB, file name) order after
        // the cursor. Every listed name is examined and then passed, whether
        // it was removed, retained (its owner still needs it) or busy, so
        // retained entries can never pin later scratch out of the page (#3).
        let after_scratch = cursor.and_then(|c| c.scratch.clone());
        let mut kbs: Vec<KbId> = match std::fs::read_dir(&indexes) {
            Ok(dirs) => dirs
                .filter_map(|d| {
                    d.ok()?
                        .file_name()
                        .to_str()
                        .and_then(|n| KbId::parse(n).ok())
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        kbs.sort();
        let mut candidates = Vec::new();
        let mut scratch_next = None;
        'dirs: for kb in kbs {
            if after_scratch.as_ref().is_some_and(|(k, _)| kb < *k) {
                continue;
            }
            let path = self.paths.index_dir(&kb);
            if self.paths.check_no_follow(&path).is_err() || !path.is_dir() {
                continue;
            }
            let mut names = Vec::new();
            for entry in std::fs::read_dir(&path).map_err(StoreError::Io)? {
                let name = entry.map_err(StoreError::Io)?.file_name();
                let Some(name) = name.to_str() else { continue };
                for suffix in [".tmp", ".tmp-journal", ".sqlite.cancel"] {
                    if let Some(id) = name.strip_suffix(suffix).and_then(|n| KbId::parse(n).ok()) {
                        names.push((name.to_owned(), id, suffix));
                    }
                }
            }
            names.sort();
            for (name, id, suffix) in names {
                if after_scratch
                    .as_ref()
                    .is_some_and(|(k, n)| kb == *k && name <= *n)
                {
                    continue;
                }
                if candidates.len() == MAX_FILES {
                    scratch_next = candidates
                        .last()
                        .map(|(k, _, _, n): &(KbId, KbId, &str, String)| (k.clone(), n.clone()));
                    break 'dirs;
                }
                candidates.push((kb.clone(), id, suffix, name));
            }
        }
        for (kb, id, suffix, _) in candidates {
            // Ownership, not status, decides (ROOT A): build scratch belongs
            // to the KB's writer permit; the cancellation intent belongs to
            // the completion permit for as long as the generation can still
            // activate (COMPLETE: a held `BuiltGeneration`, a deferred
            // activation, completion recovery or the active generation, whose
            // files only reclamation removes). Both permits are taken without
            // waiting, then the state is re-read under them.
            let cancel = suffix == ".sqlite.cancel";
            if !generation_file_disposable(
                self.generation_row_state(&id, &kb)?.as_deref(),
                cancel,
                self.generation_active(&id, &kb)?,
            ) {
                continue;
            }
            let Some(_drained) = locks::try_named_model_lock(&self.paths, &kb_permit(&kb))? else {
                continue;
            };
            let _completion = if cancel {
                let Some(p) = locks::try_named_model_lock(&self.paths, &completion_permit(&id))?
                else {
                    continue;
                };
                Some(p)
            } else {
                None
            };
            // Re-read under the permits: a claim needs the KB permit to start
            // building and the completion permit to own a completion.
            if !generation_file_disposable(
                self.generation_row_state(&id, &kb)?.as_deref(),
                cancel,
                self.generation_active(&id, &kb)?,
            ) {
                continue;
            }
            let file = self.paths.index_dir(&kb).join(format!("{id}{suffix}"));
            self.paths.check_no_follow(&file)?;
            if cfg!(windows) && suffix == ".sqlite.cancel" {
                continue; // held lock files are not unlinked on Windows
            }
            let _intent = if suffix == ".sqlite.cancel" {
                let Ok(f) = paths::open_no_follow(&file, OpenOptions::new().read(true).write(true))
                else {
                    continue;
                };
                if f.try_lock().is_err() {
                    continue;
                }
                Some(f)
            } else {
                None
            };
            match std::fs::remove_file(&file) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
        }
        // One bounded keyset page of tombstones still holding data, after
        // `after`; revisit a purged KB only if stale maintenance state remains.
        // Drive those joins from maintenance, never from retained KB history.
        let tombstoned = {
            let mut q = self.conn.prepare(
                "SELECT id FROM kbs WHERE state='TOMBSTONED' AND data_purged=0 AND (?1 IS NULL OR id>?1)
                 UNION SELECT p.kb_id FROM pack_cleanup p CROSS JOIN kbs k ON k.id=p.kb_id WHERE k.state='TOMBSTONED' AND (?1 IS NULL OR p.kb_id>?1)
                 UNION SELECT p.kb_id FROM pack_consolidation p CROSS JOIN kbs k ON k.id=p.kb_id WHERE k.state='TOMBSTONED' AND (?1 IS NULL OR p.kb_id>?1)
                 ORDER BY 1 LIMIT ?2",
            )?;
            q.query_map(
                (after.map(KbId::as_str), i64::try_from(MAX_KBS).unwrap_or(5)),
                |r| r.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?
        };
        let tombstone_next = (tombstoned.len() == MAX_KBS)
            .then(|| tombstoned.last().and_then(|id| KbId::parse(id).ok()))
            .flatten();
        for raw in tombstoned {
            let Ok(kb) = KbId::parse(&raw) else { continue };
            let Some(_drained) = locks::try_named_model_lock(&self.paths, &kb_permit(&kb))? else {
                continue;
            };
            let _guard = self.lock_write(std::slice::from_ref(&kb))?;
            let still: bool = self.conn.query_row(
                "SELECT state='TOMBSTONED' AND NOT EXISTS(SELECT 1 FROM operation_intents i WHERE i.kb_id=?1 AND i.phase IN ('PREPARED','COMMITTING')) FROM kbs WHERE id=?1",
                [kb.as_str()],
                |r| r.get(0),
            )?;
            if !still {
                continue;
            }
            for dir in [self.paths.repo_dir(&kb), self.paths.index_dir(&kb)] {
                self.paths.check_no_follow(&dir)?;
                match std::fs::symlink_metadata(&dir) {
                    Ok(meta) if meta.is_dir() && !paths::is_link(&meta) => {
                        std::fs::remove_dir_all(&dir).map_err(StoreError::Io)?;
                        removed += 1;
                    }
                    _ => {}
                }
            }
            paths::sync_dir(&self.paths.root().join("repos"))?;
            paths::sync_dir(&indexes)?;
            // The registry tombstone and operation receipts survive purging,
            // so their foreign-key cascades cannot retire repository maintenance.
            let tx = self.conn.unchecked_transaction()?;
            tx.execute("DELETE FROM pack_cleanup WHERE kb_id=?1", [kb.as_str()])?;
            tx.execute(
                "DELETE FROM pack_consolidation WHERE kb_id=?1",
                [kb.as_str()],
            )?;
            tx.execute(
                "UPDATE kbs SET data_purged=1 WHERE id=?1 AND state='TOMBSTONED'",
                [kb.as_str()],
            )?;
            tx.commit()?;
        }
        let (swept, locks_next) =
            self.sweep_lock_leftovers(cursor.and_then(|c| c.locks.as_deref()))?;
        removed += swept;
        let next = (scratch_next.is_some() || tombstone_next.is_some() || locks_next.is_some())
            .then_some(SweepCursor {
                scratch: scratch_next,
                tombstone: tombstone_next,
                locks: locks_next,
            });
        Ok((removed, next))
    }
    fn generation_active(&self, id: &KbId, kb: &KbId) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT active_generation_id=?1 FROM kbs WHERE id=?2",
                (id.as_str(), kb.as_str()),
                |r| r.get::<_, Option<bool>>(0),
            )
            .optional()?
            .flatten()
            .unwrap_or(false))
    }
    /// One bounded page (in name order, after `after`) of permit
    /// files nothing can need again: a generation's completion permit once
    /// it is SUPERSEDED, FAILED or CANCELLED, its read permit once FAILED or
    /// CANCELLED (a superseded one still serves leases), either once it is
    /// reclaimed or has no row,
    /// and a KB's lock and build permit once its data is purged (or it has
    /// no row). Each is removed only while this pass holds it, under the
    /// store fence every other opener of these names also holds (Unix: a
    /// held lock file is not unlinked on Windows).
    fn sweep_lock_leftovers(
        &self,
        after: Option<&str>,
    ) -> Result<(usize, Option<String>), StoreError> {
        const PAGE: usize = 200;
        if cfg!(windows) {
            return Ok((0, None));
        }
        let dir = self.paths.locks_dir();
        self.paths.check_no_follow(&dir)?;
        let mut names = match std::fs::read_dir(&dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok()?.file_name().to_str().map(str::to_owned))
                .filter(|n| after.is_none_or(|a| n.as_str() > a))
                .collect::<Vec<_>>(),
            Err(_) => return Ok((0, None)),
        };
        names.sort();
        let next = (names.len() > PAGE).then(|| names[PAGE - 1].clone());
        names.truncate(PAGE);
        // The store fence alone: this pass only reads the registry.
        let _fence = locks::acquire(&self.paths, &[], true)?
            .ok_or_else(|| StoreError::Internal("blocking lock returned early".into()))?;
        let mut removed = 0;
        for name in names {
            let generation = |prefix: &str| {
                name.strip_prefix(prefix)
                    .and_then(|n| n.strip_suffix(".lock"))
                    .and_then(|n| KbId::parse(n).ok())
            };
            let completion = generation("index-completion-");
            let disposable =
                if let Some(id) = completion.clone().or_else(|| generation("index-read-")) {
                    let row: Option<(String, bool)> = self
                        .conn
                        .query_row(
                            "SELECT state,reclaimed<>0 FROM index_generations WHERE id=?1",
                            [id.as_str()],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    // A superseded generation can no longer complete, but leases
                    // still read it until reclamation (which removes its permits).
                    row.is_none_or(|(state, reclaimed)| {
                        reclaimed
                            || matches!(state.as_str(), "FAILED" | "CANCELLED")
                            || (completion.is_some() && state == "SUPERSEDED")
                    })
                } else if let Some(kb) = generation("index-build-").or_else(|| generation("kb_")) {
                    let purged: Option<bool> = self
                        .conn
                        .query_row(
                            "SELECT data_purged<>0 FROM kbs WHERE id=?1",
                            [kb.as_str()],
                            |r| r.get(0),
                        )
                        .optional()?;
                    purged.is_none_or(|purged| purged)
                } else {
                    false
                };
            if !disposable {
                continue;
            }
            let Some(_held) = locks::try_named_model_lock(&self.paths, &name)? else {
                continue;
            };
            match std::fs::remove_file(dir.join(&name)) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
        }
        Ok((removed, next))
    }
    fn generation_row_state(&self, id: &KbId, kb: &KbId) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1 AND kb_id=?2",
                (id.as_str(), kb.as_str()),
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn sweep_generations(&self, now: u64) -> Result<usize, StoreError> {
        let mut after = None;
        let mut count = 0;
        loop {
            let (reclaimed, next) = self.sweep_generation_page(now, after.as_ref())?;
            count += reclaimed;
            after = next;
            if after.is_none() {
                return Ok(count);
            }
        }
    }
    /// At most 100 candidates under one short store fence. A host advances the
    /// cursor even past leased/busy files, then periodically starts a new pass.
    pub fn sweep_generation_page(
        &self,
        now: u64,
        after: Option<&KbId>,
    ) -> Result<(usize, Option<KbId>), StoreError> {
        let _guard = self.lock_write(&[])?;
        let mut after = after.map_or("", KbId::as_str).to_owned();
        let mut count = 0;
        // A completed tombstone purge already removed every generation file.
        // Reclaim its registry/permit leftovers on this pass, without waiting
        // for file retention. Ordinary generations keep their retention window.
        // A COMPLETE generation that is still its live KB's desired one is
        // owned by completion recovery, however old: never reclaimed (ROOT A).
        let mut q=self.conn.prepare("SELECT g.id FROM index_generations g JOIN kbs k ON k.id=g.kb_id WHERE g.id>?1 AND g.reclaimed=0 AND g.state IN ('COMPLETE','SUPERSEDED','FAILED') AND (k.data_purged=1 OR g.finished_ms<=?2-CASE WHEN g.state='FAILED' THEN 86400000 ELSE 604800000 END) AND NOT EXISTS(SELECT 1 FROM kbs active WHERE active.active_generation_id=g.id) AND NOT (g.state='COMPLETE' AND EXISTS(SELECT 1 FROM kbs d WHERE d.desired_generation_id=g.id AND d.state='ACTIVE')) AND NOT EXISTS(SELECT 1 FROM generation_leases l WHERE l.generation_id=g.id AND l.expires_ms>?2) ORDER BY g.id LIMIT 100")?;
        let ids = q
            .query_map((&after, ms(now)), |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let full = ids.len() == 100;
        for raw in ids {
            after = raw.clone();
            let id = KbId::parse(&raw).map_err(|_| StoreError::IndexUnavailable)?;
            let s = self.generation_snapshot(&id)?;
            // Never reclaim a completion the serve order may still need (one
            // awaiting its recovered activation).
            let complete: bool = self.conn.query_row(
                "SELECT state='COMPLETE' FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )?;
            if complete && !matches!(self.serve(&s)?, Serve::Stale) {
                continue;
            }
            let Some(_drained) = locks::try_named_model_lock(&self.paths, &kb_permit(&s.kb_id))?
            else {
                continue;
            };
            let Some(_completion) =
                locks::try_named_model_lock(&self.paths, &completion_permit(&id))?
            else {
                continue;
            };
            let path = self.paths.locks_dir().join(read_permit(&id));
            let lock = paths::open_no_follow(
                &path,
                OpenOptions::new().read(true).write(true).create(true),
            )?;
            match lock.try_lock() {
                Ok(()) => {}
                Err(std::fs::TryLockError::WouldBlock) => continue,
                Err(std::fs::TryLockError::Error(e)) => return Err(StoreError::Io(e)),
            }
            // Reclamation only deletes. A missing directory may have been
            // purged by sweep_disposable (or lost before a crash); never
            // recreate it just to remove files from it.
            let dir = self.paths.index_dir(&s.kb_id);
            self.paths.check_no_follow(&dir)?;
            // Published file and any journal beside it, crash-leftover build
            // temp and its journal, and the cancellation intent. A reclaimed
            // generation is never visited again, so nothing may be left.
            for suffix in [
                ".sqlite",
                ".sqlite-journal",
                ".tmp",
                ".tmp-journal",
                ".sqlite.cancel",
            ] {
                let file = self.paths.index_dir(&s.kb_id).join(format!("{id}{suffix}"));
                self.paths.check_no_follow(&file)?;
                match std::fs::remove_file(&file) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(StoreError::Io(e)),
                }
            }
            match std::fs::symlink_metadata(&dir) {
                Ok(_) => paths::sync_dir(&dir)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    paths::sync_dir(&self.paths.root().join("indexes"))?;
                }
                Err(e) => return Err(StoreError::Io(e)),
            }
            self.conn.execute(
                "UPDATE index_generations SET reclaimed=1 WHERE id=?1",
                [id.as_str()],
            )?;
            // A reclaimed generation is never visited again; its
            // permit files (held here) go with it instead of piling up.
            // Windows keeps them: a held lock file cannot be unlinked there
            // without a delete-pending window for other openers.
            #[cfg(unix)]
            for name in [read_permit(&id), completion_permit(&id)] {
                let file = self.paths.locks_dir().join(name);
                match std::fs::remove_file(&file) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(StoreError::Io(e)),
                }
            }
            count += 1;
        }
        self.conn.execute(
            "DELETE FROM generation_leases WHERE id IN (SELECT id FROM generation_leases WHERE expires_ms<=?1 ORDER BY expires_ms,id LIMIT 100)",
            [ms(now)],
        )?;
        let next = if full {
            Some(KbId::parse(&after).map_err(|_| StoreError::IndexUnavailable)?)
        } else {
            None
        };
        Ok((count, next))
    }
}
