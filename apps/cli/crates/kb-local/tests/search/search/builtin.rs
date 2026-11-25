//! The built-in model: alias switches, worker start failure and explicit lexical mode.

use super::*;

/// `builtin` without a revision resolves the CURRENT configuration
/// after A -> B -> A (never the newest or a stale one); the pin is A's.
#[tokio::test]
async fn builtin_alias_follows_a_switch_back_to_an_earlier_configuration() {
    use kb_local::qwen::{ModelConfiguration, ModelRuntime};
    let f = Fixture::new(1024);
    let host = model_host::seeded(&f.root.with_extension("model"), Duration::from_secs(5));
    let runtime = ModelRuntime::new(&f.store, host.clone()).expect("valid fixture");
    let configure = |context_tokens: u32| {
        runtime
            .configure(
                &f.store,
                &f.store.owner(),
                ModelConfiguration {
                    model_id: "qwen3-embedding-0.6b-q8_0",
                    context_tokens,
                    acknowledge_memory_warning: true,
                    available_bytes: Some(32 << 30),
                    timeout: Duration::from_secs(60),
                },
            )
            .expect("valid fixture")
    };
    let attach = |key: &str| {
        let job = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","confirm":"RUN","idempotencyKey":key})).expect("valid fixture")).expect("attached without a revision");
        f.store
            .generation_snapshot(&job.generation_id)
            .expect("snapshot")
            .profile
            .expect("pinned profile")
    };
    configure(1024);
    let a = attach("builtin-switch-a-0001");
    configure(2048);
    let b = attach("builtin-switch-b-0001");
    assert_ne!(a.fingerprint, b.fingerprint);
    configure(1024);
    let back = attach("builtin-switch-a-0002");
    assert_eq!(back.fingerprint, a.fingerprint, "A's configuration again");
    assert_eq!(
        back.revision,
        f.store.model_state().expect("state").epoch + 1,
        "the current revision"
    );
    // Naming another revision is a reasoned CONFLICT on `/revision`.
    let stale = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","revision":back.revision + 1,"confirm":"RUN","idempotencyKey":"builtin-stale-rev-0001"})).expect("valid fixture")).expect_err("not the current revision");
    assert_eq!(stale.protocol_code(), ErrorCode::Conflict);
    assert_eq!(
        stale.protocol_details(),
        json!({"reason": "REVISION_NOT_CURRENT", "field": "/revision"})
    );
}

#[tokio::test]
async fn d9_builtin_search_falls_back_to_lexical_when_the_worker_cannot_start() {
    use kb_local::{
        index::IndexEmbedder,
        qwen::{ModelConfiguration, ModelRuntime},
    };
    let f = Fixture::new(1024);
    let host = model_host::seeded(&f.root.with_extension("model"), Duration::from_secs(60));
    let runtime = ModelRuntime::new(&f.store, host.clone()).expect("valid fixture");
    runtime
        .configure(
            &f.store,
            &f.store.owner(),
            ModelConfiguration {
                model_id: "qwen3-embedding-0.6b-q8_0",
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(32 << 30),
                timeout: Duration::from_secs(60),
            },
        )
        .expect("valid fixture");
    // `builtin` needs no revision.
    let job = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","confirm":"RUN","idempotencyKey":"search-builtin-fallback"})).expect("valid fixture")).expect("valid fixture");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("valid fixture")
    );
    // The worker exits (idle/crash) and can no longer start.
    let pid = runtime
        .embed(
            &f.store,
            "hello",
            kb_local::qwen::Purpose::Query,
            Duration::from_secs(5),
        )
        .expect("warm")
        .pid;
    #[cfg(unix)]
    {
        // A fresh adapter has no pooled connection: a stopped worker stalls
        // the handshake, which must share the same target bound as inference.
        struct StoppedWorker<'a>(&'a kb_local::qwen::ModelHost, u32, bool);
        impl Drop for StoppedWorker<'_> {
            fn drop(&mut self) {
                if self.2 {
                    let _ = std::process::Command::new("kill")
                        .args(["-CONT", &self.1.to_string()])
                        .status();
                    model_host::kill_worker(self.0, self.1);
                }
            }
        }
        let fresh = ModelRuntime::new(&f.store, host.clone()).expect("fresh adapter");
        let mut stopped = StoppedWorker(&host, pid, true);
        assert!(
            std::process::Command::new("kill")
                .args(["-STOP", &pid.to_string()])
                .status()
                .expect("stop fixture worker")
                .success()
        );
        let started = std::time::Instant::now();
        let out = f
            .store
            .search(
                &f.store.owner(),
                input(&f, json!({"query":"generation"})),
                IndexEmbedder::Builtin(&fresh),
                &SearchControl::default(),
            )
            .await;
        let elapsed = started.elapsed();
        assert!(
            std::process::Command::new("kill")
                .args(["-CONT", &pid.to_string()])
                .status()
                .expect("resume fixture worker")
                .success()
        );
        let out = out.expect("stalled handshake degrades");
        assert!(
            elapsed >= kb_local::breaker::QUERY_EMBEDDING_DEADLINE
                && elapsed < kb_local::breaker::QUERY_EMBEDDING_DEADLINE + Duration::from_secs(5),
            "{elapsed:?}"
        );
        assert!(!out.results.is_empty());
        assert!(
            out.results
                .iter()
                .all(|hit| hit.mode == SearchMode::Lexical)
        );
        let started = std::time::Instant::now();
        let next = f
            .store
            .search(
                &f.store.owner(),
                input(&f, json!({"query":"generation"})),
                IndexEmbedder::Builtin(&fresh),
                &SearchControl::default(),
            )
            .await
            .expect("open breaker");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(
            next.results
                .iter()
                .all(|hit| hit.mode == SearchMode::Lexical)
        );
        f.store.reset_query_breakers_for_tests();
        let healthy = f
            .store
            .search(
                &f.store.owner(),
                input(&f, json!({"query":"generation"})),
                IndexEmbedder::Builtin(&fresh),
                &SearchControl::default(),
            )
            .await
            .expect("healthy worker after resume");
        assert!(
            healthy
                .results
                .iter()
                .all(|hit| hit.mode == SearchMode::Hybrid)
        );
        stopped.2 = false; // The existing failure-to-restart lane below owns cleanup.
    }
    std::fs::write(model_host::hook(&host, "model-test-worker-fail"), b"x").expect("hook");
    // Every platform: the worker really is gone before the restart fails.
    model_host::kill_worker(&host, pid);
    let started = std::time::Instant::now();
    let out = f
        .store
        .search(
            &f.store.owner(),
            input(&f, json!({"query":"generation"})),
            IndexEmbedder::Builtin(&runtime),
            &SearchControl::default(),
        )
        .await
        .expect("lexical fallback, not an error");
    assert!(started.elapsed() < Duration::from_secs(30));
    assert!(!out.results.is_empty());
    assert!(out.results.iter().all(|r| r.mode == SearchMode::Lexical));
    assert!(
        out.index_notices.iter().any(|n| matches!(
            n,
            IndexNotice::LexicalOnly(n) if n.detail == LexicalOnlyReason::EmbeddingProfileUnavailable
        )),
        "{:?}",
        out.index_notices
    );
}

#[tokio::test]
async fn host_builtin_query_and_explicit_identity_lexical_mode() {
    use kb_local::{
        index::IndexEmbedder,
        qwen::{ModelConfiguration, ModelRuntime},
    };
    let f = Fixture::new(1024);
    let runtime = ModelRuntime::new(
        &f.store,
        model_host::seeded(&f.root.with_extension("model"), Duration::from_secs(5)),
    )
    .expect("valid fixture");
    runtime
        .configure(
            &f.store,
            &f.store.owner(),
            ModelConfiguration {
                model_id: "qwen3-embedding-0.6b-q8_0",
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(32 << 30),
                timeout: Duration::from_secs(60),
            },
        )
        .expect("valid fixture");
    let job=f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","revision":f.store.model_state().expect("valid fixture").epoch+1,"confirm":"RUN","idempotencyKey":"search-builtin-profile"})).expect("valid fixture")).expect("valid fixture");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("valid fixture")
    );
    let out = f
        .store
        .search(
            &f.store.owner(),
            input(&f, json!({"query":"generation"})),
            IndexEmbedder::Builtin(&runtime),
            &SearchControl::default(),
        )
        .await
        .expect("valid fixture");
    assert_eq!(out.results[0].mode, SearchMode::Hybrid);
    check::<KnowledgeSearch>(&out);
    // Queue behind actual native IO, revoke while queued, then release it.
    // A dispatched oversized query fails with EMBEDDING_INPUT_TOO_LONG,
    // so NOT_FOUND distinguishes admission from a later response check.
    let p = reader(&f);
    std::thread::scope(|scope| {
        let native = scope.spawn(|| {
            let store = kb_local::Store::open(&f.root).expect("valid fixture");
            runtime
                .embed(
                    &store,
                    "park",
                    kb_local::qwen::Purpose::Document,
                    Duration::from_secs(20),
                )
                .expect("valid fixture");
        });
        model_admission::wait_for_marker(
            &runtime.host().runtime_dir().join("model-test-started"),
            || {
                native
                    .is_finished()
                    .then(|| "native embed thread completed".into())
            },
        )
        .expect("native request must be admitted");
        // Query pinning is a separate phase, measured after native admission.
        let until = std::time::Instant::now() + Duration::from_secs(10);
        let root = f.root.clone();
        let release = runtime.host().runtime_dir().join("model-test-release");
        let actor = p.id().to_owned();
        let actor_key = f.store.owner().actor_key();
        let prior_charges = f
            .db()
            .query_row(
                "SELECT count(*) FROM query_charges WHERE actor_key=?1",
                [&actor_key],
                |r| r.get::<_, i64>(0),
            )
            .expect("existing user charges");
        let revoker = scope.spawn(move || {
            let db = rusqlite::Connection::open(root.join("state.sqlite")).expect("valid fixture");
            while db
                .query_row(
                    "SELECT count(*) FROM query_charges WHERE actor_key=?1",
                    [&actor_key],
                    |r| r.get::<_, i64>(0),
                )
                .expect("valid fixture")
                <= prior_charges
            {
                assert!(std::time::Instant::now() < until, "query did not pin");
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::sleep(Duration::from_secs(1));
            db.execute(
                "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
                [actor],
            )
            .expect("valid fixture");
            std::fs::write(&release, b"release").expect("valid fixture");
        });
        let query_root = f.root.clone();
        let query = input(&f, json!({"query":"é".repeat(600)}));
        let runtime = &runtime;
        let queued = scope.spawn(move || {
            let store = kb_local::Store::open(&query_root).expect("valid fixture");
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("valid fixture")
                .block_on(store.search(
                    &p,
                    query,
                    IndexEmbedder::Builtin(runtime),
                    &SearchControl::default(),
                ))
        });
        let out = queued.join().expect("valid fixture");
        assert_eq!(out.unwrap_err().protocol_code(), ErrorCode::NotFound);
        revoker.join().expect("valid fixture");
        native.join().expect("valid fixture");
    });
    no_leases(&f);
    runtime
        .configure(
            &f.store,
            &f.store.owner(),
            ModelConfiguration {
                model_id: "embeddinggemma-2-q8_0",
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(32 << 30),
                timeout: Duration::from_secs(60),
            },
        )
        .expect("valid fixture");
    let out = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({"query":"generation"})),
            &SearchControl::default(),
            async |_, _| panic!("identity mismatch must never dispatch"),
            &mut |_| Ok(()),
        )
        .await
        .expect("valid fixture");
    assert_eq!(out.results[0].mode, SearchMode::Lexical);
    // The lexical arm alone ran; its first hit is the normalized maximum.
    assert_eq!(out.results[0].score, 1.);
    assert!(matches!(
        &out.index_notices[0],
        IndexNotice::RebuildPending(n) if n.detail == RebuildPendingReason::EmbeddingModelChanged
    ));
    no_leases(&f);
    drop(runtime);
}
