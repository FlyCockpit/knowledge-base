//! Shared whole-tree validation — a port of
//! `packages/api/src/lib/kb/validate-tree.ts` (and the manifest/path rules it
//! uses) with identical decisions on the shared corpus (`tests/trees.rs`).
//!
//! Rules: UTF-8/NFC/case-fold/Windows-safe relative paths (kb-client's path
//! normalizer), only `100644` blobs and `040000` trees, no symlinks,
//! executables or gitlinks, only `*.md`, the fixed `.gitignore` and the
//! canonical `.assets/manifest.json`; 4096 files, 8192 entries, depth 32,
//! 2 MiB per file, 64 MiB per tree; restricted YAML front matter; unique
//! document IDs. Manifest lineage and sealed-record lookup are REQUIRED
//! callbacks ([`TreePolicy`]); [`EmptyAssetsNoSealed`] is the initial policy
//! (empty manifest, no symbolic references). Every newly reachable commit is
//! validated, never only the tip, against one shared incoming-object budget.

use std::collections::HashMap;

use kb_client::types::Sha;
use kb_client::{casefold_path_key, check_kb_path};

use crate::git_read::{
    EntryKind, GitError, GitRepo, IncomingBudget, ObjectKind, ObjectReader, WalkBudget, walk_tree,
};
use crate::markdown::{parse_markdown, sealed_references_in, validate_markdown_bytes};

/// Tree budgets (`KB_TREE_LIMITS` in `packages/api/src/lib/kb/limits.ts`).
#[derive(Clone, Copy, Debug)]
pub struct TreeLimits {
    pub max_files: usize,
    pub max_entries: usize,
    pub max_tree_depth: usize,
    pub max_markdown_bytes: usize,
    pub max_tree_bytes: usize,
    pub max_new_commits: usize,
    pub max_objects: usize,
    pub max_uncompressed_object_bytes: usize,
}

pub const TREE_LIMITS: TreeLimits = TreeLimits {
    max_files: 4096,
    max_entries: 8192,
    max_tree_depth: crate::git_read::MAX_TREE_DEPTH,
    max_markdown_bytes: 2 * 1024 * 1024,
    max_tree_bytes: 64 * 1024 * 1024,
    max_new_commits: 512,
    max_objects: 100_000,
    max_uncompressed_object_bytes: 128 * 1024 * 1024,
};

/// `KB_MANAGED_GITIGNORE`.
pub const MANAGED_GITIGNORE: &[u8] = b"# kb managed\n";
pub const MANIFEST_PATH: &str = ".assets/manifest.json";
/// Largest immutable CAS blob.
pub const CAS_BLOB_MAX_BYTES: u64 = 25 * 1024 * 1024;
/// `CAS_SNIFF_MIME_TYPES` in `packages/api/src/lib/sniff-mime.ts`.
pub const CAS_MIME_TYPES: [&str; 10] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "application/pdf",
];

/// `TreeValidationErrorCode` (TREE_*).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeCode {
    Budget,
    Mode,
    Type,
    Path,
    FileKind,
    Required,
    Manifest,
    Markdown,
    DocumentId,
    Sealed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeViolation {
    pub code: TreeCode,
    pub message: String,
    pub path: Option<String>,
    /// The typed cause (reason), when one is known at the failing check.
    pub cause: Option<kb_client::error::InvalidReason>,
}

/// A tree is either invalid (deterministic verdict) or could not be read.
#[derive(Debug)]
pub enum TreeError {
    Invalid(TreeViolation),
    Git(GitError),
}

impl From<GitError> for TreeError {
    fn from(error: GitError) -> Self {
        match error {
            GitError::Budget(message) => violation(TreeCode::Budget, message, None),
            GitError::Structure(message) => violation(TreeCode::Path, message, None),
            other => TreeError::Git(other),
        }
    }
}

fn violation(code: TreeCode, message: impl Into<String>, path: Option<&str>) -> TreeError {
    TreeError::Invalid(TreeViolation {
        code,
        message: message.into(),
        path: path.map(str::to_owned),
        cause: None,
    })
}

/// A violation that keeps its typed cause through to the refusal.
fn violation_because(
    code: TreeCode,
    message: impl Into<String>,
    path: Option<&str>,
    cause: kb_client::error::InvalidReason,
) -> TreeError {
    TreeError::Invalid(TreeViolation {
        code,
        message: message.into(),
        path: path.map(str::to_owned),
        cause: Some(cause),
    })
}

/// One canonical manifest entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestEntry {
    pub path: String,
    pub hash: String,
    pub size: u64,
    pub mime: String,
}

/// A sealed reference (`sealed:v1:knowledge_base:<ns>:<record>`) at a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealedOccurrence {
    pub reference: String,
    pub path: String,
    /// The blob holding the reference at `path` (L-8: an unchanged blob's
    /// references were validated when it was written).
    pub blob: String,
}

/// Authority callbacks the validator cannot decide from Git alone. Both are
/// required; `commit` is the commit being validated (`None` for a bare tree).
pub trait TreePolicy {
    /// The entry must equal the trusted blob catalog and have lineage in this
    /// KB at `commit`. Structural manifest rules are already checked.
    fn check_manifest_entry(
        &self,
        commit: Option<&Sha>,
        entry: &ManifestEntry,
    ) -> Result<(), String>;

    /// Publication requires live enrollment in this KB's namespace; immutable
    /// snapshots may accept retained revoked identities. Return the first
    /// offending occurrence according to the caller's policy.
    fn check_sealed_references(
        &self,
        commit: Option<&Sha>,
        refs: &[SealedOccurrence],
    ) -> Result<(), SealedOccurrence>;
}

/// Initial local policy: no asset lineage and no sealed records exist, so
/// only an empty manifest and reference-free documents are accepted.
#[derive(Clone, Copy, Debug, Default)]
pub struct EmptyAssetsNoSealed;

impl TreePolicy for EmptyAssetsNoSealed {
    fn check_manifest_entry(
        &self,
        _commit: Option<&Sha>,
        _entry: &ManifestEntry,
    ) -> Result<(), String> {
        Err("manifest hash is not authorized for this knowledge base".to_owned())
    }

    fn check_sealed_references(
        &self,
        _commit: Option<&Sha>,
        refs: &[SealedOccurrence],
    ) -> Result<(), SealedOccurrence> {
        match refs.first() {
            Some(first) => Err(first.clone()),
            None => Ok(()),
        }
    }
}

// ── Path registry ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum PathKind {
    File,
    Dir,
}

/// Case-fold registry (`registerPath`/`registerPathWithPrefixes`).
#[derive(Clone, Default)]
struct PathRegistry {
    seen: HashMap<String, (String, PathKind)>,
}

impl PathRegistry {
    fn register(&mut self, path: &str, kind: PathKind) -> Result<(), String> {
        let key = casefold_path_key(path);
        if let Some((prior, prior_kind)) = self.seen.get(&key)
            && !(prior == path && *prior_kind == PathKind::Dir && kind == PathKind::Dir)
        {
            return Err(if prior == path {
                format!("duplicate tree entry path {path}")
            } else {
                format!("path case-folds to an existing entry ({prior})")
            });
        }
        self.seen.insert(key, (path.to_owned(), kind));
        Ok(())
    }

    fn register_with_prefixes(&mut self, path: &str, kind: PathKind) -> Result<(), String> {
        let segments: Vec<&str> = path.split('/').collect();
        for depth in 1..segments.len() {
            self.register(&segments[..depth].join("/"), PathKind::Dir)?;
        }
        self.register(path, kind)
    }
}

// ── Manifest ───────────────────────────────────────────────────────────────

/// Parse `.assets/manifest.json` (`parseAssetManifest`).
pub fn parse_manifest(bytes: &[u8]) -> Result<Vec<ManifestEntry>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "manifest is not valid JSON".to_owned())?;
    let record = value
        .as_object()
        .ok_or_else(|| "manifest must be an object".to_owned())?;
    if record.get("version").and_then(serde_json::Value::as_f64) != Some(1.0) {
        return Err("manifest version must be 1".to_owned());
    }
    let entries = match record.get("entries") {
        Some(serde_json::Value::Array(items)) if record.len() == 2 && items.len() <= 8192 => items,
        _ => return Err("manifest entries must be an array".to_owned()),
    };
    let mut out = Vec::with_capacity(entries.len());
    for item in entries {
        let row = item
            .as_object()
            .ok_or_else(|| "manifest entry must be an object".to_owned())?;
        let path = match row.get("path") {
            Some(serde_json::Value::String(path)) if row.len() == 4 => path.clone(),
            _ => return Err("manifest entry path must be a string".to_owned()),
        };
        let hash = match row.get("hash") {
            Some(serde_json::Value::String(hash)) if is_content_hash(hash) => hash.clone(),
            _ => return Err("manifest entry hash must be sha256".to_owned()),
        };
        let size = row
            .get("size")
            .and_then(serde_json::Value::as_f64)
            .filter(|n| n.fract() == 0.0 && *n >= 1.0)
            .ok_or_else(|| "manifest entry size must be a positive integer".to_owned())?;
        let mime = match row.get("mime") {
            Some(serde_json::Value::String(mime)) if !mime.is_empty() => mime.clone(),
            _ => return Err("manifest entry mime must be a string".to_owned()),
        };
        if size > CAS_BLOB_MAX_BYTES as f64 {
            return Err("manifest entry size exceeds CAS limit".to_owned());
        }
        if !CAS_MIME_TYPES.contains(&mime.as_str()) {
            return Err("manifest entry mime is not a trusted CAS type".to_owned());
        }
        out.push(ManifestEntry {
            path,
            hash,
            size: size as u64,
            mime,
        });
    }
    Ok(out)
}

fn is_content_hash(hash: &str) -> bool {
    hash.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Canonical manifest bytes: entries sorted by UTF-16 code unit order (the
/// JS `<` comparison), `JSON.stringify` layout, trailing newline.
pub fn canonical_manifest_bytes(entries: &[ManifestEntry]) -> Vec<u8> {
    let mut sorted: Vec<&ManifestEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
    let json = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let rows: Vec<String> = sorted
        .iter()
        .map(|e| {
            format!(
                "{{\"path\":{},\"hash\":{},\"size\":{},\"mime\":{}}}",
                json(&e.path),
                json(&e.hash),
                e.size,
                json(&e.mime)
            )
        })
        .collect();
    format!("{{\"version\":1,\"entries\":[{}]}}\n", rows.join(",")).into_bytes()
}

fn validate_manifest(
    bytes: &[u8],
    tree_paths: &PathRegistry,
    commit: Option<&Sha>,
    policy: &dyn TreePolicy,
) -> Result<(), TreeError> {
    let bad = |message: String, path: Option<&str>| {
        violation(
            TreeCode::Manifest,
            message,
            Some(path.unwrap_or(MANIFEST_PATH)),
        )
    };
    let entries = parse_manifest(bytes).map_err(|m| bad(m, None))?;
    if bytes != canonical_manifest_bytes(&entries).as_slice() {
        return Err(bad(
            "manifest must be canonical sorted JSON".to_owned(),
            None,
        ));
    }
    use kb_client::error::InvalidReason;
    let because = |message: String, path: &str, cause: InvalidReason| {
        violation_because(TreeCode::Manifest, message, Some(path), cause)
    };
    let mut seen = tree_paths.clone();
    for entry in &entries {
        if let Err(issue) = check_kb_path(&entry.path) {
            return Err(because(
                "manifest entry path is invalid".to_owned(),
                &entry.path,
                match issue {
                    kb_client::PathIssue::GitReserved | kb_client::PathIssue::WindowsReserved => {
                        InvalidReason::ReservedPath
                    }
                    kb_client::PathIssue::Control => InvalidReason::ControlCharacter,
                    _ => InvalidReason::InvalidPath,
                },
            ));
        }
        // An entry repeating another path (exactly, case-folded or across a file).
        seen.register_with_prefixes(&entry.path, PathKind::File)
            .map_err(|m| because(m, &entry.path, InvalidReason::PathCaseCollision))?;
        let key = casefold_path_key(&entry.path);
        let root = key.split('/').next().unwrap_or_default();
        if root == ".assets" || root == ".gitignore" {
            return Err(because(
                "manifest path is reserved".to_owned(),
                &entry.path,
                InvalidReason::ReservedPath,
            ));
        }
        policy
            .check_manifest_entry(commit, entry)
            .map_err(|m| bad(m, Some(&entry.path)))?;
    }
    Ok(())
}

// ── Validation ─────────────────────────────────────────────────────────────

/// A validated commit and its root tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedCommit {
    pub commit: Sha,
    pub tree: Sha,
}

fn is_markdown_path(path: &str) -> bool {
    path.ends_with(".md") || path == "index.md"
}

fn is_lfs_pointer(blob: &[u8]) -> bool {
    blob.starts_with(b"version https://git-lfs.github.com/spec/v1\n")
}

fn fresh_incoming(incoming: Option<std::collections::HashSet<String>>) -> IncomingBudget {
    IncomingBudget::new(
        TREE_LIMITS.max_objects,
        TREE_LIMITS.max_uncompressed_object_bytes,
        incoming,
    )
}

/// Validate one full tree (`validateTreeFromSource`). Per-tree budgets start
/// fresh; `incoming` is shared across a traversal range.
fn validate_tree_with(
    reader: &mut ObjectReader,
    tree: &Sha,
    commit: Option<&Sha>,
    policy: &dyn TreePolicy,
    incoming: &mut IncomingBudget,
) -> Result<(), TreeError> {
    let entries = walk_tree(
        reader,
        tree,
        &mut WalkBudget::new(TREE_LIMITS.max_entries),
        incoming,
    )?;
    let mut paths = PathRegistry::default();
    let mut document_ids: HashMap<String, String> = HashMap::new();
    let mut sealed: Vec<SealedOccurrence> = Vec::new();
    let mut manifest: Option<Vec<u8>> = None;
    let (mut has_gitignore, mut has_manifest, mut has_index) = (false, false, false);
    let (mut files, mut tree_bytes) = (0usize, 0usize);
    for entry in &entries {
        let path = entry.path.as_str();
        if entry.kind == EntryKind::Commit {
            return Err(violation(
                TreeCode::Type,
                "gitlink (submodule) entries are not allowed",
                Some(path),
            ));
        }
        if check_kb_path(path).is_err() {
            return Err(violation(
                TreeCode::Path,
                "path is not a valid kb path",
                Some(path),
            ));
        }
        if path.split('/').count() > TREE_LIMITS.max_tree_depth {
            return Err(violation(
                TreeCode::Path,
                "path exceeds depth budget",
                Some(path),
            ));
        }
        let kind = if entry.kind == EntryKind::Tree {
            PathKind::Dir
        } else {
            PathKind::File
        };
        // The raw tree walk emits every directory before its descendants.
        // Re-registering every ancestor here case-folds deep paths quadratically.
        paths
            .register(path, kind)
            .map_err(|m| violation(TreeCode::Path, m, Some(path)))?;
        if entry.kind == EntryKind::Tree {
            if entry.mode != "040000" {
                return Err(violation(
                    TreeCode::Mode,
                    "unsupported directory mode",
                    Some(path),
                ));
            }
            if path == ".gitignore" || path == MANIFEST_PATH {
                return Err(violation(
                    TreeCode::FileKind,
                    "reserved root file must be a regular file",
                    Some(path),
                ));
            }
            if path.starts_with(".assets/") {
                return Err(violation(
                    TreeCode::FileKind,
                    "only manifest.json is allowed under .assets",
                    Some(path),
                ));
            }
            continue;
        }
        if entry.mode != "100644" {
            return Err(violation(
                TreeCode::Mode,
                "unsupported file mode",
                Some(path),
            ));
        }
        if path.starts_with(".assets/") && path != MANIFEST_PATH {
            return Err(violation(
                TreeCode::FileKind,
                "only manifest.json is allowed under .assets",
                Some(path),
            ));
        }
        match path {
            ".gitignore" => has_gitignore = true,
            MANIFEST_PATH => has_manifest = true,
            "index.md" => has_index = true,
            _ if !is_markdown_path(path) => {
                return Err(violation(
                    TreeCode::FileKind,
                    "only Markdown files are allowed",
                    Some(path),
                ));
            }
            _ => {}
        }
        files += 1;
        if files > TREE_LIMITS.max_files {
            return Err(violation(
                TreeCode::Budget,
                "tree exceeds file budget",
                None,
            ));
        }
        // Size from the object header, then the shared incoming charge,
        // both before any content byte is read.
        let (object_kind, blob) = reader.read_checked(&entry.sha, usize::MAX, &mut |_, size| {
            if size > TREE_LIMITS.max_markdown_bytes {
                return Err(GitError::Budget("markdown exceeds size budget".into()));
            }
            incoming.charge(&entry.sha, size)
        })?;
        if object_kind != ObjectKind::Blob {
            return Err(violation(
                TreeCode::Path,
                "tree entry does not name a blob",
                Some(path),
            ));
        }
        tree_bytes += blob.len();
        if tree_bytes > TREE_LIMITS.max_tree_bytes {
            return Err(violation(
                TreeCode::Budget,
                "tree exceeds byte budget",
                None,
            ));
        }
        if path == ".gitignore" {
            if blob != MANAGED_GITIGNORE {
                return Err(violation(
                    TreeCode::FileKind,
                    "gitignore content is not the managed template",
                    Some(path),
                ));
            }
            continue;
        }
        if path == MANIFEST_PATH {
            manifest = Some(blob);
            continue;
        }
        let text = validate_markdown_bytes(&blob).map_err(|issue| {
            violation_because(
                TreeCode::Markdown,
                issue.message,
                Some(path),
                issue.code.reason(),
            )
        })?;
        if is_lfs_pointer(&blob) {
            return Err(violation(
                TreeCode::Markdown,
                "git LFS pointers are not supported",
                Some(path),
            ));
        }
        let parsed = parse_markdown(&blob).map_err(|issue| {
            violation_because(
                TreeCode::Markdown,
                issue.message,
                Some(path),
                issue.code.reason(),
            )
        })?;
        if let Some(id) = &parsed.document_id {
            if document_ids.contains_key(id) {
                return Err(violation(
                    TreeCode::DocumentId,
                    "duplicate document id",
                    Some(path),
                ));
            }
            document_ids.insert(id.clone(), path.to_owned());
        }
        let mut seen_refs = std::collections::HashSet::new();
        for reference in sealed_references_in(&parsed, text) {
            if seen_refs.insert(reference.clone()) {
                sealed.push(SealedOccurrence {
                    reference,
                    path: path.to_owned(),
                    blob: entry.sha.clone(),
                });
            }
        }
    }
    if let Some(bytes) = manifest {
        validate_manifest(&bytes, &paths, commit, policy)?;
    }
    if !has_gitignore || !has_manifest || !has_index {
        return Err(violation(
            TreeCode::Required,
            "tree is missing required root files",
            None,
        ));
    }
    policy
        .check_sealed_references(commit, &sealed)
        .map_err(|first| {
            violation(
                TreeCode::Sealed,
                "Unresolved sealed reference",
                Some(&first.path),
            )
        })
}

fn validate_commit_with(
    reader: &mut ObjectReader,
    commit: &Sha,
    policy: &dyn TreePolicy,
    incoming: &mut IncomingBudget,
) -> Result<ValidatedCommit, TreeError> {
    let info = reader.read_commit_checked(commit, &mut |_, size| {
        incoming.charge(commit.as_str(), size)
    })?;
    validate_tree_with(reader, &info.tree, Some(commit), policy, incoming)?;
    Ok(ValidatedCommit {
        commit: commit.clone(),
        tree: info.tree,
    })
}

/// Validate the tree of one commit.
pub fn validate_commit(
    repo: &GitRepo,
    commit: &Sha,
    policy: &dyn TreePolicy,
) -> Result<ValidatedCommit, TreeError> {
    let mut reader = repo.object_reader()?;
    validate_commit_with(&mut reader, commit, policy, &mut fresh_incoming(None))
}

/// Validate a bare tree (no commit context for the policy).
pub fn validate_tree(repo: &GitRepo, tree: &Sha, policy: &dyn TreePolicy) -> Result<(), TreeError> {
    let mut reader = repo.object_reader()?;
    validate_tree_with(&mut reader, tree, None, policy, &mut fresh_incoming(None))
}

/// Validate EVERY commit newly reachable from `new` (not from `old`; the
/// whole history when `old` is `None`), oldest first, against one shared
/// incoming-object budget. Returns the validated commits (tip last).
///
/// Order: bounded commit and newly-reachable object enumeration, per-commit
/// tree metadata preflight (no blob reads), then full
/// validation of each commit — so no content is read before the commit and
/// object counts are known to be within budget.
pub fn validate_newly_reachable(
    repo: &GitRepo,
    old: Option<&Sha>,
    new: &Sha,
    policy: &dyn TreePolicy,
) -> Result<Vec<Sha>, TreeError> {
    let mut commits = repo.commits_between(old, new, TREE_LIMITS.max_new_commits)?;
    if commits.is_empty() {
        commits.push(new.clone());
    }
    let set = repo.newly_reachable_objects(old, new, TREE_LIMITS.max_objects)?;
    let mut budget = fresh_incoming(Some(set));
    let mut reader = repo.object_reader()?;
    for commit in &commits {
        let info = reader
            .read_commit_checked(commit, &mut |_, size| budget.charge(commit.as_str(), size))?;
        walk_tree(
            &mut reader,
            &info.tree,
            &mut WalkBudget::new(TREE_LIMITS.max_entries),
            &mut budget,
        )?;
    }
    for commit in &commits {
        validate_commit_with(&mut reader, commit, policy, &mut budget)?;
    }
    if commits.last() != Some(new) {
        validate_commit_with(&mut reader, new, policy, &mut budget)?;
    }
    Ok(commits)
}
