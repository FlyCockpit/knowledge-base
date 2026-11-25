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
use kb_client::tools::{EmbeddingProfileGet, EmbeddingProfileSet, IndexRebuild, IndexStatusGet};
use kb_client::types::*;
use rusqlite::OptionalExtension;
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
impl GenerationReadError {
    /// The protocol error a public caller receives: a repaired generation
    /// reads as `IndexUnavailable`, every other failure as itself.
    pub(crate) fn into_store_error(self) -> StoreError {
        match self {
            GenerationReadError::Repaired(_) => StoreError::IndexUnavailable,
            GenerationReadError::ReadFailed(error) | GenerationReadError::Failed(error) => error,
        }
    }
}

/// Internal registry identity of the built-in model in pinned snapshots. It
/// never crosses the wire: the protocol and the CLI call it `builtin`.
pub const BUILTIN_PROVIDER_ID: &str = "builtinembeddingmodel000";

/// Which native runtime [`Store::schedule_builtin_rebuilds`] pins to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PinRuntime {
    /// This process's: its launch reconcile, or an owner's model
    /// enable/configure it promoted.
    Current,
    /// Each pin's own: automatic upkeep any process runs (settling an
    /// abandoned probe) refreshes the configuration but never moves a KB to
    /// its own runtime, so a `kb` of another version never re-pins the
    /// store's latest launch's KBs back (nor supersedes its re-embedding).
    Kept,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileSnapshot {
    pub provider_id: KbId,
    pub revision: i64,
    pub dimensions: usize,
    pub fingerprint: String,
    pub model: String,
    pub name: String,
    pub builtin: Option<crate::model_catalog::ModelState>,
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
    pub fn builtin(&self) -> Option<&crate::model_catalog::ModelState> {
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
    pub(crate) fn for_generation(paths: &crate::StorePaths, s: &GenerationSnapshot) -> Self {
        Self {
            token: kb_client::CancellationToken::new(),
            paths: paths.clone(),
            path: paths
                .index_dir(&s.kb_id)
                .join(format!("{}.sqlite.cancel", s.id)),
        }
    }
    /// A claim starts its attempt with a fresh durable "not cancelled"
    /// intent, replacing any earlier attempt's. The claim keeps the returned
    /// handle open until it returns, as it always has.
    pub(crate) fn create(&self) -> Result<File, StoreError> {
        let mut intent = paths::open_no_follow(
            &self.path,
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(true),
        )?;
        intent.write_all(b"0").map_err(StoreError::Io)?;
        intent.sync_all().map_err(StoreError::Io)?;
        Ok(intent)
    }
    /// The intent's file lock: activation holds it through its state commit,
    /// so a cancellation is either seen by activation or comes after it.
    pub(crate) fn lock(&self) -> Result<CancelGuard, StoreError> {
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
    pub(crate) fn reset(&self) -> Result<(), StoreError> {
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
pub(crate) struct CancelGuard(File);
impl CancelGuard {
    pub(crate) fn cancelled(&mut self) -> Result<bool, StoreError> {
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
/// marked FAILED instead of being retried.
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
/// A build's "still making progress" deadline. Every completed unit
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
pub(crate) const SERVE_DESIRED: i64 = 4;
pub(crate) fn serve_rank_sql(g: &str) -> String {
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
/// Only a fully durable, accounted file produces this capability. Fields private.
pub struct BuiltGeneration {
    pub(crate) snapshot: GenerationSnapshot,
    pub(crate) token: String,
    pub(crate) root: std::path::PathBuf,
    pub(crate) until: BuildDeadline,
    pub(crate) cancel: GenerationCancellation,
    pub(crate) _completion: locks::CredentialFence,
}
pub(crate) fn json<T: Serialize>(v: &T) -> Result<String, StoreError> {
    serde_json::to_string(v).map_err(|_| StoreError::IndexUnavailable)
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, StoreError> {
    serde_json::from_str(s).map_err(|_| StoreError::RecoveryRequired("index snapshot".into()))
}
pub(crate) fn ms(now: u64) -> i64 {
    i64::try_from(now).unwrap_or(i64::MAX)
}
/// What a profile set asks for, resolved under the fence after replay.
enum ProfileTarget {
    Provider(KbId, i64),
    Builtin(Option<i64>),
}
/// Concurrent built-in builds per store; they share one worker.
pub const BUILTIN_BUILD_SLOTS: usize = 2;
/// Concurrent external-provider builds per store.
pub const EXTERNAL_BUILD_SLOTS: usize = 2;
pub(crate) fn kb_permit(kb: &KbId) -> String {
    format!("index-build-{kb}.lock")
}
pub(crate) fn completion_permit(id: &KbId) -> String {
    format!("index-completion-{id}.lock")
}
pub(crate) fn read_permit(id: &KbId) -> String {
    format!("index-read-{id}.lock")
}
impl Store {
    /// The built-in pin (`id`) of configuration `b`, under the runtime `b`
    /// names, at `revision`.
    pub(crate) fn builtin_pin(
        id: &KbId,
        b: crate::model_catalog::ModelState,
        revision: i64,
    ) -> Result<ProfileSnapshot, StoreError> {
        let d = crate::model_catalog::descriptor(&b.model_id)?;
        // The native runtime is part of the vector space (server
        // `builtinModelIdentity`): a CLI that runs another one re-embeds.
        let fingerprint = kb_client::host::snapshot::content_hash(
            json(&(
                &d,
                b.context_tokens,
                &b.runtime_identity,
                &crate::fingerprint::EMBEDDING_VERSIONS,
            ))?
            .as_bytes(),
        )
        .to_string();
        Ok(ProfileSnapshot {
            provider_id: id.clone(),
            revision,
            dimensions: d.dimensions,
            fingerprint,
            model: b.model_id.clone(),
            name: d.model_id.clone(),
            builtin: Some(b),
        })
    }
    fn profile_pin(&self, id: &KbId, revision: i64) -> Result<ProfileSnapshot, StoreError> {
        if id.as_str() == BUILTIN_PROVIDER_ID {
            let b = self.model_state()?;
            if !b.enabled || b.reloading || revision != b.epoch + 1 {
                return Err(StoreError::IndexUnavailable);
            }
            return Self::builtin_pin(id, b, revision);
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
            return Ok(live.enabled && (!activation || (!live.reloading && live.same_config(b))));
        }
        Ok(self.conn.query_row("SELECT EXISTS(SELECT 1 FROM providers p JOIN provider_revisions r ON r.provider_id=p.id WHERE p.id=?1 AND r.revision=?2 AND p.revoked=0 AND r.state='READY' AND r.fingerprint=?3 AND r.dimensions=?4)",rusqlite::params![pin.provider_id.as_str(),pin.revision,&pin.fingerprint,pin.dimensions as i64],|r|r.get(0))?)
    }
    /// Effective availability, the one predicate every query and status
    /// surface uses (search start and its final recheck, ordinary and
    /// structured; profile and provider status): the profile can embed a
    /// query now. A built-in must be enabled, not reloading (an exclusive
    /// config probe or reload), serving the pinned model, and its file must
    /// be in the model cache (a removal changes no stored
    /// state); a user provider must be usable (not revoked, revision ready).
    pub(crate) fn effective_available(&self, pin: &ProfileSnapshot) -> Result<bool, StoreError> {
        if let Some(b) = &pin.builtin {
            let live = self.model_state()?;
            return Ok(live.enabled
                && !live.reloading
                && live.same_identity(b)
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
            && live.same_identity(b)
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
    pub(crate) fn profile_probing(&self, pin: &ProfileSnapshot) -> Result<bool, StoreError> {
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
        let d = crate::model_catalog::descriptor(&b.model_id)?;
        let present = self.builtin_present(&b.model_id)?;
        Ok(Some(ProviderSummary {
            provider_id: ProviderRef::builtin(),
            revision: b.epoch + 1,
            kind: ProviderKind::SystemBuiltin,
            name: "Built-in embedding model".into(),
            model: d.model_id,
            dimensions: d.dimensions as i64,
            context_tokens: Some(i64::from(b.context_tokens)),
            // Removed from the cache is not ready.
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
            provider_id: kb_client::schema::canonical_provider_ref(&input.provider_id),
            ..input
        };
        // Input-only checks here; the built-in's mutable state is resolved
        // in `index_request`, after the receipt lookup, so a replay always
        // returns its recorded result (ROOT 4).
        let target = match kb_client::schema::registered_provider_id(&input.provider_id) {
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
        // spends no rebuild budget (server `sameSemanticWork`).
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
            crate::deadline::OperationDeadline::check()?;
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
        crate::deadline::OperationDeadline::check()?;
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
    pub(crate) fn serve_order(
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
