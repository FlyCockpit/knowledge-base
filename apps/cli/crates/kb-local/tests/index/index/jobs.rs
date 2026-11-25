//! Durable build jobs: permits, slots, cancellation, tombstones and claim settlement.

use super::*;

#[test]
fn confirmations_permissions_idempotence_and_durable_jobs() {
    let f = Fixture::new(2);
    let a = f.set("profile-services-0001");
    assert_eq!(a, f.set("profile-services-0001"));
    check::<EmbeddingProfileSet>(&a);
    let p = f
        .store
        .register_principal(
            &f.store.lock_write(&[]).expect("valid fixture"),
            kb_local::PrincipalKind::Test,
            &f.kb,
            &[Permission::Read],
        )
        .expect("valid fixture");
    assert_eq!(
        f.store
            .index_rebuild(
                &p,
                serde_json::from_value(
                    json!({"kbId":f.kb,"idempotencyKey":"rebuild-forbidden-0001","confirm":"RUN"})
                )
                .expect("valid fixture")
            )
            .expect_err("operation must fail")
            .protocol_code(),
        kb_client::ErrorCode::Forbidden
    );
    check::<EmbeddingProfileGet>(
        &f.store
            .embedding_profile_get(
                &p,
                KbRef {
                    kb_id: f.kb.clone(),
                },
            )
            .expect("valid fixture"),
    );
    assert!(
        serde_json::from_value::<IndexRebuildInput>(
            json!({"kbId":f.kb,"idempotencyKey":"rebuild-confirm-0001","confirm":"NO"})
        )
        .is_err()
    );
    let pin = f
        .store
        .generation_snapshot(&a.generation_id)
        .expect("valid fixture");
    let receipt = f
        .store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: pin.commit_sha,
                idempotency_key: "main-index-commit-0001".into(),
                changes: vec![kb_local::FileChange {
                    path: "next.md".into(),
                    content: Some(b"next generation".to_vec()),
                }],
            },
        )
        .expect("valid fixture");
    let desired = f.status().desired_generation_id.expect("valid fixture");
    assert_ne!(desired, a.generation_id);
    assert_eq!(
        f.store
            .generation_snapshot(&desired)
            .expect("valid fixture")
            .commit_sha,
        receipt.commit_sha
    );
    assert_eq!(
        f.db()
            .query_row("SELECT count(*) FROM index_jobs", [], |r| r
                .get::<_, i64>(0))
            .expect("valid fixture"),
        5,
        "the create's lexical job, the profile set with its lexical companion, and the commit with its companion (nothing semantic was active)"
    );
}

#[test]
fn real_os_build_permits_bound_kb_and_recover_abandoned_attempt() {
    let f = Fixture::new(2);
    let job = f.set("profile-permits-0001");
    let attempt = f
        .store
        .claim_generation(&job.generation_id, Duration::from_secs(60))
        .expect("valid fixture");
    assert!(
        f.store
            .claim_generation(&job.generation_id, Duration::from_secs(60))
            .is_err()
    );
    f.store.sweep_generations(u64::MAX).expect("valid fixture");
    assert_eq!(f.status().desired_state, Some(IndexState::Building));
    drop(attempt);
    // An abandoned attempt (its process exited) is a host interruption:
    // retried however often it happens, never a stall, never FAILED.
    for _ in 0..=kb_local::generations::MAX_STALLED_ATTEMPTS {
        drop(f.store.lock_write(&[]).expect("valid fixture"));
        assert_eq!(f.status().desired_state, Some(IndexState::Pending));
        drop(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(60))
                .expect("retry claim"),
        );
    }
}

#[tokio::test]
async fn empty_redacted_and_metadata_documents_are_fully_accounted() {
    let f = Fixture::new(2);
    let head = Sha::parse(
        f.store
            .kb(&f.kb)
            .expect("valid fixture")
            .expect("valid fixture")
            .head_sha
            .as_deref()
            .expect("valid fixture"),
    )
    .expect("valid fixture");
    let sensitive = format!("sk-{}", "x".repeat(48));
    f.store.commit_files(&f.store.owner(),kb_local::CommitRequest{kb:f.kb.clone(),base_revision:head,idempotency_key:"empty-accounting-0001".into(),changes:vec![kb_local::FileChange{path:"index.md".into(),content:Some(Vec::new())},kb_local::FileChange{path:"redacted.md".into(),content:Some(sensitive.into_bytes())},kb_local::FileChange{path:"table.md".into(),content:Some(b"---\nid: table\ntitle: Inventory\ntags: [parts]\n---\n| item | count |\n| --- | --- |\n| bolts | 3 |\n".to_vec())}]}).expect("valid fixture");
    let job = f.set("profile-accounting-0001");
    let built = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(60))
                .expect("valid fixture"),
            async |pin, texts| {
                for text in texts {
                    assert!(!text.contains("sk-"));
                }
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("valid fixture");
    assert!(f.store.activate_built(built).expect("valid fixture"));
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("valid fixture");
    let db = lease.connection();
    for (path, state, windows) in [
        ("index.md", "EMPTY", 0),
        ("redacted.md", "SKIPPED_REDACTED", 1),
        ("table.md", "INDEXED", 1),
    ] {
        assert_eq!(
            db.query_row(
                "SELECT state,original_window_count FROM documents WHERE path=?1",
                [path],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            )
            .expect("valid fixture"),
            (state.into(), windows)
        );
    }
    let (meta, rows): (String, String) = db
        .query_row(
            "SELECT metadata_json,rows_json FROM documents WHERE path='table.md'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("valid fixture");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&meta).expect("valid fixture")["title"],
        "Inventory"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&rows).expect("valid fixture")[0]["values"]["count"],
        3
    );
    assert_eq!(
        db.query_row(
            "SELECT start_token,end_token,start_byte,end_byte FROM chunks WHERE path='table.md'",
            [],
            |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?
            ))
        )
        .expect("valid fixture")
        .0,
        0
    );
}

#[test]
fn global_slots_and_superseded_kb_attempts_remain_exclusive() {
    let f = Fixture::new(2);
    // Sibling KBs' lexical companions are built before any slot is held.
    let jobs = (0..2)
        .map(|n| {
            let kb = f
                .store
                .create_kb(
                    &f.store.owner(),
                    kb_local::CreateKbRequest {
                        name: "Slots".into(),
                        slug: format!("slots-{n}"),
                        description: "Global slot fixtures".into(),
                        idempotency_key: format!("create-global-slots-{n}"),
                    },
                )
                .expect("valid fixture")
                .kb_id;
            let job=f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":kb,"providerId":f.provider,"revision":1,"idempotencyKey":format!("profile-global-slots-{n}"),"confirm":"RUN"})).expect("valid fixture")).expect("valid fixture");
            f.settle_companion_blocking(&job.generation_id);
            job
        })
        .collect::<Vec<_>>();
    let a = f.set("profile-slots-0001");
    let held = f
        .store
        .claim_generation(&a.generation_id, Duration::from_secs(60))
        .expect("valid fixture");
    let b = f.rebuild("rebuild-slots-0001");
    assert!(
        f.store
            .claim_generation(&b.generation_id, Duration::from_secs(60))
            .is_err()
    );
    let mut attempts = vec![held];
    for (n, job) in jobs.iter().enumerate() {
        let attempt = f
            .store
            .claim_generation(&job.generation_id, Duration::from_secs(60));
        if n == 0 {
            attempts.push(attempt.expect("valid fixture"));
        } else {
            assert!(attempt.is_err());
        }
    }
    drop(attempts);
    assert!(
        f.store
            .claim_generation(&b.generation_id, Duration::from_secs(60))
            .is_ok()
    );
}

#[tokio::test]
async fn builtin_disable_changed_model_and_pinned_runtime_dispatch() {
    use kb_local::{
        model_catalog::Purpose,
        qwen::{ModelConfiguration, ModelRuntime},
    };
    let f = Fixture::new(2);
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
                model_id: "embeddinggemma-2-q8_0",
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(8 << 30),
                timeout: Duration::from_secs(60),
            },
        )
        .expect("valid fixture");
    let body = "語".repeat(2048);
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: Sha::parse(
                    f.store
                        .kb(&f.kb)
                        .expect("valid fixture")
                        .expect("valid fixture")
                        .head_sha
                        .as_deref()
                        .expect("valid fixture"),
                )
                .expect("valid fixture"),
                idempotency_key: "builtin-long-source-0001".into(),
                changes: vec![kb_local::FileChange {
                    path: "long.md".into(),
                    content: Some(body.as_bytes().to_vec()),
                }],
            },
        )
        .expect("valid fixture");
    let state = f.store.model_state().expect("valid fixture");
    let set=f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"providerId":"builtin","revision":state.epoch+1,"idempotencyKey":"profile-builtin-0001","confirm":"RUN"})).expect("valid fixture")).expect("valid fixture");
    let built = f.build(&set.generation_id).await;
    f.store
        .model_disable(&f.store.owner())
        .expect("valid fixture");
    assert!(!f.store.activate_built(built).expect("valid fixture"));
    assert!(
        runtime
            .embed_pinned(
                &f.store,
                "hello",
                Purpose::Document,
                Duration::from_secs(5),
                &state
            )
            .is_err()
    );
    runtime
        .configure(
            &f.store,
            &f.store.owner(),
            ModelConfiguration {
                model_id: "qwen3-embedding-0.6b-q8_0",
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(8 << 30),
                timeout: Duration::from_secs(60),
            },
        )
        .expect("valid fixture");
    let job = f.status().desired_generation_id.expect("valid fixture");
    let snapshot = f.store.generation_snapshot(&job).expect("valid fixture");
    assert_eq!(
        snapshot.profile.as_ref().expect("hybrid").model,
        "qwen3-embedding-0.6b-q8_0"
    );
    assert_ne!(job, set.generation_id);
    assert!(
        runtime
            .embed_pinned(
                &f.store,
                "hello",
                Purpose::Document,
                Duration::from_secs(5),
                &state
            )
            .is_err()
    );
    assert!(
        f.store
            .build_index(
                f.store
                    .claim_generation(&job, Duration::from_secs(60))
                    .expect("valid fixture"),
                kb_local::index::IndexEmbedder::Builtin(&runtime)
            )
            .await
            .expect("valid fixture")
    );
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("valid fixture");
    let spans: Vec<(i64, i64)> = lease
        .connection()
        .prepare("SELECT start_byte,end_byte FROM chunks WHERE path='long.md' ORDER BY chunk_index")
        .expect("valid fixture")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("valid fixture")
        .collect::<Result<_, _>>()
        .expect("valid fixture");
    assert!(spans.len() > 1);
    assert_eq!(spans[0].0, 0);
    assert_eq!(spans.last().expect("valid fixture").1, body.len() as i64);
    for (start, end) in spans {
        assert!(body.is_char_boundary(start as usize) && body.is_char_boundary(end as usize));
        assert!(end - start <= 1024);
    }
    assert_eq!(f.status().freshness, Freshness::Current);
    runtime
        .configure(
            &f.store,
            &f.store.owner(),
            ModelConfiguration {
                model_id: "qwen3-embedding-0.6b-q8_0",
                context_tokens: 1024,
                acknowledge_memory_warning: false,
                available_bytes: Some(8 << 30),
                timeout: Duration::from_secs(60),
            },
        )
        .expect("same settings probe");
    assert_eq!(
        f.status().desired_generation_id,
        Some(job.clone()),
        "a runtime epoch alone must not rebuild a current compatible index"
    );
    let head = lease.snapshot.commit_sha.clone();
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: "builtin-park-index".into(),
                changes: vec![kb_local::FileChange {
                    path: "park.md".into(),
                    content: Some(b"park".to_vec()),
                }],
            },
        )
        .expect("publication");
    let id = f.status().desired_generation_id.expect("job");
    // The new head's lexical companion serves as soon as it completes;
    // a host cancellation of semantic@head is not a stall.
    f.settle_companion(&id).await;
    let covering = f.status().active_generation_id.expect("covering");
    assert_ne!(covering, job);
    let attempt = f
        .store
        .claim_generation(&id, Duration::from_secs(30))
        .expect("claim");
    let cancellation = attempt.cancellation();
    let marker = runtime.host().runtime_dir().join("model-test-started");
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let cancel_thread = std::thread::spawn(move || {
        // The long source is read, measured and embedded before park.md. That
        // preparation must not consume the cancellation settlement budget.
        model_admission::wait_for_marker(&marker, || match finished_rx.try_recv() {
            Ok(result) => Some(result),
            Err(std::sync::mpsc::TryRecvError::Empty) => None,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Some("build owner exited".into()),
        })?;
        cancellation.cancel().expect("durable cancellation");
        // Only settlement after admission/cancellation is a latency assertion.
        finished_rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|error| {
                format!("admitted native request did not settle after cancellation: {error}")
            })?;
        Ok::<_, String>(())
    });
    let result = f
        .store
        .build_index(attempt, kb_local::index::IndexEmbedder::Builtin(&runtime))
        .await;
    let _ = finished_tx.send(format!("index build returned {result:?}"));
    cancel_thread
        .join()
        .expect("cancel thread")
        .expect("native admission and cancellation settlement");
    assert_eq!(
        result.expect_err("cancel native request").protocol_code(),
        kb_client::ErrorCode::Cancelled
    );
    // Cancellation releases the generation for a later attempt.
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
    assert_eq!(f.status().active_generation_id, Some(covering));
    // The abandoned request still occupies the shared worker until it ends.
    std::fs::write(
        runtime.host().runtime_dir().join("model-test-release"),
        b"go",
    )
    .expect("release parked request");
    assert!(
        runtime
            .embed(&f.store, "hello", Purpose::Document, Duration::from_secs(5))
            .is_ok()
    );
}

#[tokio::test(start_paused = true)]
async fn cancellation_timeout_failure_retention_and_live_owner_fences() {
    for cancel in [true, false] {
        let f = Fixture::new(2);
        let job = f.set("profile-cancel-0001");
        let a = f
            .store
            .claim_generation(&job.generation_id, Duration::from_secs(900))
            .expect("valid fixture");
        let token = a.cancellation();
        let admitted = std::sync::atomic::AtomicBool::new(false);
        let result = f
            .store
            .build_generation(
                a,
                async |_, _| {
                    admitted.store(true, std::sync::atomic::Ordering::Relaxed);
                    if cancel {
                        token.cancel().expect("durable cancellation");
                    } else {
                        tokio::time::advance(Duration::from_secs(901)).await;
                    }
                    std::future::pending().await
                },
                &mut |_| Ok(()),
            )
            .await;
        assert!(admitted.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(
            result.err().expect("valid fixture").protocol_code(),
            if cancel {
                kb_client::ErrorCode::Cancelled
            } else {
                kb_client::ErrorCode::DeadlineExceeded
            }
        );
        // Shutdown cancellation and the no-progress watchdog release
        // the generation; it is never permanently FAILED by them.
        assert_eq!(f.status().desired_state, Some(IndexState::Pending));
        // An unfinished attempt never reaches the final name.
        assert!(
            !f.store
                .paths()
                .index_file(&f.kb, &job.generation_id)
                .exists()
        );
        let path = f.store.paths().index_temp_file(&f.kb, &job.generation_id);
        assert!(path.exists());
        f.store
            .sweep_generations(now_ms() + 25 * 60 * 60 * 1000)
            .expect("valid fixture");
        assert!(path.exists(), "a retryable attempt's scratch is not swept");
        // The retry discards the old scratch and publishes.
        let built = f.build(&job.generation_id).await;
        assert!(f.store.activate_built(built).expect("valid fixture"));
        assert!(!path.exists());
    }
    let f = Fixture::new(2);
    let job = f.set("profile-owner-0001");
    let built = f.build(&job.generation_id).await;
    f.db().execute("UPDATE store_meta SET owner_principal_id='00000000-0000-4000-8000-000000000001' WHERE id=1",[]).expect("valid fixture");
    assert!(!f.store.activate_built(built).expect("valid fixture"));
}

#[tokio::test]
async fn superseded_live_builder_file_is_not_swept_and_snapshot_never_changes() {
    let f = Fixture::new(2);
    let a = f.set("profile-live-supersede");
    let snapshot = f
        .store
        .generation_snapshot(&a.generation_id)
        .expect("valid fixture");
    let path = f.store.paths().index_temp_file(&f.kb, &a.generation_id);
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&a.generation_id, Duration::from_secs(60))
                .expect("valid fixture"),
            async |pin, texts| {
                assert_eq!(Some(pin), snapshot.profile.as_ref());
                Ok(texts.iter().map(|_| vec![1.; 2]).collect())
            },
            &mut |stage| {
                if stage == BuildStage::Rows {
                    f.rebuild("rebuild-live-supersede");
                    assert_eq!(
                        f.store
                            .sweep_generations(now_ms() + 8 * 24 * 60 * 60 * 1000)
                            .expect("valid fixture"),
                        0
                    );
                    assert!(path.exists());
                }
                Ok(())
            },
        )
        .await;
    // Newer desired work does not cancel a build that still outranks what
    // serves: it completes and serves until the desired one does.
    let built = result.expect("the outranking build completes");
    assert!(f.store.activate_built(built).expect("activation"));
    assert_eq!(
        semantic_active(&f.store, &f.kb),
        Some(a.generation_id.clone())
    );
    assert_eq!(
        f.db()
            .query_row(
                "SELECT sum(reserved_bytes) FROM index_generations",
                [],
                |r| r.get::<_, i64>(0)
            )
            .expect("completed writer releases capacity"),
        0
    );
    assert_eq!(
        f.store
            .generation_snapshot(&a.generation_id)
            .expect("valid fixture"),
        snapshot
    );
}

#[tokio::test]
async fn late_mixed_dimensions_roll_back_all_rows() {
    let f = Fixture::new(2);
    let head = kb_client::types::Sha::parse(
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
                idempotency_key: "mixed-document-0001".into(),
                changes: vec![kb_local::FileChange {
                    path: "second.md".into(),
                    // > 32 chunks: the calibration sample spans two embedding calls.
                    content: Some("second document ".repeat(7000).into_bytes()),
                }],
            },
        )
        .expect("publication");
    let job = f.set("profile-late-mixed");
    let mut calls = 0;
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(60))
                .expect("claim"),
            async |_, texts| {
                calls += 1;
                Ok(texts
                    .iter()
                    .map(|_| vec![1.; if calls == 1 { 2 } else { 1 }])
                    .collect())
            },
            &mut |_| Ok(()),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(calls, 2);
    assert_eq!(f.status().desired_state, Some(IndexState::Failed));
    assert!(
        !f.store
            .paths()
            .index_file(&f.kb, &job.generation_id)
            .exists()
    );
    let db = Connection::open(f.store.paths().index_temp_file(&f.kb, &job.generation_id))
        .expect("failed private file");
    assert_eq!(
        db.query_row("SELECT count(*) FROM chunks", [], |r| r.get::<_, i64>(0))
            .expect("accounting"),
        0
    );
    assert!(no_semantic_active(&f));
}

/// Built-in builds of different KBs run side by side up to the
/// store's built-in slots (they share one worker); one more waits.
#[test]
fn builtin_generations_of_different_kbs_do_not_serialize() {
    // The shared wire name of the built-in model.
    let protocol = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../packages/api/src/lib/kb/protocol/common.ts"),
    )
    .expect("shared protocol");
    assert!(protocol.contains("z.literal(\"builtin\")"));
    let f = Fixture::new(2);
    f.db()
        .execute("UPDATE builtin_model SET enabled=1 WHERE id=1", [])
        .expect("fixture state");
    let revision = f.store.model_state().expect("state").epoch + 1;
    let kb = |n: usize| {
        f.store
            .create_kb(
                &f.store.owner(),
                kb_local::CreateKbRequest {
                    name: format!("Builtin {n}"),
                    slug: format!("builtin-{n}"),
                    description: "Concurrent builtin job".into(),
                    idempotency_key: format!("create-builtin-{n:04}"),
                },
            )
            .expect("KB")
            .kb_id
    };
    let set = |kb: KbId, key: &str| {
        f.store.embedding_profile_set(&f.store.owner(),serde_json::from_value(json!({"kbId":kb,"providerId":"builtin","revision":revision,"idempotencyKey":key,"confirm":"RUN"})).expect("input")).expect("profile")
    };
    let mut kbs = vec![f.kb.clone()];
    kbs.extend((1..=kb_local::generations::BUILTIN_BUILD_SLOTS).map(kb));
    let jobs = kbs
        .into_iter()
        .enumerate()
        .map(|(n, kb)| set(kb, &format!("builtin-concurrent-{n:04}")))
        .collect::<Vec<_>>();
    for job in &jobs {
        f.settle_companion_blocking(&job.generation_id);
    }
    let (last, running) = jobs.split_last().expect("jobs");
    let held = running
        .iter()
        .map(|job| {
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(60))
                .expect("a built-in slot")
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        f.store
            .claim_generation(&last.generation_id, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    drop(held);
    assert!(
        f.store
            .claim_generation(&last.generation_id, Duration::from_secs(60))
            .is_ok()
    );
}

#[tokio::test]
async fn tombstone_cancels_durable_job_and_partial_file_expires() {
    let f = Fixture::new(2);
    let active = f.set("profile-tombstone-job");
    assert!(
        f.store
            .activate_built(f.build(&active.generation_id).await)
            .expect("activate")
    );
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("lease");
    let job = f.rebuild("rebuild-tombstone-job");
    let result = f.store.build_generation(
        f.store.claim_generation(&job.generation_id,Duration::from_secs(60)).expect("claim"),
        async |pin,texts| Ok(texts.iter().map(|_|vec![1.;pin.dimensions]).collect()),
        &mut |stage| {
            if stage == BuildStage::Rows {
                f.store.bases_delete(&f.store.owner(),serde_json::from_value(json!({"kbId":f.kb,"metadataVersion":1,"idempotencyKey":"delete-index-tombstone","confirm":"DELETE"})).expect("input")).expect("tombstone");
            }
            Ok(())
        },
    ).await;
    assert!(result.is_err());
    assert!(no_semantic_active(&f));
    assert_eq!(
        f.db()
            .query_row(
                "SELECT state FROM index_jobs WHERE id=?1",
                [job.job_id.as_str()],
                |r| r.get::<_, String>(0)
            )
            .expect("job"),
        "CANCELLED"
    );
    assert_eq!(
        f.store
            .sweep_generations(now_ms() + 6 * 24 * 60 * 60 * 1000)
            .expect("sweep"),
        0
    );
    assert_eq!(
        f.store
            .sweep_generations(now_ms() + 8 * 24 * 60 * 60 * 1000)
            .expect("sweep"),
        3,
        "plus the create's superseded lexical generation and the profile set's lexical companion"
    );
    assert!(
        !f.store
            .paths()
            .index_file(&f.kb, &job.generation_id)
            .exists()
    );
    let active_file = f.store.paths().index_file(&f.kb, &active.generation_id);
    assert!(
        active_file.exists(),
        "a reader survives KB tombstone and sweep"
    );
    drop(lease);
    assert_eq!(
        f.store
            .sweep_generations(now_ms() + 8 * 24 * 60 * 60 * 1000)
            .expect("sweep"),
        1
    );
    assert!(
        !active_file.exists(),
        "tombstone cannot strand an inactive derived file"
    );
}

#[tokio::test]
async fn an_interrupted_activation_is_recovered_not_superseded() {
    for expired in [false, true] {
        let f = Fixture::new(2);
        let job = f.set("profile-activation-exit");
        let a = f
            .store
            .claim_generation(&job.generation_id, Duration::from_secs(60))
            .expect("claim");
        let token = a.cancellation();
        let built = f
            .store
            .build_generation(
                a,
                async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
                &mut |_| Ok(()),
            )
            .await
            .expect("build");
        let activated = f
            .store
            .activate_built_observed(built, &mut |stage| {
                if stage == BuildStage::BeforeActivationCas {
                    if expired {
                        f.store.advance_clock_for_tests(120);
                    } else {
                        token.cancel().expect("durable cancellation");
                    }
                }
                Ok(())
            })
            .expect("activation");
        // An attempt outcome (its deadline, a host cancellation) never
        // decides still-desired work: the completion stays COMPLETE and
        // recovery activates it under a fresh attempt.
        assert!(!activated);
        let state: String = f
            .db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [job.generation_id.as_str()],
                |r| r.get(0),
            )
            .expect("state");
        assert_eq!(state, "COMPLETE");
        drop(f.store.lock_write(&[]).expect("recovery"));
        assert_eq!(f.status().active_generation_id, Some(job.generation_id));
    }
}

#[tokio::test]
async fn cancellation_while_waiting_for_store_fence_never_completes() {
    let f = Fixture::new(2);
    let job = f.set("profile-cancel-fence");
    let a = f
        .store
        .claim_generation(&job.generation_id, Duration::from_secs(60))
        .expect("claim");
    let token = a.cancellation();
    let mut controller = None;
    let result = f
        .store
        .build_generation(
            a,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |stage| {
                if stage == BuildStage::BeforeComplete {
                    let root = f.root.clone();
                    let token = token.clone();
                    let (tx, rx) = std::sync::mpsc::channel();
                    controller = Some(std::thread::spawn(move || {
                        let s = kb_local::Store::open(&root).expect("second handle");
                        let _guard = s.lock_write(&[]).expect("held fence");
                        tx.send(()).expect("ready");
                        std::thread::sleep(Duration::from_millis(100));
                        token.cancel().expect("durable cancellation");
                        std::thread::sleep(Duration::from_millis(200));
                    }));
                    rx.recv_timeout(Duration::from_secs(5))
                        .expect("fence barrier");
                }
                Ok(())
            },
        )
        .await;
    controller.expect("controller").join().expect("drain");
    assert_eq!(
        result.err().expect("cancelled build").protocol_code(),
        kb_client::ErrorCode::Cancelled
    );
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
}

#[test]
fn pending_build_scan_advances_and_wraps_without_starving_siblings() {
    let f = Fixture::new(2);
    // The profile-less create pends a lexical generation, which the
    // profile set below supersedes.
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
    f.set_raw("scan-profile-0001");
    let other = f
        .store
        .create_kb(
            &f.store.owner(),
            kb_local::CreateKbRequest {
                name: "Sibling".into(),
                slug: "sibling".into(),
                description: "Sibling pending build".into(),
                idempotency_key: "scan-create-0002".into(),
            },
        )
        .expect("sibling")
        .kb_id;
    f.store.embedding_profile_set(&f.store.owner(), serde_json::from_value(json!({"kbId":other,"providerId":f.provider,"revision":1,"idempotencyKey":"scan-profile-0002","confirm":"RUN"})).expect("input")).expect("sibling job");
    // Two KBs, each with a lexical companion and a semantic generation:
    // one pass visits all four, the lexical ones first, then wraps.
    let mut seen = vec![];
    let mut after = None;
    while let Some(id) = f.store.pending_generation(after.as_ref()).expect("scan") {
        assert!(
            !seen.contains(&id),
            "one unclaimable head must not strand a sibling"
        );
        seen.push(id.clone());
        after = Some(id);
    }
    assert_eq!(seen.len(), 4);
    let kinds = seen
        .iter()
        .map(|id| {
            f.store
                .generation_snapshot(id)
                .expect("snapshot")
                .is_lexical()
        })
        .collect::<Vec<_>>();
    assert_eq!(kinds, vec![true, true, false, false]);
    assert_eq!(
        f.store.pending_generation(None).expect("wrap").as_ref(),
        seen.first()
    );
}

#[test]
fn pending_claim_settlement_preserves_successor_running_attempt_and_live_probe() {
    let f = Fixture::new(2);
    let old = f.set("pending-old-profile-001");
    let current = f.rebuild("pending-new-rebuild-001");
    assert!(
        f.store
            .claim_generation(&old.generation_id, Duration::from_secs(60))
            .is_err()
    );
    assert_eq!(f.status().desired_state, Some(IndexState::Pending));
    f.db()
        .execute(
            "UPDATE provider_revisions SET state='PROBING',probe_until_ms=?2 WHERE provider_id=?1",
            (f.provider.as_str(), now_ms() as i64 + 60_000),
        )
        .expect("live probe");
    assert!(matches!(
        f.store
            .claim_generation(&current.generation_id, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    assert_eq!(
        f.status().desired_state,
        Some(IndexState::Pending),
        "a live probe is transient"
    );
    f.db()
        .execute(
            "UPDATE provider_revisions SET state='READY' WHERE provider_id=?1",
            [f.provider.as_str()],
        )
        .expect("probe completion");
    let attempt = f
        .store
        .claim_generation(&current.generation_id, Duration::from_secs(60))
        .expect("legitimate retry");
    f.db()
        .execute(
            "UPDATE providers SET revoked=1 WHERE id=?1",
            [f.provider.as_str()],
        )
        .expect("revoke after claim");
    assert!(
        f.store
            .claim_generation(&current.generation_id, Duration::from_secs(60))
            .is_err()
    );
    assert_eq!(
        f.status().desired_state,
        Some(IndexState::Building),
        "pending settlement never replaces a running attempt"
    );
    drop(attempt);

    let repair = Fixture::new(2);
    let pending = repair.set("pending-repair-profile-001");
    std::fs::remove_file(
        repair
            .store
            .paths()
            .repo_dir(&repair.kb)
            .join("refs/heads/main"),
    )
    .expect("disposable fixture ref divergence");
    assert_eq!(
        repair
            .store
            .claim_generation(&pending.generation_id, Duration::from_secs(60))
            .err()
            .expect("repair gate before pending settlement")
            .protocol_code(),
        kb_client::ErrorCode::RepairRequired
    );
    let states = repair
        .db()
        .query_row(
            "SELECT g.state,j.state FROM index_generations g JOIN index_jobs j ON j.generation_id=g.id WHERE g.id=?1",
            [pending.generation_id.as_str()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .expect("durable repair deferral");
    assert_eq!(states, ("PENDING".into(), "PENDING".into()));
}
