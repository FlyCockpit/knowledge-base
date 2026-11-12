//! Durable desired snapshots and activation. Build KB permit -> optional built-in permit -> global slot
//! -> short store fence -> SQLite. Completion ownership survives in the built
//! capability; recovery/sweep only try that permit under the store fence.
//! Activation takes store -> cancellation-file lock through the state commit;
//! cancellation takes only that file lock, never SQLite or the store fence.
//! No network/native work under the store fence; no reverse blocking wait.
//!
//! Generation vs attempt (table in `docs/embeddings.md`): PENDING ->
//! BUILDING (claim; a semantic one only after its lexical companion) ->
//! COMPLETE -> active. An attempt ending — host cancellation, process exit,
//! deadline, cancelled or expired activation — never makes still-desired work
//! terminal: BUILDING returns to PENDING, COMPLETE stays COMPLETE for
//! recovery. Only newer desired work (SUPERSEDED), a build error or three
//! no-progress watchdog stalls in a row (FAILED) end a generation.
use crate::{LocalPrincipal, Store, StoreError, locks, paths, state};
use kb_client::types::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    time::{Duration, Instant},
};

/// A failed index read distinguishes a repair performed for that exact
/// generation from ordinary unavailability. Search may re-admit once only
/// after the former; public lease callers still receive the protocol error.
#[derive(Debug)]
pub(crate) enum GenerationReadError {
    Repaired(KbId),
    /// Only failures from reading generation bytes may be diagnosed/repaired.
    /// Admission, live checks and embedding errors must never enter this arm.
    ReadFailed(StoreError),
    Failed(StoreError),
}
impl From<StoreError> for GenerationReadError {
    fn from(error: StoreError) -> Self {
        Self::Failed(error)
    }
}
impl From<rusqlite::Error> for GenerationReadError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Failed(error.into())
    }
}
impl From<GenerationReadError> for StoreError {
    fn from(error: GenerationReadError) -> Self {
        match error {
            GenerationReadError::Repaired(_) => Self::IndexUnavailable,
            GenerationReadError::ReadFailed(error) | GenerationReadError::Failed(error) => error,
        }
    }
}

/// Internal registry identity of the built-in model in pinned snapshots. It
/// never crosses the wire: the protocol and the CLI call it `builtin`.
pub const BUILTIN_PROVIDER_ID: &str = "builtinembeddingmodel000";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileSnapshot {
    pub provider_id: KbId,
    pub revision: i64,
    pub dimensions: usize,
    pub fingerprint: String,
    pub model: String,
    pub name: String,
    pub builtin: Option<crate::qwen::ModelState>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationSnapshot {
    pub id: KbId,
    pub kb_id: KbId,
    pub epoch: i64,
    pub commit_sha: Sha,
    /// `None` = a lexical-only (FTS5) generation: no pinned profile, no
    /// vectors. Semantic generation rows always carry a profile.
    pub profile: Option<ProfileSnapshot>,
    pub owner_id: String,
    /// Frozen vector storage of this generation (file `meta.quantization`;
    /// a lexical file stores none, the KB's setting still bounds chunks).
    pub quantization: crate::index_format::IndexQuantization,
}
impl GenerationSnapshot {
    /// Lexical-only: built and searched without any embedding.
    pub fn is_lexical(&self) -> bool {
        self.profile.is_none()
    }
    /// The pinned built-in model state of a hybrid built-in generation.
    pub fn builtin(&self) -> Option<&crate::qwen::ModelState> {
        self.profile.as_ref().and_then(|p| p.builtin.as_ref())
    }
    pub(crate) fn hybrid_profile(&self) -> Result<&ProfileSnapshot, StoreError> {
        self.profile.as_ref().ok_or(StoreError::IndexUnavailable)
    }
}
/// Cancellation acknowledgement follows a durable one-byte intent, independent
/// of SQLite/store-lock waits. Activation takes this same file lock through CAS
/// commit; cancellation after activation cannot invalidate an active generation.
#[derive(Clone)]
pub struct GenerationCancellation {
    pub(crate) token: kb_client::CancellationToken,
    paths: crate::StorePaths,
    path: std::path::PathBuf,
}
impl GenerationCancellation {
    fn for_generation(paths: &crate::StorePaths, s: &GenerationSnapshot) -> Self {
        Self {
            token: kb_client::CancellationToken::new(),
            paths: paths.clone(),
            path: paths
                .index_dir(&s.kb_id)
                .join(format!("{}.sqlite.cancel", s.id)),
        }
    }
    fn lock(&self) -> Result<CancelGuard, StoreError> {
        self.paths.check_no_follow(&self.path)?;
        let file = paths::open_no_follow(&self.path, OpenOptions::new().read(true).write(true))?;
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(CancelGuard(file)),
                Err(std::fs::TryLockError::WouldBlock) if Instant::now() < until => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(std::fs::TryLockError::WouldBlock) => return Err(StoreError::DeadlineExceeded),
                Err(std::fs::TryLockError::Error(e)) => return Err(StoreError::Io(e)),
            }
        }
    }
    pub fn cancel(&self) -> Result<(), StoreError> {
        // Interrupt in-memory IO even when persistence fails; an error is NOT
        // an accepted durable cancellation and must be reported by the host.
        self.token.cancel();
        let mut guard = self.lock()?;
        guard.0.write_all(b"1").map_err(StoreError::Io)?;
        guard.0.sync_all().map_err(StoreError::Io)
    }
    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
    /// A recovered completion starts without the previous attempt's durable
    /// cancellation intent.
    fn reset(&self) -> Result<(), StoreError> {
        self.paths.check_no_follow(&self.path)?;
        // The caller holds the completion permit and the store fence; an
        // intent lost to a crash or an older sweep is recreated as "not
        // cancelled", which is what a reset records anyway.
        drop(paths::open_no_follow(
            &self.path,
            OpenOptions::new().read(true).write(true).create(true),
        )?);
        let mut guard = self.lock()?;
        guard.0.seek(SeekFrom::Start(0)).map_err(StoreError::Io)?;
        guard.0.write_all(b"0").map_err(StoreError::Io)?;
        guard.0.sync_all().map_err(StoreError::Io)
    }
    pub async fn cancelled(&self) {
        self.token.cancelled().await;
    }
}
struct CancelGuard(File);
impl CancelGuard {
    fn cancelled(&mut self) -> Result<bool, StoreError> {
        self.0.seek(SeekFrom::Start(0)).map_err(StoreError::Io)?;
        let mut byte = [0];
        self.0.read_exact(&mut byte).map_err(StoreError::Io)?;
        match byte[0] {
            b'0' => Ok(false),
            b'1' => Ok(true),
            _ => Err(StoreError::RecoveryRequired(
                "index cancellation intent".into(),
            )),
        }
    }
}
impl Drop for CancelGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
/// Longest a single build attempt may run, however steadily it progresses; a
/// longer build resumes from its checkpoint in a later attempt.
pub const MAX_BUILD_ATTEMPT: Duration = Duration::from_secs(6 * 60 * 60);
/// Watchdog expiries in a row that embedded nothing before a generation is
/// marked FAILED instead of being retried (L-1).
pub const MAX_STALLED_ATTEMPTS: i64 = 3;
/// How a build attempt ended without completing. An attempt's end is
/// never a verdict on still-desired work: only an observed no-progress stall
/// counts toward [`MAX_STALLED_ATTEMPTS`].
#[derive(Clone, Copy, Debug)]
pub(crate) enum AttemptEnd {
    /// The host stopped it: `kb mcp` shutting down (cancellation) or its
    /// process exiting or crashing (an orphaned attempt). Retried, never a stall.
    Interrupted,
    /// Its own no-progress watchdog expired: a stall unless it embedded
    /// something (or the checkpoint grew) first.
    WatchdogExpired { progressed: bool },
}
/// (L-2): a build's "still making progress" deadline. Every completed unit
/// of work (a document in pass 1, an embedding batch in pass 2) extends it by
/// the no-progress window, never past [`MAX_BUILD_ATTEMPT`] from the claim.
#[derive(Clone, Debug)]
pub struct BuildDeadline {
    base: Instant,
    window: Duration,
    cap: Instant,
    until_ms: std::sync::Arc<std::sync::atomic::AtomicU64>,
}
impl BuildDeadline {
    pub(crate) fn new(window: Duration) -> Self {
        let base = Instant::now();
        Self {
            base,
            window,
            cap: base + MAX_BUILD_ATTEMPT,
            until_ms: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
                u64::try_from(window.min(MAX_BUILD_ATTEMPT).as_millis()).unwrap_or(u64::MAX),
            )),
        }
    }
    /// A fixed deadline (recovered completions never extend).
    pub(crate) fn fixed(remaining: Duration) -> Self {
        let mut deadline = Self::new(remaining);
        deadline.window = Duration::ZERO;
        deadline
    }
    pub fn instant(&self) -> Instant {
        (self.base
            + Duration::from_millis(self.until_ms.load(std::sync::atomic::Ordering::Acquire)))
        .min(self.cap)
    }
    pub fn remaining(&self) -> Duration {
        self.instant().saturating_duration_since(Instant::now())
    }
    pub fn expired(&self) -> bool {
        self.expired_at(Instant::now())
    }
    /// [`Self::expired`] at an explicit instant (the clock is the caller's).
    pub(crate) fn expired_at(&self, now: Instant) -> bool {
        now >= self.instant()
    }
    /// Progress was made: the deadline moves to now + window (bounded by the
    /// cap, never backwards). Returns the new deadline.
    pub(crate) fn extend(&self) -> Instant {
        self.extend_at(Instant::now())
    }
    /// [`Self::extend`] at an explicit instant.
    pub(crate) fn extend_at(&self, now: Instant) -> Instant {
        let at = (now + self.window).min(self.cap);
        let ms =
            u64::try_from(at.saturating_duration_since(self.base).as_millis()).unwrap_or(u64::MAX);
        self.until_ms
            .fetch_max(ms, std::sync::atomic::Ordering::AcqRel);
        self.instant()
    }
}
/// THE serving rank (`Store::serve`; the server's `serveRankSql`), as SQL
/// over a generation `g` and its KB `k`:
/// - 4: the head's desired work (the desired epoch, and lexical or the KB's
///   current profile provider and revision);
/// - 3: another semantic generation of the head;
/// - 2: another lexical generation of the head;
/// - 1: any generation of an older commit.
///
/// A finished generation serves iff its `(rank, epoch)` is above the active
/// one's (nothing active is below everything): head work keeps priority, and
/// among older commits the newest serves.
const SERVE_LEXICAL_AT_HEAD: i64 = 2;
const SERVE_DESIRED: i64 = 4;
fn serve_rank_sql(g: &str) -> String {
    format!(
        "CASE WHEN {g}.commit_sha<>k.head_sha THEN 1 \
         WHEN {g}.epoch=k.desired_epoch AND (json_type({g}.snapshot_json,'$.profile') IS NOT 'object' \
           OR (json_extract({g}.snapshot_json,'$.profile.provider_id')=json_extract(k.profile_json,'$.provider_id') \
           AND json_extract({g}.snapshot_json,'$.profile.revision')=json_extract(k.profile_json,'$.revision'))) THEN 4 \
         WHEN json_type({g}.snapshot_json,'$.profile')='object' THEN 3 ELSE 2 END"
    )
}
/// Phase of a generation state in the state machine (docs/embeddings.md).
/// The match is exhaustive: a new `IndexState` must be classified here
/// before anything compiles, so no state can slip through a hand list.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    /// Queued, not claimed.
    Queued,
    /// Claimed by an attempt and not finished (owns the KB build permit).
    InProgress,
    /// Finished: COMPLETE, or an accepted terminal outcome.
    Terminal,
}
pub(crate) fn phase(state: IndexState) -> Phase {
    match state {
        IndexState::Pending => Phase::Queued,
        IndexState::Building | IndexState::Indexing => Phase::InProgress,
        IndexState::Complete | IndexState::Failed | IndexState::Superseded => Phase::Terminal,
    }
}
/// Every `IndexState`, checked against [`phase`] by the state-machine tests.
pub(crate) const ALL_STATES: [IndexState; 6] = [
    IndexState::Pending,
    IndexState::Building,
    IndexState::Indexing,
    IndexState::Complete,
    IndexState::Failed,
    IndexState::Superseded,
];
/// SQL list (`'A','B'`) of the states in `wanted` phases.
pub(crate) fn states_sql(wanted: &[Phase]) -> String {
    ALL_STATES
        .iter()
        .filter(|s| wanted.contains(&phase(**s)))
        .map(|s| format!("'{}'", s.as_str()))
        .collect::<Vec<_>>()
        .join(",")
}
/// The serve decision for one generation (`Store::serve`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Serve {
    /// Current work that serves better than what is active: activate it.
    Activate,
    /// No longer current (newer desired work, a moved head, or something
    /// better of the head is active): never activate.
    Stale,
}
/// Activation budget of a recovered completion (fresh attempt identity).
const RECOVERED_ACTIVATION: Duration = Duration::from_secs(60);
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
/// Only a fully durable, accounted file produces this capability. Fields private.
pub struct BuiltGeneration {
    pub(crate) snapshot: GenerationSnapshot,
    pub(crate) token: String,
    pub(crate) root: std::path::PathBuf,
    pub(crate) until: BuildDeadline,
    pub(crate) cancel: GenerationCancellation,
    pub(crate) _completion: locks::CredentialFence,
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
fn json<T: Serialize>(v: &T) -> Result<String, StoreError> {
    serde_json::to_string(v).map_err(|_| StoreError::IndexUnavailable)
}
fn decode<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, StoreError> {
    serde_json::from_str(s).map_err(|_| StoreError::RecoveryRequired("index snapshot".into()))
}
fn ms(now: u64) -> i64 {
    i64::try_from(now).unwrap_or(i64::MAX)
}
/// What a profile set asks for, resolved under the fence after replay.
enum ProfileTarget {
    Provider(KbId, i64),
    Builtin(Option<i64>),
}
/// Where [`Store::sweep_disposable`] continues: after this (KB, scratch
/// file name) and after this tombstoned KB. `None` from a sweep ends a pass.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepCursor {
    scratch: Option<(KbId, String)>,
    tombstone: Option<KbId>,
    /// R3-L10: after this lock file name.
    locks: Option<String>,
}
/// Whether a generation's scratch (`.tmp`, `.tmp-journal`) or cancellation
/// intent may be deleted, given its state, once the owning permits are held.
/// Scratch has no reader outside a live attempt; the intent is read by the
/// activation of a COMPLETE generation, so it stays until that generation is
/// active (R3-L10: then nothing reads it; a recovered activation recreates it).
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
/// Concurrent built-in builds per store (R3-L5); they share one worker.
pub const BUILTIN_BUILD_SLOTS: usize = 2;
/// Concurrent external-provider builds per store.
pub const EXTERNAL_BUILD_SLOTS: usize = 2;
fn kb_permit(kb: &KbId) -> String {
    format!("index-build-{kb}.lock")
}
fn completion_permit(id: &KbId) -> String {
    format!("index-completion-{id}.lock")
}
fn read_permit(id: &KbId) -> String {
    format!("index-read-{id}.lock")
}
impl Store {
    fn profile_pin(&self, id: &KbId, revision: i64) -> Result<ProfileSnapshot, StoreError> {
        if id.as_str() == BUILTIN_PROVIDER_ID {
            let b = self.model_state()?;
            if !b.enabled || b.reloading || revision != b.epoch + 1 {
                return Err(StoreError::IndexUnavailable);
            }
            let d = crate::qwen::descriptor(&b.model_id)?;
            let fingerprint = kb_client::snapshot::content_hash(
                json(&(
                    &d,
                    b.context_tokens,
                    &crate::fingerprint::EMBEDDING_VERSIONS,
                ))?
                .as_bytes(),
            )
            .to_string();
            return Ok(ProfileSnapshot {
                provider_id: id.clone(),
                revision,
                dimensions: d.dimensions,
                fingerprint,
                model: b.model_id.clone(),
                name: d.model_id.clone(),
                builtin: Some(b),
            });
        }
        // One contract with the server: an unknown or revoked provider is
        // NOT_FOUND; a revision it never had, or an older one that a newer
        // revision replaced and that is no longer usable, is CONFLICT
        // `REVISION_NOT_CURRENT` (retrying can't help); its latest revision
        // while not usable yet (probe pending or failing) is the retryable
        // INDEX_UNAVAILABLE outage.
        let latest: Option<i64> = self
            .conn
            .query_row(
                "SELECT max(r.revision) FROM providers p JOIN provider_revisions r ON r.provider_id=p.id WHERE p.id=?1 AND p.revoked=0",
                [id.as_str()],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let Some(latest) = latest else {
            return Err(StoreError::Explained(
                kb_client::ErrorCode::NotFound,
                format!("no provider `{id}`"),
            ));
        };
        let not_current = || {
            StoreError::conflict_reason(
                kb_client::error::ConflictReason::RevisionNotCurrent,
                Some("/revision"),
                format!(
                    "provider `{id}` revision `{revision}` is not usable; its latest revision is `{latest}`"
                ),
            )
        };
        let r = match self.provider_revision(&self.owner, id, revision) {
            Ok(r) => r,
            Err(e) if e.protocol_code() == kb_client::ErrorCode::NotFound => {
                return Err(not_current());
            }
            Err(e) => return Err(e),
        };
        if r.state != "READY" {
            return Err(if revision < latest {
                not_current()
            } else {
                StoreError::IndexUnavailable
            });
        }
        Ok(ProfileSnapshot {
            provider_id: id.clone(),
            revision,
            dimensions: r.dimensions,
            fingerprint: r.fingerprint,
            model: r.model,
            name: r.name,
            builtin: None,
        })
    }
    pub(crate) fn profile_live(
        &self,
        pin: &ProfileSnapshot,
        activation: bool,
    ) -> Result<bool, StoreError> {
        if let Some(b) = &pin.builtin {
            let live = self.model_state()?;
            return Ok(live.enabled && (!activation || (!live.reloading && live == *b)));
        }
        Ok(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM providers p JOIN provider_revisions r ON r.provider_id=p.id WHERE p.id=?1 AND r.revision=?2 AND p.revoked=0 AND r.state='READY' AND r.fingerprint=?3 AND r.dimensions=?4)",rusqlite::params![pin.provider_id.as_str(),pin.revision,&pin.fingerprint,pin.dimensions as i64],|r|r.get(0))?)
    }
    /// Effective availability, the one predicate every query and status
    /// surface uses (search start and its final recheck, ordinary and
    /// structured; profile and provider status): the profile can embed a
    /// query now. A built-in must be enabled, not reloading (an exclusive
    /// config probe or reload), serving the pinned model, and its file must
    /// be in the model cache (review r2 #4: a removal changes no stored
    /// state); a user provider must be usable (not revoked, revision ready).
    pub(crate) fn effective_available(&self, pin: &ProfileSnapshot) -> Result<bool, StoreError> {
        if let Some(b) = &pin.builtin {
            let live = self.model_state()?;
            return Ok(live.enabled
                && !live.reloading
                && live.model_id == b.model_id
                && self.builtin_present(&b.model_id)?);
        }
        self.profile_live(pin, false)
    }
    /// A built-in that is enabled and serving its model but whose file was
    /// removed from the cache (searches serve keywords until it returns).
    pub(crate) fn builtin_removed(&self, pin: &ProfileSnapshot) -> Result<bool, StoreError> {
        let Some(b) = &pin.builtin else {
            return Ok(false);
        };
        let live = self.model_state()?;
        Ok(live.enabled
            && !live.reloading
            && live.model_id == b.model_id
            && !self.builtin_present(&b.model_id)?)
    }
    /// Profile liveness applies only to hybrid generations: a lexical one is
    /// current for its desired epoch whatever the KB's profile.
    pub(crate) fn generation_live(
        &self,
        s: &GenerationSnapshot,
        activation: bool,
    ) -> Result<bool, StoreError> {
        match &s.profile {
            Some(pin) => self.profile_live(pin, activation),
            None => Ok(true),
        }
    }
    /// Bounded keyset scan; callers advance even when a claim is unavailable,
    /// then wrap at the end so a busy/revoked provider cannot starve siblings.
    pub fn pending_generation(&self, after: Option<&KbId>) -> Result<Option<KbId>, StoreError> {
        self.verify_identity()?;
        // Lexical-only generations are cheap and keep KBs searchable, so
        // each pass visits them first: keyset order is (semantic?, id), and
        // `after` resumes inside that order (a busy one never starves others).
        const KIND: &str = "coalesce(json_type(snapshot_json,'$.profile')='object',0)";
        let after_kind: i64 = match after {
            Some(a) => self
                .conn
                .query_row(
                    &format!("SELECT {KIND} FROM index_generations WHERE id=?1"),
                    [a.as_str()],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0),
            None => 0,
        };
        let id: Option<String> = self.conn.query_row(&format!("SELECT id FROM index_generations WHERE state='PENDING' AND ({KIND}>?2 OR ({KIND}=?2 AND id>?1)) ORDER BY {KIND},id LIMIT 1"), (after.map_or("", KbId::as_str), after_kind), |r|r.get(0)).optional()?;
        id.map(|s| KbId::parse(&s).map_err(|_| StoreError::IndexUnavailable))
            .transpose()
    }
    pub fn generation_snapshot(&self, id: &KbId) -> Result<GenerationSnapshot, StoreError> {
        let raw: String = self
            .conn
            .query_row(
                "SELECT snapshot_json FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(StoreError::NotFound)?;
        decode(&raw)
    }
    /// Caller owns the store fence and an encompassing state transaction.
    /// Every ACTIVE KB gets a generation (lexical-only without a usable
    /// profile), so a main publication always reports its index job.
    pub(crate) fn enqueue_generation(&self, kb: &KbId, job: &Uuid) -> Result<KbId, StoreError> {
        let (profile, epoch, head): (Option<String>, i64, String) = self.conn.query_row(
            "SELECT profile_json,desired_epoch,head_sha FROM kbs WHERE id=?1 AND state='ACTIVE'",
            [kb.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        // No profile, or a user provider that can no longer build
        // (revoked/unready), gets a lexical-only generation. A built-in pin is
        // the built-in lifecycle's (`schedule_builtin_rebuilds`) and keeps its
        // hybrid scheduling; a user revision mid-probe stays hybrid so the
        // claim defers instead of dropping its vectors.
        let profile = match profile {
            None => None,
            Some(raw) => {
                let pin: ProfileSnapshot = decode(&raw)?;
                if pin.builtin.is_some()
                    || self.profile_live(&pin, true)?
                    || self.profile_probing(&pin)?
                {
                    Some(pin)
                } else {
                    None
                }
            }
        };
        // Newer desired work replaces queued work, and every started or
        // completed-but-unactivated generation that the predicate says can
        // no longer serve (`serve_order`); one that still ranks above the
        // active generation finishes and serves until something better does
        // (a newer older-commit build while nothing of the head serves).
        self.conn.execute(
            &format!(
                "UPDATE index_generations AS g SET state='SUPERSEDED',finished_ms=?2 \
                 WHERE g.kb_id=?1 AND (g.state IN ('PENDING','BUILDING','INDEXING') \
                   OR (g.state='COMPLETE' AND g.id IS NOT (SELECT active_generation_id FROM kbs WHERE id=?1))) \
                 AND NOT (g.state<>'PENDING' AND EXISTS (SELECT 1 FROM kbs k WHERE k.id=g.kb_id \
                   AND NOT EXISTS (SELECT 1 FROM index_generations a WHERE a.id=k.active_generation_id \
                     AND ({},a.epoch)>=({},g.epoch))))",
                serve_rank_sql("a"), serve_rank_sql("g")
            ),
            (kb.as_str(), ms(self.now_ms())),
        )?;
        self.conn.execute("UPDATE index_jobs SET state='CANCELLED' WHERE state IN ('PENDING','RUNNING') AND generation_id IN (SELECT id FROM index_generations WHERE kb_id=?1 AND state='SUPERSEDED')",[kb.as_str()])?;
        let commit_sha = Sha::parse(&head).map_err(|_| StoreError::IndexUnavailable)?;
        let mut epoch = epoch;
        // "always keep a lexical index" (`lexical_gap`, the serve order):
        // while nothing of the head commit is active (no active generation, or
        // any generation of an older commit, hybrid included), a semantic build
        // is preceded by a cheap lexical-only companion of the same commit one
        // epoch below; it activates when built and the semantic one replaces
        // it. The older hybrid stays the vector-reuse source.
        if profile.is_some() && self.lexical_gap(kb)? {
            let companion = GenerationSnapshot {
                id: state::new_id()?,
                kb_id: kb.clone(),
                epoch,
                commit_sha: commit_sha.clone(),
                profile: None,
                owner_id: self.owner.id().into(),
                quantization: self.index_quantization.get(),
            };
            self.insert_generation(&companion, &state::new_uuid_v4()?)?;
            epoch += 1;
            self.conn.execute(
                "UPDATE kbs SET desired_epoch=?2 WHERE id=?1",
                (kb.as_str(), epoch),
            )?;
        }
        let id = state::new_id()?;
        let snapshot = GenerationSnapshot {
            id: id.clone(),
            kb_id: kb.clone(),
            epoch,
            commit_sha,
            profile,
            owner_id: self.owner.id().into(),
            // The CLI builds every KB as binary_int8_rescore (no CLI setter;
            // only a test seam selects another shared-format variant).
            quantization: self.index_quantization.get(),
        };
        self.insert_generation(&snapshot, job)?;
        self.conn.execute(
            "UPDATE kbs SET desired_generation_id=?2 WHERE id=?1",
            (kb.as_str(), id.as_str()),
        )?;
        Ok(id)
    }
    fn insert_generation(&self, s: &GenerationSnapshot, job: &Uuid) -> Result<(), StoreError> {
        self.conn.execute("INSERT INTO index_generations(id,kb_id,epoch,commit_sha,snapshot_json,job_id,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,'PENDING',?7)",rusqlite::params![s.id.as_str(),s.kb_id.as_str(),s.epoch,s.commit_sha.as_str(),json(s)?,job.as_str(),state::now_utc()])?;
        self.conn.execute(
            "INSERT INTO index_jobs(id,generation_id,state) VALUES(?1,?2,'PENDING')",
            (job.as_str(), s.id.as_str()),
        )?;
        Ok(())
    }
    /// Neither semantic@head nor lexical@head is active, so the scheduler
    /// covers lexical@head (built first, serving until semantic@head replaces
    /// it). An active lexical@head already is that coverage.
    fn lexical_gap(&self, kb: &KbId) -> Result<bool, StoreError> {
        Ok(self
            .active_serve(kb)?
            .is_none_or(|(rank, _)| rank < SERVE_LEXICAL_AT_HEAD))
    }
    /// The active generation's `(serve rank, epoch)` against the KB's head.
    fn active_serve(&self, kb: &KbId) -> Result<Option<(i64, i64)>, StoreError> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {},g.epoch FROM kbs k JOIN index_generations g ON g.id=k.active_generation_id WHERE k.id=?1", serve_rank_sql("g")),
                [kb.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
    fn profile_probing(&self, pin: &ProfileSnapshot) -> Result<bool, StoreError> {
        Ok(pin.builtin.is_none() && self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM providers p JOIN provider_revisions r ON r.provider_id=p.id WHERE p.id=?1 AND r.revision=?2 AND p.revoked=0 AND r.state='PROBING' AND r.probe_until_ms>?3)",
            (pin.provider_id.as_str(), pin.revision, ms(self.now_ms())), |r| r.get::<_,bool>(0),
        )?)
    }
    /// The enabled built-in model as an attachable provider (`builtin`).
    pub fn builtin_provider_summary(&self) -> Result<Option<ProviderSummary>, StoreError> {
        let b = self.model_state()?;
        if !b.enabled || b.reloading {
            return Ok(None);
        }
        let d = crate::qwen::descriptor(&b.model_id)?;
        let present = self.builtin_present(&b.model_id)?;
        Ok(Some(ProviderSummary {
            provider_id: ProviderRef::builtin(),
            revision: b.epoch + 1,
            kind: ProviderKind::SystemBuiltin,
            name: "Built-in embedding model".into(),
            model: d.model_id,
            dimensions: d.dimensions as i64,
            context_tokens: Some(i64::from(b.context_tokens)),
            // Review r2 #4: removed from the cache is not ready.
            status: if present {
                ProviderStatus::Ready
            } else {
                ProviderStatus::Unavailable
            },
        }))
    }
    pub fn embedding_profile_set(
        &self,
        p: &LocalPrincipal,
        input: EmbeddingProfileSetInput,
    ) -> Result<ProfileSetOutput, StoreError> {
        crate::bases::check_input::<EmbeddingProfileSet>(&input)?;
        let input = EmbeddingProfileSetInput {
            provider_id: input.provider_id.canonical(),
            ..input
        };
        // Input-only checks here; the built-in's mutable state is resolved
        // in `index_request`, after the receipt lookup, so a replay always
        // returns its recorded result (ROOT 4).
        let target = match input.provider_id.provider_id() {
            Some(id) => ProfileTarget::Provider(
                id,
                input.revision.ok_or_else(|| {
                    StoreError::invalid(
                        kb_client::error::InvalidReason::MissingArgument,
                        Some("/revision".into()),
                        format!(
                            "`revision` is required for provider `{}`",
                            input.provider_id
                        ),
                    )
                })?,
            ),
            None => ProfileTarget::Builtin(input.revision),
        };
        self.index_request(
            p,
            &input.kb_id,
            "PROFILE_SET",
            input.idempotency_key.as_str(),
            json(&input)?,
            Some(target),
        )
    }
    /// `builtin`: the enabled built-in's current revision.
    /// (server parity): a revision other than the current configuration's
    /// (an earlier one, or one that never existed) is `REVISION_NOT_CURRENT`
    /// whatever the model's state; the current one while the model is
    /// disabled or reloading is the retryable `INDEX_UNAVAILABLE` outage.
    fn resolve_builtin(&self, revision: Option<i64>) -> Result<(KbId, i64), StoreError> {
        let b = self.model_state()?;
        let current = b.epoch + 1;
        if revision.is_some_and(|r| r != current) {
            return Err(StoreError::conflict_reason(
                kb_client::error::ConflictReason::RevisionNotCurrent,
                Some("/revision"),
                format!(
                    "the built-in model's current revision is `{current}`; omit `revision` to use it"
                ),
            ));
        }
        if !b.enabled || b.reloading {
            return Err(StoreError::Explained(
                kb_client::ErrorCode::IndexUnavailable,
                "no built-in model is enabled; run `kb model enable` first".into(),
            ));
        }
        Ok((
            KbId::parse(BUILTIN_PROVIDER_ID).map_err(|_| StoreError::IndexUnavailable)?,
            current,
        ))
    }
    pub fn index_rebuild(
        &self,
        p: &LocalPrincipal,
        input: IndexRebuildInput,
    ) -> Result<GenerationJobOutput, StoreError> {
        crate::bases::check_input::<IndexRebuild>(&input)?;
        let out = self.index_request(
            p,
            &input.kb_id,
            "INDEX_REBUILD",
            input.idempotency_key.as_str(),
            json(&input)?,
            None,
        )?;
        // A rebuild always schedules (only a profile set can find its work done).
        Ok(GenerationJobOutput {
            operation_id: out.operation_id,
            generation_id: out.generation_id,
            job_id: out.job_id,
            state: PendingState,
        })
    }
    fn index_request(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        op: &str,
        key: &str,
        request: String,
        profile: Option<ProfileTarget>,
    ) -> Result<ProfileSetOutput, StoreError> {
        let _guard = self.lock_write(std::slice::from_ref(kb))?;
        self.authorize(p, kb, Permission::Manage)?;
        self.read_kb_locked(&_guard, kb)?;
        // All external providers belong to the single local owner. Narrowed
        // managers may attach a ready built-in, never borrow owner credentials.
        // Anyone else's provider is NOT_FOUND, without saying whose (
        // server parity).
        if matches!(profile, Some(ProfileTarget::Provider(..))) && p != &self.owner {
            return Err(StoreError::NotFound);
        }
        let actor = p.actor_key();
        let known:Option<(String,String)>=self.conn.query_row("SELECT request_json,response_json FROM index_receipts WHERE actor_key=?1 AND kb_id=?2 AND operation=?3 AND idempotency_key=?4",(&actor,kb.as_str(),op,key),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((old, response)) = known {
            if old != request {
                return Err(StoreError::IdempotencyMismatch);
            }
            return decode(&response);
        }
        self.check_disk_admission(0)?;
        let tx = self.conn.unchecked_transaction()?;
        let profile = match profile {
            Some(ProfileTarget::Provider(id, v)) => Some((id, v)),
            Some(ProfileTarget::Builtin(v)) => Some(self.resolve_builtin(v)?),
            None => None,
        };
        let pin = match &profile {
            Some((id, v)) => Some(self.profile_pin(id, *v)?),
            None => {
                let raw: Option<String> = tx.query_row(
                    "SELECT profile_json FROM kbs WHERE id=?1",
                    [kb.as_str()],
                    |r| r.get(0),
                )?;
                raw.as_deref().map(decode::<ProfileSnapshot>).transpose()?
            }
        };
        // A profile set must pin a live profile. A rebuild follows the
        // enqueue rule: without a profile, or with a user profile that
        // can no longer build, it schedules a lexical generation; a built-in
        // that is not build-current stays unavailable.
        let live = match &pin {
            Some(p) => self.profile_live(p, true)?,
            None => false,
        };
        let rebuild_lexical = profile.is_none() && pin.as_ref().is_none_or(|p| p.builtin.is_none());
        if !live && !rebuild_lexical {
            return Err(StoreError::IndexUnavailable);
        }
        // Re-attaching the profile a semantic generation of the head already
        // serves (or is building) at the desired epoch starts nothing and
        // spends no rebuild budget (R3-L12, server `sameSemanticWork`).
        if profile.is_some()
            && let Some(pin) = &pin
            && let Some((generation_id, job_id, state)) = self.same_semantic_work(kb, pin)?
        {
            let out = ProfileSetOutput {
                operation_id: state::new_uuid_v4()?,
                generation_id,
                job_id,
                state,
            };
            tx.execute(
                "INSERT INTO index_receipts VALUES(?1,?2,?3,?4,?5,?6,?7)",
                (
                    &actor,
                    kb.as_str(),
                    op,
                    key,
                    request,
                    json(&out)?,
                    ms(self.now_ms()),
                ),
            )?;
            crate::git_read::OperationDeadline::check()?;
            tx.commit()?;
            return Ok(out);
        }
        let charges: i64 = tx.query_row(
            // Only receipts that scheduled work spend the budget (a no-op
            // re-attach records a receipt for replay but no index event).
            "SELECT count(*) FROM index_receipts r WHERE r.kb_id=?1 AND r.created_ms>?2 AND EXISTS(SELECT 1 FROM index_events e WHERE e.id=json_extract(r.response_json,'$.operationId'))",
            (kb.as_str(), ms(self.now_ms().saturating_sub(3_600_000))),
            |r| r.get(0),
        )?;
        if charges >= crate::limits::LOCAL_REBUILDS_PER_HOUR_PER_KB {
            return Err(StoreError::RateLimited(3600));
        }
        tx.execute(
            "UPDATE kbs SET profile_json=coalesce(?2,profile_json),desired_epoch=desired_epoch+1 WHERE id=?1",
            (kb.as_str(), pin.as_ref().map(json).transpose()?),
        )?;
        let job = state::new_uuid_v4()?;
        let id = self.enqueue_generation(kb, &job)?;
        let out = ProfileSetOutput {
            operation_id: state::new_uuid_v4()?,
            generation_id: id,
            job_id: job,
            state: ProfileSetState::Pending,
        };
        tx.execute(
            "INSERT INTO index_receipts VALUES(?1,?2,?3,?4,?5,?6,?7)",
            (
                &actor,
                kb.as_str(),
                op,
                key,
                request,
                json(&out)?,
                ms(self.now_ms()),
            ),
        )?;
        tx.execute(
            "INSERT INTO index_events VALUES(?1,?2,?3)",
            (
                out.operation_id.as_str(),
                out.generation_id.as_str(),
                if op == "PROFILE_SET" {
                    "profile_set"
                } else {
                    "index_rebuild"
                },
            ),
        )?;
        crate::git_read::OperationDeadline::check()?;
        tx.commit()?;
        Ok(out)
    }
    /// The semantic generation already doing what a profile set of `pin`
    /// would start: the KB's profile is that provider/revision, and a
    /// generation pinning that exact provider, revision and fingerprint, of
    /// the head commit at the desired epoch, is either the active COMPLETE one
    /// (`Current`) or still in flight (`Pending`). A lexical generation never
    /// counts, whatever the KB's freshness says. Caller holds the KB lock.
    fn same_semantic_work(
        &self,
        kb: &KbId,
        pin: &ProfileSnapshot,
    ) -> Result<Option<(KbId, Uuid, ProfileSetState)>, StoreError> {
        let raw: Option<String> = self.conn.query_row(
            "SELECT profile_json FROM kbs WHERE id=?1 AND state='ACTIVE'",
            [kb.as_str()],
            |r| r.get(0),
        )?;
        let current = raw.as_deref().map(decode::<ProfileSnapshot>).transpose()?;
        if current.is_none_or(|c| c.provider_id != pin.provider_id || c.revision != pin.revision) {
            return Ok(None);
        }
        let mut q = self.conn.prepare(
            "SELECT g.id,g.job_id,g.state='COMPLETE',g.snapshot_json FROM kbs k JOIN index_generations g ON g.kb_id=k.id \
             WHERE k.id=?1 AND g.commit_sha=k.head_sha AND g.epoch=k.desired_epoch \
               AND ((g.state='COMPLETE' AND k.active_generation_id=g.id) OR g.state IN ('PENDING','BUILDING','INDEXING')) \
             ORDER BY (g.state='COMPLETE') DESC, g.id",
        )?;
        // pagination:audited — bounded by one KB's generations at one epoch.
        let rows = q
            .query_map([kb.as_str()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, job, active, snapshot) in rows {
            let snapshot: GenerationSnapshot = decode(&snapshot)?;
            let Some(p) = &snapshot.profile else {
                continue;
            };
            if p.provider_id == pin.provider_id
                && p.revision == pin.revision
                && p.fingerprint == pin.fingerprint
            {
                let malformed = || StoreError::RecoveryRequired("generation row".into());
                return Ok(Some((
                    KbId::parse(&id).map_err(|_| malformed())?,
                    Uuid::parse(&job).map_err(|_| malformed())?,
                    if active {
                        ProfileSetState::Current
                    } else {
                        ProfileSetState::Pending
                    },
                )));
            }
        }
        Ok(None)
    }
    pub fn index_status_get(
        &self,
        p: &LocalPrincipal,
        input: KbRef,
    ) -> Result<IndexStatus, StoreError> {
        crate::bases::check_input::<IndexStatusGet>(&input)?;
        Ok(self.bases_get(p, input)?.index)
    }
    pub fn embedding_profile_get(
        &self,
        p: &LocalPrincipal,
        input: KbRef,
    ) -> Result<EmbeddingProfileOutput, StoreError> {
        crate::bases::check_input::<EmbeddingProfileGet>(&input)?;
        let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        self.authorize(p, &input.kb_id, Permission::Read)?;
        let record = self.read_kb_locked(&_guard, &input.kb_id)?;
        let head = Sha::parse(record.head_sha.as_deref().unwrap_or(""))
            .map_err(|_| StoreError::IndexUnavailable)?;
        let raw: Option<String> = self.conn.query_row(
            "SELECT profile_json FROM kbs WHERE id=?1",
            [input.kb_id.as_str()],
            |r| r.get(0),
        )?;
        let profile = raw
            .map(|r| -> Result<_, StoreError> {
                let pin: ProfileSnapshot = decode(&r)?;
                Ok(ProviderSummary {
                    provider_id: if pin.builtin.is_some() {
                        ProviderRef::builtin()
                    } else {
                        pin.provider_id.clone().into()
                    },
                    revision: pin.revision,
                    kind: if pin.builtin.is_some() {
                        ProviderKind::SystemBuiltin
                    } else {
                        ProviderKind::OpenaiCompat
                    },
                    name: pin.name.clone(),
                    model: pin.model.clone(),
                    dimensions: pin.dimensions as i64,
                    context_tokens: pin.builtin.as_ref().map(|b| i64::from(b.context_tokens)),
                    status: if pin.builtin.is_none()
                        && self.conn.query_row(
                            "SELECT revoked FROM providers WHERE id=?1",
                            [pin.provider_id.as_str()],
                            |r| r.get::<_, bool>(0),
                        )? {
                        ProviderStatus::Revoked
                    } else if self.effective_available(&pin)? {
                        ProviderStatus::Ready
                    } else {
                        ProviderStatus::Unavailable
                    },
                })
            })
            .transpose()?;
        Ok(EmbeddingProfileOutput {
            profile,
            index: self.index_status(&record, &head)?,
        })
    }
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
        // R3-L5: built-in builds of different KBs no longer queue behind
        // one store-wide permit. The one shared worker runs one inference at
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
        // This new claimant exclusively owns the KB writer permit. Previous
        // terminal attempts cannot still write, including an error path that
        // was unable to obtain the store fence for its final ledger release.
        self.conn.execute("UPDATE index_generations SET reserved_bytes=0 WHERE kb_id=?1 AND id<>?2 AND reserved_bytes>0 AND state IN ('COMPLETE','SUPERSEDED','FAILED')", (snapshot.kb_id.as_str(), id.as_str()))?;
        self.check_disk_admission(0)?;
        self.paths.ensure_index_dir(&snapshot.kb_id)?;
        let cancel = GenerationCancellation::for_generation(&self.paths, &snapshot);
        let mut intent = paths::open_no_follow(
            &cancel.path,
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(true),
        )?;
        intent.write_all(b"0").map_err(StoreError::Io)?;
        intent.sync_all().map_err(StoreError::Io)?;
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
    /// THE serve invariant, one definition for scheduling, claims,
    /// builds, activation and recovery. What serves a KB is the best
    /// activatable generation in the order:
    ///
    /// 1. its desired generation (semantic, or lexical with no usable profile);
    /// 2. semantic@head;
    /// 3. lexical@head (the companion): after a commit it serves as soon as it
    ///    completes and stays until semantic@head activates;
    /// 4. the newest older generation, only while nothing of the head is
    ///    servable yet.
    pub(crate) fn serve(&self, s: &GenerationSnapshot) -> Result<Serve, StoreError> {
        Ok(match self.serve_order(&s.id, &s.kb_id, &s.owner_id)? {
            Some((_, true)) => Serve::Activate,
            _ => Serve::Stale,
        })
    }
    /// `(rank, serves)` of a stored generation by the predicate
    /// ([`serve_rank_sql`]): it serves when it is the active one or its
    /// `(rank, epoch)` is above the active one's. `None` when its KB is not an
    /// ACTIVE KB of this store's owner (it never serves).
    fn serve_order(
        &self,
        id: &KbId,
        kb: &KbId,
        owner: &str,
    ) -> Result<Option<(i64, bool)>, StoreError> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {}, g.epoch, a.id, {}, a.epoch FROM kbs k JOIN store_meta m ON m.id=1 \
                     JOIN index_generations g ON g.id=?2 AND g.kb_id=k.id \
                     LEFT JOIN index_generations a ON a.id=k.active_generation_id \
                     WHERE k.id=?1 AND k.state='ACTIVE' AND m.owner_principal_id=?3",
                    serve_rank_sql("g"),
                    serve_rank_sql("a")
                ),
                (kb.as_str(), id.as_str(), owner),
                |r| {
                    let rank: i64 = r.get(0)?;
                    let epoch: i64 = r.get(1)?;
                    let active: Option<String> = r.get(2)?;
                    let above = match active {
                        None => true,
                        Some(a) if a == id.as_str() => true,
                        Some(_) => (rank, epoch) > (r.get::<_, i64>(3)?, r.get::<_, i64>(4)?),
                    };
                    Ok((rank, above))
                },
            )
            .optional()?)
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
    fn activate_built_locked(
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
            .map_err(StoreError::from)
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
                // R3-L8: an unreadable active file heals: it is lost and
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
    /// Model promotion/rollback caller owns the store fence and transaction.
    pub(crate) fn schedule_builtin_rebuilds(&self) -> Result<(), StoreError> {
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
                    if pin.builtin.as_ref().is_some_and(|b| b != &live) {
                        let pin = self.profile_pin(&pin.provider_id, live.epoch + 1)?;
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
                    // L-1: the owning process exited mid-build: a host
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
                // R3-L8: an active file that is no longer an index (a damaged
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
    /// R3-L8 / review #4: whether a published generation file is proven
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
    /// (L-1, L-2): an attempt ended by shutdown, its no-progress watchdog
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
    /// L-21/L-22: dead scratch and tombstoned KB data, removed without
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
    /// R3-L10: one bounded page (in name order, after `after`) of permit
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
            // L-21: a reclaimed generation is never visited again; its
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

#[cfg(test)]
mod deadline_tests {
    use super::*;
    #[test]
    fn the_watchdog_moves_with_progress_and_expires_without_it() {
        // An explicit clock: instants derived from the deadline's own base,
        // never sleeps racing the real timer.
        let d = BuildDeadline::new(Duration::from_millis(80));
        let base = d.base;
        let at = |ms: u64| base + Duration::from_millis(ms);
        for step in 1..=4u64 {
            let now = at(step * 50);
            assert!(!d.expired_at(now), "progress keeps the attempt alive");
            d.extend_at(now);
        }
        // Last progress at 200 ms: alive until 280 ms, expired from then on.
        assert!(!d.expired_at(at(279)));
        assert!(d.expired_at(at(280)), "no progress for the window ends it");
        assert!(d.expired_at(at(400)));
        // Extension never moves backwards.
        d.extend_at(at(10));
        assert!(d.expired_at(at(280)));
        let fixed = BuildDeadline::fixed(Duration::from_millis(30));
        fixed.extend_at(fixed.base + Duration::from_millis(20));
        assert!(!fixed.expired_at(fixed.base + Duration::from_millis(29)));
        assert!(
            fixed.expired_at(fixed.base + Duration::from_millis(30)),
            "a fixed deadline never extends"
        );
    }
}
#[cfg(test)]
mod phase_tests {
    use super::*;
    /// The phase table covers exactly the states the schema allows, so a new
    /// state can never be missing from a derived set (`states_sql`).
    #[test]
    fn phases_cover_every_schema_state() {
        let sql = include_str!("db/0001_initial.sql");
        let at = sql.find("CREATE TABLE index_generations").expect("table");
        let check = &sql[at..];
        let list = &check[check.find("state IN (").expect("check") + 10..];
        let list = &list[..list.find(')').expect("end")];
        let mut schema = list
            .split(',')
            .map(|s| s.trim().trim_matches('\'').to_owned())
            .collect::<Vec<_>>();
        schema.sort();
        let mut ours = ALL_STATES
            .iter()
            .map(|s| s.as_str().to_owned())
            .collect::<Vec<_>>();
        ours.sort();
        assert_eq!(schema, ours);
        assert_eq!(states_sql(&[Phase::InProgress]), "'BUILDING','INDEXING'");
    }
}
