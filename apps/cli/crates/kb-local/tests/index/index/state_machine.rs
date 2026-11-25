//! The generation state machine and lexical companion dependencies.

use super::*;

/// The generation/attempt state machine (docs/embeddings.md, generations.rs):
/// every row of the transition table, driven through the real Store API.
#[tokio::test]
async fn generation_state_machine_walks_every_transition() {
    let f = Fixture::new(2);
    let state = |id: &KbId| -> String {
        f.db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .expect("state")
    };
    let active = || {
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id
    };
    let rebuild = |key: &str| {
        f.store.advance_clock_for_tests(3601); // hourly rebuild budget
        f.store
            .index_rebuild(
                &f.store.owner(),
                serde_json::from_value(json!({"kbId":f.kb,"idempotencyKey":key,"confirm":"RUN"}))
                    .expect("input"),
            )
            .expect("rebuild")
            .generation_id
    };
    let claim = |id: &KbId, window: Duration| f.store.claim_generation(id, window);
    let vectors = async |pin: &kb_local::generations::ProfileSnapshot, texts: &[String]| {
        Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
    };

    // scheduled -> PENDING; a semantic claim waits for its companion.
    let job = f.set_raw("state-machine-profile").generation_id;
    assert_eq!(state(&job), "PENDING");
    assert!(matches!(
        claim(&job, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    f.settle_companion(&job).await;
    let companion = active().expect("companion active");
    assert!(
        f.store
            .generation_snapshot(&companion)
            .expect("s")
            .is_lexical()
    );

    // BUILDING -> PENDING on a host cancellation (shutdown).
    let a = claim(&job, Duration::from_secs(60)).expect("claim");
    assert_eq!(state(&job), "BUILDING");
    a.cancel().expect("cancel");
    assert!(
        f.store
            .build_generation(a, vectors, &mut |_| Ok(()))
            .await
            .is_err()
    );
    assert_eq!(state(&job), "PENDING");

    // BUILDING -> PENDING when the owning process is gone (orphan), any number of times.
    for _ in 0..=kb_local::generations::MAX_STALLED_ATTEMPTS {
        drop(claim(&job, Duration::from_secs(60)).expect("claim"));
        drop(f.store.lock_write(&[]).expect("reconcile"));
        assert_eq!(state(&job), "PENDING");
    }

    // BUILDING -> PENDING on a no-progress watchdog; the third stall in a row -> FAILED.
    for stall in 1..=kb_local::generations::MAX_STALLED_ATTEMPTS {
        let a = claim(&job, Duration::ZERO).expect("claim");
        assert!(
            f.store
                .build_generation(a, vectors, &mut |_| Ok(()))
                .await
                .is_err()
        );
        let expected = if stall == kb_local::generations::MAX_STALLED_ATTEMPTS {
            "FAILED"
        } else {
            "PENDING"
        };
        assert_eq!(state(&job), expected, "stall {stall}");
    }

    // BUILDING -> FAILED on a build error.
    let failing = rebuild("state-machine-rebuild-01");
    let a = claim(&failing, Duration::from_secs(60)).expect("claim");
    assert!(
        f.store
            .build_generation(
                a,
                async |_, _| Err(StoreError::IndexUnavailable),
                &mut |_| Ok(())
            )
            .await
            .is_err()
    );
    assert_eq!(state(&failing), "FAILED");

    // BUILDING -> COMPLETE; a cancelled activation leaves it COMPLETE and
    // recovery activates it under a fresh attempt.
    let done = rebuild("state-machine-rebuild-02");
    let a = claim(&done, Duration::from_secs(60)).expect("claim");
    let cancel = a.cancellation();
    let built = f
        .store
        .build_generation(a, vectors, &mut |_| Ok(()))
        .await
        .expect("built");
    assert_eq!(state(&done), "COMPLETE");
    cancel.cancel().expect("cancel");
    assert!(!f.store.activate_built(built).expect("activation"));
    assert_eq!(state(&done), "COMPLETE");
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(active(), Some(done.clone()));

    // COMPLETE awaiting activation while newer desired work is scheduled: it
    // still outranks the active one (same head, newer epoch), so it is
    // kept and serves until the desired work does.
    let replaced = rebuild("state-machine-rebuild-03");
    let built = f.build(&replaced).await;
    let newer = rebuild("state-machine-rebuild-04");
    assert_eq!(state(&replaced), "COMPLETE");
    // (The budget clock advance expired this attempt: recovery activates it.)
    drop(built);
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(active(), Some(replaced.clone()));

    // PENDING -> SUPERSEDED by newer desired work.
    let newest = rebuild("state-machine-rebuild-05");
    assert_eq!(state(&newer), "SUPERSEDED");

    // COMPLETE -> active; the previous active one is retired by the next scheduling.
    assert!(
        f.store
            .activate_built(f.build(&newest).await)
            .expect("activate")
    );
    assert_eq!(active(), Some(newest.clone()));
    rebuild("state-machine-rebuild-06");
    assert_eq!(state(&done), "SUPERSEDED");
    assert_eq!(state(&companion), "SUPERSEDED");
    assert_eq!(active(), Some(newest.clone()));

    // Active older hybrid plus a new head: lexical@head is scheduled,
    // serves as soon as it completes, and keeps serving while semantic@head
    // fails.
    let head = Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .head_sha
            .expect("head"),
    )
    .expect("sha");
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: "state-machine-new-head".into(),
                changes: vec![kb_local::FileChange {
                    path: "new-head.md".into(),
                    content: Some(b"a new head".to_vec()),
                }],
            },
        )
        .expect("publication");
    let semantic = f.status().desired_generation_id.expect("desired");
    assert_eq!(active(), Some(newest.clone()));
    assert!(matches!(
        claim(&semantic, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    f.settle_companion(&semantic).await;
    let s = f.store.generation_snapshot(&semantic).expect("s");
    let covering: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2",
            (s.kb_id.as_str(), s.epoch - 1),
            |r| r.get(0),
        )
        .expect("companion");
    let covering = KbId::parse(&covering).expect("id");
    assert_eq!(state(&covering), "COMPLETE");
    assert_eq!(active(), Some(covering.clone()), "read-your-writes");
    let a = claim(&semantic, Duration::from_secs(60)).expect("claim");
    assert!(
        f.store
            .build_generation(
                a,
                async |_, _| Err(StoreError::IndexUnavailable),
                &mut |_| Ok(())
            )
            .await
            .is_err()
    );
    assert_eq!(state(&semantic), "FAILED");
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(active(), Some(covering));
}

/// Completion recovery walks the serve order (semantic@head,
/// lexical@head, newest first) and falls through a refused activation. Both
/// generations of the head are COMPLETE and unactivated, and the semantic
/// profile became unusable without a reschedule: the lexical one serves.
#[tokio::test]
async fn completion_recovery_falls_through_to_lexical_when_semantic_cannot_activate() {
    let f = Fixture::new(2);
    let job = f.set_raw("recovery-fallthrough-0001").generation_id;
    let s = f.store.generation_snapshot(&job).expect("snapshot");
    let companion: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2 AND state='PENDING'",
            (s.kb_id.as_str(), s.epoch - 1),
            |r| r.get(0),
        )
        .expect("companion");
    let companion = KbId::parse(&companion).expect("companion id");
    let state = |id: &KbId| -> String {
        f.db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .expect("state")
    };
    // The companion completes; its unfinished activation keeps the completion
    // permit, so recovery cannot take it over yet.
    let lexical = f
        .store
        .build_generation(
            f.store
                .claim_generation(&companion, Duration::from_secs(120))
                .expect("claim companion"),
            async |_, _| -> Result<Vec<Vec<f64>>, StoreError> {
                panic!("a lexical companion never embeds")
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("companion built");
    assert_eq!(state(&companion), "COMPLETE");
    // The semantic generation completes; its activation is cancelled.
    let a = f
        .store
        .claim_generation(&job, Duration::from_secs(120))
        .expect("claim semantic");
    let cancel = a.cancellation();
    let semantic = f
        .store
        .build_generation(
            a,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("semantic built");
    cancel.cancel().expect("cancel");
    assert!(!f.store.activate_built(semantic).expect("activation"));
    drop(lexical);
    assert_eq!(state(&job), "COMPLETE");
    assert_eq!(state(&companion), "COMPLETE");
    assert!(
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id
            .is_none()
    );
    // The semantic profile is unusable now (revoked, no reschedule yet).
    f.db()
        .execute(
            "UPDATE providers SET revoked=1 WHERE id=?1",
            [f.provider.as_str()],
        )
        .expect("revoke");
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id,
        Some(companion.clone())
    );
    // The refused semantic completion is not activated by a later pass either.
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id,
        Some(companion)
    );
    assert_ne!(state(&job), "BUILDING");
}

/// Dependency satisfaction is a completion question, not attempt
/// liveness. An unbuilt companion attempt that expired and was dropped never
/// unblocks the semantic claim on the same open store (no recovery in
/// between): the claim, holding the KB permit, requeues the abandoned
/// companion and defers until it really completes.
#[tokio::test]
async fn an_expired_companion_attempt_never_satisfies_the_semantic_dependency() {
    for indexing in [false, true] {
        expired_companion_attempt(indexing).await;
    }
}
/// `indexing`: the abandoned companion had reached INDEXING (any in-progress
/// state of the state machine requeues the same way).
async fn expired_companion_attempt(indexing: bool) {
    let f = Fixture::new(2);
    let job = f.set_raw("expired-companion-0001").generation_id;
    let s = f.store.generation_snapshot(&job).expect("snapshot");
    let companion: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2 AND state='PENDING'",
            (s.kb_id.as_str(), s.epoch - 1),
            |r| r.get(0),
        )
        .expect("companion");
    let companion = KbId::parse(&companion).expect("id");
    let state = |id: &KbId| -> String {
        f.db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .expect("state")
    };
    let abandoned = f
        .store
        .claim_generation(&companion, Duration::from_secs(1))
        .expect("claim companion");
    assert_eq!(state(&companion), "BUILDING");
    if indexing {
        f.db()
            .execute(
                "UPDATE index_generations SET state='INDEXING' WHERE id=?1",
                [companion.as_str()],
            )
            .expect("indexing");
    }
    f.store.advance_clock_for_tests(2);
    drop(abandoned);
    assert!(matches!(
        f.store.claim_generation(&job, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    assert_eq!(state(&companion), "PENDING", "requeued under the KB permit");
    assert_eq!(state(&job), "PENDING");
    f.settle_companion(&job).await;
    assert_eq!(state(&companion), "COMPLETE");
    assert!(
        f.store
            .claim_generation(&job, Duration::from_secs(60))
            .is_ok()
    );
}
