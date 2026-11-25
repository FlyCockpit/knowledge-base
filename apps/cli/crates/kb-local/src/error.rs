//! The store-wide failure type: every kb-local operation reports a
//! [`StoreError`], which maps onto the kb/1 error codes and details.

use std::fmt;
use std::io;

use kb_client::ErrorCode;

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
    /// The session's write mode does not allow this write (a dream from an
    /// edit-only session, or a direct edit from a dream-only one): kb/1
    /// `FORBIDDEN` with `{reason: "WRITE_MODE", required}`.
    WriteMode(kb_client::authoring::WriteKind),
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
    /// A failure with a specific human explanation for the local owner's
    /// CLI. The wire carries only `code` with empty details.
    Explained(ErrorCode, String),
    Internal(String),
    Io(io::Error),
    Sqlite(rusqlite::Error),
}

impl StoreError {
    /// kb/1 wire code for this failure.
    pub fn protocol_code(&self) -> ErrorCode {
        match self {
            StoreError::RecoveryRequired(_) | StoreError::UnsafePath(_) => {
                ErrorCode::RepairRequired
            }
            StoreError::NotFound | StoreError::PathNotFound { .. } => ErrorCode::NotFound,
            StoreError::Forbidden | StoreError::WriteMode(_) => ErrorCode::Forbidden,
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
            StoreError::WriteMode(required) => {
                f.write_str(kb_client::error::write_mode_message(*required))
            }
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
            StoreError::WriteMode(required) => ErrorDetails::WriteMode {
                required: *required,
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
