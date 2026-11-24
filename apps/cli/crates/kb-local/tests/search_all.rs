//! `knowledge_search_all` over the local store: per-base statuses, the
//! not-found rule, rank interleaving, the per-base limit, the "all" limit,
//! the shared deadline and cancellation, against real Git, SQLite FTS5 and
//! sqlite-vec. Every output is checked against the shared kb/1 schema.
#[path = "support/search_fixture.rs"]
mod support;
use kb_client::{ErrorCode, types::*};
use kb_local::{
    CommitRequest, CreateKbRequest, LocalPrincipal, StoreError,
    search::{SearchControl, SearchStage},
    search_all::SEARCH_ALL_LOCAL_BASES,
};
use rusqlite::OptionalExtension;
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
use support::*;

const MISSING: &str = "zzzzzzzzzzzzzzzzzzzzzzzz";

fn kb(id: &str) -> KbId {
    KbId::parse(id).expect("kb id")
}

fn create(f: &Fixture, n: usize) -> KbId {
    f.store
        .create_kb(
            &f.store.owner(),
            CreateKbRequest {
                name: format!("Base {n}"),
                slug: format!("search-all-{n}"),
                description: "Search-all fixture base".into(),
                idempotency_key: format!("search-all-create-{n:04}"),
            },
        )
        .expect("create")
        .kb_id
}

fn publish_to(f: &Fixture, kb: &KbId, docs: &[(&str, &str)], key: &str) {
    let head = f
        .store
        .kb(kb)
        .expect("kb")
        .expect("kb")
        .head_sha
        .expect("head");
    f.store
        .commit_files(
            &f.store.owner(),
            CommitRequest {
                kb: kb.clone(),
                base_revision: Sha::parse(&head).expect("sha"),
                idempotency_key: key.into(),
                changes: docs
                    .iter()
                    .map(|(path, body)| kb_local::FileChange {
                        path: (*path).into(),
                        content: Some(body.as_bytes().to_vec()),
                    })
                    .collect(),
            },
        )
        .expect("commit");
}

/// Builds and activates `kb`'s desired generation, after its lexical
/// companion when it has one (the fixture's own order).
async fn build_pending(f: &Fixture, kb: &KbId) {
    let status = f
        .store
        .index_status_get(&f.store.owner(), KbRef { kb_id: kb.clone() })
        .expect("status");
    let Some(desired) = status.desired_generation_id else {
        return;
    };
    if status.desired_state != Some(IndexState::Pending) {
        return;
    }
    let epoch = f
        .store
        .generation_snapshot(&desired)
        .expect("snapshot")
        .epoch;
    let companion: Option<String> = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2 AND state='PENDING' AND json_type(snapshot_json,'$.profile') IS NOT 'object'",
            (kb.as_str(), epoch - 1),
            |r| r.get(0),
        )
        .optional()
        .expect("companion");
    let mut ids: Vec<KbId> = companion
        .map(|id| KbId::parse(&id).expect("id"))
        .into_iter()
        .collect();
    ids.push(desired);
    for id in ids {
        let a = f
            .store
            .claim_generation(&id, Duration::from_secs(120))
            .expect("claim");
        let built = f
            .store
            .build_generation(
                a,
                async |_, texts| Ok(texts.iter().map(|s| vector(s)).collect()),
                &mut |_| Ok(()),
            )
            .await
            .expect("build");
        assert!(f.store.activate_built(built).expect("activate"));
    }
}

/// A base with three `alpha` documents, searched by keyword only.
async fn lexical_base(f: &Fixture, n: usize) -> KbId {
    let id = create(f, n);
    publish_to(
        f,
        &id,
        &[
            ("a.md", "# A\n\nalpha one"),
            ("b.md", "# B\n\nalpha alpha two"),
            ("c.md", "# C\n\nalpha three beta"),
        ],
        &format!("search-all-docs-{n:04}"),
    );
    build_pending(f, &id).await;
    id
}

/// A base on the fixture provider (hybrid ranking).
async fn hybrid_base(f: &Fixture, n: usize) -> KbId {
    let id = lexical_base(f, n).await;
    f.store
        .embedding_profile_set(
            &f.store.owner(),
            serde_json::from_value(json!({"kbId": id, "providerId": f.provider, "revision": 1,
                "idempotencyKey": format!("search-all-profile-{n:04}"), "confirm": "RUN"}))
            .expect("profile input"),
        )
        .expect("profile");
    build_pending(f, &id).await;
    id
}

fn request(kbs: &[&KbId], extra: serde_json::Value) -> SearchAllInput {
    let mut v = json!({"query": "alpha"});
    if !kbs.is_empty() {
        v["kbIds"] = json!(kbs.iter().map(|k| k.as_str()).collect::<Vec<_>>());
    }
    v.as_object_mut()
        .expect("object")
        .extend(extra.as_object().expect("object").clone());
    serde_json::from_value(v).expect("input")
}

async fn run_with(
    f: &Fixture,
    p: &LocalPrincipal,
    input: SearchAllInput,
    ctl: &SearchControl,
    selection: Option<&BTreeSet<String>>,
    observer: &dyn Fn(&KbId, SearchStage) -> Result<(), StoreError>,
) -> Result<SearchAllOutput, StoreError> {
    let out = f
        .store
        .search_all_generation(
            p,
            input,
            ctl,
            selection,
            async |_, text| {
                // Yield so both lanes are really in flight together.
                tokio::task::yield_now().await;
                Ok(vector(text))
            },
            observer,
        )
        .await;
    if let Ok(out) = &out {
        check::<SearchAll>(out);
    }
    out
}

async fn run(f: &Fixture, input: SearchAllInput) -> SearchAllOutput {
    run_with(
        f,
        &f.store.owner(),
        input,
        &SearchControl::default(),
        None,
        &|_, _| Ok(()),
    )
    .await
    .expect("search all")
}

fn statuses(out: &SearchAllOutput) -> Vec<SearchAllStatus> {
    out.knowledge_bases.iter().map(|r| r.status).collect()
}

/// A row with its KB ID blanked: what an observer learns besides the ID.
fn shape(row: &SearchAllBase) -> serde_json::Value {
    let mut v = serde_json::to_value(row).expect("row");
    v["kbId"] = json!(null);
    v
}

fn reader_of(f: &Fixture, kbs: &[&KbId]) -> LocalPrincipal {
    let id = "22222222-2222-4222-8222-222222222222";
    for kb in kbs {
        f.db()
            .execute(
                "INSERT INTO principal_ceilings(principal_id,kind,kb_id,bits) VALUES(?1,'TEST',?2,1)",
                (id, kb.as_str()),
            )
            .expect("ceiling");
    }
    f.store.principal(id).expect("principal")
}

fn permits_free(f: &Fixture) {
    no_leases(f);
    // Every query permit is free again: four searches hold four at once.
    let held: Vec<_> = (0..kb_local::search::QUERIES_IN_FLIGHT)
        .map(|slot| {
            let hash = kb_client::snapshot::content_hash(f.store.owner().actor_key().as_bytes());
            let path = f
                .store
                .paths()
                .locks_dir()
                .join(format!("query-{}-{slot}.lock", &hash.as_str()[7..]));
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .ok()
                .map(|file| (file.try_lock().is_ok(), file))
        })
        .collect();
    assert!(
        held.iter().flatten().all(|(free, _)| *free),
        "a query permit is still held"
    );
}

#[tokio::test]
async fn statuses_rows_and_rank_interleaving() {
    let f = Fixture::new(2);
    let hybrid = hybrid_base(&f, 1).await;
    let lexical = lexical_base(&f, 2).await;
    let rebuilding = create(&f, 3);
    let limited = lexical_base(&f, 4).await;
    // Spend `limited`'s whole per-KB minute window.
    let actor = f.store.owner().actor_key();
    for i in 0..kb_local::limits::LOCAL_QUERIES_PER_MINUTE_PER_KB {
        f.db()
            .execute(
                "INSERT INTO query_charges VALUES(?1,?2,?3,?4)",
                (
                    format!("charge-{i}"),
                    &actor,
                    limited.as_str(),
                    now_ms() as i64,
                ),
            )
            .expect("charge");
    }
    let missing = kb(MISSING);
    let status = f
        .store
        .index_status_get(
            &f.store.owner(),
            KbRef {
                kb_id: rebuilding.clone(),
            },
        )
        .expect("status");
    assert_eq!(status.desired_state, Some(IndexState::Pending));
    assert!(status.active_generation_id.is_none());
    // Request order, duplicates dropped at their first occurrence.
    let out = run(
        &f,
        request(
            &[&lexical, &hybrid, &missing, &lexical, &rebuilding, &limited],
            json!({"limitPerBase": 2}),
        ),
    )
    .await;
    assert_eq!(
        out.knowledge_bases
            .iter()
            .map(|r| r.kb_id.clone())
            .collect::<Vec<_>>(),
        [
            lexical.clone(),
            hybrid.clone(),
            missing.clone(),
            rebuilding.clone(),
            limited.clone()
        ]
    );
    assert_eq!(
        statuses(&out),
        [
            SearchAllStatus::LexicalOnly,
            SearchAllStatus::Ok,
            SearchAllStatus::NotFound,
            SearchAllStatus::Rebuilding,
            SearchAllStatus::RateLimited
        ]
    );
    assert_eq!(out.limit_per_base, 2);
    let rows = &out.knowledge_bases;
    // Searched rows carry their base's index fields; the others carry none.
    assert!(rows[0].generation_id.is_some() && rows[0].head_sha.is_some());
    assert!(matches!(
        rows[0].index_notices.as_slice(),
        [IndexNotice::LexicalOnly(LexicalOnlyNotice {
            detail: LexicalOnlyReason::NoEmbeddingProfile,
            ..
        })]
    ));
    assert!(rows[1].index_notices.is_empty() && rows[1].freshness.is_some());
    for row in &rows[2..] {
        assert!(row.generation_id.is_none() && row.freshness.is_none());
        assert!(row.indexed_commit_sha.is_none() && row.head_sha.is_none());
        assert!(row.index_notices.is_empty() && row.hit_count == 0);
    }
    assert_eq!(rows[4].retry_after_seconds, Some(60));
    assert!(rows[..4].iter().all(|r| r.retry_after_seconds.is_none()));
    // Rank 1 of every searched base in row order, then rank 2.
    assert_eq!(rows[0].hit_count, 2);
    assert_eq!(rows[1].hit_count, 2);
    let merged: Vec<(KbId, u64)> = out
        .results
        .iter()
        .map(|h| (h.hit.knowledge_base_id.clone(), h.rank))
        .collect();
    assert_eq!(
        merged,
        [
            (lexical.clone(), 1),
            (hybrid.clone(), 1),
            (lexical.clone(), 2),
            (hybrid.clone(), 2)
        ]
    );
    assert!(
        out.results
            .iter()
            .filter(|h| h.hit.knowledge_base_id == lexical)
            .all(|h| h.hit.mode == SearchMode::Lexical)
    );
    assert!(
        out.results
            .iter()
            .filter(|h| h.hit.knowledge_base_id == hybrid)
            .all(|h| h.hit.mode == SearchMode::Hybrid)
    );
    // Each base's hits are exactly its single-base search, unchanged.
    let single = f
        .store
        .search_generation(
            &f.store.owner(),
            serde_json::from_value(json!({"kbId": hybrid, "query": "alpha", "limit": 2}))
                .expect("input"),
            &SearchControl::default(),
            async |_, text| Ok(vector(text)),
            &mut |_| Ok(()),
        )
        .await
        .expect("single");
    let from_all: Vec<CitationHit> = out
        .results
        .iter()
        .filter(|h| h.hit.knowledge_base_id == hybrid)
        .map(|h| h.hit.clone())
        .collect();
    assert_eq!(from_all, single.results);
    permits_free(&f);
}

#[tokio::test]
async fn missing_unreadable_and_unselected_bases_give_the_same_row() {
    let f = Fixture::new(2);
    let readable = lexical_base(&f, 1).await;
    let hidden = lexical_base(&f, 2).await;
    let missing = kb(MISSING);
    let reader = reader_of(&f, &[&readable]);
    let out = run_with(
        &f,
        &reader,
        request(&[&hidden, &readable, &missing], json!({})),
        &SearchControl::default(),
        None,
        &|_, _| Ok(()),
    )
    .await
    .expect("search all");
    assert_eq!(
        statuses(&out),
        [
            SearchAllStatus::NotFound,
            SearchAllStatus::LexicalOnly,
            SearchAllStatus::NotFound
        ]
    );
    assert_eq!(
        shape(&out.knowledge_bases[0]),
        shape(&out.knowledge_bases[2])
    );
    assert!(
        out.results
            .iter()
            .all(|h| h.hit.knowledge_base_id == readable)
    );
    // A KB outside the session's `--kb` selection: the same row again.
    let selection: BTreeSet<String> = [readable.as_str().to_owned()].into();
    let out = run_with(
        &f,
        &f.store.owner(),
        request(&[&hidden, &readable, &missing], json!({})),
        &SearchControl::default(),
        Some(&selection),
        &|_, _| Ok(()),
    )
    .await
    .expect("search all");
    assert_eq!(
        statuses(&out),
        [
            SearchAllStatus::NotFound,
            SearchAllStatus::LexicalOnly,
            SearchAllStatus::NotFound
        ]
    );
    assert_eq!(
        shape(&out.knowledge_bases[0]),
        shape(&out.knowledge_bases[2])
    );
    // A rate-limited base the reader cannot read is still just not found.
    let actor = f.store.owner().actor_key();
    for i in 0..kb_local::limits::LOCAL_QUERIES_PER_MINUTE_PER_KB {
        f.db()
            .execute(
                "INSERT INTO query_charges VALUES(?1,?2,?3,?4)",
                (
                    format!("charge-{i}"),
                    &actor,
                    hidden.as_str(),
                    now_ms() as i64,
                ),
            )
            .expect("charge");
    }
    let out = run_with(
        &f,
        &reader,
        request(&[&hidden, &missing], json!({})),
        &SearchControl::default(),
        None,
        &|_, _| Ok(()),
    )
    .await
    .expect("search all");
    assert_eq!(
        shape(&out.knowledge_bases[0]),
        shape(&out.knowledge_bases[1])
    );
    permits_free(&f);
}

#[tokio::test]
async fn final_recheck_drops_a_base_revoked_during_the_call() {
    let f = Fixture::new(2);
    let first = lexical_base(&f, 1).await;
    let second = lexical_base(&f, 2).await;
    let reader = reader_of(&f, &[&first, &second]);
    let db = f.db();
    let out = run_with(
        &f,
        &reader,
        request(&[&first, &second], json!({})),
        &SearchControl::default(),
        None,
        &|kb, stage| {
            // `first` has already answered when `second` finishes.
            if *kb == second && stage == SearchStage::BeforeReturn {
                db.execute(
                    "DELETE FROM principal_ceilings WHERE kb_id=?1",
                    [first.as_str()],
                )
                .expect("revoke");
            }
            Ok(())
        },
    )
    .await
    .expect("search all");
    assert_eq!(
        statuses(&out),
        [SearchAllStatus::NotFound, SearchAllStatus::LexicalOnly]
    );
    assert_eq!(out.knowledge_bases[0].hit_count, 0);
    assert!(
        out.results
            .iter()
            .all(|h| h.hit.knowledge_base_id == second)
    );
    permits_free(&f);
}

#[tokio::test]
async fn at_most_two_bases_are_in_flight() {
    let f = Fixture::new(2);
    let mut ids = vec![];
    for n in 1..=4 {
        ids.push(hybrid_base(&f, n).await);
    }
    let live = Cell::new(0usize);
    let peak = Cell::new(0usize);
    let refs: Vec<&KbId> = ids.iter().collect();
    let out = run_with(
        &f,
        &f.store.owner(),
        request(&refs, json!({})),
        &SearchControl::default(),
        None,
        &|_, stage| {
            match stage {
                SearchStage::Pinned => {
                    live.set(live.get() + 1);
                    peak.set(peak.get().max(live.get()));
                }
                SearchStage::BeforeReturn => live.set(live.get() - 1),
                _ => {}
            }
            Ok(())
        },
    )
    .await
    .expect("search all");
    assert_eq!(statuses(&out), [SearchAllStatus::Ok; 4]);
    assert_eq!(peak.get(), kb_local::search_all::SEARCH_ALL_LANES);
    permits_free(&f);
}

#[tokio::test]
async fn the_per_base_limit_shrinks_to_the_merged_cap() {
    let f = Fixture::new(2);
    let real = lexical_base(&f, 1).await;
    // Ten more (missing) IDs: eleven bases, so 100 / 11 = 9 hits each.
    let fillers: Vec<KbId> = (0..10)
        .map(|n| kb(&format!("{}{n}", "y".repeat(23))))
        .collect();
    let mut refs: Vec<&KbId> = vec![&real];
    refs.extend(fillers.iter());
    let out = run(&f, request(&refs, json!({"limitPerBase": 10}))).await;
    assert_eq!(out.limit_per_base, 9);
    assert_eq!(out.knowledge_bases.len(), 11);
    let out = run(&f, request(&[&real], json!({}))).await;
    assert_eq!(out.limit_per_base, SEARCH_ALL_DEFAULT_PER_BASE);
    assert!((3..=4).contains(&out.results.len()));
    assert_eq!(
        out.results.iter().map(|h| h.rank).collect::<Vec<_>>(),
        (1..=out.results.len() as u64).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn all_is_the_listing_and_more_than_the_limit_is_refused() {
    let f = Fixture::new(2);
    let mut ids: Vec<KbId> = vec![f.kb.clone()];
    for n in 1..=SEARCH_ALL_LOCAL_BASES {
        ids.push(create(&f, n));
    }
    assert_eq!(ids.len(), SEARCH_ALL_LOCAL_BASES + 1);
    // Seventeen readable bases and no kbIds: the whole call is refused.
    let err = run_with(
        &f,
        &f.store.owner(),
        request(&[], json!({})),
        &SearchControl::default(),
        None,
        &|_, _| panic!("no base may run"),
    )
    .await
    .expect_err("too many bases");
    assert_eq!(err.protocol_code(), ErrorCode::InvalidArgument);
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "TOO_MANY_BASES", "max": 16})
    );
    let wire = kb_client::stdio::tool_error(err.protocol_code(), err.protocol_details());
    assert_eq!(
        wire["structuredContent"]["error"]["message"],
        kb_client::error::too_many_bases_message(16).expect("message")
    );
    // Sixteen through the session selection, or through a principal's
    // ceilings: every listed base, in listing order.
    let selection: BTreeSet<String> = ids[1..].iter().map(|k| k.as_str().to_owned()).collect();
    let out = run_with(
        &f,
        &f.store.owner(),
        request(&[], json!({})),
        &SearchControl::default(),
        Some(&selection),
        &|_, _| Ok(()),
    )
    .await
    .expect("sixteen");
    let listed: Vec<String> = out
        .knowledge_bases
        .iter()
        .map(|r| r.kb_id.as_str().to_owned())
        .collect();
    assert_eq!(listed, selection.iter().cloned().collect::<Vec<_>>());
    assert_eq!(out.limit_per_base, SEARCH_ALL_DEFAULT_PER_BASE);
    let refs: Vec<&KbId> = ids[..SEARCH_ALL_LOCAL_BASES].iter().collect();
    let reader = reader_of(&f, &refs);
    let out = run_with(
        &f,
        &reader,
        request(&[], json!({})),
        &SearchControl::default(),
        None,
        &|_, _| Ok(()),
    )
    .await
    .expect("sixteen readable");
    assert_eq!(out.knowledge_bases.len(), SEARCH_ALL_LOCAL_BASES);
    assert!(
        out.knowledge_bases
            .iter()
            .all(|r| r.kb_id != ids[SEARCH_ALL_LOCAL_BASES])
    );
    // An explicit list is not held to the "all" limit.
    let all: Vec<&KbId> = ids.iter().collect();
    let out = run(&f, request(&all, json!({}))).await;
    assert_eq!(out.knowledge_bases.len(), SEARCH_ALL_LOCAL_BASES + 1);
    permits_free(&f);
}

#[tokio::test]
async fn no_readable_base_is_an_empty_success() {
    let f = Fixture::new(2);
    // A selection naming no KB lists nothing: "all" is no base at all.
    let none = BTreeSet::new();
    let out = run_with(
        &f,
        &f.store.owner(),
        request(&[], json!({"limitPerBase": 7})),
        &SearchControl::default(),
        Some(&none),
        &|_, _| panic!("no base may run"),
    )
    .await
    .expect("empty");
    assert!(out.results.is_empty() && out.knowledge_bases.is_empty());
    assert_eq!(out.limit_per_base, 7);
}

#[tokio::test]
async fn a_sensitive_query_fails_the_whole_call_before_any_base() {
    let f = Fixture::new(2);
    let base = lexical_base(&f, 1).await;
    let err = run_with(
        &f,
        &f.store.owner(),
        request(
            &[&base],
            json!({"query": "sk-proj-abcdefghijklmnopqrstuvwxyz"}),
        ),
        &SearchControl::default(),
        None,
        &|_, _| panic!("no base may run"),
    )
    .await
    .expect_err("sensitive");
    assert_eq!(err.protocol_code(), ErrorCode::SensitiveQuery);
}

#[tokio::test]
async fn the_shared_deadline_marks_unstarted_bases_without_running_them() {
    let f = Fixture::new(2);
    let mut ids = vec![];
    for n in 1..=3 {
        ids.push(lexical_base(&f, n).await);
    }
    let ctl = SearchControl::with_timeout(Duration::from_secs(2));
    let stages: RefCell<BTreeMap<String, usize>> = RefCell::default();
    let refs: Vec<&KbId> = ids.iter().collect();
    let out = run_with(
        &f,
        &f.store.owner(),
        request(&refs, json!({})),
        &ctl,
        None,
        &|kb, stage| {
            *stages
                .borrow_mut()
                .entry(kb.as_str().to_owned())
                .or_default() += 1;
            // The first base outlives the whole call's deadline.
            if stage == SearchStage::BeforeReturn {
                std::thread::sleep(Duration::from_millis(2100));
            }
            Ok(())
        },
    )
    .await
    .expect("partial success");
    assert_eq!(statuses(&out), [SearchAllStatus::Deadline; 3]);
    assert!(out.results.is_empty());
    let stages = stages.into_inner();
    for later in &ids[1..] {
        assert!(!stages.contains_key(later.as_str()), "a late base ran");
    }
    permits_free(&f);
    // The store is immediately usable again.
    let again = run(&f, request(&refs, json!({}))).await;
    assert_eq!(statuses(&again), [SearchAllStatus::LexicalOnly; 3]);
}

#[tokio::test]
async fn cancellation_fails_the_call_after_every_lane_settles() {
    let f = Fixture::new(2);
    let mut ids = vec![];
    for n in 1..=3 {
        ids.push(hybrid_base(&f, n).await);
    }
    let ctl = SearchControl::default();
    let pinned = Cell::new(0usize);
    let refs: Vec<&KbId> = ids.iter().collect();
    let err = run_with(
        &f,
        &f.store.owner(),
        request(&refs, json!({})),
        &ctl,
        None,
        &|_, stage| {
            if stage == SearchStage::Pinned {
                pinned.set(pinned.get() + 1);
                // Cancel while the second lane holds its own base.
                if pinned.get() == 2 {
                    ctl.cancel();
                }
            }
            Ok(())
        },
    )
    .await
    .expect_err("cancelled");
    assert_eq!(err.protocol_code(), ErrorCode::Cancelled);
    // The third base never started; nothing is left held.
    assert_eq!(pinned.get(), 2);
    permits_free(&f);
    let again = run(&f, request(&refs, json!({}))).await;
    assert_eq!(statuses(&again), [SearchAllStatus::Ok; 3]);
}
