//! Local KB lifecycle (create/list/get/update/tombstone, quotas,
//! capability-narrowed create) and the immutable document catalog (list/get
//! at a pinned reachable revision, HMAC cursors).
//!
//! Every output is checked against the shared kb/1 output schema
//! (`packages/api/src/lib/kb/protocol/schema.json`) through kb-client, so the
//! local backend emits exactly the remote wire shapes.

#[path = "../../support/temp_dir.rs"]
mod temp_dir;

#[path = "../../support/scratch_git.rs"]
mod scratch_git;
use scratch_git::scratch_git;
use temp_dir::TestDir;

use std::path::Path;
use std::process::Stdio;

use kb_client::ErrorCode;
use kb_client::schema::{Direction, validate};
use kb_client::tools::{
    BasesCreate, BasesDelete, BasesGet, BasesList, BasesUpdate, DocumentsGet, DocumentsList, Tool,
};
use kb_client::types::{KbId, Permission, Sha, WriteMode};
use kb_client::{decode_input, host::snapshot::content_hash};
use kb_local::limits::{
    CREATES_PER_HOUR_PER_USER, CURSOR_TTL_SECS, LocalLimits, OWNED_LIVE_KBS_PER_USER, PAGE_DEFAULT,
    PAGE_MAX,
};
use kb_local::{
    CommitRequest, FileChange, LocalPrincipal, PrincipalKind, Stage, Store, StoreError,
    local_attachment,
};
use serde_json::{Value, json};

// ── Fixtures ────────────────────────────────────────────────────────────────

fn temp_root(tag: &str) -> TestDir {
    let base = temp_dir::unique_path(&format!("kb-local-bases-{tag}"));
    std::fs::create_dir_all(&base).expect("base");
    TestDir::new(base).child("store")
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = scratch_git()
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(args)
        .env("GIT_AUTHOR_NAME", "External")
        .env("GIT_AUTHOR_EMAIL", "external@example.invalid")
        .env("GIT_COMMITTER_NAME", "External")
        .env("GIT_COMMITTER_EMAIL", "external@example.invalid")
        .stdin(Stdio::null())
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_owned()
}

fn git_bytes(repo: &Path, args: &[&str]) -> Vec<u8> {
    let out = scratch_git()
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("git");
    assert!(out.status.success(), "git {args:?}");
    out.stdout
}

fn sha(text: &str) -> Sha {
    Sha::parse(text).expect("sha")
}

/// Serialize an output and check it against the shared kb/1 output schema.
fn wire<T: Tool>(output: &T::Output) -> Value {
    let value = serde_json::to_value(output).expect("serialize");
    if let Err(violation) = validate(T::NAME.as_str(), Direction::Output, &value) {
        panic!("{} output violates the shared schema: {violation}", T::NAME);
    }
    value
}

fn input<T: Tool>(value: Value) -> T::Input {
    decode_input::<T>(value).expect("valid input")
}

fn create(store: &Store, who: &LocalPrincipal, slug: &str, key: &str) -> Value {
    let out = store
        .bases_create(
            who,
            input::<BasesCreate>(json!({
                "name": format!("KB {slug}"),
                "slug": slug,
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": key,
            })),
        )
        .expect("create");
    wire::<BasesCreate>(&out)
}

fn kb_of(created: &Value) -> KbId {
    KbId::parse(created["kb"]["id"].as_str().expect("id")).expect("kb id")
}

fn head_of(created: &Value) -> Sha {
    sha(created["kb"]["headSha"].as_str().expect("head"))
}

fn commit(store: &Store, kb: &KbId, base: &Sha, key: &str, files: &[(&str, &str)]) -> Sha {
    store
        .commit_files(
            &store.owner(),
            CommitRequest {
                kb: kb.clone(),
                base_revision: base.clone(),
                idempotency_key: key.to_owned(),
                changes: files
                    .iter()
                    .map(|(path, body)| FileChange {
                        path: (*path).to_owned(),
                        content: Some(body.as_bytes().to_vec()),
                    })
                    .collect(),
            },
        )
        .expect("commit")
        .commit_sha
}

fn reader(store: &Store, kb: &KbId, bits: &[Permission]) -> LocalPrincipal {
    let guard = store.lock_write(&[]).expect("lock");
    let principal = store
        .register_principal(&guard, PrincipalKind::Test, kb, bits)
        .expect("principal");
    drop(guard);
    principal
}

fn code(error: StoreError) -> ErrorCode {
    error.protocol_code()
}

fn get_kb(store: &Store, who: &LocalPrincipal, kb: &KbId) -> Result<Value, StoreError> {
    store
        .bases_get(who, input::<BasesGet>(json!({ "kbId": kb.as_str() })))
        .map(|out| wire::<BasesGet>(&out))
}

fn list_docs(store: &Store, who: &LocalPrincipal, args: Value) -> Result<Value, StoreError> {
    store
        .documents_list(who, input::<DocumentsList>(args))
        .map(|out| wire::<DocumentsList>(&out))
}

fn get_doc(store: &Store, who: &LocalPrincipal, args: Value) -> Result<Value, StoreError> {
    store
        .documents_get(who, input::<DocumentsGet>(args))
        .map(|out| wire::<DocumentsGet>(&out))
}

/// Backdate every KB_CREATE reservation so the per-hour creation window is
/// empty again (the window is a wall-clock budget, not a quota).
fn age_creation_window(root: &Path) {
    let conn = rusqlite::Connection::open(root.join("state.sqlite")).expect("state");
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .expect("busy");
    conn.execute(
        "UPDATE operation_intents SET created_at = '2000-01-01T00:00:00Z' \
         WHERE operation = 'KB_CREATE'",
        [],
    )
    .expect("age");
}

fn state_value(root: &Path, sql: &str, kb: &KbId) -> String {
    let conn = rusqlite::Connection::open(root.join("state.sqlite")).expect("state");
    conn.query_row(sql, [kb.as_str()], |row| row.get(0))
        .expect("query")
}

fn next(
    store: &Store,
    who: &LocalPrincipal,
    kb: &KbId,
    cursor: &str,
    extra: Value,
) -> Result<Value, StoreError> {
    let mut args = json!({"kbId": kb.as_str(), "limit": 1, "cursor": cursor});
    if let Value::Object(map) = extra {
        for (k, v) in map {
            args[k] = v;
        }
    }
    list_docs(store, who, args)
}

mod admission;
mod catalog;
mod lifecycle;
mod registry;
