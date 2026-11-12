//! L-14 — the local store keeps Git internals owner-only on Unix: Git runs
//! with `core.sharedRepository=0600`, a new repository is tightened after
//! `git init`, and opening a store tightens repositories written by an older
//! `kb` (or under a looser umask).
#![cfg(unix)]

#[path = "support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use kb_client::decode_input;
use kb_client::types::{BasesCreate, KbId, Sha};
use kb_local::{CommitRequest, FileChange, Store};
use serde_json::json;

fn temp_root(tag: &str) -> TestDir {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "kb-local-owner-only-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).expect("base");
    TestDir::new(base).child("store")
}

/// Every non-link entry under `dir` (including `dir`) with group/other bits.
fn loose_entries(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path).expect("stat");
        if meta.file_type().is_symlink() {
            continue;
        }
        let mode = meta.permissions().mode();
        if mode & 0o077 != 0 {
            out.push(format!("{:o} {}", mode & 0o7777, path.display()));
        }
        if meta.is_dir() {
            for entry in std::fs::read_dir(&path).expect("read_dir") {
                stack.push(entry.expect("entry").path());
            }
        }
    }
    out
}

fn loosen(dir: &Path) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path).expect("stat");
        let mode = meta.permissions().mode();
        let extra = if meta.is_dir() { 0o055 } else { 0o044 };
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode | extra))
            .expect("chmod");
        if meta.is_dir() {
            for entry in std::fs::read_dir(&path).expect("read_dir") {
                stack.push(entry.expect("entry").path());
            }
        }
    }
}

fn commit(store: &Store, kb: &KbId, base: &Sha, key: &str, path: &str) -> Sha {
    store
        .commit_files(
            &store.owner(),
            CommitRequest {
                kb: kb.clone(),
                base_revision: base.clone(),
                idempotency_key: key.to_owned(),
                changes: vec![FileChange {
                    path: path.to_owned(),
                    content: Some(format!("# {path}\n\nbody\n").into_bytes()),
                }],
            },
        )
        .expect("commit")
        .commit_sha
}

#[test]
fn store_git_internals_are_owner_only_and_tightened_on_open() {
    let root = temp_root("git");
    let store = Store::open(&root).expect("open");
    let created = store
        .bases_create(
            &store.owner(),
            decode_input::<BasesCreate>(json!({
                "name": "Owner only",
                "slug": "owner-only",
                "description": "Owner-only Git internals",
                "idempotencyKey": "owner-only-create-1",
            }))
            .expect("input"),
        )
        .expect("create");
    let created = serde_json::to_value(&created).expect("json");
    let kb = KbId::parse(created["kb"]["id"].as_str().expect("id")).expect("kb");
    let head = Sha::parse(created["kb"]["headSha"].as_str().expect("head")).expect("sha");
    let head = commit(&store, &kb, &head, "owner-only-commit-1", "a.md");
    let repo = store.paths().repo_dir(&kb);
    assert!(repo.join("objects").is_dir());
    assert_eq!(
        loose_entries(store.paths().root()),
        Vec::<String>::new(),
        "new store entries must be owner-only"
    );
    drop(store);

    // A repository written before this fix: group/other bits everywhere.
    loosen(&repo);
    assert!(!loose_entries(&repo).is_empty());
    let store = Store::open(&root).expect("reopen");
    assert_eq!(
        loose_entries(&repo),
        Vec::<String>::new(),
        "open must tighten an existing repository"
    );
    // Writes after the reopen stay owner-only too.
    commit(&store, &kb, &head, "owner-only-commit-2", "b.md");
    assert_eq!(loose_entries(store.paths().root()), Vec::<String>::new());
    drop(store);
    let _ = std::fs::remove_dir_all(root.parent().expect("base"));
}
