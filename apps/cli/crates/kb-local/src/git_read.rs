//! Hardened, supervised, read-only Git access to a managed bare repository.
//!
//! * Every child gets an emptied environment (only `PATH`, plus the Windows
//!   process essentials), an explicit `--git-dir`, no system/global config,
//!   no replace refs, grafts or shallow boundary (`GIT_GRAFT_FILE` and
//!   `GIT_SHALLOW_FILE` point at the null device), no commit-graph,
//!   multi-pack-index or bitmap shortcuts, no hooks, fsmonitor, credential
//!   helpers, transports, auto-gc or maintenance (a publication's lock
//!   rolls small packs up instead, see `git_write::consolidate_objects`).
//!   Arguments are fixed
//!   literals, validated 40-hex SHAs or absolute store-owned scratch paths —
//!   nothing caller-controlled reaches argv as an option.
//! * Before every spawn the repository itself is checked
//!   ([`GitRepo::check_integrity`]): the repo-local `config` may contain only
//!   an allowlisted `[core]` subset (no `include`, `extensions`, hooks or any
//!   other key), and object alternates / `commondir` are refused (a staged
//!   object store's own `info/alternates`, written by [`GitRepo::staged`]
//!   inside managed scratch, is the only alternates file Git reads). The one
//!   enforcement point is [`GitRepo::command`], used by reads and by
//!   `git_write` alike.
//! * Every child is supervised: stdin closed or owned, stderr discarded,
//!   stdout read with a byte cap, and a watchdog kills it at its deadline.
//!   Dropping a handle kills and reaps the child.
//! * Objects are read through one `git cat-file --batch` session and parsed
//!   here (raw tree bytes, commit headers), so budgets are checked from the
//!   object header before any content is read, and tree order/duplicates are
//!   seen exactly as stored. Modes are canonicalized like Git's tree walker
//!   (`canon_mode`), matching the TypeScript `ls-tree` reading.
//! * A readable revision is a commit object reachable from `refs/heads/*` of
//!   THIS repository; anything else is `NotFound`.
//!
//! No writes happen here.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
#[cfg(unix)]
type NativeChild = std::process::Child;
#[cfg(windows)]
type NativeChild = crate::win::ProcessChild;
#[cfg(unix)]
type ChildStdin = std::process::ChildStdin;
#[cfg(unix)]
type ChildStdout = std::process::ChildStdout;
#[cfg(windows)]
type ChildStdin = std::fs::File;
#[cfg(windows)]
type ChildStdout = std::fs::File;

pub(crate) enum Input {
    Null,
    Pipe,
    From(ChildStdout),
}
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kb_client::ErrorCode;
use kb_client::snapshot::content_hash;
use kb_client::types::{KbId, KbPath, Sha};

use crate::StoreError;
use crate::markdown::{MarkdownIssue, SourceDocument, parse_markdown};
use crate::paths::StorePaths;

/// Default wall-clock bound for one Git child (validation bounded
/// 60s). Tests inject a shorter one with [`GitRepo::with_timeout`].
pub const GIT_TIMEOUT: Duration = Duration::from_secs(60);
thread_local! {
    static OPERATION_CANCEL: std::cell::RefCell<Option<Arc<AtomicBool>>> = const { std::cell::RefCell::new(None) };
    static OPERATION_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
    static OPERATION_CLOCK: std::cell::Cell<fn() -> Instant> = const { std::cell::Cell::new(Instant::now) };
}

thread_local! { static TRANSPORT_CONTROL: std::cell::RefCell<Option<kb_client::stdio::CallControl>> = const { std::cell::RefCell::new(None) }; }
// A test can park the pack feeder until the supervised indexer is killed.
// Thread-local and one-shot, so parallel publications are unaffected.
#[cfg(test)]
pub(crate) struct PackInstallProbe {
    pub budget: Option<Duration>,
    pub indexed: Box<dyn FnOnce(Arc<Mutex<ProcessChild>>, std::path::PathBuf)>,
}
#[cfg(test)]
thread_local! {
    pub(crate) static PACK_INSTALL_PROBE: std::cell::RefCell<Option<PackInstallProbe>> = const { std::cell::RefCell::new(None) };
}
/// Synchronous service scope: every Git handle/child shares one absolute
/// deadline, including readers opened by recovery and the dream guard.
pub(crate) struct OperationDeadline(
    Option<Instant>,
    Option<Arc<AtomicBool>>,
    Option<Option<kb_client::stdio::CallControl>>,
    fn() -> Instant,
);
impl OperationDeadline {
    pub(crate) fn now() -> Instant {
        (OPERATION_CLOCK.get())()
    }
    pub(crate) fn transport(control: kb_client::stdio::CallControl) -> Self {
        let mut scope = Self::bounded(control.until(), control.work_flag());
        scope.2 = Some(TRANSPORT_CONTROL.replace(Some(control)));
        scope
    }
    pub(crate) fn reserve_transport() -> Result<(), StoreError> {
        Self::check()?;
        TRANSPORT_CONTROL.with(|c| {
            if let Some(c) = c.borrow().as_ref() {
                c.reserve().map_err(StoreError::OperationAborted)?;
                OPERATION_CANCEL.replace(None);
            }
            Ok(())
        })
    }

    pub(crate) fn start() -> Self {
        Self::with_timeout(Duration::from_secs(30))
    }
    /// A nested scope that ends at `budget` from now or at the enclosing
    /// deadline, whichever is first (maintenance inside a caller's call).
    pub(crate) fn budget(budget: Duration) -> Self {
        Self::with_timeout(budget)
    }
    /// Time left in the current scope (zero once cancelled); `None` without
    /// a deadline.
    pub(crate) fn remaining() -> Option<Duration> {
        if OPERATION_CANCEL.with(|c| {
            c.borrow()
                .as_ref()
                .is_some_and(|c| c.load(Ordering::Acquire))
        }) {
            return Some(Duration::ZERO);
        }
        OPERATION_DEADLINE
            .get()
            .map(|deadline| deadline.saturating_duration_since(Self::now()))
    }
    // Tests shorten the same thread-local operation scope; production enters
    // through start() (the thirty-second service bound) or a nested budget.
    fn with_timeout(timeout: Duration) -> Self {
        let deadline = Self::now() + timeout;
        Self(
            OPERATION_DEADLINE.replace(Some(
                OPERATION_DEADLINE
                    .get()
                    .map_or(deadline, |old| old.min(deadline)),
            )),
            OPERATION_CANCEL.with(|c| c.borrow().clone()),
            None,
            OPERATION_CLOCK.get(),
        )
    }
    pub(crate) fn bounded(deadline: Instant, cancel: Arc<AtomicBool>) -> Self {
        Self::bounded_with_clock(deadline, cancel, Instant::now)
    }
    pub(crate) fn bounded_with_clock(
        deadline: Instant,
        cancel: Arc<AtomicBool>,
        clock: fn() -> Instant,
    ) -> Self {
        Self(
            OPERATION_DEADLINE.replace(Some(
                OPERATION_DEADLINE
                    .get()
                    .map_or(deadline, |old| old.min(deadline)),
            )),
            OPERATION_CANCEL.replace(Some(cancel)),
            None,
            OPERATION_CLOCK.replace(clock),
        )
    }
    #[cfg(test)]
    pub(crate) fn for_test(timeout: Duration) -> Self {
        Self::with_timeout(timeout)
    }
    pub(crate) fn check() -> Result<(), StoreError> {
        if OPERATION_CANCEL.with(|c| {
            c.borrow()
                .as_ref()
                .is_some_and(|c| c.load(Ordering::Acquire))
        }) {
            return Err(StoreError::OperationAborted(
                kb_client::ErrorCode::Cancelled,
            ));
        }
        if OPERATION_DEADLINE.get().is_some_and(|d| Self::now() >= d) {
            return Err(StoreError::DeadlineExceeded);
        }
        Ok(())
    }
}
impl Drop for OperationDeadline {
    fn drop(&mut self) {
        OPERATION_DEADLINE.set(self.0);
        OPERATION_CLOCK.set(self.3);
        OPERATION_CANCEL.set(self.1.clone());
        if let Some(old) = self.2.take() {
            TRANSPORT_CONTROL.set(old);
        }
    }
}
/// Largest tree or commit object read (the TS reader's 8 MiB buffer).
pub const METADATA_OBJECT_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Largest document source returned by [`read_document`].
pub const DOCUMENT_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Maximum nesting of tree objects below the root.
pub const MAX_TREE_DEPTH: usize = 32;

pub(crate) const NULL_DEVICE: &str = "/dev/null"; // Git for Windows maps this to `nul`.

/// Git read failure. Messages carry no document content.
#[derive(Debug)]
pub enum GitError {
    /// Missing object, wrong object type or not reachable in this repository.
    NotFound,
    /// A traversal/read budget was exceeded (terminated early).
    Budget(String),
    /// An object Git accepts that can never be a KB tree/commit.
    Structure(String),
    Timeout,
    Cancelled,
    /// Git exited unsuccessfully or produced unexpected output.
    Failed(String),
    Io(std::io::Error),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::NotFound => f.write_str("git object not found"),
            GitError::Budget(why) => write!(f, "git read budget exceeded: {why}"),
            GitError::Structure(why) => write!(f, "malformed git object: {why}"),
            GitError::Timeout => f.write_str("git command timed out"),
            GitError::Cancelled => f.write_str("git command cancelled"),
            GitError::Failed(why) => write!(f, "git command failed: {why}"),
            GitError::Io(error) => write!(f, "git i/o error: {error}"),
        }
    }
}

impl std::error::Error for GitError {}

impl From<std::io::Error> for GitError {
    fn from(error: std::io::Error) -> Self {
        GitError::Io(error)
    }
}

impl From<GitError> for StoreError {
    fn from(error: GitError) -> Self {
        match error {
            GitError::NotFound => StoreError::NotFound,
            GitError::Budget(why) => StoreError::InvalidArgument(why),
            GitError::Structure(why) => StoreError::RecoveryRequired(why),
            GitError::Timeout => StoreError::DeadlineExceeded,
            GitError::Cancelled => StoreError::OperationAborted(ErrorCode::Cancelled),
            other => StoreError::StorageUnavailable(other.to_string()),
        }
    }
}

fn is_sha(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_sha(text: &[u8]) -> Result<Sha, GitError> {
    std::str::from_utf8(text)
        .ok()
        .filter(|s| is_sha(s))
        .and_then(|s| Sha::parse(s).ok())
        .ok_or_else(|| GitError::Failed("unexpected object name".into()))
}

// ── Supervised children ────────────────────────────────────────────────────

/// A native child retaining its caller's lease until it is reaped.
/// Git descendants inherit the store lock; dropping this handle cannot unlock
/// their file description (Unix) or bypass the successor Job drain (Windows).
/// Credential children keep the caller's lease in the parent and independently
/// open their effect fence before receiving input.
pub struct ProcessChild {
    native: NativeChild,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    owner: Option<Arc<crate::locks::LockOwner>>,
}

impl ProcessChild {
    pub(crate) fn new(
        mut native: NativeChild,
        owner: Option<Arc<crate::locks::LockOwner>>,
    ) -> Self {
        Self {
            stdin: native.stdin.take(),
            stdout: native.stdout.take(),
            native,
            owner,
        }
    }

    pub fn id(&self) -> u32 {
        self.native.id()
    }

    pub fn kill(&mut self) -> std::io::Result<()> {
        self.native.kill()
    }

    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        drop(self.stdin.take());
        let status = self.native.wait()?;
        drop(self.owner.take());
        Ok(status)
    }

    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self.native.try_wait()?;
        if status.is_some() {
            drop(self.owner.take());
        }
        Ok(status)
    }
}

/// A spawned Git child with a deadline watchdog. Drop kills and reaps it.
struct Supervised {
    child: Arc<Mutex<ProcessChild>>,
    stop: Option<Sender<()>>,
    watchdog: Option<JoinHandle<Option<ErrorCode>>>,
}

impl Supervised {
    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }

    /// Reap under the deadline, then stop the watchdog. EOF does not imply
    /// exit. Never hold the child mutex across a blocking wait: the watchdog
    /// needs it to kill a process that closed stdout and then parked.
    fn finish(self) -> Result<bool, GitError> {
        Ok(self.finish_status()?.success())
    }

    /// [`Supervised::finish`] with the exit status itself.
    fn finish_status(mut self) -> Result<std::process::ExitStatus, GitError> {
        let status = loop {
            let status = self
                .child
                .lock()
                .map_err(|_| GitError::Failed("child lock poisoned".into()))?
                .try_wait()?;
            if let Some(status) = status {
                break status;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        if let Some(reason) = self.stop_watchdog() {
            return Err(if reason == ErrorCode::Cancelled {
                GitError::Cancelled
            } else {
                GitError::Timeout
            });
        }
        Ok(status)
    }

    fn stop_watchdog(&mut self) -> Option<ErrorCode> {
        drop(self.stop.take());
        self.watchdog
            .take()
            .map(|handle| handle.join().unwrap_or(Some(ErrorCode::DeadlineExceeded)))
            .unwrap_or(None)
    }
}

impl Drop for Supervised {
    fn drop(&mut self) {
        if self.watchdog.is_some() {
            self.kill();
            self.stop_watchdog();
            if let Ok(mut child) = self.child.lock() {
                let _ = child.wait();
            }
        }
    }
}

// ── Repository handle ──────────────────────────────────────────────────────

/// A path as Git must be given it: canonical paths keep their verbatim
/// form for integrity checks, but Git's Win32 open() rejects the `?` in
/// Rust's verbatim prefix, including for config and objects, so Windows
/// gets ordinary drive/UNC spelling.
fn git_spelling(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
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
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

/// A managed bare repository.
#[derive(Clone, Debug)]
pub struct GitRepo {
    git_dir: PathBuf,
    timeout: Duration,
    store: Option<StorePaths>,
    /// Disposable object stores layered over the repository's own (newest
    /// first): Git writes only into the first and reads all of them plus the
    /// canonical store. Planning (merges, statuses, candidate commits) runs
    /// here; only a successful publication promotes what it needs.
    overlays: Vec<PathBuf>,
}

/// Repo-local config keys (all under `[core]`) a managed repository may carry,
/// with their permitted values. Everything else is refused.
const SAFE_CORE_KEYS: [(&str, &[&str]); 7] = [
    ("repositoryformatversion", &["0"]),
    ("bare", &["true"]),
    ("filemode", &["true", "false"]),
    ("ignorecase", &["true", "false"]),
    ("precomposeunicode", &["true", "false"]),
    ("symlinks", &["true", "false"]),
    ("logallrefupdates", &["true", "false"]),
];

/// Files that would make Git read objects from, or resolve the repository
/// through, somewhere else.
const REFUSED_REPO_FILES: [&str; 3] = [
    "objects/info/alternates",
    "objects/info/http-alternates",
    "commondir",
];

/// `Err` unless `config` is exactly an allowlisted `[core]` subset.
fn check_config(config: &str) -> Result<(), GitError> {
    let refuse = |why: &str| {
        Err(GitError::Structure(format!(
            "unsafe repository config: {why}"
        )))
    };
    let mut in_core = false;
    for raw in config.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            in_core = line.eq_ignore_ascii_case("[core]");
            if !in_core {
                return refuse("section");
            }
            continue;
        }
        if !in_core {
            return refuse("key outside [core]");
        }
        let Some((key, value)) = line.split_once('=') else {
            return refuse("valueless key");
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().to_ascii_lowercase();
        let allowed = SAFE_CORE_KEYS
            .iter()
            .find(|(name, _)| *name == key)
            .is_some_and(|(_, values)| values.contains(&value.as_str()));
        if !allowed {
            return refuse("key");
        }
    }
    Ok(())
}

/// Commit identity exactly as stored (never rewritten).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitInfo {
    pub sha: Sha,
    pub tree: Sha,
    pub parents: Vec<Sha>,
    /// Raw `author` header value: `Name <email> <epoch> <tz>`.
    pub author: String,
    pub committer: String,
    pub message: String,
}

impl GitRepo {
    /// OS utility runner before a KB repository exists. Reuses the managed
    /// spawn/watchdog/drain boundary; never constructs a Git command.
    pub(crate) fn run_store_command(
        paths: &StorePaths,
        command: Command,
        max_stdout: usize,
    ) -> Result<(bool, Vec<u8>), GitError> {
        let runner = GitRepo {
            git_dir: paths.root().to_path_buf(),
            timeout: GIT_TIMEOUT,
            store: Some(paths.clone()),
            overlays: Vec::new(),
        };
        runner.run_command(command, max_stdout)
    }

    /// Open an existing bare repository directory (never a symlink).
    pub fn open(git_dir: &Path) -> Result<GitRepo, GitError> {
        let meta = std::fs::symlink_metadata(git_dir).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                GitError::NotFound
            } else {
                GitError::Io(error)
            }
        })?;
        if !meta.is_dir() || crate::paths::is_link(&meta) {
            return Err(GitError::NotFound);
        }
        let git_dir = git_dir.canonicalize()?;
        // Independently opened managed repos use their own store lock,
        // including before any guard is registered and through case aliases.
        let store = match git_dir.parent().and_then(Path::parent) {
            Some(root) if git_dir.parent() == root.join("repos").canonicalize().ok().as_deref() => {
                let mut managed = false;
                for marker in ["state.sqlite", "locks/store.lock"] {
                    match std::fs::symlink_metadata(root.join(marker)) {
                        Ok(_) => managed = true,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e.into()),
                    }
                }
                if managed {
                    Some(StorePaths::new(root.to_path_buf()).map_err(std::io::Error::other)?)
                } else {
                    None
                }
            }
            _ => None,
        };
        Ok(GitRepo {
            git_dir,
            timeout: GIT_TIMEOUT,
            store,
            overlays: Vec::new(),
        })
    }

    /// Replace the per-child deadline (tests inject a short one).
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> GitRepo {
        self.timeout = timeout;
        self
    }

    /// This repository with a disposable object store `objects` layered on
    /// top: every object Git writes through the result lands there, and
    /// reads see it, earlier layers and the canonical store.
    ///
    /// The layering is Git's own: `GIT_OBJECT_DIRECTORY` names the new store
    /// and its `info/alternates` file lists the stores below it, one
    /// absolute path per line (no path-list encoding, so any delimiter in a
    /// store path is fine). A path with a line break cannot be written there
    /// and is refused.
    pub(crate) fn staged(&self, objects: &Path) -> Result<GitRepo, StoreError> {
        let mut below: Vec<PathBuf> = self.overlays.clone();
        below.push(self.git_dir.join("objects"));
        let mut text = String::new();
        for path in &below {
            let spelled = git_spelling(path);
            let line = spelled
                .to_str()
                .ok_or_else(|| StoreError::UnsafePath("store path is not valid UTF-8".into()))?;
            if line.contains(['\n', '\r']) {
                return Err(StoreError::UnsafePath(
                    "store path contains a line break".into(),
                ));
            }
            text.push_str(line);
            text.push('\n');
        }
        let info = objects.join("info");
        std::fs::create_dir_all(&info).map_err(StoreError::Io)?;
        std::fs::write(info.join("alternates"), text).map_err(StoreError::Io)?;
        let mut staged = self.clone();
        staged.overlays.insert(0, objects.to_path_buf());
        Ok(staged)
    }

    /// The canonical repository underneath any overlays.
    pub(crate) fn canonical(&self) -> GitRepo {
        let mut canonical = self.clone();
        canonical.overlays.clear();
        canonical
    }

    /// The object store Git writes into (the newest overlay, else canonical).
    pub(crate) fn write_objects_dir(&self) -> PathBuf {
        self.overlays
            .first()
            .cloned()
            .unwrap_or_else(|| self.git_dir.join("objects"))
    }

    /// Refuse a repository whose own files could redirect or reconfigure
    /// Git (see module docs). Runs before every spawn.
    pub fn check_integrity(&self) -> Result<(), GitError> {
        let config_path = self.git_dir.join("config");
        let meta = std::fs::symlink_metadata(&config_path)
            .map_err(|_| GitError::Structure("repository config is missing".into()))?;
        if !meta.is_file() || crate::paths::is_link(&meta) {
            return Err(GitError::Structure(
                "repository config is not a file".into(),
            ));
        }
        let mut config = String::new();
        crate::paths::open_regular_read(&config_path)
            .map_err(|_| GitError::Structure("repository config is unreadable".into()))?
            .take(64 * 1024 + 1)
            .read_to_string(&mut config)
            .map_err(|_| GitError::Structure("repository config is unreadable".into()))?;
        if config.len() > 64 * 1024 {
            return Err(GitError::Structure(
                "repository config exceeds size limit".into(),
            ));
        }
        check_config(&config)?;
        for rel in REFUSED_REPO_FILES {
            match std::fs::symlink_metadata(self.git_dir.join(rel)) {
                Ok(_) => return Err(GitError::Structure(format!("repository has `{rel}`"))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// The bare repository of `kb` inside a managed store (no-follow checked).
    pub fn for_kb(paths: &StorePaths, kb: &KbId) -> Result<GitRepo, StoreError> {
        let dir = paths.repo_dir(kb);
        paths.check_no_follow(&dir)?;
        let mut repo = GitRepo::open(&dir)?;
        repo.store = Some(paths.clone());
        Ok(repo)
    }

    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    pub(crate) fn check_managed_path(&self, path: &Path) -> Result<(), StoreError> {
        let paths = self.store.as_ref().ok_or(StoreError::LockNotHeld)?;
        paths.check_no_follow(path)
    }

    /// The hardened base command (see module docs), after the integrity
    /// check. The only way kb-local builds a Git command for a repository.
    pub(crate) fn command<I, S>(&self, args: I) -> Result<Command, GitError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.check_integrity()?;
        Ok(self.command_unchecked(args))
    }

    /// [`GitRepo::command`] without the integrity check.
    pub(crate) fn command_unchecked<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.base_command(true, args)
    }

    /// `git init` of a reserved, still-empty directory. Init would persist
    /// `core.sharedRepository` (and a `[receive]` section) into the repository
    /// config, which [`check_config`] refuses, so the caller tightens the new
    /// repository with [`crate::paths::make_tree_owner_only`] instead.
    pub(crate) fn init_command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.base_command(false, args)
    }

    fn base_command<I, S>(&self, owner_only: bool, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        // Keep canonical filesystem paths for integrity checks, but pass Git
        // ordinary drive/UNC spelling (see [`git_spelling`]).
        let git_dir = git_spelling(&self.git_dir);
        let mut command = Command::new("git");
        command.env_clear();
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        #[cfg(windows)]
        for key in ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_SYSTEM", NULL_DEVICE)
            .env("GIT_CONFIG_GLOBAL", NULL_DEVICE)
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_GRAFT_FILE", NULL_DEVICE)
            .env("GIT_SHALLOW_FILE", NULL_DEVICE)
            .env("LC_ALL", "C")
            .arg("--no-replace-objects")
            .args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "credential.helper=",
                "-c",
                "protocol.allow=never",
                "-c",
                "gc.auto=0",
                "-c",
                "maintenance.auto=false",
                "-c",
                "core.alternateRefsCommand=",
                "-c",
                "core.commitGraph=false",
                "-c",
                "core.multiPackIndex=false",
                "-c",
                "pack.useBitmaps=false",
                "-c",
                "core.logAllRefUpdates=false",
                // Canonical writes are durable immediately. Disposable
                // overlays are verified and fsynced by promotion before any
                // ref can name them; per-object scratch fsyncs add thousands
                // of redundant journal barriers to an unpublished plan.
                "-c",
                if self.overlays.is_empty() {
                    "core.fsync=loose-object,reference"
                } else {
                    "core.fsync=reference"
                },
                "-c",
                "core.fsyncMethod=fsync",
            ]);
        // Owner-only Git internals on Unix: every directory and file Git
        // creates loses its group/other bits whatever the caller's umask
        // (directories 0700, files 0600, read-only objects 0400).
        #[cfg(unix)]
        if owner_only {
            command.args(["-c", "core.sharedRepository=0600"]);
        }
        #[cfg(not(unix))]
        let _ = owner_only;
        // A staged repository writes into its newest store, whose
        // `info/alternates` file reaches the ones below (see `staged`).
        if let Some(first) = self.overlays.first() {
            command.env("GIT_OBJECT_DIRECTORY", git_spelling(first));
        }
        command
            .arg("--git-dir")
            .arg(git_dir)
            .args(args)
            .current_dir(&self.git_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }

    /// The sole Git spawn boundary. A managed handle takes or reuses its
    /// identity-matched store lease, including guards on another thread and
    /// repos opened before acquisition. No call site may spawn Git directly.
    fn spawn(&self, command: Command, input: Input) -> Result<ProcessChild, GitError> {
        OperationDeadline::check().map_err(|error| match error {
            StoreError::OperationAborted(ErrorCode::Cancelled) => GitError::Cancelled,
            _ => GitError::Timeout,
        })?;
        if let Some(paths) = &self.store {
            paths
                .check_no_follow(&self.git_dir)
                .map_err(std::io::Error::other)?;
        }
        #[cfg(unix)]
        {
            let mut command = command;
            command.stdin(match input {
                Input::Null => Stdio::null(),
                Input::Pipe => Stdio::piped(),
                Input::From(pipe) => Stdio::from(pipe),
            });
            crate::locks::spawn_git(command, self.store.as_ref()).map_err(admission_error)
        }
        #[cfg(windows)]
        {
            let input = match input {
                Input::Null => crate::win::Input::Null,
                Input::Pipe => crate::win::Input::Pipe,
                Input::From(pipe) => crate::win::Input::From(pipe),
            };
            crate::locks::spawn_git(command, self.store.as_ref(), input).map_err(admission_error)
        }
    }

    /// Run one command, returning stdout (at most `max_stdout` bytes) and
    /// whether it exited successfully. Over the cap: killed, `Budget`.
    fn run(&self, args: &[&str], max_stdout: usize) -> Result<(bool, Vec<u8>), GitError> {
        let command = self.command(args)?;
        self.run_command(command, max_stdout)
    }

    /// Spawn a prepared command under the watchdog and collect capped stdout.
    pub(crate) fn run_command(
        &self,
        command: Command,
        max_stdout: usize,
    ) -> Result<(bool, Vec<u8>), GitError> {
        let mut child = self.spawn(command, Input::Null)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::Failed("missing stdout".into()))?;
        let supervised = supervise(child, self.timeout);
        let mut out = Vec::new();
        let read = stdout.take(max_stdout as u64 + 1).read_to_end(&mut out);
        if read.is_err() {
            supervised.kill();
        }
        if out.len() > max_stdout {
            drop(supervised); // kills and reaps
            return Err(GitError::Budget("git output exceeds read budget".into()));
        }
        let ok = supervised.finish()?;
        read?;
        Ok((ok, out))
    }

    /// [`GitRepo::run_command`] with the exit code (`None` when killed by a
    /// signal), for commands whose nonzero exits carry meaning
    /// (`merge-tree`'s 1 = conflicts) next to real failures.
    pub(crate) fn run_command_code(
        &self,
        command: Command,
        max_stdout: usize,
    ) -> Result<(Option<i32>, Vec<u8>), GitError> {
        let mut child = self.spawn(command, Input::Null)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::Failed("missing stdout".into()))?;
        let supervised = supervise(child, self.timeout);
        let mut out = Vec::new();
        let read = stdout.take(max_stdout as u64 + 1).read_to_end(&mut out);
        if read.is_err() {
            supervised.kill();
        }
        if out.len() > max_stdout {
            drop(supervised); // kills and reaps
            return Err(GitError::Budget("git output exceeds read budget".into()));
        }
        let status = supervised.finish_status()?;
        read?;
        Ok((status.code(), out))
    }

    /// Build and validate a complete pack in managed publication scratch. Only
    /// its completed pack and index are installed: the index is the visibility
    /// boundary, so even a stream interrupted after a commit exposes no objects.
    pub(crate) fn install_objects(
        &self,
        canonical: &GitRepo,
        objects: &[String],
    ) -> Result<(), StoreError> {
        let list: String = objects.iter().map(|sha| format!("{sha}\n")).collect();
        self.install_pack(
            canonical,
            self.command(["pack-objects", "--stdout", "-q"])?,
            list,
            |_| Ok(()),
        )
        .map(|_| ())
    }

    /// One pack of exactly `objects` (all present in `canonical`; `self` is
    /// a staging layer over it), installed exactly like
    /// [`GitRepo::install_objects`]; returns the pack's name. Packed objects
    /// keep their stored deltas.
    pub(crate) fn install_rollup(
        &self,
        canonical: &GitRepo,
        objects: &[String],
        before_install: impl FnOnce(&str) -> Result<(), StoreError>,
    ) -> Result<String, StoreError> {
        let list: String = objects.iter().map(|sha| format!("{sha}\n")).collect();
        self.install_pack(
            canonical,
            canonical.command(["pack-objects", "--stdout", "-q"])?,
            list,
            before_install,
        )
    }

    /// Stream `producer`'s pack (fed `input` on stdin) through a supervised
    /// `index-pack` into this repository's write layer, then publish the
    /// completed pack and, last, its index into `canonical`.
    fn install_pack(
        &self,
        canonical: &GitRepo,
        producer: Command,
        list: String,
        before_install: impl FnOnce(&str) -> Result<(), StoreError>,
    ) -> Result<String, StoreError> {
        let mut producer = self.spawn(producer, Input::Pipe)?;
        #[cfg(test)]
        let (release, parked) = if PACK_INSTALL_PROBE.with(|p| p.borrow().is_some()) {
            let (tx, rx) = mpsc::channel::<()>();
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let mut stdin = producer
            .stdin
            .take()
            .ok_or_else(|| GitError::Failed("missing stdin".into()))?;
        let piped = producer
            .stdout
            .take()
            .ok_or_else(|| GitError::Failed("missing stdout".into()))?;
        let producer = supervise(producer, self.timeout);
        let feeder = std::thread::spawn(move || {
            #[cfg(test)]
            if let Some(parked) = parked {
                let _ = parked.recv();
            }
            let written = stdin.write_all(list.as_bytes());
            drop(stdin);
            written
        });
        let indexed = self.index_pack(Input::From(piped));
        if indexed.is_err() {
            // The consumer can no longer drain the producer's pipe. Stop its
            // sibling before joining the feeder, including on a budget kill.
            producer.kill();
        }
        #[cfg(test)]
        drop(release);
        let fed = feeder
            .join()
            .map_err(|_| GitError::Failed("pack feeder panicked".into()))?;
        let producer_ok = producer.finish()?;
        let hash = indexed?;
        fed.map_err(StoreError::Io)?;
        if !producer_ok {
            return Err(GitError::Failed("object install failed".into()).into());
        }
        // Rollup cleanup authority must be durable before canonical installation.
        before_install(&hash)?;
        let source = self.write_objects_dir().join("pack");
        let destination = canonical.git_dir.join("objects").join("pack");
        canonical.check_managed_path(&destination)?;
        match crate::paths::create_private_dir(&destination) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(StoreError::Io(e)),
        }
        // A completed pack's index is published last. Scratch owns all temporary
        // files; recovery removes abandoned scratch and any unindexed pack.
        for suffix in ["pack", "idx"] {
            let name = format!("pack-{hash}.{suffix}");
            let from = source.join(&name);
            let to = destination.join(&name);
            canonical.check_managed_path(&to)?;
            std::fs::File::open(&from)
                .and_then(|file| file.sync_all())
                .map_err(StoreError::Io)?;
            match std::fs::hard_link(&from, &to) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
            crate::paths::sync_dir(&destination)?;
        }
        crate::paths::sync_dir(&canonical.git_dir.join("objects"))?;
        Ok(hash)
    }

    /// The actual supervised installer, also exercised with a truncated pack.
    fn index_pack(&self, input: Input) -> Result<String, GitError> {
        #[cfg(test)]
        let probe = PACK_INSTALL_PROBE.take();
        #[cfg(test)]
        let input = if probe.is_some() { Input::Pipe } else { input };
        let mut consumer = self.spawn(self.command(["index-pack", "--stdin"])?, input)?;
        let stdout = consumer
            .stdout
            .take()
            .ok_or_else(|| GitError::Failed("missing stdout".into()))?;
        #[cfg(test)]
        let mut slow_input = consumer.stdin.take();
        let consumer = supervise(consumer, self.timeout);
        #[cfg(test)]
        let test_budget = if let Some(probe) = probe {
            // A valid pack header with one unfinished object: real index-pack
            // creates its temporary pack, then blocks awaiting the rest.
            slow_input
                .as_mut()
                .expect("probe stdin")
                .write_all(b"PACK\0\0\0\x02\0\0\0\x01")?;
            (probe.indexed)(
                consumer.child.clone(),
                self.write_objects_dir().join("pack"),
            );
            probe.budget
        } else {
            None
        };
        #[cfg(test)]
        let _test_scope = test_budget.map(OperationDeadline::budget);
        #[cfg(test)]
        let consumer = if test_budget.is_some() {
            // Readiness precedes the injected deadline. Scheduling or slow
            // fixture I/O cannot move this kill ahead of scratch creation.
            let mut consumer = consumer;
            consumer.stop_watchdog();
            supervise_shared(consumer.child.clone(), self.timeout)
        } else {
            consumer
        };
        let mut output = Vec::new();
        stdout.take(256).read_to_end(&mut output)?;
        if !consumer.finish()? {
            return Err(GitError::Failed("index-pack failed".into()));
        }
        let text = std::str::from_utf8(&output)
            .map_err(|_| GitError::Failed("invalid pack name".into()))?;
        let hash = text.split_whitespace().last().unwrap_or_default();
        Sha::parse(hash).map_err(|_| GitError::Failed("invalid pack name".into()))?;
        Ok(hash.to_owned())
    }

    /// Tips of every retained branch (`refs/heads/*`).
    pub fn branch_tips(&self) -> Result<Vec<Sha>, GitError> {
        let (ok, out) = self.run(
            &["for-each-ref", "--format=%(objectname)", "refs/heads"],
            64 * 1024,
        )?;
        if !ok {
            return Err(GitError::Failed("for-each-ref".into()));
        }
        out.split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(parse_sha)
            .collect()
    }

    fn object_type(&self, sha: &Sha) -> Result<Option<ObjectKind>, GitError> {
        // The batch protocol supplies structured missing evidence. A corrupt
        // object or failed command must also pass the process exit check.
        let mut reader = self.batch_reader("--batch-check")?;
        let header = reader.read_header(sha.as_str());
        drop(reader.stdin.take());
        let ok = reader
            .process
            .take()
            .expect("live batch process")
            .finish()?;
        if !ok {
            return Err(GitError::Failed("object type lookup failed".into()));
        }
        match header {
            Ok((kind, _)) => Ok(Some(kind)),
            Err(GitError::NotFound) => {
                // Git also emits `missing` for corrupt object headers. First
                // check the loose-object path; then enumerate native object
                // names without decoding payloads (including packed objects).
                let name = sha.as_str();
                match std::fs::symlink_metadata(
                    self.git_dir
                        .join("objects")
                        .join(&name[..2])
                        .join(&name[2..]),
                ) {
                    Ok(_) => return Err(GitError::Failed("existing object is unreadable".into())),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                let (ok, objects) = self.run(
                    &[
                        "cat-file",
                        "--batch-all-objects",
                        "--batch-check=%(objectname)",
                    ],
                    METADATA_OBJECT_MAX_BYTES,
                )?;
                if !ok {
                    return Err(GitError::Failed("object existence lookup failed".into()));
                }
                for line in objects
                    .split(|b| *b == b'\n')
                    .filter(|line| !line.is_empty())
                {
                    let object = parse_sha(line)?;
                    if &object == sha {
                        return Err(GitError::Failed("existing object is unreadable".into()));
                    }
                }
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// `sha` when it names a commit reachable from a branch of this
    /// repository; `NotFound` for missing, foreign, dangling or non-commit
    /// objects (the kb/1 read-revision rule).
    pub fn resolve_readable_commit(&self, sha: &Sha) -> Result<Sha, GitError> {
        if self.object_type(sha)? != Some(ObjectKind::Commit) {
            return Err(GitError::NotFound);
        }
        // Lists `sha` unless some branch already reaches it.
        let (ok, out) = self.run(
            &[
                "rev-list",
                "--max-count=1",
                sha.as_str(),
                "--not",
                "--branches",
            ],
            64,
        )?;
        if !ok {
            return Err(GitError::Failed("commit reachability lookup failed".into()));
        }
        if out.iter().all(u8::is_ascii_whitespace) {
            Ok(sha.clone())
        } else {
            Err(GitError::NotFound)
        }
    }

    /// Start a `cat-file --batch` session.
    pub fn object_reader(&self) -> Result<ObjectReader, GitError> {
        self.batch_reader("--batch")
    }

    fn batch_reader(&self, mode: &str) -> Result<ObjectReader, GitError> {
        let command = self.command(["cat-file", mode])?;
        let mut child = self.spawn(command, Input::Pipe)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| GitError::Failed("missing stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::Failed("missing stdout".into()))?;
        Ok(ObjectReader {
            repo: self.clone(),
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            poisoned: false,
            process: Some(supervise(child, self.timeout)),
        })
    }

    /// Commit metadata exactly as stored.
    pub fn read_commit(&self, sha: &Sha) -> Result<CommitInfo, GitError> {
        let mut reader = self.object_reader()?;
        reader.read_commit(sha)
    }

    /// Commits reachable from `new` but not from `old` (all of `new`'s
    /// history when `old` is `None`), oldest first, bounded by `limit`.
    pub fn commits_between(
        &self,
        old: Option<&Sha>,
        new: &Sha,
        limit: usize,
    ) -> Result<Vec<Sha>, GitError> {
        for revision in old.into_iter().chain(std::iter::once(new)) {
            if self.object_type(revision)? != Some(ObjectKind::Commit) {
                return Err(GitError::NotFound);
            }
        }
        let max = format!("--max-count={}", limit + 1);
        let range = old.map(|old| format!("{old}..{new}"));
        let mut args = vec!["rev-list", "--reverse", max.as_str()];
        args.push(range.as_deref().unwrap_or(new.as_str()));
        let (ok, out) = self.run(&args, (limit + 1) * 41 + 1)?;
        if !ok {
            return Err(GitError::Failed("commit enumeration failed".into()));
        }
        let commits = out
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(parse_sha)
            .collect::<Result<Vec<_>, _>>()?;
        if commits.len() > limit {
            return Err(GitError::Budget("commit traversal exceeds budget".into()));
        }
        Ok(commits)
    }

    /// Every object (commit, tree, blob) newly reachable from `new` that is
    /// not reachable from `old`, excluding every historical tree of `old`
    /// explicitly (a plain `old..new` walk would report restored content as
    /// new). Stops and kills both children as soon as `limit` is exceeded.
    pub fn newly_reachable_objects(
        &self,
        old: Option<&Sha>,
        new: &Sha,
        limit: usize,
    ) -> Result<HashSet<String>, GitError> {
        let mut exclusions = None;
        let mut input = Input::Null;
        let incoming = match old {
            Some(old) => {
                let producer = self.command([
                    "rev-list",
                    "--format=^%T",
                    "--no-commit-header",
                    old.as_str(),
                ])?;
                let mut child = self.spawn(producer, Input::Null)?;
                let piped = child
                    .stdout
                    .take()
                    .ok_or_else(|| GitError::Failed("missing stdout".into()))?;
                exclusions = Some(supervise(child, self.timeout));
                let range = format!("{old}..{new}");
                let command = self.command([
                    "rev-list",
                    "--objects",
                    "--no-object-names",
                    range.as_str(),
                    "--stdin",
                ])?;
                input = Input::From(piped);
                command
            }
            None => self.command(["rev-list", "--objects", "--no-object-names", new.as_str()])?,
        };
        let mut child = self.spawn(incoming, input)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitError::Failed("missing stdout".into()))?;
        let consumer = supervise(child, self.timeout);
        let mut reader = BufReader::new(stdout);
        let mut objects = HashSet::new();
        let mut line = Vec::with_capacity(48);
        let over = |consumer: Supervised, exclusions: Option<Supervised>| {
            consumer.kill();
            if let Some(e) = &exclusions {
                e.kill();
            }
            GitError::Budget("object traversal exceeds object budget".into())
        };
        loop {
            line.clear();
            let n = (&mut reader).take(48).read_until(b'\n', &mut line)?;
            if n == 0 {
                break;
            }
            let text = line.strip_suffix(b"\n").unwrap_or(&line);
            if !line.ends_with(b"\n") || !is_sha(std::str::from_utf8(text).unwrap_or("")) {
                consumer.kill();
                return Err(GitError::Failed("invalid incoming object name".into()));
            }
            objects.insert(String::from_utf8_lossy(text).into_owned());
            if objects.len() > limit {
                return Err(over(consumer, exclusions));
            }
        }
        let ok = consumer.finish()?;
        let producer_ok = match exclusions {
            Some(e) => e.finish()?,
            None => true,
        };
        if !ok || !producer_ok {
            return Err(GitError::Failed(
                "incoming object enumeration failed".into(),
            ));
        }
        Ok(objects)
    }
}

/// A lease admission past its deadline is a timeout, not a storage fault.
fn admission_error(error: std::io::Error) -> GitError {
    if error.kind() == std::io::ErrorKind::TimedOut {
        GitError::Timeout
    } else {
        GitError::Io(error)
    }
}

fn supervise(child: ProcessChild, timeout: Duration) -> Supervised {
    supervise_shared(Arc::new(Mutex::new(child)), timeout)
}

fn supervise_shared(child: Arc<Mutex<ProcessChild>>, timeout: Duration) -> Supervised {
    // Keep the real child timeout separate from the enclosing operation clock:
    // an injected operation clock may pause during fixture preflight.
    let operation_deadline = OPERATION_DEADLINE.get();
    let clock = OPERATION_CLOCK.get();
    let (stop, rx) = mpsc::channel::<()>();
    let watched = Arc::clone(&child);
    let cancel = OPERATION_CANCEL.with(|c| c.borrow().clone());
    let watchdog = std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline
                || operation_deadline.is_some_and(|d| clock() >= d)
                || cancel.as_ref().is_some_and(|c| c.load(Ordering::Acquire))
            {
                if let Ok(mut child) = watched.lock() {
                    let _ = child.kill();
                }
                return Some(
                    if cancel.as_ref().is_some_and(|c| c.load(Ordering::Acquire)) {
                        ErrorCode::Cancelled
                    } else {
                        ErrorCode::DeadlineExceeded
                    },
                );
            }
            let mut remaining = deadline.saturating_duration_since(Instant::now());
            if let Some(d) = operation_deadline {
                remaining = remaining.min(d.saturating_duration_since(clock()));
            }
            if cancel.is_some() {
                remaining = remaining.min(Duration::from_millis(10));
            }
            match rx.recv_timeout(remaining) {
                Err(RecvTimeoutError::Timeout) => {}
                _ => return None,
            }
        }
    });
    Supervised {
        child,
        stop: Some(stop),
        watchdog: Some(watchdog),
    }
}

// ── Object reader ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectKind {
    Blob,
    Tree,
    Commit,
    Tag,
}

/// One supervised `git cat-file --batch` session. A budget failure poisons
/// the session (its pending content is never read) and kills the child.
pub struct ObjectReader {
    repo: GitRepo,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    poisoned: bool,
    process: Option<Supervised>,
}

impl Drop for ObjectReader {
    fn drop(&mut self) {
        drop(self.stdin.take());
        drop(self.process.take());
    }
}

impl ObjectReader {
    fn abort(&mut self, error: GitError) -> GitError {
        self.poisoned = true;
        drop(self.stdin.take());
        if let Some(process) = self.process.take() {
            process.kill();
            // Join the watchdog and reap before projecting the read error.
            // The watchdog records expiry even when killing produces EOF/EPIPE.
            if let Err(terminal) = process.finish() {
                return terminal;
            }
        }
        error
    }

    fn read_header(&mut self, sha: &str) -> Result<(ObjectKind, usize), GitError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| GitError::Failed("object reader closed".into()))?;
        let request = format!("{sha}\n");
        if let Err(error) = stdin
            .write_all(request.as_bytes())
            .and_then(|()| stdin.flush())
        {
            return Err(error.into());
        }
        let mut header = Vec::with_capacity(64);
        (&mut self.stdout)
            .take(128)
            .read_until(b'\n', &mut header)?;
        let text = String::from_utf8_lossy(&header).trim_end().to_owned();
        let mut parts = text.split(' ');
        let (name, kind, size) = (parts.next(), parts.next(), parts.next());
        if name == Some(sha) && kind == Some("missing") && size.is_none() {
            return Err(GitError::NotFound);
        }
        let (Some(name), Some(kind), Some(size), None) = (name, kind, size, parts.next()) else {
            return Err(GitError::Failed("unexpected cat-file header".into()));
        };
        if name != sha {
            return Err(GitError::Failed("unexpected cat-file object".into()));
        }
        let kind = match kind {
            "blob" => ObjectKind::Blob,
            "tree" => ObjectKind::Tree,
            "commit" => ObjectKind::Commit,
            "tag" => ObjectKind::Tag,
            _ => {
                return Err(GitError::Failed("unexpected object type".into()));
            }
        };
        let size: usize = match size.parse() {
            Ok(size) => size,
            Err(_) => {
                return Err(GitError::Failed("unexpected object size".into()));
            }
        };
        Ok((kind, size))
    }

    /// Header-first read; every failure drains the child and preserves its
    /// deadline outcome before returning a storage/protocol error.
    pub fn read_checked(
        &mut self,
        sha: &str,
        max_bytes: usize,
        precheck: &mut dyn FnMut(ObjectKind, usize) -> Result<(), GitError>,
    ) -> Result<(ObjectKind, Vec<u8>), GitError> {
        if self.poisoned {
            return Err(GitError::Failed("object reader was aborted".into()));
        }
        if !is_sha(sha) {
            return Err(GitError::Failed("invalid object name".into()));
        }
        let result = (|| {
            let (kind, size) = self.read_header(sha)?;
            precheck(kind, size)?;
            if size > max_bytes {
                return Err(GitError::Budget("object exceeds read budget".into()));
            }
            let mut body = vec![0u8; size + 1];
            self.stdout.read_exact(&mut body)?;
            if body.pop() != Some(b'\n') {
                return Err(GitError::Failed("unterminated cat-file object".into()));
            }
            Ok((kind, body))
        })();
        let result = result.map_err(|error| self.abort(error));
        if matches!(&result, Err(GitError::NotFound)) {
            // Batch `missing` also covers corrupt headers. Drain first, then
            // use the same existence evidence as revision resolution.
            let name = parse_sha(sha.as_bytes())?;
            if self.repo.object_type(&name)?.is_some() {
                return Err(GitError::Failed(
                    "existing object content is unreadable".into(),
                ));
            }
        }
        result
    }

    /// Read `sha`, requiring `expected` kind (mismatch = `NotFound`).
    pub fn read(
        &mut self,
        sha: &str,
        expected: ObjectKind,
        max_bytes: usize,
    ) -> Result<Vec<u8>, GitError> {
        let (kind, body) = self.read_checked(sha, max_bytes, &mut |_, _| Ok(()))?;
        if kind != expected {
            return Err(GitError::NotFound);
        }
        Ok(body)
    }

    /// Commit metadata; `precheck` sees the commit object header.
    pub fn read_commit_checked(
        &mut self,
        sha: &Sha,
        precheck: &mut dyn FnMut(ObjectKind, usize) -> Result<(), GitError>,
    ) -> Result<CommitInfo, GitError> {
        let (kind, body) = self.read_checked(sha.as_str(), METADATA_OBJECT_MAX_BYTES, precheck)?;
        if kind != ObjectKind::Commit {
            return Err(GitError::NotFound);
        }
        parse_commit(sha, &body)
    }

    pub fn read_commit(&mut self, sha: &Sha) -> Result<CommitInfo, GitError> {
        self.read_commit_checked(sha, &mut |_, _| Ok(()))
    }
}

fn parse_commit(sha: &Sha, body: &[u8]) -> Result<CommitInfo, GitError> {
    let (headers, message) = match body.windows(2).position(|w| w == b"\n\n") {
        Some(at) => (&body[..at], &body[at + 2..]),
        None => (body, &[][..]),
    };
    let mut tree = None;
    let mut parents = Vec::new();
    let mut author = String::new();
    let mut committer = String::new();
    for line in headers.split(|b| *b == b'\n') {
        if let Some(rest) = line.strip_prefix(b"tree ") {
            if tree.is_some() {
                return Err(GitError::Structure("commit has two trees".into()));
            }
            tree = Some(parse_sha(rest)?);
        } else if let Some(rest) = line.strip_prefix(b"parent ") {
            parents.push(parse_sha(rest)?);
        } else if let Some(rest) = line.strip_prefix(b"author ") {
            author = String::from_utf8_lossy(rest).into_owned();
        } else if let Some(rest) = line.strip_prefix(b"committer ") {
            committer = String::from_utf8_lossy(rest).into_owned();
        }
    }
    let tree = tree.ok_or_else(|| GitError::Structure("commit missing tree".into()))?;
    Ok(CommitInfo {
        sha: sha.clone(),
        tree,
        parents,
        author,
        committer,
        message: String::from_utf8_lossy(message).into_owned(),
    })
}

// ── Trees ──────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Blob,
    Tree,
    /// Gitlink (submodule) or any mode Git canonicalizes to one.
    Commit,
}

/// One tree entry with its full path (no trailing slash).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    /// Canonical six-digit octal mode as `git ls-tree` prints it.
    pub mode: String,
    pub kind: EntryKind,
    pub sha: String,
    pub path: String,
}

/// Entry budget of one tree walk (the root counts as one entry).
#[derive(Clone, Debug)]
pub struct WalkBudget {
    pub entries: usize,
    pub max_entries: usize,
}

impl WalkBudget {
    pub fn new(max_entries: usize) -> WalkBudget {
        WalkBudget {
            entries: 0,
            max_entries,
        }
    }

    fn charge(&mut self) -> Result<(), GitError> {
        self.entries += 1;
        if self.entries > self.max_entries {
            return Err(GitError::Budget("tree exceeds entry budget".into()));
        }
        Ok(())
    }
}

/// Aggregate budget over distinct incoming objects shared by a traversal
/// range. With an `incoming` set, objects outside it (existing history) are
/// free.
#[derive(Clone, Debug)]
pub struct IncomingBudget {
    seen: HashSet<String>,
    incoming: Option<HashSet<String>>,
    pub objects: usize,
    pub bytes: usize,
    max_objects: usize,
    max_bytes: usize,
}

impl IncomingBudget {
    pub fn new(
        max_objects: usize,
        max_bytes: usize,
        incoming: Option<HashSet<String>>,
    ) -> IncomingBudget {
        IncomingBudget {
            seen: HashSet::new(),
            incoming,
            objects: 0,
            bytes: 0,
            max_objects,
            max_bytes,
        }
    }

    /// Charge one object before its content is read.
    pub fn charge(&mut self, sha: &str, size: usize) -> Result<(), GitError> {
        if let Some(incoming) = &self.incoming
            && !incoming.contains(sha)
        {
            return Ok(());
        }
        if !self.seen.insert(sha.to_owned()) {
            return Ok(());
        }
        self.objects += 1;
        self.bytes = self.bytes.saturating_add(size);
        if self.objects > self.max_objects {
            return Err(GitError::Budget(
                "object traversal exceeds object budget".into(),
            ));
        }
        if self.bytes > self.max_bytes {
            return Err(GitError::Budget(
                "object traversal exceeds uncompressed byte budget".into(),
            ));
        }
        Ok(())
    }
}

/// Git's `canon_mode`: what `ls-tree` reports for a stored mode.
fn canonical_mode(raw: &[u8]) -> Result<(u32, EntryKind), GitError> {
    if raw.is_empty() || raw.len() > 7 || !raw.iter().all(|b| (b'0'..=b'7').contains(b)) {
        return Err(GitError::Structure("malformed mode in tree entry".into()));
    }
    let mode = raw
        .iter()
        .fold(0u32, |acc, b| acc * 8 + u32::from(b - b'0'));
    Ok(match mode & 0o170000 {
        0o100000 => (
            0o100000 | if mode & 0o100 != 0 { 0o755 } else { 0o644 },
            EntryKind::Blob,
        ),
        0o120000 => (0o120000, EntryKind::Blob),
        0o040000 => (0o040000, EntryKind::Tree),
        _ => (0o160000, EntryKind::Commit),
    })
}

struct RawChild {
    mode: String,
    kind: EntryKind,
    sha: String,
    name: Vec<u8>,
}

fn parse_tree(body: &[u8]) -> Result<Vec<RawChild>, GitError> {
    let mut out = Vec::new();
    let mut rest = body;
    while !rest.is_empty() {
        let space = rest
            .iter()
            .position(|b| *b == b' ')
            .ok_or_else(|| GitError::Structure("malformed tree entry".into()))?;
        let (mode, kind) = canonical_mode(&rest[..space])?;
        let after = &rest[space + 1..];
        let nul = after
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(|| GitError::Structure("malformed tree entry".into()))?;
        let name = after[..nul].to_vec();
        let id = after
            .get(nul + 1..nul + 21)
            .ok_or_else(|| GitError::Structure("truncated tree entry".into()))?;
        if name.is_empty() {
            return Err(GitError::Structure(
                "tree entry name must not be empty".into(),
            ));
        }
        out.push(RawChild {
            mode: format!("{mode:06o}"),
            kind,
            sha: id.iter().map(|b| format!("{b:02x}")).collect(),
            name,
        });
        rest = &after[nul + 21..];
    }
    Ok(out)
}

/// Walk every entry of `tree`, depth-first pre-order; directories are
/// emitted before their children (so empty directories are validated).
/// Duplicate names, out-of-Git-order entries, names that are not one path
/// segment and nesting deeper than [`MAX_TREE_DEPTH`] are `Structure`
/// errors; non-UTF-8 names are `Budget` (TS parity). Each visited tree is
/// charged to `incoming` before it is parsed, and the walk stops as soon as
/// the entry budget is exceeded.
pub fn walk_tree(
    reader: &mut ObjectReader,
    tree: &Sha,
    budget: &mut WalkBudget,
    incoming: &mut IncomingBudget,
) -> Result<Vec<TreeEntry>, GitError> {
    let mut entries = Vec::new();
    visit(reader, tree.as_str(), "", 0, budget, incoming, &mut entries)?;
    Ok(entries)
}

fn visit(
    reader: &mut ObjectReader,
    sha: &str,
    prefix: &str,
    depth: usize,
    budget: &mut WalkBudget,
    incoming: &mut IncomingBudget,
    entries: &mut Vec<TreeEntry>,
) -> Result<(), GitError> {
    let (kind, body) = reader.read_checked(sha, METADATA_OBJECT_MAX_BYTES, &mut |_, size| {
        incoming.charge(sha, size)
    })?;
    if kind != ObjectKind::Tree {
        return Err(GitError::Structure(
            "tree entry does not name a tree".into(),
        ));
    }
    budget.charge()?;
    let mut names: HashSet<Vec<u8>> = HashSet::new();
    let mut previous: Option<Vec<u8>> = None;
    for child in parse_tree(&body)? {
        if !names.insert(child.name.clone()) {
            return Err(GitError::Structure("duplicate entry name in tree".into()));
        }
        let name = String::from_utf8(child.name.clone())
            .map_err(|_| GitError::Budget("tree path is not valid UTF-8".into()))?;
        if name.contains('/') {
            return Err(GitError::Structure(
                "tree entry name must not contain a slash".into(),
            ));
        }
        if name == "." || name == ".." {
            return Err(GitError::Structure(
                "tree entry name must not be a dot segment".into(),
            ));
        }
        if depth + 1 > MAX_TREE_DEPTH {
            return Err(GitError::Structure(
                "tree nesting exceeds depth budget".into(),
            ));
        }
        let mut sort_key = child.name.clone();
        if child.kind == EntryKind::Tree {
            sort_key.push(b'/');
        }
        if previous
            .as_ref()
            .is_some_and(|p| p.as_slice() >= sort_key.as_slice())
        {
            return Err(GitError::Structure("tree entry is out of order".into()));
        }
        previous = Some(sort_key);
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        entries.push(TreeEntry {
            mode: child.mode,
            kind: child.kind,
            sha: child.sha.clone(),
            path: path.clone(),
        });
        if child.kind == EntryKind::Tree {
            visit(
                reader,
                &child.sha,
                &path,
                depth + 1,
                budget,
                incoming,
                entries,
            )?;
            continue;
        }
        budget.charge()?;
    }
    Ok(())
}

// ── Document source reads ──────────────────────────────────────────────────

/// Why a source read failed.
#[derive(Debug)]
pub enum SourceError {
    InvalidPath,
    /// Unreadable revision (missing, foreign, unreachable) or no such file.
    NotFound,
    InvalidMarkdown(MarkdownIssue),
    TooLarge,
    Git(GitError),
}

impl SourceError {
    pub fn protocol_code(&self) -> ErrorCode {
        match self {
            SourceError::InvalidPath | SourceError::InvalidMarkdown(_) | SourceError::TooLarge => {
                ErrorCode::InvalidArgument
            }
            SourceError::NotFound => ErrorCode::NotFound,
            SourceError::Git(GitError::NotFound) => ErrorCode::NotFound,
            SourceError::Git(GitError::Budget(_)) => ErrorCode::InvalidArgument,
            SourceError::Git(GitError::Structure(_)) => ErrorCode::RepairRequired,
            SourceError::Git(GitError::Timeout) => ErrorCode::DeadlineExceeded,
            SourceError::Git(GitError::Cancelled) => ErrorCode::Cancelled,
            SourceError::Git(GitError::Io(_) | GitError::Failed(_)) => {
                ErrorCode::StorageUnavailable
            }
        }
    }
}

impl From<GitError> for SourceError {
    fn from(error: GitError) -> Self {
        match error {
            GitError::NotFound => SourceError::NotFound,
            other => SourceError::Git(other),
        }
    }
}

/// The blob named by `path` in `tree`, matched exactly segment by segment
/// through the raw tree objects; `None` when absent or not a plain blob.
pub fn blob_at(
    reader: &mut ObjectReader,
    tree: &Sha,
    path: &KbPath,
) -> Result<Option<String>, GitError> {
    let mut current = tree.as_str().to_owned();
    let segments: Vec<&str> = path.as_str().split('/').collect();
    for (i, segment) in segments.iter().enumerate() {
        let body = reader.read(&current, ObjectKind::Tree, METADATA_OBJECT_MAX_BYTES)?;
        let Some(child) = parse_tree(&body)?
            .into_iter()
            .find(|child| child.name == segment.as_bytes())
        else {
            return Ok(None);
        };
        let last = i + 1 == segments.len();
        match (child.kind, last) {
            (EntryKind::Tree, false) => current = child.sha,
            (EntryKind::Blob, true) => return Ok(Some(child.sha)),
            _ => return Ok(None),
        }
    }
    Ok(None)
}

/// Read one document's immutable source at `commit`, which must be readable
/// (reachable from a branch of this repository). The path is matched
/// exactly, segment by segment, through the raw tree objects of that commit.
pub fn read_document(
    repo: &GitRepo,
    commit: &Sha,
    path: &str,
) -> Result<SourceDocument, SourceError> {
    let parsed_path = KbPath::parse(path).map_err(|_| SourceError::InvalidPath)?;
    repo.resolve_readable_commit(commit)?;
    let mut reader = repo.object_reader()?;
    let info = reader.read_commit(commit).map_err(referenced_object)?;
    read_document_at(&mut reader, commit, &info.tree, parsed_path.as_str())
}

/// Once a revision is proven readable, an unavailable object it references is
/// a storage fault. Only an absent path is document absence.
fn referenced_object(error: GitError) -> SourceError {
    match error {
        GitError::NotFound => {
            SourceError::Git(GitError::Failed("referenced object is unavailable".into()))
        }
        other => SourceError::from(other),
    }
}

/// [`read_document`] through an open reader, for a `commit` the caller
/// already proved readable and whose root `tree` it read (R3-L6: an index
/// build reads every document of one revision through one reader).
pub fn read_document_at(
    reader: &mut ObjectReader,
    commit: &Sha,
    tree: &Sha,
    path: &str,
) -> Result<SourceDocument, SourceError> {
    let path = KbPath::parse(path).map_err(|_| SourceError::InvalidPath)?;
    let referenced = referenced_object;
    let blob = blob_at(reader, tree, &path)
        .map_err(referenced)?
        .ok_or(SourceError::NotFound)?;
    let (kind, bytes) = match reader.read_checked(&blob, DOCUMENT_MAX_BYTES, &mut |_, _| Ok(())) {
        Err(GitError::Budget(_)) => return Err(SourceError::TooLarge),
        other => other.map_err(referenced)?,
    };
    if kind != ObjectKind::Blob {
        return Err(SourceError::Git(GitError::Failed(
            "document entry does not name a blob".into(),
        )));
    }
    let parsed = parse_markdown(&bytes).map_err(SourceError::InvalidMarkdown)?;
    let markdown = String::from_utf8(bytes).map_err(|_| {
        SourceError::Git(GitError::Failed("validated markdown is not UTF-8".into()))
    })?;
    Ok(SourceDocument {
        content_hash: content_hash(markdown.as_bytes()),
        blob_sha: Sha::parse(&blob).map_err(|_| GitError::Failed("invalid blob name".into()))?,
        path,
        commit_sha: commit.clone(),
        markdown,
        front_matter: parsed.front_matter,
        body_start: parsed.body_start,
        document_id: parsed.document_id,
        citations: parsed.citations,
    })
}

#[cfg(all(test, windows))]
mod windows_command_tests {
    use super::*;

    #[test]
    fn git_directory_argument_uses_drive_or_unc_spelling_without_changing_store_path() {
        for (canonical, argument) in [
            (r"\\?\C:\store Ω\repos\kb.git", r"C:\store Ω\repos\kb.git"),
            (
                r"\\?\UNC\server\share\store Ω\kb.git",
                r"\\server\share\store Ω\kb.git",
            ),
            (r"C:\store Ω\repos\kb.git", r"C:\store Ω\repos\kb.git"),
        ] {
            let repo = GitRepo {
                git_dir: PathBuf::from(canonical),
                timeout: GIT_TIMEOUT,
                store: None,
                overlays: Vec::new(),
            };
            let command = repo.command_unchecked(["hash-object", "-w", "f1"]);
            let mut args = command.get_args();
            assert!(args.any(|arg| arg == "--git-dir"));
            assert_eq!(args.next(), Some(OsStr::new(argument)));
            assert_eq!(repo.git_dir(), Path::new(canonical));
            assert_eq!(command.get_current_dir(), Some(Path::new(canonical)));
        }
    }
}

#[cfg(test)]
#[path = "../tests/support/fixture.rs"]
pub(crate) mod read_fixture;

#[cfg(test)]
mod operation_clock_tests {
    use super::*;

    fn paused_clock() -> Instant {
        static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        *EPOCH.get_or_init(|| Instant::now() + Duration::from_secs(3600))
    }

    #[test]
    fn nested_budgets_and_remaining_use_the_enclosing_operation_clock() {
        let cancel = Arc::new(AtomicBool::new(false));
        let outer = OperationDeadline::bounded_with_clock(
            paused_clock() + Duration::from_secs(30),
            cancel.clone(),
            paused_clock,
        );
        assert_eq!(
            OperationDeadline::remaining(),
            Some(Duration::from_secs(30))
        );
        {
            let _budget = OperationDeadline::budget(Duration::from_secs(2));
            assert_eq!(OperationDeadline::remaining(), Some(Duration::from_secs(2)));
            assert!(OperationDeadline::check().is_ok());
            let _longer = OperationDeadline::budget(Duration::from_secs(60));
            assert_eq!(OperationDeadline::remaining(), Some(Duration::from_secs(2)));
        }
        assert_eq!(
            OperationDeadline::remaining(),
            Some(Duration::from_secs(30))
        );
        cancel.store(true, Ordering::Release);
        assert_eq!(OperationDeadline::remaining(), Some(Duration::ZERO));
        drop(outer);
        assert_eq!(OperationDeadline::remaining(), None);
    }
}

#[cfg(test)]
mod object_durability_tests {
    use super::*;

    #[test]
    fn disposable_planning_defers_object_barriers_until_canonical_promotion() {
        let fixture = read_fixture::Fixture::new("scratch-durability");
        let repo = GitRepo::open(&fixture.repo).expect("repo");
        let staged = repo.staged(&fixture.root.join("staged")).expect("staged");
        let effective = |repo: &GitRepo| {
            let (ok, output) = repo
                .run(&["config", "--get", "core.fsync"], 4096)
                .expect("Git config");
            assert!(ok);
            String::from_utf8(output)
                .expect("config text")
                .trim()
                .to_owned()
        };
        assert_eq!(effective(&repo), "loose-object,reference");
        assert_eq!(effective(&staged), "reference");
        assert_eq!(effective(&staged.canonical()), "loose-object,reference");
    }
}

#[cfg(all(test, unix))]
mod batch_cancel_tests {
    use super::*;
    #[test]
    fn sealed_control_cancels_a_real_git_batch_and_allows_reentry() {
        let fx = read_fixture::Fixture::new("sealed-control");
        let repo = GitRepo::open(&fx.repo).unwrap();
        let ctl = crate::embedder::ProviderControl::default();
        let scope = ctl.git_scope();
        let mut reader = repo.object_reader().unwrap();
        ctl.cancel();
        let deadline = Instant::now() + Duration::from_secs(5);
        while reader
            .process
            .as_ref()
            .unwrap()
            .child
            .lock()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none()
        {
            assert!(
                Instant::now() < deadline,
                "sealed cancellation must reach the Git watchdog"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = reader.read_checked(
            "0000000000000000000000000000000000000000",
            10,
            &mut |_, _| Ok(()),
        );
        assert!(matches!(result, Err(GitError::Cancelled)));
        assert!(reader.process.is_none(), "Git child must be joined/reaped");
        drop(scope);
        assert!(repo.branch_tips().is_ok());
    }
    #[test]
    fn cancelled_batch_preserves_terminal_kind_and_reaps_before_reentry() {
        let fx = read_fixture::Fixture::new("cancel-batch");
        let repo = GitRepo::open(&fx.repo).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let scope =
            OperationDeadline::bounded(Instant::now() + Duration::from_secs(5), cancel.clone());
        let mut reader = repo.object_reader().unwrap();
        cancel.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stopped = reader
                .process
                .as_ref()
                .unwrap()
                .child
                .lock()
                .unwrap()
                .try_wait()
                .unwrap()
                .is_some();
            if stopped {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "watchdog failed to cancel native Git"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let error = reader
            .read_checked(
                "0000000000000000000000000000000000000000",
                10,
                &mut |_, _| Ok(()),
            )
            .unwrap_err();
        assert!(matches!(error, GitError::Cancelled));
        assert_eq!(
            SourceError::from(error).protocol_code(),
            ErrorCode::Cancelled
        );
        assert!(
            reader.process.is_none(),
            "terminal process must already be joined/reaped"
        );
        drop(scope);
        assert!(repo.branch_tips().is_ok());
    }
}

#[cfg(test)]
mod stdio_publication_tests {
    use super::OperationDeadline;
    use crate::{
        Store,
        journal::{CreateKbRequest, Stage},
    };
    use kb_client::{
        decode_input,
        stdio::{CallControl, serve},
        types::{BasesCreate, ChangesApply, DocumentsGet},
    };
    use serde_json::json;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    // Both sides of the actual durable reservation; peer loss owns cancellation
    // and worker drain. Store reopening proves once-only durable effects.
    struct OwnedRoot(std::path::PathBuf);
    impl Drop for OwnedRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[tokio::test]
    async fn stdout_loss_before_and_after_reservation_has_exact_effects() {
        for (stage, create) in [Stage::SyncObjects, Stage::Committing]
            .into_iter()
            .flat_map(|stage| [false, true].map(|create| (stage, create)))
        {
            let root = std::env::temp_dir().join(format!(
                "kb-stdio-boundary-{}-{}-{}",
                std::process::id(),
                create,
                if stage == Stage::Committing {
                    "after"
                } else {
                    "before"
                }
            ));
            std::fs::create_dir(&root).expect("fixture");
            let _owned = OwnedRoot(root.clone());
            let root = root.join("store");
            let s = Store::open(&root).expect("fixture");
            let made=s.bases_create(&s.owner(),decode_input::<BasesCreate>(json!({"name":"Boundary","slug":"boundary","description":"Boundary fixture","idempotencyKey":"boundary-create-001"})).expect("fixture")).expect("fixture");
            let create_request = || CreateKbRequest {
                name: "Extra".into(),
                slug: "extra".into(),
                description: "Created after reservation".into(),
                idempotency_key: "boundary-extra-001".into(),
            };
            let input = if create {
                json!({"name":"Extra","slug":"extra","description":"Created after reservation","idempotencyKey":"boundary-extra-001"})
            } else {
                json!({"kbId":made.kb.id,"baseRevision":made.kb.head_sha,"idempotencyKey":"boundary-edit-001","mode":"edit","title":"Boundary","changes":[{"op":"create","path":"once.md","content":{"markdown":"# once\n"}}],"sourceSessionIds":[]})
            };
            let reached = Arc::new(AtomicUsize::new(0));
            let seen = reached.clone();
            let workroot = root.clone();
            let request = input.clone();
            drop(s);
            let (client, server) = tokio::io::duplex(4096);
            let (sr, sw) = tokio::io::split(server);
            let work = tokio::spawn(serve(sr, sw, move |_, _, c: CallControl| {
                let s = Store::open(&workroot).expect("fixture");
                let _scope = OperationDeadline::transport(c.clone());
                let mut observer = |at| {
                    if at == stage {
                        seen.store(1, Ordering::Release);
                        let until = std::time::Instant::now() + Duration::from_secs(5);
                        while !c.is_cancelled() && std::time::Instant::now() < until {
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        assert!(c.is_cancelled(), "peer loss must cancel active work");
                    }
                    Ok(())
                };
                let result = if create {
                    s.create_kb_observed(&s.owner(), create_request(), &mut observer)
                        .map(|_| ())
                } else {
                    s.changes_apply_observed(
                        &s.owner(),
                        decode_input::<ChangesApply>(request.clone()).expect("fixture"),
                        &mut observer,
                    )
                    .map(|_| ())
                };
                assert_eq!(result.is_ok(), stage == Stage::Committing, "{result:?}");
                json!({})
            }));
            let (cr, mut cw) = tokio::io::split(client);
            let mut cr = BufReader::new(cr);
            cw.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\"}\n")
                .await
                .expect("fixture");
            let mut line = String::new();
            cr.read_line(&mut line).await.expect("fixture");
            cw.write_all(format!("{}\n",json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":if create {"knowledge_bases_create"}else{"knowledge_changes_apply"},"arguments":input.clone()}})).as_bytes()).await.expect("fixture");
            // Setup includes real Store recovery, Git and fsync. Bound it by
            // the production call deadline; the five-second peer-loss barrier
            // above starts only after the publication stage is actually reached.
            tokio::time::timeout(Duration::from_secs(120), async {
                while reached.load(Ordering::Acquire) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("fixture");
            drop(cr);
            cw.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n")
                .await
                .expect("fixture");
            // Tokio split retains the duplex read half until both halves drop;
            // shutdown sends EOF, while the full peer drop makes writes fail.
            drop(cw);
            assert!(
                tokio::time::timeout(Duration::from_secs(8), work)
                    .await
                    .expect("fixture")
                    .expect("fixture")
                    .is_err()
            );
            let s = Store::open(&root).expect("fixture");
            let replay = if create {
                s.create_kb(&s.owner(), create_request()).map(|r| r.kb_id)
            } else {
                s.changes_apply(
                    &s.owner(),
                    decode_input::<ChangesApply>(input).expect("fixture"),
                )
                .map(|_| made.kb.id.clone())
            };
            assert_eq!(replay.is_ok(), stage == Stage::Committing);
            let document = s.documents_get(
                &s.owner(),
                decode_input::<DocumentsGet>(json!({"kbId":replay.unwrap_or(made.kb.id),"path":if create && stage==Stage::Committing {"index.md"}else{"once.md"}}))
                    .expect("input"),
            );
            assert_eq!(document.is_ok(), stage == Stage::Committing);
            if let Ok(document) = document {
                assert_eq!(
                    document.markdown,
                    if create {
                        "# Knowledge base\n\nCreated after reservation\n"
                    } else {
                        "# once\n"
                    }
                );
            }
            let db = rusqlite::Connection::open(s.paths().state_db()).expect("fixture");
            let effects:i64=db.query_row("SELECT count(*) FROM operation_intents WHERE phase='FINALIZED' AND idempotency_key=?1",[if create {"boundary-extra-001"} else {"boundary-edit-001"}],|r|r.get(0)).expect("fixture");
            assert_eq!(effects, if stage == Stage::Committing { 1 } else { 0 });
            drop(db);
            drop(s);
            std::fs::remove_dir_all(root.parent().expect("fixture")).expect("fixture");
        }
    }
}
