//! Cross-process serialization of durable state + Git
//! reservation. Child processes are re-executions of this test binary in a
//! role selected by environment (see `child_role_entry`).

#[path = "support/fixture.rs"]
mod fixture;

#[path = "support/temp_dir.rs"]
mod temp_dir;
use temp_dir::TestDir;

use fixture::ChildGuard;
use fixture::child_guard;
#[cfg(unix)]
use fixture::os_locks_available;
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use kb_client::types::KbId;
use kb_local::{NewKb, Store, StoreError};

/// Preserve the real production handoff and its pipes. The native fixture
/// scope owns descendants, even after this direct child's successful wait;
/// this guard additionally kills/reaps the direct child on local unwinding.
struct HandoffChild(kb_local::git_read::ProcessChild);
impl HandoffChild {
    fn spawn(
        guard: &kb_local::locks::WriteGuard,
        command: Command,
    ) -> Result<Self, kb_local::StoreError> {
        assert!(
            std::env::var_os("KB_TEST_FIXTURE_SCOPE").is_some(),
            "handoff children require a native fixture scope"
        );
        guard.spawn(command).map(Self)
    }
}
impl std::ops::Deref for HandoffChild {
    type Target = kb_local::git_read::ProcessChild;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for HandoffChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for HandoffChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        if let Err(error) = self.0.wait() {
            use std::io::Write;
            let _ = writeln!(std::io::stderr(), "handoff-child drainage failed: {error}");
            std::process::abort();
        }
    }
}

const ROLE_ENV: &str = "KB_LOCAL_LOCKS_TEST_ROLE";
const ROOT_ENV: &str = "KB_LOCAL_LOCKS_TEST_ROOT";
const PROBE_ENV: &str = "KB_LOCAL_LOCKS_TEST_PROBE";
const RELEASE_ENV: &str = "KB_LOCAL_LOCKS_TEST_RELEASE";

fn temp_base(tag: &str) -> TestDir {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("test fixture")
        .as_nanos();
    let base = std::env::temp_dir().join(format!(
        "kb-local-locks-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&base).expect("test fixture");
    TestDir::new(base)
}

// A handoff child can exit while its inherited-lock descendant remains alive.
// Run those assertions under the existing native owner, with the directory
// owned here in the parent, never by the body that can panic or be killed.
fn handoff_fixture(tag: &str, panics: bool, body: impl FnOnce(&Path)) {
    const FIXTURE: &str = "KB_TEST_HANDOFF_FIXTURE";
    if let Some(root) = std::env::var_os(FIXTURE) {
        body(Path::new(&root));
        return;
    }
    let mut base = temp_base(tag);
    if panics {
        let path = base.to_path_buf();
        base.before_remove(move || {
            let pids = child_guard::writer_pids(&path);
            assert!(path.exists(), "check runs before actual rm");
            child_guard::assert_dead(&pids);
        });
    }
    let thread = std::thread::current();
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .args([
            "--exact",
            thread.name().expect("test name"),
            "--nocapture",
            "--test-threads=1",
        ])
        .env(FIXTURE, &*base);
    let output = ChildGuard::spawn(&command)
        .expect("native handoff scope")
        .wait_with_output()
        .expect("handoff scope output");
    assert_eq!(
        output.status.success(),
        !panics,
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    if panics {
        assert!(
            base.join("unwind-admitted").exists(),
            "panic must follow actual handoff admission"
        );
    }
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    // Leading newline: libtest prints `test child_role_entry ... ` without one.
    writeln!(out, "\n{line}").expect("test fixture");
    out.flush().expect("test fixture");
}

fn wait_for_file(path: &Path, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn race_kb() -> NewKb {
    NewKb {
        name: "Race".to_owned(),
        slug: "race".to_owned(),
        description: "Contended reservation".to_owned(),
    }
}

#[test]
fn child_role_entry() {
    let Ok(role) = std::env::var(ROLE_ENV) else {
        return;
    };
    if role == "unwind-probe" {
        let root = PathBuf::from(std::env::var(ROOT_ENV).expect("probe root"));
        child_guard::unwind_probe_role(&root);
    }
    match role.as_str() {
        "race" => {
            let root = PathBuf::from(std::env::var(ROOT_ENV).unwrap());
            let probe = PathBuf::from(std::env::var(PROBE_ENV).unwrap());
            let store = Store::open(&root).unwrap();
            // Exclusive ownership probe: a second holder would find `owner`.
            for _ in 0..5 {
                let guard = store.lock_write(&[]).unwrap();
                let marker = probe.join("owner");
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&marker)
                    .expect("duplicate lock ownership");
                std::thread::sleep(Duration::from_millis(3));
                std::fs::remove_file(&marker).unwrap();
                drop(guard);
            }
            let guard = store.lock_write(&[]).unwrap();
            match store.reserve_kb(&guard, race_kb()) {
                Ok(kb) => say(&format!("RESERVED {}", kb.id)),
                Err(StoreError::Conflict(_)) => say("RESERVED -"),
                Err(other) => panic!("{other:?}"),
            }
            say(&format!("UUID {}", store.store_uuid()));
        }
        "owner" => {
            let root = PathBuf::from(std::env::var(ROOT_ENV).unwrap());
            let release = std::env::var(RELEASE_ENV).unwrap();
            let store = Store::open(&root).unwrap();
            let guard = store.lock_write(&[]).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "child_role_entry",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(ROLE_ENV, "paused")
                .env(RELEASE_ENV, &release)
                .stdout(Stdio::null())
                .stderr(Stdio::inherit());
            let mut paused = HandoffChild::spawn(&guard, child).unwrap();
            say(&format!("READY {}", paused.id()));
            // Parked until killed by the test.
            let deadline = Instant::now() + Duration::from_secs(120);
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = paused.wait();
        }
        "stdin" => {
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            assert_eq!(line, "normal stdin\n");
            say("STDIN_OK");
        }
        #[cfg(unix)]
        "fork-paused" => {
            // The extra fd received at exec is inherited by this descendant;
            // unlike a CLOEXEC owner fd it survives an ordinary child spawn.
            let release = PathBuf::from(std::env::var(RELEASE_ENV).unwrap());
            // Transfer the deliberately orphaned child to the enclosing native
            // fixture scope. Its parent retains the directory through drainage.
            let child = ChildGuard::new(
                Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "child_role_entry",
                        "--nocapture",
                        "--test-threads=1",
                    ])
                    .env(ROLE_ENV, "paused")
                    .env(RELEASE_ENV, &release)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap(),
            );
            let pid = child.handoff_to_scope();
            std::fs::write(release.with_extension("pid"), pid.to_string()).unwrap();
        }
        "paused" => {
            // Descendant of the lock owner: holds the inherited lock handle
            // until released, then records that it drained and exits.
            let release = PathBuf::from(std::env::var(RELEASE_ENV).unwrap());
            if std::env::var_os("KB_TEST_HANDOFF_UNWIND").is_some() {
                let root = release.parent().unwrap();
                std::fs::write(root.join("writer-tick"), "live").unwrap();
                let ready = release.with_extension("ready");
                let pending = release.with_extension("ready.pending");
                std::fs::write(&pending, std::process::id().to_string()).unwrap();
                std::fs::rename(pending, ready).unwrap();
                loop {
                    std::fs::create_dir_all(root).unwrap();
                    std::fs::write(root.join("writer-tick"), "live").unwrap();
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            assert!(wait_for_file(&release, Duration::from_secs(120)));
            std::fs::write(release.with_extension("drained"), b"1").unwrap();
        }
        other => panic!("unknown role {other}"),
    }
}

fn spawn(role: &str, envs: &[(&str, &Path)]) -> ChildGuard {
    let mut cmd = Command::new(std::env::current_exe().expect("test fixture"));
    cmd.args([
        "--exact",
        "child_role_entry",
        "--nocapture",
        "--test-threads=1",
    ])
    .env(ROLE_ENV, role)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit());
    for (key, value) in envs {
        cmd.env(key, value);
    }
    ChildGuard::spawn(&cmd).expect("test fixture")
}

#[test]
fn racing_processes_initialize_one_store_and_reserve_once() {
    let base = temp_base("race");
    let root = base.join("store");
    let probe = base.join("probe");
    std::fs::create_dir_all(&probe).unwrap();
    let children: Vec<ChildGuard> = (0..6)
        .map(|_| spawn("race", &[(ROOT_ENV, &root), (PROBE_ENV, &probe)]))
        .collect();
    // Drain every concurrently spawned child before a result assertion can panic.
    let outputs: Vec<_> = children
        .into_iter()
        .map(ChildGuard::wait_with_output)
        .collect();
    let mut uuids = BTreeSet::new();
    let mut reserved = Vec::new();
    for output in outputs {
        let output = output.unwrap();
        assert!(output.status.success(), "child failed: {output:?}");
        let text = String::from_utf8(output.stdout).unwrap();
        for line in text.lines() {
            if let Some(uuid) = line.strip_prefix("UUID ") {
                uuids.insert(uuid.to_owned());
            }
            if let Some(id) = line.strip_prefix("RESERVED ") {
                reserved.push(id.to_owned());
            }
        }
    }
    assert_eq!(uuids.len(), 1, "one stable store uuid: {uuids:?}");
    assert_eq!(reserved.len(), 6);
    let winners: Vec<_> = reserved.iter().filter(|r| r.as_str() != "-").collect();
    assert_eq!(winners.len(), 1, "exactly one reservation: {reserved:?}");

    let store = Store::open(&root).unwrap();
    assert_eq!(store.store_uuid().as_str(), uuids.iter().next().unwrap());
    let kbs = store.list_kbs().unwrap();
    assert_eq!(kbs.len(), 1);
    assert_eq!(kbs[0].id.as_str(), winners[0].as_str());
    // Exactly one reserved repo directory.
    let repos: Vec<_> = std::fs::read_dir(root.join("repos"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(repos.len(), 1, "{repos:?}");
}

// flk7: first initialization flushed every ancestor through `/` while holding
// the store lock, so concurrent openers spent their five-second admission on
// the host's busiest filesystem. Those directories are not store state. Park
// that flush deterministically (as a stalled fsync does) and require a
// concurrent open to be admitted and initialize meanwhile.
#[cfg(unix)]
#[test]
fn stalled_first_init_ancestor_flush_does_not_hold_store_admission() {
    use kb_local::OpenStage;
    use std::os::unix::fs::DirBuilderExt;
    use std::sync::mpsc;
    let owned_base = temp_base("ancestor-flush");
    let base = owned_base.canonicalize().unwrap();
    let root = base.join("store");
    // An existing root: the parked `base` flush is the ancestor fence, not
    // the creation barrier for a new root entry.
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .unwrap();
    let (parked_send, parked) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let initializer = {
        let (root, base) = (root.clone(), base.clone());
        std::thread::spawn(move || {
            let mut stalled = false;
            Store::open_observed(&root, &mut |stage| {
                if !stalled && stage == OpenStage::SyncDirectory(base.clone()) {
                    stalled = true;
                    parked_send.send(()).unwrap();
                    // Held until the concurrent open below has returned.
                    let _ = released.recv();
                }
                Ok(())
            })
            .map(|store| store.store_uuid().clone())
        })
    };
    parked
        .recv_timeout(Duration::from_secs(60))
        .expect("initializer reached its ancestor flush");
    let concurrent = Store::open(&root);
    release.send(()).unwrap();
    let initializer = initializer.join().unwrap();
    let concurrent = concurrent.expect("ancestor flush must not hold store admission");
    let initializer = initializer.expect("parked initializer adopts the published store");
    assert_eq!(concurrent.store_uuid(), &initializer, "one store identity");
    drop(concurrent);
    std::fs::remove_dir_all(&base).unwrap();
}

#[test]
fn killed_owner_lock_is_held_until_paused_child_drains() {
    let base = temp_base("drain");
    let root = base.join("store");
    let release = base.join("release");
    drop(Store::open(&root).unwrap());
    let mut owner = spawn("owner", &[(ROOT_ENV, &root), (RELEASE_ENV, &release)]);
    let stdout = owner.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0, "owner died early");
        if line.starts_with("READY ") {
            break;
        }
    }
    owner.kill().unwrap();
    owner.wait().unwrap();

    let successor = Store::open(&root).unwrap();
    #[cfg(unix)]
    {
        // The owner is dead, but its paused descendant still holds the lock:
        // the successor cannot write.
        assert!(
            successor.try_lock_write(&[]).unwrap().is_none(),
            "successor acquired the lock while the owner's child was alive"
        );
        assert!(!release.with_extension("drained").exists());

        std::fs::write(&release, b"go").unwrap();
        let guard = successor.lock_write(&[]).unwrap();
        assert!(
            release.with_extension("drained").exists(),
            "lock released before the descendant drained"
        );
        drop(guard);
    }
    #[cfg(unix)]
    let guard = successor.lock_write(&[]).unwrap();
    #[cfg(windows)]
    let guard = {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(guard) = successor.try_lock_write(&[]).unwrap() {
                break guard;
            }
            assert!(Instant::now() < deadline, "job never drained");
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    #[cfg(windows)]
    {
        let pid = line.trim().strip_prefix("READY ").unwrap();
        let output = Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")),
            "paused child outlived job drain"
        );
    }
    let kb = successor
        .reserve_kb(
            &guard,
            NewKb {
                name: "After".to_owned(),
                slug: "after".to_owned(),
                description: "Written by the successor".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(kb.slug, "after");
}

#[test]
fn in_process_second_handle_cannot_take_a_held_lock() {
    let base = temp_base("inproc");
    let root = base.join("store");
    let a = Store::open(&root).unwrap();
    let b = Store::open(&root).unwrap();
    let guard = a.lock_write(&[]).unwrap();
    assert!(b.try_lock_write(&[]).unwrap().is_none());
    drop(guard);
    #[cfg(unix)]
    assert!(os_locks_available(&root, &[]));
    drop(b.lock_write(&[]).unwrap());
}

#[test]
fn failed_handoff_spawn_does_not_strand_lock() {
    handoff_fixture("failedspawn", false, |base| {
        let store = Store::open(&base.join("store")).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        let command = Command::new(base.join("missing-executable"));
        assert!(HandoffChild::spawn(&guard, command).is_err());
        drop(guard);
        // The consumed builder and its handoff copy must be gone after failure.
        #[cfg(unix)]
        {
            assert!(os_locks_available(store.paths().root(), &[]));
            drop(store.lock_write(&[]).unwrap());
        }
        #[cfg(windows)]
        {
            // Closing the guard's job also drains its suspended broker.
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(guard) = store.try_lock_write(&[]).unwrap() {
                    drop(guard);
                    break;
                }
                assert!(Instant::now() < deadline, "failed spawn stranded the job");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    });
}

#[test]
fn kb_locks_are_sorted_deduplicated_and_persistent() {
    let base = temp_base("order");
    let root = base.join("store");
    let store = Store::open(&root).unwrap();
    let x = KbId::parse("zzzzzzzzzzzzzzzzzzzzzzzz").unwrap();
    let y = KbId::parse("aaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
    let guard = store
        .lock_write(&[x.clone(), y.clone(), x.clone()])
        .unwrap();
    assert_eq!(guard.kb_ids(), &[y.clone(), x.clone()]);
    drop(guard);
    // Lock files are never deleted (persistent lock inode).
    for id in [&x, &y] {
        assert!(root.join("locks").join(format!("kb_{id}.lock")).is_file());
    }
    assert!(root.join("locks/store.lock").is_file());
    // A guard from one store is refused by another store.
    let other = Store::open(&base.join("other")).unwrap();
    let guard = other.lock_write(&[]).unwrap();
    assert!(matches!(
        store.reserve_kb(&guard, race_kb()),
        Err(StoreError::LockNotHeld)
    ));
}

/// Lock-release regression (the flake of
/// `in_process_second_handle_cannot_take_a_held_lock`): while another thread
/// forks children, a fork duplicates this process's descriptor table —
/// including the lock files' open file descriptions — until that child's
/// `exec` closes them (CLOEXEC). A release that only CLOSES its descriptor
/// therefore stays held by such an unrelated child for that window, and an
/// immediate `try_lock_write` spuriously fails. A guard that never handed
/// its lock to a descendant must release deterministically on drop.
#[cfg(unix)]
#[test]
fn release_is_immediate_while_other_threads_spawn_children() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let base = temp_base("spawnrace");
    let root = base.join("store");
    let a = Store::open(&root).unwrap();
    let kb = KbId::parse("spawnracekbaaaaaaaaaaaaa").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let spawners: Vec<_> = (0..2)
        .map(|_| {
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let mut spawned = 0u32;
                while !stop.load(Ordering::Relaxed) {
                    let status = Command::new("true")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .expect("spawn true");
                    assert!(status.success());
                    spawned += 1;
                }
                spawned
            })
        })
        .collect();
    let mut spurious = 0u32;
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut rounds = 0u32;
    while Instant::now() < deadline {
        rounds += 1;
        let guard = a.lock_write(std::slice::from_ref(&kb)).unwrap();
        drop(guard);
        if !os_locks_available(&root, std::slice::from_ref(&kb)) {
            spurious += 1;
        }
    }
    stop.store(true, Ordering::Relaxed);
    let spawned: u32 = spawners.into_iter().map(|t| t.join().unwrap()).sum();
    drop(a.lock_write(std::slice::from_ref(&kb)).unwrap());
    drop(a);
    std::fs::remove_dir_all(base).unwrap();
    assert!(
        spawned > 20,
        "children were spawned concurrently ({spawned})"
    );
    assert_eq!(
        spurious, 0,
        "a released guard stayed held by an unrelated forked child in {spurious} of {rounds} rounds"
    );
}

#[test]
fn lock_handoff_preserves_normal_stdin() {
    handoff_fixture("stdin", false, |base| {
        let store = Store::open(&base.join("store")).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "child_role_entry", "--nocapture"])
            .env(ROLE_ENV, "stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut child = HandoffChild::spawn(&guard, cmd).unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"normal stdin\n")
            .unwrap();
        let mut output = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take().unwrap(), &mut output).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(output.contains("STDIN_OK"), "{output}");
        drop(guard);
        // Keep the completed Child alive: successful handoff must not strand a
        // parent copy after the consumed builder and guard have gone away.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(guard) = store.try_lock_write(&[]).unwrap() {
                drop(guard);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "completed spawn stranded ownership"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(child);
        drop(store);
    });
}

#[test]
fn unrelated_thread_child_does_not_keep_a_handed_off_lock() {
    handoff_fixture("unrelated", false, |base| {
        let root = base.join("store");
        let release = base.join("release");
        let store = Store::open(&root).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "child_role_entry", "--nocapture"])
            .env(ROLE_ENV, "stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        let mut intended = HandoffChild::spawn(&guard, cmd).unwrap();
        intended
            .stdin
            .take()
            .unwrap()
            .write_all(b"normal stdin\n")
            .unwrap();
        let unrelated_release = release.clone();
        let mut unrelated =
            std::thread::spawn(move || spawn("paused", &[(RELEASE_ENV, &unrelated_release)]))
                .join()
                .unwrap();
        assert!(intended.wait().unwrap().success());
        drop(guard);
        let deadline = Instant::now() + Duration::from_secs(5);
        let released = loop {
            if let Some(guard) = store.try_lock_write(&[]).unwrap() {
                drop(guard);
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "unrelated child is still running"
        );
        std::fs::write(&release, b"go").unwrap();
        assert!(unrelated.wait().unwrap().success());
        drop(store);
        assert!(released, "unrelated child inherited the lock");
    });
}

#[test]
fn normal_drop_with_live_child_preserves_exclusion_and_stdin() {
    handoff_fixture("normal-drain", false, |base| {
        let root = base.join("store");
        let release = base.join("release");
        let store = Store::open(&root).unwrap();
        let successor = Store::open(&root).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "child_role_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ROLE_ENV, "paused")
            .env(RELEASE_ENV, &release)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        let mut child = HandoffChild::spawn(&guard, command).unwrap();
        assert!(
            child.stdin.is_some(),
            "the lock must not replace the input pipe"
        );
        drop(guard); // SIGKILL tests do not execute this path.
        let excluded = successor.try_lock_write(&[]).unwrap().is_none();
        std::fs::write(&release, b"go").unwrap();
        assert!(child.wait().unwrap().success());
        assert!(successor.lock_write(&[]).is_ok());
        assert!(excluded, "normal guard Drop released the live child's lock");
    });
}

#[test]
fn recycled_root_rejects_both_foreign_guard_and_old_store_handle() {
    let base = temp_base("recycled-root");
    let root = base.join("store");
    let a = Store::open(&root).unwrap();
    let a_guard = a.lock_write(&[]).unwrap();
    std::fs::rename(&root, base.join("retired")).unwrap();
    let b = Store::open(&root).unwrap();
    assert_ne!(a.store_uuid(), b.store_uuid());
    let b_guard = b.lock_write(&[]).unwrap();
    assert!(matches!(
        b.reserve_kb(&a_guard, race_kb()),
        Err(StoreError::LockNotHeld)
    ));
    assert!(a.reserve_kb(&a_guard, race_kb()).is_err());
    assert!(a.lock_write(&[]).is_err());
    assert!(a.list_kbs().is_err());
    let index_id = KbId::parse("zzzzzzzzzzzzzzzzzzzzzzzz").unwrap();
    assert!(a.paths().ensure_index_dir(&index_id).is_err());
    assert!(
        std::fs::read_dir(root.join("indexes"))
            .unwrap()
            .next()
            .is_none()
    );
    assert!(b.list_kbs().unwrap().is_empty());
    assert!(
        std::fs::read_dir(root.join("repos"))
            .unwrap()
            .next()
            .is_none()
    );
    assert!(b.reserve_kb(&b_guard, race_kb()).is_ok());
}

#[test]
fn replacement_lock_inode_cannot_reuse_an_old_guard() {
    let base = temp_base("recycled-lock");
    let root = base.join("store");
    let store = Store::open(&root).unwrap();
    let guard = store.lock_write(&[]).unwrap();
    std::fs::rename(store.paths().store_lock_file(), root.join("retired.lock")).unwrap();
    let current = store.lock_write(&[]).unwrap();
    assert!(store.reserve_kb(&guard, race_kb()).is_err());
    assert!(store.reserve_kb(&current, race_kb()).is_ok());
}

#[test]
fn failed_child_spawn_releases_exclusion_after_prepared_command_drop() {
    handoff_fixture("spawn-failure", false, |base| {
        let root = base.join("store");
        let store = Store::open(&root).unwrap();
        let successor = Store::open(&root).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        let command = Command::new(base.join("absent-executable"));
        assert!(HandoffChild::spawn(&guard, command).is_err());
        drop(guard);
        assert!(successor.lock_write(&[]).is_ok());
    });
}

#[cfg(unix)]
#[test]
fn normal_drop_after_child_exit_keeps_live_descendant_excluded() {
    handoff_fixture("normal-descendant-drain", false, |base| {
        let root = base.join("store");
        let release = base.join("release");
        let store = Store::open(&root).unwrap();
        let guard = store.lock_write(&[]).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "child_role_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ROLE_ENV, "fork-paused")
            .env(RELEASE_ENV, &release)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        let mut child = HandoffChild::spawn(&guard, command).unwrap();
        drop(guard);
        assert!(child.wait().unwrap().success()); // Drops the last parent lease.
        let pid = std::fs::read_to_string(release.with_extension("pid")).unwrap();
        let alive = Command::new("kill")
            .args(["-0", pid.trim()])
            .status()
            .unwrap()
            .success();
        let excluded = store.try_lock_write(&[]).unwrap().is_none();
        std::fs::write(&release, b"go").unwrap();
        assert!(wait_for_file(
            &release.with_extension("drained"),
            Duration::from_secs(10)
        ));
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(guard) = store.try_lock_write(&[]).unwrap() {
                drop(guard);
                break;
            }
            assert!(Instant::now() < deadline, "grandchild stranded lock");
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(store);
        assert!(alive && excluded, "alive descendant escaped normal Drop");
    });
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
                let child = spawn("unwind-probe", &[(ROOT_ENV, &root)]);
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

fn handoff_unwind(role: &str) {
    handoff_fixture("handoff-unwind", true, |base| {
        let release = base.join("release");
        let store = Store::open(&base.join("store")).expect("handoff unwind fixture");
        let guard = store.lock_write(&[]).expect("handoff unwind fixture");
        let mut command = Command::new(std::env::current_exe().expect("handoff unwind fixture"));
        command
            .args([
                "--exact",
                "child_role_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(ROLE_ENV, role)
            .env(RELEASE_ENV, &release)
            .env("KB_TEST_HANDOFF_UNWIND", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        let mut child = HandoffChild::spawn(&guard, command).expect("handoff unwind fixture");
        assert!(wait_for_file(
            &release.with_extension("ready"),
            Duration::from_secs(10)
        ));
        let writer = std::fs::read_to_string(release.with_extension("ready"))
            .expect("handoff unwind fixture");
        std::fs::write(base.join("writer-pids"), format!("{} {writer}", child.id()))
            .expect("handoff unwind fixture");
        if role == "fork-paused" {
            assert!(child.wait().expect("handoff unwind fixture").success());
        }
        std::fs::write(base.join("unwind-admitted"), "admitted").expect("handoff unwind fixture");
        panic!("injected handoff unwind");
    });
}

#[test]
fn handoff_child_unwind_drains_before_directory_removal() {
    handoff_unwind("paused");
}

#[cfg(unix)]
#[test]
fn handoff_orphan_unwind_drains_before_directory_removal() {
    handoff_unwind("fork-paused");
}
