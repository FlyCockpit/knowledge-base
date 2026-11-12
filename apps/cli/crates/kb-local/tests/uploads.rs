//! Spec-first durable upload lifecycle tests using real files and SQLite.
use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::{
    ErrorCode, decode_input,
    schema::{Direction, validate},
    snapshot::content_hash,
    types::*,
};
use kb_local::{LocalPrincipal, PrincipalKind, Store, StoreError, uploads::UploadStage};
use serde_json::{Value, json};
use std::process::{Command, Stdio};
#[path = "support/fixture.rs"]
mod fixture;

/// The local per-actor, per-KB write window.
const MUTATIONS: usize = kb_local::limits::LOCAL_MUTATIONS_PER_MINUTE_PER_KB;
fn begin(
    store: &Store,
    who: &LocalPrincipal,
    kb: &KbId,
    bytes: &[u8],
    kind: &str,
    mime: &str,
    key: &str,
) -> UploadBeginOutput {
    let output = store
        .upload_begin(
            who,
            decode_input::<UploadBegin>(json!({"kbId":kb, "kind":kind,
        "mime":mime,"size":bytes.len(),"contentHash":content_hash(bytes),"idempotencyKey":key}))
            .expect("fixture operation"),
        )
        .expect("fixture operation");
    validate(
        "knowledge_upload_begin",
        Direction::Output,
        &serde_json::to_value(&output).expect("fixture operation"),
    )
    .expect("fixture operation");
    output
}
fn write(
    store: &Store,
    who: &LocalPrincipal,
    kb: &KbId,
    id: &Uuid,
    offset: u64,
    bytes: &[u8],
) -> Result<UploadWriteOutput, StoreError> {
    store.upload_write(
        who,
        UploadWriteInput {
            kb_id: kb.clone(),
            upload_id: id.clone(),
            offset,
            bytes_base64: STANDARD.encode(bytes),
        },
    )
}
fn finish(
    store: &Store,
    who: &LocalPrincipal,
    kb: &KbId,
    id: &Uuid,
) -> Result<UploadFinishOutput, StoreError> {
    store.upload_finish(
        who,
        UploadRef {
            kb_id: kb.clone(),
            upload_id: id.clone(),
        },
    )
}
fn kb(store: &Store, slug: &str) -> KbId {
    store.bases_create(&store.owner(), decode_input::<BasesCreate>(json!({"name":"Fixture","slug":slug,
        "description":"Upload lifecycle test knowledge base","idempotencyKey":format!("create-{slug}-000000000")})).expect("fixture operation")).expect("fixture operation").kb.id
}
fn code<T: std::fmt::Debug>(result: Result<T, StoreError>, expected: ErrorCode) {
    assert_eq!(
        result.expect_err("operation must reject").protocol_code(),
        expected
    );
}
/// Every upload CONFLICT names its closed reason.
fn conflict<T: std::fmt::Debug>(result: Result<T, StoreError>, details: serde_json::Value) {
    let error = result.expect_err("operation must reject");
    assert_eq!(error.protocol_code(), ErrorCode::Conflict);
    assert_eq!(error.protocol_details(), details);
}
fn reserved(store: &Store) -> i64 {
    rusqlite::Connection::open(store.paths().state_db())
        .expect("fixture operation")
        .query_row(
            "SELECT coalesce(sum(size),0) FROM staged_uploads WHERE reserved=1",
            [],
            |r| r.get(0),
        )
        .expect("fixture operation")
}
fn wav(size: usize) -> Vec<u8> {
    let mut bytes = vec![128; size];
    bytes[..44].copy_from_slice(&[
        82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 64,
        31, 0, 0, 64, 31, 0, 0, 1, 0, 8, 0, 100, 97, 116, 97, 0, 0, 0, 0,
    ]);
    bytes[4..8].copy_from_slice(&((size - 8) as u32).to_le_bytes());
    bytes[40..44].copy_from_slice(&((size - 44) as u32).to_le_bytes());
    bytes
}

#[test]
fn empty_store_and_primary_action_ready_do_not_commit() {
    let f = fixture::Fixture::new("upload-primary");
    let store = Store::open(&f.root.join("store")).expect("fixture operation");
    let kb = kb(&store, "primary");
    let who = store.owner();
    let before = store
        .kb(&kb)
        .expect("fixture operation")
        .expect("fixture operation");
    assert_eq!(reserved(&store), 0);
    let zero = UploadBeginInput {
        kb_id: kb.clone(),
        idempotency_key: IdempotencyKey::parse("upload-empty-00000").expect("fixture operation"),
        kind: UploadKind::Markdown,
        size: 0,
        content_hash: content_hash(b""),
        mime: Mime::TextMarkdown,
    };
    code(store.upload_begin(&who, zero), ErrorCode::InvalidArgument);
    for (n, bytes) in [b"# hello\n\tworld\r\n".as_slice()].into_iter().enumerate() {
        let b = begin(
            &store,
            &who,
            &kb,
            bytes,
            "markdown",
            "text/markdown",
            &format!("upload-primary-000{n}"),
        );
        if !bytes.is_empty() {
            assert_eq!(
                write(&store, &who, &kb, &b.upload_id, 0, bytes)
                    .expect("fixture operation")
                    .offset,
                bytes.len() as u64
            );
        }
        let ready = finish(&store, &who, &kb, &b.upload_id).expect("fixture operation");
        validate(
            "knowledge_upload_finish",
            Direction::Output,
            &serde_json::to_value(&ready).expect("fixture operation"),
        )
        .expect("fixture operation");
        assert_eq!(
            serde_json::to_value(&ready).expect("fixture operation")["state"],
            "READY"
        );
        assert_eq!(
            finish(&store, &who, &kb, &b.upload_id).expect("fixture operation"),
            ready
        );
        assert_eq!(
            begin(
                &store,
                &who,
                &kb,
                bytes,
                "markdown",
                "text/markdown",
                &format!("upload-primary-000{n}")
            )
            .upload_id,
            b.upload_id
        );
    }
    assert_eq!(
        store
            .kb(&kb)
            .expect("fixture operation")
            .expect("fixture operation"),
        before
    );
    assert!(
        store
            .pull_requests_list(
                &who,
                decode_input::<PullRequestsList>(json!({"kbId":kb})).expect("fixture operation")
            )
            .expect("fixture operation")
            .items
            .is_empty()
    );
}

#[test]
fn max_asset_framed_restart_and_identical_retry() {
    let f = fixture::Fixture::new("upload-max");
    let root = f.root.join("store");
    let bytes = wav(25 * 1024 * 1024);
    let mut store = Store::open(&root).expect("fixture operation");
    let kb = kb(&store, "max");
    let who = store.owner();
    let b = begin(
        &store,
        &who,
        &kb,
        &bytes,
        "asset",
        "audio/wav",
        "upload-max-0000000",
    );
    code(
        write(&store, &who, &kb, &b.upload_id, 0, &bytes[..196609]),
        ErrorCode::InvalidArgument,
    );
    for (i, chunk) in bytes.chunks(196608).enumerate() {
        let offset = (i * 196608) as u64;
        let next =
            write(&store, &who, &kb, &b.upload_id, offset, chunk).expect("fixture operation");
        assert_eq!(next.offset, offset + chunk.len() as u64);
        assert_eq!(
            write(&store, &who, &kb, &b.upload_id, offset, chunk).expect("fixture operation"),
            next
        );
        if i == 3 {
            drop(store);
            store = Store::open(&root).expect("fixture operation");
        }
    }
    assert_eq!(
        finish(&store, &who, &kb, &b.upload_id)
            .expect("fixture operation")
            .content_hash,
        content_hash(&bytes)
    );
    assert_eq!(reserved(&store), bytes.len() as i64);
}

#[test]
fn binding_live_authority_size_hash_kind_utf8_and_offsets_fail_closed() {
    let f = fixture::Fixture::new("upload-binding");
    let store = Store::open(&f.root.join("store")).expect("fixture operation");
    let one = kb(&store, "one");
    let two = kb(&store, "two");
    let owner = store.owner();
    let other = {
        let guard = store
            .lock_write(std::slice::from_ref(&one))
            .expect("fixture operation");
        store
            .register_principal(&guard, PrincipalKind::Test, &one, &[Permission::Propose])
            .expect("fixture operation")
    };
    let b = begin(
        &store,
        &owner,
        &one,
        b"abcdef",
        "markdown",
        "text/markdown",
        "upload-binding-000",
    );
    code(
        write(&store, &other, &one, &b.upload_id, 0, b"abc"),
        ErrorCode::NotFound,
    );
    code(
        finish(&store, &other, &one, &b.upload_id),
        ErrorCode::NotFound,
    );
    code(
        write(&store, &owner, &two, &b.upload_id, 0, b"abc"),
        ErrorCode::NotFound,
    );
    code(
        finish(&store, &owner, &two, &b.upload_id),
        ErrorCode::NotFound,
    );
    code(
        finish(&store, &owner, &one, &b.upload_id),
        ErrorCode::UploadIncomplete,
    );
    code(
        write(&store, &owner, &one, &b.upload_id, 1, b"a"),
        ErrorCode::UploadIncomplete,
    );
    write(&store, &owner, &one, &b.upload_id, 0, b"abc").expect("fixture operation");
    let mismatch = serde_json::json!({"reason": "UPLOAD_BYTES_MISMATCH", "field": "/offset"});
    conflict(
        write(&store, &owner, &one, &b.upload_id, 0, b"xxx"),
        mismatch.clone(),
    );
    conflict(
        write(&store, &owner, &one, &b.upload_id, 1, b"bcde"),
        mismatch,
    );
    // Beyond the declared size: the chunk is TOO_LARGE (server parity).
    let beyond =
        write(&store, &owner, &one, &b.upload_id, 3, b"defg").expect_err("beyond declared size");
    assert_eq!(beyond.protocol_code(), ErrorCode::InvalidArgument);
    assert_eq!(
        beyond.protocol_details(),
        serde_json::json!({"reason": "TOO_LARGE", "field": "/bytesBase64"})
    );
    code(
        write(&store, &owner, &one, &b.upload_id, 3, b""),
        ErrorCode::InvalidArgument,
    );
    code(
        write(&store, &owner, &one, &b.upload_id, 3, &vec![0; 196609]),
        ErrorCode::InvalidArgument,
    );
    write(&store, &owner, &one, &b.upload_id, 3, b"xyz").expect("fixture operation");
    conflict(
        finish(&store, &owner, &one, &b.upload_id),
        serde_json::json!({"reason": "CONTENT_HASH_MISMATCH"}),
    );
    for (i, bytes) in [
        b"bad\x00text".as_slice(),
        b"\xff\xfe",
        b"bad\x7f",
        b"bad\x01",
    ]
    .into_iter()
    .enumerate()
    {
        let u = begin(
            &store,
            &owner,
            &one,
            bytes,
            "markdown",
            "text/markdown",
            &format!("upload-invalid-000{i}"),
        );
        write(&store, &owner, &one, &u.upload_id, 0, bytes).expect("fixture operation");
        code(
            finish(&store, &owner, &one, &u.upload_id),
            ErrorCode::InvalidArgument,
        );
    }
    for (kind, mime, size) in [
        ("asset", "text/markdown", 1),
        ("markdown", "audio/wav", 1),
        ("asset", "image/svg+xml", 1),
        ("markdown", "text/markdown", 2 * 1024 * 1024 + 1),
        ("asset", "audio/wav", 25 * 1024 * 1024 + 1),
    ] {
        let input = UploadBeginInput {
            kb_id: one.clone(),
            idempotency_key: IdempotencyKey::parse("invalid-begin-0000")
                .expect("fixture operation"),
            kind: if kind == "asset" {
                UploadKind::Asset
            } else {
                UploadKind::Markdown
            },
            size,
            content_hash: content_hash(b"x"),
            mime: serde_json::from_value(json!(mime)).expect("fixture operation"),
        };
        code(
            store.upload_begin(&owner, input),
            ErrorCode::InvalidArgument,
        );
    }
    let input = decode_input::<UploadBegin>(
        json!({"kbId":one,"kind":"markdown","mime":"text/markdown","size":1,
        "contentHash":content_hash(b"x"),"idempotencyKey":"upload-binding-000"}),
    )
    .expect("fixture operation");
    code(
        store.upload_begin(&owner, input),
        ErrorCode::IdempotencyMismatch,
    );
    let conn = rusqlite::Connection::open(store.paths().state_db()).expect("fixture operation");
    conn.execute(
        "UPDATE principal_ceilings SET bits=1 WHERE principal_id=?1",
        [other.id()],
    )
    .expect("fixture operation");
    code(
        store.upload_begin(
            &other,
            decode_input::<UploadBegin>(
                json!({"kbId":one,"kind":"markdown","mime":"text/markdown",
        "size":1,"contentHash":content_hash(b"x"),"idempotencyKey":"upload-revoked-000"}),
            )
            .expect("fixture operation"),
        ),
        ErrorCode::Forbidden,
    );
}

#[test]
fn expiry_releases_once_startup_sweep_and_timer_never_touch_cas() {
    // Startup recovery and timer ticks use nonblocking admission. Other
    // tests' Git spawns share the process-wide lock registry, so exercise
    // the uncontended startup contract in its own process, with every
    // assertion still running against real Store/SQLite/filesystem code.
    if std::env::var_os("KB_UPLOAD_EXPIRY_TEST_CHILD").is_none() {
        let output = Command::new(std::env::current_exe().expect("fixture executable"))
            .args([
                "--exact",
                "expiry_releases_once_startup_sweep_and_timer_never_touch_cas",
                "--nocapture",
            ])
            .env("KB_UPLOAD_EXPIRY_TEST_CHILD", "1")
            .stdin(Stdio::null())
            .output()
            .expect("spawn expiry test");
        assert!(
            output.status.success(),
            "expiry child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed;"),
            "expiry child must execute exactly one test"
        );
        return;
    }
    let f = fixture::Fixture::new("upload-expiry");
    let root = f.root.join("store");
    let store = Store::open(&root).expect("fixture operation");
    let kb = kb(&store, "expiry");
    let who = store.owner();
    let b = begin(
        &store,
        &who,
        &kb,
        b"abc",
        "markdown",
        "text/markdown",
        "upload-expiry-0000",
    );
    write(&store, &who, &kb, &b.upload_id, 0, b"abc").expect("fixture operation");
    finish(&store, &who, &kb, &b.upload_id).expect("fixture operation");
    let historic = store.paths().assets_dir().join("historic");
    std::fs::write(&historic, b"history").expect("fixture operation");
    assert_eq!(reserved(&store), 3);
    store.advance_clock_for_tests(3600);
    code(
        finish(&store, &who, &kb, &b.upload_id),
        ErrorCode::UploadExpired,
    );
    assert_eq!(reserved(&store), 0);
    store.sweep_uploads().expect("fixture operation");
    assert_eq!(reserved(&store), 0);
    assert_eq!(
        std::fs::read(&historic).expect("fixture operation"),
        b"history"
    );
    drop(store);
    let store = Store::open(&root).expect("fixture operation");
    assert_eq!(reserved(&store), 0);
    assert_eq!(std::fs::read(&historic).expect("historic CAS"), b"history");
    let b = begin(
        &store,
        &who,
        &kb,
        b"abc",
        "markdown",
        "text/markdown",
        "upload-startup-000",
    );
    let conn = rusqlite::Connection::open(store.paths().state_db()).expect("fixture operation");
    conn.execute(
        "UPDATE staged_uploads SET expires_ms=0 WHERE id=?1",
        [b.upload_id.as_str()],
    )
    .expect("fixture operation");
    drop(store);
    let store = Store::open(&root).expect("fixture operation");
    assert_eq!(reserved(&store), 0);
    assert_eq!(std::fs::read(&historic).expect("historic CAS"), b"history");
    let b = begin(
        &store,
        &who,
        &kb,
        b"abc",
        "markdown",
        "text/markdown",
        "upload-timer-00000",
    );
    conn.execute(
        "UPDATE staged_uploads SET expires_ms=0 WHERE id=?1",
        [b.upload_id.as_str()],
    )
    .expect("fixture operation");
    store
        .run_upload_timer_for_tests()
        .expect("fixture operation");
    assert_eq!(reserved(&store), 0);
    assert_eq!(std::fs::read(&historic).expect("historic CAS"), b"history");
}

#[test]
fn expiry_defers_under_writer_lock_and_preserves_live_staging() {
    let f = fixture::Fixture::new("upload-expiry-busy");
    let root = f.root.join("store");
    let store = Store::open(&root).expect("open store");
    let kb = kb(&store, "expiry-busy");
    let who = store.owner();
    let expired = begin(
        &store,
        &who,
        &kb,
        b"abc",
        "markdown",
        "text/markdown",
        "upload-expired-000",
    );
    let live = begin(
        &store,
        &who,
        &kb,
        b"live",
        "markdown",
        "text/markdown",
        "upload-live-00000",
    );
    let historic = store.paths().assets_dir().join("historic");
    std::fs::write(&historic, b"history").expect("historic CAS");
    // Expire while holding the store fence so neither startup nor the
    // nonblocking timer may perform cleanup until this writer releases it.
    let guard = store.lock_write(&[]).expect("writer fence");
    let conn = rusqlite::Connection::open(store.paths().state_db()).expect("fixture connection");
    conn.execute(
        "UPDATE staged_uploads SET expires_ms=0 WHERE id=?1",
        [expired.upload_id.as_str()],
    )
    .expect("expire fixture");
    let successor = Store::open(&root).expect("open while writer holds fence");
    successor
        .run_upload_timer_for_tests()
        .expect("busy timer tick");
    assert_eq!(reserved(&successor), 7);
    assert!(
        store
            .paths()
            .uploads_dir()
            .join(expired.upload_id.as_str())
            .exists()
    );
    drop(guard);
    drop(successor.lock_write(&[]).expect("recover after release"));
    assert_eq!(reserved(&successor), 4);
    assert!(
        !store
            .paths()
            .uploads_dir()
            .join(expired.upload_id.as_str())
            .exists()
    );
    successor.sweep_uploads().expect("repeat cleanup");
    assert_eq!(reserved(&successor), 4);
    assert_eq!(std::fs::read(&historic).expect("historic CAS"), b"history");
    write(&successor, &who, &kb, &live.upload_id, 0, b"live").expect("live frame remains usable");
    finish(&successor, &who, &kb, &live.upload_id).expect("live upload remains usable");
}

#[test]
fn quota_admission_and_release_are_durable() {
    let f = fixture::Fixture::new("upload-quota");
    let store = Store::open(&f.root.join("store")).expect("fixture operation");
    let kb = kb(&store, "quota");
    // Asset-sized begins fill the local hourly byte
    // window exactly (64 x 16 MiB = 1 GiB, within the per-KB storage cap).
    let chunk = 16 << 20;
    let bytes = wav(chunk);
    for i in 0..kb_local::limits::LOCAL_UPLOAD_BYTES_PER_HOUR / chunk as u64 {
        begin(
            &store,
            &store.owner(),
            &kb,
            &bytes,
            "asset",
            "audio/wav",
            &format!("upload-quota-{i:05}"),
        );
    }
    let input = UploadBeginInput {
        kb_id: kb,
        idempotency_key: IdempotencyKey::parse("upload-quota-full").expect("fixture operation"),
        kind: UploadKind::Asset,
        size: 1,
        content_hash: content_hash(b"x"),
        mime: Mime::AudioWav,
    };
    code(
        store.upload_begin(&store.owner(), input),
        ErrorCode::RateLimited,
    );
    store.advance_clock_for_tests(3600);
    store.sweep_uploads().expect("fixture operation");
    assert_eq!(reserved(&store), 0);
}

#[test]
fn crash_child() {
    let Ok(path) = std::env::var("KB_UPLOAD_TEST_CHILD") else {
        return;
    };
    let config: Value = serde_json::from_str(&path).expect("fixture operation");
    let store = Store::open(std::path::Path::new(
        config["root"].as_str().expect("fixture operation"),
    ))
    .expect("fixture operation");
    let input: UploadWriteInput =
        serde_json::from_value(config["input"].clone()).expect("fixture operation");
    store
        .upload_write_observed(&store.owner(), input, &mut |stage| {
            if stage == UploadStage::FileDurable {
                std::process::exit(73)
            }
        })
        .expect("fixture operation");
    panic!("crash boundary not reached");
}

#[test]
fn crash_between_fsync_and_offset_commit_recovers_exact_tail_and_rejects_changed_tail() {
    let f = fixture::Fixture::new("upload-crash");
    let root = f.root.join("store");
    let store = Store::open(&root).expect("fixture operation");
    let kb = kb(&store, "crash");
    let b = begin(
        &store,
        &store.owner(),
        &kb,
        b"abcdef",
        "markdown",
        "text/markdown",
        "upload-crash-00000",
    );
    drop(store);
    let input =
        json!({"kbId":kb,"uploadId":b.upload_id,"offset":0,"bytesBase64":STANDARD.encode(b"abc")});
    let output = Command::new(std::env::current_exe().expect("fixture operation"))
        .args(["--exact", "crash_child", "--nocapture"])
        .env(
            "KB_UPLOAD_TEST_CHILD",
            json!({"root":root,"input":input}).to_string(),
        )
        .stdin(Stdio::null())
        .output()
        .expect("fixture operation");
    assert_eq!(
        output.status.code(),
        Some(73),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let store = Store::open(&root).expect("fixture operation");
    assert_eq!(reserved(&store), 6);
    code(
        write(&store, &store.owner(), &kb, &b.upload_id, 0, b"xxx"),
        ErrorCode::Conflict,
    );
    code(
        write(&store, &store.owner(), &kb, &b.upload_id, 0, b"a"),
        ErrorCode::Conflict,
    );
    assert_eq!(
        write(&store, &store.owner(), &kb, &b.upload_id, 0, b"abc")
            .expect("fixture operation")
            .offset,
        3
    );
    write(&store, &store.owner(), &kb, &b.upload_id, 3, b"def").expect("fixture operation");
    finish(&store, &store.owner(), &kb, &b.upload_id).expect("fixture operation");
    store.advance_clock_for_tests(3600);
    store.sweep_uploads().expect("fixture operation");
    store.sweep_uploads().expect("fixture operation");
    assert_eq!(reserved(&store), 0);
}

fn tiny_input(id: &KbId, key: &str) -> UploadBeginInput {
    decode_input::<UploadBegin>(json!({"kbId":id,"kind":"markdown","mime":"text/markdown","size":1,"contentHash":content_hash(b"x"),"idempotencyKey":key})).expect("input")
}

#[test]
fn mutation_window_counts_new_begin_and_finish_but_exempts_replay_and_frames() {
    const NOW_SECONDS: u64 = 4_102_444_800;
    let f = fixture::Fixture::new("upload-mutations");
    let root = f.root.join("store");
    let store = Store::open(&root).expect("store");
    // Freeze the budget window across slow I/O and preserve it on reopen.
    store.set_cursor_clock_for_tests(NOW_SECONDS);
    let id = kb(&store, "mutations");
    let other = kb(&store, "other-mutations");
    let who = store.owner();
    let input = tiny_input(&id, "mutations-ready-000");
    let ready = store.upload_begin(&who, input.clone()).expect("begin");
    // Replays and frames are exempt even past the whole window.
    for _ in 0..MUTATIONS + 10 {
        assert_eq!(
            store
                .upload_begin(&who, input.clone())
                .expect("replay")
                .upload_id,
            ready.upload_id
        );
    }
    write(&store, &who, &id, &ready.upload_id, 0, b"x").expect("frame");
    for _ in 0..MUTATIONS + 10 {
        write(&store, &who, &id, &ready.upload_id, 0, b"x").expect("frame replay");
    }
    for _ in 0..MUTATIONS - 1 {
        finish(&store, &who, &id, &ready.upload_id).expect("charged finish");
    }
    code(
        finish(&store, &who, &id, &ready.upload_id),
        ErrorCode::RateLimited,
    );
    let next = tiny_input(&id, "mutations-blocked-000");
    code(
        store.upload_begin(&who, next.clone()),
        ErrorCode::RateLimited,
    );
    assert_eq!(reserved(&store), 1);
    store
        .upload_begin(&who, tiny_input(&other, "mutations-other-000"))
        .expect("other KB");
    let guard = store.lock_write(std::slice::from_ref(&id)).expect("guard");
    let principal = store
        .register_principal(&guard, PrincipalKind::Test, &id, &[Permission::Propose])
        .expect("principal");
    drop(guard);
    store
        .upload_begin(&principal, tiny_input(&id, "mutations-principal-000"))
        .expect("other actor");
    drop(store);
    let store = Store::open(&root).expect("restart");
    store.set_cursor_clock_for_tests(NOW_SECONDS);
    code(
        store.upload_begin(&who, next.clone()),
        ErrorCode::RateLimited,
    );
    store.advance_clock_for_tests(59);
    code(
        store.upload_begin(&who, next.clone()),
        ErrorCode::RateLimited,
    );
    store.advance_clock_for_tests(1);
    store
        .upload_begin(&who, next)
        .expect("rolling window expires");
}

#[test]
fn concurrent_mutation_admission_has_one_last_slot_and_one_reservation() {
    const NOW_SECONDS: u64 = 4_102_444_800;
    let f = fixture::Fixture::new("upload-mutation-race");
    let root = f.root.join("store");
    let store = Store::open(&root).expect("store");
    // All actors in the real admission race observe the same budget window.
    store.set_cursor_clock_for_tests(NOW_SECONDS);
    let id = kb(&store, "mutation-race");
    let b = store
        .upload_begin(&store.owner(), tiny_input(&id, "mutation-race-0000"))
        .expect("begin");
    write(&store, &store.owner(), &id, &b.upload_id, 0, b"x").expect("frame");
    for _ in 0..MUTATIONS - 2 {
        finish(&store, &store.owner(), &id, &b.upload_id).expect("finish");
    }
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|i| {
            let root = root.clone();
            let id = id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = Store::open(&root).expect("peer");
                store.set_cursor_clock_for_tests(NOW_SECONDS);
                let input = tiny_input(&id, &format!("mutation-race-peer-{i}"));
                barrier.wait();
                store.upload_begin(&store.owner(), input)
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = workers
        .into_iter()
        .map(|w| w.join().expect("worker"))
        .collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r
                .as_ref()
                .is_err_and(|e| e.protocol_code() == ErrorCode::RateLimited))
            .count(),
        1
    );
    assert_eq!(reserved(&store), 2);
}

#[test]
fn cleanup_error_does_not_starve_later_pages_or_release_live_stages() {
    let f = fixture::Fixture::new("upload-cleanup-pages");
    let store = Store::open(&f.root.join("store")).expect("store");
    let id = kb(&store, "cleanup-pages");
    let who = store.owner();
    let failed = store
        .upload_begin(&who, tiny_input(&id, "cleanup-failed-000"))
        .expect("begin");
    let live = store
        .upload_begin(&who, tiny_input(&id, "cleanup-live-00000"))
        .expect("begin");
    let p = store.paths().uploads_dir().join(failed.upload_id.as_str());
    std::fs::remove_file(&p).expect("remove owned file");
    std::fs::create_dir(&p).expect("unlink failure fixture");
    let conn = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    conn.execute(
        "UPDATE staged_uploads SET expires_ms=0 WHERE id=?1",
        [failed.upload_id.as_str()],
    )
    .expect("expire");
    let tx = conn.unchecked_transaction().expect("tx");
    for n in 0..205 {
        let uid = format!("00000000-0000-4000-8000-{n:012x}");
        tx.execute("INSERT INTO staged_uploads(id,op_id,kb_id,actor_key,idempotency_key,request_json,kind,size,hash,mime,created_ms,expires_ms) VALUES (?1,?1,?2,?3,?1,'{}','markdown',1,?4,'\"text/markdown\"',0,0)",rusqlite::params![uid,id.as_str(),who.actor_key(),content_hash(b"x").as_str()]).expect("row");
    }
    tx.commit().expect("commit");
    let mut saw_error = false;
    for _ in 0..5 {
        if store.sweep_uploads().is_err() {
            saw_error = true
        }
    }
    assert!(saw_error);
    assert_eq!(reserved(&store), 1);
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM staged_uploads WHERE reclaimed=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .expect("count"),
        205
    );
    assert_eq!(
        conn.query_row(
            "SELECT reclaimed FROM staged_uploads WHERE id=?1",
            [failed.upload_id.as_str()],
            |r| r.get::<_, i64>(0)
        )
        .expect("pending"),
        0
    );
    std::fs::remove_dir(&p).expect("remove owned fixture");
    store.advance_clock_for_tests(60);
    store.sweep_uploads().expect("retry");
    assert_eq!(reserved(&store), 1);
    write(&store, &who, &id, &live.upload_id, 0, b"x").expect("live stage");
}

#[test]
fn lifecycle_crash_child() {
    let Ok(encoded) = std::env::var("KB_UPLOAD_LIFECYCLE_CHILD") else {
        return;
    };
    let config: Value = serde_json::from_str(&encoded).expect("config");
    let store =
        Store::open(std::path::Path::new(config["root"].as_str().expect("root"))).expect("store");
    if config["mode"] == "begin" {
        let input: UploadBeginInput =
            serde_json::from_value(config["input"].clone()).expect("input");
        store
            .upload_begin_observed(&store.owner(), input, &mut |s| {
                if s == UploadStage::Reserved {
                    std::process::exit(73)
                }
            })
            .expect("begin");
    } else {
        store.advance_clock_for_tests(3600);
        store
            .sweep_uploads_observed(&mut |s| {
                if s == UploadStage::ExpiredDurable {
                    std::process::exit(73)
                }
            })
            .expect("expiry");
    }
    panic!("boundary not reached");
}

#[test]
fn crashes_after_begin_and_expiry_intents_recover_one_identity_and_one_release() {
    let f = fixture::Fixture::new("upload-lifecycle-crash");
    let root = f.root.join("store");
    let store = Store::open(&root).expect("store");
    let id = kb(&store, "lifecycle-crash");
    let input = tiny_input(&id, "lifecycle-crash-000");
    drop(store);
    let drive = |mode: &str| {
        let output = Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", "lifecycle_crash_child", "--nocapture"])
            .env(
                "KB_UPLOAD_LIFECYCLE_CHILD",
                json!({"root":root,"mode":mode,"input":input}).to_string(),
            )
            .stdin(Stdio::null())
            .output()
            .expect("child");
        assert_eq!(
            output.status.code(),
            Some(73),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    drive("begin");
    let store = Store::open(&root).expect("restart begin");
    let b = store
        .upload_begin(&store.owner(), input.clone())
        .expect("replay");
    assert_eq!(reserved(&store), 1);
    assert_eq!(
        store
            .upload_begin(&store.owner(), input.clone())
            .expect("same receipt")
            .upload_id,
        b.upload_id
    );
    write(&store, &store.owner(), &id, &b.upload_id, 0, b"x").expect("frame");
    finish(&store, &store.owner(), &id, &b.upload_id).expect("ready");
    let path = store.paths().uploads_dir().join(b.upload_id.as_str());
    drop(store);
    drive("expiry");
    assert!(path.exists(), "death must precede unlink");
    let conn = rusqlite::Connection::open(root.join("state.sqlite")).expect("db");
    assert_eq!(
        conn.query_row(
            "SELECT reserved+reclaimed FROM staged_uploads WHERE id=?1",
            [b.upload_id.as_str()],
            |r| r.get::<_, i64>(0)
        )
        .expect("intent"),
        0
    );
    let store = Store::open(&root).expect("restart expiry");
    assert!(!path.exists());
    assert_eq!(reserved(&store), 0);
    code(
        store.upload_begin(&store.owner(), input),
        ErrorCode::UploadExpired,
    );
    assert_eq!(store.sweep_uploads().expect("repeat"), 0);
}

/// Driven by the recorded strace script: EIO is injected at the real syscall,
/// while the control invocation must traverse the same owning boundary.
#[test]
fn durability_fault_child() {
    let Ok(encoded) = std::env::var("KB_UPLOAD_FAULT_CHILD") else {
        return;
    };
    let config: Value = serde_json::from_str(&encoded).expect("config");
    let root = std::path::PathBuf::from(config["root"].as_str().expect("root"));
    let store = Store::open(&root).expect("store");
    let id = kb(&store, "fault");
    let who = store.owner();
    let input = tiny_input(&id, "fault-boundary-000");
    let b = store.upload_begin(&who, input.clone()).expect("begin");
    let kind = config["kind"].as_str().expect("kind");
    let injected = config["injected"].as_bool().expect("injected");
    if kind != "write" {
        write(&store, &who, &id, &b.upload_id, 0, b"x").expect("frame");
        finish(&store, &who, &id, &b.upload_id).expect("ready");
    }
    let conn = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    let p = store.paths().uploads_dir().join(b.upload_id.as_str());
    std::fs::write(root.join("fault-boundary"), b"target follows").expect("marker");
    match kind {
        "write" => {
            let result = write(&store, &who, &id, &b.upload_id, 0, b"x");
            if injected {
                code(result, ErrorCode::StorageUnavailable);
                assert_eq!(
                    conn.query_row(
                        "SELECT poisoned FROM staged_uploads WHERE id=?1",
                        [b.upload_id.as_str()],
                        |r| r.get::<_, i64>(0)
                    )
                    .expect("poison"),
                    1
                );
                code(
                    write(&store, &who, &id, &b.upload_id, 0, b"x"),
                    ErrorCode::StorageUnavailable,
                );
                code(
                    finish(&store, &who, &id, &b.upload_id),
                    ErrorCode::StorageUnavailable,
                );
                drop(store);
                let store = Store::open(&root).expect("restart");
                code(
                    store.upload_begin(&who, input),
                    ErrorCode::StorageUnavailable,
                );
                code(
                    write(&store, &who, &id, &b.upload_id, 0, b"x"),
                    ErrorCode::StorageUnavailable,
                );
                code(
                    finish(&store, &who, &id, &b.upload_id),
                    ErrorCode::StorageUnavailable,
                );
            } else {
                result.expect("control frame");
                finish(&store, &who, &id, &b.upload_id).expect("control ready");
            }
        }
        "open" => {
            let result = store.upload_begin(&who, input.clone());
            if injected {
                code(result, ErrorCode::StorageUnavailable);
            } else {
                result.expect("control replay");
            }
            assert_eq!(
                conn.query_row(
                    "SELECT state FROM staged_uploads WHERE id=?1",
                    [b.upload_id.as_str()],
                    |r| r.get::<_, String>(0)
                )
                .expect("state"),
                "READY"
            );
            assert_eq!(reserved(&store), 1);
            assert_eq!(std::fs::read(&p).expect("accepted bytes"), b"x");
            assert_eq!(
                store
                    .upload_begin(&who, input)
                    .expect("recovered replay")
                    .upload_id,
                b.upload_id
            );
            finish(&store, &who, &id, &b.upload_id).expect("still READY");
        }
        "expiry" => {
            store.advance_clock_for_tests(3600);
            let result = store.sweep_uploads();
            if injected {
                code(result, ErrorCode::StorageUnavailable);
                assert_eq!(
                    conn.query_row(
                        "SELECT reclaimed FROM staged_uploads WHERE id=?1",
                        [b.upload_id.as_str()],
                        |r| r.get::<_, i64>(0)
                    )
                    .expect("uncertain"),
                    0
                );
            } else {
                result.expect("control sweep");
            }
            assert!(!p.exists());
            assert_eq!(reserved(&store), 0);
            store.advance_clock_for_tests(60);
            store.sweep_uploads().expect("retry directory barrier");
            assert_eq!(
                conn.query_row(
                    "SELECT reclaimed FROM staged_uploads WHERE id=?1",
                    [b.upload_id.as_str()],
                    |r| r.get::<_, i64>(0)
                )
                .expect("complete"),
                1
            );
            assert_eq!(store.sweep_uploads().expect("repeat"), 0);
        }
        _ => panic!("unknown scenario"),
    }
    std::fs::write(root.join("fault-complete"), kind).expect("completion");
}

#[test]
fn admission_with_one_hundred_thousand_retained_receipts_preserves_binding_and_budget() {
    let f = fixture::Fixture::new("upload-retained");
    let store = Store::open(&f.root.join("store")).expect("store");
    let id = kb(&store, "retained");
    let who = store.owner();
    let guard = store.lock_write(&[]).expect("producer fence");
    let conn = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    conn.execute("WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<99999) INSERT INTO staged_uploads(id,op_id,kb_id,actor_key,idempotency_key,request_json,kind,size,hash,mime,created_ms,expires_ms,state,reserved,reclaimed) SELECT printf('00000000-0000-4000-8000-%012d',i),printf('10000000-0000-4000-8000-%012d',i),?1,?2,printf('retained-receipt-%012d',i),'{}','markdown',1,?3,'\"text/markdown\"',0,0,'EXPIRED',0,1 FROM n",rusqlite::params![id.as_str(),who.actor_key(),content_hash(b"x").as_str()]).expect("retained receipts");
    drop(guard);
    let start = std::time::Instant::now();
    let input = tiny_input(&id, "retained-live-0000");
    let b = store
        .upload_begin(&who, input.clone())
        .expect("actual admission");
    assert!(
        start.elapsed() < std::time::Duration::from_secs(30),
        "supported retained-volume admission"
    );
    assert_eq!(
        store.upload_begin(&who, input).expect("replay").upload_id,
        b.upload_id
    );
    assert_eq!(reserved(&store), 1);
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM staged_uploads WHERE state='EXPIRED' AND reclaimed=1",
            [],
            |r| r.get::<_, i64>(0)
        )
        .expect("bindings retained"),
        100000
    );
}

#[test]
fn actual_minute_timer_reclaims_expiry_and_drop_notifies_under_writer_fence() {
    let f = fixture::Fixture::new("upload-real-timer");
    let store = Store::open(&f.root.join("store")).expect("store");
    let id = kb(&store, "real-timer");
    let who = store.owner();
    let expired = store
        .upload_begin(&who, tiny_input(&id, "real-timer-expired-000"))
        .expect("expired begin");
    let live = store
        .upload_begin(&who, tiny_input(&id, "real-timer-live-000"))
        .expect("live begin");
    let path = store.paths().uploads_dir().join(expired.upload_id.as_str());
    let historic = store.paths().assets_dir().join("historic");
    std::fs::write(&historic, b"history").expect("historic fixture");
    let guard = store.lock_write(&[]).expect("fence");
    let conn = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    conn.execute(
        "UPDATE staged_uploads SET expires_ms=0 WHERE id=?1",
        [expired.upload_id.as_str()],
    )
    .expect("expire");
    drop(guard);
    // No service call or test tick may perform reclamation: this waits for
    // the actual production condvar timeout and worker-owned SQLite/I/O.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(80);
    while path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "owned minute timer did not reclaim"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(reserved(&store), 1);
    assert_eq!(std::fs::read(&historic).expect("historic"), b"history");
    write(&store, &who, &id, &live.upload_id, 0, b"x").expect("live stage");
    let guard = store.lock_write(&[]).expect("shutdown fence");
    let start = std::time::Instant::now();
    drop(store);
    assert!(
        start.elapsed() < std::time::Duration::from_secs(1),
        "shutdown must notify sleeping worker without waiting for writer fence"
    );
    drop(guard);
}
