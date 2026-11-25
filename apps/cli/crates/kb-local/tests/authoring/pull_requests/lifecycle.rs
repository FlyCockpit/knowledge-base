//! Create, list, review, fast-forward and divergent merges, close, deltas and write modes.

use super::*;

#[test]
fn empty_list_create_owned_user_branch_and_exact_deltas() {
    let k = Kb::new("owned");
    let author = k.principal(&[Permission::Propose]);
    let stranger = k.principal(&[Permission::Propose]);
    let empty = k
        .store
        .pull_requests_list(&author, input::<PullRequestsList>(json!({"kbId":k.kb})))
        .expect("fixture");
    assert!(empty.items.is_empty());
    assert!(empty.next_cursor.is_none());
    wire::<PullRequestsList>(&empty);
    let denied = k.principal(&[]);
    code(
        k.store
            .pull_requests_list(&denied, input::<PullRequestsList>(json!({"kbId":k.kb}))),
        ErrorCode::NotFound,
    );
    code(
        k.store.pull_requests_get(
            &denied,
            input::<PullRequestsGet>(json!({"kbId":k.kb,"number":1})),
        ),
        ErrorCode::NotFound,
    );
    let head = k.user_branch(
        &author,
        "user/topic",
        &[("new.md", b"new"), ("index.md", b"changed")],
    );
    let req = k.create_input("user/topic", &head, "user-pr-key-00001");
    code(
        k.store.pull_requests_create(&stranger, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Read]);
    code(
        k.store.pull_requests_create(&author, req.clone()),
        ErrorCode::Forbidden,
    );
    assert!(k.store.proposal(&k.kb, 1).expect("fixture").is_none());
    k.permissions(&author, &[Permission::Propose]);
    let mut stale = req.clone();
    stale.expected_head_sha = k.main.clone();
    code(
        k.store.pull_requests_create(&author, stale),
        ErrorCode::Conflict,
    );
    let out = k
        .store
        .pull_requests_create(&author, req.clone())
        .expect("fixture");
    wire::<PullRequestsCreate>(&out);
    assert_eq!(out.pr.source_branch, "user/topic");
    assert_eq!(out.pr.base_sha, k.main);
    assert_eq!(out.pr.author_actor_key, author.actor_key());
    assert_eq!(out.pr.version, 1);
    assert_eq!(
        k.store.pull_requests_create(&author, req).expect("fixture"),
        out
    );
    code(
        k.store.pull_requests_create(
            &author,
            k.create_input("user/topic", &head, "second-pr-key-001"),
        ),
        ErrorCode::Conflict,
    );
    let detail = k.get(out.pr.number, None);
    wire::<PullRequestsGet>(&detail);
    assert_eq!(detail.files.len(), 2);
    assert!(detail.touched_assets.is_empty());
    assert_eq!(detail.files[0].status, FileDeltaStatus::Modified);
    assert!(detail.files[0].before_blob_sha.is_some());
    assert!(detail.files[0].after_blob_sha.is_some());
    assert_eq!(detail.files[1].status, FileDeltaStatus::Added);
    assert!(detail.files[1].before_blob_sha.is_none());
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
    // Existing explicit proposal editing must preserve a USER source ref.
    let advanced = k.store.changes_apply(&author, input::<ChangesApply>(json!({
        "kbId":k.kb,"baseRevision":head,"idempotencyKey":"user-advance-001",
        "mode":"edit","title":"Advanced","proposalNumber":out.pr.number,"proposalHeadSha":head,
        "changes":[{"op":"replace","path":"new.md","content":{"markdown":"advanced"}}],"sourceSessionIds":[]
    }))).expect("fixture");
    assert_eq!(
        advanced.proposal.expect("fixture").source_branch,
        "user/topic"
    );
}

#[test]
fn fast_forward_requires_review_confirm_and_replays_durable_sha() {
    let k = Kb::new("ff");
    let author = k.principal(&[Permission::Write]);
    // write doesn't imply review; use propose-only author for the auto branch.
    let proposer = k.principal(&[Permission::Propose]);
    let reviewer = k.principal(&[Permission::Review]);
    let pr = k.propose(&proposer, "topic.md");
    let req = k.review_input(&pr, "merge", "ff-merge-key-001");
    code(
        k.store.pull_requests_review(&author, req.clone()),
        ErrorCode::Forbidden,
    );
    code(
        k.store.pull_requests_review(&proposer, req.clone()),
        ErrorCode::Forbidden,
    );
    let mut invalid = req.clone();
    invalid.confirm = ReviewConfirm::Close;
    code(
        k.store.pull_requests_review(&reviewer, invalid),
        ErrorCode::InvalidArgument,
    );
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
    let out = k
        .store
        .pull_requests_review(&reviewer, req.clone())
        .expect("fixture");
    wire::<PullRequestsReview>(&out);
    assert_eq!(out.pr.status, PrStatus::Merged);
    assert_eq!(out.pr.merge_commit_sha, Some(pr.head_sha.clone()));
    assert_eq!(k.head(), pr.head_sha);
    assert_eq!(k.epoch(), 2);
    assert_eq!(
        k.store
            .pull_requests_review(&reviewer, req.clone())
            .expect("fixture"),
        out
    );
    assert_eq!(k.epoch(), 2);
    let guard = k
        .store
        .lock_write(std::slice::from_ref(&k.kb))
        .expect("fixture");
    k.store.compact_receipts(&guard).expect("fixture");
    drop(guard);
    assert_eq!(
        k.store
            .pull_requests_review(&reviewer, req.clone())
            .expect("fixture"),
        out
    );
    k.permissions(&reviewer, &[Permission::Read]);
    code(
        k.store.pull_requests_review(&reviewer, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&reviewer, &[Permission::Review]);
    let mut mismatch = req.clone();
    mismatch.expected_target_sha = pr.head_sha.clone();
    code(
        k.store.pull_requests_review(&reviewer, mismatch),
        ErrorCode::IdempotencyMismatch,
    );
    k.permissions(&reviewer, &[]);
    code(
        k.store.pull_requests_review(&reviewer, req),
        ErrorCode::NotFound,
    );
    let closed_edit = input::<ChangesApply>(json!({"kbId":k.kb,"baseRevision":pr.head_sha,
        "idempotencyKey":"terminal-edit-001","mode":"edit","title":"no","proposalNumber":pr.number,
        "changes":[{"op":"create","path":"forbidden.md","content":{"markdown":"no"}}],"sourceSessionIds":[]}));
    // The author's own merged PR: the precondition answer (current main).
    code(
        k.store.changes_apply(&proposer, closed_edit),
        ErrorCode::Conflict,
    );
    assert_eq!(
        k.git
            .git(&["rev-parse", &format!("refs/heads/{}", pr.source_branch)]),
        pr.head_sha.as_str()
    );
}

#[test]
fn divergent_merge_has_exactly_two_parents_main_first_and_validates_whole_result() {
    let k = Kb::new("divergent");
    let author = k.principal(&[Permission::Propose]);
    let pr = k.propose(&author, "topic.md");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "main-update-0001",
            edit("create", "human.md", "human"),
        )
        .commit_sha;
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.target_sha, main);
    let out = k
        .review(&k.store.owner(), &viewed, "merge", "diverge-merge-01")
        .expect("fixture");
    let merged = out.pr.merge_commit_sha.expect("fixture");
    assert_ne!(merged, pr.head_sha);
    assert_eq!(
        k.git.git(&["show", "-s", "--format=%P", merged.as_str()]),
        format!("{} {}", main, pr.head_sha)
    );
    let paths = k
        .git
        .git(&["ls-tree", "-r", "--name-only", merged.as_str()]);
    assert!(paths.contains("topic.md") && paths.contains("human.md"));
    assert_eq!(k.epoch(), 3);
    // Individually valid trees whose union duplicates a document ID must not publish.
    let k = Kb::new("invalid-union");
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .edit(
            &author,
            &k.main,
            "duplicate-pr-001",
            edit("create", "a.md", "---\nid: same\n---\na"),
        )
        .proposal
        .expect("fixture");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "duplicate-main-1",
            edit("create", "b.md", "---\nid: same\n---\nb"),
        )
        .commit_sha;
    // The duplicate id is a typed logical conflict, so the PR reads
    // CONFLICT and the merge is refused with both paths' versions.
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Conflict);
    assert_eq!(viewed.target_sha, main);
    match k.review(&k.store.owner(), &viewed, "merge", "invalid-merge-01") {
        Err(StoreError::ProposalConflict(conflict)) => {
            assert_eq!(conflict.head_sha, main);
            assert_eq!(conflict.proposal_number, Some(pr.number as i64));
            let paths: Vec<_> = conflict.paths.iter().map(|p| p.path.as_str()).collect();
            assert_eq!(paths, ["a.md", "b.md"]);
            assert!(conflict.content_included);
            let error = StoreError::ProposalConflict(conflict);
            assert_eq!(error.protocol_code(), ErrorCode::Conflict);
            assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
        }
        other => panic!("expected PROPOSAL_CONFLICT, got {other:?}"),
    }
    assert_eq!(k.head(), main);
    assert_eq!(k.epoch(), 2);
}

#[test]
fn stale_source_or_target_and_true_conflicts_never_move_main() {
    let k = Kb::new("stale");
    let author = k.principal(&[Permission::Propose]);
    let pr = k.propose(&author, "topic.md");
    let req = k.review_input(&pr, "merge", "stale-source-001");
    let advanced = k
        .try_edit_pr(
            &author,
            &pr.head_sha,
            "advance-key-0010",
            edit("replace", "topic.md", "advanced"),
            pr.number,
            &pr.head_sha,
        )
        .expect("explicit update")
        .proposal
        .expect("fixture");
    let stale = k
        .store
        .pull_requests_review(&k.store.owner(), req)
        .expect_err("stale source");
    assert_eq!(stale.protocol_code(), ErrorCode::Conflict);
    assert_eq!(
        stale.protocol_details()["headSha"],
        advanced.head_sha.as_str()
    );
    let stale_target = k.review_input(&advanced, "merge", "stale-target-001");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "stale-main-00010",
            edit("create", "main.md", "main"),
        )
        .commit_sha;
    code(
        k.store.pull_requests_review(&k.store.owner(), stale_target),
        ErrorCode::Conflict,
    );
    assert_eq!(k.head(), main);
    let k = Kb::new("conflict");
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .edit(
            &author,
            &k.main,
            "conflicting-pr-1",
            edit("replace", "index.md", "proposal"),
        )
        .proposal
        .expect("fixture");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "conflicting-main",
            edit("replace", "index.md", "human"),
        )
        .commit_sha;
    let review = k.review_input(&k.get(pr.number, None).pr, "merge", "conflict-merge-01");
    let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("db");
    let charges = || {
        db.query_row("SELECT json_array_length(times_json) FROM mutation_windows WHERE actor_key=?1 AND kb_id=?2",
        (k.store.owner().actor_key(),k.kb.as_str()),|r|r.get::<_,i64>(0)).expect("charges")
    };
    let before = charges();
    code(
        k.store
            .pull_requests_review(&k.store.owner(), review.clone()),
        ErrorCode::Conflict,
    );
    assert_eq!(
        charges(),
        before + 1,
        "conflict state and terminal failure share charge"
    );
    code(
        k.store.pull_requests_review(&k.store.owner(), review),
        ErrorCode::Conflict,
    );
    assert_eq!(charges(), before + 1, "conflict replay is free");
    assert_eq!(k.head(), main);
    assert_eq!(k.epoch(), 2);
    assert_eq!(k.get(pr.number, None).pr.status, PrStatus::Conflict);
}

#[test]
fn close_requires_reviewer_or_author_with_current_propose_and_retains_branch() {
    let k = Kb::new("close");
    let author = k.principal(&[Permission::Propose]);
    let other = k.principal(&[Permission::Propose]);
    let pr = k.propose(&author, "topic.md");
    let req = k.review_input(&pr, "close", "close-key-000010");
    code(
        k.store.pull_requests_review(&other, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Read]);
    code(
        k.store.pull_requests_review(&author, req.clone()),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Propose]);
    let out = k
        .store
        .pull_requests_review(&author, req.clone())
        .expect("fixture");
    assert_eq!(out.pr.status, PrStatus::Closed);
    assert!(out.pr.merge_commit_sha.is_none());
    wire::<PullRequestsReview>(&out);
    assert_eq!(
        k.store.pull_requests_review(&author, req).expect("fixture"),
        out
    );
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
    assert_eq!(
        k.git
            .git(&["rev-parse", &format!("refs/heads/{}", pr.source_branch)]),
        pr.head_sha.as_str()
    );
    let guard = k
        .store
        .lock_write(std::slice::from_ref(&k.kb))
        .expect("fixture");
    code(
        k.store
            .set_proposal_status_for_tests(&guard, &k.kb, pr.number, PrStatus::Open),
        ErrorCode::Conflict,
    );
    drop(guard);
    let next = k
        .edit(
            &author,
            &k.main,
            "next-proposal-01",
            edit("create", "next.md", "next"),
        )
        .proposal
        .expect("fixture");
    assert_eq!(next.number, pr.number + 1);
    let reviewer = k.principal(&[Permission::Review]);
    k.review(&reviewer, &next, "close", "reviewer-close-1")
        .expect("fixture");
    let page = k
        .store
        .pull_requests_list(
            &author,
            input::<PullRequestsList>(json!({"kbId":k.kb,"status":"CLOSED","limit":1})),
        )
        .expect("fixture");
    assert_eq!(page.items.len(), 1);
    assert!(page.next_cursor.is_some());
    wire::<PullRequestsList>(&page);
    let next_page = k
        .store
        .pull_requests_list(
            &author,
            input::<PullRequestsList>(
                json!({"kbId":k.kb,"status":"CLOSED","limit":1,"cursor":page.next_cursor}),
            ),
        )
        .expect("fixture");
    assert_eq!(next_page.items[0].number, next.number);
    assert!(next_page.next_cursor.is_none());
}

#[test]
fn late_human_provenance_conflicts_even_when_git_can_merge_cleanly() {
    let mut k = Kb::new("dream");
    k.main = k
        .dream(
            &k.store.owner(),
            "seed-dream-key001",
            &format!("{}old\n", "context\n".repeat(8)),
        )
        .commit_sha;
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .dream(
            &author,
            "dream-proposal-01",
            &format!("{}new\n", "context\n".repeat(8)),
        )
        .proposal
        .expect("fixture");
    // Legitimate dream proposals merge; a person's edit far from the dream's
    // lines is a clean Git merge but must still fail the domain guard after
    // a reopen. (A label-only rewrite would be a noop: re-saving never
    // relabels a document.)
    let root = k.store.paths().root().to_owned();
    let reopened = Store::open(&root).expect("fixture");
    // A person's edit (the server stamps web edits `human`).
    k.store
        .set_edit_stamp_for_tests(Some(kb_local::markdown::ProvenanceStamp::Human));
    let source = k
        .git
        .git(&["show", &format!("{}:concepts/concept.md", k.main)]);
    let main = k.edit(&reopened.owner(), &k.main, "human-after-dream", json!([
        {"op":"replace","path":"concepts/concept.md","content":{"markdown":format!("{}\n",source.replace("provenance: dream","provenance: human").replacen("context\n","context from a person\n",1))}}
    ])).commit_sha;
    k.git.git(&[
        "merge-tree",
        "--write-tree",
        "--no-messages",
        main.as_str(),
        pr.head_sha.as_str(),
    ]);
    code(
        reopened.pull_requests_review(
            &reopened.owner(),
            k.review_input(&k.get(pr.number, None).pr, "merge", "dream-merge-key01"),
        ),
        ErrorCode::Conflict,
    );
    assert_eq!(k.head(), main);
    assert_eq!(k.epoch(), 3);
}

#[test]
fn complete_large_diff_and_assets_pin_both_manifests_and_cursor_identity() {
    let k = Kb::new("pagination");
    let author = k.principal(&[Permission::Propose]);
    let names: Vec<_> = (0..211).map(|n| format!("docs/{n:03}.md")).collect();
    let mut extra: Vec<_> = names
        .iter()
        .map(|p| (p.as_str(), b"doc".as_slice()))
        .collect();
    // Publish a real READY asset proposal to establish permanent local lineage.
    // Its separate PR leaves the original main/base snapshot empty.
    let shared =
        include_str!("../../../../../../../packages/api/src/lib/kb/fixtures/media-bytes.ts");
    let encoded = shared
        .split("export function minimalPng(): Buffer {")
        .nth(1)
        .expect("shared fixture")
        .split('"')
        .nth(1)
        .expect("PNG fixture");
    let bytes = STANDARD.decode(encoded).expect("PNG bytes");
    let hash = kb_client::host::snapshot::content_hash(&bytes);
    let upload = k
        .store
        .upload_begin(
            &author,
            input::<UploadBegin>(json!({
                "kbId":k.kb,"kind":"asset","size":bytes.len(),"contentHash":hash,
                "mime":"image/png","idempotencyKey":"large-asset-upload-01"
            })),
        )
        .expect("staging");
    k.store
        .upload_write(
            &author,
            input::<UploadWrite>(
                json!({"kbId":k.kb,"uploadId":upload.upload_id,"offset":0,"bytesBase64":encoded}),
            ),
        )
        .expect("frame");
    k.store
        .upload_finish(
            &author,
            input::<UploadFinish>(json!({"kbId":k.kb,"uploadId":upload.upload_id})),
        )
        .expect("READY");
    k.store.assets_put(&author,input::<AssetsPut>(json!({"kbId":k.kb,"baseRevision":k.main,"idempotencyKey":"large-asset-put-01","path":"media/photo.png","uploadId":upload.upload_id}))).expect("lineage");
    let manifest = kb_local::tree::canonical_manifest_bytes(&[kb_local::tree::ManifestEntry {
        path: "media/photo.png".into(),
        hash: hash.as_str().into(),
        size: bytes.len() as u64,
        mime: "image/png".into(),
    }]);
    extra.push((".assets/manifest.json", &manifest));
    let head = k.user_branch(&author, "user/large", &extra);
    let out = k
        .store
        .pull_requests_create(
            &author,
            k.create_input("user/large", &head, "large-pr-key-001"),
        )
        .expect("fixture");
    let first = k.get(out.pr.number, None);
    wire::<PullRequestsGet>(&first);
    assert_eq!(first.files.len() + first.touched_assets.len(), 50);
    let asset = &first.touched_assets[0];
    assert!(asset.before.is_none());
    assert_eq!(
        asset.after.as_ref().expect("fixture").size,
        bytes.len() as u64
    );
    let cursor = first.next_cursor.clone().expect("fixture");
    k.edit(
        &k.store.owner(),
        &k.main,
        "advance-main-0010",
        edit("create", "main-later.md", "later"),
    );
    let foreign = k.principal(&[Permission::Read]);
    code(
        k.store.pull_requests_get(
            &foreign,
            input::<PullRequestsGet>(
                json!({"kbId":k.kb,"number":out.pr.number,"page":{"cursor":cursor}}),
            ),
        ),
        ErrorCode::InvalidCursor,
    );
    let mut tampered = cursor.clone();
    tampered.replace_range(0..1, "!");
    code(
        k.store.pull_requests_get(
            &k.store.owner(),
            input::<PullRequestsGet>(
                json!({"kbId":k.kb,"number":out.pr.number,"page":{"cursor":tampered}}),
            ),
        ),
        ErrorCode::InvalidCursor,
    );
    // Advance source through the existing journal. Subsequent pages still show the reviewed head.
    k.store
        .changes_apply(
            &author,
            input::<ChangesApply>(
                json!({"kbId":k.kb,"baseRevision":head,"proposalNumber":out.pr.number,
        "idempotencyKey":"large-advance-01","mode":"edit","title":"new head","sourceSessionIds":[],
        "changes":[{"op":"create","path":"later.md","content":{"markdown":"later"}}]}),
            ),
        )
        .expect("advance authorized proposal");
    let mut files = first.files;
    let mut assets = first.touched_assets;
    let mut next = Some(cursor);
    while let Some(token) = next {
        let page = k.get(out.pr.number, Some(token));
        wire::<PullRequestsGet>(&page);
        assert_eq!(page.pr.head_sha, head);
        assert_eq!(page.pr.base_sha, k.main);
        assert_eq!(page.pr.target_sha, k.main);
        assert!(page.files.len() + page.touched_assets.len() <= 200);
        files.extend(page.files);
        assets.extend(page.touched_assets);
        next = page.next_cursor;
    }
    assert_eq!(files.len(), 213);
    assert_eq!(assets.len(), 1);
    assert!(!files.iter().any(|d| d.path.as_str() == "later.md"));
    let paths: std::collections::BTreeSet<_> = files.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths.len(), 213);
    code(
        k.store.pull_requests_get(
            &k.store.owner(),
            input::<PullRequestsGet>(
                json!({"kbId":k.kb,"number":out.pr.number,"expectedHeadSha":head}),
            ),
        ),
        ErrorCode::Conflict,
    );
}

#[test]
fn revocation_before_reservation_denies_but_after_reservation_finishes_once() {
    for (stage, succeeds) in [(Stage::Prepared, false), (Stage::Committing, true)] {
        let k = Kb::new("revoke");
        let author = k.principal(&[Permission::Propose]);
        let reviewer = k.principal(&[Permission::Review]);
        let pr = k.propose(&author, "topic.md");
        let req = k.review_input(&pr, "merge", "revoke-merge-001");
        let result = k
            .store
            .pull_requests_review_observed(&reviewer, req.clone(), &mut |at| {
                if at == stage {
                    // Same-lock authority mutation, exactly at the reservation boundary.
                    rusqlite::Connection::open(k.store.paths().state_db()).expect("fixture").execute(
                    "UPDATE principal_ceilings SET bits=1 WHERE principal_id=?1 AND kb_id=?2",
                    (reviewer.id(),k.kb.as_str())).expect("fixture");
                }
                Ok(())
            });
        if succeeds {
            assert_eq!(result.expect("fixture").pr.status, PrStatus::Merged);
            assert_eq!(k.head(), pr.head_sha);
            assert_eq!(k.epoch(), 2);
        } else {
            code(result, ErrorCode::Forbidden);
            assert_eq!(k.head(), k.main);
            assert_eq!(k.epoch(), 1);
        }
        code(
            k.store.pull_requests_review(&reviewer, req),
            ErrorCode::Forbidden,
        );
    }
}

#[test]
fn deltas_include_deletions_and_asset_replacements_at_two_manifests() {
    let f = Fixture::new("asset-diff");
    let asset = |path: &str, hash: &str| json!({"path":path,"hash":format!("sha256:{}",hash.repeat(64)),"size":5,"mime":"image/png"});
    let before=json!({"version":1,"entries":[asset("media/change.png","a"),asset("media/delete.png","b")]}).to_string();
    let after =
        json!({"version":1,"entries":[asset("media/add.png","c"),asset("media/change.png","d")]})
            .to_string();
    let base = sha(&f.commit_files(
        &with_required(&[
            (".assets/manifest.json", before.as_bytes()),
            ("old.md", b"old"),
        ]),
        &[],
    ));
    let names: Vec<_> = (0..205).map(|n| format!("new/{n:03}.md")).collect();
    let mut files: Vec<_> = names
        .iter()
        .map(|p| (p.as_str(), b"new".as_slice()))
        .collect();
    files.push((".assets/manifest.json", after.as_bytes()));
    let head = sha(&f.commit_files(&with_required(&files), &[base.as_str()]));
    let repo = kb_local::git_read::GitRepo::open(&f.repo).expect("fixture");
    let first =
        kb_local::diff::diff_at_revisions(&repo, &base, &head, usize::MAX, None).expect("fixture");
    assert_eq!(first.files.len() + first.touched_assets.len(), 200);
    assert_eq!(first.touched_assets.len(), 3);
    assert!(first.touched_assets[0].before.is_none());
    assert_ne!(
        first.touched_assets[1].before,
        first.touched_assets[1].after
    );
    assert!(first.touched_assets[2].after.is_none());
    let second =
        kb_local::diff::diff_at_revisions(&repo, &base, &head, 200, first.next_after.as_deref())
            .expect("fixture");
    assert!(second.next_after.is_none());
    assert_eq!(first.files.len() + second.files.len(), 207);
    let deleted = second
        .files
        .iter()
        .find(|d| d.path.as_str() == "old.md")
        .expect("fixture");
    assert_eq!(deleted.status, FileDeltaStatus::Deleted);
    assert_eq!(deleted.before_blob_sha, Some(sha(&f.blob(b"old"))));
    assert!(deleted.after_blob_sha.is_none());
}

#[test]
fn legitimate_dream_and_already_integrated_source_can_be_reviewed_without_extra_epoch() {
    let mut k = Kb::new("inverse");
    let author = k.principal(&[Permission::Propose]);
    let pr = k
        .dream(&author, "clean-dream-key01", "safe\n")
        .proposal
        .expect("fixture");
    let out = k
        .review(&k.store.owner(), &pr, "merge", "clean-dream-merge")
        .expect("fixture");
    assert_eq!(out.pr.merge_commit_sha, Some(pr.head_sha));
    assert_eq!(k.epoch(), 2);
    k.main = k.head();
    let a = k.user_branch(&author, "user/first", &[("next.md", b"next")]);
    let b = k.user_branch(&author, "user/second", &[("next.md", b"next")]);
    assert_eq!(a, b);
    let first = k
        .store
        .pull_requests_create(
            &author,
            k.create_input("user/first", &a, "ancestor-first01"),
        )
        .expect("fixture")
        .pr;
    let second = k
        .store
        .pull_requests_create(
            &author,
            k.create_input("user/second", &b, "ancestor-second1"),
        )
        .expect("fixture")
        .pr;
    k.review(&k.store.owner(), &first, "merge", "ancestor-merge01")
        .expect("fixture");
    let epoch = k.epoch();
    let out = k
        .review(
            &k.store.owner(),
            &k.get(second.number, None).pr,
            "merge",
            "ancestor-merge02",
        )
        .expect("fixture");
    assert_eq!(out.pr.merge_commit_sha, Some(b));
    assert_eq!(k.head(), a);
    assert_eq!(k.epoch(), epoch);
}

/// A dream-only handle refuses PR creation and merges (an edit) before any
/// effect, with `WRITE_MODE` details, and still closes; a dream proposed
/// over an agent-written note merges under `both`.
#[test]
fn write_modes_gate_pr_creation_and_merge_and_dreams_merge_over_agent_notes() {
    use kb_client::authoring::{AuthoringMode, WriteKind};
    let mut k = Kb::new("modes");
    let author = k.principal(&[Permission::Propose]);
    let pr = k.propose(&author, "proposed.md");
    let dreamer = Store::open(k.store.paths().root()).expect("fixture");
    dreamer.narrow_authoring(AuthoringMode::Dream);
    let write_mode = |result: Result<PrMutationOutput, StoreError>| {
        let error = result.expect_err("refused");
        assert!(
            matches!(error, StoreError::WriteMode(WriteKind::Edit)),
            "{error}"
        );
        assert_eq!(
            error.protocol_details(),
            json!({"reason":"WRITE_MODE","required":"edit"})
        );
    };
    let epoch = k.epoch();
    write_mode(dreamer.pull_requests_review(
        &dreamer.owner(),
        k.review_input(&pr, "merge", "mode-merge-key-0001"),
    ));
    let head = k.user_branch(&author, "user/modes", &[("user.md", b"user")]);
    write_mode(dreamer.pull_requests_create(
        &author,
        k.create_input("user/modes", &head, "mode-create-key-001"),
    ));
    assert_eq!(k.head(), k.main, "main unchanged");
    assert_eq!(k.epoch(), epoch);
    assert_eq!(k.list().len(), 1, "no PR was created");
    // Closing writes nothing a mode governs.
    let closed = dreamer
        .pull_requests_review(
            &dreamer.owner(),
            k.review_input(&pr, "close", "mode-close-key-0001"),
        )
        .expect("a dream-only handle closes");
    assert_eq!(closed.pr.status, PrStatus::Closed);

    // An agent-written note (as a local session writes it) may be dreamed
    // over, and the reviewed merge's guard agrees.
    k.main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "agent-note-key-0001",
            edit(
                "create",
                "concepts/concept.md",
                "---\nid: \"concept\"\ntype: \"concept\"\n---\nAgent note.\n",
            ),
        )
        .commit_sha;
    assert!(
        k.git
            .git(&["show", &format!("{}:concepts/concept.md", k.main)])
            .contains("provenance: agent")
    );
    let dream = k
        .dream(&author, "agent-dream-key-0001", "Dreamed.\n")
        .proposal
        .expect("fixture");
    let merged = k
        .review(
            &k.store.owner(),
            &k.get(dream.number, None).pr,
            "merge",
            "agent-merge-key-0001",
        )
        .expect("dream over an agent note merges");
    assert_eq!(merged.pr.status, PrStatus::Merged);
}
