//! Hybrid ranking, citations, candidate caps and the swap/profile barriers of one search.

use super::*;

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
    // That search's own short budget timed out, which says nothing
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
        // A missing arm is a broken index contract, not a
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
        // First in both arms is the normalized maximum.
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
