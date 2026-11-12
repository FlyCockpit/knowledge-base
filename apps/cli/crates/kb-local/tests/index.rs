//! Real SQLite and activation boundaries; trusted deterministic embedder only.
#[path = "support/model_admission.rs"]
mod model_admission;
#[path = "support/model_host.rs"]
mod model_host;
#[path = "support/index_fixture.rs"]
mod support;
use kb_client::types::*;
use kb_local::{StoreError, index::BuildStage};
use rusqlite::Connection;
use serde_json::json;
use std::time::Duration;
use support::*;

#[tokio::test]
async fn real_sqlite_fts_vec_dimensions_and_accounting() {
    for dims in [2, 1024, 2000] {
        let f = Fixture::new(dims);
        // The profile-less first head is pending a lexical build.
        assert_eq!(f.status().freshness, Freshness::Building);
        let job = f.set("profile-dimensions-0001");
        let pin = f
            .store
            .generation_snapshot(&job.generation_id)
            .expect("valid fixture");
        assert_eq!(pin.profile.as_ref().expect("hybrid").dimensions, dims);
        assert_eq!(
            pin.commit_sha.as_str(),
            f.store
                .kb(&f.kb)
                .expect("valid fixture")
                .expect("valid fixture")
                .head_sha
                .expect("valid fixture")
        );
        let built = f.build(&job.generation_id).await;
        assert!(f.store.activate_built(built).expect("valid fixture"));
        let lease = f
            .store
            .lease_active_generation(&f.store.owner(), &f.kb)
            .expect("valid fixture");
        let db = lease.connection();
        assert!(
            db.query_row("SELECT load_extension('/does-not-exist')", [], |_| Ok(()))
                .expect_err("operation must fail")
                .to_string()
                .contains("not authorized")
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH 'generation'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .expect("valid fixture"),
            1
        );
        // Shared format v1, binary_int8_rescore: bit[ceil(dims/8)*8] with
        // zero pad bits plus int8[dims] at the calibrated scale, meta last.
        let bits = vec![0xffu8; dims / 8]
            .into_iter()
            .chain((!dims.is_multiple_of(8)).then(|| (1u8 << (dims % 8)) - 1))
            .collect::<Vec<_>>();
        assert_eq!(
            db.query_row(
                "SELECT id,vec_distance_hamming(vec_bit(b),vec_bit(?1)),length(b) FROM chunk_bits",
                [&bits],
                |r| Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, i64>(2)?
                ))
            )
            .expect("valid fixture"),
            (1, 0., dims.div_ceil(8) as i64)
        );
        assert_eq!(
            db.query_row("SELECT e FROM chunk_int8 WHERE id=1", [], |r| r
                .get::<_, Vec<u8>>(0))
                .expect("valid fixture"),
            vec![127u8; dims]
        );
        let meta: (String, f64, i64, i64, String) = db
            .query_row(
                "SELECT quantization,int8_scale,dimensions,chunk_count,generation_id FROM meta",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .expect("valid fixture");
        assert_eq!(
            meta,
            (
                "binary_int8_rescore".into(),
                f64::from(1f32 / (dims as f32).sqrt()),
                dims as i64,
                1,
                job.generation_id.to_string()
            )
        );
        assert_eq!(
            pin.quantization,
            kb_local::index_format::IndexQuantization::BinaryInt8Rescore
        );
        let accounting: (i64, i64) = db
            .query_row(
                "SELECT (SELECT count(*) FROM documents),(SELECT count(*) FROM chunks)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("valid fixture");
        assert_eq!(accounting, (1, 1));
        assert_eq!(f.status().freshness, Freshness::Current);
        assert_eq!(f.status().dimensions, Some(dims as i64));
        assert_eq!(f.status().indexed_commit_sha, Some(pin.commit_sha));
        check::<IndexStatusGet>(&f.status());
    }
}

#[tokio::test]
async fn rejects_mixed_nonfinite_zero_vectors_and_2001() {
    for bad in [
        vec![1.],
        vec![0.; 2],
        vec![f64::NAN; 2],
        vec![f64::INFINITY; 2],
        vec![1.; 2001],
    ] {
        let f = Fixture::new(2);
        let job = f.set("profile-rejection-0001");
        let attempt = f
            .store
            .claim_generation(&job.generation_id, Duration::from_secs(60))
            .expect("valid fixture");
        let result = f
            .store
            .build_generation(
                attempt,
                async |_, texts| Ok(texts.iter().map(|_| bad.clone()).collect()),
                &mut |_| Ok(()),
            )
            .await;
        assert!(result.is_err());
        assert!(no_semantic_active(&f));
        assert_eq!(f.status().desired_state, Some(IndexState::Failed));
    }
    let f = Fixture::new(2);
    assert!(f.db().execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,2,'https://example.invalid/embeddings','bad',2001,?2,'READY')",(f.provider.as_str(),format!("sha256:{}","a".repeat(64)))).is_err());
}

#[tokio::test]
async fn reverse_completions_only_activate_latest_and_snapshot_is_immutable() {
    let f = Fixture::new(2);
    let a = f.set("profile-reverse-0001");
    let built_a = f.build(&a.generation_id).await;
    let pin = f
        .store
        .generation_snapshot(&a.generation_id)
        .expect("valid fixture");
    assert!(
        f.db()
            .execute(
                "UPDATE index_generations SET commit_sha=?2 WHERE id=?1",
                (a.generation_id.as_str(), "b".repeat(40))
            )
            .is_err()
    );
    let b = f.rebuild("rebuild-reverse-0001");
    let built_b = f.build(&b.generation_id).await;
    assert!(f.store.activate_built(built_b).expect("valid fixture"));
    assert!(!f.store.activate_built(built_a).expect("valid fixture"));
    assert_eq!(f.status().active_generation_id, Some(b.generation_id));
    assert_eq!(
        f.store
            .generation_snapshot(&a.generation_id)
            .expect("valid fixture"),
        pin
    );
}

#[tokio::test]
async fn revoked_provider_expired_attempt_tombstone_and_old_pointer() {
    for mode in ["revoke", "expire", "tombstone", "owner"] {
        let f = Fixture::new(2);
        let a = f.set("profile-fences-0001");
        assert!(
            f.store
                .activate_built(f.build(&a.generation_id).await)
                .expect("valid fixture")
        );
        let b = f.rebuild("rebuild-fences-0001");
        let built = f.build(&b.generation_id).await;
        match mode {
            "revoke" => {
                f.db()
                    .execute(
                        "UPDATE providers SET revoked=1 WHERE id=?1",
                        [f.provider.as_str()],
                    )
                    .expect("valid fixture");
            }
            "expire" => {
                f.db()
                    .execute(
                        "UPDATE index_generations SET attempt_until_ms=0 WHERE id=?1",
                        [b.generation_id.as_str()],
                    )
                    .expect("valid fixture");
            }
            "tombstone" => {
                f.db()
                    .execute(
                        "UPDATE kbs SET state='TOMBSTONED' WHERE id=?1",
                        [f.kb.as_str()],
                    )
                    .expect("valid fixture");
            }
            _ => {
                f.db()
                    .execute(
                        "UPDATE index_generations SET attempt='foreign' WHERE id=?1",
                        [b.generation_id.as_str()],
                    )
                    .expect("valid fixture");
            }
        }
        assert!(!f.store.activate_built(built).expect("valid fixture"));
        assert_eq!(
            f.store
                .kb(&f.kb)
                .expect("valid fixture")
                .expect("valid fixture")
                .active_generation_id,
            Some(a.generation_id)
        );
        if mode == "revoke" {
            let profile = f
                .store
                .embedding_profile_get(
                    &f.store.owner(),
                    KbRef {
                        kb_id: f.kb.clone(),
                    },
                )
                .expect("valid fixture");
            assert_eq!(
                profile.profile.expect("valid fixture").status,
                ProviderStatus::Revoked
            );
            // The revoked pin's file still leases; search serves its FTS5
            // arm and index status keeps reporting it.
            assert!(
                f.store
                    .lease_active_generation(&f.store.owner(), &f.kb)
                    .is_ok()
            );
            assert_ne!(profile.index.freshness, Freshness::Unavailable);
        }
    }
}

#[tokio::test]
async fn lease_survives_retention_and_failed_build_keeps_old_pointer() {
    let f = Fixture::new(2);
    let a = f.set("profile-retain-0001");
    assert!(
        f.store
            .activate_built(f.build(&a.generation_id).await)
            .expect("valid fixture")
    );
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("valid fixture");
    let b = f.rebuild("rebuild-retain-0001");
    assert!(
        f.store
            .activate_built(f.build(&b.generation_id).await)
            .expect("valid fixture")
    );
    let future = now_ms() + 8 * 24 * 60 * 60 * 1000;
    f.store.sweep_generations(future).expect("valid fixture");
    assert!(f.store.paths().index_file(&f.kb, &a.generation_id).exists());
    assert_eq!(
        lease
            .connection()
            .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
            .expect("valid fixture"),
        1
    );
    drop(lease);
    f.store.sweep_generations(future).expect("valid fixture");
    assert!(!f.store.paths().index_file(&f.kb, &a.generation_id).exists());
    let c = f.rebuild("rebuild-retain-0002");
    let attempt = f
        .store
        .claim_generation(&c.generation_id, Duration::from_secs(60))
        .expect("valid fixture");
    let result = f
        .store
        .build_generation(
            attempt,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |stage| {
                if stage == BuildStage::BeforeFsync {
                    Err(StoreError::StorageUnavailable("injected".into()))
                } else {
                    Ok(())
                }
            },
        )
        .await;
    assert!(result.is_err());
    assert_eq!(f.status().active_generation_id, Some(b.generation_id));
}

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
        "the create's lexical job (D6), the profile set with its lexical companion, and the commit with its companion (nothing semantic was active)"
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
    // L-1: an abandoned attempt (its process exited) is a host interruption:
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
    use kb_local::qwen::{ModelConfiguration, ModelRuntime, Purpose};
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
    // L-1: cancellation releases the generation for a later attempt.
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
        // L-1/L-2: shutdown cancellation and the no-progress watchdog release
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
    // Newer desired work no longer cancels a build that still outranks what
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

/// R3-L5: built-in builds of different KBs run side by side up to the
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
        "plus the create's superseded lexical generation and the profile set's lexical companion (D6)"
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

#[tokio::test]
async fn chunk_limit_fails_before_any_embedding_and_records_its_code() {
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
                idempotency_key: "chunk-limit-document".into(),
                changes: vec![kb_local::FileChange {
                    path: "second.md".into(),
                    content: Some(b"second document".to_vec()),
                }],
            },
        )
        .expect("publication");
    assert!(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(0)
            .is_err()
    );
    assert!(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(kb_local::limits::INDEX_CHUNKS_DEFAULT + 1)
            .is_err()
    );
    f.store.set_limits(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(1)
            .expect("lower-only"),
    );
    let job = f.set("profile-chunk-limit");
    let mut calls = 0;
    let result = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(60))
                .expect("claim"),
            async |pin, texts| {
                calls += 1;
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await;
    assert_eq!(
        result.err().expect("over the limit").protocol_code(),
        kb_client::ErrorCode::QuotaExceeded
    );
    assert_eq!(calls, 0, "no embedding spend");
    assert_eq!(
        f.db()
            .query_row(
                "SELECT state,error_code,reserved_bytes FROM index_generations WHERE id=?1",
                [job.generation_id.as_str()],
                |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?
                ))
            )
            .expect("ledger"),
        ("FAILED".into(), "INDEX_CHUNK_LIMIT_EXCEEDED".into(), 0)
    );
    // kb/1 projection is unchanged.
    assert_eq!(f.status().error_code.as_deref(), Some("INDEX_BUILD_FAILED"));
    assert!(
        !f.store
            .paths()
            .index_file(&f.kb, &job.generation_id)
            .exists()
    );
    f.store.set_limits(
        kb_local::limits::LocalLimits::default()
            .with_index_chunk_limit(2)
            .expect("lower-only"),
    );
    let next = f.rebuild("rebuild-chunk-limit");
    let built = f.build(&next.generation_id).await;
    assert!(
        f.store
            .activate_built(built)
            .expect("at the limit activates")
    );
}

#[tokio::test]
async fn every_chunk_is_embedded_exactly_once_in_id_order() {
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
                idempotency_key: "embed-once-document".into(),
                changes: vec![
                    kb_local::FileChange {
                        path: "b.md".into(),
                        // Distinct words: equal chunk texts would share one vector.
                        content: Some(
                            (0..7000)
                                .map(|i| format!("bravo{i} words "))
                                .collect::<String>()
                                .into_bytes(),
                        ),
                    },
                    kb_local::FileChange {
                        path: "a.md".into(),
                        content: Some(b"alpha".to_vec()),
                    },
                ],
            },
        )
        .expect("publication");
    let job = f.set("profile-embed-once");
    let mut embedded = Vec::new();
    let built = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(120))
                .expect("claim"),
            async |pin, texts| {
                assert!(texts.len() <= 32);
                embedded.extend(texts.iter().cloned());
                Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    assert!(f.store.activate_built(built).expect("activation"));
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("lease");
    let rows: Vec<(i64, String, i64, String)> = lease
        .connection()
        .prepare("SELECT id,path,chunk_index,text FROM chunks ORDER BY id")
        .expect("chunks")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .expect("chunks")
        .collect::<Result<_, _>>()
        .expect("chunks");
    assert!(rows.len() > 32);
    // ids are 1..n in bytewise (path, chunk_index) order.
    let mut keys = rows
        .iter()
        .map(|(_, p, i, _)| (p.clone(), *i))
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        rows.iter()
            .map(|(_, p, i, _)| (p.clone(), *i))
            .collect::<Vec<_>>(),
        keys
    );
    assert_eq!(
        rows.iter().map(|r| r.0).collect::<Vec<_>>(),
        (1..=rows.len() as i64).collect::<Vec<_>>()
    );
    // Below 4096 chunks every id is a calibration sample: embedded once, in id order.
    assert_eq!(
        embedded,
        rows.iter().map(|r| r.3.clone()).collect::<Vec<_>>()
    );
    assert_eq!(lease.meta().chunk_count, rows.len() as u64);
    assert_eq!(lease.meta().document_count, 3);
}

#[tokio::test]
async fn reader_refuses_tampered_meta_and_non_rollback_headers() {
    for tamper in [
        "meta",
        "two-meta",
        "snapshot",
        "document-count",
        "chunk-count",
        "zero-counts",
        "record-chunk-count",
        "record-document-count",
        "wal-header",
        "journal",
    ] {
        let f = Fixture::new(2);
        let job = f.set("profile-reader-refusal");
        let built = f.build(&job.generation_id).await;
        assert!(f.store.activate_built(built).expect("activation"));
        let path = f.store.paths().index_file(&f.kb, &job.generation_id);
        assert!(
            !std::path::PathBuf::from(format!("{}-journal", path.display())).exists()
                && !f
                    .store
                    .paths()
                    .index_temp_file(&f.kb, &job.generation_id)
                    .exists(),
            "a published file has no side file"
        );
        match tamper {
            "meta" | "two-meta" | "snapshot" | "document-count" | "chunk-count" | "zero-counts" => {
                let db = Connection::open(&path).expect("owned test file");
                let sql = match tamper {
                    "meta" => {
                        "UPDATE meta SET commit_sha='0000000000000000000000000000000000000000'"
                    }
                    "two-meta" => "INSERT INTO meta SELECT * FROM meta",
                    "document-count" => "UPDATE meta SET document_count=document_count+1",
                    "chunk-count" => "UPDATE meta SET chunk_count=chunk_count+1",
                    // A populated file claiming zero rows.
                    "zero-counts" => "UPDATE meta SET document_count=0,chunk_count=0",
                    _ => "UPDATE meta SET host_snapshot='{}'",
                };
                db.execute_batch(sql).expect("tamper");
            }
            "record-chunk-count" | "record-document-count" => {
                let column = if tamper == "record-chunk-count" {
                    "chunk_count"
                } else {
                    "document_count"
                };
                f.db()
                    .execute(
                        &format!("UPDATE index_generations SET {column}={column}+1 WHERE id=?1"),
                        [job.generation_id.as_str()],
                    )
                    .expect("tamper record");
            }
            "wal-header" => {
                let mut bytes = std::fs::read(&path).expect("file");
                bytes[18] = 2;
                bytes[19] = 2;
                std::fs::write(&path, bytes).expect("tamper");
            }
            _ => {
                // A stray non-empty rollback journal beside a published file.
                std::fs::write(format!("{}-journal", path.display()), vec![0x5a; 4096])
                    .expect("stray journal");
            }
        }
        let leased = f.store.lease_active_generation(&f.store.owner(), &f.kb);
        // A stray non-empty journal is treated as hot; rolling it back needs a
        // write, which the read-only handle refuses (SQLITE_READONLY_ROLLBACK):
        // documented behavior is refusal, never a silent rollback.
        match leased {
            Err(StoreError::IndexUnavailable) if tamper != "wal-header" => {}
            // A damaged header is always caught by the lock pass (R3-L8):
            // the file is lost and, by the serving order, the head's
            // retained lexical companion serves meanwhile. The damaged file
            // itself is never leased.
            Ok(lease) if tamper == "wal-header" => {
                assert!(lease.snapshot.is_lexical(), "{tamper}");
                assert_ne!(
                    lease.snapshot.id.as_str(),
                    job.generation_id.as_str(),
                    "{tamper}"
                );
            }
            other => panic!("{tamper}: {:?}", other.err()),
        }
    }
}

#[tokio::test]
async fn retention_reclaims_a_journal_beside_a_published_file() {
    let f = Fixture::new(2);
    let old = f.set("profile-journal-retention");
    let built = f.build(&old.generation_id).await;
    assert!(f.store.activate_built(built).expect("activation"));
    let next = f.rebuild("rebuild-journal-retention");
    let built = f.build(&next.generation_id).await;
    assert!(f.store.activate_built(built).expect("activation"));
    let file = f.store.paths().index_file(&f.kb, &old.generation_id);
    let journal = std::path::PathBuf::from(format!("{}-journal", file.display()));
    std::fs::write(&journal, vec![0x5a; 512]).expect("stray journal");
    assert_eq!(
        f.store
            .sweep_generations(now_ms() + 8 * 24 * 60 * 60 * 1000)
            .expect("sweep"),
        3,
        "plus the create's superseded lexical generation and the profile set's lexical companion (D6)"
    );
    assert!(!file.exists());
    assert!(!journal.exists(), "no orphan after reclamation");
    assert!(
        f.store
            .paths()
            .index_file(&f.kb, &next.generation_id)
            .exists()
    );
}

/// Near-unit raw vector (norm ≈ 1.0000000353) whose int8 bytes differ when a
/// unit vector is normalized a second time: once ⇒ [127×7, 11], twice ⇒
/// [127×7, 10] (scale = its own 0.37778… component).
const TWICE_SENSITIVE: [f64; 8] = [
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.377_780_079_841_613_77,
    0.031_233_789_399_266_243,
];
fn fnv(text: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    h
}
/// FNV-1a's low bit is a byte-parity sum; use a high bit.
fn is_twice_sensitive(h: u64) -> bool {
    (h >> 61) & 1 == 0
}
/// Deterministic 8-d vectors: half the chunks (by text hash) get
/// TWICE_SENSITIVE; the rest are distinguishable, with every unit component
/// below 0.37 so the calibration scale is TWICE_SENSITIVE's 0.37778….
fn text_vector(text: &str) -> Vec<f64> {
    let h = fnv(text);
    if is_twice_sensitive(h) {
        return TWICE_SENSITIVE.to_vec();
    }
    (0..8)
        .map(|k| {
            let bits = (h >> (8 * k)) & 0xff;
            let magnitude = 1. + 0.05 * (bits >> 1) as f64 / 127.;
            if bits & 1 == 0 { magnitude } else { -magnitude }
        })
        .collect()
}

#[tokio::test]
async fn above_4096_chunks_calibrates_on_the_sample_and_embeds_each_chunk_once() {
    let f = Fixture::new(8);
    let head = kb_client::types::Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("fixture")
            .expect("fixture")
            .head_sha
            .expect("head"),
    )
    .expect("sha");
    // 8 documents x 165,000 unique words: > 4,096 windows of 400 words / step 320.
    let changes = (0..8)
        .map(|d| kb_local::FileChange {
            path: format!("d{d}.md"),
            content: Some(
                (0..165_000)
                    .map(|i| format!("w{d}x{i:x}"))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .into_bytes(),
            ),
        })
        .collect();
    f.store
        .commit_files(
            &f.store.owner(),
            kb_local::CommitRequest {
                kb: f.kb.clone(),
                base_revision: head,
                idempotency_key: "embed-once-large-corpus".into(),
                changes,
            },
        )
        .expect("publication");
    let job = f.set("profile-embed-once-large");
    let mut embedded = Vec::new();
    let built = f
        .store
        .build_generation(
            f.store
                .claim_generation(&job.generation_id, Duration::from_secs(600))
                .expect("claim"),
            async |_, texts| {
                embedded.extend(texts.iter().cloned());
                Ok(texts.iter().map(|t| text_vector(t)).collect())
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("build");
    assert!(f.store.activate_built(built).expect("activation"));
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("lease");
    let db = lease.connection();
    let rows: Vec<(i64, String, Vec<u8>, Vec<u8>)> = db
        .prepare("SELECT c.id,c.text,b.b,i.e FROM chunks c JOIN chunk_bits b ON b.id=c.id JOIN chunk_int8 i ON i.id=c.id ORDER BY c.id")
        .expect("rows")
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .expect("rows")
        .collect::<Result<_, _>>()
        .expect("rows");
    let n = rows.len() as u64;
    assert!(n > 4096, "{n} chunks");
    assert_eq!(lease.meta().chunk_count, n);
    use kb_local::index_format as fmt;
    let unit = |text: &str| fmt::unit_vector(&text_vector(text), 8).expect("unit");
    let sample = fmt::calibration_ids(n);
    assert!(
        sample.len() < rows.len(),
        "stride > 1: some chunks are unsampled"
    );
    let sampled = sample
        .iter()
        .map(|id| unit(&rows[*id as usize - 1].1))
        .collect::<Vec<_>>();
    let scale = fmt::int8_scale(sampled.iter().map(Vec::as_slice)).expect("scale");
    assert_eq!(lease.meta().int8_scale, Some(scale));
    // Sample first (in id order), then every unsampled chunk in id order:
    // each chunk exactly once.
    let sampled_ids = sample
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let expected = sample
        .iter()
        .map(|id| rows[*id as usize - 1].1.clone())
        .chain(
            rows.iter()
                .filter(|r| !sampled_ids.contains(&(r.0 as u64)))
                .map(|r| r.1.clone()),
        )
        .collect::<Vec<_>>();
    assert_eq!(embedded.len(), rows.len());
    assert!(embedded == expected, "embedding order and multiplicity");
    // Every vector lands on its own id.
    for (id, text, bits, int8) in &rows {
        let u = unit(text);
        assert_eq!(bits, &fmt::binary_bits(&u), "bits {id}");
        assert_eq!(
            int8,
            &fmt::i8_bytes(&fmt::quantize_int8(&u, scale).expect("int8")),
            "int8 {id}"
        );
    }
    // Normalized exactly once on both the sampled (cached) and the unsampled
    // path: the spec bytes, never the double-normalized [127×7, 10].
    let once = fmt::unit_vector(&TWICE_SENSITIVE, 8).expect("unit");
    assert_eq!(scale, f64::from(once[0]));
    let mut seen = (0, 0);
    for (id, text, bits, int8) in &rows {
        if !is_twice_sensitive(fnv(text)) {
            continue;
        }
        assert_eq!(bits, &vec![0xffu8], "bits {id}");
        assert_eq!(
            int8,
            &vec![127u8, 127, 127, 127, 127, 127, 127, 11],
            "int8 {id}"
        );
        if sampled_ids.contains(&(*id as u64)) {
            seen.0 += 1;
        } else {
            seen.1 += 1;
        }
    }
    assert!(seen.0 > 0 && seen.1 > 0, "both paths covered: {seen:?}");
}

/// The same near-unit vector through the real external-provider entry point
/// (`build_index` + OpenAI-compatible JSON): the adapter passes the raw f64
/// values on unchanged, and the index normalizes them exactly once.
#[tokio::test]
async fn provider_vectors_are_normalized_once_through_the_real_embedding_path() {
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
            Ok(Secret::new("disposable-normalize-fixture".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
    }
    struct Io;
    impl Dns for Io {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async { Ok(vec!["8.8.8.8".parse().expect("fixture IP")]) })
        }
    }
    impl Http for Io {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            body: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                let body: serde_json::Value = serde_json::from_slice(&body).expect("request");
                let n = body["input"].as_array().expect("texts").len();
                // Decimal JSON exactly as a provider sends it.
                let embedding = format!("[{}]", TWICE_SENSITIVE.map(|v| v.to_string()).join(","));
                let data = (0..n)
                    .map(|i| format!(r#"{{"index":{i},"embedding":{embedding}}}"#))
                    .collect::<Vec<_>>()
                    .join(",");
                Ok(HttpResponse {
                    status: 200,
                    body: format!(r#"{{"data":[{data}]}}"#).into_bytes(),
                })
            })
        }
    }
    let f = Fixture::new(8);
    let job = f.set("profile-normalize-once");
    let egress = PinnedEgress::new(&Io, &Io);
    assert!(
        f.store
            .build_index(
                f.store
                    .claim_generation(&job.generation_id, Duration::from_secs(120))
                    .expect("claim"),
                IndexEmbedder::External {
                    keys: &Keys,
                    egress: &egress,
                },
            )
            .await
            .expect("build")
    );
    let lease = f
        .store
        .lease_active_generation(&f.store.owner(), &f.kb)
        .expect("lease");
    let stored: (Vec<u8>, Vec<u8>) = lease
        .connection()
        .query_row(
            "SELECT b.b,i.e FROM chunk_bits b JOIN chunk_int8 i ON i.id=b.id WHERE b.id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("vectors");
    assert_eq!(stored.0, vec![0xff]);
    assert_eq!(stored.1, vec![127u8, 127, 127, 127, 127, 127, 127, 11]);
    assert_eq!(lease.meta().int8_scale, Some(0.377_780_079_841_613_77));
}

/// The shared `dims12-pad-bits` case (values not f32-representable) through
/// the real external-provider entry point, as int8 and as
/// binary_int8_rescore: stored f32 bytes, int8, bits and scale equal the
/// fixture.
#[tokio::test]
async fn shared_dims12_case_through_the_real_provider_path() {
    use kb_local::{
        credentials::{Credentials, Secret},
        egress::{Dns, Endpoint, Http, HttpResponse, IoFuture, PinnedEgress},
        index::IndexEmbedder,
    };
    let cases: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../../packages/api/src/lib/kb/fixtures/index-quantization-cases.json"),
        )
        .expect("shared fixture"),
    )
    .expect("shared fixture");
    let case = cases["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|c| c["name"] == "dims12-pad-bits")
        .expect("dims12-pad-bits")
        .clone();
    let vectors = case["vectors"].as_array().expect("vectors").clone();
    assert_eq!(vectors.len(), 4);
    const WORDS: [&str; 4] = ["zero", "one", "two", "three"];
    struct Keys;
    impl Credentials for Keys {
        fn set(&self, _: &str, _: &Secret) -> Result<(), StoreError> {
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Secret, StoreError> {
            Ok(Secret::new("disposable-dims12-fixture".into()))
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Ok(())
        }
    }
    struct Io(Vec<serde_json::Value>);
    impl Dns for Io {
        fn resolve<'a>(&'a self, _: &'a str, _: u16) -> IoFuture<'a, Vec<std::net::IpAddr>> {
            Box::pin(async { Ok(vec!["8.8.8.8".parse().expect("fixture IP")]) })
        }
    }
    impl Http for Io {
        fn post<'a>(
            &'a self,
            _: &'a Endpoint,
            _: std::net::SocketAddr,
            _: &'a Secret,
            body: Vec<u8>,
        ) -> IoFuture<'a, HttpResponse> {
            Box::pin(async move {
                let body: serde_json::Value = serde_json::from_slice(&body).expect("request");
                let data = body["input"]
                    .as_array()
                    .expect("texts")
                    .iter()
                    .enumerate()
                    .map(|(index, text)| {
                        let word = text
                            .as_str()
                            .expect("text")
                            .rsplit(' ')
                            .next()
                            .expect("word");
                        let at = WORDS.iter().position(|w| *w == word).expect("known text");
                        // The fixture's decimal values, re-serialized exactly.
                        json!({"index": index, "embedding": self.0[at]})
                    })
                    .collect::<Vec<_>>();
                Ok(HttpResponse {
                    status: 200,
                    body: serde_json::to_vec(&json!({ "data": data })).expect("response"),
                })
            })
        }
    }
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    for quantization in ["int8", "binary_int8_rescore"] {
        let f = Fixture::new(12);
        let head = Sha::parse(
            &f.store
                .kb(&f.kb)
                .expect("fixture")
                .expect("fixture")
                .head_sha
                .expect("head"),
        )
        .expect("sha");
        // Exactly the four case vectors: ids 1..4 = a.md..d.md, index.md empty.
        let mut changes = WORDS
            .iter()
            .enumerate()
            .map(|(i, word)| kb_local::FileChange {
                path: format!("{}.md", (b'a' + i as u8) as char),
                content: Some(format!("vector {word}").into_bytes()),
            })
            .collect::<Vec<_>>();
        changes.push(kb_local::FileChange {
            path: "index.md".into(),
            content: Some(vec![]),
        });
        f.store
            .commit_files(
                &f.store.owner(),
                kb_local::CommitRequest {
                    kb: f.kb.clone(),
                    base_revision: head,
                    idempotency_key: "dims12-real-provider".into(),
                    changes,
                },
            )
            .expect("publication");
        // The CLI builds binary_int8_rescore; the int8 run selects the
        // shared format's int8 variant through the test seam.
        f.store
            .set_index_quantization_for_tests(match quantization {
                "int8" => kb_local::index_format::IndexQuantization::Int8,
                _ => kb_local::index_format::IndexQuantization::BinaryInt8Rescore,
            });
        let job = f.set("profile-dims12-real-provider");
        let io = Io(vectors.clone());
        let egress = PinnedEgress::new(&io, &io);
        assert!(
            f.store
                .build_index(
                    f.store
                        .claim_generation(&job.generation_id, Duration::from_secs(120))
                        .expect("claim"),
                    IndexEmbedder::External {
                        keys: &Keys,
                        egress: &egress,
                    },
                )
                .await
                .expect("build")
        );
        let lease = f
            .store
            .lease_active_generation(&f.store.owner(), &f.kb)
            .expect("lease");
        let db = lease.connection();
        assert_eq!(lease.meta().chunk_count, 4);
        for i in 0..4usize {
            let id = i as i64 + 1;
            let text: String = db
                .query_row("SELECT text FROM chunks WHERE id=?1", [id], |r| r.get(0))
                .expect("chunk");
            assert_eq!(text, format!("vector {}", WORDS[i]));
            if quantization == "int8" {
                let stored: Vec<u8> = db
                    .query_row(
                        "SELECT embedding FROM chunk_vec WHERE rowid=?1",
                        [id],
                        |r| r.get(0),
                    )
                    .expect("int8 bytes");
                let expected = case["int8"][i]
                    .as_array()
                    .expect("int8")
                    .iter()
                    .map(|v| v.as_i64().expect("int8") as i8 as u8)
                    .collect::<Vec<_>>();
                assert_eq!(stored, expected, "int8 {i}");
            } else {
                let (bits, int8): (Vec<u8>, Vec<u8>) = db
                    .query_row(
                        "SELECT b.b,i.e FROM chunk_bits b JOIN chunk_int8 i ON i.id=b.id WHERE b.id=?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .expect("vectors");
                assert_eq!(
                    hex(&bits),
                    case["bitsHex"][i].as_str().expect("hex"),
                    "bits {i}"
                );
                let expected = case["int8"][i]
                    .as_array()
                    .expect("int8")
                    .iter()
                    .map(|v| v.as_i64().expect("int8") as i8 as u8)
                    .collect::<Vec<_>>();
                assert_eq!(int8, expected, "int8 {i}");
            }
        }
        assert_eq!(lease.meta().int8_scale, case["int8Scale"].as_f64());
    }
}

/// Nothing semantic serves: no active generation, or only the lexical
/// companion that keeps the KB searchable.
fn no_semantic_active(f: &Fixture) -> bool {
    let record = f.store.kb(&f.kb).expect("kb").expect("kb");
    record.active_generation_id.is_none_or(|id| {
        f.store
            .generation_snapshot(&id)
            .expect("snapshot")
            .is_lexical()
    })
}

/// The generation/attempt state machine (docs/embeddings.md, generations.rs):
/// every row of the transition table, driven through the real Store API.
#[tokio::test]
async fn generation_state_machine_walks_every_transition() {
    let f = Fixture::new(2);
    let state = |id: &KbId| -> String {
        f.db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .expect("state")
    };
    let active = || {
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id
    };
    let rebuild = |key: &str| {
        f.store.advance_clock_for_tests(3601); // hourly rebuild budget
        f.store
            .index_rebuild(
                &f.store.owner(),
                serde_json::from_value(json!({"kbId":f.kb,"idempotencyKey":key,"confirm":"RUN"}))
                    .expect("input"),
            )
            .expect("rebuild")
            .generation_id
    };
    let claim = |id: &KbId, window: Duration| f.store.claim_generation(id, window);
    let vectors = async |pin: &kb_local::generations::ProfileSnapshot, texts: &[String]| {
        Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect())
    };

    // scheduled -> PENDING; a semantic claim waits for its companion.
    let job = f.set_raw("state-machine-profile").generation_id;
    assert_eq!(state(&job), "PENDING");
    assert!(matches!(
        claim(&job, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    f.settle_companion(&job).await;
    let companion = active().expect("companion active");
    assert!(
        f.store
            .generation_snapshot(&companion)
            .expect("s")
            .is_lexical()
    );

    // BUILDING -> PENDING on a host cancellation (shutdown).
    let a = claim(&job, Duration::from_secs(60)).expect("claim");
    assert_eq!(state(&job), "BUILDING");
    a.cancel().expect("cancel");
    assert!(
        f.store
            .build_generation(a, vectors, &mut |_| Ok(()))
            .await
            .is_err()
    );
    assert_eq!(state(&job), "PENDING");

    // BUILDING -> PENDING when the owning process is gone (orphan), any number of times.
    for _ in 0..=kb_local::generations::MAX_STALLED_ATTEMPTS {
        drop(claim(&job, Duration::from_secs(60)).expect("claim"));
        drop(f.store.lock_write(&[]).expect("reconcile"));
        assert_eq!(state(&job), "PENDING");
    }

    // BUILDING -> PENDING on a no-progress watchdog; the third stall in a row -> FAILED.
    for stall in 1..=kb_local::generations::MAX_STALLED_ATTEMPTS {
        let a = claim(&job, Duration::ZERO).expect("claim");
        assert!(
            f.store
                .build_generation(a, vectors, &mut |_| Ok(()))
                .await
                .is_err()
        );
        let expected = if stall == kb_local::generations::MAX_STALLED_ATTEMPTS {
            "FAILED"
        } else {
            "PENDING"
        };
        assert_eq!(state(&job), expected, "stall {stall}");
    }

    // BUILDING -> FAILED on a build error.
    let failing = rebuild("state-machine-rebuild-01");
    let a = claim(&failing, Duration::from_secs(60)).expect("claim");
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
    assert_eq!(state(&failing), "FAILED");

    // BUILDING -> COMPLETE; a cancelled activation leaves it COMPLETE and
    // recovery activates it under a fresh attempt.
    let done = rebuild("state-machine-rebuild-02");
    let a = claim(&done, Duration::from_secs(60)).expect("claim");
    let cancel = a.cancellation();
    let built = f
        .store
        .build_generation(a, vectors, &mut |_| Ok(()))
        .await
        .expect("built");
    assert_eq!(state(&done), "COMPLETE");
    cancel.cancel().expect("cancel");
    assert!(!f.store.activate_built(built).expect("activation"));
    assert_eq!(state(&done), "COMPLETE");
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(active(), Some(done.clone()));

    // COMPLETE awaiting activation while newer desired work is scheduled: it
    // still outranks the active one (same head, newer epoch), so it is
    // kept and serves until the desired work does.
    let replaced = rebuild("state-machine-rebuild-03");
    let built = f.build(&replaced).await;
    let newer = rebuild("state-machine-rebuild-04");
    assert_eq!(state(&replaced), "COMPLETE");
    // (The budget clock advance expired this attempt: recovery activates it.)
    drop(built);
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(active(), Some(replaced.clone()));

    // PENDING -> SUPERSEDED by newer desired work.
    let newest = rebuild("state-machine-rebuild-05");
    assert_eq!(state(&newer), "SUPERSEDED");

    // COMPLETE -> active; the previous active one is retired by the next scheduling.
    assert!(
        f.store
            .activate_built(f.build(&newest).await)
            .expect("activate")
    );
    assert_eq!(active(), Some(newest.clone()));
    rebuild("state-machine-rebuild-06");
    assert_eq!(state(&done), "SUPERSEDED");
    assert_eq!(state(&companion), "SUPERSEDED");
    assert_eq!(active(), Some(newest.clone()));

    // Active older hybrid plus a new head: lexical@head is scheduled,
    // serves as soon as it completes, and keeps serving while semantic@head
    // fails.
    let head = Sha::parse(
        &f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
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
                idempotency_key: "state-machine-new-head".into(),
                changes: vec![kb_local::FileChange {
                    path: "new-head.md".into(),
                    content: Some(b"a new head".to_vec()),
                }],
            },
        )
        .expect("publication");
    let semantic = f.status().desired_generation_id.expect("desired");
    assert_eq!(active(), Some(newest.clone()));
    assert!(matches!(
        claim(&semantic, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    f.settle_companion(&semantic).await;
    let s = f.store.generation_snapshot(&semantic).expect("s");
    let covering: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2",
            (s.kb_id.as_str(), s.epoch - 1),
            |r| r.get(0),
        )
        .expect("companion");
    let covering = KbId::parse(&covering).expect("id");
    assert_eq!(state(&covering), "COMPLETE");
    assert_eq!(active(), Some(covering.clone()), "read-your-writes");
    let a = claim(&semantic, Duration::from_secs(60)).expect("claim");
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
    assert_eq!(state(&semantic), "FAILED");
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(active(), Some(covering));
}

/// Codex r3 #3: completion recovery walks the serve order (semantic@head,
/// lexical@head, newest first) and falls through a refused activation. Both
/// generations of the head are COMPLETE and unactivated, and the semantic
/// profile became unusable without a reschedule: the lexical one serves.
#[tokio::test]
async fn completion_recovery_falls_through_to_lexical_when_semantic_cannot_activate() {
    let f = Fixture::new(2);
    let job = f.set_raw("recovery-fallthrough-0001").generation_id;
    let s = f.store.generation_snapshot(&job).expect("snapshot");
    let companion: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2 AND state='PENDING'",
            (s.kb_id.as_str(), s.epoch - 1),
            |r| r.get(0),
        )
        .expect("companion");
    let companion = KbId::parse(&companion).expect("companion id");
    let state = |id: &KbId| -> String {
        f.db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .expect("state")
    };
    // The companion completes; its unfinished activation keeps the completion
    // permit, so recovery cannot take it over yet.
    let lexical = f
        .store
        .build_generation(
            f.store
                .claim_generation(&companion, Duration::from_secs(120))
                .expect("claim companion"),
            async |_, _| -> Result<Vec<Vec<f64>>, StoreError> {
                panic!("a lexical companion never embeds")
            },
            &mut |_| Ok(()),
        )
        .await
        .expect("companion built");
    assert_eq!(state(&companion), "COMPLETE");
    // The semantic generation completes; its activation is cancelled.
    let a = f
        .store
        .claim_generation(&job, Duration::from_secs(120))
        .expect("claim semantic");
    let cancel = a.cancellation();
    let semantic = f
        .store
        .build_generation(
            a,
            async |pin, texts| Ok(texts.iter().map(|_| vec![1.; pin.dimensions]).collect()),
            &mut |_| Ok(()),
        )
        .await
        .expect("semantic built");
    cancel.cancel().expect("cancel");
    assert!(!f.store.activate_built(semantic).expect("activation"));
    drop(lexical);
    assert_eq!(state(&job), "COMPLETE");
    assert_eq!(state(&companion), "COMPLETE");
    assert!(
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id
            .is_none()
    );
    // The semantic profile is unusable now (revoked, no reschedule yet).
    f.db()
        .execute(
            "UPDATE providers SET revoked=1 WHERE id=?1",
            [f.provider.as_str()],
        )
        .expect("revoke");
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id,
        Some(companion.clone())
    );
    // The refused semantic completion is not activated by a later pass either.
    drop(f.store.lock_write(&[]).expect("recovery"));
    assert_eq!(
        f.store
            .kb(&f.kb)
            .expect("kb")
            .expect("kb")
            .active_generation_id,
        Some(companion)
    );
    assert_ne!(state(&job), "BUILDING");
}

/// Server/CLI normalization parity on real built-in model output: the shared
/// fixture holds raw pooled vectors from the real Qwen and Gemma runtimes and
/// the server's `unitVector` bytes; the CLI's one normalization must produce
/// exactly those bytes (the server's format.test.ts asserts the same).
#[test]
fn normalization_matches_the_server_on_real_model_output() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/test-utils/src/kb/embedding-normalization.json"
    ))
    .expect("fixture");
    let models = fixture["models"].as_object().expect("models");
    assert_eq!(models.len(), 2);
    for rows in models.values() {
        for row in rows.as_array().expect("rows") {
            let raw = row["raw"]
                .as_array()
                .expect("raw")
                .iter()
                .map(|v| v.as_f64().expect("f64"))
                .collect::<Vec<_>>();
            assert!(raw.iter().map(|v| v * v).sum::<f64>().sqrt() > 10.);
            let unit = kb_local::index_format::unit_vector(&raw, raw.len()).expect("unit");
            let hex = unit
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            assert_eq!(
                hex,
                row["unitF32Hex"].as_str().expect("hex"),
                "{}",
                row["id"]
            );
        }
    }
}

/// Codex r9: dependency satisfaction is a completion question, not attempt
/// liveness. An unbuilt companion attempt that expired and was dropped never
/// unblocks the semantic claim on the same open store (no recovery in
/// between): the claim, holding the KB permit, requeues the abandoned
/// companion and defers until it really completes.
#[tokio::test]
async fn an_expired_companion_attempt_never_satisfies_the_semantic_dependency() {
    for indexing in [false, true] {
        expired_companion_attempt(indexing).await;
    }
}
/// `indexing`: the abandoned companion had reached INDEXING (any in-progress
/// state of the state machine requeues the same way).
async fn expired_companion_attempt(indexing: bool) {
    let f = Fixture::new(2);
    let job = f.set_raw("expired-companion-0001").generation_id;
    let s = f.store.generation_snapshot(&job).expect("snapshot");
    let companion: String = f
        .db()
        .query_row(
            "SELECT id FROM index_generations WHERE kb_id=?1 AND epoch=?2 AND state='PENDING'",
            (s.kb_id.as_str(), s.epoch - 1),
            |r| r.get(0),
        )
        .expect("companion");
    let companion = KbId::parse(&companion).expect("id");
    let state = |id: &KbId| -> String {
        f.db()
            .query_row(
                "SELECT state FROM index_generations WHERE id=?1",
                [id.as_str()],
                |r| r.get(0),
            )
            .expect("state")
    };
    let abandoned = f
        .store
        .claim_generation(&companion, Duration::from_secs(1))
        .expect("claim companion");
    assert_eq!(state(&companion), "BUILDING");
    if indexing {
        f.db()
            .execute(
                "UPDATE index_generations SET state='INDEXING' WHERE id=?1",
                [companion.as_str()],
            )
            .expect("indexing");
    }
    f.store.advance_clock_for_tests(2);
    drop(abandoned);
    assert!(matches!(
        f.store.claim_generation(&job, Duration::from_secs(60)),
        Err(StoreError::RateLimited(_))
    ));
    assert_eq!(state(&companion), "PENDING", "requeued under the KB permit");
    assert_eq!(state(&job), "PENDING");
    f.settle_companion(&job).await;
    assert_eq!(state(&companion), "COMPLETE");
    assert!(
        f.store
            .claim_generation(&job, Duration::from_secs(60))
            .is_ok()
    );
}
