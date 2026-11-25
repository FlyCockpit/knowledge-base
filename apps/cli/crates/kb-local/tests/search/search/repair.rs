//! Repair on first request: corrupt generations, lease retries and repinning.

use super::*;

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
