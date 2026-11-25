//! Promotion of staged objects and store paths with unusual characters.

use super::*;

/// Promotion installs an indexed pack. An
/// interrupted install leaves no journal row and no blocked name: the next
/// attempt publishes, even with Git's temporary garbage left in place.
#[test]
fn an_interrupted_promotion_leaves_nothing_visible_and_retries() {
    let (k, pr, _, author) = clashing_pr_by("promotion-interrupted");
    let owner = k.store.owner();
    // Resolve the clash so the PR merges (a real merge commit to promote).
    let main = k.head();
    k.try_edit_pr(
        &author,
        &main,
        "promotion-resolve-01",
        edit("replace", "shared.md", "both\n"),
        pr.number,
        &pr.head_sha,
    )
    .expect("resolution");
    k.edit(
        &owner,
        &main,
        "promotion-main-key-1",
        edit("create", "later.md", "l"),
    );
    let viewed = k.get(pr.number, None).pr;
    let req = serde_json::to_value(k.review_input(&viewed, "merge", "promotion-merge-key1"))
        .expect("fixture");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "index-pack");
    let intents = |k: &Kb| k.store.intents(&k.kb).expect("fixture").len();
    let before = intents(&k);
    let mut child = PolicyChild::new(&k, "review", req.clone(), Some(&wrapper.path));
    child.start();
    wrapper.wait("mark");
    let pid = std::fs::read_to_string(wrapper.bin.join("pid")).expect("Git PID");
    #[cfg(unix)]
    assert!(
        Command::new("kill")
            .args(["-KILL", pid.trim()])
            .status()
            .expect("kill Git by PID")
            .success()
    );
    #[cfg(windows)]
    assert!(
        Command::new("taskkill.exe")
            .args(["/F", "/PID", pid.trim()])
            .status()
            .expect("kill Git by PID")
            .success()
    );
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(30)),
        "RESULT:STORAGE_UNAVAILABLE"
    );
    drop(child);
    assert_eq!(intents(&k), before, "no journal-visible state");
    assert_eq!(k.head(), viewed.target_sha);
    let merged = k
        .store
        .pull_requests_review(&owner, input::<PullRequestsReview>(req))
        .expect("retry publishes");
    assert_eq!(merged.pr.status, PrStatus::Merged);
}

/// Interrupt the real pack stream during index-pack, after complete objects
/// have already arrived. No object from that failed graph may become visible.
#[test]
fn a_truncated_pack_exposes_no_partial_graph_and_retries() {
    let (k, pr, _, author) = clashing_pr_by("pack-truncated");
    let owner = k.store.owner();
    let main = k.head();
    k.try_edit_pr(
        &author,
        &main,
        "pack-truncated-resolve",
        edit("replace", "shared.md", "both\n"),
        pr.number,
        &pr.head_sha,
    )
    .expect("resolve");
    k.edit(
        &owner,
        &main,
        "pack-truncated-main",
        edit("create", "later.md", "later"),
    );
    let viewed = k.get(pr.number, None).pr;
    let request =
        serde_json::to_value(k.review_input(&viewed, "merge", "pack-truncated-merge")).unwrap();
    let before = object_set(&k);
    let intents = k.store.intents(&k.kb).unwrap().len();
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "truncate-pack");
    let mut child = PolicyChild::new(&k, "review", request.clone(), Some(&wrapper.path));
    child.start();
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(30)),
        "RESULT:STORAGE_UNAVAILABLE"
    );
    assert!(
        wrapper.bin.join("truncated-pack").exists(),
        "real pack was truncated during installation"
    );
    drop(child);
    assert_eq!(object_set(&k), before, "no partial graph is visible");
    assert_eq!(k.store.intents(&k.kb).unwrap().len(), intents);
    assert_eq!(k.head(), viewed.target_sha);
    // Recovery owns all unfinished pack files because index-pack ran in scratch.
    drop(k.store.lock_write(std::slice::from_ref(&k.kb)).unwrap());
    assert!(
        std::fs::read_dir(k.git.root.join("store/uploads"))
            .unwrap()
            .all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("publish-"))
    );
    let merged = k
        .store
        .pull_requests_review(&owner, input::<PullRequestsReview>(request))
        .expect("retry");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    // A crash after linking a complete pack but before its index leaves only
    // an invisible orphan; recovery reclaims it and preserves indexed packs.
    let packs = k.git.repo.join("objects/pack");
    let orphan = packs.join(format!("pack-{}.pack", "e".repeat(40)));
    let complete = std::fs::read_dir(&packs)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "pack"))
        .unwrap();
    std::fs::copy(complete, &orphan).unwrap();
    drop(k.store.lock_write(std::slice::from_ref(&k.kb)).unwrap());
    assert!(!orphan.exists());
    assert_eq!(k.head(), merged.pr.merge_commit_sha.unwrap());
}

/// A store path containing `:` (a path-list delimiter) plans and
/// publishes; the disposable store reaches the canonical one through its
/// `info/alternates` file.
#[cfg(unix)]
#[test]
fn store_paths_with_colons_publish() {
    let mut git = Fixture::new("colon");
    let store = Store::open(&git.root.join("store:with-colon")).expect("store");
    let out = store
        .bases_create(
            &store.owner(),
            input::<BasesCreate>(json!({
                "name":"Colon KB", "slug":"colon", "description":"Store path with a colon",
                "idempotencyKey":"colon-kb-create-0001"
            })),
        )
        .expect("kb");
    git.repo = store.paths().repo_dir(&out.kb.id);
    let k = Kb {
        store,
        git,
        kb: out.kb.id,
        main: out.kb.head_sha,
    };
    let pr = k.propose(&k.principal(&[Permission::Propose]), "topic.md");
    let main = k
        .edit(
            &k.store.owner(),
            &k.main,
            "colon-main-key-0001",
            edit("create", "human.md", "h"),
        )
        .commit_sha;
    let viewed = k.get(pr.number, None).pr;
    assert_eq!((viewed.status, &viewed.target_sha), (PrStatus::Open, &main));
    let merged = k
        .review(&k.store.owner(), &viewed, "merge", "colon-merge-key-001")
        .expect("merge");
    assert_eq!(merged.pr.status, PrStatus::Merged);
}

/// A newline cannot be represented in Git's line-based alternates file.
#[cfg(unix)]
#[test]
fn store_paths_with_newlines_fail_with_a_typed_error() {
    let git = Fixture::new("newline");
    let store = Store::open(&git.root.join("store\nnewline")).expect("store");
    let out = store
        .bases_create(
            &store.owner(),
            input::<BasesCreate>(json!({
                "name":"Newline KB", "slug":"newline", "description":"Path fixture",
                "idempotencyKey":"newline-create-001"
            })),
        )
        .expect("KB");
    let error = store
        .changes_apply(
            &store.owner(),
            input::<ChangesApply>(json!({
                "kbId":out.kb.id,"baseRevision":out.kb.head_sha,"mode":"edit","title":"test",
                "idempotencyKey":"newline-edit-001", "sourceSessionIds":[],
                "changes":edit("create","a.md","a")
            })),
        )
        .expect_err("unrepresentable alternates path");
    assert!(matches!(error, StoreError::UnsafePath(_)));
    assert_eq!(error.protocol_code(), ErrorCode::RepairRequired);
}
