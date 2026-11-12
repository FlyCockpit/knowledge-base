//! Own a child immediately. Supervised crash roles retain their whole writer
//! tree until Drop, independently of explicit leader kill/wait operations.
#![allow(dead_code)] // Shared by independent integration-test crates.
use std::{
    io::{self, Read},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Output, Stdio},
    time::Duration,
};

pub struct ChildGuard {
    child: Child,
    owner: Option<PathBuf>,
}
impl ChildGuard {
    /// For helpers which cannot spawn descendants (e.g. model cache writers).
    pub fn new(child: Child) -> Self {
        Self { child, owner: None }
    }

    pub fn spawn_direct(command: &mut Command) -> io::Result<Self> {
        command.spawn().map(Self::new)
    }

    /// Re-executed crash roles may start Git. The native owner retains them
    /// through leader kill/reap and only drains the tree when this guard drops.
    /// Roles have piped stdin/stdout and inherited stderr. Unused stdin is
    /// closed by wait_with_output; direct wait preserves interactive fixtures.
    pub fn spawn(command: &Command) -> io::Result<Self> {
        Self::spawn_owned(command, false)
    }

    pub fn spawn_capture(command: &Command) -> io::Result<Self> {
        Self::spawn_owned(command, true)
    }

    fn spawn_owned(command: &Command, capture_stderr: bool) -> io::Result<Self> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "kb-local-child-owner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&root)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir(&root)?;
        let mut owner = Command::new(
            option_env!("CARGO_BIN_EXE_kb-test-owner")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::current_exe()
                        .expect("test exe")
                        .parent()
                        .expect("deps")
                        .parent()
                        .expect("target profile")
                        .join(format!("kb-test-owner{}", std::env::consts::EXE_SUFFIX))
                }),
        );
        owner
            .arg(&root)
            .arg("--hold")
            .arg(command.get_program())
            .args(command.get_args())
            .env("KB_TEST_FIXTURE_SCOPE", &root);
        if let Some(cwd) = command.get_current_dir() {
            owner.current_dir(cwd);
        }
        for (key, value) in command.get_envs() {
            if let Some(value) = value {
                owner.env(key, value);
            } else {
                owner.env_remove(key);
            }
        }
        owner
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if capture_stderr {
                Stdio::piped()
            } else {
                Stdio::inherit()
            });
        match owner.spawn() {
            Ok(child) => Ok(Self {
                child,
                owner: Some(root),
            }),
            Err(error) => {
                std::fs::remove_dir_all(root)?;
                Err(error)
            }
        }
    }

    /// Deliberate orphan fixtures transfer ownership to the enclosing native
    /// scope. That scope must retain the fixture directory until it drains.
    pub fn handoff_to_scope(self) -> u32 {
        assert!(std::env::var_os("KB_TEST_FIXTURE_SCOPE").is_some());
        assert!(self.owner.is_none(), "only transfer a direct child");
        let pid = self.child.id();
        std::mem::forget(self);
        pid
    }
    pub fn id(&mut self) -> u32 {
        if let Some(root) = &self.owner {
            loop {
                if let Ok(pid) = std::fs::read_to_string(root.join("pid")) {
                    return pid.parse().expect("owner pid");
                }
                assert!(
                    self.child.try_wait().expect("test owner status").is_none(),
                    "test owner exited before admitting the crash helper"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        self.child.id()
    }
    pub fn kill(&mut self) -> io::Result<()> {
        if let Some(root) = &self.owner {
            std::fs::write(root.join("kill-leader"), "kill")
        } else {
            self.child.kill()
        }
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(root) = &self.owner {
            match std::fs::read_to_string(root.join("status")) {
                Ok(status) => {
                    #[cfg(unix)]
                    use std::os::unix::process::ExitStatusExt;
                    #[cfg(windows)]
                    use std::os::windows::process::ExitStatusExt;
                    Ok(Some(ExitStatus::from_raw(
                        status.parse().map_err(io::Error::other)?,
                    )))
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if self.child.try_wait()?.is_some() {
                        return Err(io::Error::other(
                            "test owner failed before reporting leader status",
                        ));
                    }
                    Ok(None)
                }
                Err(error) => Err(error),
            }
        } else {
            self.child.try_wait()
        }
    }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    pub fn drain(&mut self) -> io::Result<()> {
        if let Some(root) = &self.owner {
            std::fs::write(root.join("stop"), "stop")?;
            self.child.wait()?;
            if !root.join("drained").exists() {
                return Err(io::Error::other(format!(
                    "test owner failed; retained {}",
                    root.display()
                )));
            }
            std::fs::remove_dir_all(root)?;
            self.owner = None;
        } else {
            if self.child.try_wait()?.is_none() {
                self.child.kill()?;
            }
            self.child.wait()?;
        }
        Ok(())
    }
    pub fn wait_with_output(mut self) -> io::Result<Output> {
        // Read concurrently to avoid a full pipe holding up leader exit.
        drop(self.child.stdin.take());
        let stdout = self.child.stdout.take();
        let stderr = self.child.stderr.take();
        fn read(
            pipe: Option<impl Read + Send + 'static>,
        ) -> std::thread::JoinHandle<io::Result<Vec<u8>>> {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                if let Some(mut pipe) = pipe {
                    pipe.read_to_end(&mut bytes)?;
                }
                Ok(bytes)
            })
        }
        let stdout = read(stdout);
        let stderr = read(stderr);
        let status = self.wait()?;
        self.drain()?;
        Ok(Output {
            status,
            stdout: stdout.join().expect("stdout reader")?,
            stderr: stderr.join().expect("stderr reader")?,
        })
    }
}
impl std::ops::Deref for ChildGuard {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl std::ops::DerefMut for ChildGuard {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        // Failed drainage must not authorize a TestDir deletion, including while
        // unwinding. Abort the test process; the outer owner retains/drains it.
        if let Err(error) = self.drain() {
            use std::io::Write;
            let _ = writeln!(std::io::stderr(), "crash-helper drainage failed: {error}");
            std::process::abort();
        }
    }
}

/// Re-enter each suite's actual role-spawn path, then orphan a real writer.
/// The outer guard must reap BOTH PIDs before TestDir's deletion boundary.
pub fn unwind_probe_role(root: &std::path::Path) -> ! {
    if std::env::var_os("KB_TEST_UNWIND_LEAF").is_some() {
        loop {
            std::fs::create_dir_all(root).expect("live writer root");
            std::fs::write(root.join("writer-tick"), "live").expect("live writer");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    // Intentionally orphaned by the regression's injected parent panic. The
    // native ChildGuard owner, rather than this doomed role, owns its drainage.
    let mut leaf = ChildGuard::new(
        Command::new(std::env::current_exe().expect("test exe"))
            .args([
                "--exact",
                "child_role_entry",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("KB_TEST_UNWIND_LEAF", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("probe writer"),
    );
    std::fs::write(
        root.join("writer-pids"),
        format!("{} {}", std::process::id(), leaf.id()),
    )
    .expect("writer identities");
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

pub fn writer_pids(root: &std::path::Path) -> Vec<u32> {
    let until = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        // Also compiled by the standalone rustc Git fixture (default edition).
        if let (Ok(pids), true) = (
            std::fs::read_to_string(root.join("writer-pids")),
            root.join("writer-tick").exists(),
        ) {
            return pids
                .split_whitespace()
                .map(|pid| pid.parse().expect("pid"))
                .collect();
        }
        assert!(
            std::time::Instant::now() < until,
            "actual crash-helper writer did not start"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn assert_dead(pids: &[u32]) {
    for pid in pids {
        #[cfg(target_os = "linux")]
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "writer {} still exists at rm",
            pid
        );
        #[cfg(all(unix, not(target_os = "linux")))]
        assert!(
            !Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("probe pid")
                .success(),
            "writer {} alive at rm",
            pid
        );
        #[cfg(windows)]
        {
            let output = Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .expect("probe pid");
            assert!(
                !String::from_utf8_lossy(&output.stdout)
                    .split_whitespace()
                    .any(|part| part == pid.to_string()),
                "writer alive at rm"
            );
        }
    }
}
