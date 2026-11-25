//! Raw Git tree objects of a managed repository, read through one
//! [`ObjectReader`]: Git's own mode canonicalization (`canon_mode`), the
//! validated depth-first walk with its entry and incoming-object budgets, and
//! exact segment-by-segment path lookup. Tree order and duplicates are seen
//! exactly as stored, matching the TypeScript `ls-tree` reading.

use std::collections::HashSet;

use kb_client::types::{KbPath, Sha};

use crate::git_read::{
    GitError, MAX_TREE_DEPTH, METADATA_OBJECT_MAX_BYTES, ObjectKind, ObjectReader,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Blob,
    Tree,
    /// Gitlink (submodule) or any mode Git canonicalizes to one.
    Commit,
}

/// One tree entry with its full path (no trailing slash).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    /// Canonical six-digit octal mode as `git ls-tree` prints it.
    pub mode: String,
    pub kind: EntryKind,
    pub sha: String,
    pub path: String,
}

/// Entry budget of one tree walk (the root counts as one entry).
#[derive(Clone, Debug)]
pub struct WalkBudget {
    pub entries: usize,
    pub max_entries: usize,
}

impl WalkBudget {
    pub fn new(max_entries: usize) -> WalkBudget {
        WalkBudget {
            entries: 0,
            max_entries,
        }
    }

    fn charge(&mut self) -> Result<(), GitError> {
        self.entries += 1;
        if self.entries > self.max_entries {
            return Err(GitError::Budget("tree exceeds entry budget".into()));
        }
        Ok(())
    }
}

/// Aggregate budget over distinct incoming objects shared by a traversal
/// range. With an `incoming` set, objects outside it (existing history) are
/// free.
#[derive(Clone, Debug)]
pub struct IncomingBudget {
    seen: HashSet<String>,
    incoming: Option<HashSet<String>>,
    pub objects: usize,
    pub bytes: usize,
    max_objects: usize,
    max_bytes: usize,
}

impl IncomingBudget {
    pub fn new(
        max_objects: usize,
        max_bytes: usize,
        incoming: Option<HashSet<String>>,
    ) -> IncomingBudget {
        IncomingBudget {
            seen: HashSet::new(),
            incoming,
            objects: 0,
            bytes: 0,
            max_objects,
            max_bytes,
        }
    }

    /// Charge one object before its content is read.
    pub fn charge(&mut self, sha: &str, size: usize) -> Result<(), GitError> {
        if let Some(incoming) = &self.incoming
            && !incoming.contains(sha)
        {
            return Ok(());
        }
        if !self.seen.insert(sha.to_owned()) {
            return Ok(());
        }
        self.objects += 1;
        self.bytes = self.bytes.saturating_add(size);
        if self.objects > self.max_objects {
            return Err(GitError::Budget(
                "object traversal exceeds object budget".into(),
            ));
        }
        if self.bytes > self.max_bytes {
            return Err(GitError::Budget(
                "object traversal exceeds uncompressed byte budget".into(),
            ));
        }
        Ok(())
    }
}

/// Git's `canon_mode`: what `ls-tree` reports for a stored mode.
fn canonical_mode(raw: &[u8]) -> Result<(u32, EntryKind), GitError> {
    if raw.is_empty() || raw.len() > 7 || !raw.iter().all(|b| (b'0'..=b'7').contains(b)) {
        return Err(GitError::Structure("malformed mode in tree entry".into()));
    }
    let mode = raw
        .iter()
        .fold(0u32, |acc, b| acc * 8 + u32::from(b - b'0'));
    Ok(match mode & 0o170000 {
        0o100000 => (
            0o100000 | if mode & 0o100 != 0 { 0o755 } else { 0o644 },
            EntryKind::Blob,
        ),
        0o120000 => (0o120000, EntryKind::Blob),
        0o040000 => (0o040000, EntryKind::Tree),
        _ => (0o160000, EntryKind::Commit),
    })
}

struct RawChild {
    mode: String,
    kind: EntryKind,
    sha: String,
    name: Vec<u8>,
}

fn parse_tree(body: &[u8]) -> Result<Vec<RawChild>, GitError> {
    let mut out = Vec::new();
    let mut rest = body;
    while !rest.is_empty() {
        let space = rest
            .iter()
            .position(|b| *b == b' ')
            .ok_or_else(|| GitError::Structure("malformed tree entry".into()))?;
        let (mode, kind) = canonical_mode(&rest[..space])?;
        let after = &rest[space + 1..];
        let nul = after
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| GitError::Structure("malformed tree entry".into()))?;
        let name = after[..nul].to_vec();
        let id = after
            .get(nul + 1..nul + 21)
            .ok_or_else(|| GitError::Structure("truncated tree entry".into()))?;
        if name.is_empty() {
            return Err(GitError::Structure(
                "tree entry name must not be empty".into(),
            ));
        }
        out.push(RawChild {
            mode: format!("{mode:06o}"),
            kind,
            sha: id.iter().map(|b| format!("{b:02x}")).collect(),
            name,
        });
        rest = &after[nul + 21..];
    }
    Ok(out)
}

/// Walk every entry of `tree`, depth-first pre-order; directories are
/// emitted before their children (so empty directories are validated).
/// Duplicate names, out-of-Git-order entries, names that are not one path
/// segment and nesting deeper than [`MAX_TREE_DEPTH`] are `Structure`
/// errors; non-UTF-8 names are `Budget` (TS parity). Each visited tree is
/// charged to `incoming` before it is parsed, and the walk stops as soon as
/// the entry budget is exceeded.
pub fn walk_tree(
    reader: &mut ObjectReader,
    tree: &Sha,
    budget: &mut WalkBudget,
    incoming: &mut IncomingBudget,
) -> Result<Vec<TreeEntry>, GitError> {
    let mut entries = Vec::new();
    visit(reader, tree.as_str(), "", 0, budget, incoming, &mut entries)?;
    Ok(entries)
}

fn visit(
    reader: &mut ObjectReader,
    sha: &str,
    prefix: &str,
    depth: usize,
    budget: &mut WalkBudget,
    incoming: &mut IncomingBudget,
    entries: &mut Vec<TreeEntry>,
) -> Result<(), GitError> {
    let (kind, body) = reader.read_checked(sha, METADATA_OBJECT_MAX_BYTES, &mut |_, size| {
        incoming.charge(sha, size)
    })?;
    if kind != ObjectKind::Tree {
        return Err(GitError::Structure(
            "tree entry does not name a tree".into(),
        ));
    }
    budget.charge()?;
    let mut names: HashSet<Vec<u8>> = HashSet::new();
    let mut previous: Option<Vec<u8>> = None;
    for child in parse_tree(&body)? {
        if !names.insert(child.name.clone()) {
            return Err(GitError::Structure("duplicate entry name in tree".into()));
        }
        let name = String::from_utf8(child.name.clone())
            .map_err(|_| GitError::Budget("tree path is not valid UTF-8".into()))?;
        if name.contains('/') {
            return Err(GitError::Structure(
                "tree entry name must not contain a slash".into(),
            ));
        }
        if name == "." || name == ".." {
            return Err(GitError::Structure(
                "tree entry name must not be a dot segment".into(),
            ));
        }
        if depth + 1 > MAX_TREE_DEPTH {
            return Err(GitError::Structure(
                "tree nesting exceeds depth budget".into(),
            ));
        }
        let mut sort_key = child.name.clone();
        if child.kind == EntryKind::Tree {
            sort_key.push(b'/');
        }
        if previous
            .as_ref()
            .is_some_and(|p| p.as_slice() >= sort_key.as_slice())
        {
            return Err(GitError::Structure("tree entry is out of order".into()));
        }
        previous = Some(sort_key);
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        entries.push(TreeEntry {
            mode: child.mode,
            kind: child.kind,
            sha: child.sha.clone(),
            path: path.clone(),
        });
        if child.kind == EntryKind::Tree {
            visit(
                reader,
                &child.sha,
                &path,
                depth + 1,
                budget,
                incoming,
                entries,
            )?;
            continue;
        }
        budget.charge()?;
    }
    Ok(())
}

/// The blob named by `path` in `tree`, matched exactly segment by segment
/// through the raw tree objects; `None` when absent or not a plain blob.
pub fn blob_at(
    reader: &mut ObjectReader,
    tree: &Sha,
    path: &KbPath,
) -> Result<Option<String>, GitError> {
    let mut current = tree.as_str().to_owned();
    let segments: Vec<&str> = path.as_str().split('/').collect();
    for (i, segment) in segments.iter().enumerate() {
        let body = reader.read(&current, ObjectKind::Tree, METADATA_OBJECT_MAX_BYTES)?;
        let Some(child) = parse_tree(&body)?
            .into_iter()
            .find(|child| child.name == segment.as_bytes())
        else {
            return Ok(None);
        };
        let last = i + 1 == segments.len();
        match (child.kind, last) {
            (EntryKind::Tree, false) => current = child.sha,
            (EntryKind::Blob, true) => return Ok(Some(child.sha)),
            _ => return Ok(None),
        }
    }
    Ok(None)
}
