//! Durable one-ref journal, publication and crash recovery, plus
//! the Git hardening carry-ins (grafts/shallow/local config, hung-Git kill).
//!
//! Kill tests re-execute this test binary in a child role (see
//! `child_role_entry`); the child parks at a publication stage and the
//! parent SIGKILLs it, then reopens the store as a fresh process would.

#[path = "support/fixture.rs"]
mod fixture;
#[path = "support/parked_git.rs"]
mod parked_git;

#[path = "support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use fixture::ChildGuard;
use fixture::child_guard;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use kb_client::ErrorCode;
use kb_client::types::{KbId, Permission, Sha};
use kb_local::git_read::{GitError, GitRepo};
use kb_local::{
    CommitRequest, CreateKbRequest, FileChange, KbState, Phase, PrincipalKind, Stage, Store,
    StoreError,
};

// ── Fixtures ────────────────────────────────────────────────────────────────

fn temp_base(tag: &str) -> TestDir {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "kb-local-publish-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).expect("base");
    TestDir::new(base)
}

fn create_req(slug: &str, key: &str) -> CreateKbRequest {
    CreateKbRequest {
        name: format!("KB {slug}"),
        slug: slug.to_owned(),
        description: "A local knowledge base for publication tests".to_owned(),
        idempotency_key: key.to_owned(),
    }
}

fn commit_req(kb: &KbId, base: &Sha, key: &str, body: &str) -> CommitRequest {
    CommitRequest {
        kb: kb.clone(),
        base_revision: base.clone(),
        idempotency_key: key.to_owned(),
        changes: vec![FileChange {
            path: "notes/a.md".to_owned(),
            content: Some(body.as_bytes().to_vec()),
        }],
    }
}

/// Plain (unhardened) Git against a store repository, for assertions and
/// for simulating external edits.
fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(repo)
        .arg("--git-dir")
        .arg(".")
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "External")
        .env("GIT_AUTHOR_EMAIL", "external@example.invalid")
        .env("GIT_COMMITTER_NAME", "External")
        .env("GIT_COMMITTER_EMAIL", "external@example.invalid")
        .stdin(Stdio::null())
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_owned()
}

fn main_ref(repo: &Path) -> String {
    git(repo, &["rev-parse", "refs/heads/main"])
}

fn commit_count(repo: &Path) -> usize {
    git(repo, &["rev-list", "--count", "refs/heads/main"])
        .parse()
        .expect("count")
}

fn sha(text: &str) -> Sha {
    Sha::parse(text).expect("sha")
}

/// A fresh store with one ACTIVE KB; returns (store, kb, head).
fn store_with_kb(root: &Path) -> (Store, KbId, Sha) {
    let store = Store::open(root).expect("open");
    let receipt = store
        .create_kb(&store.owner(), create_req("alpha", "create-key-0000001"))
        .expect("create kb");
    let kb = receipt.kb_id.clone();
    (store, kb, receipt.commit_sha)
}

// ── Child roles ─────────────────────────────────────────────────────────────

const ROLE_ENV: &str = "KB_LOCAL_PUBLISH_ROLE";
const ROOT_ENV: &str = "KB_LOCAL_PUBLISH_ROOT";
const ARG_ENV: &str = "KB_LOCAL_PUBLISH_ARG";

// Close-only release of an inherited lock must also wait for unrelated fork
// copies to reach CLOEXEC. Immediate drain probes run without other libtest
// threads spawning children; their assertions and native lock boundary stay
// unchanged. This isolates the fixture, not the production locking mechanism.
fn run_in_isolated_process(test: &str) -> bool {
    const ISOLATED_ENV: &str = "KB_LOCAL_PUBLISH_ISOLATED_TEST";
    if std::env::var(ISOLATED_ENV).as_deref() == Ok(test) {
        return false;
    }
    let output = Command::new(std::env::current_exe().expect("test binary"))
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env(ISOLATED_ENV, test)
        .output()
        .expect("isolated lock probe");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("running 1 test"),
        "{test}: {stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "\n{line}").expect("stdout");
    out.flush().expect("stdout");
}

fn park_forever() -> ! {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::process::exit(9);
}

fn stage_named(name: &str) -> Stage {
    match name {
        "reserving" => Stage::Reserving,
        "prepared" => Stage::Prepared,
        "committing" => Stage::Committing,
        "ref-moved" => Stage::RefMoved,
        "finalizing" => Stage::Finalizing,
        "finalized" => Stage::Finalized,
        other => panic!("unknown stage {other}"),
    }
}

/// The store lock is free at the OS level. Nonblocking admission may also
/// report busy while another thread's spawn holds the shared registry
/// so an immediate `try_lock_write` cannot prove release.
fn store_lock_free(store: &Store) -> bool {
    #[cfg(unix)]
    {
        fixture::os_locks_available(store.paths().root(), &[])
    }
    #[cfg(windows)]
    {
        // Bounded blocking admission: a retained lock fails with a deadline.
        store.lock_write(&[]).map(drop).is_ok()
    }
}

/// The store lock is held by someone, judged by the OS lock itself, never by
/// a registry-busy `None`.
fn store_lock_held(store: &Store) -> bool {
    #[cfg(unix)]
    {
        !fixture::os_locks_available(store.paths().root(), &[])
    }
    #[cfg(windows)]
    {
        store.try_lock_write(&[]).expect("lock probe").is_none()
    }
}

#[test]
fn child_role_entry() {
    let Ok(role) = std::env::var(ROLE_ENV) else {
        return;
    };
    let root = PathBuf::from(std::env::var(ROOT_ENV).expect("root"));
    if role == "unwind-probe" {
        child_guard::unwind_probe_role(&root);
    }
    let arg = std::env::var(ARG_ENV).unwrap_or_default();
    match role.as_str() {
        // arg = "<stage> <kb> <base> <key>"
        "commit-kill" => {
            let parts: Vec<&str> = arg.split(' ').collect();
            let target = stage_named(parts[0]);
            let store = Store::open(&root).expect("open");
            let kb = KbId::parse(parts[1]).expect("kb");
            let request = commit_req(&kb, &sha(parts[2]), parts[3], "killed body\n");
            let _ = store.commit_files_observed(&store.owner(), request, &mut |stage| {
                if stage == target {
                    say("AT");
                    park_forever();
                }
                Ok(())
            });
            say("NEVER");
            park_forever();
        }
        // arg = "<stage> <key>"
        "create-kill" => {
            let parts: Vec<&str> = arg.split(' ').collect();
            let target = stage_named(parts[0]);
            let store = Store::open(&root).expect("open");
            let _ = store.create_kb_observed(
                &store.owner(),
                create_req("beta", parts[1]),
                &mut |stage| {
                    if stage == target {
                        say("AT");
                        park_forever();
                    }
                    Ok(())
                },
            );
            say("NEVER");
            park_forever();
        }
        // arg = "<kb> <base> <key> <body>" — race on one base.
        "commit-race" => {
            let parts: Vec<&str> = arg.splitn(4, ' ').collect();
            let store = Store::open(&root).expect("open");
            let kb = KbId::parse(parts[0]).expect("kb");
            let request = commit_req(&kb, &sha(parts[1]), parts[2], parts[3]);
            match store.commit_files(&store.owner(), request) {
                Ok(receipt) => say(&format!("OK {}", receipt.commit_sha)),
                Err(error) => say(&format!("ERR {:?}", error.protocol_code())),
            }
        }
        // arg = "<repo>" — PATH points at a hanging fake `git`.
        "hung-git" | "locked-hung-git" => {
            let store = if role == "locked-hung-git" {
                Some(Store::open(&root).unwrap())
            } else {
                None
            };
            let _guard = store.as_ref().map(|s| s.lock_write(&[]).unwrap());
            let repo = GitRepo::open(Path::new(&arg))
                .expect("repo")
                .with_timeout(Duration::from_millis(300));
            let started = Instant::now();
            let result = repo.branch_tips();
            let elapsed = started.elapsed().as_millis();
            match result {
                Err(GitError::Timeout) => say(&format!("TIMEOUT {elapsed}")),
                other => say(&format!("UNEXPECTED {other:?}")),
            }
        }
        "history-budget" => {
            let parts: Vec<_> = arg.split(' ').collect();
            let repo = GitRepo::open(Path::new(parts[0])).unwrap();
            let result = kb_local::tree::validate_newly_reachable(
                &repo,
                None,
                &sha(parts[1]),
                &kb_local::tree::EmptyAssetsNoSealed,
            );
            assert!(
                matches!(result, Err(kb_local::tree::TreeError::Invalid(ref v)) if v.code == kb_local::tree::TreeCode::Budget),
                "{result:?}"
            );
            say("BUDGET_OK");
        }
        "batch-outcome" => {
            let parts: Vec<_> = arg.split(' ').collect();
            let repo = GitRepo::open(Path::new(parts[0]))
                .unwrap()
                .with_timeout(Duration::from_millis(300));
            let mut reader = repo.object_reader().unwrap();
            if parts[2] == "batch-write-failure" {
                reader
                    .read_checked(parts[1], 10, &mut |_, _| Ok(()))
                    .unwrap();
                std::thread::sleep(Duration::from_millis(500));
            }
            let error = reader
                .read_checked(parts[1], 10, &mut |_, _| Ok(()))
                .unwrap_err();
            if parts[2] == "batch-malformed" {
                assert!(matches!(error, GitError::Failed(_)), "{error:?}");
                assert_eq!(
                    kb_local::git_read::SourceError::from(error).protocol_code(),
                    ErrorCode::StorageUnavailable
                );
            } else {
                assert!(matches!(error, GitError::Timeout), "{error:?}");
                assert_eq!(
                    kb_local::git_read::SourceError::from(error).protocol_code(),
                    ErrorCode::DeadlineExceeded
                );
            }
            assert!(
                reader
                    .read_checked(parts[1], 10, &mut |_, _| Ok(()))
                    .is_err()
            );
            say("OUTCOME_OK");
        }
        "managed-batch" => {
            let parts: Vec<_> = arg.split(' ').collect();
            let store = Store::open(&root).unwrap();
            let kb = KbId::parse(parts[0]).unwrap();
            let repo = if parts[2] == "raw" {
                GitRepo::open(&store.paths().repo_dir(&kb)).unwrap()
            } else {
                GitRepo::for_kb(store.paths(), &kb).unwrap()
            };
            let mut reader = repo.object_reader().unwrap();
            assert_eq!(
                reader.read_commit(&sha(parts[1])).unwrap().sha,
                sha(parts[1])
            );
            say("READY");
            park_forever();
        }
        "managed-spawn-failure" => {
            let store = Store::open(&root).unwrap();
            let kb = KbId::parse(&arg).unwrap();
            let repo = GitRepo::for_kb(store.paths(), &kb).unwrap();
            assert!(matches!(repo.branch_tips(), Err(GitError::Io(_))));
            assert!(store_lock_free(&store));
            say("SPAWN_FAILED");
        }
        "managed-read" => {
            let parts: Vec<_> = arg.split(' ').collect();
            let store = Store::open(&root).unwrap();
            let kb = KbId::parse(parts[0]).unwrap();
            match parts[2] {
                "main" => {
                    store.read_kb(&kb).unwrap();
                }
                "get" => {
                    store
                        .documents_get(
                            &store.owner(),
                            serde_json::from_value(
                                serde_json::json!({"kbId": kb, "path": "index.md"}),
                            )
                            .unwrap(),
                        )
                        .unwrap();
                }
                "list" => {
                    store
                        .documents_list(
                            &store.owner(),
                            serde_json::from_value(serde_json::json!({"kbId": kb})).unwrap(),
                        )
                        .unwrap();
                }
                _ => panic!("unknown read"),
            }
            say("READ_OK");
        }
        "locked-read" => {
            let parts: Vec<_> = arg.split(' ').collect();
            let store = Store::open(&root).expect("open");
            let guard = store.lock_write(&[]).expect("lock");
            // Open the repo independently: every locked spawn must inherit,
            // not merely readers explicitly constructed by a writer.
            let dir = store.paths().repo_dir(&KbId::parse(parts[0]).unwrap());
            let repo = if parts[2] == "thread" {
                std::env::set_current_dir(&root).unwrap();
                GitRepo::open(&Path::new("repos").join(dir.file_name().unwrap())).unwrap()
            } else {
                GitRepo::open(&dir).unwrap()
            };
            if parts[2] == "thread" {
                let head = sha(parts[1]);
                std::thread::spawn(move || {
                    let mut reader = repo.object_reader().unwrap();
                    assert_eq!(reader.read_commit(&head).unwrap().sha, head);
                })
                .join()
                .unwrap();
                say("READ_OK");
                return;
            }
            if parts[2] == "released" {
                let mut reader = repo.object_reader().unwrap();
                drop(guard);
                assert_eq!(
                    reader.read_commit(&sha(parts[1])).unwrap().sha,
                    sha(parts[1])
                );
                say("READ_OK");
                return;
            }
            if parts[2] == "cat-file" {
                let mut reader = repo.object_reader().unwrap();
                assert_eq!(
                    reader.read_commit(&sha(parts[1])).unwrap().sha,
                    sha(parts[1])
                );
            } else {
                assert_eq!(repo.branch_tips().unwrap(), vec![sha(parts[1])]);
            }
            say("READ_OK");
        }
        "nested-read" => {
            let parts: Vec<_> = arg.split(' ').collect();
            let outer = Store::open(&root).unwrap();
            let inner = Store::open(&root.join("uploads/inner")).unwrap();
            // Independent repo opened before acquisition; the spawn boundary
            // must select its store even when an ancestor is also registered.
            let repo =
                GitRepo::open(&inner.paths().repo_dir(&KbId::parse(parts[0]).unwrap())).unwrap();
            let (outer_guard, inner_guard) = match parts[2] {
                "outer-first" | "case-alias" => {
                    let outer_guard = outer.lock_write(&[]).unwrap();
                    (outer_guard, Some(inner.lock_write(&[]).unwrap()))
                }
                "inner-first" => {
                    let inner_guard = inner.lock_write(&[]).unwrap();
                    (outer.lock_write(&[]).unwrap(), Some(inner_guard))
                }
                "outer-only" => (outer.lock_write(&[]).unwrap(), None),
                mode => panic!("unknown nested mode {mode}"),
            };
            let mut reader = repo.object_reader().unwrap();
            drop(inner_guard);
            drop(outer_guard);
            assert_eq!(
                reader.read_commit(&sha(parts[1])).unwrap().sha,
                sha(parts[1])
            );
            say("READ_OK");
        }
        other => panic!("unknown role {other}"),
    }
}

fn spawn_role(role: &str, root: &Path, arg: &str, path_env: Option<&str>) -> ChildGuard {
    let mut command = Command::new(std::env::current_exe().expect("exe"));
    command
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, role)
        .env(ROOT_ENV, root)
        .env(ARG_ENV, arg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(path) = path_env {
        command.env("PATH", path);
    }
    ChildGuard::spawn(&command).expect("spawn child")
}

fn wait_for_line(child: &mut ChildGuard, prefix: &str) -> String {
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).expect("read");
        assert!(n > 0, "child exited before printing `{prefix}`");
        let text = line.trim_end();
        assert_ne!(text, "NEVER", "child passed its kill point");
        if let Some(rest) = text.strip_prefix(prefix) {
            return rest.trim().to_owned();
        }
    }
}

fn kill_at(child: &mut ChildGuard) {
    wait_for_line(child, "AT");
    child.kill().expect("kill");
    child.wait().expect("reap");
}

// ── Kill points: direct commit ──────────────────────────────────────────────

/// Kill a committing child at `stage`, reopen (read-only restart), and
/// return (store, kb, base, repo path, key).
fn killed_commit(base: &Path, tag: &str, stage: &str) -> (Store, KbId, Sha, PathBuf, String) {
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    drop(store);
    let key = format!("commit-key-{tag}-0001");
    let mut child = spawn_role(
        "commit-kill",
        &root,
        &format!("{stage} {kb} {head} {key}"),
        None,
    );
    kill_at(&mut child);
    let store = Store::open(&root).expect("reopen");
    (store, kb, head, repo, key)
}

fn assert_aborted_once(store: &Store, kb: &KbId, head: &Sha, repo: &Path, key: &str) {
    // Read-only restart: no write happened, yet the intent is resolved.
    let record = store.read_kb(kb).expect("gated read");
    assert_eq!(record.state, KbState::Active);
    assert_eq!(record.head_sha.as_deref(), Some(head.as_str()));
    assert_eq!(main_ref(repo), head.as_str(), "ref never moved");
    let intents = store.intents(kb).expect("intents");
    let row = intents
        .iter()
        .find(|row| row.idempotency_key == key)
        .expect("journal row");
    assert_eq!(row.phase, Phase::Aborted);
    // Stable receipt: the same key keeps failing; a new key is a new op.
    for _ in 0..2 {
        let err = store
            .commit_files(&store.owner(), commit_req(kb, head, key, "killed body\n"))
            .expect_err("aborted receipt is stable");
        assert!(matches!(err, StoreError::OperationAborted(_)), "{err:?}");
    }
    assert_eq!(main_ref(repo), head.as_str());
    let fresh = store
        .commit_files(
            &store.owner(),
            commit_req(kb, head, "commit-key-fresh-0001", "killed body\n"),
        )
        .expect("new key publishes");
    assert_eq!(main_ref(repo), fresh.commit_sha.as_str());
    assert_eq!(commit_count(repo), 2);
}

fn assert_finalized_once(store: &Store, kb: &KbId, head: &Sha, repo: &Path, key: &str) {
    let record = store.read_kb(kb).expect("gated read");
    let moved = main_ref(repo);
    assert_ne!(moved, head.as_str());
    assert_eq!(record.head_sha.as_deref(), Some(moved.as_str()));
    assert_eq!(record.state, KbState::Active);
    assert_eq!(
        record.desired_epoch, 2,
        "one metadata effect (create + commit)"
    );
    let intents = store.intents(kb).expect("intents");
    let row = intents
        .iter()
        .find(|row| row.idempotency_key == key)
        .expect("journal row");
    assert_eq!(row.phase, Phase::Finalized);
    assert_eq!(
        row.intended_new.as_ref().map(Sha::as_str),
        Some(moved.as_str())
    );
    // Retry returns the stable receipt, never a second commit.
    for _ in 0..2 {
        let receipt = store
            .commit_files(&store.owner(), commit_req(kb, head, key, "killed body\n"))
            .expect("replay");
        assert_eq!(receipt.commit_sha.as_str(), moved);
        assert_eq!(receipt.op_id, row.op_id);
    }
    assert_eq!(commit_count(repo), 2, "exactly one logical ref effect");
    assert_eq!(store.read_kb(kb).expect("read").desired_epoch, 2);
}

#[test]
fn kill_at_prepared_aborts_with_stable_receipt() {
    let base = temp_base("prep");
    let (store, kb, head, repo, key) = killed_commit(&base, "prep", "prepared");
    assert_aborted_once(&store, &kb, &head, &repo, &key);
}

#[test]
fn kill_at_committing_before_ref_move_aborts() {
    let base = temp_base("cmt");
    let (store, kb, head, repo, key) = killed_commit(&base, "cmt", "committing");
    assert_aborted_once(&store, &kb, &head, &repo, &key);
}

#[test]
fn kill_after_ref_move_finalizes_once_on_read_only_restart() {
    let base = temp_base("moved");
    let (store, kb, head, repo, key) = killed_commit(&base, "moved", "ref-moved");
    assert_finalized_once(&store, &kb, &head, &repo, &key);
}

#[test]
fn kill_inside_finalize_transaction_finalizes_once() {
    let base = temp_base("fin");
    let (store, kb, head, repo, key) = killed_commit(&base, "fin", "finalizing");
    assert_finalized_once(&store, &kb, &head, &repo, &key);
}

#[test]
fn kill_before_reply_keeps_one_effect_and_stable_receipt() {
    let base = temp_base("reply");
    let (store, kb, head, repo, key) = killed_commit(&base, "reply", "finalized");
    assert_finalized_once(&store, &kb, &head, &repo, &key);
}

#[test]
fn third_sha_after_crash_is_repair_required_without_reset() {
    let base = temp_base("third");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    drop(store);
    let key = "commit-key-third-0001";
    let mut child = spawn_role(
        "commit-kill",
        &root,
        &format!("ref-moved {kb} {head} {key}"),
        None,
    );
    kill_at(&mut child);
    // Someone moves the ref to a third commit before recovery runs.
    let tree = git(&repo, &["rev-parse", &format!("{head}^{{tree}}")]);
    let third = git(
        &repo,
        &["commit-tree", &tree, "-p", head.as_str(), "-m", "external"],
    );
    git(&repo, &["update-ref", "refs/heads/main", &third]);

    let store = Store::open(&root).expect("reopen");
    let err = store.read_kb(&kb).expect_err("repair state");
    assert_eq!(err.protocol_code(), ErrorCode::RepairRequired);
    assert_eq!(main_ref(&repo), third, "no blind reset or adopt");
    assert_eq!(
        store.kb(&kb).expect("row").expect("kb").state,
        KbState::RepairRequired
    );
    assert_eq!(
        store.kb(&kb).expect("row").expect("kb").head_sha.as_deref(),
        Some(head.as_str()),
        "the third SHA is never adopted"
    );
    let row = store
        .intents(&kb)
        .expect("intents")
        .into_iter()
        .find(|row| row.idempotency_key == key)
        .expect("row");
    assert_ne!(row.phase, Phase::Finalized);
    let err = store
        .commit_files(
            &store.owner(),
            commit_req(&kb, &head, "commit-key-after-0001", "x\n"),
        )
        .expect_err("writes refused");
    assert_eq!(err.protocol_code(), ErrorCode::RepairRequired);
    assert_eq!(main_ref(&repo), third);
}

// ── Kill points: KB_CREATE ──────────────────────────────────────────────────

fn killed_create(base: &Path, tag: &str, stage: &str) -> (Store, String) {
    let root = base.join("store");
    drop(Store::open(&root).expect("init"));
    let key = format!("create-key-{tag}-0001");
    let mut child = spawn_role("create-kill", &root, &format!("{stage} {key}"), None);
    kill_at(&mut child);
    (Store::open(&root).expect("reopen"), key)
}

#[test]
fn create_killed_before_publication_is_tombstoned_and_not_reallocated() {
    for stage in ["prepared", "committing"] {
        let tag = format!("cprep-{stage}");
        let base = temp_base(&tag);
        let (store, key) = killed_create(&base, &tag, stage);
        let kbs = store.list_kbs().expect("list");
        assert_eq!(kbs.len(), 1, "{stage}");
        // Startup admission may be busy; the read gate must recover the
        // unpublished create before reporting it as absent.
        assert_eq!(
            store
                .read_kb(&kbs[0].id)
                .expect_err("unpublished KB")
                .protocol_code(),
            ErrorCode::NotFound,
            "{stage}"
        );
        let kbs = store.list_kbs().expect("recovered list");
        assert_eq!(kbs[0].state, KbState::Tombstoned, "{stage}");
        for _ in 0..2 {
            let err = store
                .create_kb(&store.owner(), create_req("beta", &key))
                .expect_err("stable aborted receipt");
            assert!(matches!(err, StoreError::OperationAborted(_)), "{err:?}");
        }
        assert_eq!(store.list_kbs().expect("list").len(), 1, "no second id");
    }
}

#[test]
fn create_killed_after_publication_finalizes_once() {
    for stage in ["ref-moved", "finalizing", "finalized"] {
        let tag = format!("cfin-{stage}");
        let base = temp_base(&tag);
        let (store, key) = killed_create(&base, &tag, stage);
        let kbs = store.list_kbs().expect("list");
        assert_eq!(kbs.len(), 1, "{stage}");
        let kb = kbs[0].id.clone();
        let record = store.read_kb(&kb).expect("gated read");
        assert_eq!(record.state, KbState::Active, "{stage}");
        let repo = store.paths().repo_dir(&kb);
        assert_eq!(record.head_sha.as_deref(), Some(main_ref(&repo).as_str()));
        assert_eq!(commit_count(&repo), 1);
        let receipt = store
            .create_kb(&store.owner(), create_req("beta", &key))
            .expect("replay finds the reserved kb");
        assert_eq!(receipt.kb_id, kb, "{stage}");
        assert_eq!(store.list_kbs().expect("list").len(), 1, "no second id");
    }
}

// ── Concurrency and actor isolation ─────────────────────────────────────────

#[test]
fn two_processes_on_one_base_yield_one_commit() {
    let base = temp_base("race");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    drop(store);
    let children: Vec<ChildGuard> = (0..2)
        .map(|i| {
            spawn_role(
                "commit-race",
                &root,
                &format!("{kb} {head} race-key-000000{i} body {i}\n"),
                None,
            )
        })
        .collect();
    // Drain every concurrently spawned child before a result assertion can panic.
    let outputs: Vec<_> = children
        .into_iter()
        .map(ChildGuard::wait_with_output)
        .collect();
    let mut ok = Vec::new();
    let mut conflicts = 0;
    let mut outcomes = Vec::new();
    for output in outputs {
        let output = output.expect("wait");
        assert!(output.status.success(), "{output:?}");
        outcomes.push(format!("{output:?}"));
        for line in String::from_utf8(output.stdout).expect("utf8").lines() {
            if let Some(sha) = line.strip_prefix("OK ") {
                ok.push(sha.to_owned());
            }
            if line == "ERR Conflict" {
                conflicts += 1;
            }
        }
    }
    assert_eq!(ok.len(), 1, "exactly one winner: {outcomes:?}");
    assert_eq!(conflicts, 1, "the loser sees CONFLICT: {outcomes:?}");
    assert_eq!(main_ref(&repo), ok[0]);
    assert_eq!(commit_count(&repo), 2);
}

#[test]
fn different_actors_with_the_same_key_do_not_collide() {
    let base = temp_base("actors");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let guard = store.lock_write(&[]).expect("lock");
    let writer = store
        .register_principal(&guard, PrincipalKind::Test, &kb, &[Permission::Write])
        .expect("principal");
    drop(guard);
    let key = "shared-key-00000001";
    let first = store
        .commit_files(&store.owner(), commit_req(&kb, &head, key, "owner\n"))
        .expect("owner commit");
    let second = store
        .commit_files(&writer, commit_req(&kb, &first.commit_sha, key, "writer\n"))
        .expect("different actor, same key, is a new operation");
    assert_ne!(first.op_id, second.op_id);
    assert_ne!(first.commit_sha, second.commit_sha);
    // Each actor's replay returns its own receipt.
    let replay = store
        .commit_files(&store.owner(), commit_req(&kb, &head, key, "owner\n"))
        .expect("owner replay");
    assert_eq!(replay.commit_sha, first.commit_sha);
    let replay = store
        .commit_files(&writer, commit_req(&kb, &first.commit_sha, key, "writer\n"))
        .expect("writer replay");
    assert_eq!(replay.commit_sha, second.commit_sha);
    // Same actor, same key, different request -> mismatch.
    let err = store
        .commit_files(&store.owner(), commit_req(&kb, &head, key, "other\n"))
        .expect_err("mismatch");
    assert_eq!(err.protocol_code(), ErrorCode::IdempotencyMismatch);
    // KB_CREATE: the same actor+key never allocates a second KB.
    let again = store
        .create_kb(&store.owner(), create_req("alpha", "create-key-0000001"))
        .expect("create replay");
    assert_eq!(again.kb_id, kb);
    let err = store
        .create_kb(&store.owner(), create_req("gamma", "create-key-0000001"))
        .expect_err("create mismatch");
    assert_eq!(err.protocol_code(), ErrorCode::IdempotencyMismatch);
    // A narrowed principal cannot create KBs.
    let err = store
        .create_kb(&writer, create_req("delta", "create-key-0000002"))
        .expect_err("owner only");
    assert_eq!(err.protocol_code(), ErrorCode::Forbidden);
}

#[test]
fn compacted_receipts_keep_mismatch_detection_and_replay_needs_current_authority() {
    let base = temp_base("compact");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let guard = store.lock_write(&[]).expect("lock");
    let writer = store
        .register_principal(&guard, PrincipalKind::Test, &kb, &[Permission::Write])
        .expect("principal");
    drop(guard);
    let key = "compact-key-0000001";
    let done = store
        .commit_files(&writer, commit_req(&kb, &head, key, "body\n"))
        .expect("commit");
    let guard = store.lock_write(&[]).expect("lock");
    assert!(store.compact_receipts(&guard).expect("compact") >= 1);
    drop(guard);
    assert!(
        store
            .intents(&kb)
            .expect("rows")
            .iter()
            .all(|r| r.compacted)
    );
    let err = store
        .commit_files(&writer, commit_req(&kb, &head, key, "changed\n"))
        .expect_err("mismatch survives compaction");
    assert_eq!(err.protocol_code(), ErrorCode::IdempotencyMismatch);
    let replay = store
        .commit_files(&writer, commit_req(&kb, &head, key, "body\n"))
        .expect("replay after compaction");
    assert_eq!(replay.commit_sha, done.commit_sha);
    // Authority narrowed to read: the private replay is refused.
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &writer, &kb, &[Permission::Read])
        .expect("narrow");
    drop(guard);
    let err = store
        .commit_files(&writer, commit_req(&kb, &head, key, "body\n"))
        .expect_err("needs current write");
    assert_eq!(err.protocol_code(), ErrorCode::Forbidden);
    let guard = store.lock_write(&[]).expect("lock");
    store
        .set_principal_permissions(&guard, &writer, &kb, &[])
        .expect("revoke");
    drop(guard);
    let err = store
        .commit_files(&writer, commit_req(&kb, &head, key, "body\n"))
        .expect_err("no read");
    assert_eq!(err.protocol_code(), ErrorCode::NotFound);
}

// ── Failure injection ───────────────────────────────────────────────────────

#[test]
fn failed_object_fsync_never_reports_success() {
    let base = temp_base("fsync");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    let key = "fsync-key-00000001";
    let result = store.commit_files_observed(
        &store.owner(),
        commit_req(&kb, &head, key, "body\n"),
        &mut |stage| {
            if stage == Stage::SyncObjects {
                return Err(StoreError::StorageUnavailable(
                    "injected fsync failure".into(),
                ));
            }
            Ok(())
        },
    );
    let err = result.expect_err("no success");
    assert_eq!(err.protocol_code(), ErrorCode::StorageUnavailable);
    assert_eq!(main_ref(&repo), head.as_str());
    let record = store.read_kb(&kb).expect("read");
    assert_eq!(record.head_sha.as_deref(), Some(head.as_str()));
    let row = store
        .intents(&kb)
        .expect("rows")
        .into_iter()
        .find(|r| r.idempotency_key == key)
        .expect("row");
    assert_eq!(row.phase, Phase::Aborted);
    let err = store
        .commit_files(&store.owner(), commit_req(&kb, &head, key, "body\n"))
        .expect_err("stable failure");
    assert!(matches!(err, StoreError::OperationAborted(_)));
}

#[test]
fn failed_finalize_never_reports_success_and_recovers_once() {
    let base = temp_base("finalize");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    let key = "final-key-00000001";
    let result = store.commit_files_observed(
        &store.owner(),
        commit_req(&kb, &head, key, "body\n"),
        &mut |stage| {
            if stage == Stage::Finalizing {
                return Err(StoreError::StorageUnavailable("injected disk full".into()));
            }
            Ok(())
        },
    );
    assert!(result.is_err(), "finalize failure must not report success");
    let moved = main_ref(&repo);
    assert_ne!(moved, head.as_str(), "ref moved before finalize");
    // The durable row still says COMMITTING until recovery runs.
    let row = store
        .intents(&kb)
        .expect("rows")
        .into_iter()
        .find(|r| r.idempotency_key == key)
        .expect("row");
    assert_eq!(row.phase, Phase::Committing);
    // A read gates on recovery and finalizes exactly once.
    let record = store.read_kb(&kb).expect("gated read");
    assert_eq!(record.head_sha.as_deref(), Some(moved.as_str()));
    let receipt = store
        .commit_files(&store.owner(), commit_req(&kb, &head, key, "body\n"))
        .expect("replay");
    assert_eq!(receipt.commit_sha.as_str(), moved);
    assert_eq!(commit_count(&repo), 2);
    assert_eq!(store.read_kb(&kb).expect("read").desired_epoch, 2);
}

#[test]
fn external_ref_change_produces_repair_state() {
    let base = temp_base("external");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    let tree = git(&repo, &["rev-parse", &format!("{head}^{{tree}}")]);
    let external = git(
        &repo,
        &["commit-tree", &tree, "-p", head.as_str(), "-m", "edit"],
    );
    git(&repo, &["update-ref", "refs/heads/main", &external]);
    let err = store
        .commit_files(
            &store.owner(),
            commit_req(&kb, &head, "ext-key-000000001", "x\n"),
        )
        .expect_err("repair");
    assert_eq!(err.protocol_code(), ErrorCode::RepairRequired);
    assert_eq!(main_ref(&repo), external, "never reset");
    drop(store);
    let store = Store::open(&root).expect("reopen");
    assert_eq!(
        store.read_kb(&kb).expect_err("repair").protocol_code(),
        ErrorCode::RepairRequired
    );
    assert_eq!(
        store.kb(&kb).expect("row").expect("kb").state,
        KbState::RepairRequired
    );
}

#[test]
fn published_commit_is_validated_and_rejected_trees_publish_nothing() {
    let base = temp_base("validate");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    // Initial tree: index.md, managed .gitignore, empty manifest.
    let listing = git(&repo, &["ls-tree", "-r", "--name-only", "refs/heads/main"]);
    assert_eq!(listing, ".assets/manifest.json\n.gitignore\nindex.md");
    let request = CommitRequest {
        kb: kb.clone(),
        base_revision: head.clone(),
        idempotency_key: "invalid-key-0000001".to_owned(),
        changes: vec![FileChange {
            path: "script.sh".to_owned(),
            content: Some(b"echo hi\n".to_vec()),
        }],
    };
    let err = store
        .commit_files(&store.owner(), request)
        .expect_err("non-markdown file");
    assert_eq!(err.protocol_code(), ErrorCode::InvalidArgument);
    assert_eq!(main_ref(&repo), head.as_str());
    // A stale base is a CONFLICT and publishes nothing.
    let done = store
        .commit_files(
            &store.owner(),
            commit_req(&kb, &head, "valid-key-00000001", "ok\n"),
        )
        .expect("valid");
    let err = store
        .commit_files(
            &store.owner(),
            commit_req(&kb, &head, "stale-key-00000001", "late\n"),
        )
        .expect_err("stale base");
    assert_eq!(err.protocol_code(), ErrorCode::Conflict);
    assert_eq!(main_ref(&repo), done.commit_sha.as_str());
    // Commit identity: server committer + op/actor trailers.
    let body = git(&repo, &["cat-file", "commit", done.commit_sha.as_str()]);
    assert!(
        body.contains(&format!("Kb-Operation-Id: {}", done.op_id)),
        "{body}"
    );
    assert!(body.contains(&format!("Kb-Actor: {}", store.owner().actor_key())));
    // Refs of the managed repo stay one branch; HEAD names main.
    assert_eq!(git(&repo, &["symbolic-ref", "HEAD"]), "refs/heads/main");
}

// ── Git hardening carry-ins (52a) ───────────────────────────────────────────

fn two_commit_fixture(tag: &str) -> (fixture::Fixture, String, String) {
    let fx = fixture::Fixture::new(tag);
    let files = fixture::with_required(&[]);
    let c1 = fx.commit_files(&files, &[]);
    let c2 = fx.commit_files(&fixture::with_required(&[("b.md", b"b\n")]), &[&c1]);
    (fx, c1, c2)
}

#[test]
fn repository_grafts_file_is_ignored() {
    let (fx, _c1, c2) = two_commit_fixture("grafts");
    std::fs::create_dir_all(fx.repo.join("info")).expect("info");
    std::fs::write(fx.repo.join("info/grafts"), format!("{c2}\n")).expect("grafts");
    let repo = GitRepo::open(&fx.repo).expect("repo");
    let commits = repo.commits_between(None, &sha(&c2), 10).expect("walk");
    assert_eq!(commits.len(), 2, "grafted-away parent must still be seen");
}

#[test]
fn repository_shallow_file_is_ignored() {
    let (fx, _c1, c2) = two_commit_fixture("shallow");
    std::fs::write(fx.repo.join("shallow"), format!("{c2}\n")).expect("shallow");
    let repo = GitRepo::open(&fx.repo).expect("repo");
    let commits = repo.commits_between(None, &sha(&c2), 10).expect("walk");
    assert_eq!(commits.len(), 2, "shallow boundary must not hide history");
}

#[test]
fn unsafe_local_config_is_refused_and_safe_config_is_accepted() {
    let (fx, _c1, c2) = two_commit_fixture("config");
    let repo = GitRepo::open(&fx.repo).expect("repo");
    assert!(repo.branch_tips().is_ok(), "stock bare config is safe");
    let stock = std::fs::read_to_string(fx.repo.join("config")).expect("config");
    for extra in [
        "[include]\n\tpath = /tmp/evil\n",
        "[core]\n\thooksPath = /tmp/hooks\n",
        "[core]\n\tcommitGraph = true\n",
        "[extensions]\n\tobjectFormat = sha256\n",
        "[core]\n\tbare = false\n",
    ] {
        std::fs::write(fx.repo.join("config"), format!("{stock}{extra}")).expect("write");
        let err = repo.branch_tips().expect_err(extra);
        assert!(matches!(err, GitError::Structure(_)), "{extra}: {err:?}");
    }
    std::fs::write(fx.repo.join("config"), &stock).expect("restore");
    // The cap is inclusive. A forbidden suffix after it must never reach Git.
    let exact = format!("{stock}#{}\n", "x".repeat(64 * 1024 - stock.len() - 2));
    assert_eq!(exact.len(), 64 * 1024);
    std::fs::write(fx.repo.join("config"), &exact).unwrap();
    assert!(repo.branch_tips().is_ok());
    for suffix in [
        "#x\n",
        "[core]\n bare = false\n",
        "[include]\n path = elsewhere\n",
    ] {
        std::fs::write(fx.repo.join("config"), format!("{exact}{suffix}")).unwrap();
        assert!(matches!(repo.branch_tips(), Err(GitError::Structure(_))));
        assert!(matches!(repo.object_reader(), Err(GitError::Structure(_))));
    }
    std::fs::write(fx.repo.join("config"), &stock).unwrap();
    // Alternates would import foreign objects: refused.
    std::fs::write(fx.repo.join("objects/info/alternates"), "/tmp/elsewhere\n").expect("alt");
    let err = repo
        .commits_between(None, &sha(&c2), 10)
        .expect_err("alternates");
    assert!(matches!(err, GitError::Structure(_)), "{err:?}");
}

#[test]
fn hung_git_is_killed_at_the_injected_timeout() {
    let (fx, _c1, _c2) = two_commit_fixture("hung");
    let wrapper = parked_git::ParkedGit::new(&fx.root, "for-each-ref");
    let child = spawn_role(
        "hung-git",
        &fx.root,
        fx.repo.to_str().unwrap(),
        Some(&wrapper.path),
    );
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    let elapsed: u128 = text
        .lines()
        .find_map(|l| l.strip_prefix("TIMEOUT "))
        .unwrap_or_else(|| panic!("no timeout: {text}"))
        .parse()
        .unwrap();
    assert!((250..10_000).contains(&elapsed), "{elapsed}ms");
    assert!(
        !wrapper.alive_after_timeout(),
        "hung git must be killed and reaped"
    );
}

// ── Descendant drain of a publication child ─────────────────────────────────

#[test]
fn killed_owner_ref_update_child_blocks_successor_until_drained() {
    let base = temp_base("drain");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    drop(store);
    let wrapper = parked_git::ParkedGit::new(&base, "update-ref");
    let mut owner = spawn_role(
        "commit-race",
        &root,
        &format!("{kb} {head} drain-key-00000001 drained body\n"),
        Some(&wrapper.path),
    );
    wrapper.wait("mark");
    owner.kill().expect("kill owner");
    owner.wait().expect("reap owner");
    let successor = Store::open(&root).expect("open while child runs");
    #[cfg(unix)]
    {
        assert!(
            successor.try_lock_write(&[]).unwrap().is_none(),
            "publication child must retain lock"
        );
        let row = successor
            .intents(&kb)
            .unwrap()
            .into_iter()
            .find(|r| r.idempotency_key == "drain-key-00000001")
            .unwrap();
        assert_eq!(row.phase, Phase::Committing);
        assert_eq!(main_ref(&repo), head.as_str());
    }
    #[cfg(unix)]
    std::fs::write(wrapper.bin.join("release"), b"go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let guard = loop {
        if let Some(guard) = successor.try_lock_write(&[]).unwrap() {
            break guard;
        }
        assert!(Instant::now() < deadline, "child never drained");
        std::thread::sleep(Duration::from_millis(10));
    };
    #[cfg(windows)]
    assert!(!wrapper.alive(), "successor admitted before job drain");
    drop(guard);
    let record = successor.read_kb(&kb).unwrap();
    #[cfg(unix)]
    {
        let moved = main_ref(&repo);
        assert_ne!(moved, head.as_str());
        assert_eq!(record.head_sha.as_deref(), Some(moved.as_str()));
        assert_eq!(commit_count(&repo), 2);
    }
    #[cfg(windows)]
    {
        assert_eq!(
            main_ref(&repo),
            head.as_str(),
            "job killed parked writer before CAS"
        );
        assert_eq!(record.head_sha.as_deref(), Some(head.as_str()));
        assert_eq!(commit_count(&repo), 1);
    }
    drop(successor);
    drop(wrapper);
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn killed_owner_read_only_children_block_successor_until_drained() {
    for mode in ["cat-file", "for-each-ref", "thread"] {
        let base = temp_base(mode);
        let root = base.join("store");
        let (store, kb, head) = store_with_kb(&root);
        drop(store);
        let wrapper =
            parked_git::ParkedGit::new(&base, if mode == "thread" { "cat-file" } else { mode });
        let mut owner = spawn_role(
            "locked-read",
            &root,
            &format!("{kb} {head} {mode}"),
            Some(&wrapper.path),
        );
        wrapper.wait("mark");
        if mode != "for-each-ref" {
            wrapper.wait("stdin-ok");
        }
        owner.kill().unwrap();
        owner.wait().unwrap();
        let successor = Store::open(&root).unwrap();
        #[cfg(unix)]
        assert!(
            successor.try_lock_write(&[]).unwrap().is_none(),
            "{mode} escaped lock handoff"
        );
        #[cfg(unix)]
        std::fs::write(wrapper.bin.join("release"), b"go").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(guard) = successor.try_lock_write(&[]).unwrap() {
                drop(guard);
                break;
            }
            assert!(Instant::now() < deadline, "reader never drained");
            std::thread::sleep(Duration::from_millis(10));
        }
        #[cfg(windows)]
        assert!(!wrapper.alive(), "{mode} outlived job drain");
        assert_eq!(
            successor.read_kb(&kb).unwrap().head_sha.as_deref(),
            Some(head.as_str())
        );
        drop(successor);
        drop(wrapper);
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn locked_cat_file_keeps_stdin_and_releases_after_normal_exit() {
    for mode in ["cat-file", "released"] {
        let base = temp_base("live-read");
        let root = base.join("store");
        let (store, kb, head) = store_with_kb(&root);
        drop(store);
        let wrapper = parked_git::ParkedGit::new(&base, "cat-file");
        let owner = spawn_role(
            "locked-read",
            &root,
            &format!("{kb} {head} {mode}"),
            Some(&wrapper.path),
        );
        wrapper.wait("stdin-ok");
        let successor = Store::open(&root).unwrap();
        assert!(
            successor.try_lock_write(&[]).unwrap().is_none(),
            "{mode} reader must retain ownership until it finishes"
        );
        std::fs::write(wrapper.bin.join("release"), b"go").unwrap();
        let out = owner.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("READ_OK"));
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(guard) = successor.try_lock_write(&[]).unwrap() {
                drop(guard);
                break;
            }
            assert!(Instant::now() < deadline, "normal reader stranded the lock");
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(successor);
        drop(wrapper);
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn locked_git_timeout_drains_and_allows_reentry() {
    let base = temp_base("locked-timeout");
    let root = base.join("store");
    let (store, kb, _) = store_with_kb(&root);
    let repo = store.paths().repo_dir(&kb);
    drop(store);
    let wrapper = parked_git::ParkedGit::new(&base, "for-each-ref");
    let out = spawn_role(
        "locked-hung-git",
        &root,
        repo.to_str().unwrap(),
        Some(&wrapper.path),
    )
    .wait_with_output()
    .unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("TIMEOUT "));
    assert!(!wrapper.alive_after_timeout());
    let successor = Store::open(&root).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(guard) = successor.try_lock_write(&[]).unwrap() {
            drop(guard);
            break;
        }
        assert!(Instant::now() < deadline, "watchdog leaked a lock");
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(successor);
    drop(wrapper);
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn nested_store_git_inherits_only_its_exact_store_lock() {
    for order in [
        "outer-first",
        "inner-first",
        "outer-only",
        #[cfg(windows)]
        "case-alias",
    ] {
        let base = temp_base(order);
        let root = base.join("store");
        let outer = Store::open(&root).unwrap();
        let (inner, kb, head) = store_with_kb(&root.join("uploads/inner"));
        #[cfg(windows)]
        if order == "case-alias" {
            std::fs::rename(
                inner.paths().root().join("repos"),
                inner.paths().root().join("Repos"),
            )
            .unwrap();
        }
        let wrapper = parked_git::ParkedGit::new(&base, "cat-file");
        let owner = spawn_role(
            "nested-read",
            &root,
            &format!("{kb} {head} {order}"),
            Some(&wrapper.path),
        );
        wrapper.wait("stdin-ok");
        assert!(wrapper.alive(), "reader must still be parked");
        let deadline = Instant::now() + Duration::from_secs(10);
        // An inner reader must never retain the unrelated ancestor lock.
        let ancestor_released = loop {
            if let Some(guard) = outer.try_lock_write(&[]).unwrap() {
                drop(guard);
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        #[cfg(unix)]
        let inner_available = fixture::os_locks_available(inner.paths().root(), &[]);
        #[cfg(windows)]
        let inner_available = if order == "outer-only" {
            // The registry may be briefly occupied by an unrelated spawn.
            drop(inner.lock_write(&[]).unwrap());
            true
        } else {
            inner.try_lock_write(&[]).unwrap().is_some()
        };
        // Release and reap before asserting the observations, including on
        // historical failure, so the probe never leaves a parked owner.
        std::fs::write(wrapper.bin.join("release"), b"go").unwrap();
        let output = owner.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("READ_OK"));
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(guard) = inner.try_lock_write(&[]).unwrap() {
                drop(guard);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{order}: completed reader stranded lock"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(inner);
        drop(outer);
        drop(wrapper);
        std::fs::remove_dir_all(base).unwrap();
        assert!(
            !inner_available,
            "{order}: reader must retain exactly its own store lock"
        );
        assert!(ancestor_released, "{order}: reader retained ancestor lock");
    }
}

#[cfg(unix)] // The fault fixture closes fd 1 with a Unix shell before parking.
#[test]
fn early_stdout_eof_keeps_deadline_until_exit_locked_and_unlocked() {
    if run_in_isolated_process("early_stdout_eof_keeps_deadline_until_exit_locked_and_unlocked") {
        return;
    }
    for role in ["hung-git", "locked-hung-git"] {
        let base = temp_base("early-eof");
        let root = base.join("store");
        let (store, kb, _) = store_with_kb(&root);
        let repo = store.paths().repo_dir(&kb);
        let wrapper = parked_git::ParkedGit::new(&base, "early-eof");
        let out = spawn_role(role, &root, repo.to_str().unwrap(), Some(&wrapper.path))
            .wait_with_output()
            .unwrap();
        assert!(out.status.success());
        let text = String::from_utf8(out.stdout).unwrap();
        let elapsed: u128 = text
            .lines()
            .find_map(|line| line.strip_prefix("TIMEOUT "))
            .unwrap_or_else(|| panic!("{role}: EOF must not cancel the deadline: {text}"))
            .parse()
            .unwrap();
        assert!((250..10_000).contains(&elapsed), "{role}: {elapsed}ms");
        assert!(
            !wrapper.alive_after_timeout(),
            "{role}: early-EOF child not reaped"
        );
        assert!(
            fixture::os_locks_available(store.paths().root(), &[]),
            "{role}: timeout stranded lock"
        );
        drop(store.lock_write(&[]).unwrap());
        drop(store);
        drop(wrapper);
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[test]
fn killed_public_create_before_reservation_commit_leaves_no_repo_or_intent() {
    let base = temp_base("kill-reserving");
    let root = base.join("store");
    drop(Store::open(&root).unwrap());
    let mut child = spawn_role(
        "create-kill",
        &root,
        "reserving interrupted-create-001",
        None,
    );
    wait_for_line(&mut child, "AT");
    child.kill().unwrap();
    child.wait().unwrap();
    let store = Store::open(&root).unwrap();
    // Startup reconciliation is opportunistic while admission is busy; the
    // first write admission must have reconciled before it is granted.
    drop(store.lock_write(&[]).unwrap());
    assert!(store.list_kbs().unwrap().is_empty());
    assert!(
        std::fs::read_dir(root.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
    let sql = rusqlite::Connection::open(root.join("state.sqlite")).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM operation_intents", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let receipt = store
        .create_kb(&store.owner(), create_req("beta", "interrupted-create-001"))
        .unwrap();
    assert_eq!(
        store.kb(&receipt.kb_id).unwrap().unwrap().state,
        KbState::Active
    );
    assert_eq!(std::fs::read_dir(root.join("repos")).unwrap().count(), 1);
}

// Enumerate every owner thread: libtest and the watchdog need not spawn from
// the main thread. Match the exact repository as well as the batch argv:
// parallel tests can own other real cat-file children in the same process.
#[cfg(target_os = "linux")]
fn batch_pid(owner: u32, repo: &Path) -> u32 {
    for task in std::fs::read_dir(format!("/proc/{owner}/task")).expect("owner threads") {
        let children = std::fs::read_to_string(task.expect("thread entry").path().join("children"))
            .expect("thread child list");
        for pid in children.split_whitespace() {
            let argv = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
            let args: Vec<_> = argv.split(|b| *b == 0).collect();
            if args.contains(&b"cat-file".as_slice())
                && args.contains(&b"--batch".as_slice())
                && args.windows(2).any(|pair| {
                    pair == [b"--git-dir".as_slice(), repo.as_os_str().as_encoded_bytes()]
                })
            {
                return pid.parse().expect("numeric Git PID");
            }
        }
    }
    panic!(
        "real batch child not found for owner {owner} and repo {}",
        repo.display()
    );
}

#[cfg(target_os = "linux")]
#[test]
fn batch_pid_selects_its_repository_among_live_readers() {
    let first = fixture::Fixture::new("batch-pid-first");
    let second = fixture::Fixture::new("batch-pid-second");
    let first_head = sha(&first.commit_files(&[("index.md", b"first\n")], &[]));
    let second_head = sha(&second.commit_files(&[("index.md", b"second\n")], &[]));
    let mut first_reader = GitRepo::open(&first.repo).unwrap().object_reader().unwrap();
    let mut second_reader = GitRepo::open(&second.repo)
        .unwrap()
        .object_reader()
        .unwrap();
    assert_eq!(
        first_reader.read_commit(&first_head).unwrap().sha,
        first_head
    );
    assert_eq!(
        second_reader.read_commit(&second_head).unwrap().sha,
        second_head
    );
    assert_ne!(
        batch_pid(std::process::id(), &first.repo),
        batch_pid(std::process::id(), &second.repo),
        "repository probes selected the same batch child"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn managed_batch_without_guard_blocks_successor_after_owner_kill() {
    for mode in ["managed", "raw"] {
        let base = temp_base("unguarded-real-batch");
        let root = base.join("store");
        let (store, kb, head) = store_with_kb(&root);
        drop(store);
        let mut owner = spawn_role("managed-batch", &root, &format!("{kb} {head} {mode}"), None);
        wait_for_line(&mut owner, "READY");
        let pid = batch_pid(owner.id(), &root.join("repos").join(format!("kb_{kb}.git")));
        assert!(
            Command::new("kill")
                .args(["-STOP", &pid.to_string()])
                .status()
                .unwrap()
                .success()
        );
        owner.kill().unwrap();
        owner.wait().unwrap();
        let successor = Store::open(&root).unwrap();
        let alive = std::path::Path::new(&format!("/proc/{pid}")).exists();
        let excluded = successor.try_lock_write(&[]).unwrap().is_none();
        // Continue even on historical failure so closed batch input drains.
        assert!(
            Command::new("kill")
                .args(["-CONT", &pid.to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(guard) = successor.try_lock_write(&[]).unwrap() {
                drop(guard);
                break;
            }
            assert!(Instant::now() < deadline, "real reader stranded lock");
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(successor);
        std::fs::remove_dir_all(base).unwrap();
        assert!(
            alive && excluded,
            "{mode}: alive={alive}, excluded={excluded}"
        );
    }
}

#[test]
fn ordinary_document_and_main_read_children_drain_after_owner_kill() {
    for mode in ["get", "list", "main"] {
        let base = temp_base("ordinary-read");
        let root = base.join("store");
        let (store, kb, head) = store_with_kb(&root);
        drop(store);
        let wrapper = parked_git::ParkedGit::new(
            &base,
            if mode == "main" {
                "for-each-ref"
            } else {
                "cat-file"
            },
        );
        let mut owner = spawn_role(
            "managed-read",
            &root,
            &format!("{kb} {head} {mode}"),
            Some(&wrapper.path),
        );
        wrapper.wait("mark");
        owner.kill().unwrap();
        owner.wait().unwrap();
        let successor = Store::open(&root).unwrap();
        #[cfg(unix)]
        let excluded = successor.try_lock_write(&[]).unwrap().is_none();
        std::fs::write(wrapper.bin.join("release"), b"go").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(guard) = successor.try_lock_write(&[]).unwrap() {
                drop(guard);
                break;
            }
            assert!(Instant::now() < deadline, "ordinary reader stranded lock");
            std::thread::sleep(Duration::from_millis(10));
        }
        #[cfg(windows)]
        assert!(!wrapper.alive(), "reader outlived Job drain");
        drop(successor);
        drop(wrapper);
        std::fs::remove_dir_all(base).unwrap();
        #[cfg(unix)]
        assert!(excluded, "{mode} bypassed managed ownership");
    }
}

#[test]
fn replacement_store_children_use_current_root_and_lock_identity() {
    if run_in_isolated_process("replacement_store_children_use_current_root_and_lock_identity") {
        return;
    }
    let mut observations = Vec::new();
    for replace_root in [true, false] {
        let base = temp_base("replace-child-owner");
        let root = base.join("store");
        let (a, a_kb, _) = store_with_kb(&root);
        let old_repo = GitRepo::for_kb(a.paths(), &a_kb).unwrap();
        let retired = a.lock_write(&[]).unwrap();
        let (b, kb, head) = if replace_root {
            std::fs::rename(&root, base.join("retired")).unwrap();
            store_with_kb(&root)
        } else {
            std::fs::rename(a.paths().store_lock_file(), root.join("retired.lock")).unwrap();
            let b = Store::open(&root).unwrap();
            let head = sha(b.kb(&a_kb).unwrap().unwrap().head_sha.as_deref().unwrap());
            (b, a_kb, head)
        };
        let current = b.lock_write(&[]).unwrap();
        let repo = GitRepo::for_kb(b.paths(), &kb).unwrap();
        let mut reader = repo.object_reader().unwrap();
        assert_eq!(reader.read_commit(&head).unwrap().sha, head);
        #[cfg(target_os = "linux")]
        let inherited_current = {
            let pid = batch_pid(std::process::id(), &b.paths().repo_dir(&kb));
            std::fs::read_dir(format!("/proc/{pid}/fd"))
                .unwrap()
                .any(|entry| {
                    std::fs::read_link(entry.unwrap().path()).ok().as_deref()
                        == Some(b.paths().store_lock_file().as_path())
                })
        };
        drop(current);
        let excluded = store_lock_held(&b);
        drop(reader);
        assert!(store_lock_free(&b), "drained reader retained lock");
        if replace_root {
            assert!(
                old_repo.object_reader().is_err(),
                "old managed handle followed recycled root"
            );
        }
        drop(retired);
        drop(a);
        drop(b);
        std::fs::remove_dir_all(base).unwrap();
        #[cfg(not(target_os = "linux"))]
        let inherited_current = true; // Native fd inspection is Linux-only.
        observations.push((replace_root, excluded, inherited_current));
    }
    assert!(
        observations
            .iter()
            .all(|(_, excluded, current)| *excluded && *current),
        "(root_replaced, excluded, inherited_current): {observations:?}"
    );
}

#[test]
fn managed_readers_share_lease_until_last_child_drains() {
    if run_in_isolated_process("managed_readers_share_lease_until_last_child_drains") {
        return;
    }
    let base = temp_base("reader-share");
    let root = base.join("store");
    let (store, kb, head) = store_with_kb(&root);
    let repo = GitRepo::for_kb(store.paths(), &kb).unwrap();
    let mut first = repo.object_reader().unwrap();
    let mut second = repo.object_reader().unwrap();
    assert_eq!(first.read_commit(&head).unwrap().sha, head);
    assert_eq!(second.read_commit(&head).unwrap().sha, head);
    assert_eq!(repo.branch_tips().unwrap(), vec![head]);
    assert!(store_lock_held(&store));
    drop(first);
    assert!(store_lock_held(&store));
    drop(second);
    assert!(store_lock_free(&store));
    // Merely retaining the repo handle must not pin ownership after drain.
    drop(repo);
    drop(store);
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn failed_managed_spawn_releases_automatically_acquired_lease() {
    if run_in_isolated_process("failed_managed_spawn_releases_automatically_acquired_lease") {
        return;
    }
    let base = temp_base("auto-lease-failed-spawn");
    let root = base.join("store");
    let (store, kb, _) = store_with_kb(&root);
    let empty_path = base.join("empty-path");
    std::fs::create_dir(&empty_path).unwrap();
    let output = spawn_role(
        "managed-spawn-failure",
        &root,
        kb.as_str(),
        Some(empty_path.to_str().unwrap()),
    )
    .wait_with_output()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("SPAWN_FAILED"));
    assert!(store_lock_free(&store));
    drop(store);
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn batch_timeout_preserves_header_body_and_stdin_failures_and_drains() {
    for mode in [
        "cat-file",
        "batch-partial",
        "batch-write-failure",
        "batch-malformed",
    ] {
        let (fx, first, _) = two_commit_fixture(mode);
        let wrapper = parked_git::ParkedGit::new(&fx.root, mode);
        let out = spawn_role(
            "batch-outcome",
            &fx.root,
            &format!("{} {first} {mode}", fx.repo.display()),
            Some(&wrapper.path),
        )
        .wait_with_output()
        .unwrap();
        assert!(
            out.status.success(),
            "{mode}: {} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("OUTCOME_OK"));
        assert!(!wrapper.alive_after_timeout(), "{mode}: leaked batch child");
        // Re-entry uses real Git, after the poisoned process has been reaped.
        assert!(
            GitRepo::open(&fx.repo)
                .unwrap()
                .read_commit(&sha(&first))
                .is_ok()
        );
    }
}

#[test]
fn incoming_metadata_preflight_stops_before_shared_byte_cap_is_exceeded() {
    let fx = fixture::Fixture::new("history-byte-budget");
    let tree = fx.tree(&fixture::with_required(&[]));
    let mut parent = None;
    for i in 0..18 {
        let mut body = format!("tree {tree}\n{}author A <a@example.invalid> 1 +0000\ncommitter A <a@example.invalid> 1 +0000\n\n{i}\n", parent.as_ref().map_or(String::new(), |p| format!("parent {p}\n"))).into_bytes();
        body.resize(kb_local::git_read::METADATA_OBJECT_MAX_BYTES, b'x');
        parent = Some(fx.raw_commit(&body));
    }
    let new = parent.unwrap();
    fx.set_ref("refs/heads/main", &new);
    let wrapper = parked_git::ParkedGit::new(&fx.root, "batch-trace");
    let output = spawn_role(
        "history-budget",
        &fx.root,
        &format!("{} {new}", fx.repo.display()),
        Some(&wrapper.path),
    )
    .wait_with_output()
    .unwrap();
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("BUDGET_OK"));
    let mut delivered = std::collections::HashMap::new();
    for line in std::fs::read_to_string(wrapper.bin.join("bodies"))
        .unwrap()
        .lines()
    {
        let (name, size) = line.split_once(' ').unwrap();
        delivered.insert(name.to_owned(), size.parse::<usize>().unwrap());
    }
    let bytes: usize = delivered.values().sum();
    assert!(
        bytes <= kb_local::tree::TREE_LIMITS.max_uncompressed_object_bytes,
        "delivered {bytes} unique metadata bytes before rejection"
    );
    let big = delivered
        .values()
        .filter(|size| **size == kb_local::git_read::METADATA_OBJECT_MAX_BYTES)
        .count();
    assert!(
        big < 16,
        "preflight must stop before the 16th full commit plus tree exceeds the cap, got {big}"
    );
}

#[test]
fn crash_helper_unwind_drains_before_directory_removal() {
    let removed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = removed.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut root = temp_base("unwind-writer");
        std::fs::create_dir_all(&root).expect("probe root");
        // Construction of a second child fails after the first was admitted.
        // Vec must own the first tree throughout this partial construction.
        let _children: Vec<ChildGuard> = (0..2)
            .map(|index| {
                assert_eq!(index, 0, "injected failure constructing the second child");
                let child = spawn_role("unwind-probe", &root, "", None);
                let pids = child_guard::writer_pids(&root);
                let path = root.to_path_buf();
                let observed = observed.clone();
                root.before_remove(move || {
                    assert!(path.exists(), "check runs before the actual rm");
                    child_guard::assert_dead(&pids);
                    observed.store(true, std::sync::atomic::Ordering::Relaxed);
                });
                child
            })
            .collect();
    }));
    assert!(result.is_err());
    assert!(removed.load(std::sync::atomic::Ordering::Relaxed));
}
