//! Lexical (FTS5) search and lexical companion generations.

use super::*;

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
        // normalized maximum, 0.5.
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

/// Revoking the provider in use serves the hybrid file's FTS5 arm at
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
