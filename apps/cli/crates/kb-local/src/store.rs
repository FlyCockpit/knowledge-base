//! The managed store: open/initialize/recover, KB registry, generation
//! pointers and local authorization.

use std::cell::Cell;
use std::fmt;
use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

use kb_client::ErrorCode;
use kb_client::attachment::{local_attachment_locator, local_attachment_namespace};
use kb_client::types::{KbId, Permission, Slug, Uuid};
use rusqlite::{Connection, OptionalExtension};

use crate::cursor::CursorKey;
use crate::limits::LocalLimits;
use crate::locks::{self, WriteGuard};
use crate::paths::{
    STATE_INIT_FILE, StorePaths, create_dir_exclusive, is_link, open_no_follow, sync_dir,
};
use crate::state::{
    self, Bits, ConnectionSettings, LocalPrincipal, PrincipalKind, new_id, new_uuid_v4, now_utc,
};

/// Store failure. Messages never include document content or secrets.
#[derive(Debug)]
pub enum StoreError {
    /// Durable state is missing or unusable in a nonempty store; an operator
    /// must restore it. Maps to kb/1 `REPAIR_REQUIRED`.
    RecoveryRequired(String),
    /// A managed path is a symlink/reparse point, not the expected type, or
    /// not owner-only. Maps to `REPAIR_REQUIRED`.
    UnsafePath(String),
    /// The guard does not belong to this store.
    LockNotHeld,
    NotFound,
    Forbidden,
    Conflict(String),
    /// `baseRevision` is not the complete HEAD of the target branch (main,
    /// or the named/active proposal). kb/1 `CONFLICT` with details
    /// `{headSha, proposalNumber}`.
    StaleBase {
        head_sha: kb_client::types::Sha,
        proposal_number: Option<u64>,
    },
    InvalidArgument(String),
    /// `INVALID_ARGUMENT` with a closed reason and, when known, the JSON
    /// pointer of the offending argument (`{reason, field?}`).
    Invalid {
        reason: kb_client::error::InvalidReason,
        field: Option<String>,
        /// The inclusive bounds the value broke, when known.
        min: Option<i64>,
        max: Option<i64>,
        why: String,
    },
    /// A proposal update (or merge) that still clashes with main: kb/1
    /// `CONFLICT` with `PROPOSAL_CONFLICT` details (every unresolved path with
    /// its base/theirs/yours versions and revisions).
    ProposalConflict(Box<kb_client::error::ProposalConflict>),
    /// Creating a path that already exists: kb/1 `CONFLICT` with details
    /// `{reason: "PATH_EXISTS", field?}`.
    PathExists {
        field: Option<String>,
    },
    /// A document read of a path that is not in the revision: kb/1
    /// `NOT_FOUND` with `{reason: "PATH_NOT_FOUND", field?}`.
    PathNotFound {
        field: Option<String>,
    },
    /// Any other closed-reason `CONFLICT` (`{reason, field?}`), with a
    /// human explanation for the local CLI.
    ConflictWith {
        reason: kb_client::error::ConflictReason,
        field: Option<String>,
        why: String,
    },
    IndexUnavailable,
    /// Closed classification: the query embedder itself failed (provider
    /// or model error, or an invalid embedding). Degradable to the keyword
    /// arm, like `EmbeddingTimeout`; wire code `INDEX_UNAVAILABLE`.
    EmbeddingFailed,
    /// The embedding call itself ran out of time (the provider call's
    /// own budget, or the model's reply wait). Degradable like
    /// `EmbeddingFailed`; wire code `DEADLINE_EXCEEDED`. Never an admission,
    /// lock or storage deadline (those stay `DeadlineExceeded`).
    EmbeddingTimeout,
    /// A build attempt's own no-progress watchdog expired: the only deadline
    /// that counts as a stall. Wire code `DEADLINE_EXCEEDED`.
    WatchdogExpired,
    /// A durable budget (live KBs) is exhausted.
    QuotaExceeded(String),
    /// A rolling-window budget is exhausted; retry after the given seconds.
    RateLimited(u64),
    /// Malformed, foreign, tampered, rebound or expired page cursor.
    InvalidCursor,
    /// Same actor + KB + operation + idempotency key, different request.
    IdempotencyMismatch,
    /// The keyed operation was durably aborted before publication; its
    /// stable failure code is replayed for every retry with that key (a new
    /// operation needs a new key).
    OperationAborted(ErrorCode),
    DeadlineExceeded,
    StorageUnavailable(String),
    /// A failure with a specific human explanation for the local owner's CLI
    /// (L-10). The wire carries only `code` with empty details.
    Explained(ErrorCode, String),
    Internal(String),
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl StoreError {
    /// Closed classification, by the caller's purpose: may this embedding
    /// error degrade to the lexical arm? Only at the query boundary, and only
    /// for the embedder's own rejections: a failed provider/model call
    /// (including a provider rate limit or an unloaded model, which reach the
    /// boundary as `EmbeddingFailed`), the call's own timeout, or the model
    /// rejecting the query as longer than its context. A document embedding
    /// (a build) never degrades: its errors fail or retry the attempt.
    pub fn degradable_for(&self, purpose: crate::qwen::Purpose) -> bool {
        matches!(purpose, crate::qwen::Purpose::Query)
            && matches!(
                self,
                StoreError::EmbeddingFailed
                    | StoreError::EmbeddingTimeout
                    | StoreError::OperationAborted(ErrorCode::EmbeddingInputTooLong)
            )
    }
    /// kb/1 wire code for this failure.
    pub fn protocol_code(&self) -> ErrorCode {
        match self {
            StoreError::RecoveryRequired(_) | StoreError::UnsafePath(_) => {
                ErrorCode::RepairRequired
            }
            StoreError::NotFound | StoreError::PathNotFound { .. } => ErrorCode::NotFound,
            StoreError::Forbidden => ErrorCode::Forbidden,
            StoreError::Conflict(_)
            | StoreError::StaleBase { .. }
            | StoreError::ProposalConflict(_)
            | StoreError::PathExists { .. }
            | StoreError::ConflictWith { .. } => ErrorCode::Conflict,
            StoreError::InvalidArgument(_) | StoreError::Invalid { .. } => {
                ErrorCode::InvalidArgument
            }
            StoreError::IndexUnavailable | StoreError::EmbeddingFailed => {
                ErrorCode::IndexUnavailable
            }
            StoreError::QuotaExceeded(_) => ErrorCode::QuotaExceeded,
            StoreError::RateLimited(_) => ErrorCode::RateLimited,
            StoreError::InvalidCursor => ErrorCode::InvalidCursor,
            StoreError::IdempotencyMismatch => ErrorCode::IdempotencyMismatch,
            StoreError::OperationAborted(code) | StoreError::Explained(code, _) => *code,
            StoreError::DeadlineExceeded
            | StoreError::EmbeddingTimeout
            | StoreError::WatchdogExpired => ErrorCode::DeadlineExceeded,
            StoreError::StorageUnavailable(_) | StoreError::Io(_) => ErrorCode::StorageUnavailable,
            // The file could not be reached, locked or written right now (a
            // root renamed away mid-open, a full disk): transient, never a
            // broken contract.
            StoreError::Sqlite(error) => match error.sqlite_error_code() {
                Some(
                    rusqlite::ErrorCode::DatabaseBusy
                    | rusqlite::ErrorCode::DatabaseLocked
                    | rusqlite::ErrorCode::CannotOpen
                    | rusqlite::ErrorCode::SystemIoFailure
                    | rusqlite::ErrorCode::DiskFull
                    | rusqlite::ErrorCode::FileLockingProtocolFailed,
                ) => ErrorCode::StorageUnavailable,
                _ => ErrorCode::Internal,
            },
            StoreError::LockNotHeld | StoreError::Internal(_) => ErrorCode::Internal,
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::RecoveryRequired(why) => write!(f, "local store needs recovery: {why}"),
            StoreError::UnsafePath(why) => write!(f, "unsafe path: {why}"),
            StoreError::LockNotHeld => f.write_str("write lock for this store is not held"),
            StoreError::NotFound => f.write_str("not found"),
            StoreError::PathNotFound { .. } => {
                f.write_str("not found: no document at that path in this revision")
            }
            StoreError::Forbidden => f.write_str("forbidden"),
            StoreError::Conflict(why) => write!(f, "conflict: {why}"),
            StoreError::StaleBase { .. } => {
                f.write_str("conflict: base revision is not the current head of the target")
            }
            StoreError::InvalidArgument(why) => write!(f, "invalid argument: {why}"),
            StoreError::Invalid { reason, why, .. } => {
                write!(f, "invalid argument ({reason}): {why}")
            }
            StoreError::PathExists { .. } => f.write_str("conflict: path already exists"),
            StoreError::ConflictWith { reason, why, .. } => write!(f, "conflict ({reason}): {why}"),
            StoreError::ProposalConflict(conflict) => write!(
                f,
                "conflict: the proposal conflicts with main; write each listed path in full \
                 against main with proposalNumber {}",
                conflict.proposal_number.unwrap_or_default()
            ),
            StoreError::IndexUnavailable => f.write_str("index unavailable"),
            StoreError::EmbeddingFailed => f.write_str("query embedding failed"),
            StoreError::EmbeddingTimeout => f.write_str("query embedding timed out"),
            StoreError::WatchdogExpired => f.write_str("index build made no progress"),
            StoreError::QuotaExceeded(what) => write!(f, "quota exceeded: {what}"),
            StoreError::RateLimited(secs) => write!(f, "rate limited; retry after {secs}s"),
            StoreError::InvalidCursor => f.write_str("invalid cursor"),
            StoreError::IdempotencyMismatch => {
                f.write_str("idempotency key was already used for a different request")
            }
            // OperationAborted carries both journal aborts and per-call
            // failures; only the former are pinned to their idempotency key.
            StoreError::OperationAborted(code) => match code {
                ErrorCode::Cancelled => f.write_str("operation cancelled"),
                ErrorCode::UnresolvedReference => f.write_str(
                    "sealed reference is unknown, revoked or not readable in this knowledge base",
                ),
                ErrorCode::EmbeddingInputTooLong => {
                    f.write_str("input is too long for the embedding model")
                }
                ErrorCode::SensitiveQuery => {
                    f.write_str("input contains a credential or sealed value and was refused")
                }
                _ => write!(
                    f,
                    "operation was aborted before publication ({}); retry with a new idempotency key",
                    code.as_str()
                ),
            },
            StoreError::DeadlineExceeded => f.write_str("local operation deadline exceeded"),
            StoreError::StorageUnavailable(why) => write!(f, "storage unavailable: {why}"),
            StoreError::Explained(_, why) => f.write_str(why),
            StoreError::Internal(why) => write!(f, "internal error: {why}"),
            StoreError::Io(error) => write!(f, "store i/o error: {error}"),
            StoreError::Sqlite(error) => write!(f, "store database error: {error}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl StoreError {
    /// `INVALID_ARGUMENT` with a reason; `field` is dropped unless it is
    /// a valid pointer.
    pub(crate) fn invalid(
        reason: kb_client::error::InvalidReason,
        field: Option<String>,
        why: impl Into<String>,
    ) -> Self {
        Self::invalid_bounded(reason, field, (None, None), why)
    }

    /// [`StoreError::invalid`] that also states the broken bounds.
    pub(crate) fn invalid_bounded(
        reason: kb_client::error::InvalidReason,
        field: Option<String>,
        (min, max): (Option<i64>, Option<i64>),
        why: impl Into<String>,
    ) -> Self {
        StoreError::Invalid {
            reason,
            field: field.and_then(kb_client::error::field_pointer),
            min,
            max,
            why: why.into(),
        }
    }

    /// `CONFLICT` with a closed reason; `field` is dropped unless it
    /// is a valid pointer.
    pub(crate) fn conflict_reason(
        reason: kb_client::error::ConflictReason,
        field: Option<&str>,
        why: impl Into<String>,
    ) -> Self {
        StoreError::ConflictWith {
            reason,
            field: field.and_then(kb_client::error::field_pointer),
            why: why.into(),
        }
    }

    /// The kb/1 `details` this failure carries on the wire.
    pub fn protocol_details(&self) -> serde_json::Value {
        use kb_client::error::{ConflictReason, ErrorDetails};
        match self {
            StoreError::StaleBase {
                head_sha,
                proposal_number,
            } => serde_json::json!({"headSha":head_sha,"proposalNumber":proposal_number}),
            StoreError::RateLimited(n) => serde_json::json!({"retryAfterSeconds":n}),
            StoreError::Invalid {
                reason,
                field,
                min,
                max,
                ..
            } => ErrorDetails::InvalidArgument {
                reason: *reason,
                field: field.clone(),
                min: *min,
                max: *max,
            }
            .to_value(),
            // Every INVALID_ARGUMENT says why, as on the server; a
            // refusal without a narrower reason is SCHEMA.
            StoreError::InvalidArgument(_) => ErrorDetails::InvalidArgument {
                reason: kb_client::error::InvalidReason::Schema,
                field: None,
                min: None,
                max: None,
            }
            .to_value(),
            StoreError::ProposalConflict(conflict) => {
                ErrorDetails::ProposalConflict(conflict.clone()).to_value()
            }
            StoreError::PathExists { field } => ErrorDetails::ConflictReason {
                reason: ConflictReason::PathExists,
                field: field.clone(),
            }
            .to_value(),
            StoreError::PathNotFound { field } => ErrorDetails::NotFoundReason {
                reason: kb_client::error::NotFoundReason::PathNotFound,
                field: field.clone(),
            }
            .to_value(),
            StoreError::ConflictWith { reason, field, .. } => ErrorDetails::ConflictReason {
                reason: *reason,
                field: field.clone(),
            }
            .to_value(),
            _ => serde_json::json!({}),
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Sqlite(error)
    }
}

pub(crate) fn constraint_to_conflict(error: rusqlite::Error, what: &str) -> StoreError {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::ConstraintViolation) => StoreError::Conflict(what.to_owned()),
        _ => StoreError::Sqlite(error),
    }
}

/// Lifecycle state of a registered KB.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KbState {
    Creating,
    Active,
    Tombstoned,
    RepairRequired,
}

impl KbState {
    pub(crate) fn parse(value: &str) -> Result<KbState, StoreError> {
        Ok(match value {
            "CREATING" => KbState::Creating,
            "ACTIVE" => KbState::Active,
            "TOMBSTONED" => KbState::Tombstoned,
            "REPAIR_REQUIRED" => KbState::RepairRequired,
            _ => return Err(StoreError::RecoveryRequired("unknown kb state".into())),
        })
    }
}

/// A CONFIG principal and its per-KB access (`kb principals list`).
pub type ConfigPrincipal = (String, Vec<(KbId, Vec<Permission>)>);

/// Input for [`Store::reserve_kb`].
#[derive(Clone, Debug)]
pub struct NewKb {
    pub name: String,
    pub slug: String,
    pub description: String,
}

/// A registry row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KbRecord {
    pub id: KbId,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub state: KbState,
    pub head_sha: Option<String>,
    pub metadata_version: i64,
    /// Desired-index epoch; every finalized publication advances it once.
    pub desired_epoch: i64,
    pub active_generation_id: Option<KbId>,
    /// The active index file was lost; the next build replaces it.
    pub index_rebuild_required: bool,
}

/// Canonical local attachment locator and sealed namespace for a KB.
pub fn local_attachment(store: &Uuid, kb: &KbId) -> (String, Uuid) {
    (
        local_attachment_locator(store, kb),
        local_attachment_namespace(store, kb),
    )
}

/// An open managed store. Reads need no lock; every mutation takes a
/// [`WriteGuard`] from this store.
#[derive(Debug)]
pub struct Store {
    pub(crate) paths: StorePaths,
    pub(crate) conn: Connection,
    store_uuid: Uuid,
    pub(crate) owner: LocalPrincipal,
    pub(crate) cursor_key: CursorKey,
    pub(crate) limits: Cell<LocalLimits>,
    pub(crate) disk_meter: Cell<crate::limits::DiskMeter>,
    /// Quantization frozen into new generation snapshots. Always
    /// binary_int8_rescore outside tests (no CLI setter).
    pub(crate) index_quantization: Cell<crate::index_format::IndexQuantization>,
    pub(crate) response_limit: Cell<usize>,
    pub(crate) pending_index_recovery: Cell<bool>,
    /// Explicitly frozen test clock (seconds) for cursor expiry.
    clock_for_tests: Cell<Option<u64>>,
    /// Review r2 #4: the per-user model cache, so effective availability
    /// sees whether the built-in's file is actually there.
    model_cache: std::cell::RefCell<Option<crate::model_download::ModelCache>>,
    // Owns shutdown/join; expiry never outlives this handle.
    _upload_timer: crate::uploads::UploadTimer,
}

// ── Open / initialize ───────────────────────────────────────────────────────

fn io_err(error: io::Error) -> StoreError {
    StoreError::Io(error)
}

fn is_init_scratch(name: &str) -> bool {
    ["", "-journal", "-wal", "-shm"]
        .iter()
        .any(|suffix| name == format!("{STATE_INIT_FILE}{suffix}"))
}

/// Entries that make a directory "nonempty" for initialization purposes:
/// anything except the lock directory and our own init scratch files.
fn has_foreign_entries(root: &Path) -> Result<bool, StoreError> {
    for entry in std::fs::read_dir(root).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "locks" {
            let meta = entry.metadata().map_err(io_err)?;
            if is_link(&std::fs::symlink_metadata(entry.path()).map_err(io_err)?) || !meta.is_dir()
            {
                return Err(StoreError::UnsafePath(
                    "invalid initialization locks directory".into(),
                ));
            }
            for lock in std::fs::read_dir(entry.path()).map_err(io_err)? {
                let lock = lock.map_err(io_err)?;
                if lock.file_name() != "store.lock" {
                    return Ok(true);
                }
                let meta = std::fs::symlink_metadata(lock.path()).map_err(io_err)?;
                if is_link(&meta) || !meta.is_file() || meta.len() != 0 {
                    return Err(StoreError::UnsafePath("invalid initialization lock".into()));
                }
                check_init_file(&lock.path(), root)?;
            }
            continue;
        }
        if is_init_scratch(&name) {
            // A concurrent initializer renames/removes its own scratch family
            // while we scan: an entry that vanished is not a foreign entry.
            let meta = match std::fs::symlink_metadata(entry.path()) {
                Ok(meta) => meta,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(io_err(error)),
            };
            if is_link(&meta) || !meta.is_file() {
                return Err(StoreError::UnsafePath(
                    "invalid initialization scratch".into(),
                ));
            }
            match check_init_file(&entry.path(), root) {
                Err(StoreError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
                other => other?,
            }
            continue;
        }
        return Ok(true);
    }
    Ok(false)
}

fn check_init_file(path: &Path, root: &Path) -> Result<(), StoreError> {
    let file = open_no_follow(path, OpenOptions::new().read(true))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = file.metadata().map_err(io_err)?;
        let owner = std::fs::metadata(root).map_err(io_err)?.uid();
        if meta.uid() != owner || meta.permissions().mode() & 0o077 != 0 {
            return Err(StoreError::UnsafePath(
                "initialization scratch is not owner-only".into(),
            ));
        }
    }
    #[cfg(windows)]
    {
        let _ = (file, root);
    }
    Ok(())
}

/// `Some(true)` = regular state file present, `Some(false)` = absent.
pub(crate) fn state_present(paths: &StorePaths) -> Result<bool, StoreError> {
    match std::fs::symlink_metadata(paths.state_db()) {
        Ok(meta) if is_link(&meta) || !meta.is_file() => Err(StoreError::UnsafePath(
            "`state.sqlite` is not a regular file".into(),
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_err(error)),
    }
}

fn prepare_root(
    root: &Path,
    observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
) -> Result<PathBuf, StoreError> {
    match std::fs::symlink_metadata(root) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = root
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            prepare_root(parent, observer)?;
            match crate::paths::create_private_dir(root) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(io_err(error)),
            }
            crate::paths::sync_dir_observed(parent, observer)?;
        }
        Err(error) => return Err(io_err(error)),
    }
    // The root itself may sit under a symlinked parent (e.g. macOS /var);
    // it is resolved once here and everything below is no-follow.
    let canonical = root.canonicalize().map_err(io_err)?;
    let meta = std::fs::metadata(&canonical).map_err(io_err)?;
    if !meta.is_dir() {
        return Err(StoreError::UnsafePath(
            "store root is not a directory".into(),
        ));
    }
    Ok(canonical)
}

#[cfg(unix)]
fn make_root_private(root: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).map_err(io_err)
}

#[cfg(unix)]
fn check_root_private(root: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(root)
        .map_err(io_err)?
        .permissions()
        .mode();
    if mode & 0o077 != 0 {
        return Err(StoreError::UnsafePath(
            "store root is accessible by other users".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn make_root_private(root: &Path) -> Result<(), StoreError> {
    crate::win::make_private(root).map_err(io_err)
}

#[cfg(windows)]
fn check_root_private(root: &Path) -> Result<(), StoreError> {
    drop(crate::paths::open_directory(root)?); // refuses a reparse root
    if !crate::win::check_private(root).map_err(io_err)? {
        return Err(StoreError::UnsafePath(
            "store root is accessible by other users".into(),
        ));
    }
    Ok(())
}

/// Initialization stages for bounded crash/fault tests.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenStage {
    SyncState,
    BeforePublish,
    SyncDirectory(PathBuf),
}

fn sync_initialized_file(
    path: &Path,
    observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    let file = open_no_follow(path, OpenOptions::new().read(true).write(true))?;
    observer(OpenStage::SyncState)?;
    file.sync_all().map_err(io_err)
}

/// Before first publication, include existing ancestors left by an
/// interrupted creator. Published state certifies this fence completed; later
/// opens need not repeat syncs of unchanged directories through `/`. These
/// directories are outside the store and its lock protects none of them, so
/// the fence runs before admission: a flush of `/` on a busy host filesystem
/// must not consume concurrent openers' bounded store-lock wait.
fn sync_ancestors(
    root: &Path,
    observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    let mut directory = root;
    while let Some(parent) = directory.parent() {
        crate::paths::sync_dir_observed(parent, observer)?;
        directory = parent;
    }
    Ok(())
}

/// Runs under the exclusive store lock after this process's
/// [`sync_ancestors`]. Publishes identity by rename only.
fn initialize_locked(
    paths: &StorePaths,
    observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    if state_present(paths)? {
        return Ok(()); // Another process initialized first.
    }
    let root = paths.root();
    if has_foreign_entries(root)? {
        return Err(not_a_store(root));
    }
    make_root_private(root)?;
    // The caller flushed every ancestor before taking the lock.
    // Unpublished scratch from a crashed initializer: identity was never
    // visible, so it is safe to discard under the lock.
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let path = root.join(format!("{STATE_INIT_FILE}{suffix}"));
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_err(error)),
        }
    }
    let scratch = root.join(STATE_INIT_FILE);
    drop(open_no_follow(
        &scratch,
        OpenOptions::new().read(true).write(true).create_new(true),
    )?);
    state::initialize(&scratch, &new_uuid_v4()?, &new_uuid_v4()?)?;
    sync_initialized_file(&scratch, observer)?;
    observer(OpenStage::BeforePublish)?;
    std::fs::rename(&scratch, paths.state_db()).map_err(io_err)?;
    sync_dir(root)?;
    Ok(())
}

/// A nonempty directory without `state.sqlite` is never adopted (L-17): it is
/// usually a mistyped `--root`, rarely a store that lost its registry.
fn not_a_store(root: &Path) -> StoreError {
    StoreError::Explained(
        ErrorCode::RepairRequired,
        format!(
            "`{}` is not a kb store: it is not empty and has no `state.sqlite`; use an empty or new directory to create a store (if this was a store, restore `state.sqlite` from a backup)",
            root.display()
        ),
    )
}

impl Store {
    /// Open an existing managed store; never create one (read-only CLI
    /// commands, L-17).
    pub fn open_existing(root: &Path) -> Result<Store, StoreError> {
        match std::fs::symlink_metadata(root) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(StoreError::Explained(
                    ErrorCode::NotFound,
                    format!("no kb store at `{}`", root.display()),
                ));
            }
            Err(error) => return Err(io_err(error)),
        }
        let canonical = root.canonicalize().map_err(io_err)?;
        if !std::fs::metadata(&canonical).map_err(io_err)?.is_dir() {
            return Err(StoreError::Explained(
                ErrorCode::NotFound,
                format!("`{}` is not a kb store directory", root.display()),
            ));
        }
        let paths = StorePaths::new(canonical)?;
        if !state_present(&paths)? {
            return Err(if has_foreign_entries(paths.root())? {
                not_a_store(root)
            } else {
                StoreError::Explained(
                    ErrorCode::NotFound,
                    format!(
                        "no kb store at `{}` (the directory is empty)",
                        root.display()
                    ),
                )
            });
        }
        Self::open_existing_paths(paths, None, &mut |_| Ok(()))
    }

    /// Open (or initialize, if `root` is empty or absent) a managed store.
    pub fn open(root: &Path) -> Result<Store, StoreError> {
        Self::open_observed(root, &mut |_| Ok(()))
    }

    /// Initialization I/O/crash seam for trusted host tests.
    #[doc(hidden)]
    pub fn open_observed(
        root: &Path,
        observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
    ) -> Result<Store, StoreError> {
        let root = prepare_root(root, observer)?;
        let paths = StorePaths::new(root)?;
        if !state_present(&paths)? {
            // Fail closed before creating anything in a foreign directory.
            // A concurrent initializer publishes `state.sqlite` (atomic
            // rename) BEFORE creating any other entry, so foreign entries
            // with state now present are that initializer's, not foreign.
            if has_foreign_entries(paths.root())? && !state_present(&paths)? {
                return Err(not_a_store(paths.root()));
            }
            make_root_private(paths.root())?;
            crate::paths::ensure_dir_observed(paths.root(), &["locks"], false, observer)?;
            sync_ancestors(paths.root(), observer)?;
            let lock = locks::store_lock(&paths, true)?
                .ok_or_else(|| StoreError::Internal("blocking lock returned early".into()))?;
            initialize_locked(&paths, observer)?;
            drop(lock);
        }
        Self::open_existing_paths(paths, None, observer)
    }

    /// The Git version a served local store needs (see `pr_merge`): checked
    /// once when `kb mcp` starts, like the server's startup probe.
    pub fn check_git(&self) -> Result<(), StoreError> {
        crate::pr_merge::require_git(&self.paths)
    }

    /// Reopen only the launched directory and durable identity. Never initialize
    /// a missing root/registry, and validate before recovery or timer side effects.
    pub fn reopen(paths: &StorePaths, store_uuid: &Uuid) -> Result<Store, StoreError> {
        Self::open_existing_paths(paths.clone(), Some(store_uuid), &mut |_| Ok(()))
    }

    /// Transport cancellation/deadline also cover recovery during reopening.
    pub fn reopen_controlled(
        paths: &StorePaths,
        store_uuid: &Uuid,
        control: kb_client::stdio::CallControl,
    ) -> Result<Store, StoreError> {
        let _scope = crate::git_read::OperationDeadline::transport(control);
        Self::reopen(paths, store_uuid)
    }

    fn open_existing_paths(
        paths: StorePaths,
        expected: Option<&Uuid>,
        observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
    ) -> Result<Store, StoreError> {
        paths.check_identity().map_err(|e| match e {
            StoreError::Io(e) if e.kind() == io::ErrorKind::NotFound => {
                StoreError::RecoveryRequired("launched store root is missing".into())
            }
            e => e,
        })?;
        if !state_present(&paths)? {
            return Err(StoreError::RecoveryRequired(
                "`state.sqlite` is missing".into(),
            ));
        }
        check_root_private(paths.root())?;
        #[cfg(windows)]
        if !crate::win::check_private(&paths.state_db()).map_err(io_err)? {
            return Err(StoreError::UnsafePath(
                "state file is accessible by other users".into(),
            ));
        }
        drop(open_no_follow(
            &paths.state_db(),
            OpenOptions::new().read(true),
        )?);
        let conn = state::open_existing_bound(&paths.state_db(), expected)?;
        let meta: Option<(String, String, Vec<u8>)> = conn
            .query_row(
                "SELECT store_uuid, owner_principal_id, cursor_key FROM store_meta WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((store_uuid, owner_id, cursor_key)) = meta else {
            return Err(StoreError::RecoveryRequired(
                "store identity row missing".into(),
            ));
        };
        let store_uuid = Uuid::parse(&store_uuid)
            .map_err(|_| StoreError::RecoveryRequired("store identity is malformed".into()))?;
        if expected.is_some_and(|expected| expected != &store_uuid) {
            return Err(StoreError::RecoveryRequired(
                "launched store identity changed".into(),
            ));
        }
        paths.check_identity()?;
        paths.ensure_managed_dirs(observer)?;
        paths.tighten_repos()?;
        let upload_timer = crate::uploads::UploadTimer::start(paths.clone())?;
        let store = Store {
            paths,
            conn,
            store_uuid,
            owner: LocalPrincipal::new(owner_id, PrincipalKind::Owner),
            cursor_key: CursorKey::from_slice(&cursor_key)?,
            limits: Cell::new(LocalLimits::default()),
            disk_meter: Cell::new(crate::limits::available_disk),
            index_quantization: Cell::new(
                crate::index_format::IndexQuantization::BinaryInt8Rescore,
            ),
            response_limit: Cell::new(crate::limits::RESPONSE_MAX_BYTES),
            pending_index_recovery: Cell::new(true),
            clock_for_tests: Cell::new(None),
            model_cache: std::cell::RefCell::new(None),
            _upload_timer: upload_timer,
        };
        if let Some(_config) = locks::try_named_model_lock(&store.paths, "model-config.lock")? {
            store.recover_model_probe_locked()?;
        }
        // Reconcile derived-index loss and resolve interrupted publications
        // now if no writer is active (a read-only restart must not wait for
        // a later write); otherwise the live writer, the next writer or a
        // gated read does it under the lock. An unrelated spawn holding the
        // shared registry must not silently suppress startup recovery.
        if let Some(guard) = locks::acquire_for_open(&store.paths)? {
            store.reconcile_indexes()?;
            store.recover(&guard)?;
            store.recover_completed_indexes(&guard)?;
            store.pending_index_recovery.set(false);
            drop(guard);
        }
        Ok(store)
    }

    pub fn paths(&self) -> &StorePaths {
        &self.paths
    }

    /// Stable store identity (never regenerated).
    pub fn store_uuid(&self) -> &Uuid {
        &self.store_uuid
    }

    /// Long-lived hosts check both the directory handle and current registry;
    /// reading an old SQLite connection alone cannot detect pathname replacement.
    pub fn verify_identity(&self) -> Result<(), StoreError> {
        self.paths.check_identity().map_err(|e| match e {
            StoreError::Io(e) if e.kind() == io::ErrorKind::NotFound => {
                StoreError::RecoveryRequired("launched store root is missing".into())
            }
            e => e,
        })?;
        if !state_present(&self.paths)? {
            return Err(StoreError::RecoveryRequired(
                "`state.sqlite` is missing".into(),
            ));
        }
        self.paths.check_no_follow(&self.paths.state_db())?;
        drop(state::open_existing_bound(
            &self.paths.state_db(),
            Some(&self.store_uuid),
        )?);
        Ok(())
    }

    /// The opaque local owner principal.
    pub fn owner(&self) -> LocalPrincipal {
        self.owner.clone()
    }

    /// Look up a registered principal by its opaque ID: the owner, or a
    /// CONFIG/TEST principal with a ceiling or create capability row.
    /// Unknown IDs are NOT_FOUND. Grants nothing by itself: every operation
    /// still authorizes against the live ceilings.
    pub fn principal(&self, id: &str) -> Result<LocalPrincipal, StoreError> {
        if id == self.owner.id() {
            return Ok(self.owner.clone());
        }
        let kind: Option<String> = self
            .conn
            .query_row(
                "SELECT kind FROM principal_ceilings WHERE principal_id = ?1 \
                 UNION ALL SELECT kind FROM create_capabilities WHERE principal_id = ?1 LIMIT 1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        match kind.as_deref() {
            Some("CONFIG") => Ok(LocalPrincipal::new(id.to_owned(), PrincipalKind::Config)),
            Some("TEST") => Ok(LocalPrincipal::new(id.to_owned(), PrincipalKind::Test)),
            _ => Err(StoreError::NotFound),
        }
    }

    /// Opt this handle into lower limits (see [`LocalLimits::lowered`]).
    pub fn set_limits(&self, limits: LocalLimits) {
        self.limits.set(limits);
    }

    /// Trusted host disk fault seam, never a serialized tool input.
    #[doc(hidden)]
    pub fn set_disk_meter_for_tests(&self, meter: crate::limits::DiskMeter) {
        self.disk_meter.set(meter);
    }

    /// Test seam for the shared format's other variants; never a tool input.
    #[doc(hidden)]
    pub fn set_index_quantization_for_tests(&self, q: crate::index_format::IndexQuantization) {
        self.index_quantization.set(q);
    }

    /// Lower the encoded response cap at the actual service boundary.
    #[doc(hidden)]
    pub fn set_response_limit_for_tests(&self, max: usize) -> Result<(), StoreError> {
        if !(1..=crate::limits::RESPONSE_MAX_BYTES).contains(&max) {
            return Err(StoreError::InvalidArgument(
                "response limit may only be lowered".into(),
            ));
        }
        self.response_limit.set(max);
        Ok(())
    }

    /// Wall clock in milliseconds, unless a test explicitly freezes this handle.
    pub(crate) fn now_ms(&self) -> u64 {
        self.clock_for_tests.get().unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        })
    }

    /// The per-user model cache this store's built-in reads (the host's);
    /// without it a built-in is never available (fail closed).
    pub fn attach_model_cache(&self, cache: crate::model_download::ModelCache) {
        *self.model_cache.borrow_mut() = Some(cache);
    }
    /// Whether the built-in `model_id`'s file is in the cache now: a cheap
    /// stat of the file a load would use (size and identity, no hash).
    pub(crate) fn builtin_present(&self, model_id: &str) -> Result<bool, StoreError> {
        let cache = self.model_cache.borrow();
        let Some(cache) = cache.as_ref() else {
            return Ok(false);
        };
        Ok(cache.resolve(&crate::qwen::descriptor(model_id)?).is_ok())
    }

    /// Forget this store's query-embedding breakers (R3-L4; tests only).
    #[doc(hidden)]
    pub fn reset_query_breakers_for_tests(&self) {
        crate::breaker::forget(&format!("{}|", self.store_uuid()));
    }

    /// Freeze this handle's cursor clock on first use, then advance it by `secs`.
    /// Passing zero freezes wall time without advancing it (tests only).
    #[doc(hidden)]
    pub fn advance_clock_for_tests(&self, secs: i64) {
        let now = self.now_ms();
        let delta = secs.unsigned_abs().saturating_mul(1000);
        self.clock_for_tests.set(Some(if secs >= 0 {
            now.saturating_add(delta)
        } else {
            now.saturating_sub(delta)
        }));
    }

    /// Set this handle's cursor clock to an absolute time (tests only).
    /// It stays fixed until explicitly changed and does not survive reopen.
    #[doc(hidden)]
    pub fn set_cursor_clock_for_tests(&self, secs: u64) {
        self.clock_for_tests.set(Some(secs.saturating_mul(1000)));
    }

    pub fn connection_settings(&self) -> Result<ConnectionSettings, StoreError> {
        state::settings(&self.conn)
    }

    /// Locator and sealed namespace of `kb` in this store.
    pub fn attachment(&self, kb: &KbId) -> (String, Uuid) {
        local_attachment(&self.store_uuid, kb)
    }

    // ── Locks ───────────────────────────────────────────────────────────────

    /// Wait at most five seconds for the store and sorted KB locks.
    pub fn lock_write(&self, kbs: &[KbId]) -> Result<WriteGuard, StoreError> {
        let guard = locks::acquire(&self.paths, kbs, true)?
            .ok_or_else(|| StoreError::Internal("blocking lock returned early".into()))?;
        self.reconcile_indexes()?;
        self.recover(&guard)?;
        self.recover_completed_indexes(&guard)?;
        self.pending_index_recovery.set(false);
        Ok(guard)
    }

    /// Non-blocking [`Store::lock_write`]; `None` if a lock or the shared
    /// spawn/admission registry is busy.
    pub fn try_lock_write(&self, kbs: &[KbId]) -> Result<Option<WriteGuard>, StoreError> {
        let Some(guard) = locks::acquire(&self.paths, kbs, false)? else {
            return Ok(None);
        };
        self.reconcile_indexes()?;
        self.recover(&guard)?;
        self.recover_completed_indexes(&guard)?;
        self.pending_index_recovery.set(false);
        Ok(Some(guard))
    }

    pub(crate) fn check_guard(&self, guard: &WriteGuard) -> Result<(), StoreError> {
        if guard.matches(&self.paths)? {
            Ok(())
        } else {
            Err(StoreError::LockNotHeld)
        }
    }

    // ── Registry ────────────────────────────────────────────────────────────

    /// Reserve a new KB: registry row (state CREATING) plus its exclusively
    /// created repository directory, committed together under the store lock.
    pub fn reserve_kb(&self, guard: &WriteGuard, new: NewKb) -> Result<KbRecord, StoreError> {
        self.reserve_kb_observed(guard, new, &mut || {})
    }

    /// [`Store::reserve_kb`] with an observer called after all effects are
    /// staged and immediately before COMMIT (crash-test seam).
    #[doc(hidden)]
    pub fn reserve_kb_observed(
        &self,
        guard: &WriteGuard,
        new: NewKb,
        before_commit: &mut dyn FnMut(),
    ) -> Result<KbRecord, StoreError> {
        self.check_guard(guard)?;
        validate_new_kb(&new)?;
        let id = new_id()?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO kbs (id, name, slug, description, state, created_at) \
             VALUES (?1, ?2, ?3, ?4, 'CREATING', ?5)",
            (
                id.as_str(),
                &new.name,
                &new.slug,
                &new.description,
                now_utc(),
            ),
        )
        .map_err(|e| constraint_to_conflict(e, "slug already in use"))?;
        let repo = self.paths.repo_dir(&id);
        create_dir_exclusive(&self.paths, &repo)?;
        before_commit();
        if let Err(error) = tx.commit() {
            // Leave no orphan for a row that never committed.
            let _ = std::fs::remove_dir(&repo);
            return Err(error.into());
        }
        sync_dir(&self.paths.root().join("repos"))?;
        self.kb(&id)?
            .ok_or_else(|| StoreError::Internal("reserved kb vanished".into()))
    }

    pub fn kb(&self, id: &KbId) -> Result<Option<KbRecord>, StoreError> {
        self.paths.check_identity()?;
        self.conn
            .query_row(&format!("{SELECT_KB} WHERE id = ?1"), [id.as_str()], raw_kb)
            .optional()?
            .map(RawKb::into_record)
            .transpose()
    }

    /// Live (ACTIVE or REPAIR_REQUIRED) KBs with ID after `after`, ordered
    /// by ID. Bounded: live KBs are capped by the store quota.
    pub(crate) fn live_kbs_after(&self, after: Option<&str>) -> Result<Vec<KbRecord>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT_KB} WHERE state IN ('ACTIVE', 'REPAIR_REQUIRED') \
             AND (?1 IS NULL OR id > ?1) ORDER BY id LIMIT 1024"
        ))?;
        let rows = stmt.query_map([after], raw_kb)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?.into_record()?);
        }
        Ok(out)
    }

    /// Up to `limit` readable (ACTIVE, with a head) KB IDs in ID order,
    /// filtered in SQL so retained history never displaces them.
    pub fn active_kb_ids(&self, limit: usize) -> Result<Vec<KbId>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM kbs WHERE state='ACTIVE' AND head_sha IS NOT NULL ORDER BY id LIMIT ?1",
        )?;
        let rows = stmt.query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|r| {
            KbId::parse(&r?).map_err(|_| StoreError::RecoveryRequired("malformed kb id".into()))
        })
        .collect()
    }

    /// The first 1024 registered KBs of any state, ordered by ID (tests and
    /// diagnostics; never use it to find live KBs).
    pub fn list_kbs(&self) -> Result<Vec<KbRecord>, StoreError> {
        self.paths.check_identity()?;
        let mut stmt = self
            .conn
            .prepare(&format!("{SELECT_KB} ORDER BY id LIMIT 1024"))?;
        let rows = stmt.query_map([], raw_kb)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?.into_record()?);
        }
        Ok(out)
    }

    // ── Authority ───────────────────────────────────────────────────────────

    /// Register a capability-narrowed CONFIG/TEST principal on `kb`. Its
    /// effective bits never exceed the expanded `permissions` ceiling.
    pub fn register_principal(
        &self,
        guard: &WriteGuard,
        kind: PrincipalKind,
        kb: &KbId,
        permissions: &[Permission],
    ) -> Result<LocalPrincipal, StoreError> {
        self.check_guard(guard)?;
        let Some(kind_db) = kind.as_db() else {
            return Err(StoreError::InvalidArgument(
                "the owner principal is unique".into(),
            ));
        };
        if self.kb(kb)?.is_none() {
            return Err(StoreError::NotFound);
        }
        let id = new_uuid_v4()?;
        self.conn.execute(
            "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) VALUES (?1, ?2, ?3, ?4)",
            (
                id.as_str(),
                kind_db,
                kb.as_str(),
                Bits::from_permissions(permissions).raw(),
            ),
        )?;
        Ok(LocalPrincipal::new(id.as_str().to_owned(), kind))
    }

    /// L-23: an owner-created CONFIG principal holding `access` (and the
    /// access it implies) on each of `kbs`, for `kb mcp --principal <id>`.
    /// A propose-only principal's writes become pull requests on the KB.
    pub fn create_config_principal(
        &self,
        who: &LocalPrincipal,
        kbs: &[KbId],
        access: Permission,
    ) -> Result<LocalPrincipal, StoreError> {
        if who != &self.owner {
            return Err(StoreError::Forbidden);
        }
        let mut kbs = kbs.to_vec();
        kbs.sort();
        kbs.dedup();
        if kbs.is_empty() || kbs.len() > crate::limits::OWNED_LIVE_KBS_PER_USER as usize {
            return Err(StoreError::InvalidArgument(
                "name between one and twenty knowledge bases".into(),
            ));
        }
        let guard = self.lock_write(&kbs)?;
        for kb in &kbs {
            match self.kb(kb)? {
                Some(record) if record.state == KbState::Active => {}
                _ => {
                    return Err(StoreError::Explained(
                        ErrorCode::NotFound,
                        format!("`{kb}` is not a live knowledge base"),
                    ));
                }
            }
        }
        let bits = Bits::from_permissions(&[access]).expand();
        let id = new_uuid_v4()?;
        let tx = self.conn.unchecked_transaction()?;
        for kb in &kbs {
            tx.execute(
                "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) VALUES (?1, 'CONFIG', ?2, ?3)",
                (id.as_str(), kb.as_str(), bits.raw()),
            )?;
        }
        tx.commit()?;
        drop(guard);
        Ok(LocalPrincipal::new(
            id.as_str().to_owned(),
            PrincipalKind::Config,
        ))
    }

    /// One bounded page of CONFIG principals after `after` (by ID), each
    /// with its per-KB access.
    pub fn config_principals(
        &self,
        who: &LocalPrincipal,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ConfigPrincipal>, StoreError> {
        if who != &self.owner {
            return Err(StoreError::Forbidden);
        }
        let limit = i64::try_from(limit.clamp(1, 100)).unwrap_or(100);
        let mut ids = self.conn.prepare(
            "SELECT DISTINCT principal_id FROM principal_ceilings WHERE kind='CONFIG' AND (?1 IS NULL OR principal_id > ?1) ORDER BY principal_id LIMIT ?2",
        )?;
        let ids = ids
            .query_map((after, limit), |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut rows = self.conn.prepare(
            "SELECT kb_id, bits FROM principal_ceilings WHERE principal_id = ?1 AND kind='CONFIG' ORDER BY kb_id LIMIT 1024",
        )?;
        let mut out = Vec::new();
        for id in ids {
            let grants = rows
                .query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .map(|r| {
                    let (kb, bits) = r?;
                    Ok((
                        KbId::parse(&kb)
                            .map_err(|_| StoreError::RecoveryRequired("malformed kb id".into()))?,
                        Bits::from_raw(bits).permissions(),
                    ))
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            out.push((id, grants));
        }
        Ok(out)
    }

    /// Revoke a CONFIG principal everywhere (its sessions lose access on
    /// their next call). `Ok(false)` if it did not exist.
    pub fn remove_config_principal(
        &self,
        who: &LocalPrincipal,
        id: &str,
    ) -> Result<bool, StoreError> {
        if who != &self.owner {
            return Err(StoreError::Forbidden);
        }
        let _guard = self.lock_write(&[])?;
        let tx = self.conn.unchecked_transaction()?;
        let n = tx.execute(
            "DELETE FROM principal_ceilings WHERE principal_id = ?1 AND kind='CONFIG'",
            [id],
        )? + tx.execute(
            "DELETE FROM create_capabilities WHERE principal_id = ?1 AND kind='CONFIG'",
            [id],
        )?;
        tx.commit()?;
        Ok(n > 0)
    }

    /// Effective bits of `principal` on `kb` for an operation needing
    /// `required`: expanded ceiling ∩ expanded live bits (the local owner
    /// holds every bit). Unknown/tombstoned/unreadable KB → NOT_FOUND;
    /// readable but insufficient → FORBIDDEN.
    pub fn authorize(
        &self,
        principal: &LocalPrincipal,
        kb: &KbId,
        required: Permission,
    ) -> Result<Bits, StoreError> {
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        if record.state == KbState::Tombstoned {
            return Err(StoreError::NotFound);
        }
        let live = Bits::ALL;
        let ceiling = match principal.kind().as_db() {
            None if principal.id() == self.owner.id() => Bits::ALL,
            None => return Err(StoreError::NotFound),
            Some(kind) => self
                .conn
                .query_row(
                    "SELECT bits FROM principal_ceilings \
                     WHERE principal_id = ?1 AND kb_id = ?2 AND kind = ?3",
                    (principal.id(), kb.as_str(), kind),
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .map_or(Bits::NONE, Bits::from_raw),
        };
        let effective = ceiling.intersect(live);
        if !effective.contains(Permission::Read) {
            return Err(StoreError::NotFound);
        }
        if !effective.contains(required) {
            return Err(StoreError::Forbidden);
        }
        Ok(effective)
    }
}

fn validate_new_kb(new: &NewKb) -> Result<(), StoreError> {
    let name = new.name.chars().count();
    if !(1..=120).contains(&name) {
        return Err(StoreError::InvalidArgument("name".into()));
    }
    if Slug::parse(&new.slug).is_err() {
        return Err(StoreError::InvalidArgument("slug".into()));
    }
    let description = new.description.chars().count();
    if !(10..=2000).contains(&description) {
        return Err(StoreError::InvalidArgument("description".into()));
    }
    Ok(())
}

pub(crate) const SELECT_KB: &str = "SELECT id, name, slug, description, state, head_sha, \
     metadata_version, active_generation_id, index_rebuild_required, desired_epoch FROM kbs";

struct RawKb {
    id: String,
    name: String,
    slug: String,
    description: String,
    state: String,
    head_sha: Option<String>,
    metadata_version: i64,
    active_generation_id: Option<String>,
    index_rebuild_required: i64,
    desired_epoch: i64,
}

fn raw_kb(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawKb> {
    Ok(RawKb {
        id: row.get(0)?,
        name: row.get(1)?,
        slug: row.get(2)?,
        description: row.get(3)?,
        state: row.get(4)?,
        head_sha: row.get(5)?,
        metadata_version: row.get(6)?,
        active_generation_id: row.get(7)?,
        index_rebuild_required: row.get(8)?,
        desired_epoch: row.get(9)?,
    })
}

impl RawKb {
    fn into_record(self) -> Result<KbRecord, StoreError> {
        let malformed = || StoreError::RecoveryRequired("malformed kb registry row".into());
        Ok(KbRecord {
            id: KbId::parse(&self.id).map_err(|_| malformed())?,
            name: self.name,
            slug: self.slug,
            description: self.description,
            state: KbState::parse(&self.state)?,
            head_sha: self.head_sha,
            metadata_version: self.metadata_version,
            desired_epoch: self.desired_epoch,
            active_generation_id: self
                .active_generation_id
                .map(|g| KbId::parse(&g).map_err(|_| malformed()))
                .transpose()?,
            index_rebuild_required: self.index_rebuild_required != 0,
        })
    }
}

#[cfg(test)]
mod reason_tests {
    use super::*;

    /// Every INVALID_ARGUMENT kb-local reports says why (NOT_FOUND has
    /// no reason codes in kb/1; its details stay empty).
    #[test]
    fn every_invalid_argument_carries_a_reason() {
        for error in [
            StoreError::InvalidArgument("anything".into()),
            StoreError::invalid(
                kb_client::error::InvalidReason::PathNotFound,
                Some("/changes/0/path".into()),
                "missing",
            ),
        ] {
            assert_eq!(error.protocol_code(), ErrorCode::InvalidArgument);
            let details = error.protocol_details();
            assert!(
                details.get("reason").and_then(|r| r.as_str()).is_some(),
                "{details}"
            );
            assert!(
                kb_client::error::ToolError::from_value(&serde_json::json!({
                    "code": "INVALID_ARGUMENT",
                    "message": "Invalid argument",
                    "retryable": false,
                    "details": details,
                }))
                .is_ok()
            );
        }
        assert_eq!(
            StoreError::NotFound.protocol_details(),
            serde_json::json!({})
        );
    }

    /// A SQLite failure to reach, lock or write the file is transient
    /// (`STORAGE_UNAVAILABLE`, which the index builders wait out); only a
    /// failure of the query itself is a broken contract.
    #[test]
    fn sqlite_storage_failures_are_transient_and_query_failures_internal() {
        use rusqlite::ffi;
        let sqlite =
            |code| StoreError::Sqlite(rusqlite::Error::SqliteFailure(ffi::Error::new(code), None));
        for code in [
            ffi::SQLITE_BUSY,
            ffi::SQLITE_LOCKED,
            ffi::SQLITE_CANTOPEN,
            ffi::SQLITE_IOERR,
            ffi::SQLITE_IOERR_SHORT_READ,
            ffi::SQLITE_FULL,
            ffi::SQLITE_PROTOCOL,
        ] {
            assert_eq!(
                sqlite(code).protocol_code(),
                ErrorCode::StorageUnavailable,
                "{code}"
            );
        }
        for code in [
            ffi::SQLITE_ERROR,
            ffi::SQLITE_CONSTRAINT,
            ffi::SQLITE_MISMATCH,
        ] {
            assert_eq!(sqlite(code).protocol_code(), ErrorCode::Internal, "{code}");
        }
        // A missing table, as the index-worker test simulates.
        let conn = rusqlite::Connection::open_in_memory().expect("memory db");
        let missing = conn
            .execute("DELETE FROM absent", [])
            .expect_err("missing table");
        assert_eq!(
            StoreError::Sqlite(missing).protocol_code(),
            ErrorCode::Internal
        );
    }
}

#[cfg(test)]
mod clock_tests {
    use super::*;
    #[test]
    fn millisecond_clock_preserves_fraction_and_frozen_second_units() {
        let root = std::env::temp_dir().join(format!(
            "kb-sealed-clock-{}",
            crate::state::new_uuid_v4().unwrap()
        ));
        let store = Store::open(&root).unwrap();
        let epoch_ms = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        };
        while epoch_ms() % 1000 == 0 {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let before = epoch_ms();
        let observed = store.now_ms();
        let after = epoch_ms();
        assert!((before..=after).contains(&observed));
        let before = epoch_ms();
        store.advance_clock_for_tests(1);
        let after = epoch_ms();
        assert!((before + 1000..=after + 1000).contains(&store.now_ms()));
        let frozen = store.now_ms();
        store.advance_clock_for_tests(-1);
        assert_eq!(store.now_ms(), frozen - 1000);
        store.advance_clock_for_tests(0);
        assert_eq!(store.now_ms(), frozen - 1000);
        store.set_cursor_clock_for_tests(42);
        assert_eq!(store.now_ms(), 42_000);
        store.advance_clock_for_tests(1);
        assert_eq!(store.now_ms(), 43_000);
        store.set_cursor_clock_for_tests(u64::MAX);
        assert_eq!(store.now_ms(), u64::MAX);
        store.advance_clock_for_tests(i64::MIN);
        assert_eq!(store.now_ms(), 0);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
