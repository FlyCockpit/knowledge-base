//! Local dream mode of `knowledge_changes_apply` (CONTRACT "Atomic changes
//! and dreaming"; port of `packages/api/src/lib/kb/dream.ts`).
//!
//! Clients dream; the store is deterministic. A dream is ONE
//! change set through the shared service in [`crate::changes`]: one commit,
//! optional one proposal, one durable receipt — or a jobless noop receipt.
//!
//! * [`serialize_dream_markdown`] is byte-identical to the server's
//!   `serializeDreamMarkdown` (fixed key order, `JSON.stringify` scalars,
//!   citations sorted by label then target in UTF-16 code-unit order, the
//!   body verbatim after the closing delimiter); the shared golden corpus
//!   `fixtures/dream-golden.json` pins both sides.
//! * Paths come from the doc-ID map at the request base: an existing ID
//!   keeps its path, a new ID becomes `concepts/<id>.md`.
//! * Rejected before any effect: duplicate IDs, a sealed reference anywhere
//!   in the serialized document (never resolved — sealed values stay
//!   symbolic), a known credential pattern in the title, model metadata or
//!   any upsert field ([`crate::sensitive_text`], a conservative floor),
//!   and overwriting a document whose provenance is not `dream` (human, or
//!   absent = conservative human default) -> FORBIDDEN. Error texts are
//!   fixed and never echo the offending bytes.
//! * Git trailers carry `Kb-Op-Digest` / `Kb-Source-Digest` only, never raw
//!   source session IDs or model text. The receipt keeps the informational
//!   model and source metadata (`operation_intents.dream_json`).
//! * A proposed dream persists its metadata plus the merge-guard input
//!   (`guardTouchedPaths`, cumulative per ID, `existedAtBase` sticky) on the
//!   proposal row; [`crate::Store::dream_merge_guard`] re-checks provenance
//!   against current main at merge (the reviewed merge calls it): a later human edit,
//!   or the deletion of a path that existed at the proposal's base,
//!   conflicts instead of being overwritten by review.
//!
//! No deletions, asset edits, scheduler, watermark or model generation.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use kb_client::error::InvalidReason;
use kb_client::types::{DreamMetadata, DreamUpsert, KbId, KbPath, Sha, Uuid};
use ring::digest::{SHA256, digest};
use serde_json::{Map, Value, json};

use crate::git_read::{
    DOCUMENT_MAX_BYTES, EntryKind, GitError, GitRepo, IncomingBudget, ObjectKind, WalkBudget,
    walk_tree,
};
use crate::markdown::{YamlValue, find_sealed_references, parse_markdown};
use crate::sensitive_text::contains_known_credential_patterns;
use crate::store::{Store, StoreError};
use crate::tree::TREE_LIMITS;

/// Inline dream body cap (CONTRACT: 64 KiB each).
pub const DREAM_BODY_MAX_BYTES: usize = 64 * 1024;
/// Upserts per dream (CONTRACT: 8).
pub const MAX_UPSERTS: usize = 8;
/// Source sessions per change set (CONTRACT: 100).
pub const MAX_SOURCE_SESSIONS: usize = 100;

// ── Deterministic serialization ─────────────────────────────────────────────

/// JS `a < b` string order (UTF-16 code units).
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `JSON.stringify(string)`: serde_json escapes exactly the same set (`"`,
/// `\`, C0 controls with the short forms `\b \t \n \f \r`, lowercase
/// `\u00xx` otherwise) and leaves everything else, U+2028/9 included, raw.
fn js_string(value: &str) -> String {
    Value::String(value.to_owned()).to_string()
}

/// Deterministic dream Markdown for one upsert (see module docs).
pub fn serialize_dream_markdown(upsert: &DreamUpsert) -> String {
    let mut lines = vec![
        "---".to_owned(),
        format!("id: {}", js_string(upsert.id.as_str())),
        format!("type: {}", js_string(&upsert.kind)),
    ];
    if let Some(title) = &upsert.title {
        lines.push(format!("title: {}", js_string(title)));
    }
    lines.push("provenance: dream".to_owned());
    let mut citations: Vec<_> = upsert.citations.iter().collect();
    citations.sort_by(|a, b| utf16_cmp(&a.label, &b.label).then(utf16_cmp(&a.target, &b.target)));
    if !citations.is_empty() {
        lines.push("citations:".to_owned());
        for citation in citations {
            lines.push(format!(
                "  - label: {}\n    target: {}",
                js_string(&citation.label),
                js_string(&citation.target)
            ));
        }
    }
    lines.push("---".to_owned());
    format!("{}\n{}", lines.join("\n"), upsert.body)
}

/// The server's `stableJson`: object keys sorted (UTF-16), arrays in order.
fn stable_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| utf16_cmp(a.0, b.0));
            let body: Vec<String> = entries
                .into_iter()
                .map(|(k, v)| format!("{}:{}", js_string(k), stable_json(v)))
                .collect();
            format!("{{{}}}", body.join(","))
        }
        scalar => scalar.to_string(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let hex: String = digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

fn sorted_sessions(ids: &[Uuid]) -> Vec<Value> {
    let mut sorted: Vec<&str> = ids.iter().map(Uuid::as_str).collect();
    sorted.sort_by(|a, b| utf16_cmp(a, b));
    sorted
        .into_iter()
        .map(|s| Value::String(s.into()))
        .collect()
}

fn metadata_value(dream: &DreamMetadata) -> Value {
    // Serializing a typed kb/1 value cannot fail.
    serde_json::to_value(dream).unwrap_or(Value::Null)
}

/// `sha256:` digest of the dream and its sorted source sessions
/// (`dreamOperationDigest`).
pub fn operation_digest(dream: &DreamMetadata, source_session_ids: &[Uuid]) -> String {
    let payload = json!({
        "dream": metadata_value(dream),
        "sourceSessionIds": sorted_sessions(source_session_ids),
    });
    sha256_hex(stable_json(&payload).as_bytes())
}

/// `sha256:` digest of the sorted source session IDs
/// (`dreamSourceSessionsDigest`).
pub fn source_digest(source_session_ids: &[Uuid]) -> String {
    sha256_hex(stable_json(&Value::Array(sorted_sessions(source_session_ids))).as_bytes())
}

/// `formatDreamCommitMessage`: the title with CR/LF folded to spaces and
/// trimmed, then the digest trailers only.
pub fn format_dream_commit_message(
    title: &str,
    source_session_ids: &[Uuid],
    dream: &DreamMetadata,
) -> String {
    let safe = title.replace("\r\n", " ").replace(['\r', '\n'], " ");
    format!(
        "{}\n\nKb-Op-Digest: {}\nKb-Source-Digest: {}",
        trim_js(&safe),
        operation_digest(dream, source_session_ids),
        source_digest(source_session_ids)
    )
}

/// `String.prototype.trim`: JS white space and line terminators.
fn trim_js(text: &str) -> &str {
    let js_space = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    text.trim_matches(js_space)
}

/// Informational receipt metadata (never delegated identity).
pub(crate) fn receipt_json(dream: &DreamMetadata, source_session_ids: &[Uuid]) -> String {
    json!({
        "model": { "provider": dream.model.provider, "model": dream.model.model },
        "sourceSessionIds": source_session_ids.iter().map(Uuid::as_str).collect::<Vec<_>>(),
        "upsertIds": dream.upserts.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(),
        "opDigest": operation_digest(dream, source_session_ids),
        "sourceDigest": source_digest(source_session_ids),
    })
    .to_string()
}

// ── Upfront (lock-free) validation ─────────────────────────────────────────

fn sensitive() -> StoreError {
    StoreError::InvalidArgument("dream contains a known credential pattern".into())
}

/// Request-level checks, before any lock or effect: dream shape limits
/// (also enforced by the shared schema), unique non-empty sources for real
/// work, and the credential floor over the title and model metadata.
pub(crate) fn validate_request(
    title: &str,
    source_session_ids: &[Uuid],
    dream: &DreamMetadata,
) -> Result<(), StoreError> {
    let bad = |what: &str| Err(StoreError::InvalidArgument(what.into()));
    if dream.upserts.len() > MAX_UPSERTS {
        return bad("at most 8 dream upserts");
    }
    let mut ids = HashSet::new();
    if !dream.upserts.iter().all(|u| ids.insert(u.id.as_str())) {
        return bad("duplicate dream upsert ids");
    }
    if dream
        .upserts
        .iter()
        .any(|u| u.body.len() > DREAM_BODY_MAX_BYTES)
    {
        return bad("dream upsert body exceeds 64 KiB");
    }
    let mut sessions = HashSet::new();
    if source_session_ids.len() > MAX_SOURCE_SESSIONS
        || !source_session_ids.iter().all(|id| sessions.insert(id))
    {
        return bad("sourceSessionIds must be unique");
    }
    if !dream.upserts.is_empty() && source_session_ids.is_empty() {
        return bad("nonempty dream work requires sourceSessionIds");
    }
    if [title, &dream.model.provider, &dream.model.model]
        .iter()
        .any(|text| contains_known_credential_patterns(text))
    {
        return Err(sensitive());
    }
    Ok(())
}

// ── Planning against a pinned commit ───────────────────────────────────────

/// Blob paths -> SHA and the document-ID map of one commit.
struct CommitDocs {
    blobs: HashMap<String, String>,
    ids: HashMap<String, String>,
    reader: crate::git_read::ObjectReader,
}

fn is_markdown_path(path: &str) -> bool {
    path.ends_with(".md")
}

fn commit_docs(repo: &GitRepo, commit: &Sha) -> Result<CommitDocs, StoreError> {
    let mut reader = repo.object_reader()?;
    let info = reader.read_commit(commit)?;
    let entries = walk_tree(
        &mut reader,
        &info.tree,
        &mut WalkBudget::new(TREE_LIMITS.max_entries),
        &mut IncomingBudget::new(
            TREE_LIMITS.max_objects,
            TREE_LIMITS.max_uncompressed_object_bytes,
            None,
        ),
    )?;
    let mut blobs = HashMap::new();
    let mut ids = HashMap::new();
    for entry in entries {
        if entry.kind != EntryKind::Blob {
            continue;
        }
        if is_markdown_path(&entry.path) {
            let bytes = read_blob(&mut reader, &entry.sha)?;
            // Last one wins in walk order, like the server's Map; the
            // whole-tree validator already forbids duplicate IDs.
            if let Some(id) = parse_markdown(&bytes).ok().and_then(|p| p.document_id) {
                ids.insert(id, entry.path.clone());
            }
        }
        blobs.insert(entry.path, entry.sha);
    }
    Ok(CommitDocs { blobs, ids, reader })
}

fn read_blob(reader: &mut crate::git_read::ObjectReader, sha: &str) -> Result<Vec<u8>, StoreError> {
    let (kind, bytes) = reader.read_checked(sha, DOCUMENT_MAX_BYTES, &mut |_, _| Ok(()))?;
    if kind != ObjectKind::Blob {
        return Err(GitError::Structure("tree entry is not a blob".into()).into());
    }
    Ok(bytes)
}

/// An upsert's path: its id's current path, or `concepts/<id>.md` for a new
/// id. An id mapping to a path the KB refuses (a reserved name such as
/// `con`) says why, at upsert `index`'s `id` (server parity).
fn resolve_path(
    id: &str,
    ids: &HashMap<String, String>,
    index: Option<usize>,
) -> Result<String, StoreError> {
    if let Some(path) = ids.get(id) {
        return Ok(path.clone());
    }
    let path = format!("concepts/{id}.md");
    match kb_client::check_kb_path(&path) {
        Ok(()) => KbPath::parse(&path)
            .map(|p| p.as_str().to_owned())
            .map_err(|_| StoreError::InvalidArgument("dream upsert id is not a valid path".into())),
        Err(issue) => Err(StoreError::invalid(
            match issue {
                kb_client::PathIssue::GitReserved | kb_client::PathIssue::WindowsReserved => {
                    InvalidReason::ReservedPath
                }
                kb_client::PathIssue::Control => InvalidReason::ControlCharacter,
                _ => InvalidReason::InvalidPath,
            },
            index.map(|i| format!("/dream/upserts/{i}/id")),
            "dream upsert id maps to a refused path",
        )),
    }
}

/// Only an explicit `provenance: dream` may be overwritten by a dream.
fn is_dream_provenance(bytes: &[u8]) -> Result<bool, StoreError> {
    let parsed = parse_markdown(bytes)
        .map_err(|_| StoreError::InvalidArgument("document is not valid Markdown".into()))?;
    Ok(matches!(
        parsed.front_matter.get("provenance"),
        Some(YamlValue::String(value)) if value == "dream"
    ))
}

/// One planned upsert: create (new ID) or replace (existing ID's path).
pub(crate) struct PlannedUpsert {
    pub path: KbPath,
    pub exists: bool,
    pub bytes: Vec<u8>,
}

/// Map every upsert onto the doc-ID map of `base` (step order matches the
/// server: duplicate ID, sealed reference, credential floor, path,
/// provenance — first failure wins, nothing is written).
pub(crate) fn plan_upserts(
    repo: &GitRepo,
    base: &Sha,
    dream: &DreamMetadata,
) -> Result<Vec<PlannedUpsert>, StoreError> {
    let mut docs = commit_docs(repo, base)?;
    let mut seen = HashSet::new();
    let mut planned = Vec::with_capacity(dream.upserts.len());
    for (index, upsert) in dream.upserts.iter().enumerate() {
        let at = |leaf: &str| Some(format!("/dream/upserts/{index}{leaf}"));
        if !seen.insert(upsert.id.as_str()) {
            return Err(StoreError::invalid(
                InvalidReason::Schema,
                at("/id"),
                "duplicate dream upsert ids",
            ));
        }
        let markdown = serialize_dream_markdown(upsert);
        if !find_sealed_references(&markdown).is_empty() {
            return Err(StoreError::invalid(
                InvalidReason::Schema,
                at(""),
                "dream upsert must not contain a sealed reference",
            ));
        }
        // Scan the original fields too: JSON escaping in the front matter
        // (e.g. a tab inside `Bearer<TAB>token`) could hide a literal.
        let fields = [
            upsert.id.as_str(),
            &upsert.kind,
            upsert.title.as_deref().unwrap_or(""),
            &upsert.body,
        ]
        .into_iter()
        .chain(
            upsert
                .citations
                .iter()
                .flat_map(|c| [c.label.as_str(), c.target.as_str()]),
        )
        .chain([markdown.as_str()]);
        for text in fields {
            if contains_known_credential_patterns(text) {
                return Err(StoreError::invalid(
                    InvalidReason::Schema,
                    at(""),
                    "dream contains a known credential pattern",
                ));
            }
        }
        let path = resolve_path(upsert.id.as_str(), &docs.ids, Some(index))?;
        let exists = docs.ids.contains_key(upsert.id.as_str());
        if exists && let Some(blob) = docs.blobs.get(&path).cloned() {
            let bytes = read_blob(&mut docs.reader, &blob)?;
            if !is_dream_provenance(&bytes)? {
                return Err(StoreError::Forbidden);
            }
        }
        planned.push(PlannedUpsert {
            path: KbPath::parse(&path)
                .map_err(|_| StoreError::InvalidArgument("dream path".into()))?,
            exists,
            bytes: markdown.into_bytes(),
        });
    }
    Ok(planned)
}

// ── Persisted merge-guard input ────────────────────────────────────────────

/// `{id: [(path, existedAtBase)]}`, sorted by id then path.
type GuardPaths = BTreeMap<String, BTreeMap<String, bool>>;

/// Touched path per upsert ID: resolved at the request base (the doc-ID map
/// the client planned against), existence judged at the proposal's
/// immutable original main base.
pub(crate) fn guard_touched_paths(
    repo: &GitRepo,
    request_base: &Sha,
    guard_base: &Sha,
    dream: &DreamMetadata,
) -> Result<GuardPaths, StoreError> {
    let request = commit_docs(repo, request_base)?;
    let base_blobs = if guard_base == request_base {
        request.blobs.clone()
    } else {
        commit_docs(repo, guard_base)?.blobs
    };
    let mut out = GuardPaths::new();
    for (index, upsert) in dream.upserts.iter().enumerate() {
        let path = resolve_path(upsert.id.as_str(), &request.ids, Some(index))?;
        let existed = base_blobs.contains_key(&path);
        out.entry(upsert.id.as_str().to_owned())
            .or_default()
            .insert(path, existed);
    }
    Ok(out)
}

fn guard_from_value(value: Option<&Value>) -> GuardPaths {
    let mut out = GuardPaths::new();
    let Some(Value::Object(map)) = value else {
        return out;
    };
    for (id, records) in map {
        let entry = out.entry(id.clone()).or_default();
        for record in records.as_array().into_iter().flatten() {
            if let (Some(path), Some(existed)) = (
                record.get("path").and_then(Value::as_str),
                record.get("existedAtBase").and_then(Value::as_bool),
            ) {
                let sticky = entry.get(path).copied().unwrap_or(false) || existed;
                entry.insert(path.to_owned(), sticky);
            }
        }
    }
    out
}

/// `mergePersistedDreamMetadata`: upserts merged by ID (latest wins, sorted
/// by ID), guard paths cumulative per ID with sticky `existedAtBase`, model
/// from the latest dream.
pub(crate) fn merge_persisted(
    existing: Option<&str>,
    incoming: &DreamMetadata,
    touched: &GuardPaths,
) -> Result<Value, StoreError> {
    let existing: Option<Value> = existing
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| StoreError::RecoveryRequired("persisted dream metadata".into()))?;
    let mut upserts: BTreeMap<String, Value> = BTreeMap::new();
    let prior = existing.as_ref();
    for upsert in prior
        .and_then(|v| v.get("upserts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = upsert.get("id").and_then(Value::as_str) {
            upserts.insert(id.to_owned(), upsert.clone());
        }
    }
    let incoming_value = metadata_value(incoming);
    for upsert in incoming_value
        .get("upserts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = upsert.get("id").and_then(Value::as_str) {
            upserts.insert(id.to_owned(), upsert.clone());
        }
    }
    let mut guard = guard_from_value(prior.and_then(|v| v.get("guardTouchedPaths")));
    for (id, paths) in touched {
        let entry = guard.entry(id.clone()).or_default();
        for (path, existed) in paths {
            let sticky = entry.get(path).copied().unwrap_or(false) || *existed;
            entry.insert(path.clone(), sticky);
        }
    }
    let mut guard_json = Map::new();
    for (id, paths) in guard {
        let mut records: Vec<(String, bool)> = paths.into_iter().collect();
        records.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
        guard_json.insert(
            id,
            Value::Array(
                records
                    .into_iter()
                    .map(|(path, existed)| json!({ "path": path, "existedAtBase": existed }))
                    .collect(),
            ),
        );
    }
    // IDs are ASCII, so byte order is the server's UTF-16 order.
    Ok(json!({
        "model": incoming_value.get("model").cloned().unwrap_or(Value::Null),
        "redactionApplied": true,
        "upserts": upserts.into_values().collect::<Vec<_>>(),
        "guardTouchedPaths": Value::Object(guard_json),
    }))
}

// ── Merge guard ────────────────────────────────────────────────────────────

fn violation(message: String) -> StoreError {
    StoreError::Conflict(message)
}

/// One guarded path on main: absent is a violation only when it existed at
/// the proposal's base; present must still be dream-owned.
fn guard_check(docs: &mut CommitDocs, path: &str, existed: bool) -> Result<(), StoreError> {
    match docs.blobs.get(path).cloned() {
        None if existed => Err(violation(format!(
            "main document at {path} was removed after the dream proposal"
        ))),
        None => Ok(()),
        Some(blob) => {
            let bytes = read_blob(&mut docs.reader, &blob)?;
            if is_dream_provenance(&bytes)? {
                Ok(())
            } else {
                Err(violation(format!(
                    "main document at {path} was modified with human provenance after the dream proposal"
                )))
            }
        }
    }
}

/// `evaluateDreamMergeGuard` against `main` for persisted metadata.
pub(crate) fn evaluate_merge_guard(
    repo: &GitRepo,
    main: &Sha,
    persisted: &Value,
) -> Result<(), StoreError> {
    let guard = guard_from_value(persisted.get("guardTouchedPaths"));
    let mut docs = commit_docs(repo, main)?;
    let mut checked = BTreeSet::new();
    for paths in guard.values() {
        let mut records: Vec<_> = paths.iter().collect();
        records.sort_by(|a, b| utf16_cmp(a.0, b.0));
        for (path, existed) in records {
            checked.insert(path.clone());
            guard_check(&mut docs, path, *existed)?;
        }
    }
    // Each touched ID's CURRENT main path too, so a human takeover of the ID
    // at a path the proposal never recorded still conflicts.
    let mut ids: BTreeSet<String> = guard.keys().cloned().collect();
    for upsert in persisted
        .get("upserts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = upsert.get("id").and_then(Value::as_str) {
            ids.insert(id.to_owned());
        }
    }
    for id in ids {
        let path = resolve_path(&id, &docs.ids, None)?;
        if checked.contains(&path) {
            continue;
        }
        checked.insert(path.clone());
        guard_check(&mut docs, &path, false)?;
    }
    Ok(())
}

impl Store {
    /// Persisted dream metadata + merge-guard input of proposal `number`
    /// (`None` when the proposal carries no dream). Inspection only.
    pub fn proposal_dream_metadata(
        &self,
        kb: &KbId,
        number: u64,
    ) -> Result<Option<Value>, StoreError> {
        let row = self.pr_row(kb, number)?.ok_or(StoreError::NotFound)?;
        row.dream_metadata
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| StoreError::RecoveryRequired("persisted dream metadata".into()))
    }

    /// The dream provenance merge guard for proposal `number` against the
    /// current main head: `Ok` when it carries no dream or every
    /// dream-touched path is still dream-owned (or legitimately absent),
    /// CONFLICT otherwise. Reviewed merge must call this under
    /// the KB lock before publishing; review cannot bypass it.
    pub fn dream_merge_guard(&self, kb: &KbId, number: u64) -> Result<(), StoreError> {
        let Some(persisted) = self.proposal_dream_metadata(kb, number)? else {
            return Ok(());
        };
        let record = self.read_kb(kb)?;
        let main = record
            .head_sha
            .as_deref()
            .and_then(|s| Sha::parse(s).ok())
            .ok_or_else(|| StoreError::RecoveryRequired("active kb without head".into()))?;
        let repo = GitRepo::for_kb(&self.paths, kb)?;
        evaluate_merge_guard(&repo, &main, &persisted)
    }

    /// Informational dream metadata of receipt `op_id` (model, source
    /// sessions, upsert IDs, digests), if that operation was a dream.
    pub fn dream_receipt(&self, kb: &KbId, op_id: &Uuid) -> Result<Option<Value>, StoreError> {
        use rusqlite::OptionalExtension;
        let text: Option<Option<String>> = self
            .conn
            .query_row(
                "SELECT dream_json FROM operation_intents WHERE kb_id = ?1 AND op_id = ?2",
                (kb.as_str(), op_id.as_str()),
                |row| row.get(0),
            )
            .optional()?;
        text.flatten()
            .map(|t| serde_json::from_str(&t))
            .transpose()
            .map_err(|_| StoreError::RecoveryRequired("dream receipt".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_json_sorts_keys_by_utf16_and_keeps_array_order() {
        let value = json!({ "b": [2, 1], "a": { "\u{ff5e}": 1, "\u{1f600}": 2 }, "c": null });
        assert_eq!(
            stable_json(&value),
            "{\"a\":{\"\u{1f600}\":2,\"\u{ff5e}\":1},\"b\":[2,1],\"c\":null}"
        );
    }

    #[test]
    fn js_string_matches_json_stringify() {
        assert_eq!(
            js_string("a\"b\\c\u{8}\u{c}\n\r\t\u{1}\u{7f}\u{2028}"),
            "\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\u{7f}\u{2028}\""
        );
    }

    #[test]
    fn trim_js_matches_string_trim() {
        assert_eq!(trim_js("\u{feff} a b \u{3000}"), "a b");
    }

    #[test]
    fn guard_paths_merge_cumulatively_with_sticky_existence() {
        let dream: DreamMetadata = serde_json::from_value(json!({
            "model": { "provider": "p", "model": "m" },
            "redactionApplied": true,
            "upserts": [{ "id": "a", "type": "concept", "title": "a", "body": "a",
                          "citations": [], "provenance": "dream" }],
        }))
        .unwrap();
        let mut first = GuardPaths::new();
        first
            .entry("a".into())
            .or_default()
            .insert("notes/a.md".into(), true);
        let merged = merge_persisted(None, &dream, &first).unwrap();
        let mut moved = GuardPaths::new();
        let entry = moved.entry("a".into()).or_default();
        entry.insert("notes/moved.md".into(), true);
        entry.insert("notes/a.md".into(), false);
        let again = merge_persisted(Some(&merged.to_string()), &dream, &moved).unwrap();
        assert_eq!(
            again["guardTouchedPaths"]["a"],
            json!([
                { "path": "notes/a.md", "existedAtBase": true },
                { "path": "notes/moved.md", "existedAtBase": true },
            ])
        );
        assert_eq!(again["upserts"].as_array().unwrap().len(), 1);
    }
}
