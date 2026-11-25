//! Shared create and mutation admission: replay matrices, budgets, disk floor and encoded caps.

use super::*;

// Service-boundary admission regressions. Inspect the durable store before
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
        idempotency_key: format!("admit-create-{slug}-0000"),
    }
}

#[test]
fn raw_create_replay_admission_matrix() {
    let root = temp_root("admit-create-replay");
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
fn raw_create_read_revocation_is_independent_of_create() {
    let root = temp_root("admit-read-revoke");
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
fn invalid_generated_source_reserves_nothing_and_preserves_hourly_budget() {
    let root = temp_root("admit-invalid-source");
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
fn create_publication_rechecks_persisted_grant() {
    for revoke in [false, true] {
        let root = temp_root("admit-grant-gap");
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
    let root = temp_root("admit-grant-positive");
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
fn document_service_encoded_cap_exact_limit_and_overflow() {
    let root = temp_root("admit-response");
    let store = Store::open(&root).expect("open");
    let created = create(
        &store,
        &store.owner(),
        "response",
        "admit-response-create-0000",
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
fn metadata_budget_replay_rollback_delete_and_reentry() {
    let root = temp_root("admit-metadata-budget");
    let store = Store::open(&root).expect("open");
    store.set_cursor_clock_for_tests(2_000_000_000);
    let owner = store.owner();
    let kb = kb_of(&create(
        &store,
        &owner,
        "budget",
        "admit-budget-create-0000",
    ));
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
    db.execute_batch("CREATE TRIGGER reject_name BEFORE UPDATE OF name ON kbs WHEN NEW.name='Rejected by trigger' BEGIN SELECT RAISE(ABORT,'injected update failure'); END;")
        .expect("private fault trigger");
    let before_failure = admission_snapshot(&root);
    store
        .bases_update(
            &owner,
            input::<BasesUpdate>(json!({"kbId":kb,"metadataVersion":1,
        "idempotencyKey":"admit-update-rollback-0000","name":"Rejected by trigger"})),
        )
        .expect_err("actual registry write fails after budget charge");
    assert_eq!(admission_snapshot(&root), before_failure);
    let update = input::<BasesUpdate>(
        json!({"kbId":kb,"metadataVersion":1,"idempotencyKey":"admit-update-budget-0000","name":"Changed"}),
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
        json!({"kbId":kb,"metadataVersion":2,"idempotencyKey":"admit-update-blocked-0000","name":"Denied"}),
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
        json!({"kbId":kb,"metadataVersion":2,"idempotencyKey":"admit-delete-budget-0000","confirm":"DELETE"}),
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
fn metadata_mismatch_precedes_fresh_domain_validation() {
    let root = temp_root("admit-update-order");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let kb = kb_of(&create(
        &store,
        &owner,
        "update-order",
        "admit-update-order-create",
    ));
    let request = input::<BasesUpdate>(
        json!({"kbId":kb,"metadataVersion":1,"idempotencyKey":"admit-update-order-0000","name":"Valid"}),
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
        value["idempotencyKey"] = json!(format!("admit-fresh-invalid-{field}"));
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
fn create_disk_floor_error_exact_admission_and_replay() {
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
            + format!(
                "---\nprovenance: agent\n---\n# Knowledge base\n\n{}\n",
                req.description
            )
            .len() as u64)
    }
    let root = temp_root("admit-disk");
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
    let upload = input::<kb_client::tools::UploadBegin>(json!({"kbId":receipt.kb_id,
        "idempotencyKey":"admit-disk-pending-0000","kind":"markdown","size":1,
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
fn document_and_raw_commit_share_admission_with_metadata() {
    use kb_client::tools::{DocumentsCreate, DocumentsUpdate};
    let root = temp_root("admit-shared-admission");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    store.set_cursor_clock_for_tests(2_000_000_000);
    let created = create(&store, &owner, "shared", "admit-shared-create-0000");
    let kb = kb_of(&created);
    let base = head_of(&created);
    let request = input::<DocumentsCreate>(
        json!({"kbId":kb,"baseRevision":base,"idempotencyKey":"admit-shared-document-0000","path":"new.md","content":{"markdown":"# New\n"}}),
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
        idempotency_key: "admit-shared-raw-0000".into(),
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
        json!({"kbId":kb,"baseRevision":raw_receipt.commit_sha,"idempotencyKey":"admit-shared-noop-0000","path":"new.md","content":{"markdown":"# New\n"}}),
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
        json!({"kbId":kb,"baseRevision":raw_receipt.commit_sha,"idempotencyKey":"admit-disk-document-0000","path":"new.md","content":{"markdown":"# Different\n"}}),
    );
    assert_eq!(
        code(
            store
                .documents_update(&owner, update)
                .expect_err("disk before object writes")
        ),
        ErrorCode::StorageUnavailable
    );
    let upload = input::<kb_client::tools::UploadBegin>(
        json!({"kbId":kb,"idempotencyKey":"admit-disk-upload-0000","kind":"markdown","size":1,"contentHash":content_hash(b"x"),"mime":"text/markdown"}),
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
