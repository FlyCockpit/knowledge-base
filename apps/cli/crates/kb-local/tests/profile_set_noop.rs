//! R3-L12 review: re-attaching a profile is a no-op only when a SEMANTIC
//! generation of exactly that profile (provider, revision, fingerprint) of the
//! head at the desired epoch is active (`CURRENT`) or in flight (`PENDING`).
//! A current or building lexical generation never counts (server parity,
//! `sameSemanticWork`), and a no-op spends no rebuild budget.
#[path = "support/index_fixture.rs"]
mod index_fixture;
use index_fixture::*;
use kb_client::types::*;
use serde_json::json;
use std::time::Duration;

fn set(f: &Fixture, key: &str) -> ProfileSetOutput {
    f.store
        .embedding_profile_set(
            &f.store.owner(),
            serde_json::from_value(json!({"kbId": f.kb, "providerId": f.provider,
                "revision": 1, "idempotencyKey": key, "confirm": "RUN"}))
            .expect("input"),
        )
        .expect("profile set")
}
fn generations(f: &Fixture) -> i64 {
    f.db()
        .query_row("SELECT count(*) FROM index_generations", [], |r| r.get(0))
        .expect("count")
}
fn provider_state(f: &Fixture, state: &str) {
    f.db()
        .execute(
            "UPDATE provider_revisions SET state=?1 WHERE provider_id=?2",
            (state, f.provider.as_str()),
        )
        .expect("provider state");
}

#[tokio::test]
async fn reattach_is_a_noop_only_for_the_same_semantic_work() {
    let f = Fixture::new(2);
    let first = set(&f, "noop-set-0000000001");
    assert_eq!(first.state, ProfileSetState::Pending);
    // In flight: the same generation, nothing new scheduled.
    let before = generations(&f);
    let again = set(&f, "noop-set-0000000002");
    assert_eq!(
        (again.state, &again.generation_id, &again.job_id),
        (
            ProfileSetState::Pending,
            &first.generation_id,
            &first.job_id
        )
    );
    assert_eq!(generations(&f), before);
    // Active: CURRENT.
    let built = f.build(&first.generation_id).await;
    assert!(f.store.activate_built(built).expect("activate"));
    let current = set(&f, "noop-set-0000000003");
    assert_eq!(
        (current.state, &current.generation_id),
        (ProfileSetState::Current, &first.generation_id)
    );
    assert_eq!(generations(&f), before);
    // A replay returns the recorded no-op.
    assert_eq!(set(&f, "noop-set-0000000003"), current);
    // No-ops spend no budget: far more re-attaches than the hourly limit.
    for i in 0..(kb_local::limits::LOCAL_REBUILDS_PER_HOUR_PER_KB + 2) {
        assert_eq!(
            set(&f, &format!("noop-budget-{i:08}")).state,
            ProfileSetState::Current
        );
    }
}

/// The reviewer's recovery case: the provider was unusable at a publication,
/// so only lexical@head was scheduled. While that lexical build runs, and once
/// it is current, re-attaching the restored provider schedules semantic work.
#[tokio::test]
async fn lexical_current_or_building_never_satisfies_a_reattach() {
    let f = Fixture::new(2);
    let first = set(&f, "lexical-set-00000001");
    let built = f.build(&first.generation_id).await;
    assert!(f.store.activate_built(built).expect("activate"));
    // The probe starts failing; a publication schedules lexical@head only.
    provider_state(&f, "FAILED");
    let head = f
        .store
        .kb(&f.kb)
        .expect("kb")
        .expect("kb")
        .head_sha
        .expect("head");
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: Sha::parse(&head).expect("sha"),
                idempotency_key: "lexical-publication-01".into(),
                changes: vec![kb_local::FileChange {
                    path: "n.md".into(),
                    content: Some(b"# new\n".to_vec()),
                }],
            },
        )
        .expect("publication");
    let lexical = f
        .store
        .pending_generation(None)
        .expect("scan")
        .expect("lexical");
    assert!(
        f.store
            .generation_snapshot(&lexical)
            .expect("snapshot")
            .is_lexical()
    );
    let claim = f
        .store
        .claim_generation(&lexical, Duration::from_secs(120))
        .expect("claim");
    // Lexical BUILDING: the restored provider's re-attach schedules semantic work.
    provider_state(&f, "READY");
    let building = set(&f, "lexical-set-00000002");
    assert_eq!(building.state, ProfileSetState::Pending);
    assert_ne!(building.generation_id, lexical);
    assert!(
        !f.store
            .generation_snapshot(&building.generation_id)
            .expect("snapshot")
            .is_lexical()
    );
    drop(claim);
    // Lexical CURRENT (and no semantic generation of the head): not a no-op either.
    let g = Fixture::new(2);
    let only = set(&g, "lexical-set-00000003");
    g.settle_companion(&only.generation_id).await;
    let claim = g
        .store
        .claim_generation(&only.generation_id, Duration::from_secs(120))
        .expect("claim");
    assert!(
        g.store
            .build_generation(
                claim,
                async |_, _| Err(kb_local::StoreError::EmbeddingFailed),
                &mut |_| Ok(())
            )
            .await
            .is_err()
    );
    let active = g
        .store
        .kb(&g.kb)
        .expect("kb")
        .expect("kb")
        .active_generation_id;
    assert!(
        active.is_some_and(|id| g
            .store
            .generation_snapshot(&id)
            .expect("snapshot")
            .is_lexical()),
        "the lexical companion serves"
    );
    let retry = set(&g, "lexical-set-00000004");
    assert_eq!(retry.state, ProfileSetState::Pending);
    assert_ne!(retry.generation_id, only.generation_id);
}
