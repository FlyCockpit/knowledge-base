//! Per-fixture shared-worker host: its own runtime directory, model
//! cache and fake-inference worker executable.
#![allow(dead_code)]
use kb_local::qwen::{ModelHost, descriptor, model_ids};
use std::{path::PathBuf, time::Duration};

pub fn helper() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kb-model-fixture"))
}

/// The fixture root stays a plain temp directory; on Unix it is made
/// owner-only (trust needs owner-only ancestors). Windows ancestors only need
/// integrity, which a user temp directory has.
fn private_root(dir: &std::path::Path) {
    std::fs::create_dir_all(dir).expect("fixture dir");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .expect("private fixture dir");
    }
}

fn fnv(path: &std::path::Path) -> u64 {
    path.as_os_str()
        .as_encoded_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
        })
}

/// A fresh, not yet created runtime directory: the production code creates
/// it with its own platform privacy (0700, or an owner-only DACL), so the
/// fixture never inherits ambient permissions or ACLs. On Unix it is a short
/// path under `/tmp` (a socket path must fit `sun_path` whatever `TMPDIR`
/// is), named after the fixture's top temp entry so the fixture's drop
/// removes it (`/tmp/kbr-<top>-<root>`, see `fixture.rs`).
pub fn runtime_dir(root: &std::path::Path) -> PathBuf {
    #[cfg(unix)]
    {
        let temp = std::env::temp_dir();
        let top = root
            .ancestors()
            .find(|a| a.parent() == Some(temp.as_path()))
            .unwrap_or(root);
        PathBuf::from(format!(
            "/tmp/kbr-{:016x}-{:04x}",
            fnv(top),
            fnv(root) & 0xffff
        ))
    }
    #[cfg(not(unix))]
    root.join("r")
}

/// A host whose worker runs the fake-inference fixture. The model cache `m`
/// lives under `root`; the runtime dir is where hook files go.
pub fn fake_host(root: &std::path::Path, idle: Duration) -> ModelHost {
    private_root(root);
    let host =
        ModelHost::new(helper(), runtime_dir(root), root.join("m"), idle).expect("model host");
    host.prepare_runtime_dir().expect("owner-only runtime dir");
    host
}

/// Stop the worker `pid` the platform way and wait until it has exited:
/// no live worker answers on the endpoint any more.
pub fn kill_worker(host: &ModelHost, pid: u32) {
    #[cfg(unix)]
    let status = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    #[cfg(windows)]
    let status = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .status();
    assert!(status.expect("kill").success(), "worker {pid} killed");
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while host.status().is_some_and(|info| info.pid == pid) {
        assert!(std::time::Instant::now() < end, "worker {pid} did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Fake inference never reads weights; sparse files of the pinned sizes let
/// the cheap cache check pass. They are seeded as the cache's own inodes in
/// `verified/` (created owner-only), as an explicit download would publish
/// them, including permitting use again after removal.
pub fn seed_models(host: &ModelHost) {
    // Created by the cache itself: owner-only on every platform.
    host.cache().ensure_dirs().expect("model cache dirs");
    for id in model_ids() {
        let m = descriptor(&id).expect("descriptor");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(false);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let path = host.cache().private_copy(&m).expect("cache file");
        let file = options.open(&path).expect("sparse model");
        file.set_len(m.size_bytes).expect("sparse size");
        drop(file);
        // Recorded as the cache's own inode, as a download would.
        host.cache()
            .record_created_for_tests(&m, &path)
            .expect("creation mark");
    }
}

/// A seeded fake host.
pub fn seeded(root: &std::path::Path, idle: Duration) -> ModelHost {
    let host = fake_host(root, idle);
    seed_models(&host);
    host
}

pub fn hook(host: &ModelHost, name: &str) -> PathBuf {
    host.runtime_dir().join(name)
}
