//! Git plumbing of the local flow — the counterpart of
//! `packages/api/src/lib/kb/pr-merge.ts` and `logical-diff.ts`: logical
//! trees read from commits, line merges through `git merge-file` in an
//! operation scratch directory, a proposal merged onto main, the merged tree
//! written as objects, and the typed `PROPOSAL_CONFLICT` details.
//!
//! Nothing here moves a ref; the canonical repository only gains loose
//! objects the caller fsyncs (or leaves as unreachable garbage).

use std::collections::{BTreeMap, HashMap};

use kb_client::error::{ConflictKind, ConflictPath, PROPOSAL_CONFLICT_MAX_PATHS, ProposalConflict};
use kb_client::types::{KbPath, Sha};
use serde::{Deserialize, Serialize};

use crate::git_read::{DOCUMENT_MAX_BYTES, GitRepo, ObjectKind, ObjectReader};
use crate::git_write::{ObjectWriter, Scratch, TreeEdit};
use crate::locks::WriteGuard;
use crate::logical_merge::{
    Blob, Conflict, Kind, LineMergeItem, LogicalTree, MergeSource, Recorded, Value,
    by_path_then_kind, logical_tree_of, manifest_bytes, merge_logical_trees,
};
use crate::paths::StorePaths;
use crate::state::new_uuid_v4;
use crate::store::StoreError;
use crate::tree::{MANIFEST_PATH, ManifestEntry, TREE_LIMITS};

/// Combined UTF-8 budget of the inline base/theirs/yours contents
/// (`PROPOSAL_CONFLICT_CONTENT_MAX_BYTES`).
pub(crate) const PROPOSAL_CONFLICT_CONTENT_MAX_BYTES: u64 = 256 * 1024;

/// A recursive listing's most bytes for a tree within the limits.
const LISTING_MAX_BYTES: usize = 2 * TREE_LIMITS.max_entries * (kb_client::PATH_MAX_BYTES + 96);

/// One unresolved path a PR records (the server's `ConflictItem`): its
/// kind says which operations resolve it; `baseSha`/`yoursSha` are the merge
/// base it was found against and the proposal head holding "yours".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConflictItem {
    pub path: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub standing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_sha: Option<Sha>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yours_sha: Option<Sha>,
}

impl ConflictItem {
    pub(crate) fn from_conflict(c: &Conflict) -> Self {
        ConflictItem {
            path: c.path.clone(),
            kind: c.kind,
            standing: c.standing,
            base_sha: None,
            yours_sha: None,
        }
    }
}

/// Recorded conflicts plus newly found ones, one per path and kind (the
/// newer finding wins), sorted like the server.
pub(crate) fn union_conflicts(
    recorded: &[ConflictItem],
    found: &[ConflictItem],
) -> Vec<ConflictItem> {
    let mut by_key: BTreeMap<(Kind, String), ConflictItem> = recorded
        .iter()
        .map(|c| ((c.kind, c.path.clone()), c.clone()))
        .collect();
    for item in found {
        by_key.insert((item.kind, item.path.clone()), item.clone());
    }
    let mut out: Vec<ConflictItem> = by_key.into_values().collect();
    out.sort_by(|a, b| by_path_then_kind((&a.path, a.kind), (&b.path, b.kind)));
    out
}

fn unavailable() -> StoreError {
    StoreError::StorageUnavailable("merge unavailable".into())
}

fn git_sha(out: &[u8]) -> Result<Sha, StoreError> {
    Sha::parse(String::from_utf8_lossy(out).trim()).map_err(|_| unavailable())
}

/// `git merge-base a b`.
pub(crate) fn merge_base(repo: &GitRepo, a: &Sha, b: &Sha) -> Result<Sha, StoreError> {
    let (ok, out) =
        repo.run_command(repo.command(["merge-base", a.as_str(), b.as_str()])?, 4096)?;
    if !ok {
        return Err(unavailable());
    }
    git_sha(&out)
}

/// Whether `a` is an ancestor of (or equal to) `b`.
pub(crate) fn is_ancestor(repo: &GitRepo, a: &Sha, b: &Sha) -> Result<bool, StoreError> {
    Ok(repo
        .run_command(
            repo.command(["merge-base", "--is-ancestor", a.as_str(), b.as_str()])?,
            4096,
        )?
        .0)
}

/// Every blob of a commit's tree with its size, from one `ls-tree -r -l`.
fn listing(repo: &GitRepo, commit: &Sha) -> Result<BTreeMap<String, Blob>, StoreError> {
    let (ok, out) = repo.run_command(
        repo.command(["ls-tree", "-r", "-l", "-z", commit.as_str()])?,
        LISTING_MAX_BYTES,
    )?;
    if !ok {
        return Err(unavailable());
    }
    let mut entries = BTreeMap::new();
    for record in out.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let text = std::str::from_utf8(record).map_err(|_| unavailable())?;
        let (meta, path) = text.split_once('\t').ok_or_else(unavailable)?;
        let mut parts = meta.split_whitespace();
        let (Some(mode), Some(kind), Some(sha), Some(size)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(unavailable());
        };
        if mode != "100644" || kind != "blob" {
            return Err(StoreError::RecoveryRequired(
                "unexpected entry in a published tree".into(),
            ));
        }
        entries.insert(
            path.to_owned(),
            Blob {
                sha: sha.to_owned(),
                size: Some(size.parse().map_err(|_| unavailable())?),
                bytes: None,
            },
        );
    }
    Ok(entries)
}

/// Reads blobs through one `cat-file --batch` and line-merges documents the
/// way the server does: every both-changed document at once, in ONE
/// `git merge-tree --write-tree --merge-base` over three flat synthetic trees
/// (names are indices, so nothing is renamed or moved). Same algorithm as the
/// server (merge-ort, histogram diff), one process per merge whatever the
/// number of documents (R3 review: parity and near-limit performance).
pub(crate) struct GitSource<'a> {
    repo: &'a GitRepo,
    paths: &'a StorePaths,
    guard: &'a WriteGuard,
    /// Started on first read: a request that never reads spawns nothing.
    reader: Option<ObjectReader>,
}

/// The oldest Git whose `merge-tree` takes `--merge-base` and `-X`.
const MERGE_GIT_MIN: (u32, u32) = (2, 45);

/// The Git this store needs, checked once per process when `kb mcp` serves
/// a store (the server's startup probe likewise): merges, moves onto main and PR
/// statuses run `git merge-tree --write-tree --merge-base … -X…`. An older
/// Git refuses startup with a message naming the found and required versions.
pub(crate) fn require_git(paths: &StorePaths) -> Result<(), StoreError> {
    static CHECKED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    if let Some(checked) = CHECKED.get() {
        return checked.clone().map_err(explain_git);
    }
    let mut command = std::process::Command::new("git");
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    for key in ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    // The same neutralized configuration as every managed Git child.
    command
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_SYSTEM", crate::git_read::NULL_DEVICE)
        .env("GIT_CONFIG_GLOBAL", crate::git_read::NULL_DEVICE)
        .arg("version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let (ok, out) = GitRepo::run_store_command(paths, command, 4096)?;
    let text = String::from_utf8_lossy(&out).trim().to_owned();
    let found = text
        .strip_prefix("git version ")
        .unwrap_or("unknown")
        .to_owned();
    let parsed = ok.then(|| {
        let mut parts = found.split(|c: char| !c.is_ascii_digit());
        Some((
            parts.next()?.parse::<u32>().ok()?,
            parts.next()?.parse::<u32>().ok()?,
        ))
    });
    let verdict = match parsed.flatten() {
        Some(version) if version >= MERGE_GIT_MIN => Ok(()),
        _ => Err(found),
    };
    CHECKED.get_or_init(|| verdict).clone().map_err(explain_git)
}

fn explain_git(found: String) -> StoreError {
    StoreError::Explained(
        kb_client::ErrorCode::StorageUnavailable,
        format!(
            "kb needs git {}.{} or newer for a local store (pull request merges use \
             `git merge-tree --merge-base`); found git {found}",
            MERGE_GIT_MIN.0, MERGE_GIT_MIN.1
        ),
    )
}

/// Git's empty blob.
const EMPTY_BLOB: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

fn raw_sha(sha: &str) -> Result<Vec<u8>, StoreError> {
    (0..20)
        .map(|i| {
            u8::from_str_radix(sha.get(i * 2..i * 2 + 2).ok_or_else(unavailable)?, 16)
                .map_err(|_| unavailable())
        })
        .collect()
}

/// A flat tree of regular files named by `entries` (name, blob).
fn flat_tree_bytes(entries: &mut [(String, String)]) -> Result<Vec<u8>, StoreError> {
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut out = Vec::new();
    for (name, sha) in entries.iter() {
        out.extend_from_slice(format!("100644 {name}\0").as_bytes());
        out.extend(raw_sha(sha)?);
    }
    Ok(out)
}

impl<'a> GitSource<'a> {
    pub(crate) fn new(repo: &'a GitRepo, paths: &'a StorePaths, guard: &'a WriteGuard) -> Self {
        GitSource {
            repo,
            paths,
            guard,
            reader: None,
        }
    }

    fn read_blob(&mut self, sha: &str) -> Result<Vec<u8>, StoreError> {
        if self.reader.is_none() {
            self.reader = Some(self.repo.object_reader()?);
        }
        let reader = self.reader.as_mut().ok_or_else(unavailable)?;
        Ok(reader.read(sha, ObjectKind::Blob, DOCUMENT_MAX_BYTES)?)
    }

    /// The logical model of `commit`'s tree.
    pub(crate) fn logical_tree(&mut self, commit: &Sha) -> Result<LogicalTree, StoreError> {
        let entries = listing(self.repo, commit)?;
        let manifest = match entries.get(MANIFEST_PATH) {
            Some(blob) => Some(self.read_blob(&blob.sha)?),
            None => None,
        };
        logical_tree_of(entries, manifest.as_deref())
            .ok_or_else(|| StoreError::StorageUnavailable("asset manifest unavailable".into()))
    }
}

impl MergeSource for GitSource<'_> {
    fn read(&mut self, sha: &str) -> Result<Vec<u8>, StoreError> {
        self.read_blob(sha)
    }

    fn merge_texts(
        &mut self,
        items: &[LineMergeItem<'_>],
    ) -> Result<HashMap<String, Option<Vec<u8>>>, StoreError> {
        let mut out = HashMap::new();
        if items.is_empty() {
            return Ok(out);
        }
        crate::git_read::OperationDeadline::check()?;
        let name = |index: usize| format!("f{index}");
        // `self.repo` is a staged repository: the synthetic trees and the
        // merge result land in its disposable object store, never canonical.
        let trees = {
            let mut writer = ObjectWriter::new(
                self.repo,
                self.guard,
                Scratch::new(self.paths, &new_uuid_v4()?)?,
            );
            // A side without the document holds an empty file (server parity).
            let empty = writer.blob(b"")?;
            if empty != EMPTY_BLOB {
                return Err(unavailable());
            }
            let mut trees = Vec::new();
            for pick in [0, 1, 2] {
                let mut entries: Vec<(String, String)> = items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        let blob = match pick {
                            0 => item.base.map(|b| b.sha.clone()),
                            1 => Some(item.main.sha.clone()),
                            _ => Some(item.proposal.sha.clone()),
                        };
                        (name(index), blob.unwrap_or_else(|| EMPTY_BLOB.to_owned()))
                    })
                    .collect();
                trees.push(writer.tree_raw(&flat_tree_bytes(&mut entries)?)?);
            }
            trees
        };
        let command = self.repo.command([
            "merge-tree".to_owned(),
            "--write-tree".to_owned(),
            "-z".to_owned(),
            "--name-only".to_owned(),
            "-Xno-renames".to_owned(),
            format!("--merge-base={}", trees[0]),
            trees[1].clone(),
            trees[2].clone(),
        ])?;
        // Exit 0 = clean, 1 = some files conflict; anything else (or a
        // signal) is a failure and never becomes a content conflict.
        let (code, stdout) = self.repo.run_command_code(command, LISTING_MAX_BYTES)?;
        if !matches!(code, Some(0 | 1)) {
            return Err(StoreError::StorageUnavailable(
                "git merge-tree failed".into(),
            ));
        }
        let mut records = stdout.split(|b| *b == 0);
        let result = records
            .next()
            .and_then(|r| std::str::from_utf8(r).ok())
            .and_then(|r| Sha::parse(r.trim()).ok())
            .ok_or_else(unavailable)?;
        let mut clashing = std::collections::HashSet::new();
        for record in records {
            if record.is_empty() {
                break;
            }
            clashing.insert(String::from_utf8_lossy(record).into_owned());
        }
        let merged = listing(self.repo, &result)?;
        for (index, item) in items.iter().enumerate() {
            let key = name(index);
            let value = match merged.get(&key) {
                Some(blob)
                    if !clashing.contains(&key)
                        && blob.size.unwrap_or(u64::MAX)
                            <= TREE_LIMITS.max_markdown_bytes as u64 =>
                {
                    Some(self.read_blob(&blob.sha)?)
                }
                _ => None,
            };
            out.insert(item.path.to_owned(), value);
        }
        Ok(out)
    }

    fn checkpoint(&mut self) -> Result<(), StoreError> {
        crate::git_read::OperationDeadline::check()
    }
}

/// A proposal merged onto main.
pub(crate) struct ProposalMerge {
    /// Typed conflicts sorted by path and kind; empty when it applies cleanly.
    pub conflicts: Vec<Conflict>,
    /// The provisional merged tree (a conflicted path holds the proposal's
    /// version where that is valid, else main's; never a merge marker).
    pub tree: LogicalTree,
    /// The merge base the conflicts were found against (`None` for an
    /// ancestry shortcut).
    pub merge_base: Option<Sha>,
}

/// Three-way merge of `head` onto `main`; `recorded` are the PR's still
/// unresolved conflicts, whose saved choices join the closure.
pub(crate) fn merge_proposal_onto_main(
    source: &mut GitSource<'_>,
    main: &Sha,
    head: &Sha,
    enforce_limits: bool,
    recorded: &[ConflictItem],
) -> Result<ProposalMerge, StoreError> {
    let repo = source.repo;
    // Ancestry shortcuts only when nothing is recorded: a recorded choice
    // must still be checked against whatever main took in.
    if recorded.is_empty() {
        for (ancestor, descendant) in [(main, head), (head, main)] {
            if is_ancestor(repo, ancestor, descendant)? {
                return Ok(ProposalMerge {
                    conflicts: Vec::new(),
                    tree: source.logical_tree(descendant)?,
                    merge_base: None,
                });
            }
        }
    }
    let base = merge_base(repo, main, head)?;
    let mut saved: HashMap<Sha, LogicalTree> = HashMap::new();
    for sha in recorded.iter().filter_map(|c| c.yours_sha.clone()) {
        if let std::collections::hash_map::Entry::Vacant(slot) = saved.entry(sha) {
            let tree = source.logical_tree(slot.key())?;
            slot.insert(tree);
        }
    }
    let recorded: Vec<Recorded> = recorded
        .iter()
        .map(|item| {
            let tree = item.yours_sha.as_ref().and_then(|sha| saved.get(sha));
            let choice = tree.and_then(|t| match item.kind {
                Kind::Document => t.documents.get(&item.path).cloned().map(Value::Document),
                Kind::Asset => t.assets.get(&item.path).cloned().map(Value::Asset),
            });
            Recorded {
                path: item.path.clone(),
                kind: item.kind,
                standing: item.standing,
                choices: choice.into_iter().collect(),
            }
        })
        .collect();
    let (base_tree, main_tree, head_tree) = (
        source.logical_tree(&base)?,
        source.logical_tree(main)?,
        source.logical_tree(head)?,
    );
    let merged = merge_logical_trees(
        &base_tree,
        &main_tree,
        &head_tree,
        source,
        enforce_limits,
        &recorded,
    )?;
    Ok(ProposalMerge {
        conflicts: merged.conflicts,
        tree: merged.tree,
        merge_base: Some(base),
    })
}

fn kb_path(path: &str) -> Result<KbPath, StoreError> {
    KbPath::parse(path).map_err(|_| StoreError::RecoveryRequired("merged tree path".into()))
}

/// Write `tree` as main's tree with its differences applied; returns the
/// edited tree (unchanged subtrees keep their objects) for further edits.
/// Its line-merged blobs are the merge's own objects in the same staged
/// store; promotion carries every object the published commit needs.
pub(crate) fn tree_edit_for(
    mut edit: TreeEdit,
    writer: &mut ObjectWriter<'_>,
    tree: &LogicalTree,
) -> Result<TreeEdit, StoreError> {
    let current = edit.original_blobs().clone();
    for path in current.keys() {
        if path != MANIFEST_PATH
            && !tree.managed.contains_key(path)
            && !tree.documents.contains_key(path)
        {
            edit.delete(&kb_path(path)?)?;
        }
    }
    for (path, blob) in &tree.documents {
        if current.get(path) == Some(&blob.sha) {
            continue;
        }
        // A line-merged version already exists: `merge-tree` wrote it (the
        // caller adopts the source's objects for fsync); no object per file.
        edit.put(&kb_path(path)?, blob.sha.clone())?;
    }
    let manifest = manifest_bytes(tree);
    let manifest_sha = crate::logical_merge::git_blob_sha(&manifest);
    if current.get(MANIFEST_PATH) != Some(&manifest_sha) {
        edit.put(&kb_path(MANIFEST_PATH)?, writer.blob(&manifest)?)?;
    }
    Ok(edit)
}

/// Every logical write between two commits, typed: documents by path, and a
/// manifest change expanded into the assets it adds, removes or replaces.
pub(crate) fn changed_logical_paths(
    source: &mut GitSource<'_>,
    from: &Sha,
    to: &Sha,
) -> Result<Vec<(String, Kind)>, StoreError> {
    let (a, b) = (source.logical_tree(from)?, source.logical_tree(to)?);
    let mut out = Vec::new();
    let docs = |t: &LogicalTree| -> BTreeMap<String, String> {
        t.documents
            .iter()
            .chain(t.managed.iter())
            .map(|(p, b)| (p.clone(), b.sha.clone()))
            .collect()
    };
    let (da, db) = (docs(&a), docs(&b));
    for path in da
        .keys()
        .chain(db.keys())
        .collect::<std::collections::BTreeSet<_>>()
    {
        if da.get(path) != db.get(path) {
            out.push((path.clone(), Kind::Document));
        }
    }
    for path in a
        .assets
        .keys()
        .chain(b.assets.keys())
        .collect::<std::collections::BTreeSet<_>>()
    {
        let same = match (a.assets.get(path), b.assets.get(path)) {
            (Some(x), Some(y)) => x.hash == y.hash && x.size == y.size && x.mime == y.mime,
            _ => false,
        };
        if !same {
            out.push((path.clone(), Kind::Asset));
        }
    }
    out.sort_by(|x, y| by_path_then_kind((&x.0, x.1), (&y.0, y.1)));
    Ok(out)
}

/// `JSON.stringify` of a manifest entry (its manifest key order).
fn entry_json(e: &ManifestEntry) -> String {
    let json = |s: &str| serde_json::to_string(s).unwrap_or_default();
    format!(
        "{{\"path\":{},\"hash\":{},\"size\":{},\"mime\":{}}}",
        json(&e.path),
        json(&e.hash),
        e.size,
        json(&e.mime)
    )
}

/// CONFLICT for a proposal that still clashes with main: every
/// unresolved path with its base / main ("theirs") / proposal ("yours")
/// versions, inline only within a fixed budget, and the exact revisions
/// they were read at.
pub(crate) fn proposal_conflict_error(
    source: &mut GitSource<'_>,
    main: &Sha,
    head: &Sha,
    proposal_number: u64,
    paths: &[ConflictItem],
) -> Result<StoreError, StoreError> {
    let base = merge_base(source.repo, main, head)?;
    let listed = &paths[..paths.len().min(PROPOSAL_CONFLICT_MAX_PATHS)];
    let revisions = |item: &ConflictItem| {
        (
            item.base_sha.clone().unwrap_or_else(|| base.clone()),
            main.clone(),
            item.yours_sha.clone().unwrap_or_else(|| head.clone()),
        )
    };
    let mut trees: HashMap<Sha, LogicalTree> = HashMap::new();
    for item in listed {
        let (b, t, y) = revisions(item);
        for rev in [b, t, y] {
            if let std::collections::hash_map::Entry::Vacant(slot) = trees.entry(rev) {
                let tree = source.logical_tree(slot.key())?;
                slot.insert(tree);
            }
        }
    }
    enum Version {
        Absent,
        Document(Blob),
        Asset(String),
    }
    let version = |rev: &Sha, item: &ConflictItem| -> Version {
        let Some(tree) = trees.get(rev) else {
            return Version::Absent;
        };
        match item.kind {
            Kind::Document => tree
                .documents
                .get(&item.path)
                .cloned()
                .map_or(Version::Absent, Version::Document),
            Kind::Asset => tree
                .assets
                .get(&item.path)
                .map_or(Version::Absent, |e| Version::Asset(entry_json(e))),
        }
    };
    let mut bytes = 0u64;
    let mut versions = Vec::new();
    for item in listed {
        let (b, t, y) = revisions(item);
        let three = [version(&b, item), version(&t, item), version(&y, item)];
        for v in &three {
            bytes += match v {
                Version::Absent => 0,
                Version::Document(blob) => blob.size.unwrap_or(0),
                Version::Asset(text) => text.len() as u64,
            };
        }
        versions.push((item, (b, t, y), three));
    }
    let included = bytes <= PROPOSAL_CONFLICT_CONTENT_MAX_BYTES;
    let mut text = |v: &Version| -> Result<Option<String>, StoreError> {
        if !included {
            return Ok(None);
        }
        Ok(match v {
            Version::Absent => None,
            Version::Asset(text) => Some(text.clone()),
            Version::Document(blob) => {
                Some(String::from_utf8_lossy(&source.read_blob(&blob.sha)?).into_owned())
            }
        })
    };
    let mut out = Vec::new();
    for (item, (b, t, y), three) in versions {
        out.push(ConflictPath {
            path: item.path.clone(),
            kind: match item.kind {
                Kind::Document => ConflictKind::Document,
                Kind::Asset => ConflictKind::Asset,
            },
            base: text(&three[0])?,
            theirs: text(&three[1])?,
            yours: text(&three[2])?,
            base_sha: b,
            theirs_sha: t,
            yours_sha: y,
        });
    }
    Ok(StoreError::ProposalConflict(Box::new(ProposalConflict {
        head_sha: main.clone(),
        proposal_number: i64::try_from(proposal_number).ok(),
        base_sha: base,
        proposal_head_sha: head.clone(),
        content_included: included,
        paths: out,
    })))
}
