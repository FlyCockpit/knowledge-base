use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(all(unix, not(target_os = "linux")))]
use std::process::Stdio;
use std::time::{Duration, Instant};

pub struct ParkedGit {
    pub bin: PathBuf,
    pub path: String,
}

impl ParkedGit {
    pub fn new(base: &Path, mode: &str) -> Self {
        let bin = base.join("wrapper-bin");
        std::fs::create_dir(&bin).expect("bin");
        #[cfg(unix)]
        let lookup = Command::new("sh")
            .args(["-c", "command -v git"])
            .output()
            .expect("git path");
        #[cfg(windows)]
        let lookup = Command::new("where.exe")
            .arg("git.exe")
            .output()
            .expect("git path");
        assert!(lookup.status.success());
        let text = String::from_utf8(lookup.stdout).expect("utf8");
        std::fs::write(bin.join("real-git"), text.lines().next().expect("git")).expect("path");
        std::fs::write(bin.join("mode"), mode).expect("mode");
        let exe = bin.join(if cfg!(windows) { "git.exe" } else { "git" });
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/git-wrapper.rs");
        assert!(
            Command::new("rustc")
                .arg(source)
                .arg("-o")
                .arg(exe)
                .status()
                .expect("compile PATH wrapper")
                .success()
        );
        let mut paths = vec![bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").expect("PATH"),
        ));
        Self {
            bin,
            path: std::env::join_paths(paths)
                .expect("PATH")
                .to_string_lossy()
                .into_owned(),
        }
    }

    pub fn wait(&self, name: &str) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !self.bin.join(name).exists() {
            assert!(Instant::now() < deadline, "wrapper never reached {name}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn alive(&self) -> bool {
        let pid = std::fs::read_to_string(self.bin.join("pid")).expect("pid");
        #[cfg(target_os = "linux")]
        {
            // Avoid scheduling a new process for every liveness sample under load.
            Path::new(&format!("/proc/{}", pid.trim())).exists()
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            Command::new("kill")
                .args(["-0", pid.trim()])
                .stderr(Stdio::null())
                .status()
                .expect("probe")
                .success()
        }
        #[cfg(windows)]
        {
            let out = Command::new("tasklist.exe")
                .args([
                    "/FI",
                    &format!("PID eq {}", pid.trim()),
                    "/FO",
                    "CSV",
                    "/NH",
                ])
                .output()
                .expect("tasklist");
            String::from_utf8_lossy(&out.stdout).contains(&format!("\"{}\"", pid.trim()))
        }
    }

    /// Only after a supervised call reported timeout and reaped its child:
    /// startup itself may be canceled before the fixture publishes its PID.
    /// Readiness probes keep using `alive` so a missing PID remains an error.
    #[allow(dead_code)] // shared module; not every test binary uses it
    pub fn alive_after_timeout(&self) -> bool {
        self.bin.join("pid").try_exists().expect("pid presence") && self.alive()
    }
}

impl Drop for ParkedGit {
    fn drop(&mut self) {
        // Release even on failed assertions; the fixture has its own bound.
        let _ = std::fs::write(self.bin.join("release"), b"go");
    }
}
