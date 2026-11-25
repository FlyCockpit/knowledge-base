//! KB lifecycle: layout, create, update, tombstone, quotas and capability-narrowed create.

use super::*;

// ── Creation, layout, replay ────────────────────────────────────────────────

#[test]
fn scratch_files_preserve_bytes_under_canonical_unicode_store_paths() {
    let root = temp_root("scratch-paths").child("store Ω with spaces");
    let store = Store::open(&root).expect("open");
    // Store::open canonicalizes this root (a verbatim path on Windows).
    assert_eq!(
        store.paths().root(),
        root.canonicalize().expect("canonical")
    );
    let created = create(&store, &store.owner(), "scratch", "create-key-scratch-01");
    let kb = kb_of(&created);
    let body = "# Unicode Ω\n\nExact bytes with CRLF next:\r\nend\n";
    let head = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-scratch-01",
        &[("nested/document.md", body)],
    );
    let repo = store.paths().repo_dir(&kb);
    assert_eq!(
        git_bytes(
            &repo,
            &["cat-file", "blob", &format!("{head}:nested/document.md")]
        ),
        body.as_bytes()
    );
    assert_eq!(git(&repo, &["rev-list", "--count", "refs/heads/main"]), "2");
    assert_eq!(
        std::fs::read_dir(store.paths().uploads_dir())
            .expect("scratch directory")
            .count(),
        0
    );
    drop(store);
    let reopened = Store::open(&root).expect("reopen");
    assert_eq!(
        get_kb(&reopened, &reopened.owner(), &kb).expect("get")["kb"]["headSha"],
        head.as_str()
    );
    drop(reopened);
    std::fs::remove_dir_all(root.parent().expect("fixture parent")).expect("cleanup");
}

#[test]
fn initial_repo_head_and_layout() {
    let root = temp_root("layout");
    let store = Store::open(&root).expect("open");
    let created = create(&store, &store.owner(), "alpha", "create-key-layout-01");
    let kb = kb_of(&created);
    let repo = store.paths().repo_dir(&kb);
    assert!(repo.ends_with(format!("repos/kb_{kb}.git")));
    // Bare repo, HEAD -> refs/heads/main, exactly one root commit.
    assert_eq!(git(&repo, &["rev-parse", "--is-bare-repository"]), "true");
    assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
    let head = git(&repo, &["rev-parse", "refs/heads/main"]);
    assert_eq!(created["kb"]["headSha"], head.as_str());
    assert_eq!(git(&repo, &["rev-list", "--count", "refs/heads/main"]), "1");
    assert_eq!(
        git(&repo, &["for-each-ref", "--format=%(refname)"]),
        "refs/heads/main"
    );
    // Fixed initial tree.
    let tree = git(&repo, &["ls-tree", "-r", "--name-only", "refs/heads/main"]);
    assert_eq!(tree, ".assets/manifest.json\n.gitignore\nindex.md");
    assert_eq!(
        git_bytes(&repo, &["cat-file", "blob", "refs/heads/main:index.md"]),
        b"---\nprovenance: agent\n---\n# Knowledge base\n\nA local knowledge base for lifecycle tests\n"
    );
    assert_eq!(
        git_bytes(&repo, &["cat-file", "blob", "refs/heads/main:.gitignore"]),
        b"# kb managed\n"
    );
    assert_eq!(
        git_bytes(
            &repo,
            &["cat-file", "blob", "refs/heads/main:.assets/manifest.json"]
        ),
        b"{\"version\":1,\"entries\":[]}\n"
    );
    // Attachment: owner holds every bit, stable local identity.
    let (locator, namespace) = local_attachment(store.store_uuid(), &kb);
    assert_eq!(
        created["kb"],
        json!({
            "id": kb.as_str(),
            "name": "KB alpha",
            "slug": "alpha",
            "description": "A local knowledge base for lifecycle tests",
            "defaultBranch": "main",
            "headSha": head,
            "metadataVersion": 1,
            "capabilities": ["read", "propose", "write", "review", "manage"],
            "writeMode": "direct",
            "embeddingGeneration": null,
            "attachmentLocator": locator,
            "sealedNamespace": namespace.as_str(),
        })
    );
    assert_eq!(locator, format!("kb-local://{}/{kb}", store.store_uuid()));
    // Get returns the same attachment plus an index status for this head.
    let got = get_kb(&store, &store.owner(), &kb).expect("get");
    assert_eq!(got["kb"], created["kb"]);
    assert_eq!(got["index"]["headSha"], head.as_str());
    assert_eq!(got["index"]["activeGenerationId"], Value::Null);
    // Even without a profile the first head gets a lexical generation.
    assert_eq!(got["index"]["freshness"], "building");
    assert_eq!(got["index"]["desiredState"], "PENDING");
    assert_eq!(got["index"]["desiredEpoch"], "1");
    // Stable store/KB identity across reopen.
    let store_uuid = store.store_uuid().clone();
    drop(store);
    let store = Store::open(&root).expect("reopen");
    assert_eq!(store.store_uuid(), &store_uuid);
    let again = get_kb(&store, &store.owner(), &kb).expect("get after reopen");
    assert_eq!(again["kb"], created["kb"]);
}

#[test]
fn create_replay_mismatch_and_invalid_metadata() {
    let root = temp_root("replay");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let first = create(&store, &owner, "alpha", "create-key-replay-01");
    let second = create(&store, &owner, "alpha", "create-key-replay-01");
    assert_eq!(first, second, "replay returns the same operation and kb");
    let err = store
        .bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "Other name",
                "slug": "alpha",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-replay-01",
            })),
        )
        .expect_err("mismatch");
    assert_eq!(code(err), ErrorCode::IdempotencyMismatch);
    // A second live KB with the same slug conflicts.
    let err = store
        .bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "Dup",
                "slug": "alpha",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-replay-02",
            })),
        )
        .expect_err("slug taken");
    assert_eq!(code(err), ErrorCode::Conflict);
    // Typed callers can mutate plain strings after decoding. Exercise the
    // local admission boundary as well as the shared protocol decoder.
    let mut invalid = input::<BasesCreate>(json!({
        "name": "Valid name",
        "slug": "beta",
        "description": "A local knowledge base for lifecycle tests",
        "idempotencyKey": "create-key-replay-03",
    }));
    invalid.name = "bad\u{7}name".into();
    assert!(
        decode_input::<BasesCreate>(serde_json::to_value(&invalid).expect("serialize")).is_err()
    );
    let err = store
        .bases_create(&owner, invalid)
        .expect_err("control in name");
    assert_eq!(code(err), ErrorCode::InvalidArgument);
    let db = rusqlite::Connection::open(store.paths().state_db()).expect("db");
    assert_eq!(
        db.query_row("SELECT count(*) FROM kbs", [], |row| row.get::<_, i64>(0))
            .expect("registry count"),
        1,
        "invalid metadata must not reserve a hidden KB"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM operation_intents", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("intent count"),
        1,
        "invalid metadata must not reserve an operation"
    );
    drop(db);
    assert_eq!(
        store
            .bases_list(&owner, input::<BasesList>(json!({})))
            .expect("list")
            .items
            .len(),
        1
    );
}

#[test]
fn create_crash_recovery_replays_one_kb() {
    let root = temp_root("crash");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let request = |key: &str| kb_local::CreateKbRequest {
        name: "KB alpha".into(),
        slug: "alpha".into(),
        description: "A local knowledge base for lifecycle tests".into(),
        idempotency_key: key.into(),
    };
    // Crash after the ref moved: recovery finalizes, replay returns the KB.
    let err = store
        .create_kb_observed(&owner, request("create-key-crash-001"), &mut |stage| {
            if stage == Stage::RefMoved {
                Err(StoreError::Internal("simulated crash".into()))
            } else {
                Ok(())
            }
        })
        .expect_err("crash");
    assert_eq!(code(err), ErrorCode::Internal);
    drop(store);
    let store = Store::open(&root).expect("reopen");
    let replay = create(&store, &owner, "alpha", "create-key-crash-001");
    let kb = kb_of(&replay);
    // RefMoved recovery has finalized an ACTIVE KB. Metadata updates must
    // remain available once recovery succeeds, including same-key replay.
    let update = input::<BasesUpdate>(
        json!({ "kbId": kb.as_str(), "metadataVersion": 1, "name": "New", "idempotencyKey": "recovered-update-01" }),
    );
    let updated = store
        .bases_update(&owner, update.clone())
        .expect("update recovered kb");
    wire::<BasesUpdate>(&updated);
    assert_eq!(
        store.bases_update(&owner, update).expect("update replay"),
        updated
    );
    assert_eq!(
        store
            .kb(&kb)
            .expect("registry")
            .expect("row")
            .metadata_version,
        2
    );
    let listed = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].id, kb);
    // Crash while COMMITTING before the ref moved: aborted, stable failure,
    // and the slug is free for a new key.
    let err = store
        .create_kb_observed(&owner, request("create-key-crash-002"), &mut |stage| {
            if stage == Stage::Committing {
                Err(StoreError::Internal("simulated crash".into()))
            } else {
                Ok(())
            }
        })
        .map(|_| ())
        .expect_err("slug of a live kb conflicts before reservation");
    assert_eq!(code(err), ErrorCode::Conflict);
    let err = store
        .create_kb_observed(
            &owner,
            kb_local::CreateKbRequest {
                slug: "beta".into(),
                ..request("create-key-crash-003")
            },
            &mut |stage| {
                if stage == Stage::Committing {
                    Err(StoreError::Internal("simulated crash".into()))
                } else {
                    Ok(())
                }
            },
        )
        .expect_err("crash");
    assert_eq!(code(err), ErrorCode::Internal);
    drop(store);
    let store = Store::open(&root).expect("reopen");
    for _ in 0..2 {
        let err = store
            .bases_create(
                &owner,
                input::<BasesCreate>(json!({
                    "name": "KB alpha",
                    "slug": "beta",
                    "description": "A local knowledge base for lifecycle tests",
                    "idempotencyKey": "create-key-crash-003",
                })),
            )
            .expect_err("stable aborted receipt");
        assert!(matches!(err, StoreError::OperationAborted(_)), "{err:?}");
    }
    let beta = create(&store, &owner, "beta", "create-key-crash-004");
    assert_eq!(beta["kb"]["slug"], "beta");
}

// ── Update ──────────────────────────────────────────────────────────────────

#[test]
fn update_bumps_version_and_rejects_stale_versions() {
    let root = temp_root("update");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-update-01");
    let kb = kb_of(&created);
    let update = |who: &LocalPrincipal, version: i64, key: &str, name: &str| {
        store
            .bases_update(
                who,
                input::<BasesUpdate>(json!({
                    "kbId": kb.as_str(),
                    "metadataVersion": version,
                    "idempotencyKey": key,
                    "name": name,
                })),
            )
            .map(|out| wire::<BasesUpdate>(&out))
    };
    let first = update(&owner, 1, "update-key-000001", "Renamed").expect("update");
    assert_eq!(first["kb"]["name"], "Renamed");
    assert_eq!(first["kb"]["metadataVersion"], 2);
    assert_eq!(first["kb"]["headSha"], created["kb"]["headSha"]);
    let replay = update(&owner, 1, "update-key-000001", "Renamed").expect("replay");
    assert_eq!(replay["operationId"], first["operationId"]);
    assert_eq!(replay["kb"]["metadataVersion"], 2);
    let err = update(&owner, 1, "update-key-000001", "Other").expect_err("mismatch");
    assert_eq!(code(err), ErrorCode::IdempotencyMismatch);
    let err = update(&owner, 1, "update-key-000002", "Stale").expect_err("stale version");
    assert_eq!(code(err), ErrorCode::Conflict);
    let got = get_kb(&store, &owner, &kb).expect("get");
    assert_eq!(got["kb"]["name"], "Renamed");
    assert_eq!(got["kb"]["metadataVersion"], 2);
    // Description-only update.
    let desc = store
        .bases_update(
            &owner,
            input::<BasesUpdate>(json!({
                "kbId": kb.as_str(),
                "metadataVersion": 2,
                "idempotencyKey": "update-key-000003",
                "description": "A new description for this KB",
            })),
        )
        .expect("description");
    assert_eq!(desc.kb.description, "A new description for this KB");
    assert_eq!(desc.kb.metadata_version, 3);
    // Authority: read-only -> FORBIDDEN, unreadable -> NOT_FOUND.
    let read_only = reader(&store, &kb, &[Permission::Read]);
    let err = update(&read_only, 3, "update-key-000004", "Nope").expect_err("forbidden");
    assert_eq!(code(err), ErrorCode::Forbidden);
    let nobody = reader(&store, &kb, &[]);
    let err = update(&nobody, 3, "update-key-000005", "Nope").expect_err("hidden");
    assert_eq!(code(err), ErrorCode::NotFound);
    let manager = reader(&store, &kb, &[Permission::Manage]);
    let managed = update(&manager, 3, "update-key-000006", "Managed").expect("manage");
    assert_eq!(managed["kb"]["metadataVersion"], 4);
    // A private receipt is only replayed under current authority.
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &manager, &kb, &[Permission::Read])
        .expect("narrow");
    drop(guard);
    let err = update(&manager, 3, "update-key-000006", "Managed").expect_err("replay rechecks");
    assert_eq!(code(err), ErrorCode::Forbidden);
}

// ── Capability-narrowed create ──────────────────────────────────────────────

#[test]
fn capability_narrowed_create_obeys_the_ceiling() {
    let root = temp_root("capability");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let owned = kb_of(&create(&store, &owner, "owned", "create-key-cap-00001"));
    let guard = store.lock_write(&[]).expect("lock");
    let err = store
        .register_creator(&guard, PrincipalKind::Config, &[Permission::Write])
        .expect_err("created bits must include read");
    assert_eq!(code(err), ErrorCode::InvalidArgument);
    let creator = store
        .register_creator(
            &guard,
            PrincipalKind::Config,
            &[Permission::Read, Permission::Propose],
        )
        .expect("creator");
    drop(guard);
    let created = create(&store, &creator, "narrow", "create-key-cap-00002");
    let kb = kb_of(&created);
    assert_eq!(created["kb"]["capabilities"], json!(["read", "propose"]));
    assert_eq!(created["kb"]["writeMode"], "proposal_required");
    // The created ceiling never widens through creation.
    let err = store
        .bases_update(
            &creator,
            input::<BasesUpdate>(json!({
                "kbId": kb.as_str(),
                "metadataVersion": 1,
                "idempotencyKey": "update-key-cap-0001",
                "name": "Nope",
            })),
        )
        .expect_err("no manage");
    assert_eq!(code(err), ErrorCode::Forbidden);
    let err = store
        .commit_files(
            &creator,
            CommitRequest {
                kb: kb.clone(),
                base_revision: head_of(&created),
                idempotency_key: "commit-key-cap-0001".into(),
                changes: vec![FileChange {
                    path: "a.md".into(),
                    content: Some(b"# A\n".to_vec()),
                }],
            },
        )
        .expect_err("no write");
    assert_eq!(code(err), ErrorCode::Forbidden);
    // The creator sees only its own KB; the owner sees both with all bits.
    let mine = store
        .bases_list(&creator, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(mine.items.len(), 1);
    assert_eq!(mine.items[0].id, kb);
    assert_eq!(mine.items[0].write_mode, WriteMode::ProposalRequired);
    assert_eq!(
        code(get_kb(&store, &creator, &owned).expect_err("foreign")),
        ErrorCode::NotFound
    );
    let all = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(all.items.len(), 2);
    let owner_view = get_kb(&store, &owner, &kb).expect("owner get");
    assert_eq!(owner_view["kb"]["writeMode"], "direct");
    // Replay under current authority only.
    let replay = create(&store, &creator, "narrow", "create-key-cap-00002");
    assert_eq!(replay["operationId"], created["operationId"]);
    // No create capability -> FORBIDDEN; revocation applies to new creates.
    let plain = reader(&store, &kb, &[Permission::Manage]);
    let err = store
        .bases_create(
            &plain,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "plain",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-cap-00003",
            })),
        )
        .expect_err("no create capability");
    assert_eq!(code(err), ErrorCode::Forbidden);
    let guard = store.lock_write(&[]).expect("lock");
    store
        .revoke_create_capability(&guard, &creator)
        .expect("revoke");
    drop(guard);
    let err = store
        .bases_create(
            &creator,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "again",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-cap-00004",
            })),
        )
        .expect_err("revoked");
    assert_eq!(code(err), ErrorCode::Forbidden);
    // Losing read on the created KB hides it (also from list).
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &creator, &kb, &[])
        .expect("narrow to nothing");
    drop(guard);
    assert_eq!(
        code(get_kb(&store, &creator, &kb).expect_err("hidden")),
        ErrorCode::NotFound
    );
    assert!(
        store
            .bases_list(&creator, input::<BasesList>(json!({})))
            .expect("list")
            .items
            .is_empty()
    );
}

// ── Tombstone ───────────────────────────────────────────────────────────────

#[test]
fn tombstone_retains_history_and_cancels_registered_work() {
    let root = temp_root("tombstone");
    let store = Store::open(&root).expect("open");
    let owner = store.owner();
    let created = create(&store, &owner, "alpha", "create-key-tomb-0001");
    let kb = kb_of(&created);
    let head = commit(
        &store,
        &kb,
        &head_of(&created),
        "commit-key-tomb-0001",
        &[("notes/a.md", "# A\n")],
    );
    let guard = store.lock_write(std::slice::from_ref(&kb)).expect("lock");
    let generation = kb.clone();
    let db = rusqlite::Connection::open(store.paths().state_db()).unwrap();
    db.execute("INSERT INTO index_generations(id,kb_id,epoch,state,created_at,commit_sha,snapshot_json,job_id) VALUES(?1,?1,0,'PENDING','fixture',?2,'{}',?3)",(kb.as_str(),head.as_str(),store.owner().id())).unwrap();
    drop(guard);
    let delete = |who: &LocalPrincipal, version: i64, key: &str| {
        store
            .bases_delete(
                who,
                input::<BasesDelete>(json!({
                    "kbId": kb.as_str(),
                    "metadataVersion": version,
                    "idempotencyKey": key,
                    "confirm": "DELETE",
                })),
            )
            .map(|out| wire::<BasesDelete>(&out))
    };
    // Owner-only; stale version conflicts.
    let manager = reader(&store, &kb, &[Permission::Manage]);
    assert_eq!(
        code(delete(&manager, 1, "delete-key-000001").expect_err("not owner")),
        ErrorCode::Forbidden
    );
    assert_eq!(
        code(delete(&owner, 7, "delete-key-000002").expect_err("stale")),
        ErrorCode::Conflict
    );
    let receipt = delete(&owner, 1, "delete-key-000003").expect("tombstone");
    assert_eq!(receipt["tombstoned"], true);
    let replay = delete(&owner, 1, "delete-key-000003").expect("replay");
    assert_eq!(replay, receipt);
    // Hidden everywhere.
    assert_eq!(
        code(get_kb(&store, &owner, &kb).expect_err("gone")),
        ErrorCode::NotFound
    );
    assert!(
        store
            .bases_list(&owner, input::<BasesList>(json!({})))
            .expect("list")
            .items
            .is_empty()
    );
    assert_eq!(
        code(
            get_doc(
                &store,
                &owner,
                json!({"kbId": kb.as_str(), "path": "notes/a.md", "rev": head.as_str()})
            )
            .expect_err("gone")
        ),
        ErrorCode::NotFound
    );
    // Disk and history retained.
    let repo = store.paths().repo_dir(&kb);
    assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), head.as_str());
    assert_eq!(git(&repo, &["rev-list", "--count", "refs/heads/main"]), "2");
    assert_eq!(
        state_value(&root, "SELECT state FROM kbs WHERE id = ?1", &kb),
        "TOMBSTONED"
    );
    assert_eq!(
        state_value(&root, "SELECT slug FROM kbs WHERE id = ?1", &kb),
        "alpha"
    );
    // Registered work was cancelled.
    let conn = rusqlite::Connection::open(root.join("state.sqlite")).expect("state");
    let state: String = conn
        .query_row(
            "SELECT state FROM index_generations WHERE id = ?1",
            [generation.as_str()],
            |row| row.get(0),
        )
        .expect("generation row");
    assert_eq!(state, "SUPERSEDED");
    // Reopen (recovery runs) keeps the tombstone; the slug is reusable.
    drop(store);
    let store = Store::open(&root).expect("reopen");
    assert_eq!(
        code(get_kb(&store, &owner, &kb).expect_err("still gone")),
        ErrorCode::NotFound
    );
    let again = create(&store, &owner, "alpha", "create-key-tomb-0002");
    assert_ne!(kb_of(&again), kb);
}

// ── Quotas and limits ───────────────────────────────────────────────────────

#[test]
fn live_kb_quota_and_creation_rate_boundaries() {
    let root = temp_root("quota");
    let store = Store::open(&root).expect("open");
    // The local default is far above 20/hour; a lowered window keeps
    // the boundary observable inside the live-KB quota.
    let rate = 5;
    store.set_limits(LocalLimits::lowered(OWNED_LIVE_KBS_PER_USER, rate).expect("lower"));
    let owner = store.owner();
    let mut kbs = Vec::new();
    for i in 0..OWNED_LIVE_KBS_PER_USER {
        if i > 0 && i % rate == 0 {
            // The hourly creation budget is exhausted exactly here.
            let err = store
                .bases_create(
                    &owner,
                    input::<BasesCreate>(json!({
                        "name": "x", "slug": format!("rate-{i}"),
                        "description": "A local knowledge base for lifecycle tests",
                        "idempotencyKey": format!("create-key-rate-{i:04}"),
                    })),
                )
                .expect_err("rate limited");
            assert_eq!(code(err), ErrorCode::RateLimited, "at {i}");
            age_creation_window(&root);
        }
        kbs.push(kb_of(&create(
            &store,
            &owner,
            &format!("kb-{i}"),
            &format!("create-key-quota-{i:04}"),
        )));
    }
    age_creation_window(&root);
    let over = || {
        store.bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "over",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-quota-over",
            })),
        )
    };
    let err = over().expect_err("quota");
    assert_eq!(code(err), ErrorCode::QuotaExceeded);
    // Nothing was reserved for the rejected create.
    let repos = std::fs::read_dir(root.join("repos"))
        .expect("repos")
        .count();
    assert_eq!(repos, OWNED_LIVE_KBS_PER_USER as usize);
    // A tombstone frees one live slot.
    store
        .bases_delete(
            &owner,
            input::<BasesDelete>(json!({
                "kbId": kbs[0].as_str(), "metadataVersion": 1,
                "idempotencyKey": "delete-key-quota-01", "confirm": "DELETE",
            })),
        )
        .expect("tombstone");
    over().expect("room after tombstone");
    // Page bounds: default 20, max 50.
    let page = store
        .bases_list(&owner, input::<BasesList>(json!({})))
        .expect("list");
    assert_eq!(page.items.len(), PAGE_DEFAULT as usize);
    assert!(page.next_cursor.is_none(), "exactly 20 live kbs");
    assert!(decode_input::<BasesList>(json!({ "limit": PAGE_MAX + 1 })).is_err());
}

#[test]
fn local_limits_only_lower_and_match_the_shared_constants() {
    let common = LocalLimits::default();
    assert_eq!(common.live_kbs(), OWNED_LIVE_KBS_PER_USER);
    // The local store's own (higher, bounded) creation window.
    assert_eq!(
        common.creates_per_hour(),
        kb_local::limits::LOCAL_CREATES_PER_HOUR
    );
    const { assert!(kb_local::limits::LOCAL_CREATES_PER_HOUR > CREATES_PER_HOUR_PER_USER) };
    assert!(LocalLimits::lowered(OWNED_LIVE_KBS_PER_USER + 1, 1).is_err());
    assert!(LocalLimits::lowered(1, kb_local::limits::LOCAL_CREATES_PER_HOUR + 1).is_err());
    assert!(LocalLimits::lowered(0, 1).is_err());
    let lowered = LocalLimits::lowered(2, 5).expect("lower");
    let root = temp_root("limits");
    let store = Store::open(&root).expect("open");
    store.set_limits(lowered);
    let owner = store.owner();
    create(&store, &owner, "one", "create-key-limit-01");
    create(&store, &owner, "two", "create-key-limit-02");
    let err = store
        .bases_create(
            &owner,
            input::<BasesCreate>(json!({
                "name": "x", "slug": "three",
                "description": "A local knowledge base for lifecycle tests",
                "idempotencyKey": "create-key-limit-03",
            })),
        )
        .expect_err("lowered quota");
    assert_eq!(code(err), ErrorCode::QuotaExceeded);
    // Constants are the shared server values (drift check against TS).
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let limits =
        std::fs::read_to_string(repo.join("packages/api/src/lib/kb/limits.ts")).expect("limits.ts");
    assert!(limits.contains(&format!("ownedLiveKbsPerUser: {OWNED_LIVE_KBS_PER_USER},")));
    assert!(limits.contains(&format!(
        "createsPerHourPerUser: {CREATES_PER_HOUR_PER_USER},"
    )));
    let ts_number = |n: u64| {
        let digits = n.to_string();
        let mut grouped = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                grouped.push('_');
            }
            grouped.push(c);
        }
        grouped
    };
    // TS numeric literals may or may not use `_` digit separators.
    let declares = |source: &str, name: &str, value: u64| {
        source.contains(&format!("{name}: {value},"))
            || source.contains(&format!("{name}: {},", ts_number(value)))
    };
    assert!(declares(
        &limits,
        "indexChunksDefault",
        kb_local::limits::INDEX_CHUNKS_DEFAULT
    ));
    let bounds = &limits[limits.find("indexChunkBound: {").expect("indexChunkBound")..];
    let bounds = &bounds[..bounds.find('}').expect("object end")];
    for (name, value) in [
        ("int8", kb_local::limits::INDEX_CHUNK_BOUND_INT8),
        (
            "binary_int8_rescore",
            kb_local::limits::INDEX_CHUNK_BOUND_BINARY_INT8_RESCORE,
        ),
    ] {
        assert!(
            declares(bounds, name, value),
            "KB_LIMITS.indexChunkBound.{name}"
        );
    }
    assert_eq!(
        kb_local::limits::LocalLimits::default().index_chunks(),
        kb_local::limits::INDEX_CHUNKS_DEFAULT
            .min(kb_local::limits::INDEX_CHUNK_BOUND_BINARY_INT8_RESCORE)
    );
    for (name, value) in [
        (
            "minCandidates",
            kb_local::limits::INDEX_RESCORE_MIN_CANDIDATES,
        ),
        (
            "maxCandidates",
            kb_local::limits::INDEX_RESCORE_MAX_CANDIDATES,
        ),
        (
            "chunksPerCandidate",
            kb_local::limits::INDEX_RESCORE_CHUNKS_PER_CANDIDATE,
        ),
    ] {
        let rescore = &limits[limits
            .find("KB_INDEX_RESCORE = {")
            .expect("KB_INDEX_RESCORE")..];
        let rescore = &rescore[..rescore.find('}').expect("object end")];
        assert!(declares(rescore, name, value), "KB_INDEX_RESCORE.{name}");
    }
    let common_ts =
        std::fs::read_to_string(repo.join("packages/api/src/lib/kb/protocol/common.ts"))
            .expect("common.ts");
    assert!(common_ts.contains(&format!("KB_PAGE_DEFAULT = {PAGE_DEFAULT};")));
    assert!(common_ts.contains(&format!("KB_PAGE_MAX = {PAGE_MAX};")));
    // knowledge_search_all: the local "all" limit is the server's default.
    assert!(common_ts.contains(&format!(
        "SEARCH_ALL_DEFAULT_BASES = {};",
        kb_local::search_all::SEARCH_ALL_LOCAL_BASES
    )));
    assert_eq!(
        kb_local::search_all::SEARCH_ALL_LOCAL_BASES,
        kb_client::types::SEARCH_ALL_DEFAULT_BASES
    );
    let cursor_ts =
        std::fs::read_to_string(repo.join("packages/api/src/lib/kb/cursor.ts")).expect("cursor.ts");
    assert_eq!(CURSOR_TTL_SECS, 15 * 60);
    assert!(cursor_ts.contains("CURSOR_TTL_MS = 15 * 60 * 1000;"));
}
