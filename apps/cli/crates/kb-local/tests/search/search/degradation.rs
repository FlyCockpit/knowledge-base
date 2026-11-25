//! Degradation: classified embedding failures, lost and corrupt active indexes, removed models.

use super::*;

/// Closed classification, error kind × outcome: only a failed embedder
/// (`EmbeddingFailed`) or an embedding timeout degrades to the keyword arm;
/// every lease, request, authorization, storage or SQL failure out of the
/// embedding step propagates unchanged.
#[tokio::test]
async fn only_classified_embedding_failures_degrade_to_lexical() {
    let f = Fixture::new(2);
    ready(&f).await;
    type Case = (&'static str, fn() -> StoreError, Option<ErrorCode>);
    let cases: Vec<Case> = vec![
        ("embedder failed", || StoreError::EmbeddingFailed, None),
        // The model rejects the query as longer than its context.
        (
            "query too long for the model",
            || StoreError::OperationAborted(ErrorCode::EmbeddingInputTooLong),
            None,
        ),
        (
            "embedding call timeout",
            || StoreError::EmbeddingTimeout,
            None,
        ),
        // A shorter admission/lock deadline while the search budget is live.
        (
            "admission deadline",
            || StoreError::DeadlineExceeded,
            Some(ErrorCode::DeadlineExceeded),
        ),
        (
            "generic index unavailable (lease/request)",
            || StoreError::IndexUnavailable,
            Some(ErrorCode::IndexUnavailable),
        ),
        (
            "authorization",
            || StoreError::NotFound,
            Some(ErrorCode::NotFound),
        ),
        (
            "forbidden",
            || StoreError::Forbidden,
            Some(ErrorCode::Forbidden),
        ),
        (
            "storage",
            || StoreError::StorageUnavailable("disk".into()),
            Some(ErrorCode::StorageUnavailable),
        ),
        (
            "sql",
            || StoreError::Sqlite(rusqlite::Error::InvalidQuery),
            // Fails the search (redacted to INDEX_UNAVAILABLE), never lexical.
            Some(ErrorCode::IndexUnavailable),
        ),
        (
            "invalid cursor",
            || StoreError::InvalidCursor,
            Some(ErrorCode::InvalidCursor),
        ),
    ];
    for (name, error, expected) in cases {
        f.store.reset_query_breakers_for_tests();
        let out = f
            .store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({})),
                &SearchControl::default(),
                async |_, _| {
                    if name == "admission deadline" {
                        // Exercise the actual shorter lock deadline, with the
                        // search and embedding budgets still live.
                        let held = std::fs::OpenOptions::new()
                            .read(true)
                            .write(true)
                            .open(f.root.join("locks/store.lock"))
                            .expect("lock file");
                        held.lock().expect("hold admission");
                        let error = f.store.lock_write(&[]).expect_err("admission expires");
                        drop(held);
                        Err(error)
                    } else {
                        Err(error())
                    }
                },
                &mut |_| Ok(()),
            )
            .await;
        match expected {
            None => {
                let out = out.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert!(
                    out.results.iter().all(|h| h.mode == SearchMode::Lexical),
                    "{name}"
                );
            }
            Some(code) => assert_eq!(
                out.expect_err(name).protocol_code(),
                code,
                "{name} must propagate"
            ),
        }
        no_leases(&f);
        if name == "embedding call timeout" {
            // The trusted host seam may use a shorter transport timer. Only
            // the shared boundary's full target timeout can open the breaker.
            let next = f.query(json!({})).await.expect("healthy next query");
            assert_eq!(
                next.results.first().expect("vector result").mode,
                SearchMode::Hybrid
            );
        }
    }
}

/// An unreadable active index file heals like a deleted one: the
/// generation fails (`INDEX_FILE_LOST`), the KB is rescheduled (its lexical
/// companion first) and search serves again once that completes. Both a
/// damaged header (found by every lock pass) and damaged pages (found when
/// the file is opened or read) heal.
#[tokio::test]
async fn a_corrupted_active_index_is_lost_and_rebuilt() {
    for damage in ["header", "pages", "interior-page", "meta", "vectors"] {
        let f = Fixture::new(2);
        publish(
            &f,
            vec![("index.md", Some("# Index\n\nalpha body".into()))],
            "corrupt-index-publish-0001",
        );
        let active = ready(&f).await;
        assert!(f.query(json!({})).await.is_ok());
        let path = f.store.paths().index_file(&f.kb, &active);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .expect("writable");
        }
        if damage == "meta" || damage == "vectors" {
            // Intact SQLite, broken index contract: metadata, or stored
            // vectors of the wrong width.
            rusqlite::Connection::open(&path)
                .expect("file")
                .execute_batch(if damage == "meta" {
                    "UPDATE meta SET host_snapshot='{}'"
                } else {
                    "UPDATE chunk_int8 SET e=substr(e,1,1); UPDATE chunk_bits SET b=x'0000'"
                })
                .expect("damage");
        } else {
            let mut bytes = std::fs::read(&path).expect("index file");
            match damage {
                "header" => bytes[..4096].fill(0),
                "interior-page" => {
                    // Corrupt an allocated page the vector query must read,
                    // rather than an arbitrary midpoint that may belong to
                    // an unused hash table. The header and meta remain valid.
                    let page: i64 = rusqlite::Connection::open(&path)
                        .expect("index")
                        .query_row(
                            "SELECT rootpage FROM sqlite_schema WHERE name='chunk_int8'",
                            [],
                            |r| r.get(0),
                        )
                        .expect("vector page");
                    assert!(page > 1);
                    let offset = usize::try_from(page - 1).expect("page number") * 4096;
                    bytes[offset..offset + 4096].fill(0);
                }
                _ => bytes[4096..].fill(0xA5),
            }
            std::fs::write(&path, &bytes).expect("damage");
        }
        // The very first request, including damage discovered while reading,
        // re-admits once and serves the retained lexical companion.
        let out = f
            .query(json!({}))
            .await
            .unwrap_or_else(|e| panic!("{damage}: companion serves: {e}"));
        assert_ne!(out.generation_id.as_str(), active.as_str(), "{damage}");
        assert!(!out.results.is_empty(), "{damage}: lexical hits survive");
        assert!(
            out.results
                .iter()
                .all(|hit| hit.mode == SearchMode::Lexical),
            "{damage}"
        );
        let (state, code): (String, Option<String>) = f
            .db()
            .query_row(
                "SELECT state,error_code FROM index_generations WHERE id=?1",
                [active.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("generation");
        assert_eq!(
            (state.as_str(), code.as_deref()),
            ("FAILED", Some("INDEX_FILE_LOST")),
            "{damage}"
        );
        let status = f.status();
        assert_ne!(
            status.active_generation_id.as_ref().map(|id| id.as_str()),
            Some(active.as_str()),
            "{damage}"
        );
        assert_ne!(status.freshness, Freshness::Current, "{damage}");
        // Rescheduled: the companion serves keywords, the semantic build
        // brings hybrid back.
        let desired = status.desired_generation_id.expect("rescheduled");
        f.settle_companion(&desired).await;
        let out = f.query(json!({})).await.expect("serves again");
        assert!(!out.results.is_empty(), "{damage}");
        no_leases(&f);
    }
}

/// A failure that proves nothing about the file (here it cannot
/// be read for a moment) never retires a healthy index.
#[cfg(unix)]
#[tokio::test]
async fn a_transient_read_failure_never_retires_the_active_index() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha body".into()))],
        "transient-index-publish-0001",
    );
    let active = ready(&f).await;
    let path = f.store.paths().index_file(&f.kb, &active);
    let mode = std::fs::metadata(&path).expect("file").permissions().mode();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("unreadable");
    let failed = f.query(json!({})).await;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("readable");
    assert!(failed.is_err());
    assert_eq!(f.status().active_generation_id, Some(active.clone()));
    let state: String = f
        .db()
        .query_row(
            "SELECT state FROM index_generations WHERE id=?1",
            [active.as_str()],
            |r| r.get(0),
        )
        .expect("generation");
    assert_eq!(state, "COMPLETE");
    assert!(
        f.query(json!({})).await.is_ok(),
        "serves again as soon as it can read"
    );
}

/// `kb model remove` is never refused by stores that
/// enabled the model, like the server's Remove: both stores serve their
/// keyword arm with EMBEDDING_PROFILE_UNAVAILABLE while it is gone, and
/// return to hybrid with the same generation once it is downloaded again.
#[tokio::test]
async fn removing_a_model_two_stores_enabled_degrades_both_until_it_returns() {
    use kb_local::{
        index::IndexEmbedder,
        model_catalog::descriptor,
        qwen::{ModelConfiguration, ModelRuntime},
    };
    let host = model_host::seeded(
        &std::env::temp_dir().join(format!("kb-remove-two-{}.model", std::process::id())),
        Duration::from_secs(5),
    );
    let stores = [Fixture::new(1024), Fixture::new(1024)];
    let mut runtimes = vec![];
    for (n, f) in stores.iter().enumerate() {
        let runtime = ModelRuntime::new(&f.store, host.clone()).expect("runtime");
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
            .expect("enabled");
        let job = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","confirm":"RUN","idempotencyKey":format!("remove-two-profile-{n:04}")})).expect("input")).expect("profile");
        assert!(
            f.store
                .activate_built(f.build(&job.generation_id).await)
                .expect("activate")
        );
        runtimes.push(runtime);
    }
    let search = async |f: &Fixture, runtime: &ModelRuntime| {
        f.store
            .search(
                &f.store.owner(),
                input(f, json!({"query":"generation"})),
                IndexEmbedder::Builtin(runtime),
                &SearchControl::default(),
            )
            .await
            .expect("search")
    };
    let active = stores
        .iter()
        .map(|f| f.status().active_generation_id.expect("active"))
        .collect::<Vec<_>>();
    for (f, r) in stores.iter().zip(&runtimes) {
        assert!(
            search(f, r)
                .await
                .results
                .iter()
                .all(|h| h.mode == SearchMode::Hybrid)
        );
    }
    let m = descriptor("qwen3-embedding-0.6b-q8_0").expect("model");
    let removal = host
        .remove_model_report(&m)
        .expect("remove is never refused by stores");
    assert_eq!(removal.removed.len(), 1);
    for (f, r) in stores.iter().zip(&runtimes) {
        let out = search(f, r).await;
        assert!(!out.results.is_empty());
        assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
        assert_eq!(
            out.index_notices,
            vec![IndexNotice::LexicalOnly(LexicalOnlyNotice {
                kb_id: f.kb.clone(),
                code: LexicalOnlyCode,
                detail: LexicalOnlyReason::EmbeddingProfileUnavailable,
            })]
        );
    }
    // Downloaded again: hybrid at once, with the same generations (same
    // fingerprint, no rebuild).
    model_host::seed_models(&host);
    for ((f, r), id) in stores.iter().zip(&runtimes).zip(&active) {
        assert!(
            search(f, r)
                .await
                .results
                .iter()
                .all(|h| h.mode == SearchMode::Hybrid)
        );
        let status = f.status();
        assert_eq!(status.active_generation_id.as_ref(), Some(id));
        assert_eq!(status.desired_generation_id.as_ref(), Some(id));
    }
    drop(runtimes);
    let top = std::env::temp_dir().join(format!("kb-remove-two-{}.model", std::process::id()));
    let _ = std::fs::remove_dir_all(&top);
    #[cfg(unix)]
    remove_short_runtime_dirs(&top);
}

/// Effective availability sees the model file. A removal
/// between the query embedding and the return re-ranks by keyword (ordinary
/// and structured), and profile/provider status say unavailable until the
/// file is back, then ready again.
#[tokio::test]
async fn a_removal_during_a_search_degrades_it_and_status_follows_the_file() {
    use kb_local::{
        model_catalog::descriptor,
        qwen::{ModelConfiguration, ModelRuntime},
    };
    let f = Fixture::new(1024);
    let host = model_host::seeded(&f.root.with_extension("model"), Duration::from_secs(5));
    let runtime = ModelRuntime::new(&f.store, host.clone()).expect("runtime");
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
        .expect("enabled");
    let job = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","confirm":"RUN","idempotencyKey":"remove-during-search-0001"})).expect("input")).expect("profile");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("activate")
    );
    let m = descriptor("qwen3-embedding-0.6b-q8_0").expect("model");
    let status = || {
        let profile = f
            .store
            .embedding_profile_get(
                &f.store.owner(),
                KbRef {
                    kb_id: f.kb.clone(),
                },
            )
            .expect("profile")
            .profile
            .expect("pinned");
        let provider = f
            .store
            .builtin_provider_summary()
            .expect("summary")
            .expect("enabled");
        (profile.status, provider.status)
    };
    assert_eq!(status(), (ProviderStatus::Ready, ProviderStatus::Ready));
    let lexical = |notices: &[IndexNotice]| {
        notices
            == [IndexNotice::LexicalOnly(LexicalOnlyNotice {
                kb_id: f.kb.clone(),
                code: LexicalOnlyCode,
                detail: LexicalOnlyReason::EmbeddingProfileUnavailable,
            })]
    };
    let remove_after_embedding = |stage: SearchStage| {
        if stage == SearchStage::AfterEmbedding {
            host.remove_model_report(&m).expect("removed");
        }
        Ok(())
    };
    let out = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({"query":"generation"})),
            &SearchControl::default(),
            async |_, _| Ok(vec![1.; 1024]),
            &mut { remove_after_embedding },
        )
        .await
        .expect("search");
    assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
    assert!(lexical(&out.index_notices), "{:?}", out.index_notices);
    assert_eq!(
        status(),
        (ProviderStatus::Unavailable, ProviderStatus::Unavailable)
    );
    // Structured: back first, then removed between embedding and return.
    model_host::seed_models(&host);
    assert_eq!(status(), (ProviderStatus::Ready, ProviderStatus::Ready));
    let page = f
        .store
        .structured_search_generation(
            &f.store.owner(),
            structured(&f, json!({"query":"generation"})),
            &SearchControl::default(),
            async |_, _| Ok(vec![1.; 1024]),
            &mut { remove_after_embedding },
        )
        .await
        .expect("structured search");
    assert!(page.items.iter().all(|h| h.mode == SearchMode::Lexical));
    assert!(lexical(&page.index_notices), "{:?}", page.index_notices);
    // Downloaded again: ready, and hybrid without a rebuild.
    model_host::seed_models(&host);
    assert_eq!(status(), (ProviderStatus::Ready, ProviderStatus::Ready));
    let out = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({"query":"generation"})),
            &SearchControl::default(),
            async |_, _| Ok(vec![1.; 1024]),
            &mut |_| Ok(()),
        )
        .await
        .expect("search");
    assert!(out.results.iter().all(|h| h.mode == SearchMode::Hybrid));
    drop(runtime);
}
