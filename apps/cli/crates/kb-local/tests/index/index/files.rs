//! Generation files: real SQLite/FTS/vec, activation order, retention leases and tampered headers.

use super::*;

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
            // A damaged header is always caught by the lock pass:
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
        "plus the create's superseded lexical generation and the profile set's lexical companion"
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
