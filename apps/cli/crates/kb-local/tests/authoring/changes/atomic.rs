//! Atomic edit batches: validation before effects, replay, base-revision conflicts and write modes.

use super::*;

// ── Upfront validation: zero effects ───────────────────────────────────────

#[test]
#[cfg_attr(
    windows,
    ignore = "known Windows timing issue: Defender scans every loose object Git writes; follow-up: write fewer loose objects (cheaper tree-batch and pack writes)"
)]
fn invalid_32nd_change_has_zero_effects() {
    let kb = new_kb("eighth");
    let owner = kb.store.owner();
    let proposer = kb.principal(&[Permission::Propose]);
    let prefix: Vec<Value> = (1..=31)
        .map(|i| create(&format!("notes/n{i}.md"), &format!("# Note {i}\n")))
        .collect();
    let bad_last_changes = [
        replace("notes/missing.md", "# nope\n"),
        delete("notes/missing.md"),
        create("index.md", "# already exists\n"),
        create("notes/bad.md", "---\nkey: [unclosed\n---\nbody\n"),
        create("notes/data.txt", "plain text is not a document\n"),
        create("notes/N1.md", "# case-folds onto notes/n1.md\n"),
        json!({ "op": "create", "path": "notes/up.md",
                "content": { "uploadId": "00000000-0000-4000-8000-000000000001" } }),
        json!({ "op": "assetPut", "path": "images/a.png",
                "uploadId": "00000000-0000-4000-8000-000000000002" }),
        json!({ "op": "assetRemove", "path": "images/a.png" }),
        // Reserved before the extension check (case-folded).
        create(".Assets/x.md", "# not a document\n"),
        // Whole-tree rule: duplicate document `id` across the batch.
        create("notes/dup.md", "---\nid: n1\n---\n# dup\n"),
    ];
    let count = bad_last_changes.len();
    for (i, last) in bad_last_changes.into_iter().enumerate() {
        let mut changes = prefix.clone();
        if i == count - 1 {
            changes[0] = create("notes/n1.md", "---\nid: n1\n---\n# Note 1\n");
        }
        changes.push(last);
        for who in [&owner, &proposer] {
            let before = effects(&kb);
            let key = format!("eighth-key-{i:02}-{}", who.id().len());
            let err = kb
                .apply(who, &kb.main, &key, json!(changes), None)
                .expect_err("invalid last change");
            let expected = if matches!(i, 6 | 7) {
                // Upload/asset variants are now implemented; guessed staging
                // IDs must hide existence with NOT_FOUND (CONTRACT upload binding).
                ErrorCode::NotFound
            } else if i == 2 {
                // Creating an existing path is a CONFLICT.
                ErrorCode::Conflict
            } else {
                ErrorCode::InvalidArgument
            };
            assert_eq!(code(&err), expected, "case {i}: {err:?}");
            // Closed reason + JSON pointer of the offending change.
            let details = err.protocol_details();
            let want = match i {
                0 | 1 => Some(("PATH_NOT_FOUND", Some("/changes/31/path"))),
                2 => Some(("PATH_EXISTS", Some("/changes/31/path"))),
                3 => Some(("INVALID_FRONT_MATTER", Some("/changes/31/content/markdown"))),
                4 => Some(("NOT_MARKDOWN_PATH", Some("/changes/31/path"))),
                // The schema's batch-wide case-fold rule names the second spelling.
                5 => Some(("PATH_CASE_COLLISION", Some("/changes/31/path"))),
                9 => Some(("RESERVED_PATH", Some("/changes/31/path"))),
                10 => Some(("DUPLICATE_DOCUMENT_ID", None)),
                _ => None,
            };
            if let Some((reason, field)) = want {
                assert_eq!(details["reason"], reason, "case {i}: {details}");
                if let Some(field) = field {
                    assert_eq!(details["field"], field, "case {i}: {details}");
                }
            }
            assert_eq!(
                effects(&kb),
                before,
                "case {i}: no ref/journal/epoch/PR effect"
            );
        }
    }
    // Over-cap calls have zero effects and explain how to split the batch.
    let batch: Vec<_> = (0..33)
        .map(|i| create(&format!("notes/b{i}.md"), "# Body\n"))
        .collect();
    let err = kb
        .apply(&owner, &kb.main, "over-cap-changes-key", json!(batch), None)
        .expect_err("33 changes");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    assert_eq!(
        err.protocol_details(),
        json!({"reason": "TOO_MANY_CHANGES", "field": "/changes", "max": 32})
    );
    assert_eq!(kb.journal_len(), 1, "only the create receipt");
    // The same key then publishes a valid batch of 32 as ONE commit.
    let mut valid_batch = prefix;
    valid_batch.push(create("notes/n32.md", "# Note 32\n"));
    let result = kb
        .apply(
            &owner,
            &kb.main,
            "eighth-key-00-36",
            json!(valid_batch),
            None,
        )
        .expect("valid 32");
    assert_eq!(result.kind, ApplyKind::Applied);
    assert_eq!(result.changed_paths.len(), 32);
    assert_eq!(
        rev_count(&kb.repo, "refs/heads/main"),
        2,
        "exactly one commit"
    );
    assert_eq!(
        kb.get(&result.commit_sha, "notes/n8.md").expect("n8"),
        "---\nprovenance: agent\n---\n# Note 8\n"
    );
}

#[test]
fn rejections_carry_d14_reason_and_field() {
    let kb = new_kb("reasons");
    let owner = kb.store.owner();
    let created = kb
        .apply(
            &owner,
            &kb.main,
            "reasons-key-000001",
            json!([create("caps.md", "# caps\n")]),
            None,
        )
        .expect("create caps");
    let head = created.commit_sha;
    let cases = [
        // Case-folds onto an existing document (whole-tree rule).
        (
            create("CAPS.md", "# CAPS\n"),
            json!({"reason": "PATH_CASE_COLLISION", "field": "/changes/0/path"}),
        ),
        (
            create("bad.md", "---\nkey: [unclosed\n---\nbody\n"),
            json!({"reason": "INVALID_FRONT_MATTER", "field": "/changes/0/content/markdown"}),
        ),
        (
            create("ctl.md", "# bell \u{7}\n"),
            json!({"reason": "CONTROL_CHARACTER", "field": "/changes/0/content/markdown"}),
        ),
    ];
    for (i, (change, want)) in cases.into_iter().enumerate() {
        let err = kb
            .apply(
                &owner,
                &head,
                &format!("reasons-key-{i:06}x"),
                json!([change]),
                None,
            )
            .expect_err("rejected");
        assert_eq!(code(&err), ErrorCode::InvalidArgument, "case {i}: {err:?}");
        assert_eq!(err.protocol_details(), want, "case {i}");
    }
}

#[test]
fn omitted_edit_title_is_generated_and_replays_like_the_explicit_summary() {
    let kb = new_kb("generated-title");
    let mut body = json!({"kbId":kb.kb,"baseRevision":kb.main,"idempotencyKey":"generated-title-00001","mode":"edit","changes":[create("new.md", "# New\n")]});
    let result = kb
        .store
        .changes_apply(&kb.store.owner(), input::<ChangesApply>(body.clone()))
        .expect("titleless edit");
    assert_eq!(
        git(
            &kb.repo,
            &["show", "-s", "--format=%s", result.commit_sha.as_str()]
        ),
        "kb: Create new.md"
    );
    body["title"] = json!("Create new.md");
    let replay = kb
        .store
        .changes_apply(&kb.store.owner(), input::<ChangesApply>(body))
        .expect("normalized replay");
    assert_eq!(result, replay);
}

#[test]
fn empty_edit_is_rejected_and_identical_replacement_is_a_durable_noop() {
    let kb = new_kb("noop");
    let owner = kb.store.owner();
    let err = kb
        .apply(&owner, &kb.main, "empty-edit-key-0001", json!([]), None)
        .expect_err("empty edit");
    assert_eq!(code(&err), ErrorCode::InvalidArgument);
    assert_eq!(kb.journal_len(), 1);

    let index = kb.get(&kb.main, "index.md").expect("index");
    let epoch = kb.epoch();
    let noop = kb
        .apply(
            &owner,
            &kb.main,
            "noop-key-000000001",
            json!([replace("index.md", &index)]),
            None,
        )
        .expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(
        noop.commit_sha, kb.main,
        "commitSha is the unchanged target"
    );
    assert_eq!(noop.base_revision, kb.main);
    assert!(noop.changed_paths.is_empty());
    assert_eq!(noop.proposal, None);
    assert_eq!(noop.index_job_id, None);
    assert_eq!(rev_count(&kb.repo, "refs/heads/main"), 1, "no commit");
    assert_eq!(kb.epoch(), epoch, "no index intent");
    // Durable receipt: replay returns the identical result; a different
    // body under the key is a mismatch.
    let rows = kb.store.intents(&kb.kb).expect("intents");
    let row = rows
        .iter()
        .find(|row| row.idempotency_key == "noop-key-000000001")
        .expect("receipt row");
    assert_eq!(row.phase, Phase::Finalized);
    assert_eq!(row.op_id, noop.operation_id);
    let again = kb
        .apply(
            &owner,
            &kb.main,
            "noop-key-000000001",
            json!([replace("index.md", &index)]),
            None,
        )
        .expect("replay");
    assert_eq!(again, noop);
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "noop-key-000000001",
            json!([replace("index.md", "# x\n")]),
            None,
        )
        .expect_err("mismatch");
    assert_eq!(code(&err), ErrorCode::IdempotencyMismatch);

    // A propose-only noop opens no proposal and allocates no number.
    let proposer = kb.principal(&[Permission::Propose]);
    let noop = kb
        .apply(
            &proposer,
            &kb.main,
            "noop-key-000000002",
            json!([replace("index.md", &index)]),
            None,
        )
        .expect("proposer noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(noop.proposal, None);
    let first = kb
        .apply(
            &proposer,
            &kb.main,
            "noop-key-000000003",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("first proposal");
    assert_eq!(
        first.proposal.expect("pr").number,
        1,
        "no number was burned"
    );
}

// ── Idempotency and base revision ──────────────────────────────────────────

#[test]
fn same_key_replays_and_mismatches_per_operation() {
    let kb = new_kb("replay");
    let owner = kb.store.owner();
    let changes = json!([create("notes/a.md", "# A\n"), create("notes/b.md", "# B\n")]);
    let first = kb
        .apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            changes.clone(),
            None,
        )
        .expect("apply");
    assert_eq!(first.kind, ApplyKind::Applied);
    assert_eq!(first.base_revision, kb.main);
    assert_eq!(first.proposal, None);
    let paths: Vec<&str> = first.changed_paths.iter().map(KbPath::as_str).collect();
    assert_eq!(paths, ["notes/a.md", "notes/b.md"]);
    assert_eq!(kb.head(), first.commit_sha);
    assert_eq!(
        kb.epoch(),
        2,
        "main publication advances the desired epoch once"
    );
    for _ in 0..2 {
        let again = kb
            .apply(
                &owner,
                &kb.main,
                "replay-key-0000001",
                changes.clone(),
                None,
            )
            .expect("replay");
        assert_eq!(again, first);
    }
    assert_eq!(rev_count(&kb.repo, "refs/heads/main"), 2);
    assert_eq!(kb.epoch(), 2);
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            json!([create("notes/c.md", "# C\n")]),
            None,
        )
        .expect_err("mismatch");
    assert_eq!(code(&err), ErrorCode::IdempotencyMismatch);
    // Compaction keeps replay and mismatch detection.
    let guard = kb.store.lock_write(&[]).expect("lock");
    kb.store.compact_receipts(&guard).expect("compact");
    drop(guard);
    assert_eq!(
        kb.apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            changes.clone(),
            None
        )
        .expect("replay after compaction"),
        first
    );
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "replay-key-0000001",
            json!([delete("index.md")]),
            None,
        )
        .expect_err("mismatch after compaction");
    assert_eq!(code(&err), ErrorCode::IdempotencyMismatch);
    // The wrappers have their own key space (distinct operation).
    let doc = kb
        .store
        .documents_create(
            &owner,
            input::<DocumentsCreate>(json!({
                "kbId": kb.kb.as_str(),
                "baseRevision": first.commit_sha.as_str(),
                "idempotencyKey": "replay-key-0000001",
                "path": "notes/c.md",
                "content": { "markdown": "# C\n" },
            })),
        )
        .expect("wrapper with the same key");
    assert_eq!(doc.kind, ApplyKind::Applied);
    // A replay needs current authority: a revoked principal learns nothing.
    let proposer = kb.principal(&[Permission::Propose]);
    let main = kb.head();
    let proposed = kb
        .apply(
            &proposer,
            &main,
            "replay-key-0000002",
            json!([create("p.md", "# p\n")]),
            None,
        )
        .expect("proposed");
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("lock");
    kb.store
        .set_principal_permissions(&guard, &proposer, &kb.kb, &[])
        .expect("revoke");
    drop(guard);
    let err = kb
        .apply(
            &proposer,
            &main,
            "replay-key-0000002",
            json!([create("p.md", "# p\n")]),
            None,
        )
        .expect_err("revoked replay");
    assert_eq!(code(&err), ErrorCode::NotFound);
    assert!(proposed.proposal.is_some());
}

#[test]
fn competing_base_revisions_conflict_without_effects() {
    let kb = new_kb("base");
    let owner = kb.store.owner();
    let first = kb
        .apply(
            &owner,
            &kb.main,
            "base-key-00000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("first");
    let before = effects(&kb);
    let err = kb
        .apply(
            &owner,
            &kb.main,
            "base-key-00000002",
            json!([create("b.md", "# b\n")]),
            None,
        )
        .expect_err("stale base");
    match &err {
        StoreError::StaleBase {
            head_sha,
            proposal_number,
        } => {
            assert_eq!(head_sha, &first.commit_sha);
            assert_eq!(*proposal_number, None);
        }
        other => panic!("expected StaleBase, got {other:?}"),
    }
    assert_eq!(code(&err), ErrorCode::Conflict);
    assert_eq!(effects(&kb), before);
    // A readable but non-HEAD commit, and a foreign SHA, are both stale.
    let foreign = sha("0123456789abcdef0123456789abcdef01234567");
    for base in [&kb.main, &foreign] {
        let err = kb
            .apply(
                &owner,
                base,
                "base-key-00000003",
                json!([create("b.md", "# b\n")]),
                None,
            )
            .expect_err("stale");
        assert_eq!(code(&err), ErrorCode::Conflict);
    }
    // While the proposal sits on main, an edit against current main
    // applies on the proposal HEAD; only a path the proposal changed needs
    // its proposalNumber, else PROPOSAL_CONFLICT with both versions.
    let proposer = kb.principal(&[Permission::Propose]);
    let main = kb.head();
    let pr = kb
        .apply(
            &proposer,
            &main,
            "base-key-00000004",
            json!([create("p.md", "# p\n")]),
            None,
        )
        .expect("proposal");
    let on_head = kb
        .apply(
            &proposer,
            &main,
            "base-key-00000005",
            json!([create("q.md", "# q\n")]),
            None,
        )
        .expect("an edit against main reaches the proposal");
    assert_eq!(
        on_head.proposal.as_ref().map(|p| (p.number, p.version)),
        Some((1, 2))
    );
    assert_eq!(
        git(
            &kb.repo,
            &["rev-parse", &format!("{}^", on_head.commit_sha)]
        ),
        pr.commit_sha.as_str()
    );
    assert_eq!(
        kb.get(&on_head.commit_sha, "p.md").expect("kept"),
        "---\nprovenance: agent\n---\n# p\n"
    );
    let before = effects(&kb);
    let err = kb
        .apply(
            &proposer,
            &main,
            "base-key-00000006",
            json!([replace("p.md", "# p from main\n")]),
            None,
        )
        .expect_err("rewriting the proposal's own path against main");
    match &err {
        StoreError::ProposalConflict(conflict) => {
            assert_eq!(conflict.head_sha, main);
            assert_eq!(conflict.proposal_number, Some(1));
            assert_eq!(conflict.proposal_head_sha, on_head.commit_sha);
            assert_eq!(conflict.paths.len(), 1);
            assert_eq!(conflict.paths[0].path, "p.md");
            assert_eq!(
                conflict.paths[0].yours.as_deref(),
                Some("---\nprovenance: agent\n---\n# p\n")
            );
            assert_eq!(conflict.paths[0].theirs, None);
        }
        other => panic!("expected PROPOSAL_CONFLICT, got {other:?}"),
    }
    assert_eq!(effects(&kb), before);
    // Naming the PR against main needs the head the choice was made on...
    match kb
        .apply(
            &proposer,
            &main,
            "base-key-00000007",
            json!([replace("p.md", "# p chosen\n")]),
            Some(1),
        )
        .expect_err("no observed head")
    {
        StoreError::StaleBase {
            head_sha,
            proposal_number,
        } => {
            assert_eq!(
                (head_sha, proposal_number),
                (on_head.commit_sha.clone(), Some(1))
            );
        }
        other => panic!("expected StaleBase, got {other:?}"),
    }
    // ...and a second editor holding the older head never overwrites the newer
    // edit: the stale save is refused with the current head.
    match kb
        .apply_pr(
            &proposer,
            &main,
            "base-key-00000008",
            json!([replace("p.md", "# p stale\n")]),
            1,
            &pr.commit_sha,
        )
        .expect_err("stale PR head")
    {
        StoreError::StaleBase { head_sha, .. } => assert_eq!(head_sha, on_head.commit_sha),
        other => panic!("expected StaleBase, got {other:?}"),
    }
    assert_eq!(effects(&kb), before);
    let named = kb
        .apply_pr(
            &proposer,
            &main,
            "base-key-00000009",
            json!([replace("p.md", "# p chosen\n")]),
            1,
            &on_head.commit_sha,
        )
        .expect("naming the proposal is a deliberate choice");
    assert_eq!(named.proposal.as_ref().map(|p| p.version), Some(3));
    assert_eq!(
        kb.get(&named.commit_sha, "p.md").expect("chosen"),
        "---\nprovenance: agent\n---\n# p chosen\n"
    );
    assert_eq!(
        kb.get(&named.commit_sha, "q.md").expect("kept"),
        "---\nprovenance: agent\n---\n# q\n"
    );
}

#[test]
fn encoded_frontmatter_rejection_has_zero_effects_and_valid_boundary_is_readable() {
    let kb = new_kb("frontmatter-wire");
    let proposer = kb.principal(&[Permission::Propose]);
    let oversized = format!("---\nk: \"{}\"\n---\nbody\n", "\t".repeat(40_000));
    let mut numeric_yaml = String::new();
    let mut numeric_json = String::from("{");
    for i in 0..3000 {
        numeric_yaml.push_str(&format!("n{i}: 1e-6\n"));
        numeric_json.push_str(&format!("\"n{i}\":0.000001,"));
    }
    // Boundary documents already carry the agent label every local write
    // is stamped with, so the stored bytes (and the cap) are exactly these.
    numeric_yaml.push_str("provenance: agent\n");
    numeric_json.push_str("\"provenance\":\"agent\",\"padding\":\"\"}");
    let numeric_padding = 64 * 1024 - numeric_json.len();
    let oversized_numeric = format!(
        "---\n{numeric_yaml}padding: '{}'\n---\nbody\n",
        "a".repeat(numeric_padding + 1)
    );
    for invalid in [&oversized, &oversized_numeric] {
        for who in [&kb.store.owner(), &proposer] {
            let before = effects(&kb);
            let next_pr = || {
                let db = rusqlite::Connection::open(kb.store.paths().root().join("state.sqlite"))
                    .unwrap();
                db.query_row(
                    "SELECT next_pr_number FROM kbs WHERE id = ?1",
                    [kb.kb.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
            };
            let counter = next_pr();
            let err = kb
                .apply(
                    who,
                    &kb.main,
                    "encoded-frontmatter-key",
                    json!([create("large.md", invalid)]),
                    None,
                )
                .unwrap_err();
            assert_eq!(err.protocol_code(), ErrorCode::InvalidArgument);
            assert_eq!(effects(&kb), before);
            assert_eq!(next_pr(), counter);
        }
    }
    // `{"k":"<tabs>a","provenance":"agent"}` is exactly 64 KiB.
    let valid = format!(
        "---\nk: '{}a'\nprovenance: agent\n---\nbody\n",
        "\t".repeat(32753)
    );
    let result = kb
        .apply(
            &kb.store.owner(),
            &kb.main,
            "encoded-frontmatter-key",
            json!([create("large.md", &valid)]),
            None,
        )
        .unwrap();
    let doc = kb
        .store
        .documents_get(
            &kb.store.owner(),
            input::<DocumentsGet>(
                json!({"kbId":kb.kb, "rev":result.commit_sha, "path":"large.md"}),
            ),
        )
        .unwrap();
    wire::<DocumentsGet>(&doc);
    assert_eq!(doc.markdown, valid);
    assert_eq!(
        serde_json::to_vec(&doc.front_matter).unwrap().len(),
        64 * 1024
    );
    let valid_numeric = format!(
        "---\n{numeric_yaml}padding: '{}'\n---\nbody\n",
        "a".repeat(numeric_padding)
    );
    let numeric = kb
        .apply(
            &kb.store.owner(),
            &result.commit_sha,
            "numeric-frontmatter-key",
            json!([create("numeric.md", &valid_numeric)]),
            None,
        )
        .unwrap();
    let doc = kb
        .store
        .documents_get(
            &kb.store.owner(),
            input::<DocumentsGet>(
                json!({"kbId":kb.kb, "rev":numeric.commit_sha, "path":"numeric.md"}),
            ),
        )
        .unwrap();
    wire::<DocumentsGet>(&doc);
    assert_eq!(doc.markdown, valid_numeric);
    assert_eq!(doc.front_matter["n0"], json!(1e-6));
    assert_eq!(
        doc.front_matter["padding"].as_str().unwrap().len(),
        numeric_padding
    );
    assert!(
        serde_json::to_vec(&doc.front_matter).unwrap().len() < 64 * 1024,
        "serde's shorter number spelling must not define the portable cap"
    );
}

/// A store held to a write mode refuses what the mode does not allow before
/// any lock, journal row, ref, proposal or upload: FORBIDDEN with
/// `{reason: "WRITE_MODE", required}`.
#[test]
fn write_modes_refuse_store_mutations_without_effects() {
    use kb_client::authoring::{AuthoringMode, WriteKind};
    let kb = new_kb("modes");
    let owner = kb.store.owner();
    kb.store.narrow_authoring(AuthoringMode::Dream);
    let before = effects(&kb);
    let refused = |result: Result<(), StoreError>, need: WriteKind| {
        let err = result.expect_err("refused");
        assert!(
            matches!(err, StoreError::WriteMode(kind) if kind == need),
            "{err}"
        );
        assert_eq!(code(&err), ErrorCode::Forbidden);
        assert_eq!(
            err.protocol_details(),
            json!({"reason": "WRITE_MODE", "required": need.as_str()})
        );
    };
    refused(
        kb.apply(
            &owner,
            &kb.main,
            "mode-key-000000001",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .map(|_| ()),
        WriteKind::Edit,
    );
    refused(
        kb.store
            .documents_update(
                &owner,
                input::<DocumentsUpdate>(json!({
                    "kbId": kb.kb.as_str(), "baseRevision": kb.main.as_str(),
                    "idempotencyKey": "mode-key-000000002", "path": "index.md",
                    "content": {"markdown": "# x\n"},
                })),
            )
            .map(|_| ()),
        WriteKind::Edit,
    );
    refused(
        kb.store
            .documents_delete(
                &owner,
                input::<DocumentsDelete>(json!({
                    "kbId": kb.kb.as_str(), "baseRevision": kb.main.as_str(),
                    "idempotencyKey": "mode-key-000000003", "path": "index.md",
                    "confirm": "DELETE",
                })),
            )
            .map(|_| ()),
        WriteKind::Edit,
    );
    refused(
        kb.store
            .bases_create(
                &owner,
                input::<BasesCreate>(json!({
                    "name": "Other", "slug": "other", "description": "Refused by the write mode",
                    "idempotencyKey": "mode-key-000000004",
                })),
            )
            .map(|_| ()),
        WriteKind::Edit,
    );
    assert_eq!(effects(&kb), before);
    assert_eq!(kb.store.authoring(), AuthoringMode::Dream);
    // Narrowing never widens: `both` keeps dream-only.
    kb.store.narrow_authoring(AuthoringMode::Both);
    assert_eq!(kb.store.authoring(), AuthoringMode::Dream);

    // Edit-only refuses a dream.
    let edits = new_kb("modes-edit");
    edits.store.narrow_authoring(AuthoringMode::Edit);
    let before = effects(&edits);
    let dream = json!({
        "kbId": edits.kb.as_str(), "baseRevision": edits.main.as_str(),
        "idempotencyKey": "mode-key-000000005", "mode": "dream", "title": "Dream",
        "changes": [], "sourceSessionIds": ["00000000-0000-4000-8000-000000000001"],
        "dream": {"model": {"model": "fixture-model", "provider": "fixture"},
                  "redactionApplied": true,
                  "upserts": [{"id": "n1", "type": "concept", "title": null, "body": "B",
                               "citations": [], "provenance": "dream"}]},
    });
    let edit_owner = edits.store.owner();
    refused(
        edits.apply_body(&edit_owner, dream).map(|_| ()),
        WriteKind::Dream,
    );
    assert_eq!(effects(&edits), before);
    // ...and still edits.
    edits
        .apply(
            &edit_owner,
            &edits.main,
            "mode-key-000000006",
            json!([create("a.md", "# a\n")]),
            None,
        )
        .expect("edit-only edits");
}
