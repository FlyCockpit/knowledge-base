//! The three-way merge of a proposal onto main over the KB's logical
//! model — a port of `packages/api/src/lib/kb/logical-merge.ts`, run on the
//! shared corpus `fixtures/logical-merge-cases.json` by both sides (change
//! them together).
//!
//! Documents merge by logical path (with their ids), assets by manifest
//! entry. Every conflict carries its true kind, and the provisional tree is
//! always valid: an unresolved conflict keeps the proposal's choice where
//! that is valid on its own, and main's version where the proposal's would
//! break the tree (a duplicate document id, a case or path collision, a
//! file-vs-directory clash, or a repository limit). A closure then reports
//! every entry a conflict's resolution choice could collide with, so no
//! resolution can fail on an unreported path.
//!
//! Ordering follows the server exactly (JS UTF-16 string order), so both
//! sides fall back on the same entries.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

use kb_client::casefold_path_key;
use serde::{Deserialize, Serialize};

use crate::markdown::parse_markdown;
use crate::store::StoreError;
use crate::tree::{MANIFEST_PATH, ManifestEntry, TREE_LIMITS, canonical_manifest_bytes};

/// The managed `.gitignore`: carried through from main, never merged.
pub(crate) const GITIGNORE_PATH: &str = ".gitignore";
/// Most entries one manifest may list (`KB_MANIFEST_MAX_ENTRIES`).
pub(crate) const MANIFEST_MAX_ENTRIES: usize = 8192;

/// What resolves a conflict: document operations or asset operations.
/// Ordered like the server's kind strings (`"asset" < "document"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Asset,
    Document,
}

/// One conflict: its logical path and kind. `standing` marks main's own,
/// unchanged entry, recorded only because other conflicts' choices could
/// collide with it: it is resolved with them once none of them remains.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Conflict {
    pub path: String,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub standing: bool,
}

/// JS `<` on strings: UTF-16 code unit order.
pub(crate) fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub(crate) fn by_path_then_kind(a: (&str, Kind), b: (&str, Kind)) -> Ordering {
    js_cmp(a.0, b.0).then(a.1.cmp(&b.1))
}

/// The conflicts a PR still has after a head change that wrote `written`
/// (kind and path): a write of the same kind and path resolves one; main's
/// standing entries are resolved once no other conflict remains.
pub(crate) struct Remaining<T> {
    pub resolved: Vec<T>,
    pub unresolved: Vec<T>,
    pub remaining: Vec<T>,
}

pub(crate) fn remaining_conflicts<T: Clone>(
    pending: &[T],
    item: impl Fn(&T) -> (&str, Kind, bool),
    written: impl Fn(&str, Kind) -> bool,
) -> Remaining<T> {
    let (resolved, unresolved): (Vec<T>, Vec<T>) = pending.iter().cloned().partition(|p| {
        let (path, kind, _) = item(p);
        written(path, kind)
    });
    let remaining = if unresolved.iter().any(|p| !item(p).2) {
        unresolved.clone()
    } else {
        Vec::new()
    };
    Remaining {
        resolved,
        unresolved,
        remaining,
    }
}

/// A blob by its Git id; its size when known (limits are enforced only
/// then); its bytes when already in memory (a line-merge result).
#[derive(Clone, Debug)]
pub(crate) struct Blob {
    pub sha: String,
    pub size: Option<u64>,
    pub bytes: Option<Rc<Vec<u8>>>,
}

/// A KB tree as the logical model sees it.
#[derive(Clone, Debug, Default)]
pub(crate) struct LogicalTree {
    /// Markdown documents: every tree file but the managed `.gitignore` and the manifest.
    pub documents: BTreeMap<String, Blob>,
    pub assets: BTreeMap<String, ManifestEntry>,
    /// The managed `.gitignore`, carried through from main.
    pub managed: BTreeMap<String, Blob>,
}

/// Git's blob id of some bytes.
pub(crate) fn git_blob_sha(bytes: &[u8]) -> String {
    let mut data = format!("blob {}\0", bytes.len()).into_bytes();
    data.extend_from_slice(bytes);
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &data);
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// The logical model of a tree's blobs (path -> blob) whose manifest is
/// `manifest` (absent = empty); `None` when the manifest cannot be read.
pub(crate) fn logical_tree_of(
    entries: impl IntoIterator<Item = (String, Blob)>,
    manifest: Option<&[u8]>,
) -> Option<LogicalTree> {
    let mut tree = LogicalTree::default();
    for (path, blob) in entries {
        if path == MANIFEST_PATH {
            continue;
        }
        if path == GITIGNORE_PATH {
            tree.managed.insert(path, blob);
        } else {
            tree.documents.insert(path, blob);
        }
    }
    let entries = match manifest {
        Some(bytes) => crate::tree::parse_manifest(bytes).ok()?,
        None => Vec::new(),
    };
    tree.assets = entries.into_iter().map(|e| (e.path.clone(), e)).collect();
    Some(tree)
}

/// Canonical manifest bytes of a logical tree.
pub(crate) fn manifest_bytes(tree: &LogicalTree) -> Vec<u8> {
    canonical_manifest_bytes(&tree.assets.values().cloned().collect::<Vec<_>>())
}

/// Bytes of one canonical manifest entry (`JSON.stringify` of it).
pub(crate) fn manifest_entry_bytes(entry: &ManifestEntry) -> u64 {
    let json = |s: &str| serde_json::to_string(s).map_or(0, |s| s.len());
    // {"path":…,"hash":…,"size":…,"mime":…}
    (r#"{"path":,"hash":,"size":,"mime":}"#.len()
        + json(&entry.path)
        + json(&entry.hash)
        + entry.size.to_string().len()
        + json(&entry.mime)) as u64
}

const MANIFEST_FIXED_BYTES: u64 = r#"{"version":1,"entries":[]}"#.len() as u64 + 1;

fn manifest_byte_length(entry_bytes: u64, entries: u64) -> u64 {
    MANIFEST_FIXED_BYTES + entry_bytes + entries.saturating_sub(1)
}

/// One accounting of a KB tree against its budgets (`tree-budget.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreeTotals {
    pub entries: u64,
    pub files: u64,
    pub tree_bytes: u64,
    pub manifest_entries: u64,
    pub manifest_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Limit {
    Assets,
    Manifest,
    Files,
    Entries,
    Bytes,
}

fn exceeded_tree_limit(t: &TreeTotals) -> Option<Limit> {
    if t.manifest_entries > MANIFEST_MAX_ENTRIES as u64 {
        Some(Limit::Assets)
    } else if t.manifest_bytes > TREE_LIMITS.max_markdown_bytes as u64 {
        Some(Limit::Manifest)
    } else if t.files > TREE_LIMITS.max_files as u64 {
        Some(Limit::Files)
    } else if t.entries > TREE_LIMITS.max_entries as u64 {
        Some(Limit::Entries)
    } else if t.tree_bytes > TREE_LIMITS.max_tree_bytes as u64 {
        Some(Limit::Bytes)
    } else {
        None
    }
}

/// A slot value: a document blob or an asset entry; `None` = absent.
#[derive(Clone, Debug)]
pub(crate) enum Value {
    Document(Blob),
    Asset(ManifestEntry),
}

fn same_blob(a: Option<&Blob>, b: Option<&Blob>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.sha == b.sha,
        _ => false,
    }
}

fn same_asset(a: Option<&ManifestEntry>, b: Option<&ManifestEntry>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.hash == b.hash && a.size == b.size && a.mime == b.mime,
        _ => false,
    }
}

/// One document both sides changed, handed to the line merge.
pub(crate) struct LineMergeItem<'a> {
    pub path: &'a str,
    pub base: Option<&'a Blob>,
    pub main: &'a Blob,
    pub proposal: &'a Blob,
}

/// Where the merge reads blob contents and line-merges documents.
pub(crate) trait MergeSource {
    /// The bytes of blob `sha`.
    fn read(&mut self, sha: &str) -> Result<Vec<u8>, StoreError>;
    /// Every line merge at once, by path: the merged bytes, or `None` where
    /// the lines clash.
    fn merge_texts(
        &mut self,
        items: &[LineMergeItem<'_>],
    ) -> Result<HashMap<String, Option<Vec<u8>>>, StoreError>;
    /// Cooperative cancellation, called every few hundred steps.
    fn checkpoint(&mut self) -> Result<(), StoreError> {
        Ok(())
    }
}

/// A conflict recorded earlier and still unresolved, with the versions its
/// resolution may still choose (the proposal's saved "yours").
pub(crate) struct Recorded {
    pub path: String,
    pub kind: Kind,
    pub standing: bool,
    pub choices: Vec<Value>,
}

pub(crate) struct MergeOutput {
    pub tree: LogicalTree,
    pub conflicts: Vec<Conflict>,
    /// What whole-tree validation will charge; checked against the server's
    /// accounting by the shared corpus.
    #[cfg_attr(not(test), allow(dead_code))]
    pub totals: TreeTotals,
}

struct Slot {
    kind: Kind,
    path: String,
    value: Option<Value>,
    pinned: bool,
    claimed: bool,
    id: Option<String>,
}

const RESERVED: usize = usize::MAX;
const CHECKPOINT_EVERY: u64 = 256;

struct Prefix {
    spelling: String,
    key: String,
    dir: bool,
}

fn prefixes(path: &str) -> Vec<Prefix> {
    let segments: Vec<&str> = path.split('/').collect();
    let folded_path = casefold_path_key(path);
    let folded: Vec<&str> = folded_path.split('/').collect();
    (0..segments.len())
        .map(|depth| Prefix {
            spelling: segments[..=depth].join("/"),
            key: folded[..=depth.min(folded.len() - 1)].join("/"),
            dir: depth + 1 < segments.len(),
        })
        .collect()
}

struct Dir {
    spelling: String,
    holders: BTreeSet<usize>,
    tree_holders: u64,
}

#[derive(Default)]
struct Running {
    tree_files: u64,
    tree_dirs: u64,
    tree_bytes: u64,
    assets: u64,
    manifest_entry_bytes: u64,
}

/// The merge state: slots plus the incremental indices of their claims.
struct State<'s> {
    slots: Vec<Slot>,
    index: HashMap<(Kind, String), usize>,
    files: HashMap<String, usize>,
    dirs: HashMap<String, Dir>,
    id_holders: HashMap<String, usize>,
    totals: Running,
    conflicts: BTreeMap<(Kind, String), Conflict>,
    ids: HashMap<String, Option<String>>,
    contents: HashMap<String, Rc<Vec<u8>>>,
    source: &'s mut dyn MergeSource,
    steps: u64,
}

impl State<'_> {
    fn tick(&mut self) -> Result<(), StoreError> {
        self.steps += 1;
        if self.steps.is_multiple_of(CHECKPOINT_EVERY) {
            self.source.checkpoint()?;
        }
        Ok(())
    }

    fn load(&mut self, blob: &Blob) -> Result<Rc<Vec<u8>>, StoreError> {
        if let Some(bytes) = &blob.bytes {
            return Ok(bytes.clone());
        }
        if let Some(bytes) = self.contents.get(&blob.sha) {
            return Ok(bytes.clone());
        }
        let bytes = Rc::new(self.source.read(&blob.sha)?);
        self.contents.insert(blob.sha.clone(), bytes.clone());
        Ok(bytes)
    }

    fn id_of(&mut self, blob: &Blob) -> Result<Option<String>, StoreError> {
        if let Some(id) = self.ids.get(&blob.sha) {
            return Ok(id.clone());
        }
        let bytes = self.load(blob)?;
        let id = parse_markdown(&bytes).ok().and_then(|p| p.document_id);
        self.ids.insert(blob.sha.clone(), id.clone());
        Ok(id)
    }

    fn conflict(&mut self, kind: Kind, path: &str) {
        self.conflicts.insert(
            (kind, path.to_owned()),
            Conflict {
                path: path.to_owned(),
                kind,
                standing: false,
            },
        );
    }

    fn has_conflict(&self, kind: Kind, path: &str) -> bool {
        self.conflicts.contains_key(&(kind, path.to_owned()))
    }

    fn clashes(&self, at: usize) -> bool {
        let slot = &self.slots[at];
        for p in prefixes(&slot.path) {
            if self.files.get(&p.key).is_some_and(|&f| f != at) {
                return true;
            }
            if let Some(dir) = self.dirs.get(&p.key)
                && (!p.dir || dir.spelling != p.spelling)
                && !dir.holders.is_empty()
            {
                return true;
            }
        }
        if let Some(id) = &slot.id
            && self.id_holders.get(id).is_some_and(|&h| h != at)
        {
            return true;
        }
        false
    }

    /// The changed holders clashing with `at`, which a pinned (main) entry evicts.
    fn clashing(&self, at: usize) -> Vec<usize> {
        let slot = &self.slots[at];
        let mut out = Vec::new();
        for p in prefixes(&slot.path) {
            if let Some(&f) = self.files.get(&p.key)
                && f != at
            {
                out.push(f);
            }
            if let Some(dir) = self.dirs.get(&p.key)
                && (!p.dir || dir.spelling != p.spelling)
            {
                out.extend(dir.holders.iter().copied());
            }
        }
        if let Some(id) = &slot.id
            && let Some(&h) = self.id_holders.get(id)
            && h != at
        {
            out.push(h);
        }
        out.retain(|&o| o != at && o != RESERVED && !self.slots[o].pinned);
        out
    }

    fn size_of(&self, at: usize) -> u64 {
        match &self.slots[at].value {
            Some(Value::Document(blob)) => blob.size.unwrap_or(0),
            Some(Value::Asset(entry)) => manifest_entry_bytes(entry),
            None => 0,
        }
    }

    fn claim(&mut self, at: usize) {
        let tree = self.slots[at].kind == Kind::Document;
        for p in prefixes(&self.slots[at].path) {
            if !p.dir {
                self.files.insert(p.key, at);
                continue;
            }
            let dir = self.dirs.entry(p.key).or_insert_with(|| Dir {
                spelling: p.spelling,
                holders: BTreeSet::new(),
                tree_holders: 0,
            });
            dir.holders.insert(at);
            if tree {
                dir.tree_holders += 1;
                if dir.tree_holders == 1 {
                    self.totals.tree_dirs += 1;
                }
            }
        }
        if let Some(id) = self.slots[at].id.clone() {
            self.id_holders.insert(id, at);
        }
        let size = self.size_of(at);
        if tree {
            self.totals.tree_files += 1;
            self.totals.tree_bytes += size;
        } else {
            self.totals.assets += 1;
            self.totals.manifest_entry_bytes += size;
        }
        self.slots[at].claimed = true;
    }

    fn release(&mut self, at: usize) {
        if !self.slots[at].claimed {
            return;
        }
        let tree = self.slots[at].kind == Kind::Document;
        for p in prefixes(&self.slots[at].path) {
            if !p.dir {
                if self.files.get(&p.key) == Some(&at) {
                    self.files.remove(&p.key);
                }
                continue;
            }
            let Some(dir) = self.dirs.get_mut(&p.key) else {
                continue;
            };
            dir.holders.remove(&at);
            if tree {
                dir.tree_holders -= 1;
                if dir.tree_holders == 0 {
                    self.totals.tree_dirs -= 1;
                }
            }
            if dir.holders.is_empty() && dir.tree_holders == 0 {
                self.dirs.remove(&p.key);
            }
        }
        if let Some(id) = self.slots[at].id.clone()
            && self.id_holders.get(&id) == Some(&at)
        {
            self.id_holders.remove(&id);
        }
        let size = self.size_of(at);
        if tree {
            self.totals.tree_files -= 1;
            self.totals.tree_bytes -= size;
        } else {
            self.totals.assets -= 1;
            self.totals.manifest_entry_bytes -= size;
        }
        self.slots[at].claimed = false;
    }

    fn prepare(&mut self, at: usize, ids_matter: bool) -> Result<(), StoreError> {
        let id = match (&self.slots[at].value, ids_matter) {
            (Some(Value::Document(blob)), true) => {
                let blob = blob.clone();
                self.id_of(&blob)?
            }
            _ => None,
        };
        self.slots[at].id = id;
        Ok(())
    }

    fn current_totals(&self) -> TreeTotals {
        let manifest = manifest_byte_length(self.totals.manifest_entry_bytes, self.totals.assets);
        TreeTotals {
            entries: 1 + self.totals.tree_dirs + self.totals.tree_files,
            files: self.totals.tree_files,
            tree_bytes: self.totals.tree_bytes + manifest,
            manifest_entries: self.totals.assets,
            manifest_bytes: manifest,
        }
    }
}

fn main_value(main: &LogicalTree, kind: Kind, path: &str) -> Option<Value> {
    match kind {
        Kind::Document => main.documents.get(path).cloned().map(Value::Document),
        Kind::Asset => main.assets.get(path).cloned().map(Value::Asset),
    }
}

/// An entry's own size in a limit (a manifest entry with its separating comma).
fn measure(value: Option<&Value>, limit: Limit) -> i64 {
    match value {
        None => 0,
        Some(Value::Asset(entry)) => {
            let bytes = manifest_entry_bytes(entry) as i64 + 1;
            match limit {
                Limit::Assets => 1,
                Limit::Manifest | Limit::Bytes => bytes,
                _ => 0,
            }
        }
        Some(Value::Document(blob)) => match limit {
            Limit::Files | Limit::Entries => 1,
            Limit::Bytes => blob.size.unwrap_or(0) as i64,
            _ => 0,
        },
    }
}

/// Merge `proposal` onto `main` from their common `base`. Conflicts are
/// sorted by path and kind; `tree` is the provisional, valid result.
pub(crate) fn merge_logical_trees(
    base: &LogicalTree,
    main: &LogicalTree,
    proposal: &LogicalTree,
    source: &mut dyn MergeSource,
    enforce_limits: bool,
    recorded: &[Recorded],
) -> Result<MergeOutput, StoreError> {
    // Documents both sides changed are line-merged, all at once.
    let line_merges = {
        let mut items = Vec::new();
        for (path, m) in &main.documents {
            let (b, p) = (base.documents.get(path), proposal.documents.get(path));
            if let Some(p) = p
                && !same_blob(Some(m), Some(p))
                && !same_blob(b, Some(p))
                && !same_blob(b, Some(m))
            {
                items.push(LineMergeItem {
                    path,
                    base: b,
                    main: m,
                    proposal: p,
                });
            }
        }
        if items.is_empty() {
            HashMap::new()
        } else {
            source.merge_texts(&items)?
        }
    };
    let mut state = State {
        slots: Vec::new(),
        index: HashMap::new(),
        files: HashMap::new(),
        dirs: HashMap::new(),
        id_holders: HashMap::new(),
        totals: Running::default(),
        conflicts: BTreeMap::new(),
        ids: HashMap::new(),
        contents: HashMap::new(),
        source,
        steps: 0,
    };
    let push = |state: &mut State<'_>, slot: Slot| {
        let at = state.slots.len();
        state.index.insert((slot.kind, slot.path.clone()), at);
        state.slots.push(slot);
    };

    // 1. Per-path three-way choice.
    let doc_paths: BTreeSet<&String> = base
        .documents
        .keys()
        .chain(main.documents.keys())
        .chain(proposal.documents.keys())
        .collect();
    for path in doc_paths {
        state.tick()?;
        let (b, m, p) = (
            base.documents.get(path),
            main.documents.get(path),
            proposal.documents.get(path),
        );
        let value = if same_blob(m, p) || same_blob(b, p) {
            m.cloned()
        } else if same_blob(b, m) {
            p.cloned()
        } else {
            let merged = match (m, p) {
                (Some(_), Some(_)) => line_merges.get(path.as_str()).cloned().flatten(),
                _ => None,
            };
            match merged {
                Some(bytes)
                    if bytes.len() <= TREE_LIMITS.max_markdown_bytes
                        && parse_markdown(&bytes).is_ok() =>
                {
                    Some(Blob {
                        sha: git_blob_sha(&bytes),
                        size: Some(bytes.len() as u64),
                        bytes: Some(Rc::new(bytes)),
                    })
                }
                _ => {
                    state.conflict(Kind::Document, path);
                    p.cloned()
                }
            }
        };
        let pinned = same_blob(value.as_ref(), m);
        push(
            &mut state,
            Slot {
                kind: Kind::Document,
                path: path.clone(),
                value: value.map(Value::Document),
                pinned,
                claimed: false,
                id: None,
            },
        );
    }
    let asset_paths: BTreeSet<&String> = base
        .assets
        .keys()
        .chain(main.assets.keys())
        .chain(proposal.assets.keys())
        .collect();
    for path in asset_paths {
        state.tick()?;
        let (b, m, p) = (
            base.assets.get(path),
            main.assets.get(path),
            proposal.assets.get(path),
        );
        let value = if same_asset(m, p) || same_asset(b, p) {
            m.cloned()
        } else if same_asset(b, m) {
            p.cloned()
        } else {
            state.conflict(Kind::Asset, path);
            p.cloned()
        };
        let pinned = same_asset(value.as_ref(), m);
        push(
            &mut state,
            Slot {
                kind: Kind::Asset,
                path: path.clone(),
                value: value.map(Value::Asset),
                pinned,
                claimed: false,
                id: None,
            },
        );
    }

    let mut changed: Vec<usize> = (0..state.slots.len())
        .filter(|&at| !state.slots[at].pinned && state.slots[at].value.is_some())
        .collect();
    // Recorded conflicts: their saved choices, and a slot for every path (an
    // empty, unclaimed one where no tree holds it any more).
    let mut saved: HashMap<(Kind, String), Vec<Value>> = HashMap::new();
    for item in recorded {
        let key = (item.kind, item.path.clone());
        if !state.index.contains_key(&key) {
            push(
                &mut state,
                Slot {
                    kind: item.kind,
                    path: item.path.clone(),
                    value: None,
                    pinned: false,
                    claimed: false,
                    id: None,
                },
            );
        }
        saved
            .entry(key)
            .or_default()
            .extend(item.choices.iter().cloned());
    }
    let mut id_candidates: Vec<Blob> = changed
        .iter()
        .filter_map(|&at| match &state.slots[at].value {
            Some(Value::Document(blob)) => Some(blob.clone()),
            _ => None,
        })
        .collect();
    for ((kind, _), values) in &saved {
        if *kind == Kind::Document {
            id_candidates.extend(values.iter().filter_map(|v| match v {
                Value::Document(blob) => Some(blob.clone()),
                Value::Asset(_) => None,
            }));
        }
    }
    let mut ids_matter = false;
    for blob in &id_candidates {
        state.tick()?;
        if state.id_of(blob)?.is_some() {
            ids_matter = true;
            break;
        }
    }

    // 2. Claims. The managed files hold their keys for good (a sentinel).
    state.totals.tree_files = 2; // .gitignore and the manifest
    state.totals.tree_dirs = 1; // .assets
    state.totals.tree_bytes = main.managed.values().map(|b| b.size.unwrap_or(0)).sum();
    for path in main
        .managed
        .keys()
        .map(String::as_str)
        .chain(std::iter::once(MANIFEST_PATH))
    {
        for p in prefixes(path) {
            if !p.dir {
                state.files.insert(p.key, RESERVED);
            } else {
                state.dirs.insert(
                    p.key,
                    Dir {
                        spelling: p.spelling,
                        holders: BTreeSet::from([RESERVED]),
                        tree_holders: 1,
                    },
                );
            }
        }
    }

    // A worklist of fallbacks: a changed entry that clashes (or must give way
    // to a limit) takes main's version; if that exists it is pinned and
    // evicts only the changed entries holding its keys, which fall back in turn.
    let mut queue: Vec<usize> = Vec::new();
    fn fall_back(state: &mut State<'_>, main: &LogicalTree, queue: &mut Vec<usize>, at: usize) {
        if state.slots[at].pinned {
            return;
        }
        let (kind, path) = (state.slots[at].kind, state.slots[at].path.clone());
        state.conflict(kind, &path);
        state.release(at);
        state.slots[at].value = main_value(main, kind, &path);
        state.slots[at].pinned = true;
        if state.slots[at].value.is_some() {
            queue.push(at);
        }
    }
    fn settle(
        state: &mut State<'_>,
        main: &LogicalTree,
        queue: &mut Vec<usize>,
        ids_matter: bool,
    ) -> Result<(), StoreError> {
        while let Some(at) = queue.pop() {
            state.tick()?;
            state.prepare(at, ids_matter)?;
            for other in state.clashing(at) {
                fall_back(state, main, queue, other);
            }
            state.claim(at);
        }
        Ok(())
    }
    // Main's own entries first (valid together), then changed entries in order.
    for at in 0..state.slots.len() {
        if state.slots[at].pinned && state.slots[at].value.is_some() {
            state.tick()?;
            state.prepare(at, ids_matter)?;
            state.claim(at);
        }
    }
    changed.sort_by(|&a, &b| {
        by_path_then_kind(
            (&state.slots[a].path, state.slots[a].kind),
            (&state.slots[b].path, state.slots[b].kind),
        )
    });
    for &at in &changed {
        state.tick()?;
        if state.slots[at].pinned {
            continue; // already fell back
        }
        state.prepare(at, ids_matter)?;
        if state.clashes(at) {
            fall_back(&mut state, main, &mut queue, at);
        } else {
            state.claim(at);
        }
        settle(&mut state, main, &mut queue, ids_matter)?;
    }

    // 3. Repository limits, to a fixpoint: while any is exceeded, the
    // latest-sorted changed entry contributing positively to it falls back.
    if enforce_limits {
        let mut candidates = changed.clone();
        candidates.reverse();
        let contribution = |state: &State<'_>, at: usize, limit: Limit| -> i64 {
            let slot = &state.slots[at];
            if slot.pinned || !slot.claimed {
                0
            } else {
                measure(slot.value.as_ref(), limit)
                    - measure(main_value(main, slot.kind, &slot.path).as_ref(), limit)
            }
        };
        let mut cursor: BTreeMap<Limit, usize> = BTreeMap::new();
        while let Some(limit) = exceeded_tree_limit(&state.current_totals()) {
            state.tick()?;
            let at = cursor.entry(limit).or_insert(0);
            while *at < candidates.len() && contribution(&state, candidates[*at], limit) <= 0 {
                *at += 1;
            }
            // Only when main itself is over (it cannot be): validation decides.
            let Some(&slot) = candidates.get(*at) else {
                break;
            };
            fall_back(&mut state, main, &mut queue, slot);
            settle(&mut state, main, &mut queue, ids_matter)?;
        }
    }

    // 4. Closure: every entry a conflict's resolution choice would collide
    // with is itself a recorded, typed conflict.
    let mut reported_dirs: BTreeSet<String> = BTreeSet::new();
    for item in recorded {
        let key = (item.kind, item.path.clone());
        state.conflicts.entry(key).or_insert_with(|| Conflict {
            path: item.path.clone(),
            kind: item.kind,
            standing: item.standing,
        });
    }
    let mut pending: Vec<usize> = (0..state.slots.len())
        .filter(|&at| state.has_conflict(state.slots[at].kind, &state.slots[at].path))
        .collect();
    fn report(state: &mut State<'_>, pending: &mut Vec<usize>, other: usize) {
        if other == RESERVED {
            return;
        }
        let (kind, path) = (state.slots[other].kind, state.slots[other].path.clone());
        if state.has_conflict(kind, &path) {
            return;
        }
        let standing = state.slots[other].pinned;
        state.conflicts.insert(
            (kind, path.clone()),
            Conflict {
                path,
                kind,
                standing,
            },
        );
        pending.push(other);
    }
    while let Some(at) = pending.pop() {
        state.tick()?;
        let (kind, path) = (state.slots[at].kind, state.slots[at].path.clone());
        let mut choices: Vec<Value> = Vec::new();
        choices.extend(main_value(main, kind, &path));
        choices.extend(match kind {
            Kind::Document => proposal.documents.get(&path).cloned().map(Value::Document),
            Kind::Asset => proposal.assets.get(&path).cloned().map(Value::Asset),
        });
        choices.extend(
            saved
                .get(&(kind, path.clone()))
                .cloned()
                .unwrap_or_default(),
        );
        if choices.is_empty() {
            continue;
        }
        for p in prefixes(&path) {
            if let Some(&file) = state.files.get(&p.key)
                && file != at
            {
                report(&mut state, &mut pending, file);
            }
            let holders: Option<Vec<usize>> = state.dirs.get(&p.key).and_then(|dir| {
                ((!p.dir || dir.spelling != p.spelling) && !reported_dirs.contains(&p.key))
                    .then(|| dir.holders.iter().copied().collect())
            });
            if let Some(holders) = holders {
                reported_dirs.insert(p.key.clone());
                for holder in holders {
                    if holder != at {
                        report(&mut state, &mut pending, holder);
                    }
                }
            }
        }
        if kind == Kind::Document && ids_matter {
            for choice in &choices {
                let Value::Document(blob) = choice else {
                    continue;
                };
                if let Some(id) = state.id_of(blob)?
                    && let Some(&holder) = state.id_holders.get(&id)
                    && holder != at
                {
                    report(&mut state, &mut pending, holder);
                }
            }
        }
    }

    let mut tree = LogicalTree {
        managed: main.managed.clone(),
        ..LogicalTree::default()
    };
    for slot in &state.slots {
        if !slot.claimed {
            continue;
        }
        match &slot.value {
            Some(Value::Document(blob)) => {
                tree.documents.insert(slot.path.clone(), blob.clone());
            }
            Some(Value::Asset(entry)) => {
                tree.assets.insert(slot.path.clone(), entry.clone());
            }
            None => {}
        }
    }
    let totals = state.current_totals();
    let mut conflicts: Vec<Conflict> = state.conflicts.into_values().collect();
    conflicts.sort_by(|a, b| by_path_then_kind((&a.path, a.kind), (&b.path, b.kind)));
    Ok(MergeOutput {
        tree,
        conflicts,
        totals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_entry_bytes_match_the_canonical_manifest() {
        let entries = vec![
            ManifestEntry {
                path: "a/é \"q\".png".into(),
                hash: format!("sha256:{}", "0".repeat(64)),
                size: 12345,
                mime: "image/png".into(),
            },
            ManifestEntry {
                path: "b.png".into(),
                hash: format!("sha256:{}", "1".repeat(64)),
                size: 7,
                mime: "image/png".into(),
            },
        ];
        let total: u64 = entries.iter().map(manifest_entry_bytes).sum();
        assert_eq!(
            manifest_byte_length(total, entries.len() as u64),
            canonical_manifest_bytes(&entries).len() as u64
        );
        assert_eq!(
            manifest_byte_length(0, 0),
            canonical_manifest_bytes(&[]).len() as u64
        );
    }

    /// In-memory blobs and the corpus's line merges.
    struct Memory {
        blobs: HashMap<String, Vec<u8>>,
        merges: HashMap<String, Option<Vec<u8>>>,
    }
    impl Memory {
        fn put(&mut self, bytes: &[u8]) -> Blob {
            let sha = git_blob_sha(bytes);
            self.blobs.insert(sha.clone(), bytes.to_vec());
            Blob {
                sha,
                size: Some(bytes.len() as u64),
                bytes: None,
            }
        }
    }
    impl MergeSource for Memory {
        fn read(&mut self, sha: &str) -> Result<Vec<u8>, StoreError> {
            self.blobs.get(sha).cloned().ok_or(StoreError::NotFound)
        }
        fn merge_texts(
            &mut self,
            items: &[LineMergeItem<'_>],
        ) -> Result<HashMap<String, Option<Vec<u8>>>, StoreError> {
            Ok(items
                .iter()
                .map(|i| {
                    (
                        i.path.to_owned(),
                        self.merges.get(i.path).cloned().flatten(),
                    )
                })
                .collect())
        }
    }

    fn entry(value: &serde_json::Value) -> ManifestEntry {
        let text = |k: &str| value[k].as_str().expect("fixture entry").to_owned();
        ManifestEntry {
            path: text("path"),
            hash: text("hash"),
            size: value["size"].as_u64().expect("fixture entry size"),
            mime: text("mime"),
        }
    }

    fn fixture_tree(
        memory: &mut Memory,
        corpus: &serde_json::Value,
        spec: &serde_json::Value,
    ) -> LogicalTree {
        let mut entries = Vec::new();
        let text = |v: &serde_json::Value| v.as_str().expect("fixture text").as_bytes().to_vec();
        entries.push((
            ".gitignore".to_owned(),
            memory.put(&text(&corpus["gitignore"])),
        ));
        entries.push(("index.md".to_owned(), memory.put(&text(&corpus["index"]))));
        for i in 0..spec["bulk"].as_u64().unwrap_or(0) {
            entries.push((format!("bulk/d{i:04}.md"), memory.put(b"x\n")));
        }
        for (path, body) in spec["docs"].as_object().into_iter().flatten() {
            entries.push((path.clone(), memory.put(&text(body))));
        }
        let assets: Vec<ManifestEntry> = spec["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .map(entry)
            .collect();
        let manifest = canonical_manifest_bytes(&assets);
        logical_tree_of(entries, Some(&manifest)).expect("fixture manifest")
    }

    /// The corpus `logical-merge.test.ts` runs too: the same inputs produce
    /// the same conflicts, tree and totals as the server's merge.
    #[test]
    fn shared_corpus() {
        let text = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../packages/api/src/lib/kb/fixtures/logical-merge-cases.json"
        ))
        .expect("shared corpus");
        let corpus: serde_json::Value = serde_json::from_str(&text).expect("corpus json");
        let cases = corpus["cases"].as_array().expect("cases");
        assert!(cases.len() > 100);
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let mut memory = Memory {
                blobs: HashMap::new(),
                merges: case["lineMerges"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(p, v)| (p.clone(), v.as_str().map(|s| s.as_bytes().to_vec())))
                    .collect(),
            };
            let base = fixture_tree(&mut memory, &corpus, &case["base"]);
            let main = fixture_tree(&mut memory, &corpus, &case["main"]);
            let proposal = fixture_tree(&mut memory, &corpus, &case["proposal"]);
            let recorded: Vec<Recorded> = case["recorded"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| {
                    let kind: Kind = serde_json::from_value(r["kind"].clone()).expect("kind");
                    let choice = &r["choice"];
                    let choices = if choice.is_null() {
                        Vec::new()
                    } else if let Some(text) = choice.as_str() {
                        vec![Value::Document(memory.put(text.as_bytes()))]
                    } else {
                        vec![Value::Asset(entry(choice))]
                    };
                    Recorded {
                        path: r["path"].as_str().expect("path").to_owned(),
                        kind,
                        standing: r["standing"].as_bool().unwrap_or(false),
                        choices,
                    }
                })
                .collect();
            let out = merge_logical_trees(&base, &main, &proposal, &mut memory, true, &recorded)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let expect = &case["expect"];
            let conflicts: Vec<Conflict> =
                serde_json::from_value(expect["conflicts"].clone()).expect("conflicts");
            assert_eq!(out.conflicts, conflicts, "{name}: conflicts");
            let mut documents = serde_json::Map::new();
            let mut bulk = 0;
            for (path, blob) in &out.tree.documents {
                if path.starts_with("bulk/") {
                    bulk += 1;
                } else if path != "index.md" {
                    let bytes = match &blob.bytes {
                        Some(b) => b.as_ref().clone(),
                        None => memory.read(&blob.sha).expect("blob"),
                    };
                    documents.insert(path.clone(), String::from_utf8(bytes).expect("utf8").into());
                }
            }
            assert_eq!(
                serde_json::Value::Object(documents),
                expect["documents"],
                "{name}: documents"
            );
            assert_eq!(
                bulk,
                expect["bulkDocuments"].as_u64().unwrap_or(0),
                "{name}: bulk"
            );
            let assets: Vec<ManifestEntry> = expect["assets"]
                .as_array()
                .expect("assets")
                .iter()
                .map(entry)
                .collect();
            let mut got: Vec<ManifestEntry> = out.tree.assets.values().cloned().collect();
            got.sort_by(|a, b| js_cmp(&a.path, &b.path));
            assert_eq!(got, assets, "{name}: assets");
            let totals: TreeTotals =
                serde_json::from_value(expect["totals"].clone()).expect("totals");
            assert_eq!(out.totals, totals, "{name}: totals");
        }
    }

    #[test]
    fn js_order_is_utf16() {
        // U+FF5E sorts after U+1F600 in UTF-8 but before it in UTF-16.
        assert_eq!(js_cmp("\u{1F600}", "\u{FF5E}"), Ordering::Less);
    }
}
