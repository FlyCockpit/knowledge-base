//! One shared embedding worker per user.
//!
//! The first `kb` process that needs an embedding starts a detached
//! `kb embed-worker` child; every other process (any store) connects to it
//! over a local socket. The worker holds one model copy in memory, serves
//! concurrent clients (queries before document batches), exits after an idle
//! period, and is restarted on demand after an exit or crash.
//!
//! * Endpoint: a Unix domain socket in an owner-only (0700) per-user runtime
//!   directory, with the peer UID checked on both sides; on Windows a named
//!   pipe with an owner-only DACL whose random name is published in an
//!   owner-only file of the same runtime directory (so it cannot be squatted).
//! * One worker per identity (`PROTOCOL`, crate version, executable, model
//!   directory): an OS file lock is held for the worker's lifetime, so a
//!   stale socket left by a crash is removed by the next worker that wins it.
//! * The wire is bounded newline-delimited JSON. A worker never trusts a
//!   model file without its pinned size and SHA-256 (`ModelCache`).
use crate::{
    StoreError,
    egress::unavailable,
    model_download::ModelCache,
    qwen::{Embedding, ModelDescriptor, ModelOutput, Purpose, descriptor},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::VecDeque,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, mpsc},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// Bump on any wire change; part of the worker identity.
pub const PROTOCOL: u32 = 1;
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// JSON may encode each UTF-8 byte as six ASCII bytes (e.g. U+0000).
pub(crate) const MAX_FRAME_BYTES: usize = 6 * crate::git_read::DOCUMENT_MAX_BYTES + 4096;
/// How long a remover waits for the worker to release a model: longer than
/// a load parked on the removal fence takes to give up.
const UNLOAD_WAIT: Duration = Duration::from_secs(15);
/// How long a client waits for a freshly started worker to listen.
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// The worker subcommand of the `kb` binary (and of test fixtures).
pub const WORKER_ARG: &str = "embed-worker";

fn worker_error(why: impl Into<String>) -> StoreError {
    StoreError::Explained(kb_client::ErrorCode::IndexUnavailable, why.into())
}

/// Where the shared worker lives and how to start it.
#[derive(Clone, Debug)]
pub struct ModelHost {
    executable: PathBuf,
    runtime_dir: PathBuf,
    cache: ModelCache,
    idle: Duration,
    /// How long `unload` waits for a confirmed release.
    unload_wait: Duration,
    /// R3-L7: why the worker could not be started or reached, and whether
    /// the host was told (shared by this host's clones).
    start_failure: Arc<Mutex<Option<(String, bool)>>>,
}

impl ModelHost {
    /// `runtime_dir` holds the socket and locks (created owner-only);
    /// `models_dir` is the per-user model cache. Both must be absolute.
    pub fn new(
        executable: PathBuf,
        runtime_dir: PathBuf,
        models_dir: PathBuf,
        idle: Duration,
    ) -> Result<Self, StoreError> {
        if !runtime_dir.is_absolute() {
            return Err(StoreError::InvalidArgument(
                "the embedding runtime directory must be absolute".into(),
            ));
        }
        Ok(Self {
            executable,
            runtime_dir,
            cache: ModelCache::new(models_dir)?,
            idle: idle.clamp(Duration::from_millis(50), Duration::from_secs(900)),
            unload_wait: UNLOAD_WAIT,
            start_failure: Default::default(),
        })
    }
    pub fn cache(&self) -> &ModelCache {
        &self.cache
    }
    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }
    pub fn idle(&self) -> Duration {
        self.idle
    }
    pub fn executable(&self) -> &Path {
        &self.executable
    }
    /// The same host with a separate owner-only cache for verified private
    /// copies of model files that are not safe to load in place (ROOT 1).
    pub fn with_private_cache(mut self, private: PathBuf) -> Result<Self, StoreError> {
        self.cache = ModelCache::with_private(self.cache.dir().to_path_buf(), private)?;
        Ok(self)
    }
    /// Same host, another wait for confirmed releases (tests).
    pub fn with_unload_wait(&self, wait: Duration) -> Self {
        let mut host = self.clone();
        host.unload_wait = wait;
        host
    }
    /// Same host, another idle timeout (tests and short-lived commands).
    pub fn with_idle(&self, idle: Duration) -> Self {
        let mut host = self.clone();
        host.idle = idle.clamp(Duration::from_millis(50), Duration::from_secs(900));
        host
    }
    fn identity(&self) -> String {
        let text = format!(
            "{PROTOCOL}\0{VERSION}\0{}\0{}\0{}",
            self.executable.display(),
            self.cache.dir().display(),
            self.cache.private_dir().display()
        );
        let hash = kb_client::snapshot::content_hash(text.as_bytes()).to_string();
        // 12 hex digits is short enough for every socket path limit.
        hash.trim_start_matches("sha256:")[..12].to_owned()
    }
    fn file(&self, suffix: &str) -> PathBuf {
        self.runtime_dir
            .join(format!("embed-{}.{suffix}", self.identity()))
    }
    /// The endpoint file: the socket (Unix) or the pipe-name file (Windows).
    pub fn endpoint(&self) -> PathBuf {
        self.file(if cfg!(windows) { "pipe" } else { "sock" })
    }
    /// Arguments of the worker process (after the executable).
    pub fn worker_args(&self) -> Vec<OsString> {
        vec![
            WORKER_ARG.into(),
            "--runtime-dir".into(),
            self.runtime_dir.clone().into(),
            "--models-dir".into(),
            self.cache.dir().to_path_buf().into(),
            "--private-dir".into(),
            self.cache.private_dir().to_path_buf().into(),
            "--idle-ms".into(),
            self.idle.as_millis().to_string().into(),
        ]
    }
    /// Parse [`Self::worker_args`] (without the leading `embed-worker`).
    pub fn from_worker_args(
        executable: PathBuf,
        mut args: impl Iterator<Item = OsString>,
    ) -> Result<Self, StoreError> {
        let mut runtime = None;
        let mut models = None;
        let mut private = None;
        let mut idle = None;
        while let Some(flag) = args.next() {
            let value = args.next().ok_or_else(unavailable)?;
            match flag.to_str() {
                Some("--runtime-dir") => runtime = Some(PathBuf::from(value)),
                Some("--models-dir") => models = Some(PathBuf::from(value)),
                Some("--private-dir") => private = Some(PathBuf::from(value)),
                Some("--idle-ms") => {
                    idle = value
                        .to_str()
                        .and_then(|v| v.parse::<u64>().ok())
                        .map(Duration::from_millis);
                }
                _ => return Err(unavailable()),
            }
        }
        Self::new(
            executable,
            runtime.ok_or_else(unavailable)?,
            models.ok_or_else(unavailable)?,
            idle.ok_or_else(unavailable)?,
        )?
        .with_private_cache(private.ok_or_else(unavailable)?)
    }
    /// Create the runtime directory with the platform's owner-only
    /// permissions (0700, or an owner-only DACL), or check an existing one.
    pub fn prepare_runtime_dir(&self) -> Result<(), StoreError> {
        self.ensure_runtime_dir()
    }
    /// Create (owner-only) or check the runtime directory.
    fn ensure_runtime_dir(&self) -> Result<(), StoreError> {
        let dir = &self.runtime_dir;
        // sun_path is 104 bytes on macOS, 108 on Linux (with the NUL).
        #[cfg(unix)]
        if self.endpoint().as_os_str().len() > 100 {
            return Err(worker_error(format!(
                "the embedding worker socket path under `{}` is too long for a Unix socket; set `XDG_RUNTIME_DIR` or use a shorter cache directory",
                dir.display()
            )));
        }
        match fs::symlink_metadata(dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = dir.parent() {
                    let mut builder = fs::DirBuilder::new();
                    builder.recursive(true);
                    #[cfg(unix)]
                    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
                    builder.create(parent).map_err(StoreError::Io)?;
                }
                match crate::paths::create_private_dir(dir) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(StoreError::Io(e)),
                }
            }
            Err(e) => return Err(StoreError::Io(e)),
            Ok(_) => {}
        }
        check_private_dir(dir)
    }
    /// The worker's per-instance secret (owner-only file, rewritten by every
    /// worker that wins the instance lock).
    fn key_path(&self) -> PathBuf {
        self.file("key")
    }
    fn write_key(&self) -> Result<Vec<u8>, StoreError> {
        let key = crate::state::random_bytes::<32>()?.to_vec();
        let temp = self.runtime_dir.join(format!(
            ".embed-{}.key.{}",
            self.identity(),
            crate::state::new_uuid_v4()?
        ));
        {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
            }
            let mut file = options.open(&temp).map_err(StoreError::Io)?;
            std::io::Write::write_all(&mut file, &key).map_err(StoreError::Io)?;
            file.sync_all().map_err(StoreError::Io)?;
        }
        fs::rename(&temp, self.key_path()).map_err(StoreError::Io)?;
        Ok(key)
    }
    fn read_key(&self) -> Result<Vec<u8>, StoreError> {
        let path = self.key_path();
        let mut file = crate::paths::open_no_follow(&path, OpenOptions::new().read(true))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let meta = file.metadata().map_err(StoreError::Io)?;
            if meta.uid() != crate::model_download::own_uid()?
                || meta.permissions().mode() & 0o077 != 0
            {
                return Err(StoreError::UnsafePath(
                    "embedding worker key is not owner-only".into(),
                ));
            }
        }
        let mut key = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(&mut file, 64), &mut key)
            .map_err(StoreError::Io)?;
        if key.len() != 32 {
            return Err(unavailable());
        }
        Ok(key)
    }
    fn lock_file(&self, suffix: &str) -> Result<File, StoreError> {
        crate::paths::open_regular(
            &self.file(suffix),
            crate::paths::no_follow_options()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false),
        )
    }
    /// Positive evidence that NO worker of this identity exists (Serving or
    /// Draining): every worker holds the lifecycle lock shared for its whole
    /// life, so taking it exclusively proves none is alive. `Ok(false)` when
    /// a worker may exist (or that cannot be proven).
    fn no_worker_alive(&self) -> Result<bool, StoreError> {
        match fs::symlink_metadata(&self.runtime_dir) {
            // No runtime directory: no worker can hold a lock in it.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(StoreError::Io(e)),
            Ok(_) => {}
        }
        check_private_dir(&self.runtime_dir)?;
        let lock = match crate::paths::open_regular(
            &self.file("alive.lock"),
            crate::paths::no_follow_options().read(true).write(true),
        ) {
            Ok(lock) => lock,
            // Never created: no worker of this identity ever started.
            Err(StoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(true);
            }
            Err(e) => return Err(e),
        };
        Ok(lock.try_lock().is_ok())
    }
    /// Some worker of this identity holds the instance lock (Serving, or
    /// Draining until its model is released).
    fn instance_held(&self) -> bool {
        let Ok(lock) = crate::paths::open_regular(
            &self.file("lock"),
            crate::paths::no_follow_options().read(true).write(true),
        ) else {
            return false;
        };
        matches!(lock.try_lock(), Err(fs::TryLockError::WouldBlock))
    }
    /// A worker of this identity is alive (it may not answer).
    pub fn worker_alive(&self) -> bool {
        !matches!(self.no_worker_alive(), Ok(true))
    }
    /// ROOT B: release `model_id` everywhere this identity may hold it, and
    /// PROVE it (closed world: success needs positive evidence). Either the
    /// lifecycle lock shows no worker is alive, or THE worker (at most one
    /// lives per identity: a draining one keeps the instance lock until its
    /// model is released, and it accepts no handshake) acknowledged the
    /// unload control after authenticating. Anything else (no answer, a
    /// stalled or stopped worker, a failed handshake, a missing or unreadable
    /// key, an unverifiable runtime directory) is `DEADLINE_EXCEEDED` when
    /// the wait ends; nothing may then be deleted. Accepted controls complete
    /// even if this caller gives up. Never starts a worker.
    pub fn unload(&self, model_id: &str) -> Result<(), StoreError> {
        let deadline = Instant::now() + self.unload_wait;
        let busy = |why: &str| {
            StoreError::Explained(
                kb_client::ErrorCode::DeadlineExceeded,
                format!(
                    "the shared embedding worker did not confirm it released `{model_id}` within {} s ({why})",
                    self.unload_wait.as_secs()
                ),
            )
        };
        let mut acked = false;
        loop {
            match self.no_worker_alive() {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                // The runtime directory cannot be verified: no evidence.
                Err(_) => return Err(busy("its runtime directory cannot be verified")),
            }
            if !acked {
                let attempt = deadline.min(Instant::now() + Duration::from_secs(2));
                if let Ok(conn) = Conn::open(self, attempt, None) {
                    let sent = conn.send(Job {
                        model_id: model_id.into(),
                        context_tokens: 0,
                        text: String::new(),
                        purpose: Purpose::Document,
                        probe: false,
                        measure: false,
                        unload: true,
                    });
                    // A load parked on the removal fence gives up after its
                    // own 5 s wait; then the control runs.
                    acked = sent.is_ok()
                        && matches!(
                            conn.poll(deadline.saturating_duration_since(Instant::now())),
                            Ok(Some(_))
                        );
                }
            }
            // At most one live worker per identity, ever: the acknowledging
            // worker is the only one that can hold the model.
            if acked {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(busy(
                    "it did not answer: a request using it is still running, or it is stalled",
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    /// `kb model remove`: under the per-model fence (no load starts or
    /// finishes meanwhile), confirm the worker released the model, then
    /// delete every cached copy. Nothing is deleted when the release is not
    /// confirmed. `Ok(false)` if nothing was cached.
    pub fn remove_model(&self, m: &ModelDescriptor) -> Result<bool, StoreError> {
        Ok(!self.remove_model_report(m)?.removed.is_empty())
    }
    /// [`ModelHost::remove_model`] with what was deleted and kept (R3-L9).
    pub fn remove_model_report(
        &self,
        m: &ModelDescriptor,
    ) -> Result<crate::model_download::Removal, StoreError> {
        self.cache.remove_quiesced(m, &mut || {
            self.unload(&m.model_id).map_err(|e| match e {
                StoreError::Explained(code, why) => StoreError::Explained(
                    code,
                    format!("{why}; nothing was deleted: retry `kb model remove` when it finishes"),
                ),
                other => other,
            })
        })
    }
    /// Probe a running worker without starting one.
    pub fn status(&self) -> Option<WorkerInfo> {
        if check_private_dir(&self.runtime_dir).is_err() {
            return None;
        }
        Conn::open(self, Instant::now() + Duration::from_secs(2), None)
            .ok()
            .map(|c| c.info.clone())
    }
    /// Connect to the shared worker, starting it if none is listening.
    /// Every wait (start lock, connect, handshake, startup) honours both the
    /// deadline and `cancel`.
    pub(crate) fn connect(
        &self,
        deadline: Instant,
        cancel: Option<&kb_client::CancellationToken>,
    ) -> Result<Conn, StoreError> {
        let result = self.connect_or_start(deadline, cancel);
        if let Ok(mut failure) = self.start_failure.lock() {
            match &result {
                Ok(_) => *failure = None,
                // The caller's own deadline or cancellation says nothing
                // about the worker.
                Err(StoreError::OperationAborted(_) | StoreError::DeadlineExceeded) => {}
                Err(e) => {
                    Self::remember_start_failure(&mut failure, e.to_string());
                }
            }
        }
        result
    }
    fn remember_start_failure(failure: &mut Option<(String, bool)>, why: String) {
        if failure.as_ref().is_none_or(|(known, _)| *known != why) {
            *failure = Some((why, false));
        }
    }
    /// Share a preflight failure with the connection failure diagnostic state.
    pub fn record_start_failure(&self, why: String) {
        if let Ok(mut failure) = self.start_failure.lock() {
            Self::remember_start_failure(&mut failure, why);
        }
    }
    /// R3-L7: why the worker last failed to start or answer, once per
    /// distinct reason (`kb mcp` reports it on stderr; searches meanwhile
    /// fall back to lexical with their notice).
    pub fn unreported_start_failure(&self) -> Option<String> {
        let mut failure = self.start_failure.lock().ok()?;
        match failure.as_mut() {
            Some((why, reported)) if !*reported => {
                *reported = true;
                Some(why.clone())
            }
            _ => None,
        }
    }
    /// R3-L7: why a worker could not be started from here now (a runtime
    /// directory problem such as a socket path too long), without starting one.
    pub fn startability(&self) -> Result<(), StoreError> {
        self.ensure_runtime_dir()?;
        if !self.executable.is_file() {
            return Err(worker_error(format!(
                "the `kb` executable `{}` that starts the embedding worker is missing",
                self.executable.display()
            )));
        }
        Ok(())
    }
    fn connect_or_start(
        &self,
        deadline: Instant,
        cancel: Option<&kb_client::CancellationToken>,
    ) -> Result<Conn, StoreError> {
        let stopped = || -> Result<(), StoreError> {
            if cancel.is_some_and(|c| c.is_cancelled()) {
                return Err(StoreError::OperationAborted(
                    kb_client::ErrorCode::Cancelled,
                ));
            }
            if Instant::now() >= deadline {
                return Err(StoreError::DeadlineExceeded);
            }
            Ok(())
        };
        stopped()?;
        self.ensure_runtime_dir()?;
        match Conn::open(self, deadline, cancel) {
            Ok(conn) => return Ok(conn),
            Err(e @ (StoreError::OperationAborted(_) | StoreError::DeadlineExceeded)) => {
                return Err(e);
            }
            Err(_) => {}
        }
        // One starter at a time; the others wait and then connect.
        let spawn = self.lock_file("start.lock")?;
        loop {
            match spawn.try_lock() {
                Ok(()) => break,
                Err(fs::TryLockError::WouldBlock) => {
                    stopped()?;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(fs::TryLockError::Error(e)) => return Err(StoreError::Io(e)),
            }
        }
        match Conn::open(self, deadline, cancel) {
            Ok(conn) => return Ok(conn),
            Err(e @ (StoreError::OperationAborted(_) | StoreError::DeadlineExceeded)) => {
                return Err(e);
            }
            Err(_) => {}
        }
        let mut child = Some(self.spawn_worker()?);
        let mut start_by = Instant::now() + START_TIMEOUT;
        let result = loop {
            if let Err(e) = stopped() {
                break Err(e);
            }
            let attempt = deadline.min(Instant::now() + Duration::from_secs(1));
            match Conn::open(self, attempt, cancel) {
                Ok(conn) => break Ok(conn),
                Err(e @ StoreError::OperationAborted(_)) => break Err(e),
                Err(_) => {}
            }
            // A draining predecessor keeps the instance lock until its model
            // is released; the fresh worker waits for it, and so does this
            // caller, bounded only by its own deadline and cancellation.
            if self.instance_held() {
                start_by = Instant::now() + START_TIMEOUT;
            }
            if Instant::now() >= deadline {
                break Err(StoreError::DeadlineExceeded);
            }
            if Instant::now() >= start_by {
                break Err(worker_error(
                    "the shared embedding worker did not start listening",
                ));
            }
            // A worker that exits before listening failed to start (a zero
            // exit means another worker owns the identity: keep waiting).
            if let Some(status) = child.as_mut().and_then(|c| c.try_wait().ok().flatten()) {
                child = None;
                if !status.success() {
                    break Err(worker_error(format!(
                        "the shared embedding worker exited at startup ({status})"
                    )));
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if let Some(child) = child {
            reap(child);
        }
        result
    }
    fn spawn_worker(&self) -> Result<std::process::Child, StoreError> {
        let mut cmd = std::process::Command::new(&self.executable);
        // Debug test runs can give the shared worker to their native owner.
        // The broker creates it as a direct child before acknowledging admission,
        // so a caller killed during startup cannot orphan a detached worker.
        // Release builds never consult this test-only control channel.
        #[cfg(all(unix, debug_assertions))]
        let brokered = if let (Some(owner), Some(socket)) = (
            std::env::var_os("KB_TEST_PROCESS_OWNER"),
            std::env::var_os("KB_TEST_PROCESS_SOCKET"),
        ) {
            cmd = std::process::Command::new(owner);
            cmd.arg("--escape-worker").arg(socket).arg(&self.executable);
            true
        } else {
            false
        };
        #[cfg(all(unix, not(debug_assertions)))]
        let brokered = false;
        cmd.args(self.worker_args())
            .current_dir(&self.runtime_dir)
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            // Its own process group: a terminal Ctrl-C aimed at one `kb mcp`
            // must not take down the worker every other session shares.
            use std::os::unix::process::CommandExt;
            if !brokered {
                cmd.process_group(0);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            for key in ["SystemRoot", "WINDIR"] {
                if let Some(value) = std::env::var_os(key) {
                    cmd.env(key, value);
                }
            }
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            // breaking away from a host kill-on-close job when allowed.
            const BASE: u32 = 0x0000_0008 | 0x0000_0200 | 0x0800_0000;
            const BREAKAWAY: u32 = 0x0100_0000;
            cmd.creation_flags(BASE | BREAKAWAY);
            if let Ok(child) = cmd.spawn() {
                return Ok(child);
            }
            cmd.creation_flags(BASE);
        }
        cmd.spawn().map_err(StoreError::Io)
    }
}

/// The detached worker outlives this process; reap it if it exits first.
fn reap(mut child: std::process::Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

fn check_private_dir(dir: &Path) -> Result<(), StoreError> {
    let meta = fs::symlink_metadata(dir).map_err(StoreError::Io)?;
    if crate::paths::is_link(&meta) || !meta.is_dir() {
        return Err(StoreError::UnsafePath(
            "embedding runtime directory is a link or not a directory".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.uid() != crate::model_download::own_uid()? || meta.permissions().mode() & 0o077 != 0
        {
            return Err(StoreError::UnsafePath(
                "embedding runtime directory is not owner-only".into(),
            ));
        }
    }
    #[cfg(windows)]
    if !crate::win::check_private(dir).map_err(StoreError::Io)? {
        return Err(StoreError::UnsafePath(
            "embedding runtime directory is not owner-only".into(),
        ));
    }
    Ok(())
}

/// ROOT 2: the worker proves it knows the instance key before a client sends
/// any document text.
fn proof(key: &[u8], nonce: &str, pid: u32) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    let tag = ring::hmac::sign(
        &key,
        format!("kb-embed-worker-v{PROTOCOL}\0{nonce}\0{pid}").as_bytes(),
    );
    tag.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
fn proof_valid(key: &[u8], nonce: &str, info: &WorkerInfo) -> bool {
    let expected = proof(key, nonce, info.pid);
    // Constant-time comparison of equal-length hex strings.
    expected.len() == info.proof.len()
        && expected
            .bytes()
            .zip(info.proof.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

// ── Wire ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    protocol: u32,
    version: String,
    models_dir: PathBuf,
    /// Fresh per connection; the worker proves it holds the instance key.
    nonce: String,
}
/// What a running worker reports in its handshake.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerInfo {
    pub protocol: u32,
    pub version: String,
    pub pid: u32,
    pub models_dir: PathBuf,
    /// The model currently in memory, if any.
    pub loaded: Option<String>,
    /// HMAC-SHA256(instance key, nonce + pid): only the worker that wrote the
    /// owner-only key file can answer (a stale or squatted endpoint cannot).
    pub proof: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Job {
    pub model_id: String,
    pub context_tokens: u32,
    pub text: String,
    pub purpose: Purpose,
    pub probe: bool,
    pub measure: bool,
    /// Control request (ROOT B): release `model_id` if it is resident. Runs
    /// before any queued inference; `text` is empty.
    pub unload: bool,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct Reply {
    pub token_count: Option<usize>,
    pub embedding: Option<Embedding>,
    pub too_long: bool,
    /// A failure the client may show the local owner (never document text).
    pub error: Option<String>,
}

async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    w: &mut W,
    v: &T,
) -> Result<(), StoreError> {
    let mut bytes = serde_json::to_vec(v).map_err(|_| unavailable())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(unavailable());
    }
    w.write_all(&bytes).await.map_err(|_| unavailable())?;
    w.flush().await.map_err(|_| unavailable())
}
async fn read_frame<R: AsyncRead + Unpin, T: DeserializeOwned>(
    r: &mut BufReader<R>,
) -> Result<T, StoreError> {
    let mut b = Vec::new();
    (&mut *r)
        .take(MAX_FRAME_BYTES as u64 + 1)
        .read_until(b'\n', &mut b)
        .await
        .map_err(|_| unavailable())?;
    if b.len() > MAX_FRAME_BYTES || b.last() != Some(&b'\n') {
        return Err(unavailable());
    }
    serde_json::from_slice(&b).map_err(|_| unavailable())
}

// ── Transport ───────────────────────────────────────────────────────────────

#[cfg(unix)]
type Stream = tokio::net::UnixStream;
#[cfg(windows)]
type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(unix)]
async fn connect_stream(host: &ModelHost) -> Result<Stream, StoreError> {
    let stream = tokio::net::UnixStream::connect(host.endpoint())
        .await
        .map_err(StoreError::Io)?;
    let peer = stream.peer_cred().map_err(StoreError::Io)?.uid();
    if peer != crate::model_download::own_uid()? {
        return Err(StoreError::UnsafePath(
            "embedding worker socket belongs to another user".into(),
        ));
    }
    Ok(stream)
}
#[cfg(windows)]
async fn connect_stream(host: &ModelHost) -> Result<Stream, StoreError> {
    // The name file is owner-only (checked by open_no_follow), so another
    // user can neither read nor plant the random pipe name.
    let mut name = String::new();
    std::io::Read::read_to_string(
        &mut crate::paths::open_no_follow(&host.endpoint(), OpenOptions::new().read(true))?,
        &mut name,
    )
    .map_err(StoreError::Io)?;
    if !name.starts_with(r"\\.\pipe\kb-embed-") || name.len() > 200 {
        return Err(unavailable());
    }
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(&name) {
            Ok(client) => return Ok(client),
            // ERROR_PIPE_BUSY: every instance is taken; the worker makes more.
            Err(e) if e.raw_os_error() == Some(231) => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(e) => return Err(StoreError::Io(e)),
        }
    }
}

/// One client connection, driven by its own I/O thread so synchronous
/// callers can poll cancellation, deadlines and store state while waiting.
pub(crate) struct Conn {
    pub info: WorkerInfo,
    jobs: tokio::sync::mpsc::Sender<Job>,
    replies: mpsc::Receiver<Result<Reply, StoreError>>,
    stop: Arc<tokio::sync::Notify>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Conn {
    fn drop(&mut self) {
        self.stop.notify_one();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
impl Conn {
    fn open(
        host: &ModelHost,
        deadline: Instant,
        cancel: Option<&kb_client::CancellationToken>,
    ) -> Result<Conn, StoreError> {
        // No key file: no live worker to authenticate.
        let key = host.read_key()?;
        let nonce: String = crate::state::random_bytes::<16>()?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let (jobs, mut job_rx) = tokio::sync::mpsc::channel::<Job>(1);
        let (reply_tx, replies) = mpsc::sync_channel(1);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stop = Arc::new(tokio::sync::Notify::new());
        let thread_stop = stop.clone();
        let host = host.clone();
        let thread = std::thread::spawn(move || {
            let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                let _ = ready_tx.send(Err(unavailable()));
                return;
            };
            rt.block_on(async move {
                let opened = async {
                    let stream = connect_stream(&host).await?;
                    let (r, mut w) = tokio::io::split(stream);
                    let mut r = BufReader::new(r);
                    write_frame(
                        &mut w,
                        &Hello {
                            protocol: PROTOCOL,
                            version: VERSION.into(),
                            models_dir: host.cache.dir().to_path_buf(),
                            nonce: nonce.clone(),
                        },
                    )
                    .await?;
                    let info: WorkerInfo = read_frame(&mut r).await?;
                    if !proof_valid(&key, &nonce, &info) {
                        return Err(StoreError::UnsafePath(
                            "the embedding worker endpoint did not prove the instance key".into(),
                        ));
                    }
                    if info.protocol != PROTOCOL || info.models_dir != host.cache.dir() {
                        return Err(worker_error("embedding worker handshake mismatch"));
                    }
                    Ok::<_, StoreError>((r, w, info))
                };
                let (mut r, mut w) = tokio::select! {
                    opened = opened => match opened {
                        Ok((r, w, info)) => {
                            if ready_tx.send(Ok(info)).is_err() {
                                return;
                            }
                            (r, w)
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                            return;
                        }
                    },
                    _ = thread_stop.notified() => return,
                };
                loop {
                    let job = tokio::select! {
                        job = job_rx.recv() => match job { Some(job) => job, None => return },
                        _ = thread_stop.notified() => return,
                    };
                    let reply = tokio::select! {
                        reply = async {
                            write_frame(&mut w, &job).await?;
                            read_frame::<_, Reply>(&mut r).await
                        } => reply,
                        _ = thread_stop.notified() => return,
                    };
                    let failed = reply.is_err();
                    if reply_tx.send(reply).is_err() || failed {
                        return;
                    }
                }
            });
            // This connection's own I/O thread and runtime, alive exactly as
            // long as the pooled connection. It spawns no blocking tasks;
            // shutting down without waiting keeps that true by construction.
            rt.shutdown_background();
        });
        let mut conn = Conn {
            info: WorkerInfo {
                protocol: 0,
                version: String::new(),
                pid: 0,
                models_dir: PathBuf::new(),
                loaded: None,
                proof: String::new(),
            },
            jobs,
            replies,
            stop,
            thread: Some(thread),
        };
        loop {
            match ready_rx.recv_timeout(Duration::from_millis(20)) {
                Ok(Ok(info)) => {
                    conn.info = info;
                    return Ok(conn);
                }
                Ok(Err(e)) => return Err(e),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(unavailable()),
                Err(mpsc::RecvTimeoutError::Timeout)
                    if cancel.is_some_and(|c| c.is_cancelled()) =>
                {
                    return Err(StoreError::OperationAborted(
                        kb_client::ErrorCode::Cancelled,
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= deadline => {
                    return Err(StoreError::DeadlineExceeded);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    pub(crate) fn send(&self, job: Job) -> Result<(), StoreError> {
        self.jobs.try_send(job).map_err(|_| unavailable())
    }
    /// `Ok(None)` = no reply yet within `wait`.
    pub(crate) fn poll(&self, wait: Duration) -> Result<Option<Reply>, StoreError> {
        match self.replies.recv_timeout(wait) {
            Ok(reply) => reply.map(Some),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(unavailable()),
        }
    }
}

// ── Worker ──────────────────────────────────────────────────────────────────

/// The engine: `(descriptor, context, cache, artifact, text, purpose, probe,
/// measure)`. `artifact` is the cache file found for this very request (a
/// cheap stat); the native engine loads (and verifies) at most one model at
/// a time and reloads whenever that file's identity changes. `None` explicitly
/// releases all resident weights; its error result is ignored by the worker.
pub type Engine = Box<
    dyn FnMut(
            &ModelDescriptor,
            u32,
            &ModelCache,
            Option<&crate::model_download::Artifact>,
            &str,
            Purpose,
            bool,
            bool,
        ) -> Result<ModelOutput, StoreError>
        + Send,
>;

struct Task {
    job: Job,
    reply: tokio::sync::oneshot::Sender<Reply>,
}
/// The worker's lifecycle, owned by the engine thread (every transition is
/// made under the queue lock, so admission and transitions are atomic):
///
/// * `Serving`: handshakes and new requests are accepted.
/// * `Draining`: entered when the lifetime expires (no successful request
///   for the idle period, decided at every dequeue and wake-up). From here
///   no handshake is ever accepted and no new request is admitted; queued
///   requests are dropped (their callers retry and reach a fresh worker:
///   the listener closes at once, and the fresh worker starts when this one
///   hands over the instance lock); the running request and every accepted
///   control finish.
/// * `Stopped`: nothing runs, the model is released; once the last admitted
///   reply is written the instance lock is handed over and the process
///   exits. At most one live worker per identity, ever.
///
/// Per model, `current` is Loaded; an accepted unload control makes it
/// Unloading until the engine releases it (Unloaded). Controls are engine
/// state once accepted: they run even if their caller disconnected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lifecycle {
    Serving,
    Draining,
    Stopped,
}
struct Queues {
    state: Lifecycle,
    /// Unload requests: tiny, never starved, run first, survive draining.
    control: VecDeque<Task>,
    queries: VecDeque<Task>,
    documents: VecDeque<Task>,
}
impl Default for Queues {
    fn default() -> Self {
        Self {
            state: Lifecycle::Serving,
            control: VecDeque::new(),
            queries: VecDeque::new(),
            documents: VecDeque::new(),
        }
    }
}
struct Shared {
    queues: Mutex<Queues>,
    ready: Condvar,
    last: Mutex<Instant>,
    loaded: Mutex<Option<String>>,
    /// Start of the job the engine is running now (watchdog).
    running: Mutex<Option<Instant>>,
    /// Successful-activity lifetime: no success for this long ends the worker.
    idle: Duration,
    /// Lifecycle transitions, for the listener.
    changed: tokio::sync::Notify,
    /// Admitted requests whose reply has not been written yet.
    inflight: std::sync::atomic::AtomicUsize,
}
/// A single embedding never legitimately takes this long, even at 8K
/// tokens on a slow CPU; a wedged native call ends the worker so the next
/// client starts a fresh one instead of every search waiting on it.
const MAX_JOB: Duration = Duration::from_secs(600);
impl Shared {
    fn state(&self) -> Lifecycle {
        self.queues
            .lock()
            .map(|q| q.state)
            .unwrap_or(Lifecycle::Stopped)
    }
    /// Expired once no request has SUCCEEDED for `idle`, however busy the
    /// worker is with failing ones.
    fn expired(&self) -> bool {
        self.last
            .lock()
            .map(|l| l.elapsed() >= self.idle)
            .unwrap_or(true)
    }
    fn until_expiry(&self) -> Duration {
        self.last
            .lock()
            .map(|l| self.idle.saturating_sub(l.elapsed()))
            .unwrap_or(Duration::ZERO)
            .max(Duration::from_millis(1))
    }
    /// Serving -> Draining (the queue lock held): queued work is dropped so
    /// its callers retry on a fresh worker; accepted controls stay.
    fn begin_drain(&self, q: &mut Queues) {
        if q.state == Lifecycle::Serving {
            q.state = Lifecycle::Draining;
            q.queries.clear();
            q.documents.clear();
            self.changed.notify_one();
        }
    }
    fn touch(&self) {
        if let Ok(mut last) = self.last.lock() {
            *last = Instant::now();
        }
    }
}

/// After this many queries in a row a waiting document batch (a build or a
/// configuration probe) runs next: queries stay fast and builds keep making
/// progress under sustained query traffic (ROOT 3).
const QUERY_BURST: u32 = 3;
/// At most this many requests for the loaded model may overtake an older
/// request for another model before the worker switches (bounded reloads,
/// bounded wait).
const SAME_MODEL_BURST: u32 = 16;

#[derive(Default)]
struct Fairness {
    queries_in_a_row: u32,
    query_overtaken: u32,
    document_overtaken: u32,
}

/// Pick the next task: queries first but a document every `QUERY_BURST`,
/// and within a class the loaded model's requests first but never more than
/// `SAME_MODEL_BURST` times past an older request for another model.
fn pick(q: &mut Queues, loaded: Option<&str>, f: &mut Fairness) -> Option<Task> {
    if let Some(control) = q.control.pop_front() {
        return Some(control);
    }
    let queries =
        !q.queries.is_empty() && (q.documents.is_empty() || f.queries_in_a_row < QUERY_BURST);
    let (class, overtaken) = if queries {
        f.queries_in_a_row = f.queries_in_a_row.saturating_add(1);
        (&mut q.queries, &mut f.query_overtaken)
    } else if !q.documents.is_empty() {
        f.queries_in_a_row = 0;
        (&mut q.documents, &mut f.document_overtaken)
    } else {
        return None;
    };
    let same = loaded.and_then(|m| class.iter().position(|t| t.job.model_id == m));
    match same {
        Some(0) | None => {
            *overtaken = 0;
            class.pop_front()
        }
        Some(i) if *overtaken < SAME_MODEL_BURST => {
            *overtaken += 1;
            class.remove(i)
        }
        Some(_) => {
            *overtaken = 0;
            class.pop_front()
        }
    }
}

fn engine_loop(shared: Arc<Shared>, cache: ModelCache, mut engine: Engine) {
    let mut fairness = Fairness::default();
    let mut current: Option<String> = None;
    let release = |engine: &mut Engine, current: &mut Option<String>| {
        if let Some(m) = current.take().and_then(|id| descriptor(&id).ok()) {
            let _ = engine(&m, 0, &cache, None, "", Purpose::Document, false, false);
        }
        if let Ok(mut loaded) = shared.loaded.lock() {
            *loaded = None;
        }
    };
    loop {
        let task = {
            let Ok(mut q) = shared.queues.lock() else {
                return;
            };
            loop {
                // The lifetime decision, at every dequeue (so after every job
                // completion) and every wake-up: back-to-back work, failing
                // or not, cannot postpone it.
                if q.state == Lifecycle::Serving && shared.expired() {
                    shared.begin_drain(&mut q);
                }
                if let Some(control) = q.control.pop_front() {
                    break Some(control);
                }
                if q.state != Lifecycle::Serving {
                    break None;
                }
                if let Some(t) = pick(&mut q, current.as_deref(), &mut fairness) {
                    break Some(t);
                }
                q = match shared.ready.wait_timeout(q, shared.until_expiry()) {
                    Ok((q, _)) => q,
                    Err(_) => return,
                };
            }
        };
        let Some(task) = task else {
            // Draining and nothing accepted is left: release, then Stopped.
            release(&mut engine, &mut current);
            if let Ok(mut q) = shared.queues.lock() {
                q.state = Lifecycle::Stopped;
            }
            shared.changed.notify_one();
            return;
        };
        // A remover or a disabling store asks for the model to go (ROOT B).
        // Accepted controls are engine state: they run even when their caller
        // has disconnected (e.g. it gave up waiting behind a long request).
        // Not activity: no lifetime extension.
        if task.job.unload {
            if current.as_deref() == Some(task.job.model_id.as_str()) {
                release(&mut engine, &mut current);
            }
            let _ = task.reply.send(Reply::default());
            continue;
        }
        // Its client gave up (deadline, cancellation, disconnect): skip it.
        if task.reply.is_closed() {
            continue;
        }
        // Removal/mismatch invalidates resident mappings even if this request
        // fails before inference (or asks for a different, unavailable model).
        if let Some(m) = current.as_deref().and_then(|id| descriptor(id).ok())
            && cache.resolve(&m).is_err()
        {
            let _ = engine(&m, 0, &cache, None, "", Purpose::Document, false, false);
            current = None;
            if let Ok(mut loaded) = shared.loaded.lock() {
                *loaded = None;
            }
        }
        let job = &task.job;
        let result = descriptor(&job.model_id).and_then(|m| {
            m.estimate_bytes(job.context_tokens)?;
            // ROOT 3: every request re-finds the cache file, so a removed or
            // replaced model is refused (or reloaded) at once, whichever
            // store or process removed it.
            let artifact = cache.resolve(&m)?;
            if let Ok(mut running) = shared.running.lock() {
                *running = Some(Instant::now());
            }
            let result = engine(
                &m,
                job.context_tokens,
                &cache,
                Some(&artifact),
                &job.text,
                job.purpose,
                job.probe,
                job.measure,
            );
            current = if result.is_ok() {
                Some(m.model_id.clone())
            } else {
                let _ = engine(&m, 0, &cache, None, "", Purpose::Document, false, false);
                None
            };
            if let Ok(mut loaded) = shared.loaded.lock() {
                *loaded = current.clone();
            }
            result
        });
        // Only successful work extends the idle lifetime. A stream of missing
        // artifacts, bad model IDs or failed inference cannot pin the worker.
        if result.is_ok() {
            shared.touch();
        }
        let reply = match result {
            Ok(ModelOutput::TokenCount(n)) => Reply {
                token_count: Some(n),
                ..Reply::default()
            },
            Ok(ModelOutput::Embedding(e)) => Reply {
                embedding: Some(e),
                ..Reply::default()
            },
            Err(e) => Reply {
                too_long: e.protocol_code() == kb_client::ErrorCode::EmbeddingInputTooLong,
                error: Some(match &e {
                    StoreError::Explained(_, why) => why.clone(),
                    _ => "embedding failed".into(),
                }),
                ..Reply::default()
            },
        };
        if let Ok(mut running) = shared.running.lock() {
            *running = None;
        }
        let _ = task.reply.send(reply);
    }
}

async fn serve_connection<S: AsyncRead + AsyncWrite>(
    stream: S,
    shared: Arc<Shared>,
    models_dir: PathBuf,
    key: Arc<Vec<u8>>,
) -> Result<(), StoreError> {
    let (r, mut w) = tokio::io::split(stream);
    let mut r = BufReader::new(r);
    let hello: Hello = read_frame(&mut r).await?;
    if hello.protocol != PROTOCOL
        || hello.models_dir != models_dir
        || hello.nonce.len() != 32
        || !hello.nonce.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(unavailable());
    }
    // Only a Serving instance ever completes a handshake: a client refused
    // here starts (or reaches) a fresh worker instead of retrying on one
    // that is going away.
    if shared.state() != Lifecycle::Serving {
        return Err(unavailable());
    }
    let loaded = shared.loaded.lock().ok().and_then(|l| l.clone());
    write_frame(
        &mut w,
        &WorkerInfo {
            protocol: PROTOCOL,
            version: VERSION.into(),
            pid: std::process::id(),
            models_dir,
            loaded,
            proof: proof(&key, &hello.nonce, std::process::id()),
        },
    )
    .await?;
    // Only work counts as activity: an idle pooled connection or a status
    // probe never keeps the worker (and its model) alive.
    loop {
        let job: Job = read_frame(&mut r).await?;
        let limit = if job.measure {
            crate::git_read::DOCUMENT_MAX_BYTES
        } else {
            crate::qwen::MAX_TEXT_BYTES
        };
        if job.text.len() > limit
            || (job.probe && job.measure)
            || (job.unload && (job.probe || job.measure || !job.text.is_empty()))
        {
            return Err(unavailable());
        }
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        {
            let mut q = shared.queues.lock().map_err(|_| unavailable())?;
            // Only Serving admits work (the client retries on a fresh worker);
            // a control on a connection already open is still accepted while
            // Draining (it completes before Stopped).
            if q.state == Lifecycle::Stopped || (q.state != Lifecycle::Serving && !job.unload) {
                return Err(unavailable());
            }
            shared
                .inflight
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            let query = matches!(job.purpose, Purpose::Query);
            let control = job.unload;
            let task = Task { job, reply: tx };
            if control {
                q.control.push_back(task);
            } else if query {
                q.queries.push_back(task);
            } else {
                q.documents.push_back(task);
            }
        }
        shared.ready.notify_one();
        // A client never writes while it waits: any byte or EOF here means it
        // abandoned the request, which drops `rx` so the engine skips it.
        struct Admitted<'a>(&'a Shared);
        impl Drop for Admitted<'_> {
            fn drop(&mut self) {
                self.0
                    .inflight
                    .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                self.0.changed.notify_one();
            }
        }
        let _admitted = Admitted(&shared);
        let reply = tokio::select! {
            reply = &mut rx => reply,
            _ = r.fill_buf() => return Err(unavailable()),
        };
        write_frame(&mut w, &reply.map_err(|_| unavailable())?).await?;
    }
}

/// Run the shared worker through its lifecycle (see [`Lifecycle`]).
/// Returns at once (Ok) when another worker already serves this identity.
pub fn serve(host: &ModelHost, engine: Engine) -> Result<(), StoreError> {
    host.ensure_runtime_dir()?;
    // The lifecycle lock, shared for this process's whole life (Serving and
    // Draining): an exclusive holder proves no worker is alive.
    let alive = host.lock_file("alive.lock")?;
    let wait = Instant::now() + Duration::from_secs(2);
    loop {
        match alive.try_lock_shared() {
            Ok(()) => break,
            // A remover's momentary exclusive probe.
            Err(fs::TryLockError::WouldBlock) if Instant::now() < wait => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(fs::TryLockError::WouldBlock) => return Err(unavailable()),
            Err(fs::TryLockError::Error(e)) => return Err(StoreError::Io(e)),
        }
    }
    let instance = host.lock_file("lock")?;
    // A draining predecessor keeps the instance lock until its model is
    // released (at most its one admitted request, under the watchdog): wait
    // for it. Exit instead when a Serving worker already answers (this start
    // raced a healthy instance), or after the watchdog bound.
    let wait = Instant::now() + MAX_JOB + Duration::from_secs(30);
    let mut probe = Instant::now() + Duration::from_secs(1);
    loop {
        match instance.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if Instant::now() < wait => {
                if Instant::now() >= probe {
                    if host.status().is_some() {
                        return Ok(());
                    }
                    probe = Instant::now() + Duration::from_secs(1);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(fs::TryLockError::WouldBlock) => return Ok(()),
            Err(fs::TryLockError::Error(e)) => return Err(StoreError::Io(e)),
        }
    }
    let shared = Arc::new(Shared {
        queues: Mutex::new(Queues::default()),
        ready: Condvar::new(),
        last: Mutex::new(Instant::now()),
        loaded: Mutex::new(None),
        running: Mutex::new(None),
        idle: host.idle,
        changed: tokio::sync::Notify::new(),
        inflight: std::sync::atomic::AtomicUsize::new(0),
    });
    {
        let shared = shared.clone();
        let cache = host.cache.clone();
        std::thread::spawn(move || engine_loop(shared, cache, engine));
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(StoreError::Io)?;
    let endpoint = host.endpoint();
    let models_dir = host.cache.dir().to_path_buf();
    // A fresh instance key before listening: clients authenticate this
    // worker by it (a stale endpoint of a dead worker cannot answer).
    let key = Arc::new(host.write_key()?);
    let key_path = host.key_path();
    let watchdog = || {
        let running = shared.running.lock().ok().and_then(|r| *r);
        if running.is_some_and(|started| started.elapsed() >= MAX_JOB) {
            let _ = fs::remove_file(&endpoint);
            std::process::exit(70);
        }
    };
    let serving = || shared.state() == Lifecycle::Serving;
    let result = rt.block_on(async {
        // ── Serving ──
        #[cfg(unix)]
        {
            // We hold the instance lock: any existing socket file is stale.
            match fs::symlink_metadata(&endpoint) {
                Ok(meta) if meta.is_dir() => return Err(unavailable()),
                Ok(_) => fs::remove_file(&endpoint).map_err(StoreError::Io)?,
                Err(_) => {}
            }
            let listener = tokio::net::UnixListener::bind(&endpoint).map_err(StoreError::Io)?;
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600))
                    .map_err(StoreError::Io)?;
            }
            let uid = crate::model_download::own_uid()?;
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            while serving() {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        if stream.peer_cred().map(|c| c.uid()).ok() != Some(uid) {
                            continue;
                        }
                        let shared = shared.clone();
                        let models_dir = models_dir.clone();
                        let key = key.clone();
                        tokio::spawn(async move {
                            let _ = serve_connection(stream, shared, models_dir, key).await;
                        });
                    }
                    _ = shared.changed.notified() => {}
                    _ = tick.tick() => watchdog(),
                }
            }
            drop(listener);
        }
        #[cfg(windows)]
        {
            let name = format!(
                r"\\.\pipe\kb-embed-{}-{}",
                host.identity(),
                crate::state::new_uuid_v4()?
            );
            let mut server = crate::win::create_private_pipe(&name, true).map_err(StoreError::Io)?;
            // The runtime directory's inherited owner-only ACL protects the file.
            let temp = endpoint.with_extension(format!("pipe.{}", crate::state::new_uuid_v4()?));
            fs::write(&temp, name.as_bytes()).map_err(StoreError::Io)?;
            fs::rename(&temp, &endpoint).map_err(StoreError::Io)?;
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            while serving() {
                tokio::select! {
                    connected = server.connect() => {
                        if connected.is_err() {
                            server = crate::win::create_private_pipe(&name, false).map_err(StoreError::Io)?;
                            continue;
                        }
                        let next = crate::win::create_private_pipe(&name, false).map_err(StoreError::Io)?;
                        let stream = std::mem::replace(&mut server, next);
                        let shared = shared.clone();
                        let models_dir = models_dir.clone();
                        let key = key.clone();
                        tokio::spawn(async move {
                            let _ = serve_connection(stream, shared, models_dir, key).await;
                        });
                    }
                    _ = shared.changed.notified() => {}
                    _ = tick.tick() => watchdog(),
                }
            }
            drop(server);
        }
        // ── Draining ── handshakes are already refused; unpublish the endpoint
        // and key. The instance lock is KEPT until the engine has stopped and
        // released its model: at most one live worker per identity, ever. A
        // client retry (or a new worker) waits on it, bounded by its own
        // deadline and cancellation; the wait is at most the one admitted
        // request, itself bounded by the watchdog.
        let _ = fs::remove_file(&endpoint);
        let _ = fs::remove_file(&key_path);
        // Connections already open keep running: the admitted request and
        // accepted controls finish and their replies are written.
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        let mut stopped_at = None;
        loop {
            let stopped = shared.state() == Lifecycle::Stopped;
            if stopped && stopped_at.is_none() {
                stopped_at = Some(Instant::now());
            }
            let flushed = shared.inflight.load(std::sync::atomic::Ordering::Acquire) == 0;
            // A reply nobody reads cannot hold the exit for long.
            if stopped && (flushed || stopped_at.is_some_and(|t| t.elapsed() >= Duration::from_secs(5))) {
                break;
            }
            tokio::select! {
                _ = shared.changed.notified() => {}
                _ = tick.tick() => watchdog(),
            }
        }
        // Stopped (model released) and replies written: hand over.
        drop(instance);
        Ok(())
    });
    rt.shutdown_timeout(Duration::ZERO);
    drop(alive);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_and_connection_failures_share_one_diagnostic_per_reason() {
        let mut failure = None;
        ModelHost::remember_start_failure(&mut failure, "socket path too long".into());
        failure.as_mut().expect("failure").1 = true;
        ModelHost::remember_start_failure(&mut failure, "socket path too long".into());
        assert!(
            failure.as_ref().expect("same failure").1,
            "the preflight reason was already reported"
        );
        ModelHost::remember_start_failure(&mut failure, "worker exited".into());
        assert!(
            !failure.as_ref().expect("new failure").1,
            "a different reason is reportable"
        );
    }

    fn task(model: &str, purpose: Purpose) -> (Task, tokio::sync::oneshot::Receiver<Reply>) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        (
            Task {
                job: Job {
                    model_id: model.into(),
                    context_tokens: 1024,
                    text: String::new(),
                    purpose,
                    probe: false,
                    measure: false,
                    unload: false,
                },
                reply,
            },
            receiver,
        )
    }

    #[test]
    fn mixed_class_traffic_cannot_reset_another_queues_model_fairness_debt() {
        for waiting in [Purpose::Query, Purpose::Document] {
            let mut queues = Queues::default();
            let mut fairness = Fairness::default();
            let mut loaded = "A".to_owned();
            let mut receivers = Vec::new();
            // Repeat after switches and new waiting heads: every older request
            // for B must run while A traffic keeps arriving in BOTH classes.
            for _ in 0..8 {
                let (older, receiver) = task("B", waiting);
                receivers.push(receiver);
                let queue = if matches!(waiting, Purpose::Query) {
                    &mut queues.queries
                } else {
                    &mut queues.documents
                };
                // Drain the previous round's A backlog before this round's head.
                queue.clear();
                queue.push_back(older);
                let mut served = false;
                for turn in 0..800 {
                    for purpose in [Purpose::Query, Purpose::Document] {
                        let (new, receiver) = task("A", purpose);
                        receivers.push(receiver);
                        if matches!(purpose, Purpose::Query) {
                            queues.queries.push_back(new);
                        } else {
                            queues.documents.push_back(new);
                        }
                    }
                    let next =
                        pick(&mut queues, Some(&loaded), &mut fairness).expect("queued work");
                    loaded = next.job.model_id;
                    if loaded == "B" {
                        assert!(turn < (SAME_MODEL_BURST + 1) * (QUERY_BURST + 1));
                        served = true;
                        break;
                    }
                }
                assert!(
                    served,
                    "{waiting:?} head starved under mixed-class A traffic"
                );
            }
        }
    }
}
