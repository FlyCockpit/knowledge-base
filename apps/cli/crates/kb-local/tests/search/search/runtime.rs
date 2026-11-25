//! Built-in runtime upgrades and abandoned probe recovery.

use super::*;

/// A CLI upgrade that changes the native embedding runtime: launching on
/// the store re-pins every built-in KB to the new runtime and schedules its
/// re-embedding (once); until the new generation activates, the old one
/// serves keyword search only (`EMBEDDING_MODEL_CHANGED`), so its document
/// vectors never meet query vectors of another runtime. A `kb` of the
/// previous version still serving the store neither re-pins back nor fails
/// the new build.
#[tokio::test]
async fn runtime_upgrade_reembeds_builtin_kbs_and_serves_keywords_meanwhile() {
    let old_runtime: &'static str = Box::leak(format!("sha256:{}", "0".repeat(64)).into());
    let current = kb_local::qwen::runtime_identity();
    assert_ne!(old_runtime, current);
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
        "runtime-upgrade-publish-01",
    );
    f.db()
        .execute("UPDATE builtin_model SET enabled=1 WHERE id=1", [])
        .expect("enable");
    // What the previous CLI left: a built-in KB embedded under its runtime.
    f.store.set_runtime_identity_for_tests(old_runtime);
    let revision = f.store.model_state().expect("state").epoch + 1;
    let job = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","revision":revision,"idempotencyKey":"runtime-upgrade-profile-01","confirm":"RUN"})).expect("input")).expect("profile");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("old runtime generation")
    );
    let old = f
        .store
        .generation_snapshot(&job.generation_id)
        .expect("old")
        .profile
        .expect("hybrid");
    assert_eq!(
        old.builtin.as_ref().expect("builtin").runtime_identity,
        old_runtime
    );
    assert_eq!(f.status().rebuild_pending, None);

    f.store.set_runtime_identity_for_tests(current);
    // A `kb` of the previous version keeps serving this store meanwhile.
    let previous =
        kb_local::Store::reopen(f.store.paths(), f.store.store_uuid()).expect("old session");
    previous.set_runtime_identity_for_tests(old_runtime);
    // Internal reopens and locks never reconcile; only a launch does.
    let internal = kb_local::Store::reopen(f.store.paths(), f.store.store_uuid()).expect("reopen");
    drop(internal.lock_write(&[]).expect("lock"));
    assert_eq!(
        f.status().desired_generation_id,
        Some(job.generation_id.clone())
    );

    // The upgraded CLI launches while another writer holds the store: the
    // open cannot reconcile, so the launch handle still owes it ...
    let held = internal.lock_write(&[]).expect("writer");
    let upgraded = kb_local::Store::open(&f.root).expect("upgraded launch");
    assert!(upgraded.runtime_reconcile_pending());
    drop(held);
    assert_eq!(
        f.status().desired_generation_id,
        Some(job.generation_id.clone())
    );
    // ... and already counts the KB as due ...
    assert_eq!(
        upgraded.builtin_runtime_stale_kbs().expect("progress"),
        vec![f.kb.clone()]
    );
    // ... until a reopened handle sharing it (`kb mcp` builders) runs it
    // under its next store lock, for the launch handle too.
    let builder = kb_local::Store::reopen(f.store.paths(), f.store.store_uuid()).expect("builder");
    assert!(!builder.runtime_reconcile_pending());
    builder.share_runtime_reconcile(&upgraded.runtime_reconcile());
    assert!(builder.runtime_reconcile_pending());
    drop(builder.lock_write(&[]).expect("lock"));
    assert!(!builder.runtime_reconcile_pending());
    assert!(!upgraded.runtime_reconcile_pending());
    assert_eq!(
        upgraded.builtin_runtime_stale_kbs().expect("progress"),
        vec![f.kb.clone()]
    );
    let status = f.status();
    assert_eq!(
        status.rebuild_pending,
        Some(RebuildPendingReason::EmbeddingModelChanged)
    );
    assert_eq!(status.active_generation_id, Some(job.generation_id.clone()));
    let desired = status.desired_generation_id.expect("re-embed scheduled");
    assert_ne!(desired, job.generation_id);
    let pin = f
        .store
        .generation_snapshot(&desired)
        .expect("desired")
        .profile
        .expect("hybrid");
    assert_eq!(
        pin.builtin.as_ref().expect("builtin").runtime_identity,
        current
    );
    assert_ne!(pin.fingerprint, old.fingerprint);
    assert_eq!(pin.revision, old.revision);
    // Idempotent: another launch schedules nothing more.
    drop(kb_local::Store::open(&f.root).expect("relaunch"));
    assert_eq!(f.status().desired_generation_id, Some(desired.clone()));
    // The old session neither re-pins back nor fails the new runtime's
    // build: it leaves it pending for a process that runs that runtime.
    f.settle_companion(&desired).await;
    drop(previous.lock_write(&[]).expect("old session lock"));
    assert!(matches!(
        previous.claim_generation(&desired, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    let status = f.status();
    assert_eq!(status.desired_generation_id, Some(desired.clone()));
    assert_eq!(status.desired_state, Some(IndexState::Pending));
    // A lexical companion is not the re-embedding.
    assert!(
        !upgraded
            .builtin_runtime_reembedded(&f.kb)
            .expect("progress")
    );
    assert_eq!(
        upgraded.builtin_runtime_stale_kbs().expect("progress"),
        vec![f.kb.clone()]
    );

    // Meanwhile: keyword search, no query embedding, the pending notice.
    let out = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({"query":"alpha"})),
            &SearchControl::default(),
            async |_, _| panic!("old document vectors never meet new query vectors"),
            &mut |_| Ok(()),
        )
        .await
        .expect("keyword search");
    assert_eq!(out.results[0].mode, SearchMode::Lexical);
    assert!(matches!(
        &out.index_notices[0],
        IndexNotice::RebuildPending(n) if n.detail == RebuildPendingReason::EmbeddingModelChanged
    ));

    // The re-embedded generation activates: hybrid again, nothing pending.
    assert!(
        f.store
            .activate_built(f.build(&desired).await)
            .expect("re-embedded")
    );
    assert!(
        upgraded
            .builtin_runtime_reembedded(&f.kb)
            .expect("progress")
    );
    assert!(
        upgraded
            .builtin_runtime_stale_kbs()
            .expect("progress")
            .is_empty()
    );
    let status = f.status();
    assert_eq!(status.active_generation_id, Some(desired));
    assert_eq!(status.rebuild_pending, None);
    // (No model file in this fixture's cache: hybrid serving with the real
    // worker is the `qwen_model` lane's upgrade test.)
    let out = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({"query":"alpha"})),
            &SearchControl::default(),
            async |p, _| Ok(vec![1.; p.dimensions]),
            &mut |_| Ok(()),
        )
        .await
        .expect("search");
    assert!(
        !out.index_notices
            .iter()
            .any(|n| matches!(n, IndexNotice::RebuildPending(_)))
    );
    no_leases(&f);
}

/// Settling an abandoned model probe (any process, any open) refreshes the
/// built-in pins to the new configuration epoch but keeps the runtime each
/// pin names: a `kb` of another runtime than the store's latest launch
/// never re-pins those KBs to its own runtime (nor supersedes that launch's
/// re-embedding) on the way.
#[tokio::test]
async fn abandoned_probe_recovery_keeps_each_pins_runtime() {
    let foreign: &'static str = Box::leak(format!("sha256:{}", "f".repeat(64)).into());
    assert_ne!(foreign, kb_local::qwen::runtime_identity());
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
        "probe-recovery-publish-01",
    );
    f.db()
        .execute("UPDATE builtin_model SET enabled=1 WHERE id=1", [])
        .expect("enable");
    // The store's latest launch runs another runtime and pinned the KB.
    f.store.set_runtime_identity_for_tests(foreign);
    let revision = f.store.model_state().expect("state").epoch + 1;
    f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","revision":revision,"idempotencyKey":"probe-recovery-profile-01","confirm":"RUN"})).expect("input")).expect("profile");
    let pin = || -> (String, i64) {
        f.db()
            .query_row(
                "SELECT json_extract(profile_json,'$.builtin.runtimeIdentity'),json_extract(profile_json,'$.builtin.epoch') FROM kbs WHERE id=?1",
                [f.kb.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("pin")
    };
    let (_, before) = pin();
    // A reload probe whose prober died.
    let db = f.db();
    db.execute("UPDATE builtin_model SET reloading=1 WHERE id=1", [])
        .expect("reloading");
    db.execute(
        "INSERT INTO model_probe(id,attempt,base_epoch,model_id,context_tokens,slot) SELECT 1,'abandoned-probe',epoch,model_id,context_tokens,1-slot FROM builtin_model WHERE id=1",
        [],
    )
    .expect("probe");
    // A process of this binary's runtime opens the store and settles it.
    let other = kb_local::Store::reopen(f.store.paths(), f.store.store_uuid()).expect("reopen");
    let probes: i64 = db
        .query_row("SELECT count(*) FROM model_probe", [], |r| r.get(0))
        .expect("probes");
    assert_eq!(probes, 0, "the abandoned probe was settled");
    let live = other.model_state().expect("state");
    assert!(live.enabled && !live.reloading);
    assert_eq!(pin(), (foreign.to_string(), live.epoch));
    assert!(live.epoch > before);
    // The launch's work stays pinned to its runtime.
    let desired = f.status().desired_generation_id.expect("desired");
    let snapshot = f
        .store
        .generation_snapshot(&desired)
        .expect("desired")
        .profile
        .expect("hybrid");
    assert_eq!(
        snapshot.builtin.as_ref().expect("builtin").runtime_identity,
        foreign
    );
    no_leases(&f);
}
