//! Task 60: spec-first tests against real Git, SQLite FTS5 and sqlite-vec.
#[path = "support/model_admission.rs"]
mod model_admission;
#[path = "support/model_host.rs"]
mod model_host;
#[path = "support/search_fixture.rs"]
mod support;
use kb_client::{
    ErrorCode,
    snapshot::{content_hash, git_blob_sha},
    types::*,
};
use kb_local::{
    StoreError,
    search::{SearchControl, SearchStage, fuse_ranks},
};
use serde_json::json;
use std::time::Duration;
use support::*;

#[tokio::test]
async fn unavailable_sensitive_and_empty_complete() {
    let f = Fixture::new(2);
    let mut called = false;
    let mut embed = async |_: &kb_local::generations::ProfileSnapshot, _: &str| {
        called = true;
        Ok(vec![1.; 2])
    };
    assert_eq!(
        f.store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({})),
                &SearchControl::default(),
                &mut embed,
                &mut |_| Ok(())
            )
            .await
            .unwrap_err()
            .protocol_code(),
        ErrorCode::IndexUnavailable
    );
    assert_eq!(
        f.filter(json!({"title":"Index"}))
            .await
            .unwrap_err()
            .protocol_code(),
        ErrorCode::IndexUnavailable
    );
    publish(
        &f,
        vec![("index.md", Some(String::new()))],
        "search-empty-index",
    );
    ready(&f).await;
    for q in [
        "sk-proj-abcdefghijklmnopqrstuvwxyz",
        "Bearer synthetic-review-token-0123456789",
    ] {
        assert_eq!(
            f.store
                .search_generation(
                    &f.store.owner(),
                    input(&f, json!({"query":q})),
                    &SearchControl::default(),
                    &mut embed,
                    &mut |_| Ok(())
                )
                .await
                .unwrap_err()
                .protocol_code(),
            ErrorCode::SensitiveQuery
        );
        assert_eq!(
            f.filter(json!({"query":q}))
                .await
                .unwrap_err()
                .protocol_code(),
            ErrorCode::SensitiveQuery
        );
    }
    assert!(!called);
    let out = f.query(json!({})).await.expect("valid fixture");
    assert!(out.results.is_empty());
    check::<KnowledgeSearch>(&out);
    no_leases(&f);
}
#[test]
fn rrf_exact_first_weight_duplicates_and_ties() {
    let a = ("a.md".to_owned(), 0);
    let b = ("a.md".to_owned(), 1);
    let c = ("ü.md".to_owned(), 0);
    let one = fuse_ranks(&[vec![a.clone(), a.clone(), b.clone()]]);
    assert_eq!(one[0].2, 1. / 61.);
    assert_eq!(one[1].2, 1. / 62.);
    let tied = fuse_ranks(&[
        vec![c.clone(), b.clone(), a.clone()],
        vec![a.clone(), b.clone(), c.clone()],
    ]);
    assert_eq!((tied[0].0.as_str(), tied[0].1), ("a.md", 0));
    assert_eq!(tied[1].0, "ü.md");
    let tied = fuse_ranks(&[vec![a.clone(), b.clone()], vec![b, a]]);
    assert_eq!((tied[0].0.as_str(), tied[0].1), ("a.md", 0));
    assert_eq!((tied[1].0.as_str(), tied[1].1), ("a.md", 1));
}
#[tokio::test]
async fn sqlite_golden_ranking_and_citations_survive_later_edits() {
    let f = Fixture::new(2);
    let corpus = load(&f, "search");
    let id = ready(&f).await;
    for case in corpus["queries"].as_array().expect("valid fixture") {
        let out = f
            .query(json!({"query":case["query"]}))
            .await
            .expect("valid fixture");
        check::<KnowledgeSearch>(&out);
        assert_eq!(out.generation_id, id);
        let expected = case["expected"].as_array().expect("valid fixture");
        assert_eq!(out.results.len(), expected.len());
        for (h, w) in out.results.iter().zip(expected) {
            assert_eq!(h.path.as_str(), w["path"].as_str().expect("valid fixture"));
            assert_eq!(h.score, score(w));
            let doc = f.cited(h);
            assert_eq!(h.content_hash, content_hash(doc.markdown.as_bytes()));
            assert_eq!(h.blob_sha, git_blob_sha(doc.markdown.as_bytes()));
            let p =
                kb_local::markdown::parse_markdown(doc.markdown.as_bytes()).expect("valid fixture");
            let body = &doc.markdown[p.body_start..];
            let raw = &body[h.span.start_byte as usize..h.span.end_byte as usize];
            assert_eq!(
                h.snippet,
                kb_local::chunk::citation_snippet(&kb_local::plain_snippet::plain_snippet(
                    &kb_local::chunk::citation_snippet(raw)
                ))
            );
            assert_eq!(
                h.span.end_token - h.span.start_token,
                raw.split_whitespace().count() as u64
            );
        }
    }
    let out = f
        .query(json!({"query":"omega","documentId":"unicode-doc"}))
        .await
        .expect("valid fixture");
    let hit = &out.results[0];
    assert_eq!(hit.document_citations.len(), 2);
    assert_eq!(hit.document_citations[1].target, "javascript:alert(1)");
    assert_eq!(hit.asset_refs.len(), 1);
    publish(
        &f,
        vec![("notes/ünï.md", Some("different source".into()))],
        "search-edit-unicode",
    );
    assert_eq!(
        content_hash(f.cited(hit).markdown.as_bytes()),
        hit.content_hash
    );
    no_leases(&f);
}
#[tokio::test]
async fn swap_barriers_pin_profile_head_status_and_both_arms() {
    for barrier in [
        SearchStage::Pinned,
        SearchStage::BeforeDispatch,
        SearchStage::AfterEmbedding,
        SearchStage::Vector,
        SearchStage::Fts,
        SearchStage::BeforeReturn,
    ] {
        let f = Fixture::new(2);
        let a = ready(&f).await;
        let old = f.status();
        f.db().execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,2,'https://example.invalid/embeddings','different-space',3,?2,'READY')",(f.provider.as_str(),format!("sha256:{}","b".repeat(64)))).expect("valid fixture");
        f.db().execute("INSERT INTO provider_registrations(operation_id,idempotency_key,request_mac,provider_id,revision) VALUES('22222222-2222-4222-8222-222222222222','fixture-register-0002',zeroblob(32),?1,2)", [f.provider.as_str()]).expect("second immutable registration");
        let b=f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":f.provider,"revision":2,"confirm":"RUN","idempotencyKey":"search-swap-profile"})).expect("valid fixture")).expect("valid fixture");
        let mut built = Some(f.build(&b.generation_id).await);
        let expected = f.status();
        let mut called = false;
        let out = f
            .store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({"query":"generation"})),
                &SearchControl::default(),
                async |pin, _| {
                    assert_eq!(
                        Some(pin),
                        f.store
                            .generation_snapshot(&a)
                            .expect("valid fixture")
                            .profile
                            .as_ref()
                    );
                    called = true;
                    Ok(vec![1.; 2])
                },
                &mut |stage| {
                    if stage == barrier {
                        assert!(
                            f.store
                                .activate_built(built.take().expect("valid fixture"))
                                .expect("valid fixture")
                        );
                        publish(
                            &f,
                            vec![("index.md", Some("later HEAD β".into()))],
                            "search-barrier-head",
                        );
                    }
                    Ok(())
                },
            )
            .await
            .expect("valid fixture");
        assert!(called);
        assert_eq!(out.generation_id, a);
        assert_eq!(out.head_sha, old.head_sha);
        assert_ne!(out.head_sha, f.status().head_sha);
        assert_eq!(out.freshness, expected.freshness);
        assert!(
            out.results
                .iter()
                .all(|h| h.index_generation_id == a && h.commit_sha == old.head_sha)
        );
        no_leases(&f);
    }
}
/// One effective mode: losing the profile at any barrier of either
/// search method (provider revoked, built-in disabled) degrades the search to
/// the generation's lexical arm — never INDEX_UNAVAILABLE, never vector ranks
/// of the lost profile — while losing read authority still fails.
#[tokio::test]
async fn profile_loss_at_every_barrier_degrades_lexically_and_authority_loss_fails() {
    for barrier in [
        SearchStage::Pinned,
        SearchStage::BeforeDispatch,
        SearchStage::AfterEmbedding,
        SearchStage::Vector,
        SearchStage::Fts,
        SearchStage::BeforeReturn,
    ] {
        for cause in ["provider", "builtin", "authority"] {
            for structured_method in [false, true] {
                let f = Fixture::new(2);
                publish(
                    &f,
                    vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
                    "profile-loss-publish-01",
                );
                if cause == "builtin" {
                    f.db()
                        .execute("UPDATE builtin_model SET enabled=1 WHERE id=1", [])
                        .expect("enable");
                    let revision = f.store.model_state().expect("state").epoch + 1;
                    let job = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","revision":revision,"idempotencyKey":"profile-loss-builtin-01","confirm":"RUN"})).expect("input")).expect("profile");
                    f.settle_companion(&job.generation_id).await;
                    assert!(
                        f.store
                            .activate_built(f.build(&job.generation_id).await)
                            .expect("builtin")
                    );
                } else {
                    ready(&f).await;
                }
                let p = reader(&f);
                let mut called = false;
                let lose = |stage: SearchStage| {
                    if stage != barrier {
                        return;
                    }
                    let db = f.db();
                    match cause {
                        "provider" => db.execute(
                            "UPDATE providers SET revoked=1 WHERE id=?1",
                            [f.provider.as_str()],
                        ),
                        "builtin" => {
                            db.execute("UPDATE builtin_model SET enabled=0 WHERE id=1", [])
                        }
                        _ => db.execute(
                            "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
                            [p.id()],
                        ),
                    }
                    .expect("fixture");
                };
                let outcome = if structured_method {
                    f.store
                        .structured_search_generation(
                            &p,
                            structured(&f, json!({"query":"alpha"})),
                            &SearchControl::default(),
                            async |_, _| {
                                called = true;
                                Ok(vec![1.; 2])
                            },
                            &mut |stage| {
                                lose(stage);
                                Ok(())
                            },
                        )
                        .await
                        .map(|o| {
                            (
                                o.items.iter().map(|h| h.mode).collect::<Vec<_>>(),
                                o.index_notices,
                            )
                        })
                } else {
                    f.store
                        .search_generation(
                            &p,
                            input(&f, json!({})),
                            &SearchControl::default(),
                            async |_, _| {
                                called = true;
                                Ok(vec![1.; 2])
                            },
                            &mut |stage| {
                                lose(stage);
                                Ok(())
                            },
                        )
                        .await
                        .map(|o| {
                            (
                                o.results.iter().map(|h| h.mode).collect::<Vec<_>>(),
                                o.index_notices,
                            )
                        })
                };
                let label = format!("{cause} at {barrier:?} (structured: {structured_method})");
                if cause == "authority" {
                    assert_eq!(
                        outcome.expect_err(&label).protocol_code(),
                        ErrorCode::NotFound,
                        "{label}"
                    );
                } else {
                    let (modes, notices) = outcome.expect(&label);
                    assert!(!modes.is_empty(), "{label}");
                    assert!(modes.iter().all(|m| *m == SearchMode::Lexical), "{label}");
                    let detail = if cause == "provider" {
                        LexicalOnlyReason::EmbeddingProfileRevoked
                    } else {
                        LexicalOnlyReason::EmbeddingProfileUnavailable
                    };
                    assert_eq!(notices, lexical_notice(&f, detail), "{label}");
                }
                if matches!(barrier, SearchStage::Pinned | SearchStage::BeforeDispatch) {
                    assert!(!called, "{label}");
                }
                no_leases(&f);
            }
        }
    }
}
#[tokio::test]
async fn invalid_vector_falls_back_lexically_cancel_timeout_never_and_reenter() {
    let f = Fixture::new(2);
    ready(&f).await;
    for bad in [
        vec![],
        vec![1.],
        vec![0.; 2],
        vec![f64::NAN; 2],
        vec![f64::INFINITY; 2],
    ] {
        // Each case dispatches: forget the breaker the previous one opened.
        f.store.reset_query_breakers_for_tests();
        // An embedder that returns an unusable vector is failing; the
        // search degrades to the generation's lexical arm and says why.
        let out = f
            .store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({})),
                &SearchControl::default(),
                async |_, _| Ok(bad.clone()),
                &mut |_| Ok(()),
            )
            .await
            .expect("lexical fallback");
        assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
        assert!(matches!(
            out.index_notices.as_slice(),
            [IndexNotice::LexicalOnly(n)] if n.detail == LexicalOnlyReason::EmbeddingProfileUnavailable
        ));
        no_leases(&f);
    }
    f.store.reset_query_breakers_for_tests();
    for barrier in [
        SearchStage::Pinned,
        SearchStage::BeforeDispatch,
        SearchStage::AfterEmbedding,
        SearchStage::Vector,
        SearchStage::Fts,
        SearchStage::BeforeReturn,
    ] {
        let ctl = SearchControl::default();
        let e = f
            .store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({})),
                &ctl,
                async |_, _| Ok(vec![1.; 2]),
                &mut |s| {
                    if s == barrier {
                        ctl.cancel();
                    }
                    Ok(())
                },
            )
            .await
            .unwrap_err();
        assert_eq!(e.protocol_code(), ErrorCode::Cancelled);
        no_leases(&f);
    }
    for barrier in [
        SearchStage::Pinned,
        SearchStage::BeforeDispatch,
        SearchStage::AfterEmbedding,
        SearchStage::Vector,
        SearchStage::Fts,
        SearchStage::BeforeReturn,
    ] {
        let ctl = SearchControl::with_timeout(Duration::from_secs(2));
        let mut reached = false;
        let e = f
            .store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({})),
                &ctl,
                async |_, _| Ok(vec![1.; 2]),
                &mut |stage| {
                    if stage == barrier {
                        reached = true;
                        std::thread::sleep(Duration::from_millis(2100));
                    }
                    Ok(())
                },
            )
            .await
            .unwrap_err();
        assert!(reached, "timeout test must reach {barrier:?}");
        assert_eq!(e.protocol_code(), ErrorCode::DeadlineExceeded);
        no_leases(&f);
    }
    // Allow the five-second store admission budget before exercising embedding wait.
    let ctl = SearchControl::with_timeout(Duration::from_secs(10));
    let mut dispatched = false;
    // A hanging embedder spends only its share of the budget; the rest
    // serves the lexical arm.
    let out = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({})),
            &ctl,
            async |_, _| {
                dispatched = true;
                std::future::pending::<()>().await;
                Ok(vec![1.; 2])
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("lexical fallback within the query budget");
    assert!(
        dispatched,
        "the embedding share must interrupt the actual wait"
    );
    assert!(matches!(
        out.index_notices.as_slice(),
        [IndexNotice::LexicalOnly(n)] if n.detail == LexicalOnlyReason::EmbeddingProfileUnavailable
    ));
    no_leases(&f);
    // R3-L4: that search's own short budget timed out, which says nothing
    // about the target. A search with the full budget waits at most the
    // query-embedding bound, and its timeout opens the target's breaker.
    // Admission and return can wait on durable SQLite writes. Measure the
    // pending embedder's lifetime, which is what the target bound controls.
    // Keep the breaker's logical cooldown fixed until the explicit advance
    // below; slow storage must not turn an open-state check into a probe.
    f.store.advance_clock_for_tests(0);
    use std::{cell::Cell, time::Instant};
    struct TargetWait<'a>(&'a Cell<Option<Duration>>, Instant);
    impl Drop for TargetWait<'_> {
        fn drop(&mut self) {
            self.0.set(Some(self.1.elapsed()));
        }
    }
    let target_elapsed = Cell::new(None);
    let observed = &target_elapsed;
    let out = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({})),
            &SearchControl::default(),
            move |_: &kb_local::generations::ProfileSnapshot, _: &str| {
                // Construct before the target timer is armed, so the lower
                // bound includes all of its budget, even at sub-ms precision.
                let wait = TargetWait(observed, Instant::now());
                async move {
                    let _wait = wait;
                    std::future::pending::<()>().await;
                    Ok(vec![1.; 2])
                }
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("lexical after the bound");
    assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
    let waited = target_elapsed
        .get()
        .expect("the pending embedder was dropped");
    assert!(
        waited >= kb_local::breaker::QUERY_EMBEDDING_DEADLINE
            && waited < kb_local::breaker::QUERY_EMBEDDING_DEADLINE + Duration::from_secs(5),
        "{waited:?}"
    );
    // Open: searches serve the lexical arm at once, without dispatching,
    // until the cooldown ends.
    let dispatches = Cell::new(0);
    for _ in 0..3 {
        let out = f
            .store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({})),
                &SearchControl::default(),
                async |_, _| -> Result<Vec<f64>, StoreError> {
                    dispatches.set(dispatches.get() + 1);
                    Err(StoreError::EmbeddingFailed)
                },
                &mut |_| Ok(()),
            )
            .await
            .expect("lexical while open");
        assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
        assert!(matches!(
            out.index_notices.as_slice(),
            [IndexNotice::LexicalOnly(n)] if n.detail == LexicalOnlyReason::EmbeddingProfileUnavailable
        ));
    }
    assert_eq!(dispatches.get(), 0, "an open breaker never dispatches");
    // After the cooldown one search is the half-open probe; it succeeds and
    // closes the breaker.
    f.store
        .advance_clock_for_tests(kb_local::breaker::COOLDOWN.as_secs() as i64);
    for _ in 0..2 {
        let out = f.query(json!({})).await.expect("hybrid again");
        assert!(out.results.iter().all(|h| h.mode == SearchMode::Hybrid));
    }
    no_leases(&f);
    let ctl = SearchControl::default();
    let other = ctl.clone();
    let e = f
        .store
        .search_generation(
            &f.store.owner(),
            input(&f, json!({})),
            &ctl,
            async |_, _| {
                other.cancel();
                std::future::pending::<()>().await;
                Ok(vec![1.; 2])
            },
            &mut |_| Ok(()),
        )
        .await
        .unwrap_err();
    assert_eq!(e.protocol_code(), ErrorCode::Cancelled);
    no_leases(&f);
    for (barrier, table) in [
        (SearchStage::Vector, "chunk_bits"),
        (SearchStage::Fts, "chunk_fts"),
    ] {
        let generation = f.status().active_generation_id.expect("complete index");
        let db = rusqlite::Connection::open(f.store.paths().index_file(&f.kb, &generation))
            .expect("owned test index");
        let mut vector_completed = false;
        let mut damaged = false;
        let out = f
            .store
            .search_generation(
                &f.store.owner(),
                input(&f, json!({})),
                &SearchControl::default(),
                async |_, _| Ok(vec![1.; 2]),
                &mut |s| {
                    if !damaged {
                        if s == SearchStage::Fts {
                            vector_completed = true;
                        }
                        if s == barrier {
                            db.execute_batch(&format!("ALTER TABLE {table} RENAME TO broken_arm"))?;
                            damaged = true;
                        }
                    }
                    Ok(())
                },
            )
            .await
            .expect("the same search recovers the broken arm");
        assert!(damaged, "the original query reached {barrier:?}");
        assert_ne!(out.generation_id, generation);
        assert!(
            out.results
                .iter()
                .all(|hit| hit.mode == SearchMode::Lexical)
        );
        assert_eq!(
            out.index_notices,
            lexical_notice(&f, LexicalOnlyReason::SemanticIndexBuilding)
        );
        assert_eq!(vector_completed, barrier == SearchStage::Fts);
        no_leases(&f);
        // Review r2 #2: a missing arm is a broken index contract, not a
        // transient failure: the file is retired, this request serves the
        // retained lexical companion, and the semantic generation is rebuilt.
        let code: Option<String> = f
            .db()
            .query_row(
                "SELECT error_code FROM index_generations WHERE id=?1",
                [generation.as_str()],
                |r| r.get(0),
            )
            .expect("generation");
        assert_eq!(code.as_deref(), Some("INDEX_FILE_LOST"), "{table}");
        drop(db);
        let desired = f.status().desired_generation_id.expect("rescheduled");
        build_semantic(&f, &desired).await;
        f.query(json!({}))
            .await
            .expect("search re-enters after the rebuild");
    }
    assert_eq!(
        f.query(json!({}))
            .await
            .expect("valid fixture")
            .results
            .len(),
        1
    );
    no_leases(&f);
}
#[tokio::test]
async fn filters_before_eighty_candidate_cap_and_shared_cost_caps() {
    let f = Fixture::new(2);
    f.store.advance_clock_for_tests(0);
    for n in 0..11 {
        let names = (0..8)
            .map(|m| format!("a{:03}.md", n * 8 + m))
            .collect::<Vec<_>>();
        publish(
            &f,
            names
                .iter()
                .map(|p| (p.as_str(), Some("alpha".into())))
                .collect(),
            &format!("search-many-docs-{n:04}"),
        );
    }
    publish(
        &f,
        vec![("z/last.md", Some("---\nid: wanted\n---\nalpha beta".into()))],
        "search-filter-last",
    );
    ready(&f).await;
    for extra in [json!({"pathPrefix":"z"}), json!({"documentId":"wanted"})] {
        let out = f.query(extra).await.expect("valid fixture");
        assert_eq!(out.results.len(), 1);
        // L-25: first in both arms is the normalized maximum.
        assert_eq!(out.results[0].score, 1.);
    }
    assert_eq!(
        f.query(json!({"limit":20}))
            .await
            .expect("valid fixture")
            .results
            .len(),
        20
    );
    assert_eq!(
        f.query(json!({}))
            .await
            .expect("default limit")
            .results
            .len(),
        6
    );
    let (test, config) = aliases(&f, &[&f.kb]);
    let owner = f.store.owner();
    let principals = [&owner, &test, &config];
    // The local window is LOCAL_QUERIES_PER_MINUTE_PER_KB; pre-charge all
    // but the last 30 so the boundary below stays small.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    for n in 0..kb_local::limits::LOCAL_QUERIES_PER_MINUTE_PER_KB - 30 {
        f.db()
            .execute(
                "INSERT INTO query_charges VALUES(?1,?2,?3,?4)",
                (
                    format!("00000000-0000-4000-8000-{n:012}"),
                    owner.actor_key(),
                    f.kb.as_str(),
                    now,
                ),
            )
            .expect("seed the durable query window");
    }
    for n in 4..30 {
        f.filter_as(principals[n % 3], json!({"type":"absent"}), &mut |_| Ok(()))
            .await
            .expect("aliases share the remaining user window");
    }
    for p in principals {
        assert_eq!(
            f.filter_as(p, json!({"type":"absent"}), &mut |_| Ok(()))
                .await
                .unwrap_err()
                .protocol_code(),
            ErrorCode::RateLimited
        );
        assert_eq!(
            f.store
                .search_generation(
                    p,
                    input(&f, json!({})),
                    &SearchControl::default(),
                    async |_, text| Ok(vector(text)),
                    &mut |_| Ok(())
                )
                .await
                .unwrap_err()
                .protocol_code(),
            ErrorCode::RateLimited
        );
    }
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM query_charges", [], |r| r
                .get::<_, i64>(0))
            .expect("durable charges"),
        kb_local::limits::LOCAL_QUERIES_PER_MINUTE_PER_KB
    );
    let other = second_kb(&f).await;
    f.filter(json!({"kbId":other,"type":"absent"}))
        .await
        .expect("rate window remains per KB");
    no_leases(&f);
    f.store.advance_clock_for_tests(61);
    assert_eq!(
        f.query(json!({}))
            .await
            .expect("valid fixture")
            .results
            .len(),
        6
    );
}

#[tokio::test]
async fn four_in_flight_across_both_modes_cancel_and_reenter() {
    let f = Fixture::new(2);
    ready(&f).await;
    let other = second_kb(&f).await;
    let (test, config) = aliases(&f, &[&f.kb, &other]);
    let owner = f.store.owner();
    let ctl = SearchControl::default();
    let pending = async |p: &kb_local::LocalPrincipal, kb: &KbId, structured_query: bool| {
        if structured_query {
            return f
                .store
                .structured_search_generation(
                    p,
                    structured(&f, json!({"kbId":kb,"query":"alpha"})),
                    &ctl,
                    async |_, _| {
                        std::future::pending::<()>().await;
                        Ok(vec![1.; 2])
                    },
                    &mut |_| Ok(()),
                )
                .await
                .map(|_| ());
        }
        f.store
            .search_generation(
                p,
                input(&f, json!({"kbId":kb})),
                &ctl,
                async |_, _| {
                    std::future::pending::<()>().await;
                    Ok(vec![1.; 2])
                },
                &mut |_| Ok(()),
            )
            .await
            .map(|_| ())
    };
    let (a, b, c, d, ()) = tokio::join!(
        pending(&owner, &f.kb, false),
        pending(&test, &other, true),
        pending(&config, &f.kb, true),
        pending(&test, &other, false),
        async {
            assert_eq!(
                f.filter_as(
                    &config,
                    json!({"kbId":other,"title":"absent"}),
                    &mut |_| Ok(())
                )
                .await
                .unwrap_err()
                .protocol_code(),
                ErrorCode::RateLimited
            );
            assert_eq!(
                f.db()
                    .query_row("SELECT count(*) FROM generation_leases", [], |r| r
                        .get::<_, i64>(0))
                    .expect("valid fixture"),
                4
            );
            ctl.cancel();
        }
    );
    for r in [a, b, c, d] {
        assert_eq!(r.unwrap_err().protocol_code(), ErrorCode::Cancelled);
    }
    no_leases(&f);
    f.query(json!({})).await.expect("valid fixture");
    f.filter_as(&test, json!({"kbId":other,"title":"absent"}), &mut |_| {
        Ok(())
    })
    .await
    .expect("alias queryless re-entry releases common slots");
}

fn aliases(f: &Fixture, kbs: &[&KbId]) -> (kb_local::LocalPrincipal, kb_local::LocalPrincipal) {
    let mut result = vec![];
    for (id, kind) in [
        ("22222222-2222-4222-8222-222222222222", "TEST"),
        ("33333333-3333-4333-8333-333333333333", "CONFIG"),
    ] {
        for kb in kbs {
            f.db().execute("INSERT INTO principal_ceilings(principal_id,kind,kb_id,bits) VALUES(?1,?2,?3,1)",(id,kind,kb.as_str())).expect("narrow read principal");
        }
        result.push(f.store.principal(id).expect("live principal"));
    }
    (result.remove(0), result.remove(0))
}
async fn second_kb(f: &Fixture) -> KbId {
    let id = f
        .store
        .create_kb(
            &f.store.owner(),
            kb_local::CreateKbRequest {
                name: "Second search KB".into(),
                slug: "second-search-kb".into(),
                description: "Same human user's second KB".into(),
                idempotency_key: "search-second-kb-0001".into(),
            },
        )
        .expect("second KB")
        .kb_id;
    let job = f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":id,"providerId":f.provider,"revision":1,"idempotencyKey":"search-second-profile-0001","confirm":"RUN"})).expect("profile input")).expect("second profile");
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("activate second KB")
    );
    id
}

#[tokio::test]
async fn host_external_adapter_rechecks_read_after_dns_before_http() {
    use kb_local::{
        credentials::{Credentials, Secret},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture, PinnedEgress},
        index::IndexEmbedder,
    };
    struct Keys;
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            Ok(Secret::new("disposable-search-fixture".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
    }
    struct Resolver<'a>(&'a dyn Fn());
    impl Dns for Resolver<'_> {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async move {
                (self.0)();
                Ok(vec!["8.8.8.8".parse().expect("valid fixture")])
            })
        }
    }
    struct Transport(std::cell::Cell<usize>);
    impl Http for Transport {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            body: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                let body: serde_json::Value = serde_json::from_slice(&body).expect("valid fixture");
                assert_eq!(body["model"], "fixture");
                assert_eq!(body["input"][0], "alpha");
                self.0.set(self.0.get() + 1);
                Ok(HttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({"data":[{"index":0,"embedding":[1,1]}]}))
                        .expect("valid fixture"),
                })
            })
        }
    }
    for revoke in [false, true] {
        let f = Fixture::new(2);
        ready(&f).await;
        let p = reader(&f);
        let action = || {
            if revoke {
                f.db()
                    .execute(
                        "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
                        [p.id()],
                    )
                    .expect("valid fixture");
            }
        };
        let dns = Resolver(&action);
        let http = Transport(std::cell::Cell::new(0));
        let egress = PinnedEgress::new(&dns, &http);
        let out = f
            .store
            .search(
                &p,
                input(&f, json!({})),
                IndexEmbedder::External {
                    keys: &Keys,
                    egress: &egress,
                },
                &SearchControl::default(),
            )
            .await;
        if revoke {
            assert_eq!(out.unwrap_err().protocol_code(), ErrorCode::NotFound);
            assert_eq!(http.0.get(), 0);
        } else {
            assert_eq!(out.expect("valid fixture").results.len(), 1);
            assert_eq!(http.0.get(), 1);
        }
        no_leases(&f);
    }
}

/// Exercise the production provider adapter, including native-key admission,
/// rather than treating an already-admitted test closure as the provider call.
/// Admission is excluded from the target budget; DNS, connect and response
/// share it. The timer driver is paused: durable Git/SQLite work and CPU
/// scheduling cannot consume the simulated admission/target delays.
#[tokio::test(start_paused = true)]
async fn query_breakers_charge_only_target_io_through_the_production_adapter() {
    use kb_local::{
        credentials::{Credentials, Secret},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture, PinnedEgress},
        embedder::ProviderControl,
        index::IndexEmbedder,
        locks::CredentialFence,
    };
    use std::cell::Cell;
    struct Keys {
        delay: Cell<Duration>,
        reads: Cell<usize>,
    }
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            panic!("search must use controlled credential admission")
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
        fn get_controlled<'a>(
            &'a self,
            _: &'a str,
            _: &'a ProviderControl,
            _: &'a CredentialFence,
        ) -> IoFuture<'a, Secret> {
            Box::pin(async move {
                self.reads.set(self.reads.get() + 1);
                let delay = self.delay.get();
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                Ok(Secret::new("disposable-search-fixture".into()))
            })
        }
    }
    /// `None` is a resolver that never answers.
    struct Resolver {
        delay: Cell<Option<Duration>>,
        calls: Cell<usize>,
    }
    impl Dns for Resolver {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async move {
                self.calls.set(self.calls.get() + 1);
                match self.delay.get() {
                    Some(delay) if !delay.is_zero() => tokio::time::sleep(delay).await,
                    Some(_) => {}
                    None => std::future::pending().await,
                }
                Ok(vec!["8.8.8.8".parse().expect("fixture IP")])
            })
        }
    }
    struct Transport {
        delay: Cell<Duration>,
        calls: Cell<usize>,
    }
    impl Http for Transport {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            _: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                self.calls.set(self.calls.get() + 1);
                let delay = self.delay.get();
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                Ok(HttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({"data":[{"index":0,"embedding":[1,1]}]}))
                        .expect("fixture response"),
                })
            })
        }
    }
    for structured_method in [false, true] {
        let f = Fixture::new(2);
        f.store.advance_clock_for_tests(0);
        publish(
            &f,
            vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
            "slow-admission-publish-0001",
        );
        ready(&f).await;
        let keys = Keys {
            delay: Cell::new(Duration::ZERO),
            reads: Cell::new(0),
        };
        let http = Transport {
            delay: Cell::new(Duration::ZERO),
            calls: Cell::new(0),
        };
        let dns = Resolver {
            delay: Cell::new(Some(Duration::ZERO)),
            calls: Cell::new(0),
        };
        let egress = PinnedEgress::new(&dns, &http);
        let query = async |timeout| {
            let ctl = SearchControl::with_timeout(timeout);
            let io = IndexEmbedder::External {
                keys: &keys,
                egress: &egress,
            };
            let (results, notices) = if structured_method {
                let out = f
                    .store
                    .structured_search(
                        &f.store.owner(),
                        structured(&f, json!({"query":"alpha"})),
                        io,
                        &ctl,
                    )
                    .await
                    .expect("structured query within overall deadline");
                (out.items, out.index_notices)
            } else {
                let out = f
                    .store
                    .search(&f.store.owner(), input(&f, json!({})), io, &ctl)
                    .await
                    .expect("query within overall deadline");
                (out.results, out.index_notices)
            };
            assert!(
                !results.is_empty(),
                "real lexical/vector ranking participates"
            );
            let mode = results[0].mode;
            assert!(results.iter().all(|hit| hit.mode == mode));
            if mode == SearchMode::Lexical {
                assert!(matches!(notices.as_slice(), [IndexNotice::LexicalOnly(n)]
                    if n.detail == LexicalOnlyReason::EmbeddingProfileUnavailable));
            } else {
                assert!(notices.is_empty());
            }
            no_leases(&f);
            mode
        };
        for (admission_ms, reply_ms, budget_secs, expected, dispatched) in [
            // Admission plus healthy response exceeds eight seconds. The
            // provider itself needs only 2.5 s, so the query remains hybrid.
            (6500, 2500, 60, SearchMode::Hybrid, 1),
            // Exhaust the search share entirely in credential admission.
            (11000, 0, 12, SearchMode::Lexical, 0),
            // Admission leaves less than the full target budget: lexical
            // fallback is correct, but this timeout cannot blame the target.
            (6500, 5000, 12, SearchMode::Lexical, 1),
        ] {
            keys.delay.set(Duration::from_millis(admission_ms));
            http.delay.set(Duration::from_millis(reply_ms));
            let reads = keys.reads.get();
            let calls = http.calls.get();
            assert_eq!(query(Duration::from_secs(budget_secs)).await, expected);
            assert_eq!(keys.reads.get(), reads + 1);
            assert_eq!(http.calls.get(), calls + dispatched);
            keys.delay.set(Duration::ZERO);
            http.delay.set(Duration::ZERO);
            assert_eq!(
                query(Duration::from_secs(60)).await,
                SearchMode::Hybrid,
                "slow admission must not open the breaker (structured: {structured_method})"
            );
            assert_eq!(keys.reads.get(), reads + 2, "next query reads credentials");
            assert_eq!(
                http.calls.get(),
                calls + dispatched + 1,
                "next query reaches provider"
            );
        }
        // Conversely a provider that actually receives eight seconds and
        // never answers must open the breaker for this shared target.
        let calls = http.calls.get();
        let reads = keys.reads.get();
        http.delay.set(Duration::from_secs(9));
        assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Lexical);
        http.delay.set(Duration::ZERO);
        assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Lexical);
        assert_eq!(http.calls.get(), calls + 1, "open breaker skips HTTP");
        assert_eq!(keys.reads.get(), reads + 1, "open breaker skips admission");
        f.store.reset_query_breakers_for_tests();
        assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Hybrid);
        // Resolution is target I/O: resolve, connect and response share the
        // one eight-second target budget; admission alone stays outside it.
        // Both methods embed through the same `PinnedEgress::post` and
        // its one `target()` boundary; cover DNS once through plain search.
        if structured_method {
            continue;
        }
        let full = kb_local::breaker::QUERY_EMBEDDING_DEADLINE;
        for (admission_ms, dns_ms, reply_ms, expected) in [
            // Slow credentials plus a slow resolver: only DNS + HTTP count.
            (6500, Some(4000), 2500, SearchMode::Hybrid),
            // Each step alone fits; together they exceed the target budget.
            (0, Some(5000), 4000, SearchMode::Lexical),
            // A resolver that never answers.
            (0, None, 0, SearchMode::Lexical),
        ] {
            keys.delay.set(Duration::from_millis(admission_ms));
            dns.delay.set(dns_ms.map(Duration::from_millis));
            http.delay.set(Duration::from_millis(reply_ms));
            let (resolves, calls) = (dns.calls.get(), http.calls.get());
            let started = tokio::time::Instant::now();
            assert_eq!(
                query(Duration::from_secs(60)).await,
                expected,
                "dns {dns_ms:?} reply {reply_ms} (structured: {structured_method})"
            );
            let elapsed = started.elapsed();
            assert_eq!(dns.calls.get(), resolves + 1);
            assert_eq!(
                http.calls.get(),
                calls + usize::from(dns_ms.is_some()),
                "a stalled resolver never dispatches"
            );
            let admission = Duration::from_millis(admission_ms);
            if expected == SearchMode::Lexical {
                assert!(
                    elapsed >= admission + full
                        && elapsed < admission + full + Duration::from_secs(2),
                    "the target budget bounds resolution: {elapsed:?}"
                );
            }
            keys.delay.set(Duration::ZERO);
            dns.delay.set(Some(Duration::ZERO));
            http.delay.set(Duration::ZERO);
            let started = tokio::time::Instant::now();
            if expected == SearchMode::Lexical {
                // A full target timeout opened the breaker: the next query
                // is served lexically at once, without resolving or sending.
                assert_eq!(query(Duration::from_secs(60)).await, SearchMode::Lexical);
                assert_eq!(started.elapsed(), Duration::ZERO, "no provider wait");
                assert_eq!(dns.calls.get(), resolves + 1, "open breaker skips DNS");
                f.store.reset_query_breakers_for_tests();
            }
            let started = tokio::time::Instant::now();
            assert_eq!(
                query(Duration::from_secs(60)).await,
                SearchMode::Hybrid,
                "healthy query after dns {dns_ms:?} (structured: {structured_method})"
            );
            assert_eq!(started.elapsed(), Duration::ZERO, "no provider wait");
        }
    }
}

/// Review r5 #1: what must arrive within the target budget is the MCP
/// handler's reply, not merely its `block_on`. The resolver here blocks a
/// thread of the runtime's blocking pool and never answers in time, as a
/// stalled `getaddrinfo` under `tokio::net::lookup_host` does. A handler that
/// built and dropped a runtime per call would hold the reply until that
/// thread returned, because dropping a runtime waits for its blocking tasks.
#[test]
fn a_blocked_resolver_thread_does_not_hold_the_mcp_reply() {
    use kb_local::{
        credentials::{Credentials, Secret},
        dispatch::{Session, SessionIo},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture},
        embedder::ProviderControl,
        locks::CredentialFence,
        qwen::ModelRuntime,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    const STALL: Duration = Duration::from_secs(40);
    struct Keys;
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            panic!("search must use controlled credential admission")
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
        fn get_controlled<'a>(
            &'a self,
            _: &'a str,
            _: &'a ProviderControl,
            _: &'a CredentialFence,
        ) -> IoFuture<'a, Secret> {
            Box::pin(async { Ok(Secret::new("disposable-search-fixture".into())) })
        }
    }
    /// Blocks one blocking-pool thread for `STALL`, then answers.
    struct Blocked {
        calls: Arc<AtomicUsize>,
        returned: Arc<AtomicBool>,
    }
    impl Dns for Blocked {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let returned = self.returned.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    std::thread::sleep(STALL);
                    returned.store(true, Ordering::SeqCst);
                })
                .await
                .map_err(|_| StoreError::IndexUnavailable)?;
                Ok(vec!["8.8.8.8".parse().expect("fixture IP")])
            })
        }
    }
    struct Unreached;
    impl Http for Unreached {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            _: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            panic!("a stalled resolver never dispatches")
        }
    }
    // The session's one long-lived runtime, as `kb mcp` has.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
        "blocked-resolver-publish-0001",
    );
    rt.block_on(ready(&f));
    let host = model_host::seeded(&f.root.with_extension("model"), Duration::from_secs(5));
    let model = Arc::new(ModelRuntime::new(&f.store, host).expect("valid fixture"));
    let (calls, returned) = (
        Arc::new(AtomicUsize::new(0)),
        Arc::new(AtomicBool::new(false)),
    );
    let session = Session::new(
        rt.handle().clone(),
        &f.store,
        f.store.owner(),
        model,
        SessionIo {
            keys: Box::new(Keys),
            dns: Box::new(Blocked {
                calls: calls.clone(),
                returned: returned.clone(),
            }),
            http: Box::new(Unreached),
        },
    );
    let (client, server) = tokio::io::duplex(1 << 20);
    let (server_read, server_write) = tokio::io::split(server);
    let (client_read, mut client_write) = tokio::io::split(client);
    let kb = f.kb.clone();
    let (reply, elapsed) = rt.block_on(async move {
        let serving =
            kb_client::stdio::serve(server_read, server_write, move |name, input, control| {
                session.call(name, input, control, None)
            });
        let client = async move {
            let mut lines = BufReader::new(client_read).lines();
            let mut send = async |frame: serde_json::Value| {
                client_write
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .expect("request written");
            };
            send(json!({"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}})).await;
            lines.next_line().await.expect("discover reply");
            let started = std::time::Instant::now();
            send(
                json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
                "name":"knowledge_search","arguments":{"kbId":kb,"query":"alpha"}}}),
            )
            .await;
            let line = lines
                .next_line()
                .await
                .expect("reply read")
                .expect("reply line");
            let elapsed = started.elapsed();
            drop(client_write);
            let reply: serde_json::Value = serde_json::from_str(&line).expect("reply JSON");
            (reply, elapsed)
        };
        let (served, replied) = tokio::join!(serving, client);
        served.expect("session ends at EOF");
        replied
    });
    assert_eq!(reply["id"], 2, "{reply}");
    let budget = kb_local::breaker::QUERY_EMBEDDING_DEADLINE;
    assert!(
        elapsed >= budget && elapsed < budget + Duration::from_secs(2),
        "the reply arrives within the target budget: {elapsed:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        !returned.load(Ordering::SeqCst),
        "the resolver thread was still blocked when the reply arrived"
    );
    let result = &reply["result"];
    assert_eq!(result["isError"], false, "{reply}");
    assert_eq!(
        result.pointer("/structuredContent/data/results/0/mode"),
        Some(&json!("lexical")),
        "{reply}"
    );
    // Never wait for the abandoned blocking thread.
    rt.shutdown_background();
}

/// Round 7: `builtin` without a revision resolves the CURRENT configuration
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
    // L-25: the lexical arm alone ran; its first hit is the normalized maximum.
    assert_eq!(out.results[0].score, 1.);
    assert!(matches!(
        &out.index_notices[0],
        IndexNotice::RebuildPending(n) if n.detail == RebuildPendingReason::EmbeddingModelChanged
    ));
    no_leases(&f);
    drop(runtime);
}

/// Format v1 FTS (shared with the server): `unicode61 remove_diacritics 2`,
/// a punctuated word needs all of its alphanumeric runs, quoted text is an
/// exact phrase, bm25 order; in this hybrid search the lexical arm keeps
/// chunks matching a strict majority of the words.
#[tokio::test]
async fn fts_v1_folds_diacritics_ors_words_and_matches_phrases() {
    let f = Fixture::new(2);
    publish(
        &f,
        vec![
            ("index.md", Some(String::new())),
            ("art.md", Some("the art of state planning\n".into())),
            ("cafe.md", Some("café au lait\n".into())),
            ("mail.md", Some("write to user at example dot com\n".into())),
            ("other.md", Some("nothing relevant here\n".into())),
            ("pi.md", Some("pi is 3.14 roughly\n".into())),
        ],
        "search-fts-v1-corpus-0001",
    );
    ready(&f).await;
    for (query, matched) in [
        ("cafe", vec!["cafe.md"]),
        ("café", vec!["cafe.md"]),
        ("state-of-the-art", vec!["art.md"]),
        ("user@example.com", vec!["mail.md"]),
        ("3.14", vec!["pi.md"]),
        ("3.15", vec![]),
        // 1 of 2 words is no majority; 2 of 3 is.
        ("banana state", vec![]),
        ("banana state planning", vec!["art.md"]),
        ("\"state planning\"", vec!["art.md"]),
        ("\"planning state\"", vec![]),
    ] {
        let out = f
            .query(json!({"query": query, "limit": 20}))
            .await
            .expect("valid fixture");
        // Every chunk is in the vector arm (fewer than 80); only FTS matches
        // add a second reciprocal rank, so they score above one arm's
        // normalized maximum, 0.5 (L-25).
        let lexical = out
            .results
            .iter()
            .filter(|h| h.score > 0.5 + 1e-9)
            .map(|h| h.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(lexical, matched, "{query}");
    }
}

/// A KB without a usable profile is indexed FTS5-only and searched lexically.
async fn build_lexical(f: &Fixture, id: &KbId) {
    let a = f
        .store
        .claim_generation(id, Duration::from_secs(120))
        .expect("valid fixture");
    assert!(a.snapshot().is_lexical());
    let built = f
        .store
        .build_generation(
            a,
            async |_, _| -> Result<Vec<Vec<f64>>, StoreError> {
                panic!("a lexical build never embeds")
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("valid fixture");
    assert!(f.store.activate_built(built).expect("valid fixture"));
}
async fn lexical_query(f: &Fixture) -> SearchOutput {
    f.store
        .search_generation(
            &f.store.owner(),
            input(f, json!({})),
            &SearchControl::default(),
            async |_, _| -> Result<Vec<f64>, StoreError> {
                panic!("a lexical generation never embeds the query")
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("valid fixture")
}
fn lexical_notice(f: &Fixture, detail: LexicalOnlyReason) -> Vec<IndexNotice> {
    vec![IndexNotice::LexicalOnly(LexicalOnlyNotice {
        kb_id: f.kb.clone(),
        code: LexicalOnlyCode,
        detail,
    })]
}

#[tokio::test]
async fn profileless_kb_builds_activates_and_searches_a_lexical_generation() {
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
        "lexical-publish-0001",
    );
    let status = f.status();
    let desired = status.desired_generation_id.expect("scheduled lexical");
    assert_eq!(status.desired_state, Some(IndexState::Pending));
    let snapshot = f.store.generation_snapshot(&desired).expect("snapshot");
    assert!(snapshot.is_lexical() && snapshot.profile.is_none());
    build_lexical(&f, &desired).await;

    // The file has no vector tables and null profile columns in `meta`.
    let file = rusqlite::Connection::open_with_flags(
        f.store.paths().index_file(&f.kb, &desired),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("lexical file");
    let meta: (
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<f64>,
        i64,
    ) = file
        .query_row(
            "SELECT fingerprint,dimensions,quantization,int8_scale,format FROM meta",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .expect("meta");
    assert_eq!(meta, (None, None, None, None, 1));
    let vector_tables: i64 = file
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('chunk_vec','chunk_bits','chunk_int8')",
            [],
            |r| r.get(0),
        )
        .expect("schema");
    assert_eq!(vector_tables, 0);
    drop(file);

    let status = f.status();
    assert_eq!(status.active_generation_id, Some(desired.clone()));
    assert_eq!(status.freshness, Freshness::Current);
    assert_eq!(
        (status.dimensions, status.fingerprint, status.error_code),
        (None, None, None)
    );
    let out = lexical_query(&f).await;
    check::<KnowledgeSearch>(&out);
    assert!(!out.results.is_empty());
    assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
    assert_eq!(
        out.index_notices,
        lexical_notice(&f, LexicalOnlyReason::NoEmbeddingProfile)
    );
    // Queryless structured pages rank nothing: no notice. A query gets one.
    let page = f.filter(json!({"title":"Index"})).await.expect("page");
    assert!(page.index_notices.is_empty());
    let page = f.filter(json!({"query":"alpha"})).await.expect("page");
    check::<StructuredSearch>(&page);
    assert!(page.items.iter().all(|h| h.mode == SearchMode::Lexical));
    assert_eq!(
        page.index_notices,
        lexical_notice(&f, LexicalOnlyReason::NoEmbeddingProfile)
    );
    no_leases(&f);

    // Attaching a profile supersedes it by epoch; the lexical generation keeps
    // serving while the hybrid desired generation is pending: "building".
    let job = f.set("lexical-profile-0001");
    assert!(
        !f.store
            .generation_snapshot(&job.generation_id)
            .expect("snapshot")
            .is_lexical()
    );
    assert_eq!(f.status().active_generation_id, Some(desired.clone()));
    assert_eq!(
        lexical_query(&f).await.index_notices,
        lexical_notice(&f, LexicalOnlyReason::SemanticIndexBuilding)
    );
    // Once that hybrid build fails (its revision stopped being READY), the
    // profile is set and unrevoked but unusable: "unavailable".
    f.db()
        .execute(
            "UPDATE provider_revisions SET state='FAILED' WHERE provider_id=?1",
            [f.provider.as_str()],
        )
        .expect("unready revision");
    assert!(
        f.store
            .claim_generation(&job.generation_id, Duration::from_secs(60))
            .is_err()
    );
    assert_eq!(f.status().desired_state, Some(IndexState::Failed));
    assert_eq!(f.status().active_generation_id, Some(desired));
    assert_eq!(
        lexical_query(&f).await.index_notices,
        lexical_notice(&f, LexicalOnlyReason::EmbeddingProfileUnavailable)
    );
    no_leases(&f);
}

#[tokio::test]
async fn revoked_profile_publications_schedule_lexical_generations() {
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha body".into()))],
        "revoked-publish-0001",
    );
    ready(&f).await;
    f.db()
        .execute(
            "UPDATE providers SET revoked=1 WHERE id=?1",
            [f.provider.as_str()],
        )
        .expect("revoke");
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha body two".into()))],
        "revoked-publish-0002",
    );
    let desired = f.status().desired_generation_id.expect("scheduled");
    build_lexical(&f, &desired).await;
    let out = lexical_query(&f).await;
    assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
    assert_eq!(
        out.index_notices,
        lexical_notice(&f, LexicalOnlyReason::EmbeddingProfileRevoked)
    );
    no_leases(&f);
}

#[tokio::test]
async fn index_rebuild_without_a_usable_profile_schedules_a_lexical_generation() {
    let f = Fixture::new(2);
    let rebuild = |key: &str| {
        f.store
            .index_rebuild(
                &f.store.owner(),
                serde_json::from_value(json!({"kbId":f.kb,"idempotencyKey":key,"confirm":"RUN"}))
                    .expect("valid fixture"),
            )
            .expect("lexical rebuild receipt")
    };
    // No profile: a PENDING lexical receipt (server parity).
    let job = rebuild("lexical-rebuild-0001");
    check::<IndexRebuild>(&job);
    assert_eq!(
        f.status().desired_generation_id,
        Some(job.generation_id.clone())
    );
    build_lexical(&f, &job.generation_id).await;
    assert_eq!(
        lexical_query(&f).await.index_notices,
        lexical_notice(&f, LexicalOnlyReason::NoEmbeddingProfile)
    );
    no_leases(&f);
    // A revoked user profile: lexical too, and the profile pin is kept.
    ready(&f).await;
    f.db()
        .execute(
            "UPDATE providers SET revoked=1 WHERE id=?1",
            [f.provider.as_str()],
        )
        .expect("revoke");
    let job = rebuild("lexical-rebuild-0002");
    build_lexical(&f, &job.generation_id).await;
    assert_eq!(
        lexical_query(&f).await.index_notices,
        lexical_notice(&f, LexicalOnlyReason::EmbeddingProfileRevoked)
    );
    no_leases(&f);
}

/// L-7: revoking the provider in use serves the hybrid file's FTS5 arm at
/// once (`EMBEDDING_PROFILE_REVOKED`, never INDEX_UNAVAILABLE) and schedules a
/// lexical-only generation in the revocation transaction.
#[tokio::test]
async fn provider_revoke_serves_lexically_and_schedules_a_lexical_generation() {
    use kb_local::credentials::{Credentials, Secret};
    struct Keys;
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            Err(StoreError::NotFound)
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
    }
    let f = Fixture::new(2);
    let hybrid = ready(&f).await;
    f.store
        .provider_revoke(&f.store.owner(), &f.provider, &Keys)
        .expect("revoke");
    let status = f.status();
    assert_eq!(status.active_generation_id, Some(hybrid.clone()));
    assert_ne!(status.freshness, Freshness::Unavailable);
    let desired = status.desired_generation_id.expect("scheduled");
    assert_ne!(desired, hybrid);
    assert!(
        f.store
            .generation_snapshot(&desired)
            .expect("snapshot")
            .is_lexical()
    );
    let out = lexical_query(&f).await;
    assert_eq!(out.generation_id, hybrid);
    assert!(out.results.iter().all(|h| h.mode == SearchMode::Lexical));
    assert_eq!(
        out.index_notices,
        lexical_notice(&f, LexicalOnlyReason::EmbeddingProfileRevoked)
    );
    no_leases(&f);
    build_lexical(&f, &desired).await;
    let out = lexical_query(&f).await;
    assert_eq!(out.generation_id, desired);
    assert_eq!(
        out.index_notices,
        lexical_notice(&f, LexicalOnlyReason::EmbeddingProfileRevoked)
    );
    no_leases(&f);
}

/// Pending generation of `f.kb` other than `desired` (the lexical companion).
fn companion_of(f: &Fixture, desired: &KbId) -> KbId {
    let raw: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND state='PENDING' AND id<>?2",
            (f.kb.as_str(), desired.as_str()),
            |r| r.get(0),
        )
        .expect("companion");
    let id = KbId::parse(&raw).expect("id");
    let s = f.store.generation_snapshot(&id).expect("snapshot");
    assert!(s.is_lexical(), "the companion is lexical-only");
    id
}

/// Class: no window in a semantic build's life leaves a KB without a
/// lexical index — first build pending, building, failed; a replacement that
/// arrives late; a crash between completion and activation.
#[tokio::test]
async fn a_semantic_build_never_leaves_a_kb_without_a_lexical_index() {
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
        "always-lexical-publish-0001",
    );
    // The create's lexical job never ran; the profile set supersedes it.
    let job = f.set_raw("always-lexical-profile-01");
    let companion = companion_of(&f, &job.generation_id);
    assert_eq!(
        f.store.pending_generation(None).expect("scan"),
        Some(companion.clone()),
        "the companion is built first"
    );
    // Completed but not activated (a crash): recovery activates it.
    let a = f
        .store
        .claim_generation(&companion, Duration::from_secs(120))
        .expect("claim");
    drop(
        f.store
            .build_generation(
                a,
                async |_, _| -> Result<Vec<Vec<f64>>, StoreError> { panic!("lexical") },
                &mut |_| Ok(()),
            )
            .await
            .expect("built"),
    );
    drop(f.store.lock_write(&[]).expect("recovery"));
    let status = f.status();
    assert_eq!(status.active_generation_id, Some(companion.clone()));
    assert_eq!(status.freshness, Freshness::Building);
    assert_eq!(
        lexical_query(&f).await.index_notices,
        lexical_notice(&f, LexicalOnlyReason::SemanticIndexBuilding)
    );
    // The semantic build fails: the companion keeps serving.
    let a = f
        .store
        .claim_generation(&job.generation_id, Duration::from_secs(120))
        .expect("claim");
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
    assert_eq!(f.status().desired_state, Some(IndexState::Failed));
    let out = lexical_query(&f).await;
    assert_eq!(out.generation_id, companion);
    assert!(!out.results.is_empty());
    no_leases(&f);
}

/// The semantic build depends on its companion explicitly, whatever the
/// order the worker meets them in: it is not claimable (so never holds the KB
/// permit through embedding) until the companion is built, and a companion
/// that arrives while a scan is already past the lexical part is still reached.
#[tokio::test]
async fn a_semantic_claim_waits_for_its_companion_in_any_delivery_order() {
    let f = Fixture::new(2);
    let job = f.set_raw("companion-order-profile1");
    let companion = companion_of(&f, &job.generation_id);
    // Reversed delivery: the semantic job is met first.
    assert!(matches!(
        f.store
            .claim_generation(&job.generation_id, Duration::from_secs(120)),
        Err(StoreError::RateLimited(_))
    ));
    // A scan whose cursor is past every lexical generation still wraps to it.
    let mut after = Some(job.generation_id.clone());
    let mut reached = false;
    for _ in 0..4 {
        match f.store.pending_generation(after.as_ref()).expect("scan") {
            Some(id) if id == companion => {
                reached = true;
                break;
            }
            next => after = next,
        }
    }
    assert!(reached, "the companion is reached within one wrap");
    build_lexical(&f, &companion).await;
    assert!(
        f.store
            .activate_built(f.build(&job.generation_id).await)
            .expect("semantic")
    );
    assert_eq!(f.status().active_generation_id, Some(job.generation_id));
}

/// A lost active file (cleanup, disk repair) reschedules a lexical
/// companion so the KB is searchable long before its semantic rebuild.
#[tokio::test]
async fn a_lost_active_file_is_replaced_by_a_lexical_companion_first() {
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha keyword body".into()))],
        "lost-file-publish-0001",
    );
    let hybrid = ready(&f).await;
    std::fs::remove_file(f.store.paths().index_file(&f.kb, &hybrid)).expect("lose the file");
    drop(f.store.lock_write(&[]).expect("reconcile"));
    let status = f.status();
    let desired = status.desired_generation_id.expect("rebuild");
    // What still serves meanwhile is at most a keyword index of the head
    // (the earlier companion), never the lost hybrid.
    assert_ne!(status.active_generation_id, Some(hybrid.clone()));
    if let Some(active) = &status.active_generation_id {
        assert!(
            f.store
                .generation_snapshot(active)
                .expect("snapshot")
                .is_lexical()
        );
    }
    let lexical = status
        .active_generation_id
        .expect("retained lexical companion");
    let count = || -> i64 {
        f.db().query_row("SELECT count(*) FROM index_generations WHERE kb_id=?1 AND json_type(snapshot_json,'$.profile') IS NOT 'object'", [f.kb.as_str()], |r| r.get(0)).expect("count")
    };
    let before = count();
    assert_eq!(
        f.store.pending_generation(None).expect("scan"),
        Some(desired.clone()),
        "only semantic work is queued"
    );
    for _ in 0..3 {
        let out = lexical_query(&f).await;
        assert_eq!(out.generation_id, lexical);
        assert_eq!(
            out.index_notices,
            lexical_notice(&f, LexicalOnlyReason::SemanticIndexBuilding)
        );
        build_semantic(&f, &f.status().desired_generation_id.expect("desired")).await;
        let active = f.status().active_generation_id.expect("hybrid");
        std::fs::remove_file(f.store.paths().index_file(&f.kb, &active)).expect("lose hybrid");
        drop(f.store.lock_write(&[]).expect("reconcile"));
        assert_eq!(f.status().active_generation_id, Some(lexical.clone()));
        assert_eq!(
            count(),
            before,
            "reuse instead of accumulating identical companions"
        );
    }
}

/// Structured-search cursors pin the page's ranking mode: a keyword-ranked
/// first page (embedder failing) continues keyword-ranked after the embedder
/// recovered; a hybrid-ranked page whose continuation can only rank by
/// keyword is refused (INVALID_CURSOR: the caller restarts the search).
#[tokio::test]
async fn structured_cursors_keep_their_ranking_mode_across_failure_and_recovery() {
    let f = Fixture::new(2);
    publish(
        &f,
        (0..6)
            .map(|i| {
                (
                    ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"][i],
                    Some(format!("alpha note {i}\n")),
                )
            })
            .collect(),
        "cursor-mode-publish-001",
    );
    ready(&f).await;
    let page = async |extra: serde_json::Value, failing: bool| {
        f.store
            .structured_search_generation(
                &f.store.owner(),
                structured(&f, extra),
                &SearchControl::default(),
                async |_, _| {
                    if failing {
                        Err(StoreError::EmbeddingFailed)
                    } else {
                        Ok(vec![1.; 2])
                    }
                },
                &mut |_| Ok(()),
            )
            .await
    };
    // Failure, then recovery: every page stays keyword-ranked, none repeats.
    let first = page(json!({"query":"alpha","limit":2}), true)
        .await
        .expect("page 1");
    assert!(first.items.iter().all(|h| h.mode == SearchMode::Lexical));
    let mut seen = first
        .items
        .iter()
        .map(|h| h.path.to_string())
        .collect::<Vec<_>>();
    let mut cursor = first.next_cursor.expect("more pages");
    loop {
        let next = page(json!({"query":"alpha","limit":2,"cursor":cursor}), false)
            .await
            .expect("keyword continuation after recovery");
        assert!(next.items.iter().all(|h| h.mode == SearchMode::Lexical));
        assert!(matches!(
            next.index_notices.as_slice(),
            [IndexNotice::LexicalOnly(_)]
        ));
        for h in &next.items {
            assert!(!seen.contains(&h.path.to_string()), "no repeated hit");
            seen.push(h.path.to_string());
        }
        match next.next_cursor {
            Some(c) => cursor = c,
            None => break,
        }
    }
    assert_eq!(seen.len(), 6);
    f.store.reset_query_breakers_for_tests();
    // Hybrid first page, then the embedder fails: the continuation is refused.
    let first = page(json!({"query":"alpha","limit":2}), false)
        .await
        .expect("page 1");
    assert!(first.items.iter().all(|h| h.mode == SearchMode::Hybrid));
    let refused = page(
        json!({"query":"alpha","limit":2,"cursor":first.next_cursor.expect("more")}),
        true,
    )
    .await
    .expect_err("hybrid keys cannot continue in keyword ranking");
    assert_eq!(refused.protocol_code(), ErrorCode::InvalidCursor);
    no_leases(&f);
}

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

/// R3-L8: an unreadable active index file heals like a deleted one: the
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
            // Intact SQLite, broken index contract (review #4): metadata, or
            // stored vectors of the wrong width (review r2 #2).
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

/// Review #4: a failure that proves nothing about the file (here it cannot
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

/// R3-L9 (review #2): `kb model remove` is never refused by stores that
/// enabled the model, like the server's Remove: both stores serve their
/// keyword arm with EMBEDDING_PROFILE_UNAVAILABLE while it is gone, and
/// return to hybrid with the same generation once it is downloaded again.
#[tokio::test]
async fn removing_a_model_two_stores_enabled_degrades_both_until_it_returns() {
    use kb_local::{
        index::IndexEmbedder,
        qwen::{ModelConfiguration, ModelRuntime, descriptor},
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

/// Review r2 #4: effective availability sees the model file. A removal
/// between the query embedding and the return re-ranks by keyword (ordinary
/// and structured), and profile/provider status say unavailable until the
/// file is back, then ready again.
#[tokio::test]
async fn a_removal_during_a_search_degrades_it_and_status_follows_the_file() {
    use kb_local::qwen::{ModelConfiguration, ModelRuntime, descriptor};
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

#[tokio::test]
async fn structured_search_recovers_a_corrupt_page_on_its_first_request() {
    let f = Fixture::new(2);
    publish(
        &f,
        vec![("index.md", Some("# Index\n\nalpha body".into()))],
        "structured-corrupt-page",
    );
    let active = ready(&f).await;
    let path = f.store.paths().index_file(&f.kb, &active);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("writable");
    }
    rusqlite::Connection::open(&path)
        .expect("index")
        .execute_batch("UPDATE chunk_int8 SET e=substr(e,1,1)")
        .expect("damage");
    let out = f
        .filter(json!({"query":"alpha"}))
        .await
        .expect("first request heals");
    assert_ne!(out.generation_id, active);
    assert!(!out.items.is_empty());
    assert!(out.items.iter().all(|hit| hit.mode == SearchMode::Lexical));
    no_leases(&f);
}

/// Admission can change the active ID through completion recovery or a
/// concurrent activation. The retry belongs to the generation actually read.
#[tokio::test]
async fn a_newly_admitted_corrupt_generation_heals_on_the_first_request() {
    for structured_query in [false, true] {
        for transition in ["completion-recovery", "activation", "open-failure"] {
            let recovery = transition == "completion-recovery";
            let open_failure = transition == "open-failure";
            let f = Fixture::new(2);
            publish(
                &f,
                vec![("index.md", Some("# Index\n\nalpha body".into()))],
                "admission-repair-doc",
            );
            let a = ready(&f).await;
            let b = f.rebuild("admission-repair-rebuild").generation_id;
            let mut completed = Some(f.build(&b).await);
            let path = f.store.paths().index_file(&f.kb, &b);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .expect("writable");
            }
            if !open_failure {
                rusqlite::Connection::open(&path)
                    .expect("index")
                    .execute_batch("UPDATE chunk_int8 SET e=substr(e,1,1)")
                    .expect("damage");
            }
            assert_eq!(
                f.store
                    .kb(&f.kb)
                    .expect("kb")
                    .expect("kb")
                    .active_generation_id,
                Some(a.clone())
            );
            if recovery {
                // Release the completion permit, allowing admission itself
                // to recover B. Do not reopen the store or sample status.
                drop(completed.take());
            }
            let mut admissions = 0;
            let mut pins = vec![];
            let mut observer = |stage| {
                if stage == SearchStage::BeforeAdmission {
                    admissions += 1;
                    if let Some(built) = completed.take() {
                        assert!(
                            f.store
                                .activate_built(built)
                                .expect("activate between read and admission")
                        );
                        if open_failure {
                            // A broken snapshot is rejected while opening B,
                            // before a Pin or query charge exists.
                            rusqlite::Connection::open(&path)
                                .expect("index")
                                .execute_batch("UPDATE meta SET host_snapshot='{}'")
                                .expect("damage meta");
                        }
                    }
                }
                if stage == SearchStage::Pinned {
                    pins.push(
                        f.store
                            .kb(&f.kb)
                            .expect("kb")
                            .expect("kb")
                            .active_generation_id
                            .expect("active"),
                    );
                }
                Ok(())
            };
            let ctl = SearchControl::default();
            let (generation, hits) = if structured_query {
                let out = f
                    .store
                    .structured_search_generation(
                        &f.store.owner(),
                        structured(&f, json!({"query":"alpha"})),
                        &ctl,
                        async |_, text| Ok(vector(text)),
                        &mut observer,
                    )
                    .await
                    .expect("first structured request heals B");
                (out.generation_id, out.items)
            } else {
                let out = f
                    .store
                    .search_generation(
                        &f.store.owner(),
                        input(&f, json!({})),
                        &ctl,
                        async |_, text| Ok(vector(text)),
                        &mut observer,
                    )
                    .await
                    .expect("first ordinary request heals B");
                (out.generation_id, out.results)
            };
            assert_ne!(generation, a);
            assert_ne!(generation, b);
            assert!(!hits.is_empty());
            assert!(hits.iter().all(|h| h.mode == SearchMode::Lexical));
            assert_eq!(admissions, 2);
            assert_eq!(
                pins,
                if open_failure {
                    vec![generation]
                } else {
                    vec![b.clone(), generation]
                }
            );
            let (state, code): (String, String) = f
                .db()
                .query_row(
                    "SELECT state,error_code FROM index_generations WHERE id=?1",
                    [b.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .expect("B retired");
            assert_eq!(
                (state.as_str(), code.as_str()),
                ("FAILED", "INDEX_FILE_LOST")
            );
            let charges: i64 = f
                .db()
                .query_row(
                    "SELECT count(*) FROM query_charges WHERE kb_id=?1",
                    [f.kb.as_str()],
                    |r| r.get(0),
                )
                .expect("charges");
            assert_eq!(
                charges,
                if open_failure { 1 } else { 2 },
                "each successful pin charges the query afresh"
            );
            no_leases(&f);
        }
    }
}

#[tokio::test]
async fn unavailability_without_a_repair_never_retries() {
    let f = Fixture::new(2);
    let active = ready(&f).await;
    for structured_query in [false, true] {
        let mut admissions = 0;
        let mut observer = |stage| {
            if stage == SearchStage::BeforeAdmission {
                admissions += 1;
            }
            if stage == SearchStage::Pinned {
                return Err(StoreError::IndexUnavailable);
            }
            Ok(())
        };
        let ctl = SearchControl::default();
        let error = if structured_query {
            f.store
                .structured_search_generation(
                    &f.store.owner(),
                    structured(&f, json!({"query":"alpha"})),
                    &ctl,
                    async |_, text| Ok(vector(text)),
                    &mut observer,
                )
                .await
                .expect_err("unrepaired failure")
        } else {
            f.store
                .search_generation(
                    &f.store.owner(),
                    input(&f, json!({})),
                    &ctl,
                    async |_, text| Ok(vector(text)),
                    &mut observer,
                )
                .await
                .expect_err("unrepaired failure")
        };
        assert_eq!(error.protocol_code(), ErrorCode::IndexUnavailable);
        assert_eq!(admissions, 1);
        assert_eq!(f.status().active_generation_id, Some(active.clone()));
        no_leases(&f);
    }
}

async fn search_observed(
    f: &Fixture,
    structured_query: bool,
    ctl: &SearchControl,
    observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
) -> Result<(KbId, Vec<CitationHit>), StoreError> {
    if structured_query {
        let out = f
            .store
            .structured_search_generation(
                &f.store.owner(),
                structured(f, json!({"query":"alpha","cursor":null})),
                ctl,
                async |_, text| Ok(vector(text)),
                observer,
            )
            .await?;
        Ok((out.generation_id, out.items))
    } else {
        let out = f
            .store
            .search_generation(
                &f.store.owner(),
                input(f, json!({})),
                ctl,
                async |_, text| Ok(vector(text)),
                observer,
            )
            .await?;
        Ok((out.generation_id, out.results))
    }
}

fn damage_generation(f: &Fixture, id: &KbId, header: bool) {
    let path = f.store.paths().index_file(&f.kb, id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("writable");
    }
    if header {
        // Damage allocated pages too, so the read cannot rely on cached meta.
        let bytes = std::fs::metadata(&path).expect("index").len() as usize;
        std::fs::write(path, vec![0; bytes]).expect("damage header and pages");
    } else {
        rusqlite::Connection::open(path)
            .expect("index")
            .execute_batch("UPDATE chunk_int8 SET e=substr(e,1,1)")
            .expect("damage vectors");
    }
}

fn assert_generation_lost(f: &Fixture, id: &KbId) {
    let (state, code): (String, Option<String>) = f
        .db()
        .query_row(
            "SELECT state,error_code FROM index_generations WHERE id=?1",
            [id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("generation");
    assert_eq!(
        (state.as_str(), code.as_deref()),
        ("FAILED", Some("INDEX_FILE_LOST"))
    );
}

/// Reconciliation can repair the pinned file at every live fence, including
/// the final fence after all SQLite work has already succeeded. Both entry
/// points must carry that repair to the same fresh-admission boundary.
#[tokio::test]
async fn recovery_after_pin_retries_both_search_entry_points() {
    for structured_query in [false, true] {
        for barrier in [
            SearchStage::Pinned,
            SearchStage::BeforeDispatch,
            SearchStage::AfterEmbedding,
            SearchStage::Eligible {
                documents: 1,
                decoded_rows: 0,
                chunks: 1,
                row_links: 0,
            },
            SearchStage::Vector,
            SearchStage::Fts,
            SearchStage::BeforeReturn,
        ] {
            let f = Fixture::new(2);
            publish(
                &f,
                vec![("index.md", Some("# Index\n\nalpha body".into()))],
                "recovery-after-pin-doc",
            );
            let a = ready(&f).await;
            let mut admissions = 0;
            let mut damaged = false;
            let (generation, hits) = search_observed(
                &f,
                structured_query,
                &SearchControl::default(),
                &mut |stage| {
                    if stage == SearchStage::BeforeAdmission {
                        admissions += 1;
                        no_leases(&f);
                    }
                    if !damaged
                        && std::mem::discriminant(&stage) == std::mem::discriminant(&barrier)
                    {
                        damage_generation(&f, &a, true);
                        damaged = true;
                        // No explicit recovery: the next production live
                        // check's lock_write must detect and carry the repair.
                    }
                    Ok(())
                },
            )
            .await
            .unwrap_or_else(|e| panic!("{structured_query}/{barrier:?}: first request heals: {e}"));
            assert!(damaged);
            assert_ne!(generation, a);
            assert!(!hits.is_empty());
            assert!(hits.iter().all(|h| h.mode == SearchMode::Lexical));
            assert_eq!(admissions, 2);
            assert_generation_lost(&f, &a);
            let charges: i64 = f
                .db()
                .query_row("SELECT count(*) FROM query_charges", [], |r| r.get(0))
                .expect("charges");
            assert_eq!(charges, 2, "retry charges a fresh successful admission");
            no_leases(&f);
        }
    }
}

/// A healthy same-head B can supersede A after pinning, explicitly or through
/// completion recovery. A's later distance-query failure must diagnose and
/// retire A alone, then retry on B without scheduling a needless replacement.
#[tokio::test]
async fn activation_after_pin_retries_only_the_corrupt_leased_generation() {
    for structured_query in [false, true] {
        for recovered_completion in [false, true] {
            let f = Fixture::new(2);
            publish(
                &f,
                vec![("index.md", Some("# Index\n\nalpha body".into()))],
                "activation-after-pin-doc",
            );
            let a = ready(&f).await;
            let b = f.rebuild("activation-after-pin-rebuild").generation_id;
            let mut completed = Some(f.build(&b).await);
            let mut admissions = 0;
            let mut pins = vec![];
            let (generation, hits) = search_observed(
                &f,
                structured_query,
                &SearchControl::default(),
                &mut |stage| {
                    if stage == SearchStage::BeforeAdmission {
                        admissions += 1;
                        no_leases(&f);
                    }
                    if stage == SearchStage::Pinned {
                        pins.push(f.store.kb(&f.kb)?.expect("kb").active_generation_id);
                    }
                    if stage == SearchStage::Vector
                        && let Some(built) = completed.take()
                    {
                        damage_generation(&f, &a, false);
                        if recovered_completion {
                            // The following live check recovers and activates
                            // B before the vector query discovers A's damage.
                            drop(built);
                        } else {
                            assert!(f.store.activate_built(built).expect("activate B"));
                        }
                    }
                    Ok(())
                },
            )
            .await
            .expect("first request retries its corrupt lease onto B");
            assert_eq!(generation, b);
            assert!(!hits.is_empty());
            assert!(hits.iter().all(|h| h.mode == SearchMode::Hybrid));
            assert_eq!(admissions, 2);
            assert_eq!(pins, [Some(a.clone()), Some(b.clone())]);
            assert_generation_lost(&f, &a);
            let status = f.status();
            assert_eq!(status.active_generation_id, Some(b.clone()));
            assert_eq!(status.desired_generation_id, Some(b.clone()));
            assert_eq!(status.freshness, Freshness::Current);
            let (state, code): (String, Option<String>) = f
                .db()
                .query_row(
                    "SELECT state,error_code FROM index_generations WHERE id=?1",
                    [b.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .expect("B remains healthy");
            assert_eq!((state.as_str(), code), ("COMPLETE", None));
            let charges: i64 = f
                .db()
                .query_row("SELECT count(*) FROM query_charges", [], |r| r.get(0))
                .expect("charges");
            assert_eq!(charges, 2);
            no_leases(&f);
        }
    }
}

#[tokio::test]
async fn a_repair_retry_is_once_and_uses_fresh_admission_and_the_original_control() {
    for structured_query in [false, true] {
        for stop in ["second-corruption", "cancellation", "query-budget"] {
            let f = Fixture::new(2);
            publish(
                &f,
                vec![("index.md", Some("# Index\n\nalpha body".into()))],
                "repair-retry-budget-doc",
            );
            let a = ready(&f).await;
            let ctl = SearchControl::default();
            let mut admissions = 0;
            let mut damaged = 0;
            let error = search_observed(&f, structured_query, &ctl, &mut |stage| {
                if stage == SearchStage::BeforeAdmission {
                    admissions += 1;
                    no_leases(&f);
                    if admissions == 2 {
                        match stop {
                            "cancellation" => ctl.cancel(),
                            "query-budget" => {
                                // Exhaust the shared budget after repair but
                                // before the retry's fresh charging transaction.
                                let db = f.db();
                                let tx = db.unchecked_transaction()?;
                                for i in 1..kb_local::limits::LOCAL_QUERIES_PER_MINUTE_PER_KB {
                                    tx.execute(
                                        "INSERT INTO query_charges VALUES(?1,?2,?3,?4)",
                                        rusqlite::params![
                                            format!("repair-retry-charge-{i}"),
                                            f.store.owner().actor_key(),
                                            f.kb.as_str(),
                                            now_ms() as i64,
                                        ],
                                    )?;
                                }
                                tx.commit()?;
                            }
                            _ => {}
                        }
                    }
                }
                if admissions == 1 && stage == SearchStage::Vector {
                    damage_generation(&f, &a, true);
                    damaged += 1;
                } else if admissions == 2 && stage == SearchStage::Fts {
                    let active = f
                        .store
                        .kb(&f.kb)?
                        .expect("kb")
                        .active_generation_id
                        .expect("active");
                    damage_generation(&f, &active, true);
                    damaged += 1;
                }
                Ok(())
            })
            .await
            .expect_err("a second repair cannot retry; fresh admission can refuse");
            assert_eq!(admissions, 2);
            assert_eq!(
                error.protocol_code(),
                match stop {
                    "cancellation" => ErrorCode::Cancelled,
                    "query-budget" => ErrorCode::RateLimited,
                    _ => ErrorCode::IndexUnavailable,
                }
            );
            assert_eq!(damaged, if stop == "second-corruption" { 2 } else { 1 });
            no_leases(&f);
        }
    }
}

/// A concurrent repair does not turn an unrelated failure into a retry.
#[tokio::test]
async fn independent_failures_do_not_retry_even_if_the_lease_was_repaired() {
    type Failure = fn() -> StoreError;
    let cases: [(Failure, ErrorCode); 6] = [
        (|| StoreError::IndexUnavailable, ErrorCode::IndexUnavailable),
        (|| StoreError::Forbidden, ErrorCode::Forbidden),
        (
            || StoreError::StorageUnavailable("fixture".into()),
            ErrorCode::StorageUnavailable,
        ),
        (|| StoreError::DeadlineExceeded, ErrorCode::DeadlineExceeded),
        (
            || {
                StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
                    None,
                ))
            },
            ErrorCode::IndexUnavailable,
        ),
        (
            || {
                StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                    None,
                ))
            },
            ErrorCode::IndexUnavailable,
        ),
    ];
    for structured_query in [false, true] {
        for at_embedding in [false, true] {
            for (fail, expected) in cases {
                let f = Fixture::new(2);
                let a = ready(&f).await;
                let repair = || -> Result<(), StoreError> {
                    damage_generation(&f, &a, true);
                    drop(f.store.lock_write(std::slice::from_ref(&f.kb))?);
                    assert_generation_lost(&f, &a);
                    Ok(())
                };
                let mut admissions = 0;
                let mut observer = |stage| {
                    if stage == SearchStage::BeforeAdmission {
                        admissions += 1;
                    }
                    if !at_embedding && stage == SearchStage::Vector {
                        repair()?;
                        return Err(fail());
                    }
                    Ok(())
                };
                let mut embed = async |_: &kb_local::generations::ProfileSnapshot, text: &str| {
                    if at_embedding {
                        repair()?;
                        Err(fail())
                    } else {
                        Ok(vector(text))
                    }
                };
                let ctl = SearchControl::default();
                let error = if structured_query {
                    f.store
                        .structured_search_generation(
                            &f.store.owner(),
                            structured(&f, json!({"query":"alpha"})),
                            &ctl,
                            &mut embed,
                            &mut observer,
                        )
                        .await
                        .expect_err("independent embedding or read failure")
                } else {
                    f.store
                        .search_generation(
                            &f.store.owner(),
                            input(&f, json!({})),
                            &ctl,
                            &mut embed,
                            &mut observer,
                        )
                        .await
                        .expect_err("independent embedding or read failure")
                };
                assert_eq!(error.protocol_code(), expected);
                assert_eq!(admissions, 1);
                no_leases(&f);
            }
        }
    }
}

#[tokio::test]
async fn repaired_structured_continuations_never_repin() {
    for recovery in [false, true] {
        let f = Fixture::new(2);
        publish(
            &f,
            vec![
                ("index.md", Some("alpha first".into())),
                ("other.md", Some("alpha second".into())),
            ],
            "repair-cursor-docs",
        );
        let a = ready(&f).await;
        let first = f
            .filter(json!({"query":"alpha","limit":1}))
            .await
            .expect("first page");
        assert_eq!(first.generation_id, a);
        let b = f.rebuild("repair-cursor-rebuild").generation_id;
        let mut completed = Some(f.build(&b).await);
        let mut admissions = 0;
        let error = f
            .store
            .structured_search_generation(
                &f.store.owner(),
                structured(
                    &f,
                    json!({"query":"alpha","limit":1,"cursor":first.next_cursor.expect("more")}),
                ),
                &SearchControl::default(),
                async |_, text| Ok(vector(text)),
                &mut |stage| {
                    if stage == SearchStage::BeforeAdmission {
                        admissions += 1;
                    }
                    if stage == SearchStage::Vector {
                        damage_generation(&f, &a, recovery);
                        if !recovery {
                            assert!(
                                f.store
                                    .activate_built(completed.take().expect("completion"))?
                            );
                        }
                    }
                    Ok(())
                },
            )
            .await
            .expect_err("cursor cannot switch to a repaired generation");
        assert_eq!(error.protocol_code(), ErrorCode::InvalidCursor);
        assert_eq!(admissions, 1);
        assert_generation_lost(&f, &a);
        no_leases(&f);
    }
}

#[tokio::test]
async fn queryless_pages_carry_repairs_from_preparation_and_final_recovery() {
    for barrier in [SearchStage::Pinned, SearchStage::BeforeReturn] {
        let f = Fixture::new(2);
        publish(
            &f,
            vec![(
                "index.md",
                Some("---\ntitle: Index\n---\n# Index\n\nalpha body".into()),
            )],
            "queryless-repair-doc",
        );
        let a = ready(&f).await;
        let mut admissions = 0;
        let out = f
            .store
            .structured_search_generation(
                &f.store.owner(),
                structured(&f, json!({"title":"Index","cursor":null})),
                &SearchControl::default(),
                async |_, _| panic!("queryless pages never embed"),
                &mut |stage| {
                    if stage == SearchStage::BeforeAdmission {
                        admissions += 1;
                        no_leases(&f);
                    }
                    if admissions == 1 && stage == barrier {
                        damage_generation(&f, &a, true);
                    }
                    Ok(())
                },
            )
            .await
            .expect("queryless first page heals");
        assert_ne!(out.generation_id, a);
        assert!(!out.items.is_empty());
        assert!(out.items.iter().all(|h| h.mode == SearchMode::Structured));
        assert_eq!(admissions, 2);
        assert_generation_lost(&f, &a);
        no_leases(&f);
    }
}
