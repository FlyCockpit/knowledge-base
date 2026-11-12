//! kb/1 error union, protocol violations, and the cancellation/deadline
//! primitives every transport uses.
//!
//! Error text is fixed per variant: no error produced by this crate echoes a
//! caller- or server-supplied value (tokens, paths, queries, raw messages).

use std::fmt;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::schema::{MAX_SAFE_INTEGER, SchemaViolation, safe_integer};
use crate::types::{IndexState, KbId, Sha};

pub(crate) const TOO_MANY_CHANGES_MESSAGE: &str = "At most 32 changes per call. Each call commits on success: apply the first 32 now, then send the rest in another call using the returned commit as baseRevision.";

macro_rules! error_codes {
    ($( $variant:ident => $wire:literal, $message:literal, $retryable:literal; )*) => {
        /// Closed set of kb/1 error codes.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum ErrorCode { $( $variant, )* }

        impl ErrorCode {
            /// Every code, in contract order.
            pub const ALL: &'static [ErrorCode] = &[ $( ErrorCode::$variant, )* ];

            /// Wire spelling.
            pub fn as_str(self) -> &'static str {
                match self { $( ErrorCode::$variant => $wire, )* }
            }

            /// The fixed, redacted message the server must send for this code.
            pub fn message(self) -> &'static str {
                match self { $( ErrorCode::$variant => $message, )* }
            }

            /// Contract retryability: rate limit, storage, index and deadline only.
            pub fn retryable(self) -> bool {
                match self { $( ErrorCode::$variant => $retryable, )* }
            }
        }

        impl FromStr for ErrorCode {
            type Err = ProtocolError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $( $wire => Ok(ErrorCode::$variant), )*
                    _ => Err(ProtocolError::MalformedEnvelope),
                }
            }
        }
    };
}

error_codes! {
    InvalidArgument => "INVALID_ARGUMENT", "Invalid argument", false;
    InvalidCursor => "INVALID_CURSOR", "Invalid cursor", false;
    NotFound => "NOT_FOUND", "Not found", false;
    Forbidden => "FORBIDDEN", "Forbidden", false;
    Conflict => "CONFLICT", "Conflict", false;
    IdempotencyMismatch => "IDEMPOTENCY_MISMATCH", "Idempotency mismatch", false;
    RateLimited => "RATE_LIMITED", "Rate limited", true;
    QuotaExceeded => "QUOTA_EXCEEDED", "Quota exceeded", false;
    IndexUnavailable => "INDEX_UNAVAILABLE", "Index unavailable", true;
    StorageUnavailable => "STORAGE_UNAVAILABLE", "Storage unavailable", true;
    SensitiveQuery => "SENSITIVE_QUERY", "Sensitive query rejected", false;
    EmbeddingInputTooLong => "EMBEDDING_INPUT_TOO_LONG", "Embedding input too long", false;
    UploadIncomplete => "UPLOAD_INCOMPLETE", "Upload incomplete", false;
    UploadExpired => "UPLOAD_EXPIRED", "Upload expired", false;
    UnresolvedReference => "UNRESOLVED_REFERENCE", "Unresolved reference", false;
    Cancelled => "CANCELLED", "Cancelled", false;
    DeadlineExceeded => "DEADLINE_EXCEEDED", "Deadline exceeded", true;
    RepairRequired => "REPAIR_REQUIRED", "Repair required", false;
    Internal => "INTERNAL", "Internal error", false;
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Closed `details` union of a tool error; which shapes are allowed depends on
/// the code (`{}` is always allowed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErrorDetails {
    Empty,
    Conflict {
        head_sha: Sha,
        proposal_number: Option<i64>,
    },
    IndexUnavailable {
        generation_id: Option<KbId>,
        state: IndexState,
    },
    RateLimited {
        retry_after_seconds: u64,
    },
    /// `INVALID_ARGUMENT` with a closed reason and, when known, the JSON
    /// pointer of the offending argument (see [`is_field_pointer`]).
    InvalidArgument {
        reason: InvalidReason,
        field: Option<String>,
        /// The inclusive bounds the value broke (length, item count or
        /// range), when the rule has them.
        min: Option<i64>,
        max: Option<i64>,
    },
    /// `NOT_FOUND` with a closed reason: a document read of a path that is
    /// not in the revision (`{reason: "PATH_NOT_FOUND", field?}`).
    NotFoundReason {
        reason: NotFoundReason,
        field: Option<String>,
    },
    /// `CONFLICT` with a closed reason (creating a path that exists).
    ConflictReason {
        reason: ConflictReason,
        field: Option<String>,
    },
    /// `CONFLICT`: a proposal no longer applies to main. `head_sha` is the
    /// main revision to propose against; `base_sha`/`proposal_head_sha` and
    /// the per-path versions are what a resolver needs.
    ProposalConflict(Box<ProposalConflict>),
}

/// Payload of [`ErrorDetails::ProposalConflict`] (boxed: errors stay small).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalConflict {
    pub head_sha: Sha,
    pub proposal_number: Option<i64>,
    pub base_sha: Sha,
    pub proposal_head_sha: Sha,
    pub content_included: bool,
    pub paths: Vec<ConflictPath>,
}

macro_rules! reasons {
    ($(#[$meta:meta])* $name:ident { $( $variant:ident => $wire:literal, )* }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $( $variant, )* }

        impl $name {
            /// Every reason, in contract order.
            pub const ALL: &'static [$name] = &[ $( $name::$variant, )* ];

            /// Wire spelling.
            pub fn as_str(self) -> &'static str {
                match self { $( $name::$variant => $wire, )* }
            }
        }

        impl FromStr for $name {
            type Err = ProtocolError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s {
                    $( $wire => Ok($name::$variant), )*
                    _ => Err(ProtocolError::MalformedEnvelope),
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

reasons! {
    /// Closed, non-sensitive `INVALID_ARGUMENT` reasons (kb/1, additive).
    InvalidReason {
        Schema => "SCHEMA",
        UnknownArgument => "UNKNOWN_ARGUMENT",
        MissingArgument => "MISSING_ARGUMENT",
        TooManyChanges => "TOO_MANY_CHANGES",
        ConfirmRequired => "CONFIRM_REQUIRED",
        InvalidPrefix => "INVALID_PREFIX",
        QueryTooLong => "QUERY_TOO_LONG",
        LimitOutOfRange => "LIMIT_OUT_OF_RANGE",
        InvalidPath => "INVALID_PATH",
        ReservedPath => "RESERVED_PATH",
        PathCaseCollision => "PATH_CASE_COLLISION",
        PathNotFound => "PATH_NOT_FOUND",
        NotMarkdownPath => "NOT_MARKDOWN_PATH",
        InvalidFrontMatter => "INVALID_FRONT_MATTER",
        ControlCharacter => "CONTROL_CHARACTER",
        InvalidMarkdown => "INVALID_MARKDOWN",
        DuplicateDocumentId => "DUPLICATE_DOCUMENT_ID",
        SealedReferenceRevoked => "SEALED_REFERENCE_REVOKED",
        TooLarge => "TOO_LARGE",
    }
}

reasons! {
    /// Closed `CONFLICT` reasons carried as `{reason, field?}`: an existing
    /// path; a provider/built-in revision that is not the usable one
    /// (`/revision`); finished upload bytes that do not hash to the declared
    /// content hash; a chunk that disagrees with acknowledged bytes
    /// (`/offset`); an upload that is already finished or consumed.
    ConflictReason {
        PathExists => "PATH_EXISTS",
        RevisionNotCurrent => "REVISION_NOT_CURRENT",
        ContentHashMismatch => "CONTENT_HASH_MISMATCH",
        UploadBytesMismatch => "UPLOAD_BYTES_MISMATCH",
        UploadNotWritable => "UPLOAD_NOT_WRITABLE",
    }
}

reasons! {
    /// Closed `NOT_FOUND` reasons carried as `{reason, field?}`.
    NotFoundReason {
        PathNotFound => "PATH_NOT_FOUND",
    }
}

/// Wire reason of a [`ErrorDetails::ProposalConflict`].
pub const PROPOSAL_CONFLICT_REASON: &str = "PROPOSAL_CONFLICT";
/// Most conflicting paths one `PROPOSAL_CONFLICT` lists.
pub const PROPOSAL_CONFLICT_MAX_PATHS: usize = 50;

/// One conflicting logical path: its kind (`document` or `asset`), its
/// version at the merge base, on main (`theirs`) and in the proposal
/// (`yours`) — Markdown, or an asset's manifest entry as JSON; `None` when
/// absent there or when content was not included — and the exact revision
/// each was read at, so omitted content can be read with `documents_get`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictPath {
    pub path: String,
    pub kind: ConflictKind,
    pub base: Option<String>,
    pub theirs: Option<String>,
    pub yours: Option<String>,
    pub base_sha: Sha,
    pub theirs_sha: Sha,
    pub yours_sha: Sha,
}

/// What resolves a conflicting path: document operations or asset operations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictKind {
    Document,
    Asset,
}

impl ConflictKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ConflictKind::Document => "document",
            ConflictKind::Asset => "asset",
        }
    }
}

/// A `field` JSON pointer: 1..=8 segments of `[A-Za-z0-9_]{1,64}`. Anything
/// else (caller-chosen key text) is never sent; the member is omitted.
pub fn is_field_pointer(pointer: &str) -> bool {
    let Some(rest) = pointer.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    (1..=8).contains(&segments.len())
        && segments.iter().all(|segment| {
            (1..=64).contains(&segment.len())
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}

/// `field` only when it is a valid pointer.
pub fn field_pointer(pointer: impl Into<String>) -> Option<String> {
    let pointer = pointer.into();
    is_field_pointer(&pointer).then_some(pointer)
}

impl ErrorDetails {
    fn parse(code: ErrorCode, value: &Value) -> Result<Self, ProtocolError> {
        let object = value.as_object().ok_or(ProtocolError::MalformedEnvelope)?;
        if object.is_empty() {
            return Ok(ErrorDetails::Empty);
        }
        let closed = |keys: &[&str]| {
            object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
        };
        let bad = || ProtocolError::MalformedEnvelope;
        match code {
            ErrorCode::Conflict if closed(&["headSha", "proposalNumber"]) => {
                let head_sha =
                    serde_json::from_value(object["headSha"].clone()).map_err(|_| bad())?;
                let proposal_number = match &object["proposalNumber"] {
                    Value::Null => None,
                    other => Some(safe_integer(other).ok_or_else(bad)?),
                };
                Ok(ErrorDetails::Conflict {
                    head_sha,
                    proposal_number,
                })
            }
            ErrorCode::IndexUnavailable if closed(&["generationId", "state"]) => {
                let generation_id =
                    serde_json::from_value(object["generationId"].clone()).map_err(|_| bad())?;
                let state = serde_json::from_value(object["state"].clone()).map_err(|_| bad())?;
                Ok(ErrorDetails::IndexUnavailable {
                    generation_id,
                    state,
                })
            }
            ErrorCode::RateLimited if closed(&["retryAfterSeconds"]) => {
                let seconds = safe_integer(&object["retryAfterSeconds"]).ok_or_else(bad)?;
                let retry_after_seconds = u64::try_from(seconds).ok().filter(|s| *s >= 1);
                Ok(ErrorDetails::RateLimited {
                    retry_after_seconds: retry_after_seconds.ok_or_else(bad)?,
                })
            }
            ErrorCode::InvalidArgument
                if object.contains_key("reason")
                    && object
                        .keys()
                        .all(|k| matches!(k.as_str(), "reason" | "field" | "min" | "max")) =>
            {
                let bound = |key: &str| match object.get(key) {
                    None => Ok(None),
                    Some(v) => safe_integer(v).map(Some).ok_or_else(bad),
                };
                Ok(ErrorDetails::InvalidArgument {
                    reason: object["reason"].as_str().ok_or_else(bad)?.parse()?,
                    field: parse_field(object.get("field"))?,
                    min: bound("min")?,
                    max: bound("max")?,
                })
            }
            ErrorCode::Conflict
                if object.get("reason").and_then(Value::as_str)
                    == Some(PROPOSAL_CONFLICT_REASON) =>
            {
                parse_proposal_conflict(object)
            }
            ErrorCode::NotFound if closed(&["reason"]) || closed(&["reason", "field"]) => {
                Ok(ErrorDetails::NotFoundReason {
                    reason: object["reason"].as_str().ok_or_else(bad)?.parse()?,
                    field: parse_field(object.get("field"))?,
                })
            }
            ErrorCode::Conflict if closed(&["reason"]) || closed(&["reason", "field"]) => {
                Ok(ErrorDetails::ConflictReason {
                    reason: object["reason"].as_str().ok_or_else(bad)?.parse()?,
                    field: parse_field(object.get("field"))?,
                })
            }
            _ => Err(bad()),
        }
    }

    /// Wire form of these details.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        match self {
            ErrorDetails::Empty => {}
            ErrorDetails::Conflict {
                head_sha,
                proposal_number,
            } => {
                map.insert(
                    "headSha".into(),
                    Value::String(head_sha.as_str().to_owned()),
                );
                map.insert(
                    "proposalNumber".into(),
                    proposal_number.map_or(Value::Null, Value::from),
                );
            }
            ErrorDetails::IndexUnavailable {
                generation_id,
                state,
            } => {
                map.insert(
                    "generationId".into(),
                    generation_id
                        .as_ref()
                        .map_or(Value::Null, |id| Value::from(id.as_str())),
                );
                map.insert("state".into(), Value::from(state.as_str()));
            }
            ErrorDetails::RateLimited {
                retry_after_seconds,
            } => {
                map.insert(
                    "retryAfterSeconds".into(),
                    Value::from(*retry_after_seconds),
                );
            }
            ErrorDetails::InvalidArgument {
                reason,
                field,
                min,
                max,
            } => {
                map.insert("reason".into(), Value::from(reason.as_str()));
                if let Some(field) = field {
                    map.insert("field".into(), Value::from(field.as_str()));
                }
                if let Some(min) = min {
                    map.insert("min".into(), Value::from(*min));
                }
                if let Some(max) = max {
                    map.insert("max".into(), Value::from(*max));
                }
            }
            ErrorDetails::ConflictReason { reason, field } => {
                map.insert("reason".into(), Value::from(reason.as_str()));
                if let Some(field) = field {
                    map.insert("field".into(), Value::from(field.as_str()));
                }
            }
            ErrorDetails::NotFoundReason { reason, field } => {
                map.insert("reason".into(), Value::from(reason.as_str()));
                if let Some(field) = field {
                    map.insert("field".into(), Value::from(field.as_str()));
                }
            }
            ErrorDetails::ProposalConflict(conflict) => {
                let ProposalConflict {
                    head_sha,
                    proposal_number,
                    base_sha,
                    proposal_head_sha,
                    content_included,
                    paths,
                } = conflict.as_ref();
                map.insert(
                    "headSha".into(),
                    Value::String(head_sha.as_str().to_owned()),
                );
                map.insert(
                    "proposalNumber".into(),
                    proposal_number.map_or(Value::Null, Value::from),
                );
                map.insert("reason".into(), Value::from(PROPOSAL_CONFLICT_REASON));
                map.insert(
                    "baseSha".into(),
                    Value::String(base_sha.as_str().to_owned()),
                );
                map.insert(
                    "proposalHeadSha".into(),
                    Value::String(proposal_head_sha.as_str().to_owned()),
                );
                map.insert("contentIncluded".into(), Value::Bool(*content_included));
                let text = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
                map.insert(
                    "paths".into(),
                    Value::Array(
                        paths
                            .iter()
                            .map(|p| {
                                let mut entry = Map::new();
                                entry.insert("path".into(), Value::from(p.path.as_str()));
                                entry.insert("kind".into(), Value::from(p.kind.as_str()));
                                entry.insert("base".into(), text(&p.base));
                                entry.insert("theirs".into(), text(&p.theirs));
                                entry.insert("yours".into(), text(&p.yours));
                                entry.insert("baseSha".into(), Value::from(p.base_sha.as_str()));
                                entry
                                    .insert("theirsSha".into(), Value::from(p.theirs_sha.as_str()));
                                entry.insert("yoursSha".into(), Value::from(p.yours_sha.as_str()));
                                Value::Object(entry)
                            })
                            .collect(),
                    ),
                );
            }
        }
        Value::Object(map)
    }
}

fn parse_field(value: Option<&Value>) -> Result<Option<String>, ProtocolError> {
    match value {
        None => Ok(None),
        Some(Value::String(s)) if is_field_pointer(s) => Ok(Some(s.clone())),
        Some(_) => Err(ProtocolError::MalformedEnvelope),
    }
}

fn parse_proposal_conflict(object: &Map<String, Value>) -> Result<ErrorDetails, ProtocolError> {
    let bad = || ProtocolError::MalformedEnvelope;
    let keys = [
        "headSha",
        "proposalNumber",
        "reason",
        "baseSha",
        "proposalHeadSha",
        "contentIncluded",
        "paths",
    ];
    if object.len() != keys.len() || !keys.iter().all(|key| object.contains_key(*key)) {
        return Err(bad());
    }
    let sha = |key: &str| serde_json::from_value::<Sha>(object[key].clone()).map_err(|_| bad());
    let proposal_number = match &object["proposalNumber"] {
        Value::Null => None,
        other => Some(safe_integer(other).ok_or_else(bad)?),
    };
    let content_included = object["contentIncluded"].as_bool().ok_or_else(bad)?;
    let items = object["paths"].as_array().ok_or_else(bad)?;
    let text = |v: &Value| match v {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(bad()),
    };
    let mut paths = Vec::with_capacity(items.len());
    for item in items {
        let entry = item.as_object().ok_or_else(bad)?;
        let entry_keys = [
            "path",
            "kind",
            "base",
            "theirs",
            "yours",
            "baseSha",
            "theirsSha",
            "yoursSha",
        ];
        if entry.len() != entry_keys.len() || !entry_keys.iter().all(|k| entry.contains_key(*k)) {
            return Err(bad());
        }
        let revision =
            |key: &str| serde_json::from_value::<Sha>(entry[key].clone()).map_err(|_| bad());
        paths.push(ConflictPath {
            path: entry["path"].as_str().ok_or_else(bad)?.to_owned(),
            kind: match entry["kind"].as_str() {
                Some("document") => ConflictKind::Document,
                Some("asset") => ConflictKind::Asset,
                _ => return Err(bad()),
            },
            base: text(&entry["base"])?,
            theirs: text(&entry["theirs"])?,
            yours: text(&entry["yours"])?,
            base_sha: revision("baseSha")?,
            theirs_sha: revision("theirsSha")?,
            yours_sha: revision("yoursSha")?,
        });
    }
    Ok(ErrorDetails::ProposalConflict(Box::new(ProposalConflict {
        head_sha: sha("headSha")?,
        proposal_number,
        base_sha: sha("baseSha")?,
        proposal_head_sha: sha("proposalHeadSha")?,
        content_included,
        paths,
    })))
}

/// Map a tool-input schema violation to `INVALID_ARGUMENT` details:
/// a closed reason and, when it is a safe pointer, the offending field.
/// `input` is the rejected arguments object, read only to classify a path.
pub fn invalid_input_details(violation: &SchemaViolation, input: &Value) -> ErrorDetails {
    let pointer = match (&violation.member, violation.keyword) {
        (Some(member), "required" | "additionalProperties") => {
            format!("{}/{member}", violation.pointer)
        }
        _ => violation.pointer.clone(),
    };
    let last = pointer.rsplit('/').next().unwrap_or_default();
    let reason = match violation.keyword {
        "additionalProperties" => InvalidReason::UnknownArgument,
        // Any value but the exact confirmation word, of any type, is a
        // missing confirmation (server parity).
        _ if last == "confirm" => InvalidReason::ConfirmRequired,
        // A wrong type is never a domain reason (`limit: "5"` is SCHEMA).
        "type" => InvalidReason::Schema,
        "required" => InvalidReason::MissingArgument,
        "maxItems" if last == "changes" => InvalidReason::TooManyChanges,
        _ if last == "prefix" => InvalidReason::InvalidPrefix,
        "maxLength" | "x-kb-utf8-max-bytes" if last == "query" => InvalidReason::QueryTooLong,
        "minimum" | "maximum" if last == "limit" => InvalidReason::LimitOutOfRange,
        "x-kb-change-paths" => InvalidReason::PathCaseCollision,
        "x-kb-no-control-chars" => InvalidReason::ControlCharacter,
        "x-kb-path" => match input
            .pointer(&violation.pointer)
            .and_then(Value::as_str)
            .map(crate::path::check_kb_path)
        {
            Some(Err(
                crate::path::PathIssue::GitReserved | crate::path::PathIssue::WindowsReserved,
            )) => InvalidReason::ReservedPath,
            Some(Err(crate::path::PathIssue::Absolute))
                if input
                    .pointer(&violation.pointer)
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.as_bytes().get(1) == Some(&b':')) =>
            {
                InvalidReason::ReservedPath
            }
            Some(Err(crate::path::PathIssue::Control)) => InvalidReason::ControlCharacter,
            _ => InvalidReason::InvalidPath,
        },
        "maxLength" | "x-kb-utf8-max-bytes" | "x-kb-json-encoded-max-bytes" => {
            InvalidReason::TooLarge
        }
        _ => InvalidReason::Schema,
    };
    ErrorDetails::InvalidArgument {
        reason,
        field: field_pointer(pointer),
        min: violation.min,
        max: violation.max,
    }
}

/// Wire `details` for a failed input check: reason + field for a schema
/// violation, `{}` for anything else.
pub fn invalid_input_details_value(error: &KbError, input: &Value) -> Value {
    match error {
        KbError::Protocol(ProtocolError::InvalidInput(violation)) => {
            invalid_input_details(violation, input).to_value()
        }
        _ => Value::Object(Map::new()),
    }
}

/// A domain error returned by a tool (`isError: true`).
/// Construct with [`ToolError::new`] or [`ToolError::from_value`]; validated
/// details can be inspected but cannot be changed after construction.
///
/// ```compile_fail
/// use kb_client::{ToolError, ErrorCode};
/// use kb_client::error::ErrorDetails;
/// let mut error = ToolError::new(ErrorCode::Forbidden, ErrorDetails::Empty).unwrap();
/// error.details = ErrorDetails::RateLimited { retry_after_seconds: 0 };
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolError {
    code: ErrorCode,
    details: ErrorDetails,
}

impl ToolError {
    /// Build a canonical error, rejecting mismatched detail kinds and unsafe
    /// numeric members. Private fields prevent mutation bypassing this boundary.
    pub fn new(code: ErrorCode, details: ErrorDetails) -> Result<Self, ProtocolError> {
        let valid = match &details {
            ErrorDetails::Empty => true,
            ErrorDetails::Conflict {
                proposal_number, ..
            } => {
                code == ErrorCode::Conflict
                    && proposal_number
                        .is_none_or(|n| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n))
            }
            ErrorDetails::IndexUnavailable { .. } => code == ErrorCode::IndexUnavailable,
            ErrorDetails::RateLimited {
                retry_after_seconds,
            } => {
                code == ErrorCode::RateLimited
                    && (1..=MAX_SAFE_INTEGER as u64).contains(retry_after_seconds)
            }
            ErrorDetails::InvalidArgument {
                field, min, max, ..
            } => {
                code == ErrorCode::InvalidArgument
                    && field.as_deref().is_none_or(is_field_pointer)
                    && [min, max].iter().all(|n| {
                        n.is_none_or(|n| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n))
                    })
            }
            ErrorDetails::ConflictReason { field, .. } => {
                code == ErrorCode::Conflict && field.as_deref().is_none_or(is_field_pointer)
            }
            ErrorDetails::NotFoundReason { field, .. } => {
                code == ErrorCode::NotFound && field.as_deref().is_none_or(is_field_pointer)
            }
            ErrorDetails::ProposalConflict(conflict) => {
                let ProposalConflict {
                    proposal_number,
                    content_included,
                    paths,
                    ..
                } = conflict.as_ref();
                code == ErrorCode::Conflict
                    && proposal_number
                        .is_none_or(|n| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n))
                    && (1..=PROPOSAL_CONFLICT_MAX_PATHS).contains(&paths.len())
                    && paths.iter().all(|p| {
                        crate::path::check_kb_path(&p.path).is_ok()
                            && (*content_included
                                || (p.base.is_none() && p.theirs.is_none() && p.yours.is_none()))
                    })
            }
        };
        if !valid {
            return Err(ProtocolError::MalformedEnvelope);
        }
        Ok(ToolError { code, details })
    }

    pub fn code(&self) -> ErrorCode {
        self.code
    }

    pub fn message(&self) -> &'static str {
        if matches!(
            self.details,
            ErrorDetails::InvalidArgument {
                reason: InvalidReason::TooManyChanges,
                ..
            }
        ) {
            TOO_MANY_CHANGES_MESSAGE
        } else {
            self.code.message()
        }
    }

    pub fn retryable(&self) -> bool {
        self.code.retryable()
    }

    pub fn details(&self) -> &ErrorDetails {
        &self.details
    }

    /// Strictly parse the `error` member of a kb/1 error envelope.
    pub fn from_value(value: &Value) -> Result<Self, ProtocolError> {
        let object = value.as_object().ok_or(ProtocolError::MalformedEnvelope)?;
        let keys = ["code", "message", "retryable", "details"];
        if object.len() != keys.len() || !keys.iter().all(|key| object.contains_key(*key)) {
            return Err(ProtocolError::MalformedEnvelope);
        }
        let code: ErrorCode = object["code"]
            .as_str()
            .ok_or(ProtocolError::MalformedEnvelope)?
            .parse()?;
        let details = ErrorDetails::parse(code, &object["details"])?;
        let error = ToolError::new(code, details)?;
        if object["message"].as_str() != Some(error.message())
            || object["retryable"].as_bool() != Some(code.retryable())
        {
            return Err(ProtocolError::MalformedEnvelope);
        }
        Ok(error)
    }

    /// Wire form of the `error` member.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".into(), Value::from(self.code.as_str()));
        map.insert("message".into(), Value::from(self.message()));
        map.insert("retryable".into(), Value::Bool(self.code.retryable()));
        map.insert("details".into(), self.details.to_value());
        Value::Object(map)
    }
}

impl fmt::Display for ToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message())
    }
}

/// The peer (or caller) violated the kb/1 contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    /// Operation name is not in the pinned kb/1 catalog.
    UnknownTool,
    /// `schemaVersion` absent or not `kb/1`.
    SchemaVersionMismatch,
    /// Envelope or error member is not the closed kb/1 shape.
    MalformedEnvelope,
    /// Tool input fails the contract (maps to `INVALID_ARGUMENT`).
    InvalidInput(SchemaViolation),
    /// Tool output fails the contract.
    InvalidOutput(SchemaViolation),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::UnknownTool => f.write_str("unknown kb/1 tool"),
            ProtocolError::SchemaVersionMismatch => f.write_str("kb/1 schema version mismatch"),
            ProtocolError::MalformedEnvelope => f.write_str("malformed kb/1 envelope"),
            ProtocolError::InvalidInput(v) => write!(f, "invalid kb/1 tool input: {v}"),
            ProtocolError::InvalidOutput(v) => write!(f, "invalid kb/1 tool output: {v}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// Every failure a kb/1 client call can end in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KbError {
    Protocol(ProtocolError),
    Tool(ToolError),
    /// The caller cancelled; a late response must be discarded.
    Cancelled,
    /// The call's deadline elapsed before a response.
    DeadlineExceeded,
}

impl KbError {
    /// The contract code this failure corresponds to.
    pub fn code(&self) -> ErrorCode {
        match self {
            KbError::Protocol(ProtocolError::InvalidInput(_)) => ErrorCode::InvalidArgument,
            KbError::Protocol(_) => ErrorCode::Internal,
            KbError::Tool(error) => error.code,
            KbError::Cancelled => ErrorCode::Cancelled,
            KbError::DeadlineExceeded => ErrorCode::DeadlineExceeded,
        }
    }

    /// Whether retrying the same operation (same idempotency key) may succeed.
    pub fn retryable(&self) -> bool {
        match self {
            KbError::Protocol(_) => false,
            other => other.code().retryable(),
        }
    }
}

impl fmt::Display for KbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KbError::Protocol(error) => error.fmt(f),
            KbError::Tool(error) => error.fmt(f),
            KbError::Cancelled => f.write_str("kb call cancelled"),
            KbError::DeadlineExceeded => f.write_str("kb call deadline exceeded"),
        }
    }
}

impl std::error::Error for KbError {}

impl From<ProtocolError> for KbError {
    fn from(error: ProtocolError) -> Self {
        KbError::Protocol(error)
    }
}

impl From<ToolError> for KbError {
    fn from(error: ToolError) -> Self {
        KbError::Tool(error)
    }
}

/// Cooperative cancellation shared between a caller and an in-flight call.
/// Clones observe the same state; cancellation is one-way. Transports await
/// [`CancellationToken::cancelled`] so a cancel interrupts I/O immediately.
#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    inner: Arc<CancelState>,
}

#[derive(Debug, Default)]
struct CancelState {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once [`CancellationToken::cancel`] has been called (at once if
    /// it already was).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            // Register before re-checking the flag so a concurrent cancel is
            // never missed between the check and the await.
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// `Err(KbError::Cancelled)` once cancelled.
    pub fn check(&self) -> Result<(), KbError> {
        if self.is_cancelled() {
            Err(KbError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Absolute deadline for one call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deadline {
    at: Instant,
}

impl Deadline {
    pub fn at(at: Instant) -> Self {
        Deadline { at }
    }

    pub fn after(timeout: Duration) -> Self {
        Deadline {
            at: Instant::now() + timeout,
        }
    }

    pub fn instant(&self) -> Instant {
        self.at
    }

    /// Time left, zero once elapsed.
    pub fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.at
    }

    /// `Err(KbError::DeadlineExceeded)` once elapsed.
    pub fn check(&self) -> Result<(), KbError> {
        if self.is_expired() {
            Err(KbError::DeadlineExceeded)
        } else {
            Ok(())
        }
    }
}
