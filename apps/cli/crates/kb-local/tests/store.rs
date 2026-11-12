//! Durable store, recovery, filesystem jail, identity and
//! authority. Multi-process kill tests re-run this test binary in a child
//! role (see `child_role_entry`).

#[path = "support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[path = "support/child_guard.rs"]
mod child_guard;
use child_guard::ChildGuard;
use std::time::{Duration, Instant};

use kb_client::ErrorCode;
use kb_client::types::{KbId, Permission, Uuid};
use kb_local::{Bits, NewKb, OpenStage, PrincipalKind, Store, StoreError};

fn temp_root(tag: &str) -> TestDir {
    let base = std::env::temp_dir().join(format!(
        "kb-local-store-{tag}-{}-{}",
        std::process::id(),
        Instant::now().elapsed().as_nanos() ^ rand_suffix()
    ));
    std::fs::create_dir_all(&base).expect("test fixture");
    TestDir::new(base)
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("test fixture")
        .as_nanos()
}

fn new_kb(slug: &str) -> NewKb {
    NewKb {
        name: format!("KB {slug}"),
        slug: slug.to_owned(),
        description: "A local knowledge base for tests".to_owned(),
    }
}

fn store_dir(base: &Path) -> PathBuf {
    base.join("store")
}

// Only remove generated entries of a freshly opened fixture. Nonrecursive
// removal refuses unexpected data, including anything inside the CAS temp dir.
fn remove_empty_managed_fixture_dir(root: &Path, rel: &str) -> std::io::Result<()> {
    let managed = root.join(rel);
    match rel {
        "assets" => std::fs::remove_dir(managed.join("tmp"))?,
        "locks" => {
            // Store open also admits model recovery through these persistent
            // lock files. Remove only the exact empty-fixture inventory.
            for name in ["store.lock", "model-config.lock"] {
                std::fs::remove_file(managed.join(name))?;
            }
        }
        _ => {}
    }
    std::fs::remove_dir(managed)
}

// ── Child roles (re-exec of this test binary) ───────────────────────────────

const ROLE_ENV: &str = "KB_LOCAL_STORE_TEST_ROLE";
const ROOT_ENV: &str = "KB_LOCAL_STORE_TEST_ROOT";

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    // Leading newline: libtest prints `test child_role_entry ... ` without one.
    writeln!(out, "\n{line}").expect("test fixture");
    out.flush().expect("test fixture");
}

fn park_forever() -> ! {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::process::exit(9);
}

#[test]
fn child_role_entry() {
    let Ok(role) = std::env::var(ROLE_ENV) else {
        return;
    };
    let root = PathBuf::from(std::env::var(ROOT_ENV).unwrap());
    if role == "unwind-probe" {
        child_guard::unwind_probe_role(&root);
    }
    if role == "kill-init" {
        let _ = Store::open_observed(&root, &mut |stage| {
            if stage == OpenStage::BeforePublish {
                say("BEFORE_PUBLISH");
                park_forever();
            }
            Ok(())
        });
        unreachable!("initializer was killed");
    }
    #[cfg(target_os = "linux")]
    if role == "native-busy-reopen-sync-fault" {
        // Initialize and admit the predecessor before arming directory EIO.
        // A real live writer defers startup CAS recovery, so a later recovery
        // flush cannot conceal an omitted managed-parent flush during reopen.
        let arm = PathBuf::from(std::env::var("R51_NATIVE_SYNC_DIR_ARM").unwrap());
        let store = Store::open(&root).unwrap();
        let identity = store.store_uuid().clone();
        let guard = store.lock_write(&[]).unwrap();
        let abandoned = root.join("assets/tmp/cas-00000000-0000-4000-8000-000000000051");
        std::fs::write(&abandoned, b"deferred recovery sentinel").unwrap();
        std::fs::write(&arm, b"armed").unwrap();
        let result = Store::open(&root);
        assert!(
            matches!(result, Err(StoreError::Io(ref error)) if error.raw_os_error() == Some(libc::EIO)),
            "the actual final managed-parent fsync must fail even with recovery deferred"
        );
        assert!(
            abandoned.is_file(),
            "recovery must defer to the live writer"
        );
        std::fs::remove_file(&arm).unwrap();
        let reopened = Store::open(&root).unwrap();
        assert_eq!(reopened.store_uuid(), &identity);
        assert!(
            abandoned.is_file(),
            "successful busy reopen still defers recovery"
        );
        assert!(reopened.try_lock_write(&[]).unwrap().is_none());
        drop(reopened);
        drop(guard);
        drop(store);
        let recovered = Store::open(&root).unwrap();
        assert_eq!(recovered.store_uuid(), &identity);
        assert!(!abandoned.exists(), "idle reopen resumes CAS recovery");
        drop(recovered.lock_write(&[]).unwrap());
        say("NATIVE_BUSY_REOPEN_SYNC_EIO");
        return;
    }
    #[cfg(target_os = "linux")]
    if role == "native-sync-fault" {
        let arm = PathBuf::from(std::env::var("R51_NATIVE_SYNC_ARM").unwrap());
        let result = Store::open_observed(&root, &mut |stage| {
            if stage == OpenStage::SyncState {
                std::fs::write(&arm, b"armed").unwrap();
            }
            Ok(())
        });
        assert!(
            matches!(result, Err(StoreError::Io(ref error)) if error.raw_os_error() == Some(libc::EIO)),
            "the actual initialization fsync must return EIO"
        );
        say("NATIVE_SYNC_EIO");
        return;
    }
    let store = Store::open(&root).unwrap();
    match role.as_str() {
        "kill-mid-reserve" => {
            let guard = store.lock_write(&[]).unwrap();
            let _ = store.reserve_kb_observed(&guard, new_kb("torn"), &mut || {
                say("IN_TX");
                park_forever();
            });
            unreachable!("the observer never returns");
        }
        "kill-after-commit" => {
            let guard = store.lock_write(&[]).unwrap();
            let kb = store.reserve_kb(&guard, new_kb("kept")).unwrap();
            say(&format!("COMMITTED {}", kb.id));
            park_forever();
        }
        other => panic!("unknown role {other}"),
    }
}

fn spawn_role(role: &str, root: &Path) -> ChildGuard {
    let mut command = Command::new(std::env::current_exe().expect("test fixture"));
    command
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, role)
        .env(ROOT_ENV, root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null());
    ChildGuard::spawn(&command).expect("test fixture")
}

fn wait_for_line(child: &mut ChildGuard, prefix: &str) -> String {
    let stdout = child.stdout.take().expect("test fixture");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).expect("test fixture");
        assert!(n > 0, "child exited before printing `{prefix}`");
        if let Some(rest) = line.trim_end().strip_prefix(prefix) {
            return rest.trim().to_owned();
        }
    }
}

// ── Fresh store / pragmas ───────────────────────────────────────────────────

#[test]
fn fresh_empty_store_initializes_once_with_durable_pragmas() {
    let base = temp_root("fresh");
    let root = store_dir(&base);
    let first = Store::open(&root).unwrap();
    let uuid = first.store_uuid().clone();
    let owner = first.owner().id().to_owned();
    let settings = first.connection_settings().unwrap();
    assert_eq!(settings.journal_mode, "wal");
    assert_eq!(settings.synchronous, 2, "FULL synchronous");
    assert!(settings.foreign_keys);
    assert!(settings.busy_timeout_ms >= 1000);
    assert_eq!(settings.user_version, 1);
    drop(first);

    let second = Store::open(&root).unwrap();
    assert_eq!(
        second.store_uuid(),
        &uuid,
        "identity is never reinitialized"
    );
    assert_eq!(second.owner().id(), owner);
    for dir in ["repos", "assets", "uploads", "indexes", "locks"] {
        assert!(root.join(dir).is_dir(), "{dir}");
    }
    assert!(root.join("state.sqlite").is_file());
}

#[cfg(unix)]
#[test]
fn managed_dirs_and_state_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let base = temp_root("perms");
    let root = store_dir(&base);
    let _store = Store::open(&root).unwrap();
    for rel in ["", "repos", "assets", "uploads", "indexes", "locks"] {
        let mode = std::fs::metadata(root.join(rel))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "`{rel}` mode {mode:o}");
    }
    let mode = std::fs::metadata(root.join("state.sqlite"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o077, 0, "state.sqlite mode {mode:o}");
}

// ── Recovery ────────────────────────────────────────────────────────────────

fn remove_state(root: &Path) {
    for name in ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"] {
        let _ = std::fs::remove_file(root.join(name));
    }
}

#[test]
fn nonempty_store_missing_state_fails_closed() {
    let base = temp_root("missing");
    let root = store_dir(&base);
    {
        let store = Store::open(&root).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        store.reserve_kb(&guard, new_kb("alpha")).unwrap();
    }
    remove_state(&root);
    let err = Store::open(&root).expect_err("must fail closed");
    // L-17: explained as "not a kb store", still fail-closed REPAIR_REQUIRED.
    assert_eq!(err.protocol_code(), ErrorCode::RepairRequired, "{err:?}");
    assert!(
        !root.join("state.sqlite").exists(),
        "state must never be silently recreated"
    );
    // A second attempt still fails (nothing was half-initialized).
    assert_eq!(
        Store::open(&root)
            .expect_err("still fails closed")
            .protocol_code(),
        kb_client::ErrorCode::RepairRequired
    );
}

#[test]
fn foreign_nonempty_directory_is_never_adopted() {
    let base = temp_root("foreign");
    let root = store_dir(&base);
    std::fs::create_dir_all(root.join("repos/kb_abcdefghijklmnopqrstuvwx.git")).unwrap();
    std::fs::write(root.join("notes.md"), b"hello").unwrap();
    let err = Store::open(&root).expect_err("must not adopt");
    assert_eq!(err.protocol_code(), ErrorCode::RepairRequired, "{err:?}");
    assert!(err.to_string().contains("is not a kb store"), "{err}");
    assert!(!root.join("state.sqlite").exists());
}

#[test]
fn corrupt_or_uninitialized_state_fails_closed() {
    let base = temp_root("corrupt");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    remove_state(&root);
    // A zero-length / non-kb SQLite file must not be treated as fresh.
    std::fs::write(root.join("state.sqlite"), b"").unwrap();
    let err = Store::open(&root).expect_err("fails closed");
    assert!(matches!(err, StoreError::RecoveryRequired(_)), "{err:?}");
}

// ── FK / transaction durability ─────────────────────────────────────────────

#[test]
fn foreign_keys_are_enforced_on_the_store_connection() {
    let base = temp_root("fk");
    let store = Store::open(&store_dir(&base)).unwrap();
    let guard = store.lock_write(&[]).unwrap();
    let a = store.reserve_kb(&guard, new_kb("fk-a")).unwrap();
    let conn = rusqlite::Connection::open(store.paths().state_db()).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    assert!(
        conn.execute(
            "UPDATE kbs SET active_generation_id=?2 WHERE id=?1",
            (a.id.as_str(), "zzzzzzzzzzzzzzzzzzzzzzzz")
        )
        .is_err()
    );
    assert_eq!(store.kb(&a.id).unwrap().unwrap().active_generation_id, None);
}

#[test]
fn transaction_killed_before_commit_leaves_no_row() {
    let base = temp_root("kill-tx");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    let mut child = spawn_role("kill-mid-reserve", &root);
    wait_for_line(&mut child, "IN_TX");
    child.kill().unwrap();
    child.wait().unwrap();

    let store = Store::open(&root).unwrap();
    assert!(
        store.list_kbs().unwrap().is_empty(),
        "aborted tx left a row"
    );
    // Startup reconciliation is opportunistic while admission is busy; the
    // first write admission must have reconciled before it is granted.
    let guard = store.lock_write(&[]).unwrap();
    assert!(
        std::fs::read_dir(root.join("repos"))
            .unwrap()
            .next()
            .is_none(),
        "pre-commit repo directory must be reconciled"
    );
    // The store is writable again once the dead owner's lock is gone.
    let kb = store.reserve_kb(&guard, new_kb("torn")).unwrap();
    assert_eq!(store.list_kbs().unwrap().len(), 1);
    assert_eq!(kb.slug, "torn");
}

#[test]
fn committed_reservation_survives_kill() {
    let base = temp_root("kill-commit");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    let mut child = spawn_role("kill-after-commit", &root);
    let id = wait_for_line(&mut child, "COMMITTED");
    child.kill().unwrap();
    child.wait().unwrap();
    let store = Store::open(&root).unwrap();
    let id = KbId::parse(&id).unwrap();
    let kb = store
        .kb(&id)
        .unwrap()
        .expect("FULL synchronous commit kept");
    assert_eq!(kb.slug, "kept");
    assert!(store.paths().repo_dir(&id).is_dir());
}

// ── Paths: canonicalization and case collisions ─────────────────────────────

#[test]
fn managed_paths_never_collapse_distinct_ids() {
    let base = temp_root("paths");
    let store = Store::open(&store_dir(&base)).unwrap();
    let guard = store.lock_write(&[]).unwrap();
    let mut repo_keys = BTreeSet::new();
    let mut index_keys = BTreeSet::new();
    for i in 0..12 {
        let kb = store
            .reserve_kb(&guard, new_kb(&format!("kb-{i}")))
            .unwrap();
        let repo = store.paths().repo_dir(&kb.id);
        assert_eq!(
            repo.file_name().unwrap().to_str().unwrap(),
            format!("kb_{}.git", kb.id)
        );
        assert_eq!(repo.parent().unwrap(), store.paths().root().join("repos"));
        // Compare case-insensitively: distinct on a case-folding filesystem.
        assert!(repo_keys.insert(repo.to_string_lossy().to_lowercase()));
        let generation = kb.id.clone();
        let file = store.paths().index_file(&kb.id, &generation);
        assert!(index_keys.insert(file.to_string_lossy().to_lowercase()));
    }
    // Only lowercase IDs exist, so no two IDs can differ only by case, and
    // traversal / separators are unrepresentable.
    for bad in [
        "ABCDEFGHIJKLMNOPQRSTUVWX",
        "abcdefghijklmnopqrstuvwX",
        "../abcdefghijklmnopqrstuv",
        "abcdefghijk/mnopqrstuvwx",
        "abcdefghijk\\mnopqrstuvwx",
        "short",
    ] {
        assert!(KbId::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn preexisting_repo_dir_is_not_adopted() {
    let base = temp_root("adopt");
    let root = store_dir(&base);
    let store = Store::open(&root).unwrap();
    let stray = KbId::parse("abcdefghijklmnopqrstuvwx").unwrap();
    std::fs::create_dir(store.paths().repo_dir(&stray)).unwrap();
    assert!(store.kb(&stray).unwrap().is_none());
    assert!(store.list_kbs().unwrap().is_empty());
}

// ── Symlink / reparse jail ──────────────────────────────────────────────────

fn outside_with_sentinel(base: &Path) -> PathBuf {
    let outside = base.join("outside");
    std::fs::create_dir_all(&outside).expect("test fixture");
    std::fs::write(outside.join("sentinel"), b"untouched").expect("test fixture");
    outside
}

fn assert_outside_untouched(outside: &Path) {
    let entries: Vec<_> = std::fs::read_dir(outside)
        .expect("test fixture")
        .map(|e| e.expect("test fixture").file_name())
        .collect();
    assert_eq!(entries, vec![std::ffi::OsString::from("sentinel")]);
    assert_eq!(
        std::fs::read(outside.join("sentinel")).expect("test fixture"),
        b"untouched"
    );
}

#[test]
fn symlinked_managed_dir_is_refused() {
    let base = temp_root("symlink-dir");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    let outside = outside_with_sentinel(&base);
    std::fs::remove_dir(root.join("indexes")).unwrap();
    link_dir(&outside, &root.join("indexes"));
    let err = Store::open(&root).expect_err("symlinked indexes refused");
    assert!(matches!(err, StoreError::UnsafePath(_)), "{err:?}");
    assert_outside_untouched(&outside);
}

#[test]
fn symlink_swapped_after_open_never_writes_outside() {
    let base = temp_root("symlink-repos");
    let root = store_dir(&base);
    let store = Store::open(&root).unwrap();
    let outside = outside_with_sentinel(&base);
    std::fs::remove_dir(root.join("repos")).unwrap();
    link_dir(&outside, &root.join("repos"));
    let err = match store.lock_write(&[]) {
        Err(error) => error,
        Ok(guard) => store
            .reserve_kb(&guard, new_kb("escape"))
            .expect_err("reservation through a symlink refused"),
    };
    assert!(matches!(err, StoreError::UnsafePath(_)), "{err:?}");
    assert!(
        store.list_kbs().unwrap().is_empty(),
        "no row for a refused dir"
    );
    assert_outside_untouched(&outside);
}

#[test]
fn symlinked_state_file_is_refused() {
    let base = temp_root("symlink-state");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    let outside = outside_with_sentinel(&base);
    remove_state(&root);
    link_file(&outside.join("sentinel"), &root.join("state.sqlite"));
    let err = Store::open(&root).expect_err("symlinked state refused");
    assert!(
        matches!(
            err,
            StoreError::UnsafePath(_) | StoreError::RecoveryRequired(_)
        ),
        "{err:?}"
    );
    assert_outside_untouched(&outside);
}

#[test]
fn symlinked_lock_dir_is_refused() {
    let base = temp_root("symlink-locks");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    let outside = outside_with_sentinel(&base);
    std::fs::remove_dir_all(root.join("locks")).unwrap();
    link_dir(&outside, &root.join("locks"));
    let err = Store::open(&root).expect_err("symlinked locks refused");
    assert!(matches!(err, StoreError::UnsafePath(_)), "{err:?}");
    assert_outside_untouched(&outside);
}

// ── Identity ────────────────────────────────────────────────────────────────

#[test]
fn local_attachment_matches_golden_vectors() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../packages/api/src/lib/kb/fixtures/attachment.json");
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
    let mut checked = 0;
    for vector in json["vectors"].as_array().unwrap() {
        if vector["kind"] != "local" {
            continue;
        }
        let store = Uuid::parse(vector["storeUuid"].as_str().unwrap()).unwrap();
        let kb = KbId::parse(vector["kbId"].as_str().unwrap()).unwrap();
        let (locator, namespace) = kb_local::local_attachment(&store, &kb);
        assert_eq!(locator, vector["locator"].as_str().unwrap());
        assert_eq!(namespace.as_str(), vector["namespace"].as_str().unwrap());
        checked += 1;
    }
    assert!(checked >= 1, "fixture has local vectors");
}

#[test]
fn store_attachment_is_stable_and_distinct_per_kb() {
    let base = temp_root("attach");
    let root = store_dir(&base);
    let (a, b, la, na) = {
        let store = Store::open(&root).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        let a = store.reserve_kb(&guard, new_kb("att-a")).unwrap();
        let b = store.reserve_kb(&guard, new_kb("att-b")).unwrap();
        let (la, na) = store.attachment(&a.id);
        assert_eq!(la, format!("kb-local://{}/{}", store.store_uuid(), a.id));
        let (_, nb) = store.attachment(&b.id);
        assert_ne!(na, nb);
        (a.id, b.id, la, na)
    };
    let store = Store::open(&root).unwrap();
    assert_eq!(store.attachment(&a), (la, na));
    let _ = b;
}

// ── Authority ───────────────────────────────────────────────────────────────

#[test]
fn permission_expansion_matches_shared_rules() {
    let cases: &[(&[Permission], &[Permission])] = &[
        (&[Permission::Read], &[Permission::Read]),
        (
            &[Permission::Propose],
            &[Permission::Read, Permission::Propose],
        ),
        (
            &[Permission::Write],
            &[Permission::Read, Permission::Propose, Permission::Write],
        ),
        (
            &[Permission::Review],
            &[Permission::Read, Permission::Review],
        ),
        (
            &[Permission::Manage],
            &[
                Permission::Read,
                Permission::Propose,
                Permission::Write,
                Permission::Review,
                Permission::Manage,
            ],
        ),
        (&[], &[]),
    ];
    for (input, expected) in cases {
        let bits = Bits::from_permissions(input).expand();
        assert_eq!(bits.permissions(), expected.to_vec(), "{input:?}");
    }
    // Write never implies review.
    assert!(
        !Bits::from_permissions(&[Permission::Write])
            .expand()
            .contains(Permission::Review)
    );
}

#[test]
fn owner_has_all_bits_and_narrowed_principals_are_capped() {
    let base = temp_root("authz");
    let store = Store::open(&store_dir(&base)).unwrap();
    let guard = store.lock_write(&[]).unwrap();
    let kb = store.reserve_kb(&guard, new_kb("authz")).unwrap();
    let owner = store.owner();
    assert_eq!(owner.kind(), PrincipalKind::Owner);
    let bits = store.authorize(&owner, &kb.id, Permission::Manage).unwrap();
    assert_eq!(bits, Bits::ALL);

    let tester = store
        .register_principal(&guard, PrincipalKind::Test, &kb.id, &[Permission::Propose])
        .unwrap();
    assert_ne!(tester.id(), owner.id());
    let bits = store
        .authorize(&tester, &kb.id, Permission::Propose)
        .unwrap();
    assert_eq!(
        bits.permissions(),
        vec![Permission::Read, Permission::Propose]
    );
    let err = store
        .authorize(&tester, &kb.id, Permission::Write)
        .err()
        .unwrap();
    assert_eq!(err.protocol_code(), ErrorCode::Forbidden);

    // No ceiling row on another KB: not even existence is disclosed.
    let other = store.reserve_kb(&guard, new_kb("authz-other")).unwrap();
    let err = store
        .authorize(&tester, &other.id, Permission::Read)
        .err()
        .unwrap();
    assert_eq!(err.protocol_code(), ErrorCode::NotFound);

    // Unknown KB is NOT_FOUND even for the owner.
    let unknown = KbId::parse("zzzzzzzzzzzzzzzzzzzzzzzz").unwrap();
    let err = store
        .authorize(&owner, &unknown, Permission::Read)
        .err()
        .unwrap();
    assert_eq!(err.protocol_code(), ErrorCode::NotFound);

    // A principal cannot be registered with the owner kind.
    assert!(
        store
            .register_principal(&guard, PrincipalKind::Owner, &kb.id, &[Permission::Read])
            .is_err()
    );
}

fn link_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("directory symlink");
    #[cfg(windows)]
    assert!(
        Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(windows_plain_path(link))
            .arg(windows_plain_path(target))
            .stdout(Stdio::null())
            .status()
            .expect("create junction")
            .success()
    );
}

#[test]
fn nested_managed_component_link_is_refused() {
    let base = temp_root("nested-link");
    let root = store_dir(&base);
    let store = Store::open(&root).unwrap();
    let outside = outside_with_sentinel(&base);
    let kb = KbId::parse("nestedlinkaaaaaaaaaaaaaa").unwrap();
    let path = store.paths().ensure_index_dir(&kb).unwrap();
    std::fs::remove_dir(&path).unwrap();
    link_dir(&outside, &path);
    assert!(matches!(
        store.paths().ensure_index_dir(&kb),
        Err(StoreError::UnsafePath(_))
    ));
    assert!(matches!(
        store.paths().check_no_follow(&path.join("deeper/file")),
        Err(StoreError::UnsafePath(_))
    ));
    assert_outside_untouched(&outside);
}

#[cfg(windows)]
fn acl_probe(path: &Path, action: &str) -> bool {
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/acl-probe.ps1"))
        .arg(windows_plain_path(path))
        .arg(action)
        .status()
        .expect("ACL probe")
        .success()
}

#[cfg(windows)]
#[test]
fn windows_managed_dirs_and_created_files_have_owner_only_acls() {
    let base = temp_root("acls");
    let root = store_dir(&base);
    let store = Store::open(&root).unwrap();
    let receipt = store
        .create_kb(
            &store.owner(),
            kb_local::CreateKbRequest {
                name: "ACL fixture".into(),
                slug: "acl".into(),
                description: "A private Windows knowledge base".into(),
                idempotency_key: "acl-fixture-000001".into(),
            },
        )
        .unwrap();
    let guard = store.lock_write(&[]).unwrap();
    let index = store.paths().ensure_index_dir(&receipt.kb_id).unwrap();
    for path in [
        store.paths().root().to_path_buf(),
        store.paths().state_db(),
        root.join("locks"),
        root.join("locks/store.lock"),
        root.join("repos"),
        store.paths().repo_dir(&receipt.kb_id),
        store.paths().repo_dir(&receipt.kb_id).join("config"),
        store
            .paths()
            .repo_dir(&receipt.kb_id)
            .join("refs/heads/main"),
        index,
        root.join("assets"),
        root.join("uploads"),
    ] {
        assert!(acl_probe(&path, "verify"), "ACL: {}", path.display());
    }
    drop(guard);
    drop(store);
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_broadened_managed_acl_is_refused_without_repairing_it() {
    let base = temp_root("broad-acl");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    let target = root.join("indexes");
    assert!(acl_probe(&target, "broaden"));
    assert!(matches!(Store::open(&root), Err(StoreError::UnsafePath(_))));
    assert!(
        !acl_probe(&target, "verify"),
        "must not silently adopt broadened ACL"
    );
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn widened_existing_root_and_managed_directories_fail_closed() {
    use std::os::unix::fs::PermissionsExt;
    for rel in ["", "locks", "repos", "assets", "uploads", "indexes"] {
        let base = temp_root("wide-reopen");
        let root = store_dir(&base);
        let store = Store::open(&root).unwrap();
        let identity = store.store_uuid().clone();
        drop(store);
        let before = std::fs::read(root.join("state.sqlite")).unwrap();
        std::fs::set_permissions(root.join(rel), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            matches!(Store::open(&root), Err(StoreError::UnsafePath(_))),
            "{rel}"
        );
        assert_eq!(std::fs::read(root.join("state.sqlite")).unwrap(), before);
        std::fs::set_permissions(root.join(rel), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(Store::open(&root).unwrap().store_uuid(), &identity);
    }
}

#[test]
fn unrelated_init_prefixed_entries_and_invalid_scratch_types_are_preserved() {
    for (name, directory) in [
        ("state.sqlite.init.foreign", false),
        ("state.sqlite.init.foreign", true),
        ("state.sqlite.init", true),
        ("locks/foreign", false),
    ] {
        let base = temp_root("foreign-init");
        let root = store_dir(&base);
        std::fs::create_dir(&root).unwrap();
        let path = root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        if directory {
            std::fs::create_dir(&path).unwrap();
        } else {
            std::fs::write(&path, b"operator data").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
        assert!(Store::open(&root).is_err(), "{name}, directory={directory}");
        assert!(path.exists());
        if !directory {
            assert_eq!(std::fs::read(&path).unwrap(), b"operator data");
        }
        assert!(!root.join("state.sqlite").exists());
    }
}

#[test]
fn real_first_init_kill_discards_exact_scratch_family_and_keeps_one_identity() {
    let base = temp_root("init-kill");
    let root = store_dir(&base);
    let mut child = spawn_role("kill-init", &root);
    wait_for_line(&mut child, "BEFORE_PUBLISH");
    assert!(root.join("state.sqlite.init").metadata().unwrap().len() > 0);
    assert!(!root.join("state.sqlite").exists());
    child.kill().unwrap();
    child.wait().unwrap();
    // SQLite may have removed sidecars on close. Seed every legitimate
    // interrupted member to check the cleanup bound, without changing state.
    for suffix in ["-journal", "-wal", "-shm"] {
        std::fs::write(
            root.join(format!("state.sqlite.init{suffix}")),
            b"interrupted",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join(format!("state.sqlite.init{suffix}")),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
    }
    let store = Store::open(&root).unwrap();
    let uuid = store.store_uuid().clone();
    for suffix in ["", "-journal", "-wal", "-shm"] {
        assert!(!root.join(format!("state.sqlite.init{suffix}")).exists());
    }
    drop(store);
    assert_eq!(Store::open(&root).unwrap().store_uuid(), &uuid);
}

#[test]
fn explicit_init_sync_failure_never_publishes_and_retry_succeeds() {
    let base = temp_root("init-sync-error");
    let root = store_dir(&base);
    let mut reached_sync = false;
    let result = Store::open_observed(&root, &mut |stage| {
        if stage == OpenStage::SyncState {
            reached_sync = true;
            return Err(StoreError::Io(std::io::Error::from(
                std::io::ErrorKind::Other,
            )));
        }
        if stage == OpenStage::BeforePublish {
            panic!("publish after a failed sync");
        }
        Ok(())
    });
    assert!(reached_sync);
    assert!(matches!(result, Err(StoreError::Io(_))));
    assert!(!root.join("state.sqlite").exists());
    assert!(root.join("state.sqlite.init").exists());
    let store = Store::open(&root).unwrap();
    let uuid = store.store_uuid().clone();
    drop(store);
    assert_eq!(Store::open(&root).unwrap().store_uuid(), &uuid);
}

#[cfg(unix)]
#[test]
fn broadened_managed_directory_mode_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let base = temp_root("broadened-mode");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    std::fs::set_permissions(root.join("indexes"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(Store::open(&root), Err(StoreError::UnsafePath(_))));
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(windows)]
fn windows_plain_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut parts = path.components();
    match parts.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::VerbatimDisk(drive) => {
                PathBuf::from(format!("{}:", char::from(drive))).join(parts.as_path())
            }
            Prefix::VerbatimUNC(server, share) => PathBuf::from(r"\\")
                .join(server)
                .join(share)
                .join(parts.as_path()),
            _ => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

fn link_file(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("file symlink");
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(target, link)
        .expect("file symlink (Windows CI has symlink privilege)");
}

#[cfg(unix)]
#[test]
fn new_ancestor_and_managed_entries_are_synced_and_sync_errors_propagate() {
    let owned_base = temp_root("ancestor-sync");
    let base = owned_base.canonicalize().unwrap();
    let parent = base.join("new-parent");
    let root = parent.join("store");
    let mut directories = Vec::new();
    let store = Store::open_observed(&root, &mut |stage| {
        if let OpenStage::SyncDirectory(path) = stage {
            directories.push(path);
        }
        Ok(())
    })
    .unwrap();
    assert!(
        directories.contains(&base),
        "new ancestor entry must be durable"
    );
    assert!(
        directories.contains(&parent),
        "store root entry must be durable"
    );
    assert!(
        directories.iter().filter(|d| **d == root).count() >= 6,
        "lock and managed directory entries must be durable"
    );
    assert!(store.paths().root().join("repos").is_dir());
    let failed_root = base.join("failed-parent/store");
    let result = Store::open_observed(&failed_root, &mut |stage| {
        if stage == OpenStage::SyncDirectory(base.clone()) {
            return Err(StoreError::Io(std::io::Error::from(
                std::io::ErrorKind::Other,
            )));
        }
        Ok(())
    });
    assert!(matches!(result, Err(StoreError::Io(_))));
    assert!(!failed_root.join("state.sqlite").exists());
    assert!(
        Store::open(&failed_root).is_ok(),
        "retry must sync interrupted ancestors too"
    );
}

#[cfg(unix)]
#[test]
fn acknowledged_reopen_flushes_managed_parent_once_without_ancestor_syncs() {
    let owned_base = temp_root("reopen-sync");
    let base = owned_base.canonicalize().unwrap();
    let root = base.join("store");
    let store = Store::open(&root).unwrap();
    let identity = store.store_uuid().clone();
    drop(store);
    let mut directories = Vec::new();
    let store = Store::open_observed(&root, &mut |stage| {
        if let OpenStage::SyncDirectory(path) = stage {
            directories.push(path);
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(store.store_uuid(), &identity);
    assert_eq!(directories, vec![root]);
}

#[cfg(unix)]
#[test]
fn first_init_flushes_preexisting_ancestors_before_state_publication() {
    use std::os::unix::fs::DirBuilderExt;
    let owned_base = temp_root("existing-init-sync");
    let base = owned_base.canonicalize().unwrap();
    let parent = base.join("parent");
    let root = parent.join("store");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&parent)
        .unwrap();
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .unwrap();
    let mut ancestors = Vec::new();
    let mut state_synced = false;
    let store = Store::open_observed(&root, &mut |stage| {
        match stage {
            OpenStage::SyncDirectory(path) if !state_synced => ancestors.push(path),
            OpenStage::SyncState => {
                assert!(ancestors.contains(&base));
                assert!(ancestors.contains(&parent));
                state_synced = true;
            }
            _ => {}
        }
        Ok(())
    })
    .unwrap();
    assert!(state_synced);
    let identity = store.store_uuid().clone();
    drop(store);
    assert_eq!(Store::open(&root).unwrap().store_uuid(), &identity);
}

#[cfg(unix)]
#[test]
fn published_store_finishes_interrupted_managed_directory_installation() {
    let owned_base = temp_root("interrupted-managed-sync");
    let base = owned_base.canonicalize().unwrap();
    let root = base.join("store");
    let store = Store::open(&root).unwrap();
    let identity = store.store_uuid().clone();
    drop(store);
    // State publication precedes managed directory installation. Reconstruct
    // that restart window while preserving the published authority database.
    // Open-time recovery creates the empty CAS temp directory, which cannot
    // exist before its managed parent is installed.
    for dir in ["repos", "assets", "uploads", "indexes"] {
        remove_empty_managed_fixture_dir(&root, dir).unwrap();
    }
    let mut directories = Vec::new();
    let store = Store::open_observed(&root, &mut |stage| {
        if let OpenStage::SyncDirectory(path) = stage {
            directories.push(path);
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(directories, vec![root.clone(); 5]);
    assert_eq!(store.store_uuid(), &identity);
    for dir in kb_local::paths::MANAGED_DIRS {
        assert!(root.join(dir).is_dir());
    }
    drop(store);
    let result = Store::open_observed(&root, &mut |stage| {
        if stage == OpenStage::SyncDirectory(root.clone()) {
            return Err(StoreError::Io(std::io::Error::from(
                std::io::ErrorKind::Other,
            )));
        }
        Ok(())
    });
    assert!(matches!(result, Err(StoreError::Io(_))));
    assert_eq!(Store::open(&root).unwrap().store_uuid(), &identity);
}

#[test]
fn empty_managed_fixture_cleanup_covers_every_directory_after_open_recovery() {
    let base = temp_root("managed-fixture-cleanup");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    for rel in kb_local::paths::MANAGED_DIRS {
        remove_empty_managed_fixture_dir(&root, rel).unwrap();
        assert!(!root.join(rel).exists(), "{rel}");
    }
}

#[test]
fn managed_fixture_cleanup_refuses_unexpected_data() {
    for rel in ["repos", "assets", "locks"] {
        let base = temp_root("managed-fixture-data");
        let root = store_dir(&base);
        drop(Store::open(&root).unwrap());
        let sentinel = if rel == "assets" {
            root.join(rel).join("tmp/operator-file")
        } else {
            root.join(rel).join("operator-file")
        };
        std::fs::write(&sentinel, b"unchanged").unwrap();
        assert!(
            remove_empty_managed_fixture_dir(&root, rel).is_err(),
            "{rel}"
        );
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"unchanged");
    }
}

#[test]
fn orphan_reconcile_keeps_registered_and_unknown_nonempty_data() {
    let base = temp_root("orphan-bound");
    let root = store_dir(&base);
    let store = Store::open(&root).unwrap();
    let guard = store.lock_write(&[]).unwrap();
    let kb = store.reserve_kb(&guard, new_kb("registered")).unwrap();
    drop(guard);
    let unknown = KbId::parse("unregisteredaaaaaaaaaaaa").unwrap();
    let path = store.paths().repo_dir(&unknown);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
    }
    #[cfg(windows)]
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("operator-file"), b"keep").unwrap();
    drop(store);
    // Open reconciles when startup admission is free; otherwise the first
    // write admission must refuse the same nonempty unregistered repo.
    assert!(matches!(
        Store::open(&root).and_then(|store| store.lock_write(&[]).map(drop)),
        Err(StoreError::RecoveryRequired(_))
    ));
    assert_eq!(std::fs::read(path.join("operator-file")).unwrap(), b"keep");
    assert!(
        root.join("repos")
            .join(format!("kb_{}.git", kb.id))
            .exists()
    );
}

#[cfg(windows)]
#[test]
fn widened_windows_acls_on_existing_roots_dirs_and_state_are_rejected() {
    for rel in [
        "",
        "locks",
        "repos",
        "assets",
        "uploads",
        "indexes",
        "state.sqlite",
    ] {
        let base = temp_root("windows-acl");
        let root = store_dir(&base);
        let store = Store::open(&root).unwrap();
        let identity = store.store_uuid().clone();
        drop(store);
        let before = std::fs::read(root.join("state.sqlite")).unwrap();
        let output = Command::new("icacls")
            .arg(root.join(rel))
            .args(["/grant", "*S-1-1-0:F"])
            .output()
            .unwrap();
        assert!(output.status.success(), "icacls failed: {output:?}");
        assert!(
            matches!(Store::open(&root), Err(StoreError::UnsafePath(_))),
            "{rel}"
        );
        assert_eq!(std::fs::read(root.join("state.sqlite")).unwrap(), before);
        let output = Command::new("icacls")
            .arg(root.join(rel))
            .args(["/remove:g", "*S-1-1-0"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(Store::open(&root).unwrap().store_uuid(), &identity);
    }
}

#[cfg(windows)]
#[test]
fn windows_managed_directory_junctions_and_state_symlink_never_change_outside() {
    use std::os::windows::fs::symlink_file;
    for rel in ["locks", "repos", "assets", "uploads", "indexes"] {
        let base = temp_root("windows-junction");
        let root = store_dir(&base);
        drop(Store::open(&root).unwrap());
        let outside = base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), b"unchanged").unwrap();
        let managed = root.join(rel);
        remove_empty_managed_fixture_dir(&root, rel).unwrap();
        let output = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&managed)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed: {output:?}"
        );
        assert!(matches!(Store::open(&root), Err(StoreError::UnsafePath(_))));
        assert_eq!(
            std::fs::read(outside.join("sentinel")).unwrap(),
            b"unchanged"
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
    }
    let base = temp_root("windows-file-link");
    let root = store_dir(&base);
    drop(Store::open(&root).unwrap());
    let outside = base.join("outside-file");
    std::fs::write(&outside, b"unchanged").unwrap();
    remove_state(&root);
    symlink_file(&outside, root.join("state.sqlite"))
        .expect("Windows CI must allow the real reparse fixture");
    assert!(matches!(Store::open(&root), Err(StoreError::UnsafePath(_))));
    assert_eq!(std::fs::read(&outside).unwrap(), b"unchanged");
}

#[cfg(target_os = "linux")]
#[test]
fn native_initialization_file_and_directory_fsync_eio_prevents_publication_and_retry_succeeds() {
    let base = temp_root("native-fsync-eio");
    let root = store_dir(&base);
    let source = base.join("fsync_fault.c");
    let library = base.join("fsync_fault.so");
    let arm = base.join("armed");
    // Fault the actual fsync syscall wrapper only after the explicit init-sync
    // stage arms it. SQLite's preceding FULL/checkpoint writes remain real.
    std::fs::write(&source, r#"
#define _GNU_SOURCE
#include <dlfcn.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/stat.h>
int fsync(int fd) {
    char link[64], path[4096];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, path, sizeof(path)-1);
    const char *arm = getenv("R51_NATIVE_SYNC_ARM");
    const char *name = "state.sqlite.init";
    if (n >= 0) {
        path[n] = 0;
        const char *directory = getenv("R51_NATIVE_SYNC_DIR");
        const char *directory_arm = getenv("R51_NATIVE_SYNC_DIR_ARM");
        struct stat metadata;
        if (directory && (!directory_arm || access(directory_arm, F_OK)==0) && strcmp(directory, path)==0 && fstat(fd, &metadata)==0 && S_ISDIR(metadata.st_mode)) {
            errno = EIO;
            return -1;
        }
        size_t size = strlen(name);
        if ((size_t)n >= size && strcmp(path+n-size, name)==0 && arm && access(arm, F_OK)==0) {
            errno = EIO;
            return -1;
        }
    }
    int (*real_sync)(int) = dlsym(RTLD_NEXT, "fsync");
    return real_sync(fd);
}
"#).unwrap();
    let compiler = Command::new("cc")
        .args(["-shared", "-fPIC", "-o"])
        .arg(&library)
        .arg(&source)
        .arg("-ldl")
        .output()
        .unwrap();
    assert!(
        compiler.status.success(),
        "native fault fixture compiler failed: {compiler:?}"
    );
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, "native-sync-fault")
        .env(ROOT_ENV, &root)
        .env("R51_NATIVE_SYNC_ARM", &arm)
        .env("LD_PRELOAD", &library)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native fsync fault was not observed: {output:?}"
    );
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("NATIVE_SYNC_EIO")
    );
    assert!(!root.join("state.sqlite").exists());
    assert!(root.join("state.sqlite.init").metadata().unwrap().len() > 0);
    let store = Store::open(&root).unwrap();
    let identity = store.store_uuid().clone();
    drop(store);
    assert_eq!(Store::open(&root).unwrap().store_uuid(), &identity);

    // Also fault the actual containing-directory fsync for a newly created
    // root, before any identity bytes exist. This discriminates missing
    // ancestor flushes from merely recording an observer event.
    let parent = base.join("new-ancestor");
    let directory_root = parent.join("store");
    let directory_arm = base.join("directory-arm");
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, "native-sync-fault")
        .env(ROOT_ENV, &directory_root)
        .env("R51_NATIVE_SYNC_ARM", &directory_arm)
        .env(
            "R51_NATIVE_SYNC_DIR",
            base.canonicalize().unwrap().join("new-ancestor"),
        )
        .env("LD_PRELOAD", &library)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native directory fsync fault was not observed: {output:?}"
    );
    assert!(
        !directory_arm.exists(),
        "directory failure must precede state initialization"
    );
    assert!(!directory_root.join("state.sqlite").exists());
    assert!(!directory_root.join("state.sqlite.init").exists());
    assert!(
        Store::open(&directory_root).is_ok(),
        "retry must finish interrupted ancestor persistence"
    );

    // A crashed creator can leave both ancestors present but unacknowledged.
    // Fault the actual ancestor fsync in initialize_locked, not its observer.
    use std::os::unix::fs::DirBuilderExt;
    let parent = base.join("preexisting-ancestor");
    let existing_root = parent.join("store");
    for dir in [&parent, &existing_root] {
        std::fs::DirBuilder::new().mode(0o700).create(dir).unwrap();
    }
    let existing_arm = base.join("existing-arm");
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, "native-sync-fault")
        .env(ROOT_ENV, &existing_root)
        .env("R51_NATIVE_SYNC_ARM", &existing_arm)
        .env("R51_NATIVE_SYNC_DIR", parent.canonicalize().unwrap())
        .env("LD_PRELOAD", &library)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "preexisting ancestor fsync skipped: {output:?}"
    );
    assert!(!existing_arm.exists());
    assert!(!existing_root.join("state.sqlite").exists());
    assert!(!existing_root.join("state.sqlite.init").exists());
    assert!(Store::open(&existing_root).is_ok());

    // Published state does not certify later managed-dir installation. The
    // one final root flush remains a real syscall, and its failure propagates.
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, "native-sync-fault")
        .env(ROOT_ENV, &root)
        .env("R51_NATIVE_SYNC_ARM", base.join("reopen-arm"))
        .env("R51_NATIVE_SYNC_DIR", root.canonicalize().unwrap())
        .env("LD_PRELOAD", &library)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "published root fsync skipped: {output:?}"
    );
    assert_eq!(Store::open(&root).unwrap().store_uuid(), &identity);

    // Keep the idle-reopen case above, and independently fault the same native
    // flush with a predecessor holding the real OS lock. Only the required
    // pre-recovery managed-parent syscall can then produce this EIO.
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "child_role_entry",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(ROLE_ENV, "native-busy-reopen-sync-fault")
        .env(ROOT_ENV, &root)
        .env("R51_NATIVE_SYNC_DIR", root.canonicalize().unwrap())
        .env("R51_NATIVE_SYNC_DIR_ARM", base.join("busy-reopen-arm"))
        .env("LD_PRELOAD", &library)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "busy-reopen managed-parent fsync skipped: {output:?}"
    );
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("NATIVE_BUSY_REOPEN_SYNC_EIO")
    );
    assert_eq!(Store::open(&root).unwrap().store_uuid(), &identity);
}

#[test]
fn crash_helper_unwind_drains_before_directory_removal() {
    let removed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = removed.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut root = temp_root("unwind-writer");
        std::fs::create_dir_all(&root).expect("probe root");
        // Construction of a second child fails after the first was admitted.
        // Vec must own the first tree throughout this partial construction.
        let _children: Vec<ChildGuard> = (0..2)
            .map(|index| {
                assert_eq!(index, 0, "injected failure constructing the second child");
                let child = spawn_role("unwind-probe", &root);
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
