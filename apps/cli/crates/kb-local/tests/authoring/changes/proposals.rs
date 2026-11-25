//! Proposal ownership and the single-document wrappers.

use super::*;

// ── Proposals ──────────────────────────────────────────────────────────────

#[test]
fn propose_only_principal_gets_one_auto_proposal_and_main_never_changes() {
    let kb = new_kb("auto");
    let proposer = kb.principal(&[Permission::Propose]);
    let epoch = kb.epoch();
    let first = kb
        .apply(
            &proposer,
            &kb.main,
            "auto-key-00000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("proposed");
    assert_eq!(first.kind, ApplyKind::Proposed);
    assert_eq!(first.index_job_id, None, "nondefault never schedules index");
    let pr = first.proposal.clone().expect("proposal");
    assert_eq!(pr.number, 1);
    assert_eq!(pr.source_branch, "pr/1");
    assert_eq!(pr.status, PrStatus::Open);
    assert_eq!(pr.version, 1);
    assert_eq!(pr.base_sha, kb.main);
    assert_eq!(pr.head_sha, first.commit_sha);
    assert_eq!(pr.target_sha, kb.main);
    assert_eq!(pr.author_actor_key, proposer.actor_key());
    assert_eq!(pr.merge_commit_sha, None);
    assert_eq!(
        git(&kb.repo, &["rev-parse", "refs/heads/main"]),
        kb.main.as_str()
    );
    assert_eq!(
        git(&kb.repo, &["rev-parse", "refs/heads/pr/1"]),
        first.commit_sha.as_str()
    );
    assert_eq!(kb.head(), kb.main);
    assert_eq!(kb.epoch(), epoch);
    assert_eq!(
        kb.get(&first.commit_sha, "a.md").expect("reachable"),
        "---\nprovenance: agent\n---\n# a\n"
    );
    // Second edit on the proposal HEAD reuses #1.
    let second = kb
        .apply_pr(
            &proposer,
            &first.commit_sha,
            "auto-key-00000002",
            json!([replace("a.md", "# a2\n")]),
            1,
            &first.commit_sha,
        )
        .expect("second");
    let pr2 = second.proposal.clone().expect("proposal");
    assert_eq!((pr2.number, pr2.version), (1, 2));
    assert_eq!(pr2.base_sha, kb.main, "original main base is kept");
    assert_eq!(
        git(&kb.repo, &["rev-parse", &format!("{}^", second.commit_sha)]),
        first.commit_sha.as_str()
    );
    assert_eq!(kb.head(), kb.main);
    assert_eq!(kb.epoch(), epoch);
    assert_eq!(kb.store.proposal(&kb.kb, 1).expect("pr"), Some(pr2));
    // A propose-only principal can never reach main, even naming none.
    assert_eq!(rev_count(&kb.repo, "refs/heads/main"), 1);
}

#[test]
fn open_and_conflict_reuse_then_a_fresh_number_after_close_or_merge() {
    let kb = new_kb("reuse");
    let proposer = kb.principal(&[Permission::Propose]);
    let first = kb
        .apply(
            &proposer,
            &kb.main,
            "reuse-key-0000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("first");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_proposal_status_for_tests(&guard, &kb.kb, 1, PrStatus::Conflict)
        .expect("conflict");
    drop(guard);
    let second = kb
        .apply(
            &proposer,
            &first.commit_sha,
            "reuse-key-0000002",
            json!([create("b.md", "# b\n")]),
            None,
        )
        .expect("reuse conflict proposal");
    let pr = second.proposal.expect("pr");
    assert_eq!((pr.number, pr.version, pr.status), (1, 2, PrStatus::Open));

    for (status, expect_number, key) in [
        (PrStatus::Closed, 2, "reuse-key-0000003"),
        (PrStatus::Merged, 3, "reuse-key-0000004"),
    ] {
        let closed_number = expect_number - 1;
        let closed = kb
            .store
            .proposal(&kb.kb, closed_number)
            .expect("pr")
            .expect("pr");
        let guard = kb
            .store
            .lock_write(std::slice::from_ref(&kb.kb))
            .expect("lock");
        kb.store
            .set_proposal_status_for_tests(&guard, &kb.kb, closed_number, status)
            .expect("terminal");
        // Terminal proposals are immutable.
        let err = kb
            .store
            .set_proposal_status_for_tests(&guard, &kb.kb, closed_number, PrStatus::Open)
            .expect_err("immutable");
        assert_eq!(code(&err), ErrorCode::Conflict);
        drop(guard);
        let refs_before = refs(&kb.repo);
        // Naming one's own closed proposal is the precondition answer:
        // continue on current main (server parity); others' stay invisible.
        let err = kb
            .apply(
                &proposer,
                &closed.head_sha,
                &format!("{key}x"),
                json!([create("z.md", "# z\n")]),
                Some(closed_number),
            )
            .expect_err("closed proposal");
        match &err {
            StoreError::StaleBase {
                head_sha,
                proposal_number,
            } => assert_eq!((head_sha, *proposal_number), (&kb.head(), None)),
            other => panic!("expected StaleBase, got {other:?}"),
        }
        let stranger = kb.principal(&[Permission::Propose]);
        let err = kb
            .apply(
                &stranger,
                &closed.head_sha,
                &format!("{key}w"),
                json!([create("z.md", "# z\n")]),
                Some(closed_number),
            )
            .expect_err("someone else's closed proposal");
        assert_eq!(code(&err), ErrorCode::NotFound);
        // Its old head is no longer a valid base for an implicit edit.
        let err = kb
            .apply(
                &proposer,
                &closed.head_sha,
                &format!("{key}y"),
                json!([create("z.md", "# z\n")]),
                None,
            )
            .expect_err("closed head is stale");
        assert_eq!(code(&err), ErrorCode::Conflict);
        assert_eq!(refs(&kb.repo), refs_before);
        let fresh = kb
            .apply(
                &proposer,
                &kb.main,
                key,
                json!([create("c.md", "# c\n")]),
                None,
            )
            .expect("fresh proposal");
        let pr = fresh.proposal.expect("pr");
        assert_eq!((pr.number, pr.version), (expect_number, 1));
        assert_eq!(pr.source_branch, format!("pr/{expect_number}"));
        // The closed branch is retained and unchanged.
        assert_eq!(
            git(
                &kb.repo,
                &["rev-parse", &format!("refs/heads/pr/{closed_number}")]
            ),
            closed.head_sha.as_str()
        );
        assert_eq!(
            kb.store
                .proposal(&kb.kb, closed_number)
                .expect("pr")
                .expect("pr")
                .head_sha,
            closed.head_sha
        );
    }
    assert_eq!(kb.head(), kb.main);
}

#[test]
fn cross_actor_proposals_are_denied() {
    let kb = new_kb("cross");
    let alice = kb.principal(&[Permission::Propose]);
    let bob = kb.principal(&[Permission::Propose]);
    let owner = kb.store.owner();
    let pr = kb
        .apply(
            &alice,
            &kb.main,
            "cross-key-0000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("alice");
    let head = pr.commit_sha.clone();
    for who in [&bob, &owner] {
        let before = effects(&kb);
        let err = kb
            .apply(
                who,
                &head,
                "cross-key-0000002",
                json!([create("b.md", "# b\n")]),
                Some(1),
            )
            .expect_err("not the branch owner");
        assert_eq!(code(&err), ErrorCode::Forbidden);
        assert_eq!(effects(&kb), before);
    }
    // Bob's implicit edit opens his own proposal instead of reusing Alice's.
    let bobs = kb
        .apply(
            &bob,
            &kb.main,
            "cross-key-0000003",
            json!([create("b.md", "# b\n")]),
            None,
        )
        .expect("bob");
    let pr = bobs.proposal.expect("pr");
    assert_eq!(pr.number, 2);
    assert_eq!(pr.author_actor_key, bob.actor_key());
    // A principal without propose is forbidden; without read, NOT_FOUND.
    let reader = kb.principal(&[Permission::Read]);
    let err = kb
        .apply(
            &reader,
            &kb.main,
            "cross-key-0000004",
            json!([create("r.md", "# r\n")]),
            None,
        )
        .expect_err("read only");
    assert_eq!(code(&err), ErrorCode::Forbidden);
    let nobody = kb.principal(&[]);
    let err = kb
        .apply(
            &nobody,
            &kb.main,
            "cross-key-0000005",
            json!([create("r.md", "# r\n")]),
            None,
        )
        .expect_err("no access");
    assert_eq!(code(&err), ErrorCode::NotFound);
}

#[test]
fn explicit_proposal_stays_a_proposal_for_a_write_holder() {
    let kb = new_kb("explicit");
    let author = kb.principal(&[Permission::Propose]);
    let pr = kb
        .apply(
            &author,
            &kb.main,
            "explicit-key-00001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("proposal");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_principal_permissions(&guard, &author, &kb.kb, &[Permission::Write])
        .expect("raise to write");
    drop(guard);
    let updated = kb
        .apply_pr(
            &author,
            &pr.commit_sha,
            "explicit-key-00002",
            json!([replace("a.md", "# a2\n")]),
            1,
            &pr.commit_sha,
        )
        .expect("explicit proposal");
    assert_eq!(updated.kind, ApplyKind::Proposed);
    assert_eq!(updated.proposal.expect("pr").version, 2);
    assert_eq!(kb.head(), kb.main, "main untouched");
    // Without proposalNumber the write holder publishes main directly.
    let direct = kb
        .apply(
            &author,
            &kb.main,
            "explicit-key-00003",
            json!([create("d.md", "# d\n")]),
            None,
        )
        .expect("direct");
    assert_eq!(direct.kind, ApplyKind::Applied);
    assert_eq!(direct.proposal, None);
    assert_eq!(kb.head(), direct.commit_sha);
    // An unknown proposal number is NOT_FOUND.
    let err = kb
        .apply(
            &author,
            &direct.commit_sha,
            "explicit-key-00004",
            json!([create("e.md", "# e\n")]),
            Some(9),
        )
        .expect_err("unknown");
    assert_eq!(code(&err), ErrorCode::NotFound);
}

#[test]
fn document_wrappers_keep_explicit_owned_proposal_for_write_holder() {
    let kb = new_kb("wrapper-proposal");
    let author = kb.principal(&[Permission::Propose]);
    let proposal = kb
        .apply(
            &author,
            &kb.main,
            "wrapper-pr-start-01",
            json!([create("seed.md", "# seed\n")]),
            None,
        )
        .expect("proposal");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_principal_permissions(&guard, &author, &kb.kb, &[Permission::Write])
        .expect("write permission");
    drop(guard);
    let mut head = proposal.commit_sha;
    let epoch = kb.epoch();
    for (step, tool) in ["create", "update", "delete"].iter().enumerate() {
        let mut value = json!({"kbId":kb.kb,"baseRevision":head,"proposalNumber":1,"proposalHeadSha":head,"idempotencyKey":format!("wrapper-pr-step-{step:03}"),"path":"owned.md"});
        if *tool == "delete" {
            value["confirm"] = json!("DELETE");
        } else {
            value["content"] = json!({"markdown":format!("# step {step}\n")});
        }
        // A main base plus a nonexistent explicit selector must never fall back to main.
        let before = effects(&kb);
        let mut invalid = value.clone();
        invalid["baseRevision"] = json!(kb.main);
        invalid["proposalNumber"] = json!(999);
        invalid["idempotencyKey"] = json!(format!("wrapper-pr-invalid-{step:03}"));
        let denied = match *tool {
            "create" => kb
                .store
                .documents_create(&author, input::<DocumentsCreate>(invalid)),
            "update" => kb
                .store
                .documents_update(&author, input::<DocumentsUpdate>(invalid)),
            _ => kb
                .store
                .documents_delete(&author, input::<DocumentsDelete>(invalid)),
        }
        .expect_err("explicit unknown proposal");
        assert_eq!(code(&denied), ErrorCode::NotFound);
        assert_eq!(effects(&kb), before);
        let result = match *tool {
            "create" => kb
                .store
                .documents_create(&author, input::<DocumentsCreate>(value)),
            "update" => kb
                .store
                .documents_update(&author, input::<DocumentsUpdate>(value)),
            _ => kb
                .store
                .documents_delete(&author, input::<DocumentsDelete>(value)),
        }
        .expect("explicit owned proposal");
        assert_eq!(result.kind, ApplyKind::Proposed);
        assert_eq!(result.proposal.expect("proposal").number, 1);
        assert_eq!(result.index_job_id, None);
        assert_eq!(kb.head(), kb.main);
        assert_eq!(kb.epoch(), epoch);
        head = result.commit_sha;
    }
}

#[test]
fn single_document_wrappers_call_the_same_service() {
    let kb = new_kb("wrappers");
    let owner = kb.store.owner();
    let write = |key: &str, base: &Sha, path: &str, body: &str, update: bool| {
        let value = json!({
            "kbId": kb.kb.as_str(),
            "baseRevision": base.as_str(),
            "idempotencyKey": key,
            "path": path,
            "content": { "markdown": body },
        });
        if update {
            let out = kb
                .store
                .documents_update(&owner, input::<DocumentsUpdate>(value));
            out.inspect(|r| {
                wire::<DocumentsUpdate>(r);
            })
        } else {
            let out = kb
                .store
                .documents_create(&owner, input::<DocumentsCreate>(value));
            out.inspect(|r| {
                wire::<DocumentsCreate>(r);
            })
        }
    };
    let created =
        write("wrap-key-000000001", &kb.main, "notes/w.md", "# w\n", false).expect("create");
    assert_eq!(created.kind, ApplyKind::Applied);
    let head = created.commit_sha.clone();
    let err = write(
        "wrap-key-000000002",
        &head,
        "notes/w.md",
        "# again\n",
        false,
    )
    .expect_err("create existing");
    assert_eq!(code(&err), ErrorCode::Conflict);
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "PATH_EXISTS", "field": "/path"})
    );
    let noop = write("wrap-key-000000003", &head, "notes/w.md", "# w\n", true).expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    let err = write("wrap-key-000000004", &head, "notes/none.md", "# n\n", true)
        .expect_err("update missing");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "PATH_NOT_FOUND", "field": "/path"})
    );
    let updated = write("wrap-key-000000005", &head, "notes/w.md", "# w2\n", true).expect("update");
    assert_eq!(updated.kind, ApplyKind::Applied);
    let delete_input = |key: &str, base: &Sha, path: &str| {
        input::<DocumentsDelete>(json!({
            "kbId": kb.kb.as_str(),
            "baseRevision": base.as_str(),
            "idempotencyKey": key,
            "path": path,
            "confirm": "DELETE",
        }))
    };
    let err = kb
        .store
        .documents_delete(
            &owner,
            delete_input("wrap-key-000000006", &updated.commit_sha, "x.md"),
        )
        .expect_err("delete missing");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    let deleted = kb
        .store
        .documents_delete(
            &owner,
            delete_input("wrap-key-000000007", &updated.commit_sha, "notes/w.md"),
        )
        .expect("delete");
    wire::<DocumentsDelete>(&deleted);
    assert_eq!(deleted.kind, ApplyKind::Applied);
    assert_eq!(
        deleted
            .changed_paths
            .iter()
            .map(KbPath::as_str)
            .collect::<Vec<_>>(),
        ["notes/w.md"]
    );
    assert_eq!(
        code(&kb.get(&deleted.commit_sha, "notes/w.md").expect_err("gone")),
        ErrorCode::NotFound
    );
    // A propose-only principal's wrapper call becomes its auto-proposal.
    let proposer = kb.principal(&[Permission::Propose]);
    let proposed = kb
        .store
        .documents_create(
            &proposer,
            input::<DocumentsCreate>(json!({
                "kbId": kb.kb.as_str(),
                "baseRevision": deleted.commit_sha.as_str(),
                "idempotencyKey": "wrap-key-000000008",
                "path": "notes/p.md",
                "content": { "markdown": "# p\n" },
            })),
        )
        .expect("proposed");
    assert_eq!(proposed.kind, ApplyKind::Proposed);
    assert_eq!(proposed.proposal.expect("pr").number, 1);
    assert_eq!(kb.head(), deleted.commit_sha);
}
