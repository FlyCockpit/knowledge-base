//! Killed processes around the proposal ref move and cross-process number allocation.

use super::*;

fn kill_at(child: &mut ChildGuard) {
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).expect("read");
        assert!(n > 0, "child exited before its kill point");
        assert_ne!(line.trim_end(), "NEVER", "child passed its kill point");
        if line.trim_end() == "AT" {
            break;
        }
    }
    child.kill().expect("kill");
    child.wait().expect("reap");
}

#[test]
fn crash_after_proposal_ref_move_recovers_one_row_and_receipt() {
    for stage in ["ref-moved", "finalizing"] {
        let kb = new_kb(&format!("crash-{stage}"));
        let proposer = kb.principal(&[Permission::Propose]);
        let root = kb.store.paths().root().to_path_buf();
        let (kb_id, main, repo) = (kb.kb.clone(), kb.main.clone(), kb.repo.clone());
        // Close the store for restart, retaining directory ownership.
        let _fixture = kb._root;
        drop(kb.store);
        let key = "crash-key-00000001";
        let mut child = spawn_role(
            "apply-kill",
            &root,
            &format!("{stage} {} {kb_id} {main} {key} a.md", proposer.id()),
        );
        kill_at(&mut child);
        // Startup recovery is opportunistic. Force its nonblocking lock
        // attempt to defer, just as unrelated registry/spawn contention can.
        let fence = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("locks/store.lock"))
            .expect("fixture fence");
        fence.lock().expect("fixture fence");
        let store = Store::open(&root).expect("reopen while recovery is deferred");
        assert_eq!(
            store
                .intents(&kb_id)
                .expect("intents")
                .into_iter()
                .find(|row| row.idempotency_key == key)
                .expect("row")
                .phase,
            Phase::Committing,
            "startup must not recover through a held fence"
        );
        fence.unlock().expect("release fixture fence");
        let record = store.read_kb(&kb_id).expect("read-only recovery gate");
        let rows: Vec<_> = store
            .intents(&kb_id)
            .expect("intents")
            .into_iter()
            .filter(|row| row.idempotency_key == key)
            .collect();
        assert_eq!(rows.len(), 1, "{stage}: one journal row");
        assert_eq!(rows[0].phase, Phase::Finalized, "{stage}");
        assert_eq!(rows[0].ref_name, "refs/heads/pr/1");
        let pr = store.proposal(&kb_id, 1).expect("pr").expect("one PR row");
        assert_eq!(pr.version, 1);
        assert_eq!(pr.status, PrStatus::Open);
        assert_eq!(store.proposal(&kb_id, 2).expect("pr"), None);
        assert_eq!(
            git(&repo, &["rev-parse", "refs/heads/pr/1"]),
            pr.head_sha.as_str()
        );
        assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), main.as_str());
        assert_eq!(record.head_sha.as_deref(), Some(main.as_str()));
        assert_eq!(record.desired_epoch, 1, "no index intent for a proposal");
        let replay = store
            .changes_apply(&proposer, child_input(&kb_id, &main, key, "a.md"))
            .expect("replay the recovered receipt");
        wire::<ChangesApply>(&replay);
        assert_eq!(replay.kind, ApplyKind::Proposed);
        assert_eq!(replay.operation_id, rows[0].op_id);
        assert_eq!(replay.commit_sha, pr.head_sha);
        assert_eq!(replay.proposal, Some(pr.clone()));
        // The next edit reuses #1.
        let next = store
            .changes_apply(
                &proposer,
                child_input(&kb_id, &pr.head_sha, "crash-key-00000002", "b.md"),
            )
            .expect("next");
        assert_eq!(next.proposal.expect("pr").number, 1);
    }
}

#[test]
fn crash_before_proposal_ref_move_aborts_without_burning_a_number() {
    let kb = new_kb("crash-committing");
    let proposer = kb.principal(&[Permission::Propose]);
    let root = kb.store.paths().root().to_path_buf();
    let (kb_id, main, repo) = (kb.kb.clone(), kb.main.clone(), kb.repo.clone());
    // Close the store for restart, retaining directory ownership.
    let _fixture = kb._root;
    drop(kb.store);
    let key = "crash-key-00000003";
    let mut child = spawn_role(
        "apply-kill",
        &root,
        &format!("committing {} {kb_id} {main} {key} a.md", proposer.id()),
    );
    kill_at(&mut child);
    let store = Store::open(&root).expect("reopen");
    let record = store.read_kb(&kb_id).expect("read-only recovery gate");
    assert_eq!(record.head_sha.as_deref(), Some(main.as_str()));
    assert_eq!(
        record.desired_epoch, 1,
        "aborted proposal has no index effect"
    );
    let row = store
        .intents(&kb_id)
        .expect("intents")
        .into_iter()
        .find(|row| row.idempotency_key == key)
        .expect("row");
    assert_eq!(row.phase, Phase::Aborted);
    assert_eq!(store.proposal(&kb_id, 1).expect("pr"), None);
    assert!(!refs(&repo).contains("refs/heads/pr/"), "no proposal ref");
    let err = store
        .changes_apply(&proposer, child_input(&kb_id, &main, key, "a.md"))
        .expect_err("stable abort");
    assert!(matches!(err, StoreError::OperationAborted(_)), "{err:?}");
    let fresh = store
        .changes_apply(
            &proposer,
            child_input(&kb_id, &main, "crash-key-00000004", "a.md"),
        )
        .expect("fresh");
    assert_eq!(fresh.proposal.expect("pr").number, 1);
}

#[test]
#[cfg_attr(
    windows,
    ignore = "known Windows timing issue: Defender scans every loose object Git writes; follow-up: write fewer loose objects (cheaper tree-batch and pack writes)"
)]
fn two_processes_serialize_proposal_number_allocation() {
    let kb = new_kb("alloc");
    let a = kb.principal(&[Permission::Propose]);
    let b = kb.principal(&[Permission::Propose]);
    let root = kb.store.paths().root().to_path_buf();
    let (kb_id, main, repo) = (kb.kb.clone(), kb.main.clone(), kb.repo.clone());
    // Close the store for restart, retaining directory ownership.
    let _fixture = kb._root;
    drop(kb.store);
    let children: Vec<ChildGuard> = [(&a, "alloc-key-000000a"), (&b, "alloc-key-000000b")]
        .into_iter()
        .map(|(who, key)| {
            spawn_role(
                "apply",
                &root,
                &format!("- {} {kb_id} {main} {key} {}.md", who.id(), &key[15..]),
            )
        })
        .collect();
    // Drain every concurrently spawned child before a result assertion can panic.
    let outputs: Vec<_> = children
        .into_iter()
        .map(ChildGuard::wait_with_output)
        .collect();
    let mut numbers = Vec::new();
    for output in outputs {
        let output = output.expect("wait");
        assert!(output.status.success());
        for line in String::from_utf8(output.stdout).expect("utf8").lines() {
            if let Some(n) = line.strip_prefix("OK ") {
                numbers.push(n.parse::<u64>().expect("number"));
            }
            assert!(!line.starts_with("ERR"), "{line}");
        }
    }
    numbers.sort_unstable();
    assert_eq!(numbers, [1, 2], "distinct, gap-free numbers");
    let store = Store::open(&root).expect("reopen");
    let authors: Vec<String> = [1, 2]
        .iter()
        .map(|n| {
            store
                .proposal(&kb_id, *n)
                .expect("pr")
                .expect("pr")
                .author_actor_key
        })
        .collect();
    assert!(authors.contains(&a.actor_key()) && authors.contains(&b.actor_key()));
    assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), main.as_str());
    assert_eq!(refs(&repo).lines().count(), 3, "main + pr/1 + pr/2");
}
