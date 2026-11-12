//! Task 60: exact shared filters, immutable pages and fail-closed hybrid mode.
#[path = "support/search_fixture.rs"]
mod support;
use kb_client::{ErrorCode, types::*};
use kb_local::{
    StoreError,
    search::{SearchControl, SearchStage},
};
use serde_json::json;
use support::*;

#[tokio::test]
async fn large_valid_table_all_query_shapes_decode_once_and_reenter() {
    let f = Fixture::new(2);
    let cell = "alpha content payload words source span "
        .repeat(5)
        .trim()
        .to_owned();
    let body = format!(
        "---\ntype: roster\n---\n| n | c1 | c2 | c3 | c4 | c5 | c6 | c7 |\n|---|---|---|---|---|---|---|---|\n{}",
        (0..1000)
            .map(|n| format!("| {n} | {} |\n", [cell.as_str(); 7].join(" | ")))
            .collect::<String>()
    );
    assert!(body.len() > 1_000_000 && body.len() < 2 * 1024 * 1024);
    publish(
        &f,
        vec![("index.md", Some(String::new())), ("table.md", Some(body))],
        "large-search-table-0001",
    );
    ready(&f).await;
    let generation = f
        .status()
        .active_generation_id
        .expect("complete generation");
    let conn = rusqlite::Connection::open(f.store.paths().index_file(&f.kb, &generation))
        .expect("actual generation");
    let expected_chunks = conn
        .query_row(
            "SELECT count(*) FROM chunks WHERE path='table.md'",
            [],
            |r| r.get::<_, u32>(0),
        )
        .expect("source chunk count") as usize;
    assert!(expected_chunks > 500);
    for shape in 0..3 {
        let mut counts = vec![];
        let mut observe = |s| {
            if let SearchStage::Eligible {
                documents,
                decoded_rows,
                chunks,
                row_links,
            } = s
            {
                counts.push((documents, decoded_rows, chunks, row_links));
            }
            Ok(())
        };
        let hits = if shape == 0 {
            f.store
                .search_generation(
                    &f.store.owner(),
                    input(&f, json!({"pathPrefix":"table","limit":1})),
                    &SearchControl::default(),
                    async |_, text| Ok(vector(text)),
                    &mut observe,
                )
                .await
                .expect("large ordinary search within actual 60s deadline")
                .results
        } else {
            let mut extra = json!({"structured":[{"column":"c1","equals":cell}],"limit":1});
            if shape == 1 {
                extra["query"] = json!("alpha");
            }
            f.filter_as(&f.store.owner(), extra, &mut observe)
                .await
                .expect("large structured search within actual 60s deadline")
                .items
        };
        assert_eq!(
            counts.len(),
            1,
            "eligibility is shared, never repeated per arm/projection"
        );
        let (documents, decoded_rows, chunks, links) = counts[0];
        assert_eq!(documents, if shape == 0 { 1 } else { 2 });
        assert_eq!(
            decoded_rows,
            if shape == 0 { 0 } else { 1000 },
            "row decoding is document-wide and skipped without row predicates"
        );
        assert_eq!(chunks, expected_chunks);
        assert!(
            links > 0 && links <= 1000 + 2 * chunks,
            "bounded overlap links without row JSON copies"
        );
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        assert_eq!(
            hit.mode,
            if shape == 2 {
                SearchMode::Structured
            } else {
                SearchMode::Hybrid
            }
        );
        assert_eq!(hit.matched_row.is_some(), shape != 0);
        let source = f.cited(hit);
        assert_eq!(
            hit.content_hash,
            kb_client::snapshot::content_hash(source.markdown.as_bytes())
        );
        let parsed =
            kb_local::markdown::parse_markdown(source.markdown.as_bytes()).expect("source");
        let raw = &source.markdown[parsed.body_start + hit.span.start_byte as usize
            ..parsed.body_start + hit.span.end_byte as usize];
        let snippet_source = if shape == 0 {
            raw.split_whitespace().collect::<Vec<_>>().join(" ")
        } else {
            raw.to_owned()
        };
        assert_eq!(
            hit.snippet,
            kb_local::chunk::citation_snippet(&kb_local::plain_snippet::plain_snippet(
                &kb_local::chunk::citation_snippet(&snippet_source)
            ))
        );
        no_leases(&f);
    }
    // Cancellation arrives from another thread while the actual large request
    // is executing; it must discard results, release its lease, and re-enter.
    for timeout in [false, true] {
        let ctl = SearchControl::with_timeout(if timeout {
            std::time::Duration::from_millis(5)
        } else {
            std::time::Duration::from_secs(60)
        });
        let stop = ctl.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(5));
            if !timeout {
                stop.cancel();
            }
        });
        let error = f
            .store
            .structured_search_generation(
                &f.store.owner(),
                structured(
                    &f,
                    json!({"structured":[{"column":"c1","equals":cell}],"limit":1}),
                ),
                &ctl,
                async |_, _| panic!("queryless does not embed"),
                &mut |_| Ok(()),
            )
            .await
            .unwrap_err();
        worker.join().expect("owned cancellation worker");
        assert_eq!(
            error.protocol_code(),
            if timeout {
                ErrorCode::DeadlineExceeded
            } else {
                ErrorCode::Cancelled
            }
        );
        no_leases(&f);
        let last = f
            .filter(json!({"structured":[{"column":"n","equals":999}],"limit":1}))
            .await
            .expect("large row filter re-entry");
        assert_eq!(last.items.len(), 1);
        assert_eq!(
            last.items[0].matched_row.as_ref().expect("last source row")["n"],
            999
        );
        no_leases(&f);
    }
}

#[tokio::test]
async fn shared_filter_and_hybrid_corpus_executes_sqlite() {
    let f = Fixture::new(2);
    let v = load(&f, "structured-search");
    ready(&f).await;
    for kind in ["structured", "hybrid"] {
        for case in v[kind].as_array().expect("valid fixture") {
            let out = f
                .filter(case["input"].clone())
                .await
                .expect("valid fixture");
            check::<StructuredSearch>(&out);
            assert!(out.next_cursor.is_none());
            let actual=out.items.iter().map(|h|json!({"path":h.path,"chunkIndex":h.chunk_index,"matchedRow":h.matched_row})).collect::<Vec<_>>();
            let expected=case["expected"].as_array().expect("valid fixture").iter().map(|h|json!({"path":h["path"],"chunkIndex":h["chunkIndex"],"matchedRow":h["matchedRow"]})).collect::<Vec<_>>();
            assert_eq!(actual, expected, "{}", case["name"]);
            for (h, w) in out
                .items
                .iter()
                .zip(case["expected"].as_array().expect("valid fixture"))
            {
                assert_eq!(
                    h.mode,
                    if kind == "structured" {
                        SearchMode::Structured
                    } else {
                        SearchMode::Hybrid
                    }
                );
                assert_eq!(h.score, if kind == "structured" { 1. } else { score(w) });
                if h.matched_row.is_some() {
                    let d = f.cited(h);
                    let p = kb_local::markdown::parse_markdown(d.markdown.as_bytes())
                        .expect("valid fixture");
                    let raw = &d.markdown[p.body_start + h.span.start_byte as usize
                        ..p.body_start + h.span.end_byte as usize];
                    assert_eq!(
                        h.snippet,
                        kb_local::chunk::citation_snippet(&kb_local::plain_snippet::plain_snippet(
                            &kb_local::chunk::citation_snippet(raw)
                        ))
                    );
                }
            }
        }
    }
    no_leases(&f);
}
#[tokio::test]
async fn complete_pages_over_fifty_rows_pin_activation_and_bind_cursors() {
    let f = Fixture::new(2);
    let body = format!(
        "---\ntype: roster\n---\n| n | yes |\n|---|---|\n{}",
        (0..121)
            .map(|n| format!("| {n} | true |\n"))
            .collect::<String>()
    );
    publish(&f, vec![("rows.md", Some(body))], "structured-many-rows");
    let a = ready(&f).await;
    let filters = json!({"structured":[{"column":"yes","equals":true}],"limit":50});
    let mut out = f.filter(filters.clone()).await.expect("valid fixture");
    assert_eq!(out.items.len(), 50);
    let token = out.next_cursor.clone().expect("valid fixture");
    let p = reader(&f);
    for extra in [
        json!({"type":"other","cursor":token}),
        json!({"query":"alpha","cursor":token}),
        json!({"structured":[{"column":"yes","equals":false}],"cursor":token}),
    ] {
        assert_eq!(
            f.filter(extra).await.unwrap_err().protocol_code(),
            ErrorCode::InvalidCursor
        );
    }
    let mut rebound = filters.clone();
    rebound["cursor"] = json!(token);
    assert_eq!(
        f.filter_as(&p, rebound.clone(), &mut |_| Ok(()))
            .await
            .unwrap_err()
            .protocol_code(),
        ErrorCode::InvalidCursor
    );
    let mut bad = token.clone().into_bytes();
    let mac = token.find('.').expect("signed cursor") + 3;
    bad[mac] = if bad[mac] == b'A' { b'B' } else { b'A' };
    rebound["cursor"] = json!(String::from_utf8(bad).expect("valid fixture"));
    assert_eq!(
        f.filter(rebound).await.unwrap_err().protocol_code(),
        ErrorCode::InvalidCursor
    );
    publish(
        &f,
        vec![("rows.md", Some("new contents".into()))],
        "structured-edit-rows",
    );
    let b = f.status().desired_generation_id.expect("valid fixture");
    assert!(
        f.store
            .activate_built(f.build(&b).await)
            .expect("valid fixture")
    );
    f.store.advance_clock_for_tests(700);
    let mut continued = token.clone();
    let mut rows = vec![];
    loop {
        assert_eq!(out.generation_id, a);
        rows.extend(out.items.iter().map(|h| {
            h.matched_row.as_ref().expect("valid fixture")["n"]
                .as_u64()
                .expect("valid fixture")
        }));
        let Some(token) = out.next_cursor else { break };
        continued = token.clone();
        let mut next = filters.clone();
        next["cursor"] = json!(token);
        out = f.filter(next).await.expect("valid fixture");
        assert_eq!(out.freshness, Freshness::Stale);
    }
    assert_eq!(rows, (0..121).collect::<Vec<_>>());
    f.store.advance_clock_for_tests(201);
    let mut next = filters;
    next["cursor"] = json!(continued);
    assert_eq!(
        f.filter(next).await.unwrap_err().protocol_code(),
        ErrorCode::InvalidCursor
    );
    no_leases(&f);
}
#[tokio::test]
async fn invalid_queryless_failed_hybrid_and_final_read_loss() {
    let f = Fixture::new(2);
    ready(&f).await;
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("valid fixture");
    let stamp: String = lease
        .connection()
        .query_row(
            "SELECT json_extract(metadata_json,'$.timestamp') FROM documents WHERE path='index.md'",
            [],
            |r| r.get(0),
        )
        .expect("indexed commit timestamp");
    drop(lease);
    let out = f
        .filter(json!({"timestamp":{"after":stamp}}))
        .await
        .expect("inclusive commit fallback");
    assert_eq!(out.items.len(), 1);
    assert_eq!(out.items[0].path.as_str(), "index.md");
    assert!(
        f.filter(json!({"timestamp":{"before":stamp}}))
            .await
            .expect("exclusive commit fallback")
            .items
            .is_empty()
    );
    for extra in [
        json!({}),
        json!({"query":""}),
        json!({"timestamp":{"after":"2026-02-01T00:00:00Z","before":"2026-01-01T00:00:00Z"}}),
    ] {
        assert_eq!(
            f.filter(extra).await.unwrap_err().protocol_code(),
            ErrorCode::InvalidArgument
        );
    }
    // The model rejecting the query as too long degrades too (query purpose).
    let long = f
        .store
        .structured_search_generation(
            &f.store.owner(),
            structured(&f, json!({"query":"alpha","title":"Index"})),
            &SearchControl::default(),
            async |_, _| {
                Err(StoreError::OperationAborted(
                    kb_client::ErrorCode::EmbeddingInputTooLong,
                ))
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("lexical fallback for a too-long query");
    assert!(long.items.iter().all(|h| h.mode == SearchMode::Lexical));
    no_leases(&f);
    // A failing query embedding serves the lexical arm (never the
    // queryless operation) and says why.
    let out = f
        .store
        .structured_search_generation(
            &f.store.owner(),
            structured(&f, json!({"query":"alpha","title":"Index"})),
            &SearchControl::default(),
            async |_, _| Err(StoreError::EmbeddingFailed),
            &mut |_| Ok(()),
        )
        .await
        .expect("lexical fallback");
    assert!(out.items.iter().all(|h| h.mode == SearchMode::Lexical));
    assert!(matches!(
        out.index_notices.as_slice(),
        [IndexNotice::LexicalOnly(n)] if n.detail == LexicalOnlyReason::EmbeddingProfileUnavailable
    ));
    no_leases(&f);
    let p = reader(&f);
    let e = f
        .filter_as(&p, json!({"title":"absent"}), &mut |s| {
            if s == SearchStage::BeforeReturn {
                f.db()
                    .execute(
                        "UPDATE principal_ceilings SET bits=0 WHERE principal_id=?1",
                        [p.id()],
                    )
                    .expect("valid fixture");
            }
            Ok(())
        })
        .await
        .unwrap_err();
    assert_eq!(e.protocol_code(), ErrorCode::NotFound);
    no_leases(&f);
}
#[tokio::test]
async fn full_row_credentials_cannot_leak_through_a_safe_partial_chunk() {
    let f = Fixture::new(2);
    let text = format!(
        "| name | note |\n|---|---|\n| safe | plain |\n| encoded | \"\\u0073k-proj-abcdefghijklmnopqrstuvwxyz\" |\n| empty | \"\" |\n| spaces | \"  \" |\n| unsafe | {} sk-proj-abcdefghijklmnopqrstuvwxyz |\n\n| name | sk-proj-abcdefghijklmnopqrstuvwxyz |\n|---|---|\n| heading | {} |\n",
        "x ".repeat(410),
        "y ".repeat(410)
    );
    publish(
        &f,
        vec![("rows.md", Some(text))],
        "structured-sensitive-rows",
    );
    ready(&f).await;
    assert!(
        f.filter(json!({"structured":[{"column":"name","equals":"unsafe"}]}))
            .await
            .expect("valid fixture")
            .items
            .is_empty()
    );
    let out = f
        .filter(json!({"structured":[{"column":"name","equals":"safe"}]}))
        .await
        .expect("valid fixture");
    assert_eq!(out.items.len(), 1);
    assert_eq!(
        out.items[0].matched_row.as_ref().expect("valid fixture")["note"],
        "plain"
    );
    assert!(
        f.filter(json!({"structured":[{"column":"name","equals":"encoded"}]}))
            .await
            .expect("valid fixture")
            .items
            .is_empty(),
        "decoded JSON cells must pass the credential floor"
    );
    assert!(
        f.filter(json!({"structured":[{"column":"name","equals":"heading"}]}))
            .await
            .expect("valid fixture")
            .items
            .is_empty(),
        "matchedRow keys must pass the same credential floor"
    );
    for (name, value) in [("empty", ""), ("spaces", "  ")] {
        let out = f
            .filter(json!({"structured":[{"column":"name","equals":name}]}))
            .await
            .expect("valid fixture");
        assert_eq!(out.items.len(), 1);
        assert_eq!(
            out.items[0].matched_row.as_ref().expect("valid fixture")["note"],
            value
        );
    }
    no_leases(&f);
}
