//! Complete, ordered file/asset deltas at two immutable revisions. One
//! stream (assets then files, UTF-16 keys) bounds both kinds to <=200/page.
use crate::{
    StoreError,
    git_read::{EntryKind, GitRepo, IncomingBudget, ObjectKind, WalkBudget, walk_tree},
    tree::{MANIFEST_PATH, TREE_LIMITS, parse_manifest},
};
use kb_client::types::{AssetDelta, AssetRef, FileDelta, FileDeltaStatus, KbPath, Sha};
use std::collections::{BTreeMap, BTreeSet};

pub struct DiffPage {
    pub files: Vec<FileDelta>,
    pub touched_assets: Vec<AssetDelta>,
    pub next_after: Option<String>,
}

pub(crate) fn entries(repo: &GitRepo, revision: &Sha) -> Result<BTreeMap<String, Sha>, StoreError> {
    let mut reader = repo.object_reader()?;
    let commit = reader.read_commit(revision)?;
    let entries = walk_tree(
        &mut reader,
        &commit.tree,
        &mut WalkBudget::new(TREE_LIMITS.max_entries),
        &mut IncomingBudget::new(
            TREE_LIMITS.max_objects,
            TREE_LIMITS.max_uncompressed_object_bytes,
            None,
        ),
    )?;
    entries
        .into_iter()
        .filter(|e| e.kind == EntryKind::Blob)
        .map(|e| {
            let sha =
                Sha::parse(&e.sha).map_err(|_| StoreError::RecoveryRequired("blob SHA".into()))?;
            Ok((e.path, sha))
        })
        .collect()
}
fn path(value: &str) -> Result<KbPath, StoreError> {
    KbPath::parse(value).map_err(|_| StoreError::RecoveryRequired("diff path".into()))
}
fn assets(
    repo: &GitRepo,
    files: &BTreeMap<String, Sha>,
) -> Result<BTreeMap<String, AssetRef>, StoreError> {
    let Some(blob) = files.get(MANIFEST_PATH) else {
        return Ok(BTreeMap::new());
    };
    let bytes = repo.object_reader()?.read(
        blob.as_str(),
        ObjectKind::Blob,
        crate::git_read::DOCUMENT_MAX_BYTES,
    )?;
    parse_manifest(&bytes)
        .map_err(|_| StoreError::StorageUnavailable("asset manifest unavailable".into()))?
        .into_iter()
        .map(|e| {
            // Deserialize the exact shared AssetRef, including trusted MIME/size bounds.
            let asset: AssetRef = serde_json::from_value(
                serde_json::json!({"path":e.path,"hash":e.hash,"size":e.size,"mime":e.mime}),
            )
            .map_err(|_| StoreError::StorageUnavailable("asset manifest unavailable".into()))?;
            Ok((asset.path.as_str().to_owned(), asset))
        })
        .collect()
}
/// Read pinned base/head objects, never a branch's current HEAD. The caller
/// owns read authorization and reachability; all tree walks are budgeted.
pub fn diff_at_revisions(
    repo: &GitRepo,
    base: &Sha,
    head: &Sha,
    limit: usize,
    after: Option<&str>,
) -> Result<DiffPage, StoreError> {
    let before = entries(repo, base)?;
    let next = entries(repo, head)?;
    let old_assets = assets(repo, &before)?;
    let new_assets = assets(repo, &next)?;
    let mut deltas = Vec::new();
    for p in before.keys().chain(next.keys()).collect::<BTreeSet<_>>() {
        let a = before.get(p);
        let b = next.get(p);
        if a != b {
            deltas.push((
                format!("f:{p}"),
                Some(FileDelta {
                    path: path(p)?,
                    status: if a.is_none() {
                        FileDeltaStatus::Added
                    } else if b.is_none() {
                        FileDeltaStatus::Deleted
                    } else {
                        FileDeltaStatus::Modified
                    },
                    before_blob_sha: a.cloned(),
                    after_blob_sha: b.cloned(),
                }),
                None,
            ));
        }
    }
    for p in old_assets
        .keys()
        .chain(new_assets.keys())
        .collect::<BTreeSet<_>>()
    {
        let a = old_assets.get(p);
        let b = new_assets.get(p);
        if a != b {
            deltas.push((
                format!("a:{p}"),
                None,
                Some(AssetDelta {
                    path: path(p)?,
                    before: a.cloned(),
                    after: b.cloned(),
                }),
            ));
        }
    }
    deltas.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let limit = limit.clamp(1, 200);
    let mut selected = deltas
        .into_iter()
        .filter(|e| after.is_none_or(|key| e.0.encode_utf16().cmp(key.encode_utf16()).is_gt()))
        .take(limit + 1)
        .collect::<Vec<_>>();
    let more = selected.len() > limit;
    selected.truncate(limit);
    let next_after = if more {
        selected.last().map(|e| e.0.clone())
    } else {
        None
    };
    Ok(DiffPage {
        files: selected.iter().filter_map(|e| e.1.clone()).collect(),
        touched_assets: selected.into_iter().filter_map(|e| e.2).collect(),
        next_after,
    })
}
