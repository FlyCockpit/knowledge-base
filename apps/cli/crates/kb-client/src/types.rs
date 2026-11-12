//! Closed, camelCase kb/1 input/output types for every catalog tool.
//!
//! Serde shape is only the first gate: [`crate::encode_input`] and
//! [`crate::decode_output`] additionally run every value through the canonical
//! JSON Schema artifact, which enforces Unicode scalar bounds, UTF-8 byte caps,
//! safe integers, canonical base64, paths and instants exactly like the server.
//!
//! Conventions:
//! * optional input keys are omitted when `None` and reject an explicit `null`;
//! * nullable output keys must be present (`null` or a value);
//! * no compatibility aliases — unknown keys fail.

use std::fmt;
use std::str::FromStr;

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::error::{KbError, ProtocolError};
use crate::path::check_kb_path;
use crate::schema::{self, Direction};

// ── Serde helpers ───────────────────────────────────────────────────────────

/// Optional input key: absent → `None`; explicit `null` is rejected.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// Nullable output key: must be present, `null` → `None`.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

/// Optional *and* nullable input key (`cursor`): absent, `null`, or a value.
mod optional_nullable {
    use super::*;

    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }

    pub fn serialize<S: Serializer, T: Serialize>(
        value: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(Some(inner)) => inner.serialize(s),
            _ => s.serialize_none(),
        }
    }
}

/// Finite numbers serialized like JavaScript: integral values without `.0`.
mod js_number {
    use super::*;

    pub fn serialize<S: Serializer>(value: &f64, s: S) -> Result<S::Ok, S::Error> {
        const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
        if value.fract() == 0.0 && value.abs() <= MAX_SAFE {
            // Exact: integral and within the safe range.
            #[allow(clippy::cast_possible_truncation)]
            let integral = *value as i64;
            s.serialize_i64(integral)
        } else {
            s.serialize_f64(*value)
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        let value = f64::deserialize(d)?;
        if value.is_finite() {
            Ok(value)
        } else {
            Err(D::Error::custom("non-finite number"))
        }
    }
}

// ── Scalars ─────────────────────────────────────────────────────────────────

/// A scalar failed its kb/1 format. Never carries the rejected text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScalarError {
    pub kind: &'static str,
}

impl fmt::Display for ScalarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid `{}`", self.kind)
    }
}

impl std::error::Error for ScalarError {}

macro_rules! validated_string {
    ($(#[$doc:meta])* $name:ident, $check:expr) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            /// Validate and wrap.
            pub fn parse(value: &str) -> Result<Self, ScalarError> {
                let check: fn(&str) -> bool = $check;
                if check(value) {
                    Ok($name(value.to_owned()))
                } else {
                    Err(ScalarError { kind: stringify!($name) })
                }
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = ScalarError;
            fn try_from(value: String) -> Result<Self, ScalarError> {
                Self::parse(&value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }

        impl FromStr for $name {
            type Err = ScalarError;
            fn from_str(value: &str) -> Result<Self, ScalarError> {
                Self::parse(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

validated_string!(
    /// Lowercase cuid2-style KB/generation/provider ID (24..32 `[a-z0-9]`).
    KbId,
    schema::is_kb_id
);
validated_string!(
    /// An embedding provider: a provider [`KbId`], or `builtin` for the
    /// built-in local model.
    ProviderRef,
    |s| s == ProviderRef::BUILTIN || schema::is_kb_id(s)
);
impl ProviderRef {
    /// The wire name of the built-in local model.
    pub const BUILTIN: &'static str = "builtin";
    pub fn builtin() -> Self {
        ProviderRef(Self::BUILTIN.to_owned())
    }
    pub fn canonical(&self) -> Self {
        Self(schema::canonical_provider_ref(&self.0).to_owned())
    }
    pub fn is_builtin(&self) -> bool {
        schema::canonical_provider_ref(&self.0) == Self::BUILTIN
    }
    /// The registered provider ID, `None` for `builtin`.
    pub fn provider_id(&self) -> Option<KbId> {
        if self.is_builtin() {
            None
        } else {
            KbId::parse(&self.0).ok()
        }
    }
}
impl From<KbId> for ProviderRef {
    fn from(id: KbId) -> Self {
        ProviderRef(id.as_str().to_owned())
    }
}
validated_string!(
    /// Canonical lowercase UUID.
    Uuid,
    schema::is_uuid
);
validated_string!(
    /// 40-hex lowercase Git SHA-1 object name.
    Sha,
    schema::is_sha
);
validated_string!(
    /// `sha256:` plus 64 lowercase hex.
    ContentHash,
    schema::is_content_hash
);
validated_string!(
    /// Idempotency key, 16..128 `[A-Za-z0-9_-]`.
    IdempotencyKey,
    schema::is_idempotency_key
);
validated_string!(
    /// KB slug `[a-z0-9]+(-[a-z0-9]+)*`, at most 63 characters.
    Slug,
    |s| s.len() <= 63 && schema::is_slug(s)
);
validated_string!(
    /// Dream concept ID `[a-z0-9][a-z0-9_-]{0,127}`.
    ConceptId,
    schema::is_concept_id
);
validated_string!(
    /// Normalized relative kb repository path.
    KbPath,
    |s| check_kb_path(s).is_ok()
);
validated_string!(
    /// A raw document-path prefix filter: a [`KbPath`] optionally followed
    /// by one `/` (L-22: `notes/` matches only the `notes` directory).
    KbPathPrefix,
    |s| check_kb_path(s.strip_suffix('/').unwrap_or(s)).is_ok()
);
validated_string!(
    /// UTC RFC 3339 instant with `Z`, 0..9 fractional digits, real date.
    IsoInstant,
    |s| schema::parse_iso_instant(s).is_some()
);

/// Opaque bearer credential (PAT or OAuth access token). Its value never
/// appears in `Debug`/`Display`, and it cannot be serialized.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretToken(zeroize::Zeroizing<String>);

impl SecretToken {
    pub fn new(secret: String) -> Self {
        SecretToken(zeroize::Zeroizing::new(secret))
    }

    /// The raw secret, for placing into an `Authorization` header only.
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretToken([redacted])")
    }
}

impl fmt::Display for SecretToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

// ── Literals ────────────────────────────────────────────────────────────────

macro_rules! literal_str {
    ($(#[$doc:meta])* $name:ident, $wire:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
        pub struct $name;

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str($wire)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let value = String::deserialize(d)?;
                if value == $wire { Ok($name) } else { Err(D::Error::custom(concat!("expected ", $wire))) }
            }
        }
    };
}

literal_str!(MainBranch, "main");
literal_str!(DeleteConfirm, "DELETE");
literal_str!(RunConfirm, "RUN");
literal_str!(PendingState, "PENDING");
literal_str!(ReadyState, "READY");
literal_str!(ZipMime, "application/zip");
literal_str!(DreamProvenance, "dream");
literal_str!(RebuildPendingCode, "EMBEDDING_REBUILD_PENDING");
literal_str!(LexicalOnlyCode, "LEXICAL_ONLY");
literal_str!(AssetStillReferencedCode, "ASSET_STILL_REFERENCED");
literal_str!(SealedAlgorithm, "X25519-HKDF-SHA256-AES256GCM");

/// The JSON literal `true`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if bool::deserialize(d)? {
            Ok(True)
        } else {
            Err(D::Error::custom("expected true"))
        }
    }
}

/// A fixed integer literal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ConstU64<const N: u64>;

impl<const N: u64> Serialize for ConstU64<N> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(N)
    }
}

impl<'de, const N: u64> Deserialize<'de> for ConstU64<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if schema::safe_integer(&Value::deserialize(d)?)
            .is_some_and(|n| u64::try_from(n).ok() == Some(N))
        {
            Ok(ConstU64)
        } else {
            Err(D::Error::custom("literal"))
        }
    }
}

// ── Enums ───────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Read,
    Propose,
    Write,
    Review,
    Manage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteMode {
    Direct,
    ProposalRequired,
    ReadOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IndexState {
    Pending,
    Building,
    Indexing,
    Complete,
    Failed,
    Superseded,
}

impl IndexState {
    pub fn as_str(self) -> &'static str {
        match self {
            IndexState::Pending => "PENDING",
            IndexState::Building => "BUILDING",
            IndexState::Indexing => "INDEXING",
            IndexState::Complete => "COMPLETE",
            IndexState::Failed => "FAILED",
            IndexState::Superseded => "SUPERSEDED",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    Current,
    Stale,
    Building,
    Failed,
    Unavailable,
}

/// What a `knowledge_embedding_profile_set` left in place: `Pending` = a
/// semantic generation of that profile is scheduled or building; `Current` =
/// the active one already serves that exact profile at the head, so nothing
/// was started (re-attaching is a no-op).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProfileSetState {
    Pending,
    Current,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RebuildPendingReason {
    EmbeddingSettingsChanged,
    EmbeddingModelChanged,
    EmbeddingRuntimeReloading,
}

/// Why a search ran over a lexical-only (FTS5, no vectors) generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LexicalOnlyReason {
    NoEmbeddingProfile,
    EmbeddingProfileRevoked,
    EmbeddingProfileUnavailable,
    /// The KB's desired generation is a hybrid one still pending or building.
    SemanticIndexBuilding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProviderKind {
    OpenaiCompat,
    SystemBuiltin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderStatus {
    Ready,
    Revoked,
    Unavailable,
}

/// Trusted asset/upload MIME allowlist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Mime {
    #[serde(rename = "text/markdown")]
    TextMarkdown,
    #[serde(rename = "text/plain")]
    TextPlain,
    #[serde(rename = "text/csv")]
    TextCsv,
    #[serde(rename = "application/json")]
    ApplicationJson,
    #[serde(rename = "application/pdf")]
    ApplicationPdf,
    #[serde(rename = "image/png")]
    ImagePng,
    #[serde(rename = "image/jpeg")]
    ImageJpeg,
    #[serde(rename = "image/gif")]
    ImageGif,
    #[serde(rename = "image/webp")]
    ImageWebp,
    #[serde(rename = "image/svg+xml")]
    ImageSvgXml,
    #[serde(rename = "audio/mpeg")]
    AudioMpeg,
    #[serde(rename = "audio/wav")]
    AudioWav,
    #[serde(rename = "audio/ogg")]
    AudioOgg,
    #[serde(rename = "video/mp4")]
    VideoMp4,
    #[serde(rename = "video/webm")]
    VideoWebm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    Hybrid,
    Structured,
    Lexical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PrStatus {
    Open,
    Conflict,
    Closed,
    Merged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileDeltaStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApplyKind {
    Applied,
    Proposed,
    Noop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangesMode {
    Edit,
    Dream,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadKind {
    Markdown,
    Asset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    Assets,
    Whole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewDecision {
    Merge,
    Close,
}

/// Review confirm; must match the decision (`MERGE` for merge, `CLOSE` for close).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewConfirm {
    Merge,
    Close,
}

// ── Shared shapes ───────────────────────────────────────────────────────────

/// Page of results; `nextCursor` is always present.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page<T> {
    pub items: Vec<T>,
    #[serde(deserialize_with = "nullable")]
    pub next_cursor: Option<String>,
}

/// Nested page request (`knowledge_pull_requests_get.page`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageInput {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub limit: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "optional_nullable"
    )]
    pub cursor: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KbAttachment {
    pub id: KbId,
    pub name: String,
    pub slug: Slug,
    pub description: String,
    pub default_branch: MainBranch,
    pub head_sha: Sha,
    pub metadata_version: i64,
    pub capabilities: Vec<Permission>,
    pub write_mode: WriteMode,
    #[serde(deserialize_with = "nullable")]
    pub embedding_generation: Option<KbId>,
    pub attachment_locator: String,
    pub sealed_namespace: Uuid,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexStatus {
    #[serde(deserialize_with = "nullable")]
    pub active_generation_id: Option<KbId>,
    #[serde(deserialize_with = "nullable")]
    pub desired_generation_id: Option<KbId>,
    pub desired_epoch: String,
    #[serde(deserialize_with = "nullable")]
    pub active_state: Option<IndexState>,
    #[serde(deserialize_with = "nullable")]
    pub desired_state: Option<IndexState>,
    #[serde(deserialize_with = "nullable")]
    pub indexed_commit_sha: Option<Sha>,
    pub head_sha: Sha,
    #[serde(deserialize_with = "nullable")]
    pub dimensions: Option<i64>,
    #[serde(deserialize_with = "nullable")]
    pub fingerprint: Option<ContentHash>,
    pub freshness: Freshness,
    #[serde(deserialize_with = "nullable")]
    pub error_code: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub rebuild_pending: Option<RebuildPendingReason>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebuildPendingNotice {
    pub kb_id: KbId,
    pub code: RebuildPendingCode,
    pub detail: RebuildPendingReason,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LexicalOnlyNotice {
    pub kb_id: KbId,
    pub code: LexicalOnlyCode,
    pub detail: LexicalOnlyReason,
}

/// One `indexNotices` entry: a built-in rebuild notice or a
/// lexical-only notice, told apart by `code`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum IndexNotice {
    RebuildPending(RebuildPendingNotice),
    LexicalOnly(LexicalOnlyNotice),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSummary {
    pub provider_id: ProviderRef,
    pub revision: i64,
    pub kind: ProviderKind,
    pub name: String,
    pub model: String,
    pub dimensions: i64,
    pub context_tokens: Option<i64>,
    pub status: ProviderStatus,
}

/// Untrusted citation text; render clickable only for safe schemes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocCitation {
    pub label: String,
    pub target: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetRef {
    pub path: KbPath,
    pub hash: ContentHash,
    pub size: u64,
    pub mime: Mime,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub path: KbPath,
    #[serde(deserialize_with = "nullable")]
    pub document_id: Option<String>,
    pub markdown: String,
    /// Bounded open object (64 KiB JSON, depth 16); unknown keys retained.
    pub front_matter: Map<String, Value>,
    pub commit_sha: Sha,
    pub blob_sha: Sha,
    pub content_hash: ContentHash,
    pub document_citations: Vec<DocCitation>,
    pub asset_refs: Vec<AssetRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentListItem {
    pub path: KbPath,
    #[serde(deserialize_with = "nullable")]
    pub document_id: Option<String>,
    pub commit_sha: Sha,
    pub blob_sha: Sha,
    pub size: u64,
}

/// Token ordinals are source-body whitespace-word ordinals; bytes are UTF-8
/// body bytes after front matter. Ends are exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitationSpan {
    pub start_token: u64,
    pub end_token: u64,
    pub start_byte: u64,
    pub end_byte: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitationHit {
    pub knowledge_base_id: KbId,
    pub knowledge_base_name: String,
    pub path: KbPath,
    #[serde(deserialize_with = "nullable")]
    pub document_id: Option<String>,
    pub commit_sha: Sha,
    pub blob_sha: Sha,
    pub content_hash: ContentHash,
    pub chunk_index: u64,
    pub span: CitationSpan,
    pub snippet: String,
    #[serde(with = "js_number")]
    pub score: f64,
    pub mode: SearchMode,
    pub index_generation_id: KbId,
    pub freshness: Freshness,
    pub document_citations: Vec<DocCitation>,
    pub asset_refs: Vec<AssetRef>,
    /// Exact matched GFM table row (JSON scalars only) for structured hits.
    #[serde(deserialize_with = "nullable")]
    pub matched_row: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub source_branch: String,
    pub target_branch: MainBranch,
    pub base_sha: Sha,
    pub head_sha: Sha,
    pub target_sha: Sha,
    pub status: PrStatus,
    pub author_actor_key: String,
    pub version: u64,
    #[serde(deserialize_with = "nullable")]
    pub merge_commit_sha: Option<Sha>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDelta {
    pub path: KbPath,
    pub status: FileDeltaStatus,
    #[serde(deserialize_with = "nullable")]
    pub before_blob_sha: Option<Sha>,
    #[serde(deserialize_with = "nullable")]
    pub after_blob_sha: Option<Sha>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetDelta {
    pub path: KbPath,
    #[serde(deserialize_with = "nullable")]
    pub before: Option<AssetRef>,
    #[serde(deserialize_with = "nullable")]
    pub after: Option<AssetRef>,
}

/// Outcome of every mutation that writes Git content.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyResult {
    pub operation_id: Uuid,
    pub kind: ApplyKind,
    pub commit_sha: Sha,
    pub base_revision: Sha,
    #[serde(deserialize_with = "nullable")]
    pub proposal: Option<PrSummary>,
    pub changed_paths: Vec<KbPath>,
    pub source_session_ids: Vec<Uuid>,
    #[serde(deserialize_with = "nullable")]
    pub index_job_id: Option<Uuid>,
    /// L-22: non-blocking notes; omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ApplyWarning>,
}

/// An asset removed while documents of the resulting tree still link to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyWarning {
    pub code: AssetStillReferencedCode,
    pub path: KbPath,
    /// Up to 20 referencing documents.
    pub referenced_by: Vec<KbPath>,
}

/// Inline Markdown (≤128 KiB, no C0 controls except tab/CR/LF) or a finished
/// Markdown upload.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TextInput {
    Markdown(InlineMarkdown),
    Upload(UploadedText),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InlineMarkdown {
    pub markdown: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadedText {
    pub upload_id: Uuid,
}

/// One atomic change in `knowledge_changes_apply` (edit mode).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Change {
    Create { path: KbPath, content: TextInput },
    Replace { path: KbPath, content: TextInput },
    Delete { path: KbPath },
    AssetPut { path: KbPath, upload_id: Uuid },
    AssetRemove { path: KbPath },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DreamModel {
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DreamUpsert {
    pub id: ConceptId,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(deserialize_with = "nullable")]
    pub title: Option<String>,
    /// Inline body, at most 64 KiB UTF-8.
    pub body: String,
    pub citations: Vec<DocCitation>,
    pub provenance: DreamProvenance,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DreamMetadata {
    pub model: DreamModel,
    pub redaction_applied: True,
    pub upserts: Vec<DreamUpsert>,
}

/// Recipient-encrypted sealed literal. Ciphertext only — the plaintext never
/// travels through agent-visible data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealedEnvelope {
    pub algorithm: SealedAlgorithm,
    pub ephemeral_public_key: String,
    pub nonce: String,
    pub ciphertext: String,
}

/// `structured[].equals`: string, boolean, null or finite number.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonScalar {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuredCondition {
    pub column: String,
    pub equals: JsonScalar,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimestampRange {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub after: Option<IsoInstant>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub before: Option<IsoInstant>,
}

// ── Tool inputs and outputs ─────────────────────────────────────────────────

// Field kinds: `req` required; `opt` optional input key (absent, never null);
// `null` nullable output key (always present); `cursor` optional and nullable;
// `list` optional input list whose absence means empty (always serialized, so
// an omitted list and `[]` are the same request).
macro_rules! tool_structs {
    ($( $(#[$doc:meta])* $name:ident { $( $field:ident : $kind:ident $ty:ty ),* $(,)? } )*) => {
        $( tool_struct!($(#[$doc])* $name [] $( $field $kind ($ty) )*); )*
    };
}

macro_rules! tool_struct {
    ($(#[$doc:meta])* $name:ident [$($done:tt)*]) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $($done)* }
    };
    ($(#[$doc:meta])* $name:ident [$($done:tt)*] $field:ident req ($ty:ty) $($rest:tt)*) => {
        tool_struct!($(#[$doc])* $name [$($done)* pub $field: $ty,] $($rest)*);
    };
    ($(#[$doc:meta])* $name:ident [$($done:tt)*] $field:ident opt ($ty:ty) $($rest:tt)*) => {
        tool_struct!($(#[$doc])* $name [$($done)*
            #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
            pub $field: Option<$ty>,] $($rest)*);
    };
    ($(#[$doc:meta])* $name:ident [$($done:tt)*] $field:ident list ($ty:ty) $($rest:tt)*) => {
        tool_struct!($(#[$doc])* $name [$($done)*
            #[serde(default)]
            pub $field: $ty,] $($rest)*);
    };
    ($(#[$doc:meta])* $name:ident [$($done:tt)*] $field:ident null ($ty:ty) $($rest:tt)*) => {
        tool_struct!($(#[$doc])* $name [$($done)*
            #[serde(deserialize_with = "nullable")]
            pub $field: Option<$ty>,] $($rest)*);
    };
    ($(#[$doc:meta])* $name:ident [$($done:tt)*] $field:ident cursor ($ty:ty) $($rest:tt)*) => {
        tool_struct!($(#[$doc])* $name [$($done)*
            #[serde(default, skip_serializing_if = "Option::is_none", with = "optional_nullable")]
            pub $field: Option<Option<$ty>>,] $($rest)*);
    };
}

tool_structs! {
    /// `knowledge_bases_list` input.
    BasesListInput { limit: opt u64, cursor: cursor String }
    /// `knowledge_bases_get`, `knowledge_index_status`, `knowledge_embedding_profile_get` input.
    KbRef { kb_id: req KbId }
    BasesGetOutput { kb: req KbAttachment, index: req IndexStatus }
    BasesCreateInput {
        name: req String, slug: req Slug, description: req String,
        idempotency_key: req IdempotencyKey,
    }
    /// Output of `knowledge_bases_create` and `knowledge_bases_update`.
    KbMutationOutput { operation_id: req Uuid, kb: req KbAttachment }
    BasesUpdateInput {
        kb_id: req KbId, metadata_version: req i64, idempotency_key: req IdempotencyKey,
        name: opt String, description: opt String,
    }
    BasesDeleteInput {
        kb_id: req KbId, metadata_version: req i64, idempotency_key: req IdempotencyKey,
        confirm: req DeleteConfirm,
    }
    BasesDeleteOutput { operation_id: req Uuid, tombstoned: req True }
    DocumentsListInput {
        kb_id: req KbId, rev: opt Sha, limit: opt u64, cursor: cursor String, prefix: opt KbPathPrefix,
    }
    DocumentsGetInput { kb_id: req KbId, rev: opt Sha, path: req KbPath }
    SearchInput {
        kb_id: req KbId, query: req String, limit: opt u64, path_prefix: opt KbPathPrefix,
        document_id: opt String,
    }
    SearchOutput {
        results: req Vec<CitationHit>, generation_id: req KbId, freshness: req Freshness,
        indexed_commit_sha: null Sha, head_sha: req Sha, index_notices: req Vec<IndexNotice>,
    }
    StructuredSearchInput {
        kb_id: req KbId, limit: opt u64, cursor: cursor String, query: opt String,
        r#type: opt String, title: opt String, tags: opt Vec<String>,
        timestamp: opt TimestampRange, structured: opt Vec<StructuredCondition>,
    }
    StructuredSearchOutput {
        items: req Vec<CitationHit>, next_cursor: null String, generation_id: req KbId,
        freshness: req Freshness, indexed_commit_sha: null Sha, head_sha: req Sha,
        index_notices: req Vec<IndexNotice>,
    }
    ChangesApplyInput {
        kb_id: req KbId, base_revision: req Sha, idempotency_key: req IdempotencyKey,
        mode: req ChangesMode, proposal_number: opt u64, proposal_head_sha: opt Sha,
        title: opt String,
        changes: req Vec<Change>, source_session_ids: list Vec<Uuid>, dream: opt DreamMetadata,
    }
    /// `knowledge_documents_create` / `knowledge_documents_update` input.
    DocumentWriteInput {
        kb_id: req KbId, base_revision: req Sha, idempotency_key: req IdempotencyKey,
        path: req KbPath, content: req TextInput,
        proposal_number: opt u64, proposal_head_sha: opt Sha,
    }
    DocumentsDeleteInput {
        kb_id: req KbId, base_revision: req Sha, idempotency_key: req IdempotencyKey,
        path: req KbPath, confirm: req DeleteConfirm,
        proposal_number: opt u64, proposal_head_sha: opt Sha,
    }
    UploadBeginInput {
        kb_id: req KbId, idempotency_key: req IdempotencyKey, kind: req UploadKind,
        size: req u64, content_hash: req ContentHash, mime: req Mime,
    }
    UploadBeginOutput {
        operation_id: req Uuid, upload_id: req Uuid, offset: req ConstU64<0>,
        expires_at: req IsoInstant, max_chunk_bytes: req ConstU64<196608>,
    }
    UploadWriteInput { kb_id: req KbId, upload_id: req Uuid, offset: req u64, bytes_base64: req String }
    UploadWriteOutput { upload_id: req Uuid, offset: req u64 }
    UploadRef { kb_id: req KbId, upload_id: req Uuid }
    UploadFinishOutput {
        upload_id: req Uuid, content_hash: req ContentHash, size: req u64, mime: req Mime,
        state: req ReadyState, expires_at: req IsoInstant,
    }
    AssetsPutInput {
        kb_id: req KbId, base_revision: req Sha, idempotency_key: req IdempotencyKey,
        path: req KbPath, upload_id: req Uuid,
        proposal_number: opt u64, proposal_head_sha: opt Sha,
    }
    AssetSource { kb_id: req KbId, rev: req Sha, hash: req ContentHash }
    AssetsImportInput {
        kb_id: req KbId, base_revision: req Sha, idempotency_key: req IdempotencyKey,
        path: req KbPath, source: req AssetSource,
        proposal_number: opt u64, proposal_head_sha: opt Sha,
    }
    AssetsListInput { kb_id: req KbId, rev: opt Sha, limit: opt u64, cursor: cursor String }
    ExportPrepareInput {
        kb_id: req KbId, rev: opt Sha, kind: req ExportKind, idempotency_key: req IdempotencyKey,
    }
    ExportPrepareOutput {
        operation_id: req Uuid, transfer_id: req Uuid, rev: req Sha, size: req u64,
        content_hash: req ContentHash, expires_at: req IsoInstant, mime: req ZipMime,
    }
    TransferReadInput { kb_id: req KbId, transfer_id: req Uuid, offset: req u64, max_bytes: opt u64 }
    TransferReadOutput {
        transfer_id: req Uuid, offset: req u64, next_offset: req u64, bytes_base64: req String,
        eof: req bool, content_hash: req ContentHash,
    }
    TransferRef { kb_id: req KbId, transfer_id: req Uuid }
    ExportCompleteOutput { transfer_id: req Uuid, released: req True }
    IndexRebuildInput { kb_id: req KbId, idempotency_key: req IdempotencyKey, confirm: req RunConfirm }
    /// Output of `knowledge_index_rebuild`.
    GenerationJobOutput {
        operation_id: req Uuid, generation_id: req KbId, job_id: req Uuid, state: req PendingState,
    }
    /// `knowledge_embedding_profile_set` output.
    ProfileSetOutput {
        operation_id: req Uuid, generation_id: req KbId, job_id: req Uuid,
        state: req ProfileSetState,
    }
    EmbeddingProfileOutput { profile: null ProviderSummary, index: req IndexStatus }
    EmbeddingProfileSetInput {
        kb_id: req KbId, provider_id: req ProviderRef, revision: opt i64,
        idempotency_key: req IdempotencyKey, confirm: req RunConfirm,
    }
    PullRequestsListInput {
        kb_id: req KbId, limit: opt u64, cursor: cursor String, status: opt PrStatus,
    }
    PullRequestsGetInput {
        kb_id: req KbId, number: req u64, page: opt PageInput, expected_head_sha: opt Sha,
    }
    PullRequestsGetOutput {
        pr: req PrSummary, files: req Vec<FileDelta>, touched_assets: req Vec<AssetDelta>,
        next_cursor: null String,
    }
    PullRequestsCreateInput {
        kb_id: req KbId, head_branch: req String, expected_head_sha: req Sha,
        expected_target_sha: req Sha, title: req String, idempotency_key: req IdempotencyKey,
    }
    PrMutationOutput { operation_id: req Uuid, pr: req PrSummary }
    PullRequestsReviewInput {
        kb_id: req KbId, number: req u64, decision: req ReviewDecision,
        expected_head_sha: req Sha, expected_target_sha: req Sha,
        idempotency_key: req IdempotencyKey, confirm: req ReviewConfirm,
    }
    SealedResolveInput {
        kb_id: req KbId, rev: opt Sha, path: req KbPath, reference: req String,
        recipient_key_id: req Uuid,
    }
    SealedResolveOutput {
        reference: req String, recipient_key_id: req Uuid, envelope: req SealedEnvelope,
        expires_at: req IsoInstant,
    }
}

// ── Catalog ─────────────────────────────────────────────────────────────────

/// One kb/1 catalog tool with owned, thread-safe input and output so the HTTP
/// transport can validate them off the async executor under call control.
pub trait Tool {
    const NAME: ToolName;
    type Input: Serialize + DeserializeOwned + fmt::Debug + Clone + PartialEq + Send + 'static;
    type Output: Serialize + DeserializeOwned + fmt::Debug + Clone + PartialEq + Send + 'static;
}

fn check_typed<T: Serialize + DeserializeOwned>(
    tool: &str,
    direction: Direction,
    value: Value,
) -> Result<Value, KbError> {
    let wrap = |violation| match direction {
        Direction::Input => KbError::Protocol(ProtocolError::InvalidInput(violation)),
        Direction::Output => KbError::Protocol(ProtocolError::InvalidOutput(violation)),
    };
    schema::validate(tool, direction, &value).map_err(wrap)?;
    let typed: T = serde_json::from_value(schema::normalize_integers(value))
        .map_err(|_| wrap(typed_violation()))?;
    serde_json::to_value(&typed).map_err(|_| wrap(typed_violation()))
}

pub(crate) fn typed_violation() -> schema::SchemaViolation {
    schema::SchemaViolation {
        pointer: String::new(),
        keyword: "typed-shape",
        member: None,
        min: None,
        max: None,
    }
}

macro_rules! catalog {
    ($( $variant:ident => $marker:ident, $wire:literal, $read_only:literal, $input:ty, $output:ty; )*) => {
        /// The pinned kb/1 tool catalog. Arbitrary operation names do not parse.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum ToolName { $( $variant, )* }

        impl ToolName {
            /// Every catalog tool.
            pub const ALL: &'static [ToolName] = &[ $( ToolName::$variant, )* ];

            /// Wire name.
            pub fn as_str(self) -> &'static str {
                match self { $( ToolName::$variant => $wire, )* }
            }

            /// Read tools accept `mcp:read` or `mcp:write`; others need `mcp:write`.
            pub fn read_only(self) -> bool {
                match self { $( ToolName::$variant => $read_only, )* }
            }

            /// Validate an untyped input against the contract and the typed
            /// shape; returns the canonical re-serialization.
            pub fn check_input(self, value: Value) -> Result<Value, KbError> {
                match self {
                    $( ToolName::$variant => check_typed::<$input>($wire, Direction::Input, value), )*
                }
            }

            /// Validate an untyped output against the contract and the typed
            /// shape; returns the canonical re-serialization.
            pub fn check_output(self, value: Value) -> Result<Value, KbError> {
                match self {
                    $( ToolName::$variant => check_typed::<$output>($wire, Direction::Output, value), )*
                }
            }

            /// Validate a complete success or domain-error envelope without
            /// changing its wire representation (agent forwarding).
            pub fn check_envelope(self, value: Value) -> Result<(), KbError> {
                match self {
                    $( ToolName::$variant => match crate::decode_envelope::<$marker>(value) {
                        Ok(_) | Err(KbError::Tool(_)) => Ok(()),
                        Err(error) => Err(error),
                    }, )*
                }
            }
        }

        impl FromStr for ToolName {
            type Err = KbError;
            fn from_str(s: &str) -> Result<Self, KbError> {
                match s {
                    $( $wire => Ok(ToolName::$variant), )*
                    _ => Err(KbError::Protocol(ProtocolError::UnknownTool)),
                }
            }
        }

        $(
            #[doc = concat!("Marker for `", $wire, "`.")]
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub struct $marker;

            impl Tool for $marker {
                const NAME: ToolName = ToolName::$variant;
                type Input = $input;
                type Output = $output;
            }
        )*
    };
}

catalog! {
    KnowledgeBasesList => BasesList, "knowledge_bases_list", true,
        BasesListInput, Page<KbAttachment>;
    KnowledgeBasesGet => BasesGet, "knowledge_bases_get", true, KbRef, BasesGetOutput;
    KnowledgeBasesCreate => BasesCreate, "knowledge_bases_create", false,
        BasesCreateInput, KbMutationOutput;
    KnowledgeBasesUpdate => BasesUpdate, "knowledge_bases_update", false,
        BasesUpdateInput, KbMutationOutput;
    KnowledgeBasesDelete => BasesDelete, "knowledge_bases_delete", false,
        BasesDeleteInput, BasesDeleteOutput;
    KnowledgeDocumentsList => DocumentsList, "knowledge_documents_list", true,
        DocumentsListInput, Page<DocumentListItem>;
    KnowledgeDocumentsGet => DocumentsGet, "knowledge_documents_get", true,
        DocumentsGetInput, Document;
    KnowledgeSearch => KnowledgeSearch, "knowledge_search", true, SearchInput, SearchOutput;
    KnowledgeStructuredSearch => StructuredSearch, "knowledge_structured_search", true,
        StructuredSearchInput, StructuredSearchOutput;
    KnowledgeChangesApply => ChangesApply, "knowledge_changes_apply", false,
        ChangesApplyInput, ApplyResult;
    KnowledgeDocumentsCreate => DocumentsCreate, "knowledge_documents_create", false,
        DocumentWriteInput, ApplyResult;
    KnowledgeDocumentsUpdate => DocumentsUpdate, "knowledge_documents_update", false,
        DocumentWriteInput, ApplyResult;
    KnowledgeDocumentsDelete => DocumentsDelete, "knowledge_documents_delete", false,
        DocumentsDeleteInput, ApplyResult;
    KnowledgeUploadBegin => UploadBegin, "knowledge_upload_begin", false,
        UploadBeginInput, UploadBeginOutput;
    KnowledgeUploadWrite => UploadWrite, "knowledge_upload_write", false,
        UploadWriteInput, UploadWriteOutput;
    KnowledgeUploadFinish => UploadFinish, "knowledge_upload_finish", false,
        UploadRef, UploadFinishOutput;
    KnowledgeAssetsPut => AssetsPut, "knowledge_assets_put", false, AssetsPutInput, ApplyResult;
    KnowledgeAssetsImport => AssetsImport, "knowledge_assets_import", false,
        AssetsImportInput, ApplyResult;
    KnowledgeAssetsList => AssetsList, "knowledge_assets_list", true,
        AssetsListInput, Page<AssetRef>;
    KnowledgeExportPrepare => ExportPrepare, "knowledge_export_prepare", true,
        ExportPrepareInput, ExportPrepareOutput;
    KnowledgeTransferRead => TransferRead, "knowledge_transfer_read", true,
        TransferReadInput, TransferReadOutput;
    KnowledgeExportComplete => ExportComplete, "knowledge_export_complete", true,
        TransferRef, ExportCompleteOutput;
    KnowledgeIndexStatus => IndexStatusGet, "knowledge_index_status", true, KbRef, IndexStatus;
    KnowledgeIndexRebuild => IndexRebuild, "knowledge_index_rebuild", false,
        IndexRebuildInput, GenerationJobOutput;
    KnowledgeEmbeddingProfileGet => EmbeddingProfileGet, "knowledge_embedding_profile_get", true,
        KbRef, EmbeddingProfileOutput;
    KnowledgeEmbeddingProfileSet => EmbeddingProfileSet, "knowledge_embedding_profile_set", false,
        EmbeddingProfileSetInput, ProfileSetOutput;
    KnowledgePullRequestsList => PullRequestsList, "knowledge_pull_requests_list", true,
        PullRequestsListInput, Page<PrSummary>;
    KnowledgePullRequestsGet => PullRequestsGet, "knowledge_pull_requests_get", true,
        PullRequestsGetInput, PullRequestsGetOutput;
    KnowledgePullRequestsCreate => PullRequestsCreate, "knowledge_pull_requests_create", false,
        PullRequestsCreateInput, PrMutationOutput;
    KnowledgePullRequestsReview => PullRequestsReview, "knowledge_pull_requests_review", false,
        PullRequestsReviewInput, PrMutationOutput;
    KnowledgeSealedResolve => SealedResolve, "knowledge_sealed_resolve", true,
        SealedResolveInput, SealedResolveOutput;
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroize;

    #[test]
    fn secret_token_owned_clones_use_the_zeroizing_wipe_primitive() {
        let token = SecretToken::new("synthetic-canary".to_owned());
        let mut cloned = token.clone();
        assert_ne!(cloned.0.as_ptr(), token.0.as_ptr());
        let pointer = cloned.0.as_ptr();
        let capacity = cloned.0.capacity();
        // Same Zeroize<String> primitive that Zeroizing<String>::drop invokes.
        // Inspect live state only; never read freed or inaccessible memory.
        cloned.0.zeroize();
        assert!(cloned.expose_secret().is_empty());
        assert_eq!(cloned.0.capacity(), capacity);
        assert_eq!(cloned.0.as_ptr(), pointer);
        assert_eq!(token.expose_secret(), "synthetic-canary");
        assert_eq!(
            format!("{token:?} {cloned}"),
            "SecretToken([redacted]) [redacted]"
        );
    }

    #[test]
    fn index_notices_round_trip_both_codes_and_refuse_mixed_pairs() {
        let kb = "a".repeat(24);
        for (wire, expected) in [
            (
                serde_json::json!({"kbId":kb,"code":"EMBEDDING_REBUILD_PENDING","detail":"EMBEDDING_MODEL_CHANGED"}),
                IndexNotice::RebuildPending(RebuildPendingNotice {
                    kb_id: KbId::parse(&kb).expect("id"),
                    code: RebuildPendingCode,
                    detail: RebuildPendingReason::EmbeddingModelChanged,
                }),
            ),
            (
                serde_json::json!({"kbId":kb,"code":"LEXICAL_ONLY","detail":"NO_EMBEDDING_PROFILE"}),
                IndexNotice::LexicalOnly(LexicalOnlyNotice {
                    kb_id: KbId::parse(&kb).expect("id"),
                    code: LexicalOnlyCode,
                    detail: LexicalOnlyReason::NoEmbeddingProfile,
                }),
            ),
        ] {
            let decoded: IndexNotice = serde_json::from_value(wire.clone()).expect("notice");
            assert_eq!(decoded, expected);
            assert_eq!(serde_json::to_value(&decoded).expect("encode"), wire);
        }
        for mixed in [
            serde_json::json!({"kbId":kb,"code":"LEXICAL_ONLY","detail":"EMBEDDING_MODEL_CHANGED"}),
            serde_json::json!({"kbId":kb,"code":"EMBEDDING_REBUILD_PENDING","detail":"NO_EMBEDDING_PROFILE"}),
            serde_json::json!({"kbId":kb,"code":"LEXICAL_ONLY","detail":"NO_EMBEDDING_PROFILE","extra":1}),
        ] {
            assert!(serde_json::from_value::<IndexNotice>(mixed).is_err());
        }
    }
}
