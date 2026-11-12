//! Local KB lifecycle (create/list/get/update/tombstone, quotas,
//! capability-narrowed create) and the immutable document catalog (list/get
//! at a pinned reachable revision, HMAC cursors).
//!
//! Every output is checked against the shared kb/1 output schema
//! (`packages/api/src/lib/kb/protocol/schema.json`) through kb-client, so the
//! local backend emits exactly the remote wire shapes.

#[path = "support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use std::path::Path;
use std::process::{Command, Stdio};

use kb_client::ErrorCode;
use kb_client::schema::{Direction, validate};
use kb_client::types::{
    BasesCreate, BasesDelete, BasesGet, BasesList, BasesUpdate, DocumentsGet, DocumentsList, KbId,
    Permission, Sha, Tool, WriteMode,
};
use kb_client::{decode_input, snapshot::content_hash};
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
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "kb-local-bases-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).expect("base");
    TestDir::new(base).child("store")
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
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
    let out = Command::new("git")
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
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

// ── Creation, layout, replay ────────────────────────────────────────────────

#[test]
fn scratch_files_preserve_bytes_under_canonical_unicode_store_paths() {
    let root = temp_root("scratch-paths").child("store Ω with spaces");
    let store = Store::open(&root).expect("open");
    // Store::open canonicalizes this root (a verbatim path on Windows).
    assert_eq!(
        store.paths().root(),
        root.canonicalize().expect("canonical")
    );
    let created = create(&store, &store.owner(), "scratch", "create-key-scratch-01");
    let kb = kb_of(&created);
    let body = "# Unicode Ω\n\nExact bytes with CRLF next:\r\nend\n";
    let head = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-scratch-01",
        &[("nested/document.md", body)],
    );
    let repo = store.paths().repo_dir(&kb);
    assert_eq!(
        git_bytes(
            &repo,
            &["cat-file", "blob", &format!("{head}:nested/document.md")]
        ),
        body.as_bytes()
    );
    assert_eq!(git(&repo, &["rev-list", "--count", "refs/heads/main"]), "2");
    assert_eq!(
        std::fs::read_dir(store.paths().uploads_dir())
            .expect("scratch directory")
            .count(),
        0
    );
    drop(store);
    let reopened = Store::open(&root).expect("reopen");
    assert_eq!(
        get_kb(&reopened, &reopened.owner(), &kb).expect("get")["kb"]["headSha"],
        head.as_str()
    );
    drop(reopened);
    std::fs::remove_dir_all(root.parent().expect("fixture parent")).expect("cleanup");
}

#[test]
fn initial_repo_head_and_layout() {
    let root = temp_root("layout");
    let store = Store::open(&root).expect("open");
    let created = create(&store, &store.owner(), "alpha", "create-key-layout-01");
    let kb = kb_of(&created);
    let repo = store.paths().repo_dir(&kb);
    assert!(repo.ends_with(format!("repos/kb_{kb}.git")));
    // Bare repo, HEAD -> refs/heads/main, exactly one root commit.
    assert_eq!(git(&repo, &["rev-parse", "--is-bare-repository"]), "true");
    assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    let head = git(&repo, &["rev-parse", "refs/heads/main"]);
    assert_eq!(created["kb"]["headSha"], head.as_str());
    assert_eq!(git(&repo, &["rev-list", "--count", "refs/heads/main"]), "1");
    assert_eq!(
        git(&repo, &["for-each-ref", "--format=%(refname)"]),
        "refs/heads/main"
    );
    // Fixed initial tree.
    let tree = git(&repo, &["ls-tree", "-r", "--name-only", "refs/heads/main"]);
    assert_eq!(tree, ".assets/manifest.json\n.gitignore\nindex.md");
    assert_eq!(
        git_bytes(&repo, &["cat-file", "blob", "refs/heads/main:index.md"]),
        b"# Knowledge base\n\nA local knowledge base for lifecycle tests\n"
    );
    assert_eq!(
        git_bytes(&repo, &["cat-file", "blob", "refs/heads/main:.gitignore"]),
        b"# kb managed\n"
    );
    assert_eq!(
        git_bytes(
            &repo,
            &["cat-file", "blob", "refs/heads/main:.assets/manifest.json"]
        ),
        b"{\"version\":1,\"entries\":[]}\n"
    );
    // Attachment: owner holds every bit, stable local identity.
    let (locator, namespace) = local_attachment(store.store_uuid(), &kb);
    assert_eq!(
        created["kb"],
        json!({
            "id": kb.as_str(),
            "name": "KB alpha",
            "slug": "alpha",
            "description": "A local knowledge base for lifecycle tests",
            "defaultBranch": "main",
            "headSha": head,
            "metadataVersion": 1,
            "capabilities": ["read", "propose", "write", "review", "manage"],
            "writeMode": "direct",
            "embeddingGeneration": null,
            "attachmentLocator": locator,
            "sealedNamespace": namespace.as_str(),
        })
    );
    assert_eq!(locator, format!("kb-local://{}/{kb}", store.store_uuid()));
    // Get returns the same attachment plus an index status for this head.
    let got = get_kb(&store, &store.owner(), &kb).expect("get");
    assert_eq!(got["kb"], created["kb"]);
    assert_eq!(got["index"]["headSha"], head.as_str());
    assert_eq!(got["index"]["activeGenerationId"], Value::Null);
    // Even without a profile the first head gets a lexical generation.
    assert_eq!(got["index"]["freshness"], "building");
    assert_eq!(got["index"]["desiredState"], "PENDING");
    assert_eq!(got["index"]["desiredEpoch"], "1");
    // Stable store/KB identity across reopen.
    let store_uuid = store.store_uuid().clone();
    drop(store);
    let store = Store::open(&root).expect("reopen");
    assert_eq!(store.store_uuid(), &store_uuid);
    let again = get_kb(&store, &store.owner(), &kb).expect("get after reopen");
    assert_eq!(again["kb"], created["kb"]);
}

#[test]
fn create_replay_mismatch_and_invalid_metadata() {
    let root = temp_root("replay");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let first = create(&store, &owner, "alpha", "create-key-replay-01");
    let second = create(&store, &owner, "alpha", "create-key-replay-01");
    assert_eq!(first, second, "replay returns the same operation and kb");
    let err = store
        .bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "Other name",
                "slug": "alpha",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-replay-01",
            })),
        )
        .expect_err("mismatch");
    assert_eq!(code(err), ErrorCode::IdempotencyMismatch);
    // A second live KB with the same slug conflicts.
    let err = store
        .bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "Dup",
                "slug": "alpha",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-replay-02",
            })),
        )
        .expect_err("slug taken");
    assert_eq!(code(err), ErrorCode::Conflict);
    // Typed callers can mutate plain strings after decoding. Exercise the
    // local admission boundary as well as the shared protocol decoder.
    let mut invalid = input::<BasesCreate>(json!({
        "name": "Valid name",
        "slug": "beta",
        "description": "A local knowledge base for lifecycle tests",
        "idempotencyKey": "create-key-replay-03",
    }));
    invalid.name = "bad\u{7}name".into();
    assert!(
        decode_input::<BasesCreate>(serde_json::to_value(&invalid).expect("serialize")).is_err()
    );
    let err = store
        .bases_create(&owner, invalid)
        .expect_err("control in name");
    assert_eq!(code(err), ErrorCode::InvalidArgument);
    let db = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    assert_eq!(
        db.query_row("SELECT count(*) FROM kbs", [], |row| row.get::<_, i64>(0))
            .expect("registry count"),
        1,
        "invalid metadata must not reserve a hidden KB"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM operation_intents", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("intent count"),
        1,
        "invalid metadata must not reserve an operation"
    );
    drop(db);
    assert_eq!(
        store
            .bases_list(&owner, input::<BasesList>(json!({})))
            .expect("list")
            .items
            .len(),
        1
    );
}

#[test]
fn create_crash_recovery_replays_one_kb() {
    let root = temp_root("crash");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let request = |key: &str| kb_local::CreateKbRequest {
        name: "KB alpha".into(),
        slug: "alpha".into(),
        description: "A local knowledge base for lifecycle tests".into(),
        idempotency_key: key.into(),
    };
    // Crash after the ref moved: recovery finalizes, replay returns the KB.
    let err = store
        .create_kb_observed(&owner, request("create-key-crash-001"), &mut |stage| {
            if stage == Stage::RefMoved {
                Err(StoreError::Internal("simulated crash".into()))
            } else {
                Ok(())
            }
        })
        .expect_err("crash");
    assert_eq!(code(err), ErrorCode::Internal);
    drop(store);
    let store = Store::open(&root).expect("reopen");
    let replay = create(&store, &owner, "alpha", "create-key-crash-001");
    let kb = kb_of(&replay);
    // RefMoved recovery has finalized an ACTIVE KB. Metadata updates must
    // remain available once recovery succeeds, including same-key replay.
    let update = input::<BasesUpdate>(
        json!({ "kbId": kb.as_str(), "metadataVersion": 1, "name": "New", "idempotencyKey": "recovered-update-01" }),
    );
    let updated = store
        .bases_update(&owner, update.clone())
        .expect("update recovered kb");
    wire::<BasesUpdate>(&updated);
    assert_eq!(
        store.bases_update(&owner, update).expect("update replay"),
        updated
    );
    assert_eq!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("row")
            .metadata_version,
        2
    );
    let listed = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].id, kb);
    // Crash while COMMITTING before the ref moved: aborted, stable failure,
    // and the slug is free for a new key.
    let err = store
        .create_kb_observed(&owner, request("create-key-crash-002"), &mut |stage| {
            if stage == Stage::Committing {
                Err(StoreError::Internal("simulated crash".into()))
            } else {
                Ok(())
            }
        })
        .map(|_| ())
        .expect_err("slug of a live kb conflicts before reservation");
    assert_eq!(code(err), ErrorCode::Conflict);
    let err = store
        .create_kb_observed(
            &owner,
            kb_local::CreateKbRequest {
                slug: "beta".into(),
                ..request("create-key-crash-003")
            },
            &mut |stage| {
                if stage == Stage::Committing {
                    Err(StoreError::Internal("simulated crash".into()))
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("crash");
    assert_eq!(code(err), ErrorCode::Internal);
    drop(store);
    let store = Store::open(&root).expect("reopen");
    for _ in 0..2 {
        let err = store
            .bases_create(
                &owner,
                input::<BasesCreate>(json!({
                    "name": "KB alpha",
                    "slug": "beta",
                    "description": "A local knowledge base for lifecycle tests",
                    "idempotencyKey": "create-key-crash-003",
                })),
            )
            .expect_err("stable aborted receipt");
        assert!(matches!(err, StoreError::OperationAborted(_)), "{err:?}");
    }
    let beta = create(&store, &owner, "beta", "create-key-crash-004");
    assert_eq!(beta["kb"]["slug"], "beta");
}

// ── Update ──────────────────────────────────────────────────────────────────

#[test]
fn update_bumps_version_and_rejects_stale_versions() {
    let root = temp_root("update");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-update-01");
    let kb = kb_of(&created);
    let update = |who: &LocalPrincipal, version: i64, key: &str, name: &str| {
        store
            .bases_update(
                who,
                input::<BasesUpdate>(json!({
                    "kbId": kb.as_str(),
                    "metadataVersion": version,
                    "idempotencyKey": key,
                    "name": name,
                })),
            )
            .map(|out| wire::<BasesUpdate>(&out))
    };
    let first = update(&owner, 1, "update-key-000001", "Renamed").expect("update");
    assert_eq!(first["kb"]["name"], "Renamed");
    assert_eq!(first["kb"]["metadataVersion"], 2);
    assert_eq!(first["kb"]["headSha"], created["kb"]["headSha"]);
    let replay = update(&owner, 1, "update-key-000001", "Renamed").expect("replay");
    assert_eq!(replay["operationId"], first["operationId"]);
    assert_eq!(replay["kb"]["metadataVersion"], 2);
    let err = update(&owner, 1, "update-key-000001", "Other").expect_err("mismatch");
    assert_eq!(code(err), ErrorCode::IdempotencyMismatch);
    let err = update(&owner, 1, "update-key-000002", "Stale").expect_err("stale version");
    assert_eq!(code(err), ErrorCode::Conflict);
    let got = get_kb(&store, &owner, &kb).expect("get");
    assert_eq!(got["kb"]["name"], "Renamed");
    assert_eq!(got["kb"]["metadataVersion"], 2);
    // Description-only update.
    let desc = store
        .bases_update(
            &owner,
            input::<BasesUpdate>(json!({
                "kbId": kb.as_str(),
                "metadataVersion": 2,
                "idempotencyKey": "update-key-000003",
                "description": "A new description for this KB",
            })),
        )
        .expect("description");
    assert_eq!(desc.kb.description, "A new description for this KB");
    assert_eq!(desc.kb.metadata_version, 3);
    // Authority: read-only -> FORBIDDEN, unreadable -> NOT_FOUND.
    let read_only = reader(&store, &kb, &[Permission::Read]);
    let err = update(&read_only, 3, "update-key-000004", "Nope").expect_err("forbidden");
    assert_eq!(code(err), ErrorCode::Forbidden);
    let nobody = reader(&store, &kb, &[]);
    let err = update(&nobody, 3, "update-key-000005", "Nope").expect_err("hidden");
    assert_eq!(code(err), ErrorCode::NotFound);
    let manager = reader(&store, &kb, &[Permission::Manage]);
    let managed = update(&manager, 3, "update-key-000006", "Managed").expect("manage");
    assert_eq!(managed["kb"]["metadataVersion"], 4);
    // A private receipt is only replayed under current authority.
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &manager, &kb, &[Permission::Read])
        .expect("narrow");
    drop(guard);
    let err = update(&manager, 3, "update-key-000006", "Managed").expect_err("replay rechecks");
    assert_eq!(code(err), ErrorCode::Forbidden);
}

// ── Capability-narrowed create ──────────────────────────────────────────────

#[test]
fn capability_narrowed_create_obeys_the_ceiling() {
    let root = temp_root("capability");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let owned = kb_of(&create(&store, &owner, "owned", "create-key-cap-00001"));
    let guard = store.lock_write(&[]).expect("lock");
    let err = store
        .register_creator(&guard, PrincipalKind::Config, &[Permission::Write])
        .expect_err("created bits must include read");
    assert_eq!(code(err), ErrorCode::InvalidArgument);
    let creator = store
        .register_creator(
            &guard,
            PrincipalKind::Config,
            &[Permission::Read, Permission::Propose],
        )
        .expect("creator");
    drop(guard);
    let created = create(&store, &creator, "narrow", "create-key-cap-00002");
    let kb = kb_of(&created);
    assert_eq!(created["kb"]["capabilities"], json!(["read", "propose"]));
    assert_eq!(created["kb"]["writeMode"], "proposal_required");
    // The created ceiling never widens through creation.
    let err = store
        .bases_update(
            &creator,
            input::<BasesUpdate>(json!({
                "kbId": kb.as_str(),
                "metadataVersion": 1,
                "idempotencyKey": "update-key-cap-0001",
                "name": "Nope",
            })),
        )
        .expect_err("no manage");
    assert_eq!(code(err), ErrorCode::Forbidden);
    let err = store
        .commit_files(
            &creator,
            CommitRequest {
                kb: kb.clone(),
                base_revision: head_of(&created),
                idempotency_key: "commit-key-cap-0001".into(),
                changes: vec![FileChange {
                    path: "a.md".into(),
                    content: Some(b"# A\n".to_vec()),
                }],
            },
        )
        .expect_err("no write");
    assert_eq!(code(err), ErrorCode::Forbidden);
    // The creator sees only its own KB; the owner sees both with all bits.
    let mine = store
        .bases_list(&creator, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(mine.items.len(), 1);
    assert_eq!(mine.items[0].id, kb);
    assert_eq!(mine.items[0].write_mode, WriteMode::ProposalRequired);
    assert_eq!(
        code(get_kb(&store, &creator, &owned).expect_err("foreign")),
        ErrorCode::NotFound
    );
    let all = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(all.items.len(), 2);
    let owner_view = get_kb(&store, &owner, &kb).expect("owner get");
    assert_eq!(owner_view["kb"]["writeMode"], "direct");
    // Replay under current authority only.
    let replay = create(&store, &creator, "narrow", "create-key-cap-00002");
    assert_eq!(replay["operationId"], created["operationId"]);
    // No create capability -> FORBIDDEN; revocation applies to new creates.
    let plain = reader(&store, &kb, &[Permission::Manage]);
    let err = store
        .bases_create(
            &plain,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "plain",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-cap-00003",
            })),
        )
        .expect_err("no create capability");
    assert_eq!(code(err), ErrorCode::Forbidden);
    let guard = store.lock_write(&[]).expect("lock");
    store
        .revoke_create_capability(&guard, &creator)
        .expect("revoke");
    drop(guard);
    let err = store
        .bases_create(
            &creator,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "again",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-cap-00004",
            })),
        )
        .expect_err("revoked");
    assert_eq!(code(err), ErrorCode::Forbidden);
    // Losing read on the created KB hides it (also from list).
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &creator, &kb, &[])
        .expect("narrow to nothing");
    drop(guard);
    assert_eq!(
        code(get_kb(&store, &creator, &kb).expect_err("hidden")),
        ErrorCode::NotFound
    );
    assert!(
        store
            .bases_list(&creator, input::<BasesList>(json!({})))
            .expect("list")
            .items
            .is_empty()
    );
}

// ── Tombstone ───────────────────────────────────────────────────────────────

#[test]
fn tombstone_retains_history_and_cancels_registered_work() {
    let root = temp_root("tombstone");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-tomb-0001");
    let kb = kb_of(&created);
    let head = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-tomb-0001",
        &[("notes/a.md", "# A\n")],
    );
    let guard = store.lock_write(std::slice::from_ref(&kb)).expect("lock");
    let generation = kb.clone();
    let db = rusqlite::Connection::open(store.paths().state_db()).unwrap();
    db.execute("INSERT INTO index_generations(id,kb_id,epoch,state,created_at,commit_sha,snapshot_json,job_id) VALUES(?1,?1,0,'PENDING','fixture',?2,'{}',?3)",(kb.as_str(),head.as_str(),store.owner().id())).unwrap();
    drop(guard);
    let delete = |who: &LocalPrincipal, version: i64, key: &str| {
        store
            .bases_delete(
                who,
                input::<BasesDelete>(json!({
                    "kbId": kb.as_str(),
                    "metadataVersion": version,
                    "idempotencyKey": key,
                    "confirm": "DELETE",
                })),
            )
            .map(|out| wire::<BasesDelete>(&out))
    };
    // Owner-only; stale version conflicts.
    let manager = reader(&store, &kb, &[Permission::Manage]);
    assert_eq!(
        code(delete(&manager, 1, "delete-key-000001").expect_err("not owner")),
        ErrorCode::Forbidden
    );
    assert_eq!(
        code(delete(&owner, 7, "delete-key-000002").expect_err("stale")),
        ErrorCode::Conflict
    );
    let receipt = delete(&owner, 1, "delete-key-000003").expect("tombstone");
    assert_eq!(receipt["tombstoned"], true);
    let replay = delete(&owner, 1, "delete-key-000003").expect("replay");
    assert_eq!(replay, receipt);
    // Hidden everywhere.
    assert_eq!(
        code(get_kb(&store, &owner, &kb).expect_err("gone")),
        ErrorCode::NotFound
    );
    assert!(
        store
            .bases_list(&owner, input::<BasesList>(json!({})))
            .expect("list")
            .items
            .is_empty()
    );
    assert_eq!(
        code(
            get_doc(
                &store,
                &owner,
                json!({"kbId": kb.as_str(), "path": "notes/a.md", "rev": head.as_str()})
            )
            .expect_err("gone")
        ),
        ErrorCode::NotFound
    );
    // Disk and history retained.
    let repo = store.paths().repo_dir(&kb);
    assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), head.as_str());
    assert_eq!(git(&repo, &["rev-list", "--count", "refs/heads/main"]), "2");
    assert_eq!(
        state_value(&root, "SELECT state FROM kbs WHERE id = ?1", &kb),
        "TOMBSTONED"
    );
    assert_eq!(
        state_value(&root, "SELECT slug FROM kbs WHERE id = ?1", &kb),
        "alpha"
    );
    // Registered work was cancelled.
    let conn = rusqlite::Connection::open(root.join("state.sqlite")).expect("state");
    let state: String = conn
        .query_row(
            "SELECT state FROM index_generations WHERE id = ?1",
            [generation.as_str()],
            |row| row.get(0),
        )
        .expect("generation row");
    assert_eq!(state, "SUPERSEDED");
    // Reopen (recovery runs) keeps the tombstone; the slug is reusable.
    drop(store);
    let store = Store::open(&root).expect("reopen");
    assert_eq!(
        code(get_kb(&store, &owner, &kb).expect_err("still gone")),
        ErrorCode::NotFound
    );
    let again = create(&store, &owner, "alpha", "create-key-tomb-0002");
    assert_ne!(kb_of(&again), kb);
}

// ── Quotas and limits ───────────────────────────────────────────────────────

#[test]
fn live_kb_quota_and_creation_rate_boundaries() {
    let root = temp_root("quota");
    let store = Store::open(&root).expect("open");
    // The local default is far above 20/hour; a lowered window keeps
    // the boundary observable inside the live-KB quota.
    let rate = 5;
    store.set_limits(LocalLimits::lowered(OWNED_LIVE_KBS_PER_USER, rate).expect("lower"));
    let owner = store.owner();
    let mut kbs = Vec::new();
    for i in 0..OWNED_LIVE_KBS_PER_USER {
        if i > 0 && i % rate == 0 {
            // The hourly creation budget is exhausted exactly here.
            let err = store
                .bases_create(
                    &owner,
                    input::<BasesCreate>(json!({
                        "name": "x", "slug": format!("rate-{i}"),
                        "description": "A local knowledge base for lifecycle tests",
                        "idempotencyKey": format!("create-key-rate-{i:04}"),
                    })),
                )
                .expect_err("rate limited");
            assert_eq!(code(err), ErrorCode::RateLimited, "at {i}");
            age_creation_window(&root);
        }
        kbs.push(kb_of(&create(
            &store,
            &owner,
            &format!("kb-{i}"),
            &format!("create-key-quota-{i:04}"),
        )));
    }
    age_creation_window(&root);
    let over = || {
        store.bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "over",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-quota-over",
            })),
        )
    };
    let err = over().expect_err("quota");
    assert_eq!(code(err), ErrorCode::QuotaExceeded);
    // Nothing was reserved for the rejected create.
    let repos = std::fs::read_dir(root.join("repos"))
        .expect("repos")
        .count();
    assert_eq!(repos, OWNED_LIVE_KBS_PER_USER as usize);
    // A tombstone frees one live slot.
    store
        .bases_delete(
            &owner,
            input::<BasesDelete>(json!({
                "kbId": kbs[0].as_str(), "metadataVersion": 1,
                "idempotencyKey": "delete-key-quota-01", "confirm": "DELETE",
            })),
        )
        .expect("tombstone");
    over().expect("room after tombstone");
    // Page bounds: default 20, max 50.
    let page = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(page.items.len(), PAGE_DEFAULT as usize);
    assert!(page.next_cursor.is_none(), "exactly 20 live kbs");
    assert!(decode_input::<BasesList>(json!({ "limit": PAGE_MAX + 1 })).is_err());
}

#[test]
fn local_limits_only_lower_and_match_the_shared_constants() {
    let common = LocalLimits::default();
    assert_eq!(common.live_kbs(), OWNED_LIVE_KBS_PER_USER);
    // The local store's own (higher, bounded) creation window.
    assert_eq!(
        common.creates_per_hour(),
        kb_local::limits::LOCAL_CREATES_PER_HOUR
    );
    const { assert!(kb_local::limits::LOCAL_CREATES_PER_HOUR > CREATES_PER_HOUR_PER_USER) };
    assert!(LocalLimits::lowered(OWNED_LIVE_KBS_PER_USER + 1, 1).is_err());
    assert!(LocalLimits::lowered(1, kb_local::limits::LOCAL_CREATES_PER_HOUR + 1).is_err());
    assert!(LocalLimits::lowered(0, 1).is_err());
    let lowered = LocalLimits::lowered(2, 5).expect("lower");
    let root = temp_root("limits");
    let store = Store::open(&root).expect("open");
    store.set_limits(lowered);
    let owner = store.owner();
    create(&store, &owner, "one", "create-key-limit-01");
    create(&store, &owner, "two", "create-key-limit-02");
    let err = store
        .bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "three",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-limit-03",
            })),
        )
        .expect_err("lowered quota");
    assert_eq!(code(err), ErrorCode::QuotaExceeded);
    // Constants are the shared server values (drift check against TS).
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let limits =
        std::fs::read_to_string(repo.join("packages/api/src/lib/kb/limits.ts")).expect("limits.ts");
    assert!(limits.contains(&format!("ownedLiveKbsPerUser: {OWNED_LIVE_KBS_PER_USER},")));
    assert!(limits.contains(&format!(
        "createsPerHourPerUser: {CREATES_PER_HOUR_PER_USER},"
    )));
    let ts_number = |n: u64| {
        let digits = n.to_string();
        let mut grouped = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                grouped.push('_');
            }
            grouped.push(c);
        }
        grouped
    };
    // TS numeric literals may or may not use `_` digit separators.
    let declares = |source: &str, name: &str, value: u64| {
        source.contains(&format!("{name}: {value},"))
            || source.contains(&format!("{name}: {},", ts_number(value)))
    };
    assert!(declares(
        &limits,
        "indexChunksDefault",
        kb_local::limits::INDEX_CHUNKS_DEFAULT
    ));
    let bounds = &limits[limits.find("indexChunkBound: {").expect("indexChunkBound")..];
    let bounds = &bounds[..bounds.find('}').expect("object end")];
    for (name, value) in [
        ("int8", kb_local::limits::INDEX_CHUNK_BOUND_INT8),
        (
            "binary_int8_rescore",
            kb_local::limits::INDEX_CHUNK_BOUND_BINARY_INT8_RESCORE,
        ),
    ] {
        assert!(
            declares(bounds, name, value),
            "KB_LIMITS.indexChunkBound.{name}"
        );
    }
    assert_eq!(
        kb_local::limits::LocalLimits::default().index_chunks(),
        kb_local::limits::INDEX_CHUNKS_DEFAULT
            .min(kb_local::limits::INDEX_CHUNK_BOUND_BINARY_INT8_RESCORE)
    );
    for (name, value) in [
        (
            "minCandidates",
            kb_local::limits::INDEX_RESCORE_MIN_CANDIDATES,
        ),
        (
            "maxCandidates",
            kb_local::limits::INDEX_RESCORE_MAX_CANDIDATES,
        ),
        (
            "chunksPerCandidate",
            kb_local::limits::INDEX_RESCORE_CHUNKS_PER_CANDIDATE,
        ),
    ] {
        let rescore = &limits[limits
            .find("KB_INDEX_RESCORE = {")
            .expect("KB_INDEX_RESCORE")..];
        let rescore = &rescore[..rescore.find('}').expect("object end")];
        assert!(declares(rescore, name, value), "KB_INDEX_RESCORE.{name}");
    }
    let common_ts =
        std::fs::read_to_string(repo.join("packages/api/src/lib/kb/protocol/common.ts"))
            .expect("common.ts");
    assert!(common_ts.contains(&format!("KB_PAGE_DEFAULT = {PAGE_DEFAULT};")));
    assert!(common_ts.contains(&format!("KB_PAGE_MAX = {PAGE_MAX};")));
    let cursor_ts =
        std::fs::read_to_string(repo.join("packages/api/src/lib/kb/cursor.ts")).expect("cursor.ts");
    assert_eq!(CURSOR_TTL_SECS, 15 * 60);
    assert!(cursor_ts.contains("CURSOR_TTL_MS = 15 * 60 * 1000;"));
}

// ── Documents ───────────────────────────────────────────────────────────────

const CITED: &str = "---\nid: guide-1\ntitle: Guide\ncitations:\n  - label: Source\n    target: https://example.invalid/a\nextra:\n  depth: 2\n---\n# Guide v1\n\nBody.\n";

#[test]
fn historic_get_after_newer_head_returns_old_bytes() {
    let root = temp_root("historic");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-docs-0001");
    let kb = kb_of(&created);
    let v1 = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-docs-0001",
        &[("docs/guide.md", CITED)],
    );
    let v2 = commit(
        &store,
        &kb,
        &v1,
        "commit-key-docs-0002",
        &[("docs/guide.md", "# Guide v2\n")],
    );
    let repo = store.paths().repo_dir(&kb);
    let old = get_doc(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md", "rev": v1.as_str()}),
    )
    .expect("historic get");
    assert_eq!(old["markdown"], CITED);
    assert_eq!(old["commitSha"], v1.as_str());
    assert_eq!(
        old["blobSha"],
        git(&repo, &["rev-parse", &format!("{v1}:docs/guide.md")]).as_str()
    );
    assert_eq!(old["contentHash"], content_hash(CITED.as_bytes()).as_str());
    assert_eq!(old["documentId"], "guide-1");
    assert_eq!(
        old["documentCitations"],
        json!([{"label": "Source", "target": "https://example.invalid/a"}])
    );
    assert_eq!(
        old["frontMatter"],
        json!({
            "id": "guide-1",
            "title": "Guide",
            "citations": [{"label": "Source", "target": "https://example.invalid/a"}],
            "extra": {"depth": 2},
        })
    );
    assert_eq!(old["assetRefs"], json!([]));
    // Default rev is the current head.
    let new = get_doc(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md"}),
    )
    .expect("head get");
    assert_eq!(new["markdown"], "# Guide v2\n");
    assert_eq!(new["commitSha"], v2.as_str());
    assert_eq!(new["documentId"], Value::Null);
    assert_eq!(new["frontMatter"], json!({}));
    // Missing path at a readable revision.
    let err = get_doc(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md", "rev": head_of(&created).as_str()}),
    )
    .expect_err("absent then");
    // A readable KB says it is the path that is missing.
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "PATH_NOT_FOUND", "field": "/path"})
    );
    assert_eq!(code(err), ErrorCode::NotFound);
    // A read-only principal may read; an unreadable one sees NOT_FOUND.
    let read_only = reader(&store, &kb, &[Permission::Read]);
    get_doc(
        &store,
        &read_only,
        json!({"kbId": kb.as_str(), "path": "docs/guide.md", "rev": v1.as_str()}),
    )
    .expect("reader");
    let nobody = reader(&store, &kb, &[]);
    let hidden = get_doc(
        &store,
        &nobody,
        json!({"kbId": kb.as_str(), "path": "docs/missing.md"}),
    )
    .expect_err("hidden");
    // No path reason for a KB the principal cannot read.
    assert_eq!(hidden.protocol_details(), json!({}));
    assert_eq!(code(hidden), ErrorCode::NotFound);
}

#[test]
fn foreign_and_unreachable_revisions_are_denied() {
    let root = temp_root("foreign");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let a = create(&store, &owner, "alpha", "create-key-foreign-01");
    let b = create(&store, &owner, "beta", "create-key-foreign-02");
    let kb_a = kb_of(&a);
    let kb_b = kb_of(&b);
    let b_head = commit(
        &store,
        &kb_b,
        &head_of(&b),
        "commit-key-foreign-01",
        &[("secret.md", "# Secret\n")],
    );
    // A dangling commit object inside KB A's own repository.
    let repo_a = store.paths().repo_dir(&kb_a);
    let tree = git(&repo_a, &["rev-parse", "refs/heads/main^{tree}"]);
    let dangling = git(
        &repo_a,
        &[
            "commit-tree",
            &tree,
            "-p",
            "refs/heads/main",
            "-m",
            "dangling",
        ],
    );
    for rev in [b_head.as_str(), dangling.as_str(), &"a".repeat(40)] {
        let err = get_doc(
            &store,
            &owner,
            json!({"kbId": kb_a.as_str(), "path": "index.md", "rev": rev}),
        )
        .expect_err("unreadable revision");
        assert_eq!(code(err), ErrorCode::NotFound, "{rev}");
        let err = list_docs(&store, &owner, json!({"kbId": kb_a.as_str(), "rev": rev}))
            .expect_err("unreadable revision");
        assert_eq!(code(err), ErrorCode::NotFound, "{rev}");
    }
    // The blob of another KB is never readable through this one.
    let err = get_doc(
        &store,
        &owner,
        json!({"kbId": kb_a.as_str(), "path": "secret.md"}),
    )
    .expect_err("foreign path");
    assert_eq!(code(err), ErrorCode::NotFound);
    // An external edit of main is REPAIR_REQUIRED, never adopted.
    git(&repo_a, &["update-ref", "refs/heads/main", &dangling]);
    let err = get_doc(
        &store,
        &owner,
        json!({"kbId": kb_a.as_str(), "path": "index.md"}),
    )
    .expect_err("repair");
    assert_eq!(code(err), ErrorCode::RepairRequired);
}

#[test]
fn documents_list_pagination_is_complete_bounded_and_pinned() {
    let root = temp_root("paging");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-page-0001");
    let kb = kb_of(&created);
    let files: Vec<(String, String)> = (0..7)
        .map(|i| {
            (
                format!("docs/d{i}.md"),
                format!("---\nid: doc-{i}\n---\n# Doc {i}\n"),
            )
        })
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(p, b)| (p.as_str(), b.as_str()))
        .collect();
    let pinned = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-page-0001",
        &refs,
    );
    let repo = store.paths().repo_dir(&kb);
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        let mut args = json!({"kbId": kb.as_str(), "limit": 3});
        if let Some(c) = &cursor {
            args["cursor"] = json!(c);
        }
        let page = list_docs(&store, &owner, args).expect("page");
        pages += 1;
        let items = page["items"].as_array().expect("items");
        assert!(items.len() <= 3);
        for item in items {
            assert_eq!(item["commitSha"], pinned.as_str());
            let path = item["path"].as_str().expect("path").to_owned();
            assert_eq!(
                item["blobSha"],
                git(&repo, &["rev-parse", &format!("{pinned}:{path}")]).as_str()
            );
            let size: u64 = git(&repo, &["cat-file", "-s", &format!("{pinned}:{path}")])
                .parse()
                .expect("size");
            assert_eq!(item["size"], size);
            seen.push((path, item["documentId"].clone()));
        }
        if pages == 1 {
            // HEAD moves between pages; the cursor stays on its revision.
            commit(
                &store,
                &kb,
                &pinned,
                "commit-key-page-0002",
                &[("docs/zz-new.md", "# New\n")],
            );
        }
        match page["nextCursor"].as_str() {
            Some(next) => {
                assert!(next.len() <= 1024);
                cursor = Some(next.to_owned());
            }
            None => break,
        }
        assert!(pages < 10, "pagination terminates");
    }
    assert_eq!(pages, 3);
    let mut expected: Vec<String> = files.iter().map(|(p, _)| p.clone()).collect();
    expected.push("index.md".into());
    expected.sort();
    let paths: Vec<String> = seen.iter().map(|(p, _)| p.clone()).collect();
    assert_eq!(paths, expected, "complete, ordered, no duplicates");
    assert_eq!(seen[0].1, json!("doc-0"));
    assert_eq!(seen[7].1, Value::Null, "index.md has no id");
    // A fresh listing sees the new head; prefix filters by raw path prefix.
    let fresh = list_docs(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "prefix": "docs/zz"}),
    )
    .expect("prefix");
    assert_eq!(fresh["items"].as_array().expect("items").len(), 1);
    assert_eq!(fresh["items"][0]["path"], "docs/zz-new.md");
    assert_eq!(fresh["nextCursor"], Value::Null);
    // L-22: a trailing slash is accepted and keeps the raw-prefix meaning
    // (one directory); without it the prefix also matches `docs-*` names.
    let dir = list_docs(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "prefix": "docs/"}),
    )
    .expect("trailing slash");
    let raw = list_docs(
        &store,
        &owner,
        json!({"kbId": kb.as_str(), "prefix": "docs"}),
    )
    .expect("raw prefix");
    assert!(!dir["items"].as_array().expect("items").is_empty());
    assert!(
        dir["items"]
            .as_array()
            .expect("items")
            .iter()
            .all(|i| i["path"].as_str().expect("path").starts_with("docs/"))
    );
    assert!(
        raw["items"].as_array().expect("items").len()
            >= dir["items"].as_array().expect("items").len()
    );
    for bad in ["docs//", "/", "docs/../x/"] {
        assert!(
            decode_input::<DocumentsList>(json!({"kbId": kb.as_str(), "prefix": bad})).is_err(),
            "{bad}"
        );
    }
    let all = list_docs(&store, &owner, json!({"kbId": kb.as_str()})).expect("default");
    assert_eq!(all["items"].as_array().expect("items").len(), 9);
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

#[test]
fn cursor_tamper_principal_scope_and_expiry_are_rejected() {
    let root = temp_root("cursor");
    let store = Store::open(&root).expect("open");
    // Cursor issuance and validation share an absolute clock, independent of
    // wall time spent in Git, principal changes or reopening the real store.
    let issued_at = 1_800_000_000;
    store.set_cursor_clock_for_tests(issued_at);
    let owner = store.owner();
    let a = create(&store, &owner, "alpha", "create-key-cursor-01");
    let b = create(&store, &owner, "beta", "create-key-cursor-02");
    let kb_a = kb_of(&a);
    let kb_b = kb_of(&b);
    commit(
        &store,
        &kb_a,
        &head_of(&a),
        "commit-key-cursor-01",
        &[("a.md", "# A\n"), ("b.md", "# B\n"), ("c.md", "# C\n")],
    );
    let first =
        list_docs(&store, &owner, json!({"kbId": kb_a.as_str(), "limit": 1})).expect("first page");
    let cursor = first["nextCursor"].as_str().expect("cursor").to_owned();
    next(&store, &owner, &kb_a, &cursor, json!({})).expect("valid cursor");
    // Tampering with any byte of the body or MAC.
    let mut bytes = cursor.clone().into_bytes();
    for index in [0, bytes.len() / 2, bytes.len() - 1] {
        let original = bytes[index];
        bytes[index] = if original == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes.clone()).expect("ascii");
        let err = next(&store, &owner, &kb_a, &tampered, json!({})).expect_err("tampered");
        assert_eq!(code(err), ErrorCode::InvalidCursor, "byte {index}");
        bytes[index] = original;
    }
    assert_eq!(
        code(next(&store, &owner, &kb_a, "garbage", json!({})).expect_err("garbage")),
        ErrorCode::InvalidCursor
    );
    // Bound to principal, KB, filter and revision.
    let other = reader(&store, &kb_a, &[Permission::Read]);
    assert_eq!(
        code(next(&store, &other, &kb_a, &cursor, json!({})).expect_err("principal")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(next(&store, &owner, &kb_b, &cursor, json!({})).expect_err("kb")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(next(&store, &owner, &kb_a, &cursor, json!({"prefix": "a"})).expect_err("filter")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(
            next(
                &store,
                &owner,
                &kb_a,
                &cursor,
                json!({"rev": head_of(&a).as_str()})
            )
            .expect_err("revision")
        ),
        ErrorCode::InvalidCursor
    );
    // A KB-list cursor is not a document cursor.
    let kbs_page = store
        .bases_list(&owner, input::<BasesList>(json!({"limit": 1})))
        .expect("kb page");
    let kb_cursor = kbs_page.next_cursor.expect("kb cursor");
    assert_eq!(
        code(next(&store, &owner, &kb_a, &kb_cursor, json!({})).expect_err("kind")),
        ErrorCode::InvalidCursor
    );
    let rest = store
        .bases_list(
            &owner,
            input::<BasesList>(json!({"limit": 1, "cursor": kb_cursor})),
        )
        .expect("kb page 2");
    assert_eq!(rest.items.len(), 1);
    assert!(rest.next_cursor.is_none());
    assert_ne!(rest.items[0].id, kbs_page.items[0].id);
    // The key is durable (survives reopen) and store-specific.
    drop(store);
    let store = Store::open(&root).expect("reopen");
    store.set_cursor_clock_for_tests(issued_at);
    next(&store, &owner, &kb_a, &cursor, json!({})).expect("cursor after reopen");
    let foreign_root = temp_root("cursor-foreign");
    let foreign = Store::open(&foreign_root).expect("other store");
    let fa = create(&foreign, &foreign.owner(), "alpha", "create-key-cursor-03");
    let err = foreign
        .documents_list(
            &foreign.owner(),
            input::<DocumentsList>(
                json!({"kbId": kb_of(&fa).as_str(), "limit": 1, "cursor": cursor}),
            ),
        )
        .expect_err("foreign store key");
    assert_eq!(code(err), ErrorCode::InvalidCursor);
    // Revocation is checked independently of a valid cursor.
    let guard = store.lock_write(&[]).expect("lock");
    let narrowed = store
        .register_principal(&guard, PrincipalKind::Test, &kb_a, &[Permission::Read])
        .expect("principal");
    drop(guard);
    let theirs = list_docs(
        &store,
        &narrowed,
        json!({"kbId": kb_a.as_str(), "limit": 1}),
    )
    .expect("page")["nextCursor"]
        .as_str()
        .expect("cursor")
        .to_owned();
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &narrowed, &kb_a, &[])
        .expect("revoke");
    drop(guard);
    assert_eq!(
        code(next(&store, &narrowed, &kb_a, &theirs, json!({})).expect_err("revoked")),
        ErrorCode::NotFound
    );
    // Expiry: exactly 15 minutes is valid, one second later is expired,
    // independent of time spent in the filesystem checks. The clock is still
    // frozen at `issued_at`, so this fresh cursor, the earlier document cursor
    // and the KB-list cursor share one issue instant, clock and signing key.
    let expiry_cursor = list_docs(&store, &owner, json!({"kbId": kb_a.as_str(), "limit": 1}))
        .expect("expiry page")["nextCursor"]
        .as_str()
        .expect("expiry cursor")
        .to_owned();
    store.set_cursor_clock_for_tests(issued_at + CURSOR_TTL_SECS - 1);
    next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect("one second before expiry");
    store.advance_clock_for_tests(1);
    next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect("last valid instant");
    next(&store, &owner, &kb_a, &cursor, json!({})).expect("still valid");
    store
        .bases_list(
            &owner,
            input::<BasesList>(json!({"limit": 1, "cursor": kb_cursor})),
        )
        .expect("kb cursor still valid");
    store.advance_clock_for_tests(1);
    assert_eq!(
        code(next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect_err("expired")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(next(&store, &owner, &kb_a, &expiry_cursor, json!({})).expect_err("expired")),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(
            store
                .bases_list(
                    &owner,
                    input::<BasesList>(json!({"limit": 1, "cursor": kb_cursor})),
                )
                .expect_err("kb cursor expired")
        ),
        ErrorCode::InvalidCursor
    );
}

fn check_document_return_authority(list: bool) {
    let root = temp_root("return-revoke");
    let store = Store::open(&root).expect("test fixture");
    let created = create(&store, &store.owner(), "private", "private-create-00001");
    let kb = kb_of(&created);
    let who = reader(&store, &kb, &[Permission::Read]);
    let other = Store::open(&root).expect("test fixture");
    let mut assembled = false;
    let mut revoke = || {
        assembled = true;
        let guard = other.lock_write(&[])?;
        other.set_principal_permissions(&guard, &who, &kb, &[])?;
        assert!(matches!(
            other.authorize(&who, &kb, Permission::Read),
            Err(StoreError::NotFound)
        ));
        Ok(())
    };
    if list {
        let result = store.documents_list_observed(
            &who,
            input::<DocumentsList>(json!({"kbId": kb, "limit": 1})),
            &mut revoke,
        );
        assert!(matches!(result, Err(StoreError::NotFound)));
    } else {
        let result = store.documents_get_observed(
            &who,
            input::<DocumentsGet>(json!({"kbId": kb, "path": "index.md"})),
            &mut revoke,
        );
        let error = result.expect_err("revoked");
        assert!(matches!(error, StoreError::NotFound), "{error:?}");
        assert_eq!(error.protocol_details(), json!({}));
    }
    assert!(
        assembled,
        "actual Git/SQLite/content assembly must finish before revoke"
    );
    // Inverse: renewed legitimate authority can read the same immutable bytes.
    let guard = other.lock_write(&[]).expect("test fixture");
    other
        .set_principal_permissions(&guard, &who, &kb, &[Permission::Read])
        .expect("test fixture");
    drop(guard);
    let document = store
        .documents_get(
            &who,
            input::<DocumentsGet>(json!({"kbId": kb, "path": "index.md"})),
        )
        .expect("test fixture");
    assert_eq!(
        document.markdown,
        "# Knowledge base\n\nA local knowledge base for lifecycle tests\n"
    );
    let page = store
        .documents_list(
            &who,
            input::<DocumentsList>(json!({"kbId": kb, "limit": 1})),
        )
        .expect("test fixture");
    assert_eq!(page.items.len(), 1);
}

#[test]
fn document_get_return_checks_live_authority_after_real_assembly() {
    check_document_return_authority(false);
}
#[test]
fn document_list_return_checks_live_authority_after_real_assembly() {
    check_document_return_authority(true);
}

#[test]
fn revoked_kbs_do_not_consume_page_slots_or_reappear_through_cursor() {
    let root = temp_root("return-pagination");
    let store = Store::open(&root).unwrap();
    let guard = store.lock_write(&[]).unwrap();
    let who = store
        .register_creator(
            &guard,
            PrincipalKind::Config,
            &[Permission::Read, Permission::Manage],
        )
        .unwrap();
    drop(guard);
    let mut kbs = Vec::new();
    for (slug, key) in [
        ("a", "page-create-000001"),
        ("b", "page-create-000002"),
        ("c", "page-create-000003"),
    ] {
        kbs.push(kb_of(&create(&store, &who, slug, key)));
    }
    kbs.sort();
    let first = store
        .bases_list(&who, input::<BasesList>(json!({"limit": 1})))
        .unwrap();
    assert_eq!(first.items[0].id, kbs[0]);
    let guard = store.lock_write(&[]).unwrap();
    store
        .set_principal_permissions(&guard, &who, &kbs[1], &[])
        .unwrap();
    drop(guard);
    let rest = store
        .bases_list(
            &who,
            input::<BasesList>(json!({"limit": 1, "cursor": first.next_cursor})),
        )
        .unwrap();
    assert_eq!(rest.items.len(), 1);
    assert_eq!(rest.items[0].id, kbs[2]);
    assert!(rest.next_cursor.is_none());
    let all = store
        .bases_list(&who, input::<BasesList>(json!({"limit": 2})))
        .unwrap();
    assert_eq!(
        all.items
            .iter()
            .map(|row| row.id.clone())
            .collect::<Vec<_>>(),
        vec![kbs[0].clone(), kbs[2].clone()]
    );
    assert!(all.next_cursor.is_none());
    assert!(matches!(
        store.bases_get(&who, input::<BasesGet>(json!({"kbId": kbs[1]}))),
        Err(StoreError::NotFound)
    ));
}

// R52c: service-boundary admission regressions. Inspect the durable store before
// another call can recover CREATING rows or hide tombstones from live lists.
fn admission_snapshot(root: &Path) -> (i64, i64, usize, i64) {
    let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("inspect state");
    let count = |sql| {
        db.query_row(sql, [], |r| r.get::<_, i64>(0))
            .expect("count")
    };
    (
        count("SELECT count(*) FROM kbs"),
        count("SELECT count(*) FROM operation_intents"),
        std::fs::read_dir(root.join("repos"))
            .expect("repos")
            .count(),
        count("SELECT coalesce(sum(json_array_length(times_json)),0) FROM mutation_windows"),
    )
}

fn raw_create(slug: &str) -> kb_local::CreateKbRequest {
    kb_local::CreateKbRequest {
        name: "Admission notes".into(),
        slug: slug.into(),
        description: "A valid description for admission tests".into(),
        idempotency_key: format!("r52c-create-{slug}-0000"),
    }
}

#[test]
fn r52c_raw_create_replay_admission_matrix() {
    let root = temp_root("r52c-create-replay");
    let store = Store::open(&root).expect("open");
    let guard = store.lock_write(&[]).expect("lock");
    let creator = store
        .register_creator(&guard, PrincipalKind::Config, &[Permission::Read])
        .expect("creator");
    drop(guard);
    let request = raw_create("replay");
    let receipt = store.create_kb(&creator, request.clone()).expect("create");
    let before = admission_snapshot(&root);
    assert_eq!(
        store
            .create_kb(&creator, request.clone())
            .expect("readable replay"),
        receipt
    );
    let mut changed = request.clone();
    changed.name = "bad\u{7}name".into();
    assert_eq!(
        code(
            store
                .create_kb(&creator, changed)
                .expect_err("changed invalid name")
        ),
        ErrorCode::IdempotencyMismatch
    );
    // Independently exhaust live quota and hourly rate, while preserving replay.
    store.set_limits(LocalLimits::lowered(1, 5).expect("quota"));
    assert_eq!(
        store
            .create_kb(&creator, request.clone())
            .expect("replay at live quota"),
        receipt
    );
    store.set_limits(LocalLimits::lowered(20, 1).expect("hourly"));
    assert_eq!(
        store
            .create_kb(&creator, request.clone())
            .expect("replay at hourly limit"),
        receipt
    );
    assert_eq!(admission_snapshot(&root), before);
    let guard = store.lock_write(&[]).expect("lock");
    store
        .revoke_create_capability(&guard, &creator)
        .expect("revoke create only");
    drop(guard);
    store
        .authorize(&creator, &receipt.kb_id, Permission::Read)
        .expect("read still allowed");
    assert_eq!(
        code(
            store
                .create_kb(&creator, request)
                .expect_err("revoked creator replay")
        ),
        ErrorCode::Forbidden
    );
    assert_eq!(admission_snapshot(&root), before);
}

#[test]
fn r52c_raw_create_read_revocation_is_independent_of_create() {
    let root = temp_root("r52c-read-revoke");
    let store = Store::open(&root).expect("open");
    let guard = store.lock_write(&[]).expect("lock");
    let creator = store
        .register_creator(&guard, PrincipalKind::Test, &[Permission::Read])
        .expect("creator");
    drop(guard);
    let request = raw_create("read-revoke");
    let receipt = store.create_kb(&creator, request.clone()).expect("create");
    assert_eq!(
        store
            .create_kb(&creator, request.clone())
            .expect("readable replay"),
        receipt
    );
    let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("db");
    assert_eq!(
        db.execute(
            "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1 AND kb_id=?2",
            (creator.id(), receipt.kb_id.as_str())
        )
        .expect("revoke read only"),
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM create_capabilities WHERE principal_id=?1",
            [creator.id()],
            |r| r.get::<_, i64>(0)
        )
        .expect("create retained"),
        1
    );
    let before = admission_snapshot(&root);
    assert_eq!(
        code(
            store
                .create_kb(&creator, request)
                .expect_err("raw replay read revoked")
        ),
        ErrorCode::NotFound
    );
    assert_eq!(admission_snapshot(&root), before);
    // The retained create capability still works for another KB.
    store
        .create_kb(&creator, raw_create("read-retained"))
        .expect("create still allowed");
}

#[test]
fn r52c_invalid_generated_source_reserves_nothing_and_preserves_hourly_budget() {
    let root = temp_root("r52c-invalid-source");
    let store = Store::open(&root).expect("open");
    let before = admission_snapshot(&root);
    // A tab is forbidden in names but allowed in Markdown, so moving only the
    // name validator after reservation cannot be concealed by source preflight.
    let mut request = raw_create("bad-name");
    request.name = "bad\tname".into();
    assert_eq!(
        code(
            store
                .create_kb(&store.owner(), request)
                .expect_err("invalid name")
        ),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        admission_snapshot(&root),
        before,
        "ALL registry/intent/repo/charge rows unchanged"
    );
    for n in 0..CREATES_PER_HOUR_PER_USER {
        let mut request = raw_create(&format!("bad-description-{n}"));
        request.description = "valid length but bad\u{7}description".into();
        assert_eq!(
            code(
                store
                    .create_kb(&store.owner(), request)
                    .expect_err("invalid description")
            ),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            admission_snapshot(&root),
            before,
            "invalid description cannot spend create allowance"
        );
    }
    let mut request = raw_create("valid-controls");
    request.description = "valid\tMarkdown\r\nwith permitted controls".into();
    store
        .create_kb(&store.owner(), request)
        .expect("hourly allowance preserved");
    assert_eq!(admission_snapshot(&root), (1, 1, 1, 0));
}

#[test]
fn r52c_create_publication_rechecks_persisted_grant() {
    for revoke in [false, true] {
        let root = temp_root("r52c-grant-gap");
        let store = Store::open(&root).expect("open");
        let guard = store.lock_write(&[]).expect("lock");
        let creator = store
            .register_creator(&guard, PrincipalKind::Config, &[Permission::Read])
            .expect("creator");
        drop(guard);
        let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("db");
        let mut prepared = false;
        let error = store.create_kb_observed(&creator, raw_create("grant-gap"), &mut |stage| {
            if stage == Stage::Prepared {
                prepared = true;
                let changed = if revoke {
                    db.execute("DELETE FROM create_capabilities WHERE principal_id=?1", [creator.id()])
                } else {
                    db.execute("UPDATE create_capabilities SET created_kb_bits=3 WHERE principal_id=?1", [creator.id()])
                }.expect("change actual approved grant in publication gap");
                assert_eq!(changed, 1);
            }
            Ok(())
        }).expect_err("grant changed before publication");
        assert!(prepared);
        assert_eq!(code(error), ErrorCode::Forbidden);
        let (id, state, head): (String, String, Option<String>) = db
            .query_row("SELECT id,state,head_sha FROM kbs", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .expect("failed reservation retained");
        assert_eq!(state, "TOMBSTONED");
        assert!(head.is_none());
        assert!(
            !root
                .join("repos")
                .join(format!("kb_{id}.git/refs/heads/main"))
                .exists()
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM principal_ceilings", [], |r| r
                .get::<_, i64>(0))
                .expect("ceilings"),
            0
        );
        assert_eq!(
            db.query_row("SELECT phase FROM operation_intents", [], |r| r
                .get::<_, String>(0))
                .expect("phase"),
            "ABORTED"
        );
    }
    let root = temp_root("r52c-grant-positive");
    let store = Store::open(&root).expect("open");
    let guard = store.lock_write(&[]).expect("lock");
    let creator = store
        .register_creator(&guard, PrincipalKind::Config, &[Permission::Read])
        .expect("creator");
    drop(guard);
    let mut prepared = false;
    let receipt = store
        .create_kb_observed(&creator, raw_create("grant-unchanged"), &mut |stage| {
            prepared |= stage == Stage::Prepared;
            Ok(())
        })
        .expect("unchanged grant succeeds");
    assert!(prepared);
    assert_eq!(
        store
            .authorize(&creator, &receipt.kb_id, Permission::Read)
            .expect("exact ceiling")
            .permissions(),
        vec![Permission::Read]
    );
}

#[test]
fn r52c_document_service_encoded_cap_exact_limit_and_overflow() {
    let root = temp_root("r52c-response");
    let store = Store::open(&root).expect("open");
    let created = create(
        &store,
        &store.owner(),
        "response",
        "r52c-response-create-0000",
    );
    let request = input::<DocumentsGet>(json!({"kbId":kb_of(&created),"path":"index.md"}));
    let document = store
        .documents_get(&store.owner(), request.clone())
        .expect("default cap");
    let exact = serde_json::to_vec(&document)
        .expect("actual encoding")
        .len();
    assert!(
        store
            .set_response_limit_for_tests(kb_local::limits::RESPONSE_MAX_BYTES + 1)
            .is_err()
    );
    store.set_response_limit_for_tests(exact).expect("lower");
    assert_eq!(
        wire::<DocumentsGet>(
            &store
                .documents_get(&store.owner(), request.clone())
                .expect("exact cap")
        ),
        wire::<DocumentsGet>(&document)
    );
    store
        .set_response_limit_for_tests(exact - 1)
        .expect("lower");
    let mut delivered = false;
    assert_eq!(
        code(
            store
                .documents_get_observed(&store.owner(), request, &mut || {
                    delivered = true;
                    Ok(())
                })
                .expect_err("actual encoded document exceeds cap")
        ),
        ErrorCode::InvalidArgument
    );
    assert!(!delivered, "overflow fails before delivery");
}

/// The local per-actor, per-KB write window.
const MUTATIONS: usize = kb_local::limits::LOCAL_MUTATIONS_PER_MINUTE_PER_KB;
const MUTATIONS_I64: i64 = MUTATIONS as i64;
fn seed_mutation_window(root: &Path, actor: &str, kb: &KbId, count: usize, now: u64) {
    let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("db");
    db.execute("INSERT INTO mutation_windows(actor_key,kb_id,times_json) VALUES (?1,?2,?3) ON CONFLICT(actor_key,kb_id) DO UPDATE SET times_json=excluded.times_json",
        (actor, kb.as_str(), serde_json::to_string(&vec![now;count]).expect("encode"))).expect("seed actual durable window");
}

#[test]
fn r52c_metadata_budget_replay_rollback_delete_and_reentry() {
    let root = temp_root("r52c-metadata-budget");
    let store = Store::open(&root).expect("open");
    store.set_cursor_clock_for_tests(2_000_000_000);
    let owner = store.owner();
    let kb = kb_of(&create(&store, &owner, "budget", "r52c-budget-create-0000"));
    seed_mutation_window(
        &root,
        &owner.actor_key(),
        &kb,
        MUTATIONS - 1,
        2_000_000_000_000,
    );
    // Force an actual SQLite failure after charging but before receipt commit:
    // the charge, version change and intent must roll back together.
    let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("db");
    db.execute_batch("CREATE TRIGGER r52c_reject_name BEFORE UPDATE OF name ON kbs WHEN NEW.name='Rejected by trigger' BEGIN SELECT RAISE(ABORT,'injected update failure'); END;")
        .expect("private fault trigger");
    let before_failure = admission_snapshot(&root);
    store
        .bases_update(
            &owner,
            input::<BasesUpdate>(json!({"kbId":kb,"metadataVersion":1,
        "idempotencyKey":"r52c-update-rollback-0000","name":"Rejected by trigger"})),
        )
        .expect_err("actual registry write fails after budget charge");
    assert_eq!(admission_snapshot(&root), before_failure);
    let update = input::<BasesUpdate>(
        json!({"kbId":kb,"metadataVersion":1,"idempotencyKey":"r52c-update-budget-0000","name":"Changed"}),
    );
    let receipt = store
        .bases_update(&owner, update.clone())
        .expect("last mutation in the window allowed");
    let full = admission_snapshot(&root);
    assert_eq!(full.3, MUTATIONS_I64);
    assert_eq!(
        store
            .bases_update(&owner, update.clone())
            .expect("replay full window")
            .operation_id,
        receipt.operation_id
    );
    let fresh = input::<BasesUpdate>(
        json!({"kbId":kb,"metadataVersion":2,"idempotencyKey":"r52c-update-blocked-0000","name":"Denied"}),
    );
    assert_eq!(
        code(
            store
                .bases_update(&owner, fresh.clone())
                .expect_err("one past the window denied")
        ),
        ErrorCode::RateLimited
    );
    let deletion = input::<BasesDelete>(
        json!({"kbId":kb,"metadataVersion":2,"idempotencyKey":"r52c-delete-budget-0000","confirm":"DELETE"}),
    );
    assert_eq!(
        code(
            store
                .bases_delete(&owner, deletion.clone())
                .expect_err("delete shares window")
        ),
        ErrorCode::RateLimited
    );
    assert_eq!(admission_snapshot(&root), full);
    assert_eq!(
        get_kb(&store, &owner, &kb).expect("unchanged")["kb"]["metadataVersion"],
        2
    );
    drop(store);
    let store = Store::open(&root).expect("reentry");
    store.set_cursor_clock_for_tests(2_000_000_000);
    assert_eq!(
        code(
            store
                .bases_update(&owner, fresh)
                .expect_err("durable full window")
        ),
        ErrorCode::RateLimited
    );
    store.advance_clock_for_tests(60);
    let deleted = store
        .bases_delete(&owner, deletion.clone())
        .expect("window expired exactly");
    assert_eq!(admission_snapshot(&root).3, 1);
    assert_eq!(
        store
            .bases_delete(&owner, deletion)
            .expect("tombstone replay")
            .operation_id,
        deleted.operation_id
    );
    assert_eq!(admission_snapshot(&root).3, 1);
}

#[test]
fn r52c_metadata_mismatch_precedes_fresh_domain_validation() {
    let root = temp_root("r52c-update-order");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let kb = kb_of(&create(
        &store,
        &owner,
        "update-order",
        "r52c-update-order-create",
    ));
    let request = input::<BasesUpdate>(
        json!({"kbId":kb,"metadataVersion":1,"idempotencyKey":"r52c-update-order-0000","name":"Valid"}),
    );
    let receipt = store.bases_update(&owner, request.clone()).expect("update");
    let before = admission_snapshot(&root);
    assert_eq!(
        store
            .bases_update(&owner, request.clone())
            .expect("same request")
            .operation_id,
        receipt.operation_id
    );
    for field in ["name", "description"] {
        // A changed but valid field on the committed key is a mismatch.
        let mut value = serde_json::to_value(&request).expect("encode");
        value[field] = json!("Changed valid metadata");
        assert_eq!(
            code(
                store
                    .bases_update(&owner, input::<BasesUpdate>(value.clone()))
                    .expect_err("changed valid metadata")
            ),
            ErrorCode::IdempotencyMismatch
        );
        // Control-bearing metadata now violates the shared kb/1 metadata
        // policy, so it is rejected structurally, with no receipt or charge.
        value[field] = json!("bad\u{7}metadata text");
        // Bypass the test helper's decoder so the store's own check_input runs.
        let raw = |value: &Value| -> <BasesUpdate as Tool>::Input {
            serde_json::from_value(value.clone()).expect("serde shape")
        };
        assert_eq!(
            code(
                store
                    .bases_update(&owner, raw(&value))
                    .expect_err("changed invalid metadata")
            ),
            ErrorCode::InvalidArgument
        );
        value["idempotencyKey"] = json!(format!("r52c-fresh-invalid-{field}"));
        value["metadataVersion"] = json!(2);
        assert_eq!(
            code(
                store
                    .bases_update(&owner, raw(&value))
                    .expect_err("fresh invalid")
            ),
            ErrorCode::InvalidArgument
        );
        assert_eq!(admission_snapshot(&root), before);
    }
    let manager = reader(&store, &kb, &[Permission::Read]);
    assert_eq!(
        code(
            store
                .bases_update(&manager, request)
                .expect_err("no live manage")
        ),
        ErrorCode::Forbidden
    );
}

#[test]
fn r52c_create_disk_floor_error_exact_admission_and_replay() {
    use kb_local::limits::{FREE_DISK_FLOOR_BYTES, WRITE_DISK_RESERVE_BYTES};
    fn below(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
        Ok(FREE_DISK_FLOOR_BYTES - 1)
    }
    fn floor(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
        Ok(FREE_DISK_FLOOR_BYTES)
    }
    fn failed(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
        Err(StoreError::StorageUnavailable(
            "injected disk measurement error".into(),
        ))
    }
    fn exact(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
        let req = raw_create("disk");
        Ok(FREE_DISK_FLOOR_BYTES
            + WRITE_DISK_RESERVE_BYTES
            + format!("# Knowledge base\n\n{}\n", req.description).len() as u64)
    }
    let root = temp_root("r52c-disk");
    let store = Store::open(&root).expect("open");
    let before = admission_snapshot(&root);
    for (meter, expected) in [
        (
            below as fn(&kb_local::StorePaths, &Path) -> Result<u64, StoreError>,
            ErrorCode::QuotaExceeded,
        ),
        (floor, ErrorCode::QuotaExceeded),
        (failed, ErrorCode::StorageUnavailable),
    ] {
        store.set_disk_meter_for_tests(meter);
        assert_eq!(
            code(
                store
                    .create_kb(&store.owner(), raw_create("disk"))
                    .expect_err("disk admission")
            ),
            expected
        );
        assert_eq!(
            admission_snapshot(&root),
            before,
            "disk denial precedes reservations"
        );
    }
    store.set_disk_meter_for_tests(exact);
    let receipt = store
        .create_kb(&store.owner(), raw_create("disk"))
        .expect("exact floor plus reservation");
    let upload = input::<kb_client::types::UploadBegin>(json!({"kbId":receipt.kb_id,
        "idempotencyKey":"r52c-disk-pending-0000","kind":"markdown","size":1,
        "contentHash":content_hash(b"x"),"mime":"text/markdown"}));
    store
        .upload_begin(&store.owner(), upload)
        .expect("promise one pending byte");
    let pending = admission_snapshot(&root);
    assert_eq!(
        code(
            store
                .create_kb(&store.owner(), raw_create("disk-pending"))
                .expect_err("promised pending upload cannot spend floor")
        ),
        ErrorCode::QuotaExceeded
    );
    assert_eq!(admission_snapshot(&root), pending);
    store.set_disk_meter_for_tests(failed);
    assert_eq!(
        store
            .create_kb(&store.owner(), raw_create("disk"))
            .expect("replay does not remeasure disk"),
        receipt
    );
    assert_eq!(admission_snapshot(&root), pending);
}

#[test]
fn r52c_document_and_raw_commit_share_admission_with_metadata() {
    use kb_client::types::{DocumentsCreate, DocumentsUpdate};
    let root = temp_root("r52c-shared-admission");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    store.set_cursor_clock_for_tests(2_000_000_000);
    let created = create(&store, &owner, "shared", "r52c-shared-create-0000");
    let kb = kb_of(&created);
    let base = head_of(&created);
    let request = input::<DocumentsCreate>(
        json!({"kbId":kb,"baseRevision":base,"idempotencyKey":"r52c-shared-document-0000","path":"new.md","content":{"markdown":"# New\n"}}),
    );
    seed_mutation_window(
        &root,
        &owner.actor_key(),
        &kb,
        MUTATIONS - 1,
        2_000_000_000_000,
    );
    let applied = store
        .documents_create(&owner, request.clone())
        .expect("document fills the window");
    let full = admission_snapshot(&root);
    assert_eq!(full.3, MUTATIONS_I64);
    assert_eq!(
        store
            .documents_create(&owner, request)
            .expect("document replay")
            .operation_id,
        applied.operation_id
    );
    let raw = CommitRequest {
        kb: kb.clone(),
        base_revision: applied.commit_sha.clone(),
        idempotency_key: "r52c-shared-raw-0000".into(),
        changes: vec![FileChange {
            path: "raw.md".into(),
            content: Some(b"# Raw\n".to_vec()),
        }],
    };
    assert_eq!(
        code(
            store
                .commit_files(&owner, raw.clone())
                .expect_err("raw shares ledger")
        ),
        ErrorCode::RateLimited
    );
    assert_eq!(admission_snapshot(&root), full);
    seed_mutation_window(
        &root,
        &owner.actor_key(),
        &kb,
        MUTATIONS - 1,
        2_000_000_000_000,
    );
    let raw_receipt = store
        .commit_files(&owner, raw.clone())
        .expect("raw 60th mutation");
    assert_eq!(
        store.commit_files(&owner, raw).expect("raw replay"),
        raw_receipt
    );
    assert_eq!(admission_snapshot(&root).3, MUTATIONS_I64);
    // A durable noop is also a fresh operation, but identical replay is free.
    let noop = input::<DocumentsUpdate>(
        json!({"kbId":kb,"baseRevision":raw_receipt.commit_sha,"idempotencyKey":"r52c-shared-noop-0000","path":"new.md","content":{"markdown":"# New\n"}}),
    );
    assert_eq!(
        code(
            store
                .documents_update(&owner, noop.clone())
                .expect_err("noop shares ledger")
        ),
        ErrorCode::RateLimited
    );
    store.advance_clock_for_tests(60);
    let receipt = store
        .documents_update(&owner, noop.clone())
        .expect("noop fresh window");
    assert_eq!(receipt.kind, kb_client::types::ApplyKind::Noop);
    assert_eq!(admission_snapshot(&root).3, 1);
    assert_eq!(
        store
            .documents_update(&owner, noop)
            .expect("noop replay")
            .operation_id,
        receipt.operation_id
    );
    assert_eq!(admission_snapshot(&root).3, 1);
    fn failed(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
        Err(StoreError::StorageUnavailable(
            "injected disk measurement".into(),
        ))
    }
    store.set_disk_meter_for_tests(failed);
    let before = admission_snapshot(&root);
    let update = input::<DocumentsUpdate>(
        json!({"kbId":kb,"baseRevision":raw_receipt.commit_sha,"idempotencyKey":"r52c-disk-document-0000","path":"new.md","content":{"markdown":"# Different\n"}}),
    );
    assert_eq!(
        code(
            store
                .documents_update(&owner, update)
                .expect_err("disk before object writes")
        ),
        ErrorCode::StorageUnavailable
    );
    let upload = input::<kb_client::types::UploadBegin>(
        json!({"kbId":kb,"idempotencyKey":"r52c-disk-upload-0000","kind":"markdown","size":1,"contentHash":content_hash(b"x"),"mime":"text/markdown"}),
    );
    assert_eq!(
        code(
            store
                .upload_begin(&owner, upload)
                .expect_err("disk before staging reservation")
        ),
        ErrorCode::StorageUnavailable
    );
    assert_eq!(admission_snapshot(&root), before);
    assert_eq!(
        store
            .kb(&kb)
            .expect("kb")
            .expect("exists")
            .head_sha
            .as_deref(),
        Some(raw_receipt.commit_sha.as_str())
    );
}

#[test]
fn repair_rows_stay_in_the_registry_but_are_not_common_attachments() {
    let root = temp_root("attachment-repair");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "repair", "create-repair-00001");
    let kb = kb_of(&created);
    let db = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    db.execute(
        "UPDATE kbs SET state='REPAIR_REQUIRED', head_sha=NULL WHERE id=?1",
        [kb.as_str()],
    )
    .expect("mark repair");
    let update = input::<BasesUpdate>(
        json!({ "kbId": kb.as_str(), "metadataVersion": 1, "name": "New", "idempotencyKey": "repair-update-00001" }),
    );
    assert_eq!(
        code(
            store
                .bases_update(&owner, update.clone())
                .expect_err("repair update")
        ),
        ErrorCode::RepairRequired
    );
    assert_eq!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("row")
            .metadata_version,
        1
    );
    let listed = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert!(listed.items.is_empty());
    assert_eq!(
        code(get_kb(&store, &owner, &kb).expect_err("unready attachment")),
        ErrorCode::RepairRequired
    );
    assert!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("retained row")
            .head_sha
            .is_none()
    );
    assert_eq!(
        store.kb(&kb).expect("registry").expect("row").name,
        created["kb"]["name"].as_str().expect("name")
    );
    assert!(
        !store
            .intents(&kb)
            .expect("receipts")
            .iter()
            .any(|intent| intent.operation == "KB_UPDATE")
    );
    // Rejection must leave the key reusable when the KB is ready again.
    db.execute(
        "UPDATE kbs SET state='ACTIVE', head_sha=?2 WHERE id=?1",
        (kb.as_str(), head_of(&created).as_str()),
    )
    .expect("restore active fixture");
    let updated = store
        .bases_update(&owner, update.clone())
        .expect("update restored kb");
    let output = wire::<BasesUpdate>(&updated);
    assert_eq!(output["kb"]["name"], "New");
    assert_eq!(output["kb"]["metadataVersion"], 2);
    assert_eq!(
        store.bases_update(&owner, update).expect("update replay"),
        updated
    );
    assert_eq!(
        get_kb(&store, &owner, &kb).expect("get")["kb"],
        output["kb"]
    );
    assert_eq!(
        wire::<BasesList>(
            &store
                .bases_list(&owner, input::<BasesList>(json!({})))
                .expect("list restored kb")
        )["items"],
        json!([output["kb"]])
    );
    // Attachment readiness must not remove the owner's repair-row tombstone
    // capability, whose reply carries no attachment or private revision.
    db.execute(
        "UPDATE kbs SET state='REPAIR_REQUIRED', head_sha=NULL WHERE id=?1",
        [kb.as_str()],
    )
    .expect("mark repair again");
    let deleted = store
        .bases_delete(
            &owner,
            input::<BasesDelete>(json!({
                "kbId": kb, "metadataVersion": 2, "confirm": "DELETE",
                "idempotencyKey": "repair-delete-00001",
            })),
        )
        .expect("owner tombstones repair row");
    assert_eq!(wire::<BasesDelete>(&deleted)["tombstoned"], true);
    assert_eq!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("retained row")
            .state,
        kb_local::KbState::Tombstoned
    );
    drop(db);
    drop(store);
    std::fs::remove_dir_all(root.parent().expect("fixture parent")).expect("cleanup");
}

#[test]
fn selected_kb_list_pages_and_cursors_hold_only_selected_ids() {
    let root = temp_root("selected-list");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let mut ids: Vec<String> = ["sel-one", "sel-two", "sel-three", "sel-four"]
        .iter()
        .enumerate()
        .map(|(i, slug)| {
            kb_of(&create(
                &store,
                &owner,
                slug,
                &format!("selected-list-key-{i}"),
            ))
            .as_str()
            .to_owned()
        })
        .collect();
    ids.sort();
    let page = |selection: &std::collections::BTreeSet<String>, cursor: Option<&str>| {
        let mut args = json!({"limit": 1});
        if let Some(cursor) = cursor {
            args["cursor"] = json!(cursor);
        }
        store
            .bases_list_selected(&owner, input::<BasesList>(args), Some(selection))
            .map(|page| wire::<BasesList>(&page))
    };
    let ids_of = |page: &Value| -> Vec<String> {
        page["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|kb| kb["id"].as_str().expect("id").to_owned())
            .collect()
    };
    // Only the last KB selected: excluded KBs take no page slot and make no cursor.
    let last: std::collections::BTreeSet<String> = [ids[3].clone()].into();
    let only = page(&last, None).expect("page");
    assert_eq!(ids_of(&only), [ids[3].clone()]);
    assert!(only["nextCursor"].is_null());
    // Two of four, one per page: every cursor follows a selected row.
    let two: std::collections::BTreeSet<String> = [ids[0].clone(), ids[2].clone()].into();
    let first = page(&two, None).expect("page");
    assert_eq!(ids_of(&first), [ids[0].clone()]);
    let cursor = first["nextCursor"].as_str().expect("cursor").to_owned();
    let second = page(&two, Some(&cursor)).expect("page");
    assert_eq!(ids_of(&second), [ids[2].clone()]);
    assert!(second["nextCursor"].is_null());
    // A cursor is bound to its selection (and to no selection).
    assert_eq!(
        code(page(&last, Some(&cursor)).unwrap_err()),
        ErrorCode::InvalidCursor
    );
    assert_eq!(
        code(
            store
                .bases_list(
                    &owner,
                    input::<BasesList>(json!({"limit": 1, "cursor": cursor}))
                )
                .unwrap_err()
        ),
        ErrorCode::InvalidCursor
    );
}

#[test]
fn session_metadata_reads_live_authority_without_side_effects() {
    use kb_local::metadata::StoreMetadata;
    let root = temp_root("session-metadata");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let a = kb_of(&create(&store, &owner, "meta-a", "metadata-key-00001"));
    let b = kb_of(&create(&store, &owner, "meta-b", "metadata-key-00002"));
    let principal = reader(&store, &a, &[Permission::Read]);
    let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("fixture");
    db.execute(
        "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) VALUES (?1, 'TEST', ?2, 4)",
        (principal.id(), b.as_str()),
    )
    .expect("second ceiling");
    let meta = StoreMetadata::open(store.paths(), store.store_uuid()).expect("metadata");
    let found = meta.authority(&principal, None).expect("authority");
    assert!(!found.owner);
    assert!(found.create.is_none());
    let kbs = found.kbs.expect("narrowed");
    assert_eq!(kbs.len(), 2);
    let bits_of = |kb: &KbId| kbs.iter().find(|(id, _)| id == kb).expect("kb").1;
    assert_eq!(bits_of(&a).permissions(), [Permission::Read]);
    assert_eq!(
        bits_of(&b).permissions(),
        [Permission::Read, Permission::Propose, Permission::Write]
    );
    assert!(found.ceiling.contains(Permission::Write));
    // The selection limits both the KBs and the ceiling.
    let only_a: std::collections::BTreeSet<String> = [a.as_str().to_owned()].into();
    let narrowed = meta
        .authority(&principal, Some(&only_a))
        .expect("authority");
    assert_eq!(narrowed.kbs.expect("narrowed").len(), 1);
    assert!(!narrowed.ceiling.contains(Permission::Write));
    // Revocation and tombstones show on the next read.
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &principal, &a, &[])
        .expect("revoke");
    drop(guard);
    let version = get_kb(&store, &owner, &b).expect("kb")["kb"]["metadataVersion"].clone();
    store
        .bases_delete(
            &owner,
            input::<BasesDelete>(json!({"kbId": b, "metadataVersion": version,
                "confirm": "DELETE", "idempotencyKey": "metadata-delete-001"})),
        )
        .expect("delete");
    assert_eq!(
        meta.authority(&principal, None).expect("authority").kbs,
        Some(vec![])
    );
    let owned = meta
        .authority(
            &owner,
            Some(&[a.as_str().to_owned(), b.as_str().to_owned()].into()),
        )
        .expect("owner");
    assert!(owned.owner && owned.create.is_some());
    assert_eq!(owned.kbs.expect("narrowed").len(), 1);
    assert_eq!(meta.authority(&owner, None).expect("owner").kbs, None);
    // Opening reads only: a missing registry is not recreated.
    let detached = root.with_file_name("detached-state.sqlite");
    drop(meta);
    std::fs::rename(root.join("state.sqlite"), &detached).expect("detach");
    assert!(StoreMetadata::open(store.paths(), store.store_uuid()).is_err());
    assert!(!root.join("state.sqlite").exists());
    std::fs::rename(&detached, root.join("state.sqlite")).expect("restore");
}

#[test]
fn session_metadata_never_truncates_behind_retained_history() {
    use kb_local::metadata::StoreMetadata;
    let root = temp_root("metadata-history");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let live = kb_of(&create(&store, &owner, "live-kb", "history-key-000001"));
    let principal = reader(&store, &live, &[Permission::Write]);
    let mut db = rusqlite::Connection::open(root.join("state.sqlite")).expect("fixture");
    let tx = db.transaction().expect("fixture");
    // 4,100 tombstoned KBs whose IDs sort before the live one, each keeping
    // a read ceiling row for the principal (retained history).
    for n in 0..4100 {
        let id = format!("{n:0>24}");
        tx.execute(
            "INSERT INTO kbs (id, name, slug, description, state, created_at) \
             VALUES (?1, 'Old', ?1, 'Tombstoned history', 'TOMBSTONED', '2026-01-01T00:00:00Z')",
            [id.as_str()],
        )
        .expect("history kb");
        tx.execute(
            "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) VALUES (?1, 'TEST', ?2, 1)",
            (principal.id(), id.as_str()),
        )
        .expect("history ceiling");
    }
    tx.commit().expect("fixture");
    let meta = StoreMetadata::open(store.paths(), store.store_uuid()).expect("metadata");
    let found = meta.authority(&principal, None).expect("authority");
    assert!(
        found.ceiling.contains(Permission::Write),
        "live ceiling kept"
    );
    let kbs = found.kbs.expect("one live KB is narrowed");
    assert_eq!(kbs.len(), 1);
    assert_eq!(kbs[0].0, live);
    assert!(kbs[0].1.contains(Permission::Write));
    let selected: std::collections::BTreeSet<String> = [live.as_str().to_owned()].into();
    let found = meta
        .authority(&principal, Some(&selected))
        .expect("authority");
    assert_eq!(found.kbs.expect("narrowed").len(), 1);
    assert!(found.ceiling.contains(Permission::Write));
}
