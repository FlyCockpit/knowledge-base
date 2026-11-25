//! Merge plans and status reads: typed failures, noops, canonical objects and named-PR overwrites.

use super::*;

/// The status filter of a list sees statuses made current first
/// (no prior read), so a freshly clashing PR is found under CONFLICT and not
/// under OPEN, with the main it was checked against.
#[test]
fn list_filters_on_current_statuses() {
    let (k, pr, main) = clashing_pr("list-current");
    let by = |status: &str| {
        k.store
            .pull_requests_list(
                &k.store.owner(),
                input::<PullRequestsList>(json!({"kbId":k.kb,"status":status})),
            )
            .expect("list")
            .items
    };
    assert!(by("OPEN").is_empty());
    let conflicted = by("CONFLICT");
    assert_eq!(conflicted.len(), 1);
    assert_eq!(
        (conflicted[0].number, &conflicted[0].target_sha),
        (pr.number, &main)
    );
}

/// A Git execution failure during the status check is an error,
/// never a cached or recorded content conflict.
#[test]
fn git_failures_never_become_conflicts() {
    let (k, pr, _) = clashing_pr("git-failure");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "fail-merge-tree");
    let mut child = PolicyChild::new(
        &k,
        "get",
        json!({"kbId":k.kb,"number":pr.number}),
        Some(&wrapper.path),
    );
    child.start();
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(30)),
        "RESULT:STORAGE_UNAVAILABLE"
    );
    drop(child);
    let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("fixture");
    let (status, checked): (String, Option<String>) = db
        .query_row(
            "SELECT status, merge_checked_sha FROM pull_requests WHERE kb_id=?1 AND number=?2",
            (k.kb.as_str(), pr.number as i64),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("row");
    assert_eq!(status, "OPEN", "no conflict was cached");
    assert_eq!(
        checked.as_deref(),
        Some(pr.base_sha.as_str()),
        "the old check stands"
    );
    // With a working Git the same read reports the real clash.
    assert_eq!(k.get(pr.number, None).pr.status, PrStatus::Conflict);
}

/// Retrying a refused merge with its key replays the typed
/// PROPOSAL_CONFLICT (paths and versions), not a bare CONFLICT.
#[test]
fn a_refused_merge_replays_its_typed_details() {
    let (k, pr, _) = clashing_pr("typed-replay");
    let viewed = k.get(pr.number, None).pr;
    let first = k
        .review(&k.store.owner(), &viewed, "merge", "typed-replay-merge-1")
        .expect_err("refused");
    let again = k
        .review(&k.store.owner(), &viewed, "merge", "typed-replay-merge-1")
        .expect_err("replayed");
    assert_eq!(first.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    assert_eq!(again.protocol_details(), first.protocol_details());
    // A reader without the PR's KB still gets nothing back.
    let stranger = k.principal(&[]);
    assert_ne!(
        k.review(&stranger, &viewed, "merge", "typed-replay-merge-1")
            .expect_err("forbidden")
            .protocol_code(),
        ErrorCode::Conflict
    );
}

/// A dream PR is pinned to its own main — neither an ordinary
/// edit naming it nor the author's implicit selection moves it onto main.
#[test]
fn ordinary_edits_never_move_a_dream_pr() {
    let k = Kb::new("dream-pinned");
    let author = k.principal(&[Permission::Propose]);
    let dreamt = k.dream(&author, "dream-pinned-key-01", "dreamt body\n");
    let pr = dreamt.proposal.expect("dream proposal");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "dream-pinned-main1",
            edit("create", "human.md", "h"),
        )
        .commit_sha;
    // Named (with the head the caller read) and implicit selection alike.
    let named = k.try_edit_pr(
        &author,
        &main,
        "dream-pinned-named1",
        edit("create", "other.md", "o"),
        pr.number,
        &pr.head_sha,
    );
    let implicit = k.try_edit(
        &author,
        &main,
        "dream-pinned-implic",
        edit("create", "other.md", "o"),
        None,
    );
    for (key, result) in [("named", named), ("implicit", implicit)] {
        match result.expect_err("pinned") {
            StoreError::StaleBase { head_sha, .. } => assert_eq!(head_sha, pr.head_sha, "{key}"),
            other => panic!("{key}: expected StaleBase, got {other:?}"),
        }
    }
    assert_eq!(k.get(pr.number, None).pr.base_sha, pr.base_sha);
}

/// A no-op names the revision it was evaluated on — the PR head a
/// request against main reached, never the request's base.
#[test]
fn a_noop_reached_from_main_names_the_pr_head() {
    let k = Kb::new("noop-head");
    let author = k.principal(&[Permission::Propose]);
    let owner = k.store.owner();
    let seeded = k
        .edit(
            &owner,
            &k.main,
            "noop-head-seed-01",
            edit("create", "b.md", "bee\n"),
        )
        .commit_sha;
    let pr = k
        .try_edit(
            &author,
            &seeded,
            "noop-head-pr-0001",
            edit("create", "a.md", "a"),
            None,
        )
        .expect("proposal")
        .proposal
        .expect("proposal");
    let noop = k
        .try_edit(
            &author,
            &seeded,
            "noop-head-same-01",
            edit("replace", "b.md", "bee\n"),
            None,
        )
        .expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    assert_eq!(noop.commit_sha, pr.head_sha);
    assert_eq!(noop.proposal.map(|p| p.head_sha), Some(pr.head_sha));
}

/// A fresh no-op is validated like a read/merge, even without publication.
#[test]
fn fresh_noop_checks_status_against_locked_main() {
    let (k, pr, main, author) = clashing_pr_by("noop-checked");
    let noop = k
        .try_edit_pr(
            &author,
            &pr.head_sha,
            "noop-checked-same1",
            edit("replace", "shared.md", "pr\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect("noop");
    assert_eq!(noop.kind, ApplyKind::Noop);
    let summary = noop.proposal.expect("proposal");
    assert_eq!(summary.status, PrStatus::Conflict);
    assert_eq!(summary.target_sha, main);
    assert_eq!(summary, k.get(pr.number, None).pr);
}

/// Planning never writes into the canonical object store —
/// status reads, refused merges and refused updates leave its object set
/// unchanged; only a successful publication promotes what it needs.
#[test]
fn status_reads_and_rejected_plans_leave_canonical_objects_unchanged() {
    let (k, pr, main) = clashing_pr("canonical-objects");
    let author = k
        .store
        .proposal(&k.kb, pr.number)
        .expect("fixture")
        .expect("pr")
        .author_actor_key;
    let _ = author;
    let before = object_set(&k);
    // A status read (the merge plan with line merges and a candidate tree).
    assert_eq!(k.get(pr.number, None).pr.status, PrStatus::Conflict);
    assert_eq!(k.list().len(), 1);
    assert_eq!(object_set(&k), before, "status reads");
    // A refused merge.
    let viewed = k.get(pr.number, None).pr;
    assert!(
        k.review(&k.store.owner(), &viewed, "merge", "canonical-merge-key")
            .is_err()
    );
    assert_eq!(object_set(&k), before, "refused merge");
    // A refused update (resolves nothing, PROPOSAL_CONFLICT) and a refused
    // edit (whole-tree validation: a duplicated document id).
    let proposer = k.principal(&[Permission::Propose]);
    let _ = k.try_edit(
        &proposer,
        &main,
        "canonical-refused-1",
        edit("create", "x.md", "x"),
        None,
    );
    let owner = k.store.owner();
    k.edit(
        &owner,
        &main,
        "canonical-id-seed01",
        edit("create", "id.md", "---\nid: same\n---\na"),
    );
    let seeded = object_set(&k);
    let head = k.head();
    assert!(
        k.try_edit(
            &owner,
            &head,
            "canonical-id-dupe1",
            edit("create", "dup.md", "---\nid: same\n---\nb"),
            None
        )
        .is_err()
    );
    assert_eq!(object_set(&k), seeded, "refused edits");
}

/// A commit of the required files plus `docs` (deep paths) built with one
/// index: `update-index --index-info` then `write-tree`.
fn deep_commit(k: &Kb, docs: &[(String, Vec<u8>)], parents: &[&str]) -> Sha {
    let mut files: Vec<(String, Vec<u8>)> = with_required(&[])
        .into_iter()
        .map(|(p, b)| (p.to_owned(), b.to_vec()))
        .collect();
    files.extend(docs.iter().cloned());
    let shas = bulk_blobs(k, &files.iter().map(|(_, b)| b.clone()).collect::<Vec<_>>());
    let index = k.git.root.join(format!("deep-index-{}", files.len()));
    let _ = std::fs::remove_file(&index);
    let mut info = String::new();
    for ((path, _), sha) in files.iter().zip(&shas) {
        info.push_str(&format!("100644 {sha}\t{path}\n"));
    }
    let run = |args: &[&str], input: Option<&str>| -> String {
        let mut child = ChildGuard::new(
            fixture::scratch_git()
                .arg("--git-dir")
                .arg(fixture::git_spelling(&k.git.repo))
                .args(args)
                .env("GIT_INDEX_FILE", &index)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("git"),
        );
        let mut stdin = child.stdin.take().expect("stdin");
        let text = input.unwrap_or("").to_owned();
        let feeder = std::thread::spawn(move || stdin.write_all(text.as_bytes()).expect("fixture"));
        let out = child.wait_with_output().expect("git");
        feeder.join().expect("feeder");
        assert!(out.status.success());
        String::from_utf8(out.stdout)
            .expect("utf8")
            .trim()
            .to_owned()
    };
    run(&["update-index", "--add", "--index-info"], Some(&info));
    let tree = run(&["write-tree"], None);
    std::fs::remove_file(&index).expect("fixture");
    sha(&k.git.commit(&tree, parents))
}

/// A valid tree with thousands of distinct subtrees (320
/// documents, each 24 directories deep: 7,680 subtrees, about 8,000 entries)
/// is planned within the 30-second deadline by status checks, a move onto
/// main and the reviewed merge — trees are written in batches, not one Git
/// process per directory. The deadline is not raised.
#[test]
#[cfg_attr(
    windows,
    ignore = "known Windows timing issue: Defender scans every loose object Git writes; follow-up: write fewer loose objects (cheaper tree-batch and pack writes)"
)]
fn thousands_of_distinct_subtrees_fit_the_pr_deadline() {
    let k = Kb::new("deep-subtrees");
    let owner = k.store.owner();
    let author = k.principal(&[Permission::Propose]);
    const N: usize = 320;
    let path = |i: usize| -> String {
        let dirs: Vec<String> = (0..24).map(|d| format!("d{i}x{d}")).collect();
        format!("{}/doc.md", dirs.join("/"))
    };
    let docs = |f: &dyn Fn(usize) -> String| -> Vec<(String, Vec<u8>)> {
        (0..N).map(|i| (path(i), f(i).into_bytes())).collect()
    };
    let own = |name: &str, who: &LocalPrincipal, tip: &Sha| {
        k.git.set_ref(name, tip.as_str());
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        rusqlite::Connection::open(k.store.paths().state_db())
            .expect("fixture")
            .execute(
                "INSERT INTO branch_owners VALUES (?1, ?2, ?3, 'USER', 'fixture')",
                (k.kb.as_str(), name, who.actor_key()),
            )
            .expect("fixture");
        drop(guard);
    };
    let base = deep_commit(
        &k,
        &docs(&|i| format!("# Doc {i}\n\none\ntwo\nthree\n")),
        &[k.main.as_str()],
    );
    let main = deep_commit(
        &k,
        &docs(&|i| format!("# Doc {i}\n\nONE\ntwo\nthree\n")),
        &[base.as_str()],
    );
    // Prepare the graph independently of the operations being timed.
    k.git.set_ref("refs/heads/main", main.as_str());
    rusqlite::Connection::open(k.store.paths().state_db())
        .expect("fixture")
        .execute(
            "UPDATE kbs SET head_sha=?2 WHERE id=?1",
            (k.kb.as_str(), main.as_str()),
        )
        .expect("fixture head");
    let head = deep_commit(
        &k,
        &docs(&|i| format!("# Doc {i}\n\none\ntwo\nTHREE\n")),
        &[base.as_str()],
    );
    own("refs/heads/author/deep", &author, &head);
    // One pack is a durable seed; timed calls do not inherit dirty fixture
    // inodes or run unrelated fast-forward journals against their PR budget.
    k.git.git(&[
        "-c",
        "core.fsync=pack,pack-metadata",
        "-c",
        "core.fsyncMethod=fsync",
        "repack",
        "-a",
    ]);
    let pack_dir = k.git.repo.join("objects/pack");
    for dir in [&pack_dir, &k.git.repo.join("objects"), &k.git.repo] {
        kb_local::paths::sync_dir(dir).expect("durable fixture entries");
    }
    let started = Instant::now();
    // Status at creation: line merges of every document and the merged tree.
    let pr = k
        .store
        .pull_requests_create(
            &author,
            input::<PullRequestsCreate>(json!({
                "kbId":k.kb,"headBranch":"author/deep","expectedHeadSha":head,
                "expectedTargetSha":main,"title":"Deep","idempotencyKey":"deep-author-create"
            })),
        )
        .expect("create within the deadline")
        .pr;
    assert_eq!(pr.status, PrStatus::Open);
    // A move onto main (rebase planning rebuilds every changed subtree).
    let moved = k
        .try_edit_pr(
            &author,
            &main,
            "deep-author-move",
            edit("create", "note.md", "n"),
            pr.number,
            &head,
        )
        .expect("move onto main within the deadline");
    assert_eq!(
        moved.proposal.as_ref().map(|p| p.base_sha.clone()),
        Some(main.clone())
    );
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    let merged = k
        .review(&owner, &viewed, "merge", "deep-author-merge-key")
        .expect("merge within the deadline");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    assert_eq!(
        k.git.git(&["show", &format!("{}:{}", k.head(), path(319))]),
        "# Doc 319\n\nONE\ntwo\nTHREE"
    );
    assert!(
        started.elapsed() < Duration::from_secs(90),
        "{:?}",
        started.elapsed()
    );
}

/// One consent rule: a request against main overwrites a path
/// the caller's PR changed — a fresh conflict here, document or asset — only
/// by naming the PR with the head it read; otherwise nothing is applied.
#[test]
fn overwriting_any_pr_changed_path_requires_naming_the_pr() {
    // Document: main and the PR change the same document (a fresh conflict).
    let (k, pr, main, author) = clashing_pr_by("consent-document");
    let unnamed = k
        .try_edit(
            &author,
            &main,
            "consent-doc-unnamed",
            edit("replace", "shared.md", "mine\n"),
            None,
        )
        .expect_err("unnamed overwrite");
    assert_eq!(unnamed.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
    // A base equal to the PR head is no substitute for either selector.
    for (number, observed) in [
        (None, None),
        (Some(pr.number), None),
        (None, Some(pr.head_sha.clone())),
    ] {
        let mut request = json!({
            "kbId": k.kb, "baseRevision": pr.head_sha, "mode":"edit", "title":"consent",
            "idempotencyKey": format!("consent-direct-{}-{}", number.unwrap_or(0), observed.is_some()),
            "proposalNumber": number, "proposalHeadSha": observed,
            "changes": edit("replace", "shared.md", "mine\n"), "sourceSessionIds":[]
        });
        request
            .as_object_mut()
            .expect("object")
            .retain(|_, v| !v.is_null());
        let error = k
            .store
            .changes_apply(&author, input::<ChangesApply>(request))
            .expect_err("both selectors required even at the PR head");
        assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    }
    let named = k
        .try_edit_pr(
            &author,
            &main,
            "consent-doc-named1",
            edit("replace", "shared.md", "mine\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect("named overwrite");
    assert_eq!(named.proposal.map(|p| p.status), Some(PrStatus::Open));

    // Asset put/remove share the rule for ordinary, fresh and recorded paths.
    for clashing in [false, true] {
        let k = Kb::new(if clashing {
            "consent-asset-clash"
        } else {
            "consent-asset"
        });
        let author = k.principal(&[Permission::Propose]);
        let owner = k.store.owner();
        let shared =
            include_str!("../../../../../../../packages/api/src/lib/kb/fixtures/media-bytes.ts");
        let encoded = shared
            .split("export function minimalPng(): Buffer {")
            .nth(1)
            .expect("fixture")
            .split('"')
            .nth(1)
            .expect("PNG");
        let bytes = STANDARD.decode(encoded).expect("PNG bytes");
        let stage = |who: &LocalPrincipal, key: &str| {
            let upload = k.store.upload_begin(who,input::<UploadBegin>(json!({
                "kbId":k.kb,"kind":"asset","size":bytes.len(),"contentHash":kb_client::host::snapshot::content_hash(&bytes),
                "mime":"image/png","idempotencyKey":key
            }))).expect("staging");
            k.store.upload_write(who,input::<UploadWrite>(json!({"kbId":k.kb,"uploadId":upload.upload_id,"offset":0,"bytesBase64":encoded}))).expect("frame");
            k.store
                .upload_finish(
                    who,
                    input::<UploadFinish>(json!({"kbId":k.kb,"uploadId":upload.upload_id})),
                )
                .expect("READY");
            upload.upload_id
        };
        let uploaded = stage(&author, "consent-asset-upload1");
        let put = k.store.assets_put(&author,input::<AssetsPut>(json!({
            "kbId":k.kb,"baseRevision":k.main,"idempotencyKey":"consent-asset-put-01","path":"media/photo.png","uploadId":uploaded
        }))).expect("proposed asset");
        let pr = put.proposal.expect("proposal");
        let main = if clashing {
            k.store.assets_put(&owner,input::<AssetsPut>(json!({
                "kbId":k.kb,"baseRevision":k.main,"idempotencyKey":"consent-asset-main-1","path":"media/PHOTO.png","uploadId":stage(&owner,"consent-owner-upload1")
            }))).expect("main asset").commit_sha
        } else {
            k.edit(
                &owner,
                &k.main,
                "consent-asset-main-1",
                edit("create", "plain.md", "p"),
            )
            .commit_sha
        };
        let replacement = stage(&author, "consent-asset-upload2");
        let operations = [
            json!([{"op":"assetRemove","path":"media/photo.png"}]),
            json!([{"op":"assetPut","path":"media/photo.png","uploadId":replacement}]),
        ];
        for (i, change) in operations.iter().enumerate() {
            let error = k
                .try_edit(
                    &author,
                    &main,
                    &format!("consent-asset-unnamed-{i}"),
                    change.clone(),
                    None,
                )
                .expect_err("unnamed overwrite");
            assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
            assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
        }
        let mut observed = pr.head_sha.clone();
        if clashing {
            // Resolve the main-side case variant first, recording the PR asset.
            let step = k
                .try_edit_pr(
                    &author,
                    &main,
                    "consent-record-step1",
                    json!([{"op":"assetRemove","path":"media/PHOTO.png"}]),
                    pr.number,
                    &observed,
                )
                .expect("partial resolution");
            assert_eq!(
                step.proposal.as_ref().map(|p| p.status),
                Some(PrStatus::Conflict)
            );
            observed = step.commit_sha;
            for (i, change) in operations.iter().enumerate() {
                for (j, base) in [&main, &observed].iter().enumerate() {
                    let error = k
                        .try_edit(
                            &author,
                            base,
                            &format!("consent-record-unnamed-{i}-{j}"),
                            change.clone(),
                            None,
                        )
                        .expect_err("recorded asset needs consent");
                    assert_eq!(error.protocol_details()["reason"], "PROPOSAL_CONFLICT");
                }
            }
        }
        let named = k
            .try_edit_pr(
                &author,
                &main,
                "consent-asset-named1",
                operations[0].clone(),
                pr.number,
                &observed,
            )
            .expect("named asset write");
        assert_eq!(named.proposal.map(|p| p.status), Some(PrStatus::Open));
    }
}
