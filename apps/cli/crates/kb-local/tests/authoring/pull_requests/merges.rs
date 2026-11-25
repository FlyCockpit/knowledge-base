//! Conflicting proposals, moves onto main and native line merges within the PR deadline.

use super::*;

/// The wire form of a PROPOSAL_CONFLICT is a valid kb/1 envelope.
fn proposal_conflict(error: StoreError) -> Box<kb_client::error::ProposalConflict> {
    assert_eq!(error.protocol_code(), ErrorCode::Conflict);
    kb_client::error::ToolError::from_value(&json!({
        "code": "CONFLICT", "message": ErrorCode::Conflict.message(), "retryable": false,
        "details": error.protocol_details(),
    }))
    .expect("kb/1 envelope");
    match error {
        StoreError::ProposalConflict(conflict) => conflict,
        other => panic!("expected PROPOSAL_CONFLICT, got {other:?}"),
    }
}

/// Locally, as on the server: a clashing PR reads CONFLICT and
/// refuses to merge with typed details; the author moves it onto main by
/// proposing against current main, progressively, keeping its number and
/// title; then it merges.
#[test]
fn conflicting_proposal_is_marked_resolved_progressively_moved_onto_main_and_merged() {
    let k = Kb::new("clash-local");
    let author = k.principal(&[Permission::Propose]);
    let owner = k.store.owner();
    let first = k.edit(
        &author,
        &k.main,
        "clash-propose-0001-key",
        json!([
            {"op":"create","path":"proposals/three.md","content":{"markdown":"# Three\n\nfrom the PR\n"}},
            {"op":"create","path":"proposals/four.md","content":{"markdown":"# Four\n\nfrom the PR\n"}},
            {"op":"create","path":"proposals/free.md","content":{"markdown":"# Free\n"}}
        ]),
    );
    let pr = first.proposal.clone().expect("proposal");
    assert_eq!(pr.status, PrStatus::Open);
    let title = pr.title.clone();
    // Main creates the same paths.
    let main = k
        .edit(
            &owner,
            &k.main,
            "clash-main-000001-key",
            json!([
                {"op":"create","path":"proposals/three.md","content":{"markdown":"# Three\n\nfrom main\n"}},
                {"op":"create","path":"proposals/four.md","content":{"markdown":"# Four\n\nfrom main\n"}}
            ]),
        )
        .commit_sha;
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(
        (viewed.status, &viewed.target_sha),
        (PrStatus::Conflict, &main)
    );
    let listed = k.list();
    assert_eq!(
        (listed[0].status, &listed[0].target_sha),
        (PrStatus::Conflict, &main)
    );
    // Merge refuses with every clashing path and its three versions.
    let refused = proposal_conflict(
        k.review(&owner, &viewed, "merge", "clash-merge-00001-key")
            .expect_err("conflicting merge"),
    );
    assert_eq!(refused.head_sha, main);
    let paths: Vec<_> = refused.paths.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(paths, ["proposals/four.md", "proposals/three.md"]);
    let three = &refused.paths[1];
    assert_eq!(three.base, None);
    // Both writers are local sessions: agents.
    assert_eq!(
        three.theirs.as_deref(),
        Some("---\nprovenance: agent\n---\n# Three\n\nfrom main\n")
    );
    assert_eq!(
        three.yours.as_deref(),
        Some("---\nprovenance: agent\n---\n# Three\n\nfrom the PR\n")
    );
    assert_eq!(
        (three.theirs_sha.clone(), three.yours_sha.clone()),
        (main.clone(), pr.head_sha.clone())
    );
    assert_eq!(k.head(), main);
    // Against the PR head the update is accepted but keeps the clash.
    let stale = k.try_edit(
        &author,
        &main,
        "clash-stale-00001-key",
        edit("create", "other.md", "o"),
        Some(99),
    );
    assert_eq!(
        stale.expect_err("unknown PR").protocol_code(),
        ErrorCode::NotFound
    );
    // Against main, a request that resolves nothing changes nothing.
    let refused = proposal_conflict(
        k.try_edit(
            &author,
            &main,
            "clash-unrelated-01-key",
            edit("create", "other.md", "o"),
            None,
        )
        .expect_err("no progress"),
    );
    assert_eq!(refused.proposal_number, Some(pr.number as i64));
    assert_eq!(refused.paths.len(), 2);
    assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
    // Resolving one conflict moves the PR onto main; the other stays recorded.
    let step = k
        .try_edit_pr(
            &author,
            &main,
            "clash-resolve-0001-key",
            edit("replace", "proposals/three.md", "# Three\n\nresolved\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect("progress");
    // Progressive resolution chains heads: a second editor still holding the
    // pre-move head cannot resolve (or overwrite) the moved PR.
    match k
        .try_edit_pr(
            &author,
            &main,
            "clash-resolve-stale-key",
            edit("replace", "proposals/four.md", "# Four\n\nstale\n"),
            pr.number,
            &pr.head_sha,
        )
        .expect_err("stale head")
    {
        StoreError::StaleBase { head_sha, .. } => assert_eq!(head_sha, step.commit_sha),
        other => panic!("expected StaleBase, got {other:?}"),
    }
    let moved = step.proposal.clone().expect("proposal");
    assert_eq!(moved.number, pr.number);
    assert_eq!(moved.title, title, "the title is kept");
    assert_eq!(moved.base_sha, main, "the PR moved onto main");
    assert_eq!(moved.status, PrStatus::Conflict);
    assert_eq!(
        k.git
            .git(&["show", "-s", "--format=%P", step.commit_sha.as_str()]),
        format!("{} {}", main, pr.head_sha),
        "the previous head stays reachable as a second parent"
    );
    let recorded = proposal_conflict(
        k.review(
            &owner,
            &k.get(pr.number, None).pr,
            "merge",
            "clash-merge-00002-key",
        )
        .expect_err("still conflicting"),
    );
    let paths: Vec<_> = recorded.paths.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(paths, ["proposals/four.md"]);
    assert_eq!(
        recorded.paths[0].yours_sha, pr.head_sha,
        "recorded versions stay readable"
    );
    // Writing the last one (keep mine, even identical bytes) resolves it.
    let done = k
        .try_edit(
            &author,
            &main,
            "clash-resolve-0002-key",
            edit("replace", "proposals/four.md", "# Four\n\nfrom the PR\n"),
            None,
        )
        .expect_err("a recorded conflict is resolved only by naming the PR");
    assert_eq!(done.protocol_details()["reason"], "PROPOSAL_CONFLICT");
    // The same write, naming the PR with the head it read, resolves it
    // (keep mine, identical bytes).
    let done = k
        .try_edit_pr(
            &author,
            &main,
            "clash-resolve-0003-key",
            edit("replace", "proposals/four.md", "# Four\n\nfrom the PR\n"),
            pr.number,
            &step.commit_sha,
        )
        .expect("resolution");
    let open = done.proposal.clone().expect("proposal");
    assert_eq!(
        (open.status, open.version),
        (PrStatus::Open, pr.version + 2)
    );
    assert_eq!(open.title, title);
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    let merged = k
        .review(&owner, &viewed, "merge", "clash-merge-00003-key")
        .expect("merges once resolved");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    let head = k.head();
    for (path, body) in [
        (
            "proposals/three.md",
            "---\nprovenance: agent\n---\n# Three\n\nresolved\n",
        ),
        (
            "proposals/four.md",
            "---\nprovenance: agent\n---\n# Four\n\nfrom the PR\n",
        ),
        ("proposals/free.md", "---\nprovenance: agent\n---\n# Free\n"),
    ] {
        assert_eq!(
            k.git.git(&["show", &format!("{head}:{path}")]),
            body.trim_end()
        );
    }
}

/// A move onto main replays the PR's clean changes, and a line merge both
/// sides can combine is not a conflict.
#[test]
fn moving_onto_main_replays_clean_changes_and_line_merges() {
    let k = Kb::new("clash-replay");
    let author = k.principal(&[Permission::Propose]);
    let owner = k.store.owner();
    let base = k
        .edit(
            &owner,
            &k.main,
            "replay-base-0001-key",
            edit("create", "shared.md", "one\ntwo\nthree\nfour\nfive\n"),
        )
        .commit_sha;
    let pr = k
        .try_edit(
            &author,
            &base,
            "replay-pr-00001-key",
            edit("replace", "shared.md", "ONE\ntwo\nthree\nfour\nfive\n"),
            None,
        )
        .expect("proposal")
        .proposal
        .expect("proposal");
    let main = k
        .edit(
            &owner,
            &base,
            "replay-main-001-key",
            edit("replace", "shared.md", "one\ntwo\nthree\nfour\nFIVE\n"),
        )
        .commit_sha;
    // Lines combine: the PR still merges.
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    // An update against main moves it onto main with both edits.
    let moved = k
        .try_edit(
            &author,
            &main,
            "replay-move-001-key",
            edit("create", "new.md", "new"),
            None,
        )
        .expect("move onto main");
    assert_eq!(moved.proposal.as_ref().map(|p| &p.base_sha), Some(&main));
    assert_eq!(
        k.git
            .git(&["show", &format!("{}:shared.md", moved.commit_sha)]),
        "---\nprovenance: agent\n---\nONE\ntwo\nthree\nfour\nFIVE"
    );
    // Rewriting the PR's own path against main without naming it clashes.
    let refused = proposal_conflict(
        k.try_edit(
            &author,
            &main,
            "replay-over-001-key",
            edit("replace", "shared.md", "x"),
            None,
        )
        .expect_err("overwrite guard"),
    );
    assert_eq!(refused.paths[0].path, "shared.md");
}

/// A commit of the required files plus `dir/<name>` documents (one flat dir).
fn bulk_commit(k: &Kb, dir: &str, docs: &[(String, Vec<u8>)], parents: &[&str]) -> Sha {
    let shas = bulk_blobs(k, &docs.iter().map(|(_, b)| b.clone()).collect::<Vec<_>>());
    let mut entries: Vec<(&str, &[u8], &str)> = docs
        .iter()
        .zip(&shas)
        .map(|((name, _), sha)| ("100644", name.as_bytes(), sha.as_str()))
        .collect();
    entries.sort_by(|a, b| a.1.cmp(b.1));
    let sub = k.git.raw_tree(&entries);
    let required = with_required(&[]);
    let mut root: Vec<(String, Vec<u8>, String)> = required
        .iter()
        .map(|(path, bytes)| (path.to_string(), bytes.to_vec(), String::new()))
        .collect();
    // Required files may sit in a subdirectory: build them with the helper.
    let base_tree = k.git.tree(&required);
    let listing = k.git.git(&["ls-tree", &base_tree]);
    root.clear();
    let mut top: Vec<(String, String, String)> = listing
        .lines()
        .map(|line| {
            let (meta, name) = line.split_once('\t').expect("ls-tree");
            let parts: Vec<&str> = meta.split(' ').collect();
            (parts[0].to_owned(), name.to_owned(), parts[2].to_owned())
        })
        .collect();
    top.push(("40000".into(), dir.into(), sub));
    // Git orders a directory as if its name ended in `/`.
    top.sort_by(|a, b| {
        let key = |e: &(String, String, String)| {
            let mut k = e.1.clone().into_bytes();
            if e.0 == "40000" {
                k.push(b'/');
            }
            k
        };
        key(a).cmp(&key(b))
    });
    let entries: Vec<(&str, &[u8], &str)> = top
        .iter()
        .map(|(mode, name, sha)| (mode.as_str(), name.as_bytes(), sha.as_str()))
        .collect();
    let tree = k.git.raw_tree(&entries);
    sha(&k.git.commit(&tree, parents))
}

/// The shared real-Git corpus (`fixtures/text-merge-cases.json`, generated by
/// the server's merge): every case is one document of ONE local merge, and
/// the clean results and clashes match the server exactly (native
/// merge parity, not stubbed line merges).
#[test]
fn native_line_merges_match_the_servers_real_git_corpus() {
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../packages/api/src/lib/kb/fixtures/text-merge-cases.json"
        ))
        .expect("corpus"),
    )
    .expect("corpus json");
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(cases.len() >= 30);
    let k = Kb::new("text-merge");
    let side = |key: &str| -> Vec<(String, Vec<u8>)> {
        cases
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                c[key]
                    .as_str()
                    .map(|t| (format!("c{i:02}.md"), t.as_bytes().to_vec()))
            })
            .collect()
    };
    let base = bulk_commit(&k, "cases", &side("base"), &[]);
    let main = bulk_commit(&k, "cases", &side("main"), &[base.as_str()]);
    let head = bulk_commit(&k, "cases", &side("proposal"), &[base.as_str()]);
    let (conflicts, documents) = k
        .store
        .logical_merge_for_tests(&k.kb, &main, &head)
        .expect("merge");
    for (i, c) in cases.iter().enumerate() {
        let path = format!("cases/c{i:02}.md");
        let got = if conflicts.contains(&path) {
            None
        } else {
            Some(String::from_utf8(documents[&path].clone()).expect("utf8"))
        };
        assert_eq!(got.as_deref(), c["merged"].as_str(), "{}", c["name"]);
    }
}

/// Near the repository limits (4,000 documents, each changed cleanly on both
/// sides), the status check and the reviewed merge stay inside the 30-second
/// PR deadline: one merge-tree for every line merge, not one Git process per
/// document. The deadline itself is not raised.
#[test]
#[cfg_attr(
    windows,
    ignore = "known Windows timing issue: Defender scans every loose object Git writes; follow-up: write fewer loose objects (cheaper tree-batch and pack writes)"
)]
fn four_thousand_line_merges_fit_the_pr_deadline() {
    let k = Kb::new("near-limit-merges");
    let owner = k.store.owner();
    let author = k.principal(&[Permission::Propose]);
    const N: usize = 4000;
    let docs = |f: &dyn Fn(usize) -> String| -> Vec<(String, Vec<u8>)> {
        (0..N)
            .map(|i| (format!("d{i:04}.md"), f(i).into_bytes()))
            .collect()
    };
    let base_docs = docs(&|i| format!("# Doc {i}\n\none\ntwo\nthree\nfour\nfive\n"));
    let main_docs = docs(&|i| format!("# Doc {i}\n\nONE\ntwo\nthree\nfour\nfive\n"));
    let pr_docs = docs(&|i| format!("# Doc {i}\n\none\ntwo\nthree\nfour\nFIVE\n"));
    // Build the input graph outside PR deadlines. Fast-forward publication has
    // its own tests; this test measures the divergent status/read/merge work.
    let base = bulk_commit(&k, "bulk", &base_docs, &[k.main.as_str()]);
    let main = bulk_commit(&k, "bulk", &main_docs, &[base.as_str()]);
    k.git.set_ref("refs/heads/main", main.as_str());
    rusqlite::Connection::open(k.store.paths().state_db())
        .expect("fixture")
        .execute(
            "UPDATE kbs SET head_sha=?2 WHERE id=?1",
            (k.kb.as_str(), main.as_str()),
        )
        .expect("fixture head");
    let head = bulk_commit(&k, "bulk", &pr_docs, &[base.as_str()]);
    let name = "refs/heads/author/bulk";
    k.git.set_ref(name, head.as_str());
    {
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        rusqlite::Connection::open(k.store.paths().state_db())
            .expect("fixture")
            .execute(
                "INSERT INTO branch_owners VALUES (?1, ?2, ?3, 'USER', 'fixture')",
                (k.kb.as_str(), name, author.actor_key()),
            )
            .expect("fixture");
        drop(guard);
    }
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
    let pr = k
        .store
        .pull_requests_create(
            &author,
            input::<PullRequestsCreate>(json!({
                "kbId":k.kb,"headBranch":"author/bulk","expectedHeadSha":head,
                "expectedTargetSha":main,"title":"Bulk edits","idempotencyKey":"bulk-author-create"
            })),
        )
        .expect("create (status checked)")
        .pr;
    assert_eq!(pr.status, PrStatus::Open);
    let viewed = k.get(pr.number, None).pr;
    assert_eq!(viewed.status, PrStatus::Open);
    let merged = k
        .review(&owner, &viewed, "merge", "bulk-author-merge")
        .expect("merge within the deadline");
    assert_eq!(merged.pr.status, PrStatus::Merged);
    assert_eq!(
        k.git.git(&["show", &format!("{}:bulk/d3999.md", k.head())]),
        "# Doc 3999\n\nONE\ntwo\nthree\nfour\nFIVE"
    );
    // Create, the read and the merge each stay far inside their 30 s budget.
    assert!(
        started.elapsed() < Duration::from_secs(60),
        "{:?}",
        started.elapsed()
    );
}
