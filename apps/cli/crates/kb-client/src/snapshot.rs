//! Retrieval with immutable `snapshot_source` (Cockpit `RemoteKb.retrieve`).
//!
//! Search (hybrid or structured) returns citations pinned to a commit. For
//! each distinct cited `(path, commitSha)` the helper fetches the document
//! with `knowledge_documents_get(path, rev = commitSha)` — never HEAD — and
//! verifies the returned bytes: commit, path, recomputed Git blob SHA-1 and
//! full-source `sha256:` content hash must all equal the hit's. Spans,
//! citations, asset refs and matched rows are carried through unchanged.
//! The index may lag main: an old revision still verifies after main moves.

use std::fmt;
use std::sync::Arc;

use ring::digest::{SHA1_FOR_LEGACY_USE_ONLY, SHA256, digest};
use serde::Deserialize;

use crate::client::{CallControl, ClientError, McpClient};
use crate::types::{
    CitationHit, ContentHash, Document, DocumentsGet, DocumentsGetInput, Freshness, IndexNotice,
    KbId, KnowledgeSearch, SearchInput, Sha, StructuredCondition, StructuredSearch,
    StructuredSearchInput, TimestampRange,
};

/// Why a retrieval was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotError {
    Client(ClientError),
    /// A hit names a KB other than the one searched.
    KbMismatch,
    /// The document is not from the cited commit (e.g. HEAD answered).
    CommitMismatch,
    PathMismatch,
    /// Recomputed Git blob SHA-1 differs from the hit or the label.
    BlobShaMismatch,
    /// Recomputed full-source SHA-256 differs from the hit or the label.
    ContentHashMismatch,
    /// Structured filters do not form a valid shared-contract request.
    InvalidFilters,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SnapshotError::Client(error) => error.fmt(f),
            SnapshotError::KbMismatch => f.write_str("search returned a hit from another kb"),
            SnapshotError::CommitMismatch => f.write_str("kb source is not from the cited commit"),
            SnapshotError::PathMismatch => f.write_str("kb source is not the cited path"),
            SnapshotError::BlobShaMismatch => f.write_str("kb source blob sha does not verify"),
            SnapshotError::ContentHashMismatch => {
                f.write_str("kb source content hash does not verify")
            }
            SnapshotError::InvalidFilters => f.write_str("invalid structured search filters"),
        }
    }
}

impl std::error::Error for SnapshotError {}

impl From<ClientError> for SnapshotError {
    fn from(error: ClientError) -> Self {
        SnapshotError::Client(error)
    }
}

/// Git blob object name: SHA-1 of `blob <len>\0<bytes>`.
pub fn git_blob_sha(bytes: &[u8]) -> Sha {
    let mut object = format!("blob {}\0", bytes.len()).into_bytes();
    object.extend_from_slice(bytes);
    let hex = to_hex(digest(&SHA1_FOR_LEGACY_USE_ONLY, &object).as_ref());
    Sha::parse(&hex).expect("sha-1 hex is a valid Sha")
}

/// `sha256:` + hex of the full source bytes (front matter included).
pub fn content_hash(bytes: &[u8]) -> ContentHash {
    let hex = to_hex(digest(&SHA256, bytes).as_ref());
    ContentHash::parse(&format!("sha256:{hex}")).expect("sha-256 hex is a valid ContentHash")
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Verify that `document` is exactly the immutable source `hit` cites.
pub fn verify_snapshot(hit: &CitationHit, document: &Document) -> Result<(), SnapshotError> {
    if document.commit_sha != hit.commit_sha {
        return Err(SnapshotError::CommitMismatch);
    }
    if document.path != hit.path {
        return Err(SnapshotError::PathMismatch);
    }
    let bytes = document.markdown.as_bytes();
    let blob = git_blob_sha(bytes);
    if blob != hit.blob_sha || blob != document.blob_sha {
        return Err(SnapshotError::BlobShaMismatch);
    }
    let hash = content_hash(bytes);
    if hash != hit.content_hash || hash != document.content_hash {
        return Err(SnapshotError::ContentHashMismatch);
    }
    Ok(())
}

/// A citation with its verified immutable source.
#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotSource {
    pub hit: CitationHit,
    /// Shared between hits citing the same `(path, commit)`.
    pub source: Arc<Document>,
}

/// `knowledge_search` hits with verified sources.
#[derive(Clone, Debug, PartialEq)]
pub struct Retrieval {
    pub hits: Vec<SnapshotSource>,
    pub generation_id: KbId,
    pub freshness: Freshness,
    pub indexed_commit_sha: Option<Sha>,
    pub head_sha: Sha,
    pub index_notices: Vec<IndexNotice>,
}

/// `knowledge_structured_search` items with verified sources.
#[derive(Clone, Debug, PartialEq)]
pub struct StructuredRetrieval {
    pub hits: Vec<SnapshotSource>,
    pub next_cursor: Option<String>,
    pub generation_id: KbId,
    pub freshness: Freshness,
    pub indexed_commit_sha: Option<Sha>,
    pub head_sha: Sha,
    pub index_notices: Vec<IndexNotice>,
}

/// Fetch one hit's cited bytes by `(path, rev = commitSha)` and verify them.
pub async fn fetch_snapshot(
    client: &McpClient,
    hit: &CitationHit,
    ctl: &CallControl,
) -> Result<Document, SnapshotError> {
    let input = DocumentsGetInput {
        kb_id: hit.knowledge_base_id.clone(),
        rev: Some(hit.commit_sha.clone()),
        path: hit.path.clone(),
    };
    let document = client.call::<DocumentsGet>(&input, ctl).await?;
    verify_snapshot(hit, &document)?;
    Ok(document)
}

async fn attach_sources(
    client: &McpClient,
    kb_id: &KbId,
    hits: Vec<CitationHit>,
    ctl: &CallControl,
) -> Result<Vec<SnapshotSource>, SnapshotError> {
    if hits.iter().any(|hit| &hit.knowledge_base_id != kb_id) {
        return Err(SnapshotError::KbMismatch);
    }
    // Bounded by the page size (<= 50); a linear scan keeps order stable.
    let mut fetched: Vec<Arc<Document>> = Vec::new();
    let mut out = Vec::with_capacity(hits.len());
    for hit in hits {
        let cached = fetched
            .iter()
            .find(|doc| doc.path == hit.path && doc.commit_sha == hit.commit_sha)
            .cloned();
        let source = match cached {
            Some(doc) => {
                // Same (path, commit) must cite the same bytes.
                verify_snapshot(&hit, &doc)?;
                doc
            }
            None => {
                let doc = Arc::new(fetch_snapshot(client, &hit, ctl).await?);
                fetched.push(doc.clone());
                doc
            }
        };
        out.push(SnapshotSource { hit, source });
    }
    Ok(out)
}

/// `RemoteKb.retrieve`: search, then fetch each cited immutable source.
pub async fn retrieve(
    client: &McpClient,
    input: &SearchInput,
    ctl: &CallControl,
) -> Result<Retrieval, SnapshotError> {
    let out = client.call::<KnowledgeSearch>(input, ctl).await?;
    let hits = attach_sources(client, &input.kb_id, out.results, ctl).await?;
    Ok(Retrieval {
        hits,
        generation_id: out.generation_id,
        freshness: out.freshness,
        indexed_commit_sha: out.indexed_commit_sha,
        head_sha: out.head_sha,
        index_notices: out.index_notices,
    })
}

/// Structured search, then fetch each cited immutable source.
pub async fn retrieve_structured(
    client: &McpClient,
    input: &StructuredSearchInput,
    ctl: &CallControl,
) -> Result<StructuredRetrieval, SnapshotError> {
    let out = client.call::<StructuredSearch>(input, ctl).await?;
    let hits = attach_sources(client, &input.kb_id, out.items, ctl).await?;
    Ok(StructuredRetrieval {
        hits,
        next_cursor: out.next_cursor,
        generation_id: out.generation_id,
        freshness: out.freshness,
        indexed_commit_sha: out.indexed_commit_sha,
        head_sha: out.head_sha,
        index_notices: out.index_notices,
    })
}

/// Cockpit's `StructuredSearchQuery` shape (`query`, `type`, `title`, `tags`,
/// `timestamp`, `structured`, `limit`), mapped one-to-one onto
/// `knowledge_structured_search`. Unknown keys and non-scalar `equals` are
/// rejected when parsing.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuredFilters {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub timestamp: Option<TimestampRange>,
    #[serde(default)]
    pub structured: Vec<StructuredCondition>,
    #[serde(default)]
    pub limit: Option<u64>,
}

impl StructuredFilters {
    /// Build the shared-contract request; the full kb/1 input contract
    /// (bounds, inverted ranges, query-or-filter) is enforced here.
    pub fn to_input(
        &self,
        kb_id: KbId,
        cursor: Option<String>,
    ) -> Result<StructuredSearchInput, SnapshotError> {
        let timestamp = self
            .timestamp
            .clone()
            .filter(|t| t.after.is_some() || t.before.is_some());
        let input = StructuredSearchInput {
            kb_id,
            limit: self.limit,
            cursor: cursor.map(Some),
            query: self.query.clone(),
            r#type: self.kind.clone(),
            title: self.title.clone(),
            tags: (!self.tags.is_empty()).then(|| self.tags.clone()),
            timestamp,
            structured: (!self.structured.is_empty()).then(|| self.structured.clone()),
        };
        let filtered = input.r#type.is_some()
            || input.title.is_some()
            || input.tags.is_some()
            || input.timestamp.is_some()
            || input.structured.is_some();
        if input.query.is_none() && !filtered {
            return Err(SnapshotError::InvalidFilters);
        }
        if let Some(TimestampRange {
            after: Some(after),
            before: Some(before),
        }) = &input.timestamp
            && crate::schema::compare_iso(after.as_str(), before.as_str())
                != Some(std::cmp::Ordering::Less)
        {
            return Err(SnapshotError::InvalidFilters);
        }
        crate::encode_input::<StructuredSearch>(&input)
            .map_err(|_| SnapshotError::InvalidFilters)?;
        Ok(input)
    }
}
