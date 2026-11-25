//! Interrupted merges, admission timeouts, planner scratch recovery and the shared budget.

use super::*;

#[test]
fn interrupted_merge_recovers_one_effect_and_index_intent() {
    for stage in [
        Stage::Prepared,
        Stage::Committing,
        Stage::RefMoved,
        Stage::Finalizing,
        Stage::Finalized,
    ] {
        let k = Kb::new("crash");
        let author = k.principal(&[Permission::Propose]);
        let pr = k.propose(&author, "topic.md");
        let mut child = ChildGuard::spawn(
            Command::new(std::env::current_exe().expect("fixture"))
                .args(["--exact", "child_merge_entry", "--nocapture"])
                .env("KB_PR_CHILD_ROOT", k.store.paths().root())
                .env("KB_PR_CHILD_ID", k.kb.as_str())
                .env("KB_PR_CHILD_STAGE", format!("{stage:?}"))
                .stdout(Stdio::piped())
                .stderr(Stdio::piped()),
        )
        .expect("fixture");
        let stdout = child.stdout.take().expect("fixture");
        let (send, recv) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.expect("fixture").contains("PARKED") {
                    let _ = send.send(());
                    break;
                }
            }
        });
        let started = Instant::now();
        let parked = recv.recv_timeout(Duration::from_secs(15));
        assert!(
            k.store
                .try_lock_write(std::slice::from_ref(&k.kb))
                .expect("fixture")
                .is_none()
        );
        child.kill().expect("fixture");
        let output = child.wait_with_output().expect("fixture");
        reader.join().expect("fixture");
        assert!(
            parked.is_ok(),
            "failed to park at {stage:?} after {:?}: {}",
            started.elapsed(),
            String::from_utf8_lossy(&output.stderr)
        );
        let recovered = Store::open(k.store.paths().root()).expect("fixture");
        // Open may defer recovery if its nonblocking admission is busy.
        let record = recovered.read_kb(&k.kb).expect("read-only recovery gate");
        let published = matches!(
            stage,
            Stage::RefMoved | Stage::Finalizing | Stage::Finalized
        );
        let row = recovered
            .proposal(&k.kb, pr.number)
            .expect("fixture")
            .expect("fixture");
        assert_eq!(
            row.status,
            if published {
                PrStatus::Merged
            } else {
                PrStatus::Open
            }
        );
        assert_eq!(
            k.head(),
            if published {
                pr.head_sha.clone()
            } else {
                k.main.clone()
            }
        );
        assert_eq!(record.desired_epoch, if published { 2 } else { 1 });
        let intent = recovered
            .intents(&k.kb)
            .expect("fixture")
            .into_iter()
            .filter(|r| r.operation == "PR_MERGE")
            .collect::<Vec<_>>();
        assert_eq!(intent.len(), 1);
        assert_eq!(
            intent[0].phase,
            if published {
                Phase::Finalized
            } else {
                Phase::Aborted
            }
        );
        let retry = recovered.pull_requests_review(
            &recovered.owner(),
            k.review_input(&pr, "merge", "crash-merge-key1"),
        );
        if published {
            assert_eq!(
                retry.expect("fixture").pr.merge_commit_sha,
                Some(pr.head_sha)
            );
        } else {
            code(retry, ErrorCode::Conflict);
        }
        assert_eq!(
            recovered.read_kb(&k.kb).expect("fixture").desired_epoch,
            if published { 2 } else { 1 }
        );
    }
}

#[test]
fn fix_admission_all_pr_entries_timeout_without_releasing_predecessor() {
    let k = Kb::new("admission");
    let pr = k.propose(&k.principal(&[Permission::Propose]), "topic.md");
    let head = k.user_branch(
        &k.store.owner(),
        "user/admission",
        &[("other.md", b"other")],
    );
    for (role, req) in [
        ("list", json!({"kbId":k.kb})),
        ("get", json!({"kbId":k.kb,"number":pr.number})),
        (
            "create",
            serde_json::to_value(k.create_input("user/admission", &head, "admit-create-key"))
                .expect("fixture"),
        ),
        (
            "review",
            serde_json::to_value(k.review_input(&pr, "merge", "admit-merge-key1"))
                .expect("fixture"),
        ),
    ] {
        let mut child = PolicyChild::new(&k, role, req, None);
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        child.start();
        assert_eq!(
            child.wait("RESULT:", Duration::from_millis(6500)),
            "RESULT:DEADLINE_EXCEEDED",
            "{role}"
        );
        assert!(
            child.method_elapsed_ms() < 5500,
            "{role}: method admission budget"
        );
        assert!(
            k.store.try_lock_write(&[]).expect("fixture").is_none(),
            "timeout released predecessor"
        );
        drop(guard);
    }
    // The same total deadline also covers waiting on the second lock.
    let mut child = PolicyChild::new(&k, "list", json!({"kbId":k.kb}), None);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(k.store.paths().kb_lock_file(&k.kb))
        .expect("fixture");
    file.lock().expect("fixture");
    child.start();
    assert_eq!(
        child.wait("RESULT:", Duration::from_millis(6500)),
        "RESULT:DEADLINE_EXCEEDED"
    );
    assert!(child.method_elapsed_ms() < 5500);
    // Admission can be briefly busy with another test's spawn registry;
    // the store lock must still be obtainable while this KB lock is held.
    #[cfg(unix)]
    assert!(fixture::os_locks_available(k.store.paths().root(), &[]));
    drop(k.store.lock_write(&[]).expect("released store lock"));
    assert!(
        k.store
            .try_lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture")
            .is_none()
    );
    drop(file);
    assert_eq!(k.get(pr.number, None).pr.head_sha, pr.head_sha);
    assert_eq!(k.head(), k.main);
    assert_eq!(k.epoch(), 1);
}
fn divergent_fixture(tag: &str) -> (Kb, PullRequestsReviewInput) {
    let k = Kb::new(tag);
    let pr = k.propose(&k.principal(&[Permission::Propose]), "topic.md");
    k.edit(
        &k.store.owner(),
        &k.main,
        "planner-main-key",
        edit("create", "human.md", "human"),
    );
    let req = k.review_input(&k.get(pr.number, None).pr, "merge", "planner-merge-key");
    (k, req)
}
fn scratch_count(k: &Kb) -> usize {
    std::fs::read_dir(k.store.paths().uploads_dir())
        .expect("fixture")
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("publish-"))
        .count()
}
#[test]
fn fix_killed_preintent_planner_preserves_live_scratch_then_cleans_on_reopen() {
    let (k, req) = divergent_fixture("scratch-crash");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "commit-tree");
    let mut child = PolicyChild::new(
        &k,
        "review",
        serde_json::to_value(&req).expect("fixture"),
        Some(&wrapper.path),
    );
    child.start();
    wrapper.wait("mark");
    assert_eq!(scratch_count(&k), 1);
    assert!(
        !k.store
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .any(|i| i.operation == "PR_MERGE")
    );
    let upload = k.store.paths().uploads_dir().join("ordinary-upload");
    std::fs::create_dir(&upload).expect("fixture");
    std::fs::write(upload.join("keep"), b"upload").expect("fixture");
    let other = Store::open(k.store.paths().root()).expect("fixture");
    assert!(other.try_lock_write(&[]).expect("fixture").is_none());
    child.child.kill().expect("fixture");
    child.child.wait().expect("fixture");
    #[cfg(unix)]
    {
        assert!(wrapper.alive());
        assert!(other.try_lock_write(&[]).expect("fixture").is_none());
        assert_eq!(scratch_count(&k), 1, "live descendant scratch removed");
        std::fs::write(wrapper.bin.join("release"), b"go").expect("fixture");
        wrapper.wait("exited");
    }
    drop(child);
    let recovered = Store::open(k.store.paths().root()).expect("fixture");
    // Pre-intent scratch has no pending row to trigger a gated read.
    // Enter the recovery fence explicitly if startup deferred admission.
    drop(recovered.lock_write(&[]).expect("scratch recovery fence"));
    assert_eq!(scratch_count(&k), 0);
    assert_eq!(
        std::fs::read(upload.join("keep")).expect("fixture"),
        b"upload"
    );
    let out = recovered
        .pull_requests_review(&recovered.owner(), req.clone())
        .expect("fixture");
    assert_eq!(
        recovered
            .pull_requests_review(&recovered.owner(), req)
            .expect("fixture"),
        out
    );
    assert_eq!(recovered.read_kb(&k.kb).expect("fixture").desired_epoch, 3);
    assert_eq!(k.head(), out.pr.merge_commit_sha.expect("fixture"));
    assert_eq!(
        recovered
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .filter(|i| i.operation == "PR_MERGE")
            .count(),
        1
    );
}
#[test]
fn fix_operation_deadline_uses_one_budget_and_drains_planner_before_retry() {
    let (k, req) = divergent_fixture("operation-timeout");
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "commit-tree");
    let mut child = PolicyChild::new(
        &k,
        "review-reentry",
        serde_json::to_value(&req).expect("fixture"),
        Some(&wrapper.path),
    );
    child.start();
    wrapper.wait("mark");
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(33)),
        "RESULT:DEADLINE_EXCEEDED"
    );
    assert!(child.method_elapsed_ms() < 32_000);
    assert!(!wrapper.alive(), "deadline returned before Git drain");
    assert_eq!(scratch_count(&k), 0);
    assert_eq!(k.epoch(), 2);
    assert_eq!(k.head(), req.expected_target_sha);
    assert!(
        !k.store
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .any(|i| i.operation == "PR_MERGE")
    );
    std::fs::write(wrapper.bin.join("release"), b"go").expect("fixture");
    child.start();
    // Observe the method's own budget, excluding scheduling and reply delivery.
    // A 30s receive timeout races the method's permitted 30s execution window.
    let reply = child.wait("RETRY:", Duration::from_secs(33));
    let elapsed_ms: u128 = reply
        .strip_prefix("RETRY:OK:")
        .expect("retry must succeed")
        .parse()
        .expect("retry duration");
    assert!(elapsed_ms < 30_000, "retry exceeded the procedure budget");
    let out = k
        .store
        .pull_requests_review(&k.store.owner(), req.clone())
        .expect("fixture");
    assert_eq!(
        k.store
            .pull_requests_review(&k.store.owner(), req)
            .expect("fixture"),
        out
    );
    assert_eq!(k.epoch(), 3);
}
#[test]
fn fix_repair_gate_covers_pr_and_document_receipts_and_restored_active_replay() {
    let mut k = Kb::new("repair-replay");
    let writer = k.principal(&[Permission::Write]);
    let author = k.principal(&[Permission::Propose]);
    let reviewer = k.principal(&[Permission::Review]);
    let head = k.user_branch(&author, "user/repair", &[("topic.md", b"topic")]);
    let create = k.create_input("user/repair", &head, "repair-create-key");
    let created = k
        .store
        .pull_requests_create(&author, create.clone())
        .expect("fixture");
    let close = k.review_input(&created.pr, "close", "repair-close-key1");
    let closed = k
        .store
        .pull_requests_review(&author, close.clone())
        .expect("fixture");
    let proposed = k.propose(&author, "proposal.md");
    let merge = k.review_input(&proposed, "merge", "repair-merge-key1");
    let merged = k
        .store
        .pull_requests_review(&reviewer, merge.clone())
        .expect("fixture");
    k.main = k.head();
    let changes = input::<ChangesApply>(
        json!({"kbId":k.kb,"baseRevision":k.main,"mode":"edit", "title":"later",
        "changes":edit("create", "later.md", "later"), "sourceSessionIds":[],"idempotencyKey":"repair-change-key"}),
    );
    let applied = k
        .store
        .changes_apply(&writer, changes.clone())
        .expect("fixture");
    let doc = input::<DocumentsCreate>(json!({"kbId":k.kb,"baseRevision":applied.commit_sha,
        "path":"document.md","content":{"markdown":"doc"},"idempotencyKey":"repair-document-key"}));
    let document = k
        .store
        .documents_create(&writer, doc.clone())
        .expect("fixture");
    let update = input::<DocumentsUpdate>(json!({"kbId":k.kb,"baseRevision":document.commit_sha,
        "path":"document.md","content":{"markdown":"updated"},"idempotencyKey":"repair-doc-update"}));
    let updated = k
        .store
        .documents_update(&writer, update.clone())
        .expect("fixture");
    let delete = input::<DocumentsDelete>(json!({"kbId":k.kb,"baseRevision":updated.commit_sha,
        "path":"document.md","idempotencyKey":"repair-doc-delete","confirm":"DELETE"}));
    let deleted = k
        .store
        .documents_delete(&writer, delete.clone())
        .expect("fixture");
    let epoch = k.epoch();
    for compact in [false, true] {
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        if compact {
            k.store.compact_receipts(&guard).expect("fixture");
        }
        let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("fixture");
        db.execute(
            "UPDATE kbs SET state='REPAIR_REQUIRED' WHERE id=?1",
            [k.kb.as_str()],
        )
        .expect("fixture");
        drop(guard);
        code(
            k.store.pull_requests_create(&author, create.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.pull_requests_review(&author, close.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.pull_requests_review(&reviewer, merge.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.changes_apply(&writer, changes.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.documents_create(&writer, doc.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.documents_update(&writer, update.clone()),
            ErrorCode::RepairRequired,
        );
        code(
            k.store.documents_delete(&writer, delete.clone()),
            ErrorCode::RepairRequired,
        );
        let metadata_input = input::<BasesUpdate>(json!({
            "kbId":k.kb,"metadataVersion":if compact {2} else {1},
            "name":"repair management", "idempotencyKey":if compact {"repair-meta-key2"} else {"repair-meta-key1"}
        }));
        code(
            k.store
                .bases_update(&k.store.owner(), metadata_input.clone()),
            ErrorCode::RepairRequired,
        );
        assert_eq!(
            k.store
                .kb(&k.kb)
                .expect("fixture")
                .expect("fixture")
                .metadata_version,
            if compact { 2 } else { 1 }
        );
        assert_eq!(
            k.store.kb(&k.kb).expect("fixture").expect("fixture").state,
            kb_local::KbState::RepairRequired
        );
        let guard = k
            .store
            .lock_write(std::slice::from_ref(&k.kb))
            .expect("fixture");
        db.execute("UPDATE kbs SET state='ACTIVE' WHERE id=?1", [k.kb.as_str()])
            .expect("fixture");
        drop(guard);
        let metadata = k
            .store
            .bases_update(&k.store.owner(), metadata_input.clone())
            .expect("metadata update after repair");
        assert_eq!(metadata.kb.name, "repair management");
        assert_eq!(
            k.store
                .bases_update(&k.store.owner(), metadata_input)
                .expect("metadata replay"),
            metadata
        );
        assert_eq!(
            k.store
                .pull_requests_create(&author, create.clone())
                .expect("fixture"),
            created
        );
        assert_eq!(
            k.store
                .pull_requests_review(&author, close.clone())
                .expect("fixture"),
            closed
        );
        assert_eq!(
            k.store
                .pull_requests_review(&reviewer, merge.clone())
                .expect("fixture"),
            merged
        );
        assert_eq!(
            k.store
                .changes_apply(&writer, changes.clone())
                .expect("fixture"),
            applied
        );
        assert_eq!(
            k.store
                .documents_create(&writer, doc.clone())
                .expect("fixture"),
            document
        );
        assert_eq!(
            k.store
                .documents_update(&writer, update.clone())
                .expect("fixture"),
            updated
        );
        assert_eq!(
            k.store
                .documents_delete(&writer, delete.clone())
                .expect("fixture"),
            deleted
        );
        assert_eq!(k.epoch(), epoch);
    }
    k.permissions(&writer, &[Permission::Read]);
    code(
        k.store.changes_apply(&writer, changes),
        ErrorCode::Forbidden,
    );
    code(k.store.documents_create(&writer, doc), ErrorCode::Forbidden);
    code(
        k.store.documents_update(&writer, update),
        ErrorCode::Forbidden,
    );
    code(
        k.store.documents_delete(&writer, delete),
        ErrorCode::Forbidden,
    );
    k.permissions(&author, &[Permission::Read]);
    code(
        k.store.pull_requests_create(&author, create),
        ErrorCode::Forbidden,
    );
    code(
        k.store.pull_requests_review(&author, close),
        ErrorCode::Forbidden,
    );
    k.permissions(&reviewer, &[Permission::Read]);
    code(
        k.store.pull_requests_review(&reviewer, merge),
        ErrorCode::Forbidden,
    );
}

#[test]
fn fix_scratch_recovery_preserves_foreign_names_and_refuses_links() {
    let k = Kb::new("scratch-names");
    let uploads = k.store.paths().uploads_dir();
    let name = "publish-11111111-1111-4111-8111-111111111111";
    let owned = uploads.join(name);
    std::fs::create_dir(&owned).expect("fixture");
    std::fs::write(owned.join("f1"), b"scratch").expect("fixture");
    let ordinary = uploads.join("publish-not-a-uuid");
    std::fs::create_dir(&ordinary).expect("fixture");
    let recovered = Store::open(k.store.paths().root()).expect("fixture");
    drop(recovered.lock_write(&[]).expect("scratch recovery fence"));
    assert!(!owned.exists());
    assert!(ordinary.is_dir());
    #[cfg(unix)]
    {
        let sentinel = k.git.root.join("foreign");
        std::fs::create_dir(&sentinel).expect("fixture");
        std::fs::write(sentinel.join("keep"), b"foreign").expect("fixture");
        std::os::unix::fs::symlink(&sentinel, &owned).expect("fixture");
        code(recovered.lock_write(&[]), ErrorCode::RepairRequired);
        assert_eq!(
            std::fs::read(sentinel.join("keep")).expect("fixture"),
            b"foreign"
        );
        std::fs::remove_file(owned).expect("fixture");
        assert!(fixture::os_locks_available(recovered.paths().root(), &[]));
        drop(
            recovered
                .lock_write(&[])
                .expect("re-entry after link removal"),
        );
    }
}

#[test]
fn fix_timeout_after_reservation_recovers_abort_before_new_key_publication() {
    let (k, mut req) = divergent_fixture("reserved-timeout");
    let old = k.head();
    let wrapper = parked_git::ParkedGit::new(&k.git.root, "update-ref");
    let mut child = PolicyChild::new(
        &k,
        "review",
        serde_json::to_value(&req).expect("fixture"),
        Some(&wrapper.path),
    );
    child.start();
    wrapper.wait("mark");
    let intents = k.store.intents(&k.kb).expect("fixture");
    assert_eq!(
        intents
            .iter()
            .find(|i| i.operation == "PR_MERGE")
            .expect("fixture")
            .phase,
        Phase::Committing
    );
    assert_eq!(
        child.wait("RESULT:", Duration::from_secs(33)),
        "RESULT:DEADLINE_EXCEEDED"
    );
    assert!(!wrapper.alive());
    let recovered = Store::open(k.store.paths().root()).expect("fixture");
    assert_eq!(k.head(), old);
    assert_eq!(recovered.read_kb(&k.kb).expect("fixture").desired_epoch, 2);
    code(
        recovered.pull_requests_review(&recovered.owner(), req.clone()),
        ErrorCode::Conflict,
    );
    assert_eq!(
        recovered
            .intents(&k.kb)
            .expect("fixture")
            .iter()
            .find(|i| i.operation == "PR_MERGE")
            .expect("fixture")
            .phase,
        Phase::Aborted
    );
    req.idempotency_key = IdempotencyKey::parse("reserved-new-key").expect("fixture");
    let out = recovered
        .pull_requests_review(&recovered.owner(), req.clone())
        .expect("fixture");
    assert_eq!(
        recovered
            .pull_requests_review(&recovered.owner(), req)
            .expect("fixture"),
        out
    );
    assert_eq!(recovered.read_kb(&k.kb).expect("fixture").desired_epoch, 3);
}

#[test]
fn pr_mutations_share_durable_budget_and_exempt_replay() {
    // The local per-actor, per-KB write window.
    const FULL: usize = kb_local::limits::LOCAL_MUTATIONS_PER_MINUTE_PER_KB;
    let k = Kb::new("admit-pr-budget");
    k.store.set_cursor_clock_for_tests(2_000_000_000);
    let owner = k.store.owner();
    let head = k.user_branch(&owner, "user/budget", &[("budget.md", b"# Budget\n")]);
    let db = rusqlite::Connection::open(k.store.paths().state_db()).expect("db");
    let seed = |count| {
        db.execute("INSERT INTO mutation_windows(actor_key,kb_id,times_json) VALUES (?1,?2,?3) ON CONFLICT(actor_key,kb_id) DO UPDATE SET times_json=excluded.times_json",
            (owner.actor_key(), k.kb.as_str(),serde_json::to_string(&vec![2_000_000_000_000u64;count]).expect("encode"))).expect("seed durable window");
    };
    let charges = || {
        db.query_row("SELECT json_array_length(times_json) FROM mutation_windows WHERE actor_key=?1 AND kb_id=?2",
        (owner.actor_key(),k.kb.as_str()),|r|r.get::<_,i64>(0)).expect("charges")
    };
    seed(FULL - 1);
    let request = k.create_input("user/budget", &head, "admit-pr-create-0000");
    let created = k
        .store
        .pull_requests_create(&owner, request.clone())
        .expect("last mutation in the window");
    assert_eq!(charges(), FULL as i64);
    assert_eq!(
        k.store
            .pull_requests_create(&owner, request)
            .expect("PR replay at full window")
            .operation_id,
        created.operation_id
    );
    for decision in ["close", "merge"] {
        code(
            k.review(
                &owner,
                &created.pr,
                decision,
                &format!("admit-pr-{decision}-0000"),
            ),
            ErrorCode::RateLimited,
        );
        assert_eq!(k.head(), k.main);
        assert_eq!(k.get(created.pr.number, None).pr.status, PrStatus::Open);
    }
    seed(FULL - 1);
    let merged = k
        .review(&owner, &created.pr, "merge", "admit-pr-merge-0000")
        .expect("merge last slot");
    assert_eq!(charges(), FULL as i64);
    assert_eq!(
        k.review(&owner, &created.pr, "merge", "admit-pr-merge-0000")
            .expect("merge replay")
            .operation_id,
        merged.operation_id
    );
    assert_eq!(charges(), FULL as i64);
    // Closing a different PR also charges with its finalized receipt.
    k.store.advance_clock_for_tests(60);
    let proposer = k.principal(&[Permission::Propose]);
    let main = k.head();
    let proposal = k
        .edit(
            &proposer,
            &main,
            "admit-pr-propose-0000",
            edit("create", "close.md", "# Close\n"),
        )
        .proposal
        .expect("proposal");
    let closed = k
        .review(&owner, &proposal, "close", "admit-pr-close-final-0000")
        .expect("close fresh window");
    assert_eq!(charges(), 1);
    assert_eq!(
        k.review(&owner, &proposal, "close", "admit-pr-close-final-0000")
            .expect("close replay")
            .operation_id,
        closed.operation_id
    );
    assert_eq!(charges(), 1);
}
