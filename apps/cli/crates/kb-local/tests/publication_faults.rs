//! R52b native recovery and mandatory survivor regressions. No mocked Git,
//! SQLite, filesystem barrier or OS fence; every fixture is private.
#![cfg(target_os = "linux")]

#[path = "support/child_guard.rs"]
mod child_guard;
use child_guard::ChildGuard;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use kb_client::ErrorCode;
use kb_client::types::{ChangesApply, ChangesApplyInput, KbId, Permission, Sha};
use kb_local::{
    CommitRequest, CreateKbRequest, FileChange, KbState, Phase, PrincipalKind, Stage, Store,
    StoreError,
};
use rusqlite::Connection;
use serde_json::json;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("native fixture operation")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("r52b-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).expect("native fixture operation");
        Self(path)
    }
    fn root(&self) -> PathBuf {
        self.0.join("store")
    }
    fn arm(&self, mode: &str, path: &Path) {
        std::fs::write(
            self.0.join("control"),
            format!("{mode}\n{}\n", path.display()),
        )
        .expect("native fixture operation");
    }
    fn disarm(&self) {
        std::fs::remove_file(self.0.join("control")).expect("native fixture operation");
    }
    fn hit(&self) -> bool {
        self.0.join("hit").exists()
    }
    fn compile(&self) -> PathBuf {
        let library = self.0.join("fault.so");
        let output = Command::new("cc")
            .args(["-shared", "-fPIC", "-o"])
            .arg(&library)
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/publication_fault.c"))
            .arg(format!(
                "-DR52_CONTROL=\"{}\"",
                self.0.join("control").display()
            ))
            .arg(format!("-DR52_MARKER=\"{}\"", self.0.join("hit").display()))
            .arg(format!(
                "-DR52_PID=\"{}\"",
                self.0.join("git-pid").display()
            ))
            .arg("-ldl")
            .output()
            .expect("native fixture operation");
        assert!(output.status.success(), "{output:?}");
        library
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::env::var_os("R52_ROLE").is_none() {
            std::fs::remove_dir_all(&self.0).expect("native fixture operation");
        }
    }
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@local.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@local.invalid")
        .output()
        .expect("native fixture operation");
    assert!(output.status.success(), "{args:?}: {output:?}");
    String::from_utf8(output.stdout)
        .expect("native fixture operation")
        .trim()
        .to_owned()
}

fn request(kb: &KbId, head: &Sha, key: &str) -> CommitRequest {
    CommitRequest {
        kb: kb.clone(),
        base_revision: head.clone(),
        idempotency_key: key.into(),
        changes: vec![FileChange {
            path: "note.md".into(),
            content: Some(b"new body\n".to_vec()),
        }],
    }
}

fn setup(fixture: &Fixture) -> (Store, KbId, Sha) {
    let store = Store::open(&fixture.root()).expect("native fixture operation");
    let receipt = store
        .create_kb(
            &store.owner(),
            CreateKbRequest {
                name: "Recovery".into(),
                slug: "recovery".into(),
                description: "A private recovery fixture".into(),
                idempotency_key: "create-key-0000001".into(),
            },
        )
        .expect("native fixture operation");
    (store, receipt.kb_id, receipt.commit_sha)
}

fn interrupt(store: &Store, request: CommitRequest, stage: Stage) {
    assert!(
        store
            .commit_files_observed(&store.owner(), request, &mut |s| {
                if s == stage {
                    return Err(StoreError::StorageUnavailable("interrupted".into()));
                }
                Ok(())
            })
            .is_err()
    );
}

fn phase(store: &Store, kb: &KbId, key: &str) -> Phase {
    store
        .intents(kb)
        .expect("native fixture operation")
        .into_iter()
        .find(|r| r.idempotency_key == key)
        .expect("native fixture operation")
        .phase
}

fn apply_input(kb: &KbId, head: &Sha, key: &str) -> ChangesApplyInput {
    kb_client::decode_input::<ChangesApply>(
        json!({"kbId":kb.as_str(), "baseRevision":head.as_str(),
        "idempotencyKey":key, "mode":"edit", "title":"Proposal", "sourceSessionIds":[],
        "changes":[{"op":"create", "path":"note.md", "content":{"markdown":"new body\n"}}]}),
    )
    .expect("native fixture operation")
}

fn proposer(store: &Store, kb: &KbId) -> kb_local::LocalPrincipal {
    let guard = store
        .lock_write(std::slice::from_ref(kb))
        .expect("native fixture operation");
    store
        .register_principal(&guard, PrincipalKind::Test, kb, &[Permission::Propose])
        .expect("native fixture operation")
}

// Roles run in their own process so LD_PRELOAD and PATH never mutate a
// concurrently executing test's ambient environment.
#[test]
fn child_role() {
    let Ok(role) = std::env::var("R52_ROLE") else {
        return;
    };
    let fixture = Fixture(PathBuf::from(
        std::env::var_os("R52_BASE").expect("native fixture operation"),
    ));
    let (store, kb, head) = setup(&fixture);
    let repo = store.paths().repo_dir(&kb);
    let key = "native-key-000001";
    let input = request(&kb, &head, key);
    match role.as_str() {
        "object" => {
            let result = store.commit_files_observed(&store.owner(), input.clone(), &mut |stage| {
                if stage == Stage::SyncObjects {
                    fixture.arm("object", &repo);
                }
                Ok(())
            });
            assert!(fixture.hit(), "actual object sync must execute (52b-07)");
            assert!(
                matches!(result, Err(StoreError::Io(ref e)) if e.raw_os_error() == Some(5)),
                "{result:?}"
            );
            fixture.disarm();
            assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), head.as_str());
            assert_eq!(phase(&store, &kb, key), Phase::Aborted);
            assert!(matches!(
                store.commit_files(&store.owner(), input),
                Err(StoreError::OperationAborted(_))
            ));
            let next = store
                .commit_files(&store.owner(), request(&kb, &head, "native-next-00001"))
                .expect("native fixture operation");
            assert_ne!(next.commit_sha, head);
        }
        "directory" | "ref-file" | "wal" => {
            let result = store.commit_files_observed(&store.owner(), input.clone(), &mut |stage| {
                if role == "directory" && stage == Stage::Committing {
                    fixture.arm("eio", &repo.join("refs/heads"));
                }
                if role == "ref-file" && stage == Stage::Committing {
                    fixture.arm("eio", &repo.join("refs/heads/main"));
                }
                if role == "wal" && stage == Stage::Finalizing {
                    fixture.arm(
                        "eio",
                        &store.paths().state_db().with_file_name("state.sqlite-wal"),
                    );
                }
                Ok(())
            });
            assert!(fixture.hit(), "actual directory/WAL sync must execute");
            assert!(
                result.is_err(),
                "failed barrier cannot acknowledge: {result:?}"
            );
            assert_eq!(phase(&store, &kb, key), Phase::Committing);
            let moved = git(&repo, &["rev-parse", "refs/heads/main"]);
            assert_ne!(moved, head.as_str());
            if role != "wal" {
                assert!(
                    store.read_kb(&kb).is_err(),
                    "recovery must repeat the failed barrier"
                );
                assert_eq!(phase(&store, &kb, key), Phase::Committing);
                assert_eq!(
                    store
                        .kb(&kb)
                        .expect("native fixture operation")
                        .expect("native fixture operation")
                        .state,
                    KbState::Active
                );
            }
            fixture.disarm();
            drop(store);
            let reopened = Store::open(&fixture.root()).expect("native fixture operation");
            let receipt = reopened
                .commit_files(&reopened.owner(), input)
                .expect("native fixture operation");
            assert_eq!(receipt.commit_sha.as_str(), moved);
            assert_eq!(
                reopened
                    .read_kb(&kb)
                    .expect("native fixture operation")
                    .desired_epoch,
                2
            );
        }
        "observation" => {
            interrupt(&store, input.clone(), Stage::Finalizing);
            let bin = fixture.0.join("bin");
            // Only this launcher's for-each-ref fails; all Git/SQLite state
            // is real and the next fresh process uses ordinary Git again.
            std::fs::write(bin.join("fail"), "armed").expect("native fixture operation");
            assert_eq!(
                store.read_kb(&kb).unwrap_err().protocol_code(),
                ErrorCode::StorageUnavailable
            );
            assert_eq!(phase(&store, &kb, key), Phase::Committing);
            assert_eq!(
                store
                    .kb(&kb)
                    .expect("native fixture operation")
                    .expect("native fixture operation")
                    .state,
                KbState::Active
            );
            assert!(Store::open(&fixture.root()).is_err());
            std::fs::remove_file(bin.join("fail")).expect("native fixture operation");
            let fresh = Store::open(&fixture.root()).expect("native fixture operation");
            assert_eq!(
                fresh
                    .commit_files(&fresh.owner(), input)
                    .expect("native fixture operation")
                    .commit_sha
                    .as_str(),
                git(&repo, &["rev-parse", "refs/heads/main"])
            );
        }
        "crash" | "crash-proposal" => {
            std::fs::write(fixture.0.join("kb"), kb.as_str()).expect("native fixture operation");
            std::fs::write(fixture.0.join("head"), head.as_str())
                .expect("native fixture operation");
            let name = if role == "crash" {
                "refs/heads/main"
            } else {
                "refs/heads/pr/1"
            };
            let mut observer = |stage| {
                if stage == Stage::Committing {
                    fixture.arm("park", &repo.join(format!("{name}.lock")));
                }
                Ok(())
            };
            if role == "crash" {
                store
                    .commit_files_observed(&store.owner(), input, &mut observer)
                    .expect("native fixture operation");
            } else {
                store
                    .changes_apply_observed(
                        &proposer(&store, &kb),
                        apply_input(&kb, &head, key),
                        &mut observer,
                    )
                    .expect("native fixture operation");
            }
            panic!("parked real Git must be killed before success");
        }
        "config" => {
            let next = store
                .commit_files(&store.owner(), input)
                .expect("native fixture operation");
            assert_eq!(
                store
                    .read_kb(&kb)
                    .expect("native fixture operation")
                    .head_sha
                    .as_deref(),
                Some(next.commit_sha.as_str())
            );
        }
        "unlink" => {
            interrupt(&store, input.clone(), Stage::Committing);
            let intended = store
                .intents(&kb)
                .expect("native fixture operation")
                .into_iter()
                .find(|r| r.idempotency_key == key)
                .expect("native fixture operation")
                .intended_new
                .expect("native fixture operation");
            let lock = repo.join("refs/heads/main.lock");
            std::fs::write(&lock, format!("{intended}\n")).expect("native fixture operation");
            fixture.arm("eio", &repo.join("refs/heads"));
            assert!(store.read_kb(&kb).is_err());
            assert!(fixture.hit());
            assert!(!lock.exists(), "the first cleanup unlinked its exact lock");
            assert!(
                store.read_kb(&kb).is_err(),
                "ENOENT cannot bypass failed cleanup durability"
            );
            assert_eq!(phase(&store, &kb, key), Phase::Committing);
            fixture.disarm();
            store.read_kb(&kb).expect("native fixture operation");
            assert_eq!(phase(&store, &kb, key), Phase::Aborted);
            store
                .commit_files(&store.owner(), request(&kb, &head, "after-unlink-0001"))
                .expect("native fixture operation");
        }
        other => panic!("unknown role {other}"),
    }
    // Parent owns and cleans this fixture after the child exits.
    std::mem::forget(fixture);
}

fn role_command(fixture: &Fixture, role: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("native fixture operation"));
    command
        .args(["--exact", "child_role", "--nocapture", "--test-threads=1"])
        .env("R52_BASE", &fixture.0)
        .env("R52_ROLE", role);
    command
}

fn run_fault(role: &str) {
    let fixture = Fixture::new();
    let library = fixture.compile();
    let output = role_command(&fixture, role)
        .env("LD_PRELOAD", library)
        .output()
        .expect("native fixture operation");
    assert!(output.status.success(), "{role}: {output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[test]
fn native_object_fsync_failure_blocks_cas_and_allows_new_key() {
    run_fault("object");
}
#[test]
fn native_ref_directory_failure_is_retried_before_recovered_finalize() {
    run_fault("directory");
}
#[test]
fn native_ref_file_failure_is_retried_before_recovered_finalize() {
    run_fault("ref-file");
}
#[test]
fn native_ref_lock_unlink_barrier_is_retried_even_after_enoent() {
    run_fault("unlink");
}
#[test]
fn native_finalize_wal_sync_failure_never_acknowledges_and_recovers_once() {
    run_fault("wal");
}

fn script(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).expect("native fixture operation");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .expect("native fixture operation");
}
fn quote(path: &Path) -> String {
    format!(
        "'{}'",
        path.to_str()
            .expect("native fixture operation")
            .replace('\'', "'\\''")
    )
}
fn real_git() -> PathBuf {
    let output = Command::new("which")
        .arg("git")
        .output()
        .expect("native fixture operation");
    assert!(output.status.success());
    PathBuf::from(
        String::from_utf8(output.stdout)
            .expect("native fixture operation")
            .trim(),
    )
}

#[test]
fn temporary_git_observation_failure_remains_recoverable() {
    let fixture = Fixture::new();
    let bin = fixture.0.join("bin");
    std::fs::create_dir(&bin).expect("native fixture operation");
    script(
        &bin.join("git"),
        &format!(
            "#!/bin/sh\nif [ -f {} ]; then\n for arg do [ \"$arg\" = for-each-ref ] && exit 75; done\nfi\nexec {} \"$@\"\n",
            quote(&bin.join("fail")),
            quote(&real_git())
        ),
    );
    let output = role_command(&fixture, "observation")
        .env("PATH", &bin)
        .output()
        .expect("native fixture operation");
    assert!(output.status.success(), "{output:?}");
}

#[test]
fn real_git_ref_lock_crash_is_drained_and_successor_publishes() {
    crash_lock(false);
    crash_lock(true);
}

fn crash_lock(proposal: bool) {
    let fixture = Fixture::new();
    let library = fixture.compile();
    let bin = fixture.0.join("bin");
    std::fs::create_dir(&bin).expect("native fixture operation");
    script(
        &bin.join("git"),
        &format!(
            "#!/bin/sh\nexport LD_PRELOAD={}\nexec {} \"$@\"\n",
            quote(&library),
            quote(&real_git())
        ),
    );
    let mut command = role_command(&fixture, if proposal { "crash-proposal" } else { "crash" });
    command.env("PATH", &bin);
    let mut owner = ChildGuard::spawn(&command).expect("native fixture operation");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !fixture.0.join("git-pid").exists() && Instant::now() < deadline {
        assert!(
            owner
                .try_wait()
                .expect("native fixture operation")
                .is_none(),
            "owner exited before real Git barrier"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let pid =
        std::fs::read_to_string(fixture.0.join("git-pid")).expect("real Git at ref-lock fsync");
    let root = fixture.root();
    let kb = KbId::parse(
        &std::fs::read_to_string(fixture.0.join("kb")).expect("native fixture operation"),
    )
    .expect("native fixture operation");
    let head = Sha::parse(
        &std::fs::read_to_string(fixture.0.join("head")).expect("native fixture operation"),
    )
    .expect("native fixture operation");
    let repo = root.join("repos").join(format!("kb_{kb}.git"));
    let lock = repo.join(if proposal {
        "refs/heads/pr/1.lock"
    } else {
        "refs/heads/main.lock"
    });
    assert!(lock.is_file());
    owner.kill().expect("native fixture operation");
    owner.wait().expect("native fixture operation");
    assert!(
        Command::new("kill")
            .args(["-KILL", pid.trim()])
            .status()
            .expect("native fixture operation")
            .success()
    );
    fixture.disarm();
    let store = Store::open(&root).expect("native fixture operation");
    let guard = store
        .lock_write(std::slice::from_ref(&kb))
        .expect("native fixture operation");
    drop(guard);
    assert!(!lock.exists());
    assert_eq!(phase(&store, &kb, "native-key-000001"), Phase::Aborted);
    assert_eq!(git(&repo, &["rev-parse", "refs/heads/main"]), head.as_str());
    if proposal {
        let who = store
            .principal(
                &Connection::open(store.paths().state_db())
                    .expect("native fixture operation")
                    .query_row(
                        "SELECT principal_id FROM principal_ceilings WHERE kb_id=?1",
                        [kb.as_str()],
                        |r| r.get::<_, String>(0),
                    )
                    .expect("native fixture operation"),
            )
            .expect("native fixture operation");
        store
            .changes_apply(&who, apply_input(&kb, &head, "after-crash-00001"))
            .expect("native fixture operation");
    } else {
        store
            .commit_files(&store.owner(), request(&kb, &head, "after-crash-00001"))
            .expect("native fixture operation");
    }
}

#[test]
fn expected_old_cas_rejects_external_main_and_proposal_changes_at_final_gap() {
    for proposal in [false, true] {
        let fixture = Fixture::new();
        let (store, kb, head) = setup(&fixture);
        let repo = store.paths().repo_dir(&kb);
        let tree = git(&repo, &["rev-parse", &format!("{head}^{{tree}}")]);
        let third = git(
            &repo,
            &[
                "commit-tree",
                &tree,
                "-p",
                head.as_str(),
                "-m",
                "external third SHA",
            ],
        );
        let name = if proposal {
            "refs/heads/pr/1"
        } else {
            "refs/heads/main"
        };
        let mut observer = |stage| {
            if stage == Stage::Committing {
                git(&repo, &["update-ref", name, &third]);
            }
            Ok(())
        };
        let failed = if proposal {
            store
                .changes_apply_observed(
                    &proposer(&store, &kb),
                    apply_input(&kb, &head, "cas-key-00000001"),
                    &mut observer,
                )
                .is_err()
        } else {
            store
                .commit_files_observed(
                    &store.owner(),
                    request(&kb, &head, "cas-key-00000001"),
                    &mut observer,
                )
                .is_err()
        };
        assert!(
            failed,
            "actual expected-old CAS must refuse the third SHA (52b-10)"
        );
        assert_eq!(
            git(&repo, &["rev-parse", name]),
            third,
            "never overwrite external change"
        );
        assert_eq!(phase(&store, &kb, "cas-key-00000001"), Phase::Committing);
        drop(store);
        let store = Store::open(&fixture.root()).expect("native fixture operation");
        assert_eq!(
            store
                .kb(&kb)
                .expect("native fixture operation")
                .expect("native fixture operation")
                .state,
            KbState::RepairRequired
        );
        assert_eq!(git(&repo, &["rev-parse", name]), third);
    }
}

#[test]
fn hostile_private_system_and_global_config_are_neutralized() {
    for system in [false, true] {
        let fixture = Fixture::new();
        let config = fixture.0.join("hostile-config");
        std::fs::write(&config, "[malformed configuration\n").expect("native fixture operation");
        let variable = if system {
            "GIT_CONFIG_SYSTEM"
        } else {
            "GIT_CONFIG_GLOBAL"
        };
        // Calibration: real Git demonstrably fails when it consults the
        // controlled fixture. No host/user config file is read or modified.
        let output = Command::new(real_git())
            .args(["config", "--list"])
            .env("GIT_CONFIG_NOSYSTEM", "0")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env(variable, &config)
            .output()
            .expect("native fixture operation");
        assert!(
            !output.status.success(),
            "hostile config must affect unprotected Git"
        );
        let bin = fixture.0.join("bin");
        std::fs::create_dir(&bin).expect("native fixture operation");
        script(
            &bin.join("git"),
            &format!(
                "#!/bin/sh\nexport {variable}=\"${{{variable}:-{}}}\"\nexec {} \"$@\"\n",
                config.display(),
                quote(&real_git())
            ),
        );
        let output = role_command(&fixture, "config")
            .env("PATH", &bin)
            .output()
            .expect("native fixture operation");
        assert!(
            output.status.success(),
            "protected real Git must ignore {variable}: {output:?}"
        );
    }
}

#[test]
fn pending_ref_lock_cleanup_preserves_foreign_bytes_and_symlinks() {
    for symlink in [false, true] {
        let fixture = Fixture::new();
        let (store, kb, head) = setup(&fixture);
        let repo = store.paths().repo_dir(&kb);
        interrupt(
            &store,
            request(&kb, &head, "foreign-lock-0001"),
            Stage::Committing,
        );
        let foreign = fixture.0.join("foreign");
        std::fs::write(&foreign, "unrelated bytes").expect("native fixture operation");
        let path = repo.join("refs/heads/main.lock");
        if symlink {
            std::os::unix::fs::symlink(&foreign, &path).expect("native fixture operation");
        } else {
            std::fs::write(&path, "unrelated bytes").expect("native fixture operation");
        }
        assert!(store.read_kb(&kb).is_err());
        assert!(std::fs::symlink_metadata(&path).is_ok());
        assert_eq!(
            std::fs::read(&foreign).expect("native fixture operation"),
            b"unrelated bytes"
        );
        assert_eq!(phase(&store, &kb, "foreign-lock-0001"), Phase::Committing);
        assert_eq!(
            store
                .kb(&kb)
                .expect("native fixture operation")
                .expect("native fixture operation")
                .state,
            KbState::Active
        );
    }
}

#[test]
fn retained_first_page_cannot_starve_live_recovery() {
    let fixture = Fixture::new();
    let (store, kb, head) = setup(&fixture);
    let input = request(&kb, &head, "retained-key-0001");
    interrupt(&store, input.clone(), Stage::Finalizing);
    let conn = Connection::open(store.paths().state_db()).expect("native fixture operation");
    // A fixed low UUID prefixes every pending row in keyset order. Retained
    // tombstones are schema-valid historical inspection evidence, not mocks.
    let tx = conn
        .unchecked_transaction()
        .expect("native fixture operation");
    let dead = "aaaaaaaaaaaaaaaaaaaaaaaa";
    tx.execute("INSERT INTO kbs (id,name,slug,description,state,head_sha,metadata_version,desired_epoch,next_pr_number,index_rebuild_required,created_at) SELECT ?1, 'Retained', 'retained', description, 'TOMBSTONED', head_sha, metadata_version, desired_epoch, next_pr_number,index_rebuild_required,created_at FROM kbs WHERE id=?2", (dead, kb.as_str())).expect("native fixture operation");
    for i in 0..1001 {
        let op = format!("00000000-0000-4000-8000-{i:012}");
        tx.execute("INSERT INTO operation_intents (op_id,kb_id,actor_key,operation,idempotency_key,request_hash,phase,ref_name,expected_old,intended_new,validated_tree,delta_json,response_json,created_at) SELECT ?1, ?2, actor_key, operation, ?3, request_hash, phase, ref_name, expected_old, intended_new, validated_tree, delta_json, response_json, created_at FROM operation_intents WHERE kb_id=?4 AND phase='COMMITTING'", (op, dead, format!("retained-key-{i:016}"), kb.as_str())).expect("native fixture operation");
    }
    tx.commit().expect("native fixture operation");
    drop(conn);
    drop(store);
    let reopened = Store::open(&fixture.root()).expect("native fixture operation");
    assert_eq!(phase(&reopened, &kb, "retained-key-0001"), Phase::Finalized);
    assert_eq!(
        reopened
            .read_kb(&kb)
            .expect("native fixture operation")
            .desired_epoch,
        2
    );
    reopened
        .commit_files(&reopened.owner(), input)
        .expect("native fixture operation");
    let conn = Connection::open(reopened.paths().state_db()).expect("native fixture operation");
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM operation_intents WHERE kb_id=?1 AND phase='COMMITTING'",
            [dead],
            |r| r.get(0),
        )
        .expect("native fixture operation");
    assert_eq!(count, 1001, "retain unresolved inspection evidence");
}
