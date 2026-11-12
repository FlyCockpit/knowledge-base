//! Incremental, resumable builds. Per-chunk text hashes (format 1), vector
//! reuse from the active file, the per-KB checkpoint and attempt release.
#[path = "support/index_fixture.rs"]
mod support;
use kb_client::types::*;
use kb_local::index_format::IndexQuantization;
use rusqlite::Connection;
use std::{cell::RefCell, time::Duration};
use support::*;

fn publish(f: &Fixture, key: &str, files: &[(&str, String)]) {
    let head = Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("fixture")
            .expect("fixture")
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
                idempotency_key: key.into(),
                changes: files
                    .iter()
                    .map(|(path, body)| kb_local::FileChange {
                        path: (*path).into(),
                        content: Some(body.clone().into_bytes()),
                    })
                    .collect(),
            },
        )
        .expect("publication");
}
/// Distinct, multi-chunk documents: `n` words each.
fn doc(tag: &str, n: usize) -> String {
    (0..n).map(|i| format!("{tag}{i} ")).collect()
}
/// Deterministic per-text vector (dims 2) so copies are checkable.
fn vector(text: &str) -> Vec<f64> {
    let h = text
        .bytes()
        .fold(7u64, |a, b| a.wrapping_mul(31).wrapping_add(b.into()));
    vec![1. + (h % 97) as f64, 1. + (h % 89) as f64]
}
async fn build(f: &Fixture, id: &KbId, seen: &RefCell<Vec<String>>) -> bool {
    // A new head over an older hybrid schedules lexical@head first.
    f.settle_companion(id).await;
    let built = f
        .store
        .build_generation(
            f.store
                .claim_generation(id, Duration::from_secs(120))
                .expect("claim"),
            async |_, texts| {
                seen.borrow_mut().extend(texts.iter().cloned());
                Ok(texts.iter().map(|t| vector(t)).collect())
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    f.store.activate_built(built).expect("activate")
}
fn file(f: &Fixture) -> Connection {
    let id = f.status().active_generation_id.expect("active");
    Connection::open(f.store.paths().index_file(&f.kb, &id)).expect("index file")
}
fn vectors(db: &Connection, q: IndexQuantization) -> Vec<(String, Vec<u8>)> {
    let sql = match q {
        IndexQuantization::BinaryInt8Rescore => {
            "SELECT c.text, CAST(b.b || i.e AS BLOB) FROM chunks c JOIN chunk_bits b ON b.id=c.id JOIN chunk_int8 i ON i.id=c.id ORDER BY c.text"
        }
        IndexQuantization::Int8 => {
            "SELECT c.text, v.embedding FROM chunks c JOIN chunk_vec v ON v.rowid=c.id ORDER BY c.text"
        }
    };
    db.prepare(sql)
        .expect("vectors")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("vectors")
        .collect::<Result<_, _>>()
        .expect("vectors")
}

#[tokio::test]
async fn a_one_document_edit_embeds_only_the_changed_chunks() {
    for q in [
        IndexQuantization::BinaryInt8Rescore,
        IndexQuantization::Int8,
    ] {
        let f = Fixture::new(2);
        f.store.set_index_quantization_for_tests(q);
        publish(
            &f,
            "reuse-corpus-0001",
            &[
                ("a.md", doc("alpha", 1200)),
                ("b.md", doc("bravo", 1200)),
                ("c.md", doc("charlie", 1200)),
            ],
        );
        let seen = RefCell::new(vec![]);
        let job = f.set("reuse-profile-0001");
        assert!(build(&f, &job.generation_id, &seen).await);
        let db = file(&f);
        let chunks: i64 = db
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .expect("chunks");
        assert!(chunks > 10, "{chunks}");
        assert_eq!(seen.borrow().len() as i64, chunks, "first build embeds all");
        // Format 2: one SHA-256 of the stored text per chunk.
        let hashes: i64 = db
            .query_row(
                "SELECT count(*) FROM chunk_hash h JOIN chunks c ON c.id=h.id",
                [],
                |r| r.get(0),
            )
            .expect("hashes");
        assert_eq!(hashes, chunks);
        let (text, hash): (String, Vec<u8>) = db
            .query_row(
                "SELECT c.text,h.h FROM chunks c JOIN chunk_hash h ON h.id=c.id LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("hash row");
        assert_eq!(hash, kb_local::index_format::chunk_hash(&text));
        let before = vectors(&db, q);
        let scale: f64 = db
            .query_row("SELECT int8_scale FROM meta", [], |r| r.get(0))
            .expect("scale");
        drop(db);
        // A one-line edit of one document (L-3).
        seen.borrow_mut().clear();
        publish(
            &f,
            "reuse-edit-document-0001",
            &[("b.md", doc("bravo", 1200) + "delta")],
        );
        let next = f.status().desired_generation_id.expect("desired");
        assert!(build(&f, &next, &seen).await);
        let changed = seen.borrow().clone();
        assert!(!changed.is_empty() && changed.len() <= 2, "{changed:?}");
        assert!(
            changed
                .iter()
                .all(|t| t.contains("bravo") || t.contains("delta"))
        );
        let db = file(&f);
        // The scale is inherited and every unchanged chunk keeps its bytes.
        assert_eq!(
            db.query_row("SELECT int8_scale FROM meta", [], |r| r.get::<_, f64>(0))
                .expect("scale"),
            scale
        );
        let after = vectors(&db, q);
        let unchanged = before
            .iter()
            .filter(|row| !changed.contains(&row.0))
            .filter(|row| after.contains(row))
            .count();
        assert!(
            unchanged >= before.len() - 2,
            "{unchanged} of {}",
            before.len()
        );
        // The checkpoint is gone once the generation is active.
        assert!(
            !f.store
                .paths()
                .index_dir(&f.kb)
                .join("vectors.sqlite")
                .exists()
        );
    }
}

#[tokio::test]
async fn an_interrupted_build_resumes_from_its_checkpoint_and_embeds_each_chunk_once() {
    let f = Fixture::new(2);
    publish(
        &f,
        "resume-corpus-0001",
        &[("a.md", doc("alpha", 6000)), ("b.md", doc("bravo", 6000))],
    );
    let job = f.set("resume-profile-0001");
    let seen = RefCell::new(vec![]);
    let attempt = f
        .store
        .claim_generation(&job.generation_id, Duration::from_secs(120))
        .expect("claim");
    let cancel = attempt.cancellation();
    let calls = RefCell::new(0);
    let result = f
        .store
        .build_generation(
            attempt,
            async |_, texts| {
                *calls.borrow_mut() += 1;
                if *calls.borrow() == 2 {
                    // `kb mcp` exits after the first batch was checkpointed.
                    cancel.cancel().expect("cancel");
                    std::future::pending::<()>().await;
                }
                seen.borrow_mut().extend(texts.iter().cloned());
                Ok(texts.iter().map(|t| vector(t)).collect())
            },
            &mut |_| Ok(()),
        )
        .await;
    assert_eq!(
        result.err().expect("cancelled").protocol_code(),
        kb_client::ErrorCode::Cancelled
    );
    // L-1: back to PENDING, never permanently FAILED.
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
    let first = seen.borrow().len();
    assert!(first > 0);
    assert!(
        f.store
            .paths()
            .index_dir(&f.kb)
            .join("vectors.sqlite")
            .exists()
    );
    assert!(build(&f, &job.generation_id, &seen).await);
    let chunks: i64 = file(&f)
        .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
        .expect("chunks");
    let mut all = seen.borrow().clone();
    assert_eq!(
        all.len() as i64,
        chunks,
        "the resumed attempt skips the checkpoint"
    );
    all.sort();
    all.dedup();
    assert_eq!(
        all.len() as i64,
        chunks,
        "every chunk embedded exactly once"
    );
    assert_eq!(f.status().freshness, Freshness::Current);
}

/// A new head over an active hybrid of an older commit. Returns
/// (hybrid, semantic@head, companion) once the companion is built.
async fn new_head_fixture(f: &Fixture, tag: &str) -> (KbId, KbId, KbId) {
    publish(
        f,
        &format!("{tag}-older-publication-0001"),
        &[("a.md", doc("alpha", 3000)), ("b.md", doc("beta", 3000))],
    );
    let seen = RefCell::new(Vec::new());
    let hybrid = f.set(&format!("{tag}-attach-profile-0001")).generation_id;
    assert!(build(f, &hybrid, &seen).await);
    publish(
        f,
        &format!("{tag}-newer-publication-0001"),
        &[("b.md", doc("gamma", 3000))],
    );
    let job = f.status().desired_generation_id.expect("desired");
    assert_eq!(
        active_after_recovery(f),
        Some(hybrid.clone()),
        "nothing of head yet"
    );
    f.settle_companion(&job).await;
    let s = f.store.generation_snapshot(&job).expect("snapshot");
    let companion: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2",
            (s.kb_id.as_str(), s.epoch - 1),
            |r| r.get(0),
        )
        .expect("companion");
    (hybrid, job, KbId::parse(&companion).expect("id"))
}
fn active_after_recovery(f: &Fixture) -> Option<KbId> {
    drop(f.store.lock_write(&[]).expect("recovery"));
    f.status().active_generation_id
}
fn state_of(f: &Fixture, id: &KbId) -> String {
    f.db()
        .query_row(
            "SELECT state FROM index_generations WHERE id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .expect("state")
}

/// Read-your-writes: after a commit the new head's lexical companion
/// serves as soon as it completes (never the older hybrid's stale content),
/// keeps serving while semantic@head fails, and is replaced only when
/// semantic@head activates, which reuses the retired hybrid's vectors.
#[tokio::test]
async fn a_new_head_serves_its_lexical_companion_until_semantic_head_activates() {
    let f = Fixture::new(2);
    let (hybrid, job, companion) = new_head_fixture(&f, "read-your-writes").await;
    assert_eq!(active_after_recovery(&f), Some(companion.clone()));
    assert!(
        f.store
            .generation_snapshot(&companion)
            .expect("snapshot")
            .is_lexical()
    );
    assert!(
        f.store
            .build_generation(
                f.store
                    .claim_generation(&job, Duration::from_secs(120))
                    .expect("claim"),
                async |_, _| Err(kb_local::StoreError::EmbeddingFailed),
                &mut |_| Ok(())
            )
            .await
            .is_err()
    );
    assert_eq!(active_after_recovery(&f), Some(companion.clone()));
    f.store.advance_clock_for_tests(3601);
    let retry = f.rebuild("read-your-writes-rebuild-0001").generation_id;
    let seen = RefCell::new(Vec::new());
    assert!(build(&f, &retry, &seen).await);
    assert_eq!(active_after_recovery(&f), Some(retry));
    let seen = seen.borrow();
    assert!(!seen.is_empty());
    assert!(
        seen.iter()
            .all(|t| t.contains("gamma") && !t.contains("alpha"))
    );
    assert_ne!(state_of(&f, &hybrid), "COMPLETE");
}

/// Retention: heads A -> B -> C. Each superseded companion and the old
/// hybrid are retired once something better of the head activates, and
/// retention reclaims them; nothing obsolete accumulates.
#[tokio::test]
async fn superseded_companions_are_retired_and_reclaimed() {
    let f = Fixture::new(2);
    let (hybrid, _job_b, companion_b) = new_head_fixture(&f, "retire").await;
    publish(
        &f,
        "retire-head-c-publication-0001",
        &[("c.md", doc("delta", 200))],
    );
    let job_c = f.status().desired_generation_id.expect("desired");
    f.settle_companion(&job_c).await;
    let seen = RefCell::new(Vec::new());
    assert!(build(&f, &job_c, &seen).await);
    assert_eq!(active_after_recovery(&f), Some(job_c.clone()));
    // The next scheduling retires every completed generation but the active.
    f.store.advance_clock_for_tests(3601);
    let next = f.rebuild("retire-rebuild-0001").generation_id;
    for id in [&hybrid, &companion_b] {
        assert_eq!(state_of(&f, id), "SUPERSEDED", "{id:?}");
    }
    f.store
        .sweep_generations(now_ms() + 8 * 86_400_000)
        .expect("retention");
    for id in [&hybrid, &companion_b] {
        assert!(!f.store.paths().index_file(&f.kb, id).exists(), "{id:?}");
    }
    assert_eq!(state_of(&f, &next), "PENDING");
    assert!(f.store.paths().index_file(&f.kb, &job_c).is_file());
}

/// Codex r7 #1: a shorter admission/lock/storage deadline while the build's
/// watchdog is live is transient, never a stall, however often it happens.
#[tokio::test]
async fn an_admission_deadline_inside_a_live_watchdog_is_never_a_stall() {
    let f = Fixture::new(2);
    let (_hybrid, job, companion) = new_head_fixture(&f, "admission-deadline").await;
    for attempt in 0..=kb_local::generations::MAX_STALLED_ATTEMPTS {
        let result = f
            .store
            .build_generation(
                f.store
                    .claim_generation(&job, Duration::from_secs(120))
                    .expect("claim"),
                async |_, _| -> Result<Vec<Vec<f64>>, kb_local::StoreError> {
                    if attempt == 0 {
                        // A real five-second OS-lock admission timeout, while the
                        // attempt's 120-second watchdog remains live.
                        let held = std::fs::OpenOptions::new()
                            .read(true)
                            .write(true)
                            .open(f.root.join("locks/store.lock"))
                            .expect("lock file");
                        held.lock().expect("hold admission");
                        let error = f.store.lock_write(&[]).expect_err("admission expires");
                        drop(held);
                        return Err(error);
                    }
                    Err(kb_local::StoreError::DeadlineExceeded)
                },
                &mut |_| Ok(()),
            )
            .await;
        assert!(result.is_err());
        // Never INDEX_BUILD_STALLED: still retryable.
        assert_eq!(f.status().desired_state, Some(IndexState::Pending));
    }
    assert_eq!(active_after_recovery(&f), Some(companion));
}

/// An embedding-call timeout fails the build (it is not the watchdog).
#[tokio::test]
async fn an_embedding_call_timeout_fails_the_build_without_a_watchdog_stall() {
    let f = Fixture::new(2);
    let (_hybrid, job, companion) = new_head_fixture(&f, "embedding-call-timeout").await;
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job, Duration::from_secs(120))
                .expect("claim"),
            async |_, _| -> Result<Vec<Vec<f64>>, kb_local::StoreError> {
                Err(kb_local::StoreError::EmbeddingTimeout)
            },
            &mut |_| Ok(()),
        )
        .await;
    assert!(matches!(
        result,
        Err(kb_local::StoreError::EmbeddingTimeout)
    ));
    assert_eq!(f.status().desired_state, Some(IndexState::Failed));
    assert_eq!(active_after_recovery(&f), Some(companion));
}

/// A partial semantic build: embeds `batches` batches, then the host shuts
/// down (cancellation). Returns whether the attempt failed as expected.
async fn partial_build(f: &Fixture, job: &KbId, batches: usize) {
    let attempt = f
        .store
        .claim_generation(job, Duration::from_secs(120))
        .expect("claim");
    let cancel = attempt.cancellation();
    let calls = RefCell::new(0);
    let result = f
        .store
        .build_generation(
            attempt,
            async |pin, texts| {
                *calls.borrow_mut() += 1;
                if *calls.borrow() > batches {
                    cancel.cancel().expect("cancel");
                    std::future::pending::<()>().await;
                }
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await;
    assert!(result.is_err());
}
fn checkpoint_rows(f: &Fixture) -> Option<i64> {
    let file = f.store.paths().index_dir(&f.kb).join("vectors.sqlite");
    file.exists().then(|| {
        Connection::open(&file)
            .expect("checkpoint")
            .query_row("SELECT count(*) FROM cache_units", [], |r| r.get(0))
            .expect("rows")
    })
}

/// Codex r11 #2 (invariant 1): committed progress resets stall accounting in
/// the same transaction, so stall -> progress/shutdown -> stall -> ... never
/// reaches INDEX_BUILD_STALLED while progress separates the stalls.
#[tokio::test]
async fn progress_between_stalls_resets_stall_accounting() {
    let f = Fixture::new(2);
    publish(
        &f,
        "stall-progress-corpus-0001",
        &[("a.md", doc("alpha", 20000)), ("b.md", doc("bravo", 20000))],
    );
    let job = f.set("stall-progress-profile-0001").generation_id;
    for round in 0..kb_local::generations::MAX_STALLED_ATTEMPTS {
        // A no-progress watchdog expiry.
        let stalled = f
            .store
            .claim_generation(&job, Duration::ZERO)
            .expect("claim");
        assert!(
            f.store
                .build_generation(
                    stalled,
                    async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
                    &mut |_| Ok(())
                )
                .await
                .is_err()
        );
        assert_eq!(
            f.status().desired_state,
            Some(IndexState::Pending),
            "stall {round}"
        );
        // Committed progress, then shutdown.
        partial_build(&f, &job, 1).await;
        assert_eq!(
            f.status().desired_state,
            Some(IndexState::Pending),
            "progress {round}"
        );
    }
    let stalled = f
        .store
        .claim_generation(&job, Duration::ZERO)
        .expect("claim");
    assert!(
        f.store
            .build_generation(
                stalled,
                async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
                &mut |_| Ok(())
            )
            .await
            .is_err()
    );
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
}

/// Codex r11 #3 (invariant 2): repeated superseding builds keep only the
/// current generation's vectors; a revocation (lexical desired) and an
/// activation reclaim the checkpoint.
#[tokio::test]
async fn the_checkpoint_stays_bounded_across_supersession_and_revocation() {
    let f = Fixture::new(2);
    publish(&f, "bounded-corpus-0001", &[("a.md", doc("first", 40000))]);
    let mut job = f.set("bounded-profile-0001").generation_id;
    let mut previous = 0;
    for round in 0..3 {
        f.settle_companion(&job).await;
        partial_build(&f, &job, 2).await;
        let rows = checkpoint_rows(&f).expect("checkpoint");
        assert!(rows > 0);
        if round > 0 {
            assert!(rows <= previous, "bounded: {rows} after {previous}");
        }
        previous = rows;
        // Supersede with entirely new content (no shared chunk hash).
        publish(
            &f,
            &format!("bounded-edit-{round}-0001"),
            &[("a.md", doc(&format!("round{round}x"), 40000))],
        );
        job = f.status().desired_generation_id.expect("desired");
    }
    // Revocation: the desired generation becomes lexical; nothing semantic is
    // resumable, so the checkpoint is reclaimed at the next lock pass.
    f.db()
        .execute(
            "UPDATE providers SET revoked=1 WHERE id=?1",
            [f.provider.as_str()],
        )
        .expect("revoke");
    f.store.advance_clock_for_tests(3601);
    f.rebuild("bounded-revoked-rebuild-0001");
    drop(f.store.lock_write(&[]).expect("lock pass"));
    assert_eq!(checkpoint_rows(&f), None);
}

/// R3-L2: a commit that supersedes a running semantic build (never
/// published) must not end reuse: the next build copies the unchanged chunks
/// from the active hybrid file and embeds only the changed ones.
#[tokio::test]
async fn a_build_superseded_mid_build_still_reuses_the_active_file() {
    let f = Fixture::new(2);
    publish(
        &f,
        "supersede-corpus-0001",
        &[
            ("a.md", doc("alpha", 1200)),
            ("b.md", doc("bravo", 1200)),
            ("c.md", doc("charlie", 1200)),
            ("d.md", doc("delta", 1200)),
            ("e.md", doc("echo", 1200)),
        ],
    );
    let seen = RefCell::new(vec![]);
    let job = f.set("supersede-profile-0001");
    assert!(build(&f, &job.generation_id, &seen).await);
    publish(
        &f,
        "supersede-edit-a-0001",
        &[("a.md", doc("alpha2x", 1200))],
    );
    let running = f.status().desired_generation_id.expect("desired");
    f.settle_companion(&running).await;
    // The next commit lands while its first embedding call runs.
    partial_build(&f, &running, 0).await;
    publish(
        &f,
        "supersede-edit-b-0001",
        &[("b.md", doc("bravo2x", 1200))],
    );
    let next = f.status().desired_generation_id.expect("desired");
    assert_ne!(next, running);
    assert_eq!(state_of(&f, &running), "SUPERSEDED");
    seen.borrow_mut().clear();
    assert!(build(&f, &next, &seen).await);
    let embedded = seen.borrow();
    assert!(!embedded.is_empty());
    assert!(
        embedded
            .iter()
            .all(|t| t.contains("alpha2x") || t.contains("bravo2x")),
        "only changed chunks are embedded"
    );
}

/// Review #5: a newest candidate whose hash table is damaged falls through
/// to an older usable file instead of failing the build.
#[tokio::test]
async fn a_damaged_newest_reuse_candidate_falls_through_to_an_older_one() {
    let f = Fixture::new(2);
    let docs = ["a", "b", "c", "d", "e"].map(|n| (format!("{n}.md"), doc(&format!("{n}0x"), 1200)));
    publish(
        &f,
        "damaged-candidate-corpus-0001",
        &docs
            .iter()
            .map(|(p, b)| (p.as_str(), b.clone()))
            .collect::<Vec<_>>(),
    );
    let seen = RefCell::new(vec![]);
    let job = f.set("damaged-candidate-profile-0001");
    assert!(build(&f, &job.generation_id, &seen).await);
    let older = job.generation_id;
    publish(
        &f,
        "damaged-candidate-edit-a-0001",
        &[("a.md", doc("a1x", 1200))],
    );
    let newest = f.status().desired_generation_id.expect("desired");
    assert!(build(&f, &newest, &seen).await);
    // Damage the newest (active) file's hash table: every hash has a bad length.
    let path = f.store.paths().index_file(&f.kb, &newest);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("writable");
    }
    let (root, page): (i64, i64) = {
        let db = Connection::open(&path).expect("file");
        (
            db.query_row(
                "SELECT rootpage FROM sqlite_master WHERE name='chunk_hash'",
                [],
                |r| r.get(0),
            )
            .expect("root page"),
            db.query_row("PRAGMA page_size", [], |r| r.get(0))
                .expect("page size"),
        )
    };
    let mut bytes = std::fs::read(&path).expect("file");
    let at = ((root - 1) * page) as usize;
    bytes[at..at + page as usize].fill(0xA5);
    std::fs::write(&path, bytes).expect("damage the hash table page");
    publish(
        &f,
        "damaged-candidate-edit-b-0001",
        &[("b.md", doc("b1x", 1200))],
    );
    let next = f.status().desired_generation_id.expect("desired");
    seen.borrow_mut().clear();
    assert!(build(&f, &next, &seen).await, "the build succeeds");
    let embedded = seen.borrow();
    assert!(!embedded.is_empty());
    // Reused from the older file: only what changed since it is embedded.
    assert!(
        embedded
            .iter()
            .all(|t| t.contains("a1x") || t.contains("b1x")),
        "only chunks changed since {older} are embedded"
    );
}

/// Review #5: more unpublished superseded generations than one candidate
/// page never hide the retained usable source.
#[tokio::test]
async fn a_burst_of_superseded_builds_never_hides_the_reuse_source() {
    let f = Fixture::new(2);
    let docs = ["a", "b", "c", "d", "e"].map(|n| (format!("{n}.md"), doc(&format!("{n}0x"), 1200)));
    publish(
        &f,
        "burst-corpus-0001",
        &docs
            .iter()
            .map(|(p, b)| (p.as_str(), b.clone()))
            .collect::<Vec<_>>(),
    );
    let seen = RefCell::new(vec![]);
    let job = f.set("burst-profile-0001");
    assert!(build(&f, &job.generation_id, &seen).await);
    for round in 0..20 {
        publish(
            &f,
            &format!("burst-round-edit-{round:04}"),
            &[("a.md", doc(&format!("a{round}burst"), 1200))],
        );
        let running = f.status().desired_generation_id.expect("desired");
        f.settle_companion(&running).await;
        // Interrupted at its first embedding call, then superseded by the next commit.
        partial_build(&f, &running, 0).await;
    }
    publish(
        &f,
        "burst-final-edit-0001",
        &[("a.md", doc("afinalburst", 1200))],
    );
    let next = f.status().desired_generation_id.expect("desired");
    seen.borrow_mut().clear();
    assert!(build(&f, &next, &seen).await);
    let embedded = seen.borrow();
    assert!(!embedded.is_empty());
    assert!(
        embedded.iter().all(|t| t.contains("afinalburst")),
        "only the changed document is embedded"
    );
}

/// Review r2 #5: cancellation stops the reuse walk at once, however many
/// candidates remain; the attempt goes back to PENDING (interrupted).
#[tokio::test]
async fn cancellation_stops_the_reuse_walk() {
    let f = Fixture::new(2);
    publish(
        &f,
        "cancel-reuse-corpus-0001",
        &[("a.md", doc("a0x", 1200))],
    );
    let seen = RefCell::new(vec![]);
    let job = f.set("cancel-reuse-profile-0001");
    assert!(build(&f, &job.generation_id, &seen).await);
    for round in 0..6 {
        publish(
            &f,
            &format!("cancel-reuse-round-{round:04}"),
            &[("a.md", doc(&format!("a{round}cancel"), 1200))],
        );
        let running = f.status().desired_generation_id.expect("desired");
        f.settle_companion(&running).await;
        partial_build(&f, &running, 0).await;
    }
    publish(
        &f,
        "cancel-reuse-final-0001",
        &[("a.md", doc("afinalcancel", 1200))],
    );
    let next = f.status().desired_generation_id.expect("desired");
    f.settle_companion(&next).await;
    let attempt = f
        .store
        .claim_generation(&next, Duration::from_secs(120))
        .expect("claim");
    let cancel = attempt.cancellation();
    let mut candidates = 0;
    let result = f
        .store
        .build_generation(
            attempt,
            async |_, texts| Ok(texts.iter().map(|t| vector(t)).collect()),
            &mut |stage| {
                if stage == kb_local::index::BuildStage::ReuseCandidate {
                    candidates += 1;
                    cancel.cancel().expect("cancel");
                }
                Ok(())
            },
        )
        .await;
    assert_eq!(
        result.err().expect("cancelled").protocol_code(),
        kb_client::ErrorCode::Cancelled
    );
    assert_eq!(candidates, 1, "no further candidate is examined");
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
}

/// Review r2 #2: a stored vector of the wrong width is never copied on: the
/// chunk is embedded again and the new file holds only full-width vectors.
#[tokio::test]
async fn a_malformed_stored_vector_is_embedded_again_not_copied() {
    let f = Fixture::new(2);
    publish(
        &f,
        "malformed-vector-corpus-0001",
        &["a", "b", "c", "d"]
            .map(|n| (format!("{n}.md"), doc(&format!("{n}0x"), 1200)))
            .iter()
            .map(|(p, b)| (p.as_str(), b.clone()))
            .collect::<Vec<_>>(),
    );
    let seen = RefCell::new(vec![]);
    let job = f.set("malformed-vector-profile-0001");
    assert!(build(&f, &job.generation_id, &seen).await);
    let path = f.store.paths().index_file(&f.kb, &job.generation_id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("writable");
    }
    // One stored row of b.md is shortened.
    let shortened: i64 = Connection::open(&path)
        .expect("file")
        .query_row(
            "UPDATE chunk_int8 SET e=substr(e,1,1) WHERE id=(SELECT min(id) FROM chunks WHERE path='b.md') RETURNING id",
            [],
            |r| r.get(0),
        )
        .expect("damage");
    let text: String = Connection::open(&path)
        .expect("file")
        .query_row("SELECT text FROM chunks WHERE id=?1", [shortened], |r| {
            r.get(0)
        })
        .expect("text");
    publish(
        &f,
        "malformed-vector-edit-0001",
        &[("a.md", doc("a1x", 1200))],
    );
    let next = f.status().desired_generation_id.expect("desired");
    seen.borrow_mut().clear();
    assert!(build(&f, &next, &seen).await);
    assert!(
        seen.borrow().contains(&text),
        "the malformed row is embedded again"
    );
    let db = file(&f);
    let bad: i64 = db
        .query_row(
            "SELECT count(*) FROM chunk_int8 WHERE length(e)<>2",
            [],
            |r| r.get(0),
        )
        .expect("widths");
    assert_eq!(bad, 0);
}

/// Disk admission is durable per capacity slab and progress is durable per
/// bounded group/batch, so a one-document edit does not fsync the registry
/// once for every unchanged document in each of its two generations.
#[tokio::test]
async fn incremental_build_admits_storage_in_batches_for_a_150_document_kb() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static ADMISSIONS: AtomicUsize = AtomicUsize::new(0);
    fn meter(_: &kb_local::StorePaths, _: &std::path::Path) -> Result<u64, kb_local::StoreError> {
        ADMISSIONS.fetch_add(1, Ordering::Relaxed);
        Ok(u64::MAX)
    }
    let f = Fixture::new(2);
    let names = (0..149)
        .map(|i| format!("doc-{i:03}.md"))
        .collect::<Vec<_>>();
    let files = names
        .iter()
        .enumerate()
        .map(|(i, path)| (path.as_str(), format!("alpha document {i}\n")))
        .collect::<Vec<_>>();
    for (batch, files) in files.chunks(8).enumerate() {
        publish(&f, &format!("batch-admission-corpus-{batch:03}"), files);
    }
    let seen = RefCell::new(vec![]);
    let first = f.set("batch-admission-profile");
    assert!(build(&f, &first.generation_id, &seen).await);
    let before = vectors(&file(&f), IndexQuantization::BinaryInt8Rescore);
    seen.borrow_mut().clear();
    publish(
        &f,
        "batch-admission-edit",
        &[(names[0].as_str(), "alpha changed document\n".into())],
    );
    f.store.set_disk_meter_for_tests(meter);
    let desired = f.status().desired_generation_id.expect("desired");
    let started = std::time::Instant::now();
    f.settle_companion(&desired).await;
    {
        use std::io::Write;
        writeln!(
            std::io::stderr(),
            "lexical companion: {:?}",
            started.elapsed()
        )
        .expect("measurement");
    }
    let attempt = f
        .store
        .claim_generation(&desired, Duration::from_secs(120))
        .expect("claim");
    let built = f
        .store
        .build_generation(
            attempt,
            async |_, texts| {
                seen.borrow_mut().extend(texts.iter().cloned());
                Ok(texts.iter().map(|text| vector(text)).collect())
            },
            &mut |stage| {
                use std::io::Write;
                writeln!(
                    std::io::stderr(),
                    "semantic {stage:?}: {:?}",
                    started.elapsed()
                )
                .expect("measurement");
                Ok(())
            },
        )
        .await
        .expect("incremental build");
    assert!(f.store.activate_built(built).expect("activate"));
    // Each admission measures the five independently rooted store surfaces.
    let admissions = ADMISSIONS.load(Ordering::Relaxed) / 5;
    {
        use std::io::Write;
        writeln!(std::io::stderr(), "150-document incremental lexical + semantic build: {:?}; storage admissions={admissions}; embedded={}", started.elapsed(), seen.borrow().len()).expect("measurement");
    }
    assert!(
        admissions < 10,
        "storage admission scales with bounded groups, not documents: {admissions}"
    );
    assert_eq!(seen.borrow().len(), 1, "only the changed chunk is embedded");
    let after = vectors(&file(&f), IndexQuantization::BinaryInt8Rescore);
    assert_eq!(before.len(), 150);
    assert_eq!(after.len(), 150);
    assert_eq!(
        before.iter().filter(|row| after.contains(row)).count(),
        149,
        "unchanged vector bytes survive"
    );
}

#[tokio::test]
async fn corrupt_checkpoint_recovery_preserves_other_kbs_and_reembeds() {
    for malformed_schema in [false, true] {
        let f = Fixture::new(2);
        let other = f
            .store
            .create_kb(
                &f.store.owner(),
                kb_local::CreateKbRequest {
                    name: "Unaffected".into(),
                    slug: "unaffected".into(),
                    description: "Durable data survives checkpoint damage".into(),
                    idempotency_key: "checkpoint-other-kb-0001".into(),
                },
            )
            .expect("other KB")
            .kb_id;
        let other_before = f.store.kb(&other).expect("other KB").expect("present");
        let head = Sha::parse(other_before.head_sha.as_ref().expect("head")).expect("sha");
        f.store
            .commit_files(
                &f.store.owner(),
                kb_local::CommitRequest {
                    kb: other.clone(),
                    base_revision: head,
                    idempotency_key: "checkpoint-other-document-0001".into(),
                    changes: vec![kb_local::FileChange {
                        path: "keep.md".into(),
                        content: Some(b"# Keep\n\nDurable document\n".to_vec()),
                    }],
                },
            )
            .expect("other document");
        let other_head = f
            .store
            .kb(&other)
            .expect("other KB")
            .expect("present")
            .head_sha;
        publish(
            &f,
            "corrupt-cache-corpus-0001",
            &[("a.md", doc("alpha", 20000))],
        );
        let job = f.set("corrupt-cache-profile-0001").generation_id;
        partial_build(&f, &job, 1).await;
        assert!(checkpoint_rows(&f).expect("checkpoint") > 0);
        let cache_file = f.store.paths().index_dir(&f.kb).join("vectors.sqlite");
        if malformed_schema {
            // Replace only the derived fixture file with an incompatible schema.
            std::fs::remove_file(&cache_file).expect("fixture checkpoint");
            Connection::open(&cache_file)
                .expect("sqlite")
                .execute_batch("CREATE TABLE cache_meta(id INTEGER PRIMARY KEY,wrong TEXT);")
                .expect("incompatible checkpoint");
        } else {
            std::fs::write(&cache_file, b"not a SQLite database").expect("corrupt checkpoint");
        }
        std::fs::write(cache_file.with_file_name("vectors.sqlite-journal"), b"")
            .expect("checkpoint journal");
        let reopened =
            kb_local::Store::open_existing(&f.root).expect("corrupt cache cannot block startup");
        assert!(!cache_file.exists());
        assert!(!cache_file.with_file_name("vectors.sqlite-journal").exists());
        assert_eq!(
            reopened
                .kb(&other)
                .expect("other KB readable")
                .expect("other KB exists")
                .head_sha,
            other_head
        );
        let document = reopened
            .documents_get(
                &reopened.owner(),
                serde_json::from_value(serde_json::json!({"kbId":other,"path":"keep.md"}))
                    .expect("document input"),
            )
            .expect("unrelated Git document readable");
        assert_eq!(document.markdown, "# Keep\n\nDurable document\n");
        reopened
            .create_kb(
                &reopened.owner(),
                kb_local::CreateKbRequest {
                    name: "Still writable".into(),
                    slug: "still-writable".into(),
                    description: "Recovery does not block writes".into(),
                    idempotency_key: "checkpoint-still-writable-0001".into(),
                },
            )
            .expect("unrelated write");
        drop(reopened);
        let seen = RefCell::new(vec![]);
        assert!(build(&f, &job, &seen).await);
        let count: i64 = file(&f)
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .expect("chunks");
        assert_eq!(
            seen.borrow().len() as i64,
            count,
            "lost checkpoint only costs re-embedding"
        );
    }
}
