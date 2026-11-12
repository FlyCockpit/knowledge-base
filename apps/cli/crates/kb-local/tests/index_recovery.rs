#[path = "support/child_guard.rs"]
mod child_guard;
#[path = "support/index_fixture.rs"]
mod support;
use child_guard::ChildGuard;

use kb_local::{Store, index::BuildStage};
use std::{
    io::Write,
    process::{Command, Stdio},
    time::Duration,
};
use support::*;
#[tokio::test]
async fn delete_index_reopen_rebuild_preserves_ids_history_receipts() {
    let f = Fixture::new(2);
    let job = f.set("profile-loss-0001");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("valid fixture")
    );
    let uuid = f.store.store_uuid().clone();
    let before = f
        .db()
        .query_row("SELECT count(*) FROM operation_intents", [], |r| {
            r.get::<_, i64>(0)
        })
        .expect("valid fixture");
    std::fs::remove_file(f.store.paths().index_file(&f.kb, &job.generation_id))
        .expect("valid fixture");
    let s = Store::open(&f.root).expect("valid fixture");
    drop(s.lock_write(&[]).expect("valid fixture"));
    assert_eq!(s.store_uuid(), &uuid);
    let record = s.kb(&f.kb).expect("valid fixture").expect("valid fixture");
    // The lost semantic file never serves; the head's lexical companion does.
    assert!(semantic_active(&s, &f.kb).is_none());
    let desired = s
        .index_status_get(
            &s.owner(),
            kb_client::types::KbRef {
                kb_id: f.kb.clone(),
            },
        )
        .expect("valid fixture")
        .desired_generation_id
        .expect("valid fixture");
    assert_ne!(desired, job.generation_id);
    let pin = s.generation_snapshot(&desired).expect("valid fixture");
    assert_eq!(
        pin.profile,
        f.store
            .generation_snapshot(&job.generation_id)
            .expect("valid fixture")
            .profile
    );
    f.settle_companion(&desired).await;
    let build = s
        .build_generation(
            s.claim_generation(&desired, Duration::from_secs(60))
                .expect("valid fixture"),
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("valid fixture");
    assert!(s.activate_built(build).expect("valid fixture"));
    assert_eq!(
        before,
        f.db()
            .query_row("SELECT count(*) FROM operation_intents", [], |r| r
                .get::<_, i64>(0))
            .expect("valid fixture")
    );
    assert_eq!(
        record.head_sha,
        s.kb(&f.kb)
            .expect("valid fixture")
            .expect("valid fixture")
            .head_sha
    );
}
#[tokio::test]
async fn child_crash_entry() {
    let Ok(root) = std::env::var("KB_INDEX_CRASH_ROOT") else {
        return;
    };
    let id =
        kb_client::types::KbId::parse(&std::env::var("KB_INDEX_CRASH_ID").expect("valid fixture"))
            .expect("valid fixture");
    let stage: BuildStage =
        serde_json::from_str(&std::env::var("KB_INDEX_CRASH_STAGE").expect("valid fixture"))
            .expect("valid fixture");
    let s = Store::open(std::path::Path::new(&root)).expect("valid fixture");
    let pause = |at| {
        if at == stage {
            writeln!(std::io::stdout(), "\nBARRIER").expect("valid fixture");
            std::io::stdout().flush().expect("valid fixture");
            std::thread::sleep(Duration::from_secs(60));
        }
        Ok(())
    };
    let built = s
        .build_generation(
            s.claim_generation(&id, Duration::from_secs(60))
                .expect("valid fixture"),
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |at| pause(at),
        )
        .await
        .expect("valid fixture");
    s.activate_built_observed(built, &mut |at| pause(at))
        .expect("valid fixture");
}
#[test]
fn kill_during_build_fsync_complete_and_activation_never_activates_partial() {
    use std::io::{BufRead, BufReader};
    for stage in [
        BuildStage::Rows,
        BuildStage::BeforeFsync,
        BuildStage::AfterFsync,
        BuildStage::BeforeComplete,
        BuildStage::BeforeActivate,
        BuildStage::BeforeActivationCas,
    ] {
        let f = Fixture::new(2);
        let job = f.set("profile-crash-0001");
        let mut child = ChildGuard::spawn(
            Command::new(std::env::current_exe().expect("valid fixture"))
                .args(["--exact", "child_crash_entry", "--nocapture"])
                .env("KB_INDEX_CRASH_ROOT", &f.root)
                .env("KB_INDEX_CRASH_ID", job.generation_id.as_str())
                .env(
                    "KB_INDEX_CRASH_STAGE",
                    serde_json::to_string(&stage).expect("valid fixture"),
                )
                .stdout(Stdio::piped()),
        )
        .expect("valid fixture");
        let stdout = child.stdout.take().expect("valid fixture");
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.expect("valid fixture") == "BARRIER" {
                    tx.send(()).expect("valid fixture");
                    break;
                }
            }
        });
        let barrier = rx.recv_timeout(Duration::from_secs(20));
        child.kill().expect("valid fixture");
        child.wait().expect("valid fixture");
        reader.join().expect("valid fixture");
        assert!(barrier.is_ok(), "barrier {stage:?}");
        let s = Store::open(&f.root).expect("valid fixture");
        drop(s.lock_write(&[]).expect("valid fixture"));
        let active = s
            .kb(&f.kb)
            .expect("valid fixture")
            .expect("valid fixture")
            .active_generation_id;
        // Every byte is written under the temp name; only a finalized,
        // fsynced file is linked to the final name (the temp is then gone).
        let published = !matches!(stage, BuildStage::Rows | BuildStage::BeforeFsync);
        assert_eq!(
            s.paths().index_file(&f.kb, &job.generation_id).exists(),
            published,
            "{stage:?}"
        );
        assert_eq!(
            s.paths()
                .index_temp_file(&f.kb, &job.generation_id)
                .exists(),
            !published,
            "{stage:?}"
        );
        if matches!(
            stage,
            BuildStage::BeforeActivate | BuildStage::BeforeActivationCas
        ) {
            let lease = s
                .lease_active_generation(&s.owner(), &f.kb)
                .expect("valid fixture");
            // The lease verified the single meta row, which is written last.
            assert_eq!(
                lease
                    .connection()
                    .query_row("SELECT count(*) FROM meta", [], |r| r.get::<_, i64>(0))
                    .expect("valid fixture"),
                1
            );
            assert_eq!(lease.meta().generation_id, lease.snapshot.id.as_str());
        } else {
            assert!(
                active.is_none_or(|id| s.generation_snapshot(&id).expect("s").is_lexical()),
                "{stage:?}"
            );
        }
        let state = s
            .index_status_get(
                &s.owner(),
                kb_client::types::KbRef {
                    kb_id: f.kb.clone(),
                },
            )
            .expect("valid fixture")
            .desired_state;
        // L-1: an attempt killed before COMPLETE is released for a retry.
        assert!(matches!(
            state,
            Some(kb_client::types::IndexState::Pending | kb_client::types::IndexState::Complete)
        ));
        if state == Some(kb_client::types::IndexState::Pending) {
            let a = s
                .claim_generation(&job.generation_id, Duration::from_secs(120))
                .expect("retry claim");
            let built = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(s.build_generation(
                    a,
                    async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
                    &mut |_| Ok(()),
                ))
                .expect("the retry discards the killed attempt's files and publishes");
            assert!(s.activate_built(built).expect("activate"), "{stage:?}");
        }
    }
}
#[test]
fn missing_durable_state_is_never_recreated() {
    let f = Fixture::new(2);
    let path = f.store.paths().state_db();
    let root = f.root.clone();
    drop(f.store);
    std::fs::remove_file(&path).expect("valid fixture");
    assert_eq!(
        Store::open(&root)
            .expect_err("still fails closed")
            .protocol_code(),
        kb_client::ErrorCode::RepairRequired
    );
    assert!(
        !path.exists(),
        "recovery must not recreate durable authority"
    );
}

#[tokio::test]
async fn missing_completed_candidate_is_rebuilt_without_losing_state() {
    let f = Fixture::new(2);
    let old = f.set("profile-candidate-first");
    assert!(
        f.store
            .activate_built(f.build(&old.generation_id).await)
            .expect("valid fixture")
    );
    let job = f.rebuild("profile-candidate-loss");
    drop(f.build(&job.generation_id).await);
    std::fs::remove_file(f.store.paths().index_file(&f.kb, &job.generation_id))
        .expect("valid fixture");
    let s = Store::open(&f.root).expect("valid fixture");
    let status = s
        .index_status_get(
            &s.owner(),
            kb_client::types::KbRef {
                kb_id: f.kb.clone(),
            },
        )
        .expect("valid fixture");
    assert_eq!(status.active_generation_id, Some(old.generation_id));
    assert_ne!(
        status.desired_generation_id.as_ref(),
        Some(&job.generation_id)
    );
    assert_eq!(
        status.desired_state,
        Some(kb_client::types::IndexState::Pending)
    );
}

#[tokio::test]
async fn cancelled_completion_child_entry() {
    let Ok(root) = std::env::var("KB_INDEX_CANCEL_ROOT") else {
        return;
    };
    let id =
        kb_client::types::KbId::parse(&std::env::var("KB_INDEX_CANCEL_ID").expect("fixture id"))
            .expect("id");
    let s = Store::open(std::path::Path::new(&root)).expect("child store");
    let a = s
        .claim_generation(&id, Duration::from_secs(900))
        .expect("claim");
    let cancel = a.cancellation();
    let _built = s
        .build_generation(
            a,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("complete file");
    cancel
        .cancel()
        .expect("durable cancellation acknowledgement");
    writeln!(std::io::stdout(), "\nCANCEL_DURABLE").expect("barrier");
    std::io::stdout().flush().expect("flush barrier");
    std::thread::sleep(Duration::from_secs(60));
}
#[test]
/// (a): a host cancellation acknowledged after durable COMPLETE, then a
/// process kill, ends that attempt only; the still-desired completion is
/// activated on restart under a fresh attempt.
fn accepted_cancel_after_complete_survives_process_kill() {
    use std::io::{BufRead, BufReader};
    let f = Fixture::new(2);
    let job = f.set("profile-cancel-crash");
    let mut child = ChildGuard::spawn(
        Command::new(std::env::current_exe().expect("test binary"))
            .args(["--exact", "cancelled_completion_child_entry", "--nocapture"])
            .env("KB_INDEX_CANCEL_ROOT", &f.root)
            .env("KB_INDEX_CANCEL_ID", job.generation_id.as_str())
            .stdout(Stdio::piped()),
    )
    .expect("child");
    let stdout = child.stdout.take().expect("stdout");
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.expect("line") == "CANCEL_DURABLE" {
                tx.send(()).expect("barrier");
                break;
            }
        }
    });
    let barrier = rx.recv_timeout(Duration::from_secs(120));
    child.kill().expect("kill");
    let killed = child.wait().expect("drain");
    reader.join().expect("reader drain");
    assert!(
        barrier.is_ok(),
        "child acknowledged cancellation before kill"
    );
    assert!(!killed.success(), "one actual process kill");
    let next = Store::open(&f.root).expect("restart");
    let status = next
        .index_status_get(
            &next.owner(),
            kb_client::types::KbRef {
                kb_id: f.kb.clone(),
            },
        )
        .expect("status");
    assert_eq!(status.active_generation_id, Some(job.generation_id.clone()));
    assert_eq!(
        status.desired_state,
        Some(kb_client::types::IndexState::Complete)
    );
}
