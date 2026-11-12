//! Review regressions at the actual store, file, and recovery boundaries.
#[path = "support/index_fixture.rs"]
mod support;
use kb_client::{ErrorCode, types::*};
use kb_local::{Store, StoreError};
use std::time::Duration;
use support::*;
fn zero_disk(_: &kb_local::StorePaths, _: &std::path::Path) -> Result<u64, StoreError> {
    Ok(0)
}
fn kb_ref(f: &Fixture) -> KbRef {
    KbRef {
        kb_id: f.kb.clone(),
    }
}
#[tokio::test]
async fn queued_writer_rechecks_disk_and_preserves_active() {
    let f = Fixture::new(2);
    let first = f.set("profile-disk-first");
    assert!(
        f.store
            .activate_built(f.build(&first.generation_id).await)
            .expect("activate")
    );
    let job = f.rebuild("rebuild-disk-second");
    let attempt = f
        .store
        .claim_generation(&job.generation_id, Duration::from_secs(60))
        .expect("claim");
    f.store.set_disk_meter_for_tests(zero_disk);
    let result = f
        .store
        .build_generation(
            attempt,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await;
    assert_eq!(
        result
            .err()
            .expect("writer must reject low disk")
            .protocol_code(),
        ErrorCode::QuotaExceeded
    );
    assert!(
        !f.store
            .paths()
            .index_file(&f.kb, &job.generation_id)
            .exists()
    );
    assert_eq!(f.status().active_generation_id, Some(first.generation_id));
}
#[tokio::test]
async fn repair_blocks_profile_replay_and_read_lease() {
    let f = Fixture::new(2);
    let job = f.set("profile-repair-replay");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("activate")
    );
    let rebuild = serde_json::from_value(
        serde_json::json!({"kbId":f.kb,"idempotencyKey":"rebuild-repair-replay","confirm":"RUN"}),
    )
    .expect("input");
    f.store
        .index_rebuild(&f.store.owner(), rebuild)
        .expect("rebuild");
    f.db()
        .execute(
            "UPDATE kbs SET state='REPAIR_REQUIRED' WHERE id=?1",
            [f.kb.as_str()],
        )
        .expect("mark repair");
    assert_eq!(
        f.store
            .embedding_profile_get(&f.store.owner(), kb_ref(&f))
            .expect_err("repair gate")
            .protocol_code(),
        ErrorCode::RepairRequired
    );
    assert_eq!(
        f.store
            .lease_active_generation(&f.store.owner(), &f.kb)
            .err()
            .expect("lease repair gate")
            .protocol_code(),
        ErrorCode::RepairRequired
    );
    for (profile, key) in [
        (true, "profile-repair-replay"),
        (false, "rebuild-repair-replay"),
    ] {
        let result = if profile {
            f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(serde_json::json!({"kbId":f.kb,"providerId":f.provider,"revision":1,"idempotencyKey":key,"confirm":"RUN"})).expect("input")).map(|_| ())
        } else {
            f.store
                .index_rebuild(
                    &f.store.owner(),
                    serde_json::from_value(
                        serde_json::json!({"kbId":f.kb,"idempotencyKey":key,"confirm":"RUN"}),
                    )
                    .expect("input"),
                )
                .map(|_| ())
        };
        assert_eq!(
            result.expect_err("replay repair gate").protocol_code(),
            ErrorCode::RepairRequired
        );
    }
}
#[tokio::test]
async fn busy_startup_recovers_complete_on_same_handle_read() {
    let f = Fixture::new(2);
    let job = f.set("profile-deferred-complete");
    drop(f.build(&job.generation_id).await);
    // Raw OS fence avoids the normal lock admission's recovery work.
    let fence = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(f.store.paths().root().join("locks/store.lock"))
        .expect("fence");
    fence.lock().expect("hold fence");
    let second = Store::open(&f.root).expect("deferred open");
    assert!(semantic_active(&second, &f.kb).is_none());
    drop(fence);
    assert_eq!(
        second
            .index_status_get(&second.owner(), kb_ref(&f))
            .expect("read admission")
            .active_generation_id,
        Some(job.generation_id)
    );
}
#[tokio::test]
/// (a) attempt vs generation: a host cancellation after durable COMPLETE
/// ends the attempt, never still-desired work; reopening activates it.
async fn cancelled_complete_is_recovered_after_reopen_while_still_desired() {
    let f = Fixture::new(2);
    let job = f.set("profile-cancel-complete");
    let attempt = f
        .store
        .claim_generation(&job.generation_id, Duration::from_secs(60))
        .expect("claim");
    let cancel = attempt.cancellation();
    let built = f
        .store
        .build_generation(
            attempt,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    cancel.cancel().expect("durable cancellation");
    drop(built);
    let second = Store::open(&f.root).expect("reopen");
    assert_eq!(
        second
            .index_status_get(&second.owner(), kb_ref(&f))
            .expect("status")
            .active_generation_id,
        Some(job.generation_id)
    );
}
#[test]
fn low_disk_before_claim_has_no_writer_or_attempt_effect() {
    let f = Fixture::new(2);
    let job = f.set("profile-disk-claim");
    f.store.set_disk_meter_for_tests(zero_disk);
    assert_eq!(
        f.store
            .claim_generation(&job.generation_id, Duration::from_secs(60))
            .err()
            .expect("claim rejects")
            .protocol_code(),
        ErrorCode::QuotaExceeded
    );
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
    assert!(
        !f.store
            .paths()
            .index_file(&f.kb, &job.generation_id)
            .exists()
    );
}
#[tokio::test]
async fn disk_changes_between_batches_roll_back_and_release_reservation() {
    let f = Fixture::new(2000);
    let first = f.set("profile-disk-batches");
    assert!(
        f.store
            .activate_built(f.build(&first.generation_id).await)
            .expect("activate")
    );
    let head = Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .head_sha
            .expect("head"),
    )
    .expect("sha");
    let published = f
        .store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: "disk-large-publication".into(),
                changes: vec![kb_local::FileChange {
                    path: "many.md".into(),
                    content: Some("word ".repeat(22_000).into_bytes()),
                }],
            },
        )
        .expect("main publication auto-enqueues");
    let _ = published;
    let job = f.status().desired_generation_id.expect("automatic desired");
    // The new head's lexical companion serves as soon as it completes.
    f.settle_companion(&job).await;
    let serving = f.status().active_generation_id;
    assert_ne!(serving, Some(first.generation_id.clone()));
    let mut calls = 0;
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job, Duration::from_secs(120))
                .expect("claim"),
            async |pin, texts| {
                calls += 1;
                if calls == 2 {
                    f.store.set_disk_meter_for_tests(zero_disk);
                }
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await;
    assert_eq!(calls, 2, "reject before a third dispatch");
    assert_eq!(
        result.err().expect("disk rejects").protocol_code(),
        ErrorCode::QuotaExceeded
    );
    // semantic@head failed: the lexical companion keeps serving the head.
    let covering = f.status().active_generation_id.expect("covering");
    assert_eq!(Some(covering.clone()), serving);
    assert!(
        f.store
            .generation_snapshot(&covering)
            .expect("snapshot")
            .is_lexical()
    );
    assert_eq!(
        f.db()
            .query_row(
                "SELECT reserved_bytes FROM index_generations WHERE id=?1",
                [job.as_str()],
                |r| r.get::<_, i64>(0)
            )
            .expect("ledger"),
        0
    );
    let file = rusqlite::Connection::open(f.store.paths().index_temp_file(&f.kb, &job))
        .expect("private file");
    assert_eq!(
        file.query_row("SELECT count(*) FROM chunks", [], |r| r.get::<_, i64>(0))
            .expect("rollback"),
        0
    );
}
fn constrained_disk(_: &kb_local::StorePaths, _: &std::path::Path) -> Result<u64, StoreError> {
    Ok(kb_local::limits::FREE_DISK_FLOOR_BYTES + 45 * 1024 * 1024)
}
#[tokio::test]
async fn concurrent_builders_share_durable_disk_reservations() {
    let f = Fixture::new(2);
    let second = f
        .store
        .create_kb(
            &f.store.owner(),
            kb_local::CreateKbRequest {
                name: "Second".into(),
                slug: "second".into(),
                description: "Concurrent index reservation".into(),
                idempotency_key: "create-disk-second".into(),
            },
        )
        .expect("second KB")
        .kb_id;
    let a = f.set("profile-reservation-a");
    let b=f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(serde_json::json!({"kbId":second,"providerId":f.provider,"revision":1,"idempotencyKey":"profile-reservation-b","confirm":"RUN"})).expect("input")).expect("profile");
    f.settle_companion(&b.generation_id).await;
    let other = Store::open(&f.root).expect("second handle");
    f.store.set_disk_meter_for_tests(constrained_disk);
    other.set_disk_meter_for_tests(constrained_disk);
    let mut rejected = false;
    let built = f
        .store
        .build_generation(
            f.store
                .claim_generation(&a.generation_id, Duration::from_secs(120))
                .expect("claim a"),
            async |pin, texts| {
                let pending: i64 = f
                    .db()
                    .query_row(
                        "SELECT reserved_bytes-allocated_bytes FROM index_generations WHERE id=?1",
                        [a.generation_id.as_str()],
                        |r| r.get(0),
                    )
                    .expect("pending ledger");
                assert!(pending > 30 * 1024 * 1024);
                let result = other
                    .build_generation(
                        other
                            .claim_generation(&b.generation_id, Duration::from_secs(60))
                            .expect("claim b"),
                        async |_, _| panic!("unreserved inference"),
                        &mut |_| Ok(()),
                    )
                    .await;
                assert_eq!(
                    result
                        .err()
                        .expect("combined reservation rejects")
                        .protocol_code(),
                    ErrorCode::QuotaExceeded
                );
                rejected = true;
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("legitimate first build");
    assert!(rejected);
    assert!(f.store.activate_built(built).expect("first activates"));
    assert!(!other.paths().index_file(&second, &b.generation_id).exists());
    assert_eq!(
        f.db()
            .query_row(
                "SELECT sum(reserved_bytes) FROM index_generations",
                [],
                |r| r.get::<_, i64>(0)
            )
            .expect("released promises"),
        0
    );
}
#[tokio::test]
async fn actual_ref_divergence_blocks_read_replay_claim_and_activation() {
    let f = Fixture::new(2);
    let job = f.set("profile-ref-gate");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("activate")
    );
    std::fs::remove_file(f.store.paths().repo_dir(&f.kb).join("refs/heads/main"))
        .expect("disposable fixture ref edit");
    assert_eq!(
        f.store
            .embedding_profile_get(&f.store.owner(), kb_ref(&f))
            .expect_err("actual-ref gate")
            .protocol_code(),
        ErrorCode::RepairRequired
    );
    assert_eq!(
        f.store
            .lease_active_generation(&f.store.owner(), &f.kb)
            .err()
            .expect("lease gate")
            .protocol_code(),
        ErrorCode::RepairRequired
    );
    assert_eq!(f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(serde_json::json!({"kbId":f.kb,"providerId":f.provider,"revision":1,"idempotencyKey":"profile-ref-gate","confirm":"RUN"})).expect("input")).expect_err("replay gate").protocol_code(),ErrorCode::RepairRequired);
    assert_eq!(
        f.store
            .claim_generation(&job.generation_id, Duration::from_secs(60))
            .err()
            .expect("claim gate")
            .protocol_code(),
        ErrorCode::RepairRequired
    );
    let f = Fixture::new(2);
    let job = f.set("profile-late-ref-gate");
    let built = f.build(&job.generation_id).await;
    std::fs::remove_file(f.store.paths().repo_dir(&f.kb).join("refs/heads/main"))
        .expect("fixture ref edit");
    assert_eq!(
        f.store
            .activate_built(built)
            .expect_err("late activation gate")
            .protocol_code(),
        ErrorCode::RepairRequired
    );
    assert!(semantic_active(&f.store, &f.kb).is_none());
}
#[tokio::test]
async fn completion_recovery_transfers_attempt_and_ignores_old_cancellation() {
    let f = Fixture::new(2);
    let job = f.set("profile-recover-owner");
    let attempt = f
        .store
        .claim_generation(&job.generation_id, Duration::from_secs(60))
        .expect("claim");
    let cancel = attempt.cancellation();
    let built = f
        .store
        .build_generation(
            attempt,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    let old: String = f
        .db()
        .query_row(
            "SELECT attempt FROM index_generations WHERE id=?1",
            [job.generation_id.as_str()],
            |r| r.get(0),
        )
        .expect("attempt");
    let live = Store::open(&f.root).expect("parallel open");
    assert!(
        semantic_active(&live, &f.kb).is_none(),
        "live capability owns completion"
    );
    drop(built);
    drop(live.try_lock_write(&[]).expect("nonblocking recovery"));
    assert_eq!(
        live.index_status_get(&live.owner(), kb_ref(&f))
            .expect("status")
            .active_generation_id,
        Some(job.generation_id.clone())
    );
    let new: String = f
        .db()
        .query_row(
            "SELECT attempt FROM index_generations WHERE id=?1",
            [job.generation_id.as_str()],
            |r| r.get(0),
        )
        .expect("successor attempt");
    assert_ne!(old, new);
    cancel.cancel().expect("durable cancellation");
    drop(live.lock_write(&[]).expect("readmission"));
    assert_eq!(
        live.index_status_get(&live.owner(), kb_ref(&f))
            .expect("status")
            .active_generation_id,
        Some(job.generation_id)
    );
    assert_eq!(f.status().active_state, Some(IndexState::Complete));
}
#[tokio::test]
async fn stale_capability_cannot_terminalize_active_or_successor_attempt() {
    for transferred in [false, true] {
        let f = Fixture::new(2);
        let job = f.set("profile-stale-capability");
        let a = f
            .store
            .claim_generation(&job.generation_id, Duration::from_secs(60))
            .expect("claim");
        let cancel = a.cancellation();
        let built = f
            .store
            .build_generation(
                a,
                async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
                &mut |_| Ok(()),
            )
            .await
            .expect("build");
        // Fault seam reproduces the durable post-recovery state while retaining
        // a stale capability. Production recovery also requires its OS drain.
        f.db()
            .execute(
                "UPDATE kbs SET active_generation_id=?2 WHERE id=?1",
                (f.kb.as_str(), job.generation_id.as_str()),
            )
            .expect("recovered active pointer");
        if transferred {
            f.db().execute("UPDATE index_generations SET attempt='00000000-0000-4000-8000-000000000099' WHERE id=?1",[job.generation_id.as_str()]).expect("transferred owner");
        }
        cancel.cancel().expect("durable cancellation");
        assert!(!f.store.activate_built(built).expect("stale activation"));
        assert_eq!(f.status().active_state, Some(IndexState::Complete));
    }
}

#[tokio::test]
async fn pre_admission_expiry_never_calls_embedder_or_creates_index() {
    let f = Fixture::new(2);
    let job = f.set("profile-pre-admission-expiry");
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::ZERO)
                .expect("claim"),
            async |_, _| panic!("expired dispatch"),
            &mut |_| Ok(()),
        )
        .await;
    assert_eq!(
        result.err().expect("expired").protocol_code(),
        ErrorCode::DeadlineExceeded
    );
    assert!(
        !f.store
            .paths()
            .index_file(&f.kb, &job.generation_id)
            .exists()
    );
    // An expired watchdog is a stall, retried (L-2), never a permanent failure at once.
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
}
#[tokio::test]
async fn recovery_activates_expired_keeps_revoked_and_supersedes_replaced_completions() {
    for invalid in ["expired", "revoked", "superseded"] {
        let f = Fixture::new(2);
        let job = f.set("profile-invalid-recovery");
        let built = f.build(&job.generation_id).await;
        match invalid {
            "expired" => {
                f.db()
                    .execute(
                        "UPDATE index_generations SET attempt_until_ms=0 WHERE id=?1",
                        [job.generation_id.as_str()],
                    )
                    .expect("expiry");
            }
            "revoked" => {
                f.db()
                    .execute(
                        "UPDATE providers SET revoked=1 WHERE id=?1",
                        [f.provider.as_str()],
                    )
                    .expect("revocation");
            }
            _ => {
                f.rebuild("rebuild-successor-recovery");
            }
        }
        drop(built);
        let second = Store::open(&f.root).expect("recovery");
        // An expired attempt is recovered under a fresh one, as is a
        // completion newer desired work did not outrank; a profile that can
        // no longer embed leaves it COMPLETE (not served semantically).
        let active = second
            .index_status_get(&second.owner(), kb_ref(&f))
            .expect("status")
            .active_generation_id;
        let state: String = f
            .db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [job.generation_id.as_str()],
                |r| r.get(0),
            )
            .expect("state");
        match invalid {
            "expired" => assert_eq!(active, Some(job.generation_id.clone()), "{invalid}"),
            "revoked" => {
                assert_ne!(active, Some(job.generation_id.clone()), "{invalid}");
                assert_eq!(state, "COMPLETE", "{invalid}");
            }
            _ => {
                // Newer desired work does not supersede a completion that
                // still outranks what serves: recovery activates it.
                assert_eq!(active, Some(job.generation_id.clone()), "{invalid}");
                assert_eq!(state, "COMPLETE", "{invalid}");
            }
        }
    }
}

#[tokio::test]
async fn new_kb_permit_releases_drained_terminal_capacity_without_false_rejection() {
    let f = Fixture::new(2);
    let old = f.set("profile-orphan-capacity");
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&old.generation_id, Duration::from_secs(60))
                .expect("claim"),
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |stage| {
                if stage == kb_local::index::BuildStage::Rows {
                    Err(StoreError::IndexUnavailable)
                } else {
                    Ok(())
                }
            },
        )
        .await;
    assert!(result.is_err());
    let next = f.rebuild("rebuild-orphan-capacity");
    // Fault state: the writer drained but its release could not acquire the
    // state fence. The next claim holds KB before reconcile can try that KB.
    let allocated = std::fs::metadata(f.store.paths().index_temp_file(&f.kb, &old.generation_id))
        .expect("retained failed file")
        .len();
    f.db()
        .execute(
            "UPDATE index_generations SET reserved_bytes=?2,allocated_bytes=?3 WHERE id=?1",
            (
                old.generation_id.as_str(),
                80 * 1024 * 1024,
                allocated as i64,
            ),
        )
        .expect("abandoned promise");
    f.store.set_disk_meter_for_tests(constrained_disk);
    let attempt = f
        .store
        .claim_generation(&next.generation_id, Duration::from_secs(60))
        .expect("drained capacity released before admission");
    assert_eq!(
        f.db()
            .query_row(
                "SELECT reserved_bytes FROM index_generations WHERE id=?1",
                [old.generation_id.as_str()],
                |r| r.get::<_, i64>(0)
            )
            .expect("old promise"),
        0
    );
    let built = f
        .store
        .build_generation(
            attempt,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("legitimate successor build");
    assert!(f.store.activate_built(built).expect("activation"));
    assert!(
        f.store
            .paths()
            .index_temp_file(&f.kb, &old.generation_id)
            .exists(),
        "physical failed bytes remain retained and metered"
    );
}

/// ROOT A: a COMPLETE generation's cancellation intent belongs to its
/// completion permit until activation; the sweep must not delete it while a
/// built capability waits, nor before recovery activates it after a reopen.
#[tokio::test]
async fn sweep_keeps_the_cancellation_intent_of_completions_awaiting_activation() {
    let f = Fixture::new(2);
    let job = f.set("profile-sweep-built");
    let intent = f
        .store
        .paths()
        .index_dir(&f.kb)
        .join(format!("{}.sqlite.cancel", job.generation_id));
    let built = f.build(&job.generation_id).await;
    f.store.sweep_disposable(None).expect("sweep");
    assert!(intent.exists(), "held completion keeps its intent");
    assert!(f.store.activate_built(built).expect("activate"));
    // R3-L10: active, nothing reads the intent any more (a recovered
    // activation recreates it): it goes instead of piling up.
    f.store.sweep_disposable(None).expect("sweep");
    #[cfg(unix)]
    assert!(!intent.exists());

    // Built, then the capability is dropped (a deferred activation or a
    // crash): the sweep runs before completion recovery on reopen.
    let next = f.rebuild("profile-sweep-deferred");
    let intent = f
        .store
        .paths()
        .index_dir(&f.kb)
        .join(format!("{}.sqlite.cancel", next.generation_id));
    drop(f.build(&next.generation_id).await);
    f.store.sweep_disposable(None).expect("sweep");
    assert!(intent.exists(), "recovery still owns the intent");
    // Nor does retention reclaim a still-desired completion, however old.
    f.store
        .sweep_generations(now_ms() + 30 * 86_400_000)
        .expect("retention");
    assert!(intent.exists(), "retention keeps the desired completion");
    let reopened = Store::open(&f.root).expect("reopen recovers the completion");
    assert_eq!(
        reopened
            .index_status_get(&reopened.owner(), kb_ref(&f))
            .expect("status")
            .active_generation_id,
        Some(next.generation_id.clone())
    );
}

/// #3: the scratch scan is bounded but progresses: more than a page of
/// retained cancellation intents (COMPLETE generations) sorted before an
/// orphan's scratch cannot keep the orphan from being removed when the
/// host carries the cursor from pass to pass.
#[test]
fn retained_entries_never_pin_later_scratch_out_of_the_bounded_scan() {
    let f = Fixture::new(2);
    let job = f.set("profile-sweep-progress");
    let db = f.db();
    let dir = f.store.paths().index_dir(&f.kb);
    for n in 0..250 {
        let id = format!("aaaaaaaaaaaaaaaaaaaa{n:04}");
        db.execute(
            "INSERT INTO index_generations(id,kb_id,epoch,state,created_at,commit_sha,snapshot_json,job_id,document_count,chunk_count) SELECT ?1,kb_id,epoch+1000+?2,'COMPLETE',created_at,commit_sha,snapshot_json,printf('00000000-0000-4000-8000-%012d',?2),0,0 FROM index_generations WHERE id=?3",
            rusqlite::params![id, n, job.generation_id.as_str()],
        )
        .expect("retained generation");
        std::fs::write(dir.join(format!("{id}.sqlite.cancel")), b"0").expect("intent");
    }
    let orphan = dir.join("zzzzzzzzzzzzzzzzzzzzzzzz.tmp");
    std::fs::write(&orphan, b"scratch").expect("orphan scratch");
    let mut cursor = None;
    let mut passes = 0;
    while orphan.exists() {
        passes += 1;
        assert!(passes <= 3, "the scan must reach the orphan");
        cursor = f.store.sweep_disposable(cursor.as_ref()).expect("sweep").1;
    }
    assert_eq!(
        passes, 2,
        "one full page of retained entries, then the orphan"
    );
    for n in 0..250 {
        assert!(
            dir.join(format!("aaaaaaaaaaaaaaaaaaaa{n:04}.sqlite.cancel"))
                .exists(),
            "retained intents stay"
        );
    }
}

/// An intent already lost (a crash or an earlier sweep) does not wedge
/// completion recovery: the reset recreates it as "not cancelled".
#[tokio::test]
async fn completion_recovery_recreates_a_lost_cancellation_intent() {
    let f = Fixture::new(2);
    let job = f.set("profile-lost-intent");
    drop(f.build(&job.generation_id).await);
    std::fs::remove_file(
        f.store
            .paths()
            .index_dir(&f.kb)
            .join(format!("{}.sqlite.cancel", job.generation_id)),
    )
    .expect("lose the intent");
    let reopened = Store::open(&f.root).expect("reopen");
    assert_eq!(
        reopened
            .index_status_get(&reopened.owner(), kb_ref(&f))
            .expect("status")
            .active_generation_id,
        Some(job.generation_id)
    );
}

#[test]
fn l21_l22_sweep_removes_dead_scratch_and_tombstoned_kb_data() {
    let f = Fixture::new(2);
    let job = f.set("profile-sweep-scratch");
    let id = job.generation_id;
    let dir = f.store.paths().index_dir(&f.kb);
    let scratch = |suffix: &str| dir.join(format!("{id}{suffix}"));
    let seed = || {
        for suffix in [".tmp", ".tmp-journal", ".sqlite.cancel"] {
            std::fs::write(scratch(suffix), b"0").expect("scratch");
        }
    };
    seed();
    // A generation being built keeps its scratch.
    f.db()
        .execute(
            "UPDATE index_generations SET state='BUILDING' WHERE id=?1",
            [id.as_str()],
        )
        .expect("fixture state");
    f.store.sweep_disposable(None).expect("sweep");
    assert!(scratch(".tmp").exists() && scratch(".sqlite.cancel").exists());
    // A completed one loses its build scratch but keeps the intent its
    // activation reads.
    f.db()
        .execute(
            "UPDATE index_generations SET state='COMPLETE',chunk_count=0,document_count=0 WHERE id=?1",
            [id.as_str()],
        )
        .expect("fixture state");
    f.store.sweep_disposable(None).expect("sweep");
    assert!(!scratch(".tmp").exists() && scratch(".sqlite.cancel").exists());
    seed();
    // A settled one (cancelled, failed, superseded) loses it at once.
    f.db()
        .execute(
            "UPDATE index_generations SET state='FAILED' WHERE id=?1",
            [id.as_str()],
        )
        .expect("fixture state");
    f.store.sweep_disposable(None).expect("sweep");
    assert!(!scratch(".tmp").exists() && !scratch(".tmp-journal").exists());
    #[cfg(unix)]
    assert!(!scratch(".sqlite.cancel").exists());
    // A tombstoned KB's repository and derived indexes are purged; its
    // registry row (and receipts) stay.
    let repo = f.store.paths().repo_dir(&f.kb);
    assert!(repo.exists());
    f.db()
        .execute(
            "UPDATE kbs SET state='TOMBSTONED' WHERE id=?1",
            [f.kb.as_str()],
        )
        .expect("fixture state");
    f.store.sweep_disposable(None).expect("sweep");
    assert!(!repo.exists() && !dir.exists());
    assert_eq!(
        f.db()
            .query_row("SELECT state FROM kbs WHERE id=?1", [f.kb.as_str()], |r| {
                r.get::<_, String>(0)
            })
            .expect("row"),
        "TOMBSTONED"
    );
}

#[test]
fn retention_and_tombstone_purge_never_recreate_deleted_kb_directories() {
    // Both maintenance orders, and both a fresh and an expired generation.
    for purge_first in [true, false] {
        for expired in [true, false] {
            let f = Fixture::new(2);
            let job = f.set("profile-combined-sweep");
            let dir = f.store.paths().index_dir(&f.kb);
            let repo = f.store.paths().repo_dir(&f.kb);
            let now = now_ms();
            let finished = if expired { now - 8 * 86400000 } else { now };
            f.db()
                .execute(
                    "UPDATE index_generations SET state='FAILED',finished_ms=?2 WHERE kb_id=?1",
                    (f.kb.as_str(), finished as i64),
                )
                .expect("terminal generations");
            f.db()
                .execute(
                    "UPDATE kbs SET state='TOMBSTONED',active_generation_id=NULL WHERE id=?1",
                    [f.kb.as_str()],
                )
                .expect("tombstone");
            for suffix in [".sqlite", ".tmp", ".tmp-journal", ".sqlite.cancel"] {
                std::fs::write(
                    dir.join(format!("{}{suffix}", job.generation_id)),
                    b"scratch",
                )
                .expect("scratch");
            }
            if !purge_first {
                f.store.sweep_generations(now).expect("retention first");
            }
            f.store.sweep_disposable(None).expect("purge");
            assert!(!dir.exists() && !repo.exists());
            f.store
                .sweep_generations(now)
                .expect("retention after purge");
            f.store.sweep_disposable(None).expect("repeat purge");
            assert!(
                !dir.exists() && !repo.exists(),
                "maintenance must only delete"
            );
            assert_eq!(
                f.db()
                    .query_row(
                        "SELECT count(*) FROM index_generations WHERE kb_id=?1 AND reclaimed=0",
                        [f.kb.as_str()],
                        |r| r.get::<_, i64>(0)
                    )
                    .expect("registry"),
                0,
                "purged files are reclaimed regardless of age"
            );
            assert_eq!(f.store.sweep_generations(now).expect("repeat retention"), 0);
        }
    }
}

#[test]
fn retention_does_not_create_an_absent_live_kbs_index_directory() {
    let f = Fixture::new(2);
    let job = f.set("profile-missing-retention");
    let dir = f.store.paths().index_dir(&f.kb);
    let now = now_ms();
    f.db()
        .execute(
            "UPDATE index_generations SET state='FAILED',finished_ms=?2 WHERE id=?1",
            (job.generation_id.as_str(), (now - 8 * 86400000) as i64),
        )
        .expect("expired");
    std::fs::remove_dir_all(&dir).expect("simulate missing derived data");
    assert_eq!(
        f.store
            .sweep_generations(now)
            .expect("reclaim missing files"),
        1
    );
    assert!(!dir.exists());
    assert!(f.store.paths().repo_dir(&f.kb).exists());
}

/// ROOT 5: retained history (thousands of tombstones) is paged in SQL: live
/// KBs are found past it, cleanup visits bounded pages with a progressing
/// cursor and never revisits a completed purge.
#[test]
fn large_retained_history_is_paged_and_purges_complete_once() {
    let f = Fixture::new(2);
    let db = f.db();
    let mk = |n: usize| -> String {
        // 24 lowercase alphanumerics that sort before the fixture's KB.
        let digits = format!("{n:06}");
        format!("000000000000000000{digits}")
    };
    for n in 0..1100 {
        db.execute(
            "INSERT INTO kbs (id,name,slug,description,state,created_at) VALUES (?1,'old',?2,'retained history','TOMBSTONED','2026-01-01T00:00:00Z')",
            (mk(n), format!("old-{n}")),
        )
        .expect("history row");
    }
    // Live KBs are still named (SQL-filtered), past all retained history.
    assert_eq!(
        f.store.active_kb_ids(6).expect("active"),
        vec![f.kb.clone()]
    );
    // Twelve tombstones still hold data on disk.
    for n in 0..12 {
        std::fs::create_dir_all(
            f.store
                .paths()
                .root()
                .join("repos")
                .join(format!("kb_{}.git", mk(n))),
        )
        .expect("repo");
    }
    let mut after = None;
    let mut pages = 0;
    loop {
        let (_, next) = f.store.sweep_disposable(after.as_ref()).expect("page");
        pages += 1;
        assert!(pages <= 1100 / 5 + 2, "the cursor progresses");
        match next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    for n in 0..12 {
        assert!(
            !f.store
                .paths()
                .root()
                .join("repos")
                .join(format!("kb_{}.git", mk(n)))
                .exists()
        );
    }
    let purged: i64 = db
        .query_row(
            "SELECT count(*) FROM kbs WHERE state='TOMBSTONED' AND data_purged=1",
            [],
            |r| r.get(0),
        )
        .expect("count");
    assert_eq!(purged, 1100, "every visited tombstone is marked done");
    // A later pass has nothing left to visit.
    assert_eq!(f.store.sweep_disposable(None).expect("pass").1, None);
}

/// R3-L10: permit files of generations that can never complete or be read
/// again, and of purged KBs, are swept instead of accumulating; those still
/// needed stay.
#[cfg(unix)]
#[tokio::test]
async fn sweep_removes_permits_nothing_can_need_again() {
    let f = Fixture::new(2);
    let first = f.set("profile-sweep-permits");
    assert!(
        f.store
            .activate_built(f.build(&first.generation_id).await)
            .expect("activate")
    );
    let second = f.rebuild("rebuild-sweep-permits");
    assert!(
        f.store
            .activate_built(f.build(&second.generation_id).await)
            .expect("activate")
    );
    let locks = f.store.paths().locks_dir();
    let permit = |kind: &str, id: &KbId| locks.join(format!("index-{kind}-{id}.lock"));
    for kind in ["completion", "read"] {
        for id in [&first.generation_id, &second.generation_id] {
            std::fs::write(permit(kind, id), b"").expect("permit");
        }
    }
    let state = |id: &KbId| -> String {
        f.db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .expect("state")
    };
    // Activation settles outranked completions immediately, without a later
    // publication or a fixture state change. Idle retention can clean them.
    assert_eq!(state(&first.generation_id), "SUPERSEDED");
    let old_cancel = f
        .store
        .paths()
        .index_dir(&f.kb)
        .join(format!("{}.sqlite.cancel", first.generation_id));
    assert!(old_cancel.exists());
    let mut cursor = None;
    loop {
        cursor = f.store.sweep_disposable(cursor.as_ref()).expect("sweep").1;
        if cursor.is_none() {
            break;
        }
    }
    // Superseded: its cancellation and completion permit go; leases may still read it.
    assert!(!old_cancel.exists());
    assert!(!permit("completion", &first.generation_id).exists());
    assert!(permit("read", &first.generation_id).exists());
    // Active: both stay.
    assert!(permit("completion", &second.generation_id).exists());
    assert!(permit("read", &second.generation_id).exists());
    // A failed generation needs neither.
    f.db()
        .execute(
            "UPDATE index_generations SET state='FAILED' WHERE id=?1",
            [first.generation_id.as_str()],
        )
        .expect("fixture state");
    f.store.sweep_disposable(None).expect("sweep");
    assert!(!permit("read", &first.generation_id).exists());
    // A purged KB's lock and build permit go with its data.
    let kb_lock = locks.join(format!("kb_{}.lock", f.kb));
    let build = locks.join(format!("index-build-{}.lock", f.kb));
    std::fs::write(&build, b"").expect("permit");
    assert!(kb_lock.exists());
    f.db()
        .execute(
            "UPDATE kbs SET state='TOMBSTONED',active_generation_id=NULL WHERE id=?1",
            [f.kb.as_str()],
        )
        .expect("fixture state");
    f.store.sweep_disposable(None).expect("purge");
    f.store.sweep_disposable(None).expect("leftovers");
    assert!(!kb_lock.exists() && !build.exists());
}
