//! Cross-process write serialization with OS file locks.
//!
//! Lock files live under `locks/` and are never deleted or truncated, so the
//! inode every process locks is persistent (no unlink/recreate race). Order is
//! fixed: the store (authority) lock first, then KB locks in sorted ID order.
//! A [`WriteGuard`] is the only way to hold KB locks, so the reverse order is
//! unrepresentable.
//!
//! Every Git spawn looks up the exact store owning `<root>/repos/<repo>`.
//! Unix hands it off on a child-only fd >=3; the parent's copies stay CLOEXEC.
//! Windows uses an explicit handle list and an owner-held kill-on-close job;
//! a successor holds the byte-range lock while waiting for the old job to drain.
//! Stdin remains available for normal Git protocol input.
//!
//! Locks never handed to a child explicitly unlock on drop (53b fork-race
//! fix). Handed locks use close-only release so descendants retain ownership;
//! a concurrent unrelated fork can delay release only until its CLOEXEC exec.
//! Provider native calls retain the parent's CLOEXEC fence until reap, and
//! independently lock their native-operation file before receiving input.

use std::fs::{File, OpenOptions, TryLockError};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use crate::StoreError;
use crate::paths::{StorePaths, open_no_follow};
use kb_client::types::KbId;

// A registry of held store locks. Git spawns reuse current identity-matched
// ownership or acquire their own lease; ordinary WriteGuards never reuse it.
// Weak entries cannot keep ownership alive. Nonblocking acquisition/register
// and native spawn share this mutex; OS/child waits happen outside it.
static OWNERS: Mutex<Vec<Weak<LockOwner>>> = Mutex::new(Vec::new());

/// Bound on every blocking store/KB lock admission, including the lease a
/// managed Git spawn takes when no current owner exists.
const ADMISSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub(crate) struct LockOwner {
    pub(crate) file: File,
    inherited: AtomicBool,
    paths: Option<StorePaths>,
    #[cfg(windows)]
    pub(crate) job: crate::win::DrainJob,
}

impl Drop for LockOwner {
    fn drop(&mut self) {
        if !self.inherited.load(Ordering::Relaxed) {
            let _ = self.file.unlock();
        }
    }
}

#[derive(Debug)]
pub(crate) struct HeldLock {
    owner: Arc<LockOwner>,
}

impl HeldLock {
    fn new(file: File, paths: Option<&StorePaths>) -> Result<Option<Self>, StoreError> {
        #[cfg(windows)]
        let job = if paths.is_some() {
            let Some(job) = crate::win::DrainJob::acquire(&file).map_err(StoreError::Io)? else {
                return Ok(None);
            };
            job
        } else {
            crate::win::DrainJob::unused()
        };
        Ok(Some(Self {
            owner: Arc::new(LockOwner {
                file,
                inherited: AtomicBool::new(false),
                paths: paths.cloned(),
                #[cfg(windows)]
                job,
            }),
        }))
    }
}

impl HeldLock {
    /// The held file must still be the store's lock file under an unreplaced root.
    fn validate_path(&self, paths: &StorePaths) -> Result<(), StoreError> {
        paths.check_identity()?;
        let current = open_lock_file(paths, &paths.store_lock_file())?;
        if !crate::paths::same_file(&self.owner.file, &current)? {
            return Err(StoreError::UnsafePath(
                "store lock file was replaced".into(),
            ));
        }
        Ok(())
    }
}

// The managed handle pins root identity. Registry candidates must match both
// that directory and its current lock file: an old guard for a retired root
// or lock inode must never supply ownership to a replacement store's child.
fn with_owner<T>(
    paths: Option<&StorePaths>,
    spawn: impl FnOnce(Option<Arc<LockOwner>>) -> std::io::Result<T>,
) -> std::io::Result<T> {
    let Some(paths) = paths else {
        return spawn(None);
    };
    // Same bounded admission as `store_lock`, capped by any operation deadline.
    let deadline = Instant::now() + ADMISSION_TIMEOUT;
    let check_deadline = || {
        if Instant::now() >= deadline || crate::git_read::OperationDeadline::check().is_err() {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "store lock admission deadline exceeded",
            ))
        } else {
            Ok(())
        }
    };
    loop {
        check_deadline()?;
        match OWNERS.try_lock() {
            Ok(mut owners) => {
                check_deadline()?;
                paths.check_identity().map_err(std::io::Error::other)?;
                let file = open_lock_file(paths, &paths.store_lock_file())
                    .map_err(std::io::Error::other)?;
                owners.retain(|owner| owner.strong_count() > 0);
                for weak in owners.iter() {
                    let Some(owner) = weak.upgrade() else {
                        continue;
                    };
                    let Some(held) = &owner.paths else {
                        continue;
                    };
                    if held.root() == paths.root()
                        && crate::paths::same_file(&held.root_handle, &paths.root_handle)
                            .map_err(std::io::Error::other)?
                        && crate::paths::same_file(&owner.file, &file)
                            .map_err(std::io::Error::other)?
                    {
                        check_deadline()?;
                        return spawn(Some(owner));
                    }
                }
                if take(&file).map_err(std::io::Error::other)?
                    && let Some(lock) =
                        HeldLock::new(file, Some(paths)).map_err(std::io::Error::other)?
                {
                    lock.validate_path(paths).map_err(std::io::Error::other)?;
                    check_deadline()?;
                    owners.push(Arc::downgrade(&lock.owner));
                    return spawn(Some(lock.owner));
                }
            }
            Err(std::sync::TryLockError::WouldBlock) => {}
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(std::io::Error::other("lock registry poisoned"));
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

// This narrowly scoped descriptor operation runs only in the child.
#[cfg(unix)]
#[allow(unsafe_code)] // pre_exec/fcntl are confined to this audited handoff.
fn inherit(owner: &LockOwner, command: &mut Command) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    let file = owner.file.try_clone()?; // stays CLOEXEC in the parent
    // SAFETY: the closure owns its source File until spawn. In the forked
    // child only, F_DUPFD picks an unused fd >=3 and clears CLOEXEC on that
    // duplicate. No parent fd flags change; no allocation/locks in pre_exec.
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn spawn_git(
    mut command: Command,
    paths: Option<&StorePaths>,
) -> std::io::Result<crate::git_read::ProcessChild> {
    with_owner(paths, |owner| {
        if let Some(owner) = &owner {
            inherit(owner, &mut command)?;
        }
        let child = command.spawn()?;
        if let Some(owner) = &owner {
            owner.inherited.store(true, Ordering::Relaxed);
        }
        Ok(crate::git_read::ProcessChild::new(child, owner))
    })
}

#[cfg(windows)]
pub(crate) fn spawn_git(
    command: Command,
    paths: Option<&StorePaths>,
    input: crate::win::Input,
) -> std::io::Result<crate::git_read::ProcessChild> {
    with_owner(paths, |owner| {
        let child = crate::win::spawn(&command, input, owner.as_deref())?;
        Ok(crate::git_read::ProcessChild::new(child, owner))
    })
}

/// Native account serialization. Never acquired while holding a store/KB fence.
/// Provider workers never inherit this file. They reopen a separate native
/// fence before input, preserving effect ordering after owner death.
/// Windows also drains the account's kill-on-close job before a successor.
pub struct CredentialFence(HeldLock, std::path::PathBuf);
impl CredentialFence {
    pub(crate) fn spawn_native(
        &self,
        mut command: Command,
    ) -> Result<crate::git_read::ProcessChild, StoreError> {
        let path = self.1.with_extension("native.lock");
        let paths = self.0.owner.paths.as_ref().ok_or(StoreError::LockNotHeld)?;
        // Create/validate the persistent inode before spawn. All parent files
        // remain CLOEXEC; no pre_exec duplicate hands this fence to the worker.
        drop(open_lock_file(paths, &path)?);
        command.arg("--kb-native-credential-fence").arg(path);
        #[cfg(unix)]
        let child = command.spawn().map_err(StoreError::Io)?;
        #[cfg(windows)]
        let child =
            crate::win::spawn_credential(&command, Some(&self.0.owner)).map_err(StoreError::Io)?;
        // A live native call retains ownership even if the caller drops its
        // fence. Successful reap releases this copy, not the caller's copy:
        // registration/revocation finalization and later calls stay excluded.
        Ok(crate::git_read::ProcessChild::new(
            child,
            Some(Arc::clone(&self.0.owner)),
        ))
    }
}
fn try_credential_lock(
    paths: &StorePaths,
    id: &KbId,
    revision: i64,
) -> Result<Option<CredentialFence>, StoreError> {
    let path = paths
        .locks_dir()
        .join(format!("provider_{id}_{revision}.lock"));
    let file = open_lock_file(paths, &path)?;
    if take(&file)? {
        // Some(paths) selects the Windows drain job; this lease is never
        // published to the store-owner registry.
        return Ok(HeldLock::new(file, Some(paths))?.map(|lock| CredentialFence(lock, path)));
    }
    Ok(None)
}
pub(crate) fn credential_lock(
    paths: &StorePaths,
    id: &KbId,
    revision: i64,
    ctl: &crate::embedder::ProviderControl,
) -> Result<CredentialFence, StoreError> {
    loop {
        ctl.check()?;
        if let Some(fence) = try_credential_lock(paths, id, revision)? {
            return Ok(fence);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(crate) async fn credential_lock_async(
    paths: &StorePaths,
    id: &KbId,
    revision: i64,
    ctl: &crate::embedder::ProviderControl,
) -> Result<CredentialFence, StoreError> {
    loop {
        ctl.check()?;
        if let Some(fence) = try_credential_lock(paths, id, revision)? {
            return Ok(fence);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Named store-local lease (config controller, index permits); never nest
/// its acquisition inside a store lock.
pub(crate) fn named_model_lock_until(
    paths: &StorePaths,
    name: &str,
    deadline: Instant,
) -> Result<CredentialFence, StoreError> {
    let deadline = deadline.min(Instant::now() + ADMISSION_TIMEOUT);
    loop {
        if Instant::now() >= deadline {
            return Err(StoreError::DeadlineExceeded);
        }
        if let Some(held) = try_named_model_lock(paths, name)? {
            return Ok(held);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub(crate) fn try_named_model_lock(
    paths: &StorePaths,
    name: &str,
) -> Result<Option<CredentialFence>, StoreError> {
    let path = paths.locks_dir().join(name);
    let file = open_lock_file(paths, &path)?;
    if take(&file)? {
        return Ok(HeldLock::new(file, Some(paths))?.map(|lock| CredentialFence(lock, path)));
    }
    Ok(None)
}

/// Trusted native-worker argument, not provider/config input. This independent
/// CLOEXEC file orders effects even after the lifecycle owner is killed. A
/// worker must hold it before acknowledging readiness or reading credentials.
pub(crate) fn native_credential_lock(path: &std::path::Path) -> Result<HeldLock, StoreError> {
    let locks = path.parent().ok_or(StoreError::LockNotHeld)?;
    if locks.file_name().and_then(|s| s.to_str()) != Some("locks") {
        return Err(StoreError::LockNotHeld);
    }
    let paths = StorePaths::new(locks.parent().ok_or(StoreError::LockNotHeld)?.to_path_buf())?;
    let file = open_lock_file(&paths, path)?;
    file.lock().map_err(StoreError::Io)?;
    HeldLock::new(file, None)?.ok_or(StoreError::LockNotHeld)
}

/// Exclusive hold of the store lock plus a sorted, deduplicated KB lock set.
#[derive(Debug)]
pub struct WriteGuard {
    root: std::path::PathBuf,
    // Identity of the root directory the guard was taken in: a guard for a
    // replaced/recycled root path never authorizes the new store.
    root_handle: Arc<File>,
    store: HeldLock,
    ids: Vec<KbId>,
    // Held for their lock; dropped (unlocked) in reverse acquisition order.
    _kbs: Vec<HeldLock>,
}

impl WriteGuard {
    /// KB IDs locked by this guard, sorted ascending.
    pub fn kb_ids(&self) -> &[KbId] {
        &self.ids
    }

    pub fn holds_kb(&self, kb: &KbId) -> bool {
        self.ids.binary_search(kb).is_ok()
    }

    /// Whether this guard holds `paths`' store lock: same root directory
    /// identity (not only the same path string) and the same lock file.
    pub(crate) fn matches(&self, paths: &StorePaths) -> Result<bool, StoreError> {
        paths.check_identity()?;
        if self.root != paths.root()
            || !crate::paths::same_file(&self.root_handle, &paths.root_handle)?
        {
            return Ok(false);
        }
        self.store.validate_path(paths)?;
        Ok(true)
    }

    /// Spawn a child with the store lock on an extra descriptor/explicit
    /// handle list. Unix preserves Command's stdio; Windows uses piped stdin
    /// and stdout and discarded stderr, as the supervised Git boundary does.
    /// Consumes the builder so its child-only handoff cannot retain a parent
    /// lock duplicate after spawn or be reused for a later child.
    pub fn spawn(&self, command: Command) -> Result<crate::git_read::ProcessChild, StoreError> {
        // Explicit guard children use the same bounded registry admission as
        // automatic Git readers, reusing this guard's identity-matched lease.
        #[cfg(unix)]
        let result = spawn_git(command, self.store.owner.paths.as_ref());
        #[cfg(windows)]
        let result = spawn_git(
            command,
            self.store.owner.paths.as_ref(),
            crate::win::Input::Pipe,
        );
        result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                StoreError::DeadlineExceeded
            } else {
                StoreError::Io(error)
            }
        })
    }
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        // Release KB locks (never inherited) before the store lock, which is
        // released after this body — explicitly unlocked unless it was
        // inherited: an explicit unlock would release the lock for inheriting
        // descendants too, while a close keeps it until the last one exits.
        while let Some(file) = self._kbs.pop() {
            drop(file);
        }
    }
}

fn open_lock_file(paths: &StorePaths, path: &std::path::Path) -> Result<File, StoreError> {
    paths.check_no_follow(path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    open_no_follow(path, &mut options)
}

/// Try an exclusive lock without an uninterruptible kernel wait.
fn take(file: &File) -> Result<bool, StoreError> {
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => Err(StoreError::Io(error)),
    }
}

/// Just the store lock, used by open/initialization.
pub(crate) fn store_lock(
    paths: &StorePaths,
    blocking: bool,
) -> Result<Option<HeldLock>, StoreError> {
    store_lock_until(
        paths,
        Admission::write(blocking),
        Instant::now() + ADMISSION_TIMEOUT,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Admission {
    Wait,
    Try,
    // Wait for the process-wide registry, but defer to an actual store
    // writer or draining descendant. Registry contention is not evidence
    // that this store has a live writer that will complete recovery.
    Startup,
}

impl Admission {
    fn write(blocking: bool) -> Self {
        if blocking { Self::Wait } else { Self::Try }
    }
}

fn store_lock_until(
    paths: &StorePaths,
    admission: Admission,
    deadline: Instant,
) -> Result<Option<HeldLock>, StoreError> {
    loop {
        if admission != Admission::Try {
            crate::git_read::OperationDeadline::check()?;
        }
        if admission != Admission::Try && Instant::now() >= deadline {
            return Err(StoreError::DeadlineExceeded);
        }
        let file = open_lock_file(paths, &paths.store_lock_file())?;
        match OWNERS.try_lock() {
            Ok(mut owners) => {
                if take(&file)?
                    && let Some(lock) = HeldLock::new(file, Some(paths))?
                {
                    // A lock taken on a replaced root/lock file protects nothing.
                    lock.validate_path(paths)?;
                    if admission != Admission::Try && Instant::now() >= deadline {
                        return Err(StoreError::DeadlineExceeded);
                    }
                    if admission != Admission::Try {
                        crate::git_read::OperationDeadline::check()?;
                    }
                    owners.retain(|owner| owner.strong_count() > 0);
                    owners.push(Arc::downgrade(&lock.owner));
                    return Ok(Some(lock));
                }
                if admission != Admission::Wait {
                    return Ok(None);
                }
            }
            Err(std::sync::TryLockError::WouldBlock) => {}
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(StoreError::Internal("lock registry poisoned".into()));
            }
        }
        if admission == Admission::Try {
            return Ok(None);
        }
        if Instant::now() >= deadline {
            return Err(StoreError::DeadlineExceeded);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

pub(crate) fn acquire(
    paths: &StorePaths,
    kbs: &[KbId],
    blocking: bool,
) -> Result<Option<WriteGuard>, StoreError> {
    acquire_with_admission(paths, kbs, Admission::write(blocking))
}

/// Startup can defer to a live writer, but must not silently skip recovery
/// because an unrelated store's spawn temporarily owns the registry.
pub(crate) fn acquire_for_open(paths: &StorePaths) -> Result<Option<WriteGuard>, StoreError> {
    acquire_with_admission(paths, &[], Admission::Startup)
}

fn acquire_with_admission(
    paths: &StorePaths,
    kbs: &[KbId],
    admission: Admission,
) -> Result<Option<WriteGuard>, StoreError> {
    let deadline = Instant::now() + ADMISSION_TIMEOUT;
    let mut ids = kbs.to_vec();
    ids.sort();
    ids.dedup();
    let Some(store) = store_lock_until(paths, admission, deadline)? else {
        return Ok(None);
    };
    let mut guard = WriteGuard {
        root: paths.root().to_path_buf(),
        root_handle: Arc::clone(&paths.root_handle),
        store,
        ids: Vec::new(),
        _kbs: Vec::with_capacity(ids.len()),
    };
    for id in &ids {
        if admission != Admission::Try {
            crate::git_read::OperationDeadline::check()?;
        }
        let file = open_lock_file(paths, &paths.kb_lock_file(id))?;
        while !take(&file)? {
            if admission != Admission::Wait {
                return Ok(None);
            }
            if Instant::now() >= deadline {
                return Err(StoreError::DeadlineExceeded);
            }
            crate::git_read::OperationDeadline::check()?;
            std::thread::sleep(Duration::from_millis(10));
        }
        guard._kbs.push(
            HeldLock::new(file, None)?
                .ok_or_else(|| StoreError::Internal("KB lock drain returned early".into()))?,
        );
    }
    guard.ids = ids;
    if admission != Admission::Try {
        crate::git_read::OperationDeadline::check()?;
    }
    if admission != Admission::Try && Instant::now() >= deadline {
        return Err(StoreError::DeadlineExceeded);
    }
    Ok(Some(guard))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_read::read_fixture::ChildGuard;

    #[cfg(unix)]
    #[allow(unsafe_code)] // Read-only fd inspection at the audited handoff boundary.
    fn assert_cloexec(file: &File) {
        use std::os::fd::AsRawFd;
        // SAFETY: the borrowed File keeps this descriptor live; F_GETFD only
        // reads its flags and does not change process descriptor ownership.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }

    #[cfg(unix)]
    mod native_lifecycle {
        use super::*;
        use crate::credentials::{Credentials, NativeCredentials, Secret};
        use crate::embedder::ProviderControl;
        use std::cell::{Cell, RefCell};
        use std::path::PathBuf;

        #[derive(Clone, Copy, PartialEq, Eq)]
        enum ReadMode {
            Normal,
            Cancel,
            Deadline,
            Drop,
        }
        struct Keys<'a> {
            store: &'a crate::Store,
            native: NativeCredentials,
            copies: RefCell<Vec<(File, PathBuf)>>,
            revoke_during_set: Cell<bool>,
            mode: Cell<ReadMode>,
            pending: Cell<bool>,
        }
        impl<'a> Keys<'a> {
            fn new(store: &'a crate::Store, root: &CredentialRoot) -> Self {
                use std::os::unix::fs::PermissionsExt;
                let exe = root.0.join("native-fixture");
                // The actual NativeCall pipes/reaper run against a trusted
                // fixture, never a user's OS keystore. Parking uses exec so no
                // descendant can keep the pipes alive after the worker is killed.
                std::fs::write(&exe, b"#!/bin/sh\nworker_dir=${0%/*}\nif [ -e \"$worker_dir/park\" ]; then exec sleep 30; fi\nif [ -e \"$worker_dir/read-before-ready\" ]; then exec cat >\"$worker_dir/input-received\"; fi\nprintf '\\001'\ncat >/dev/null\nif [ -e \"$worker_dir/fail\" ]; then exit 1; fi\nprintf disposable-native-fixture\n")
                    .expect("native fixture");
                std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700))
                    .expect("native fixture");
                Self {
                    store,
                    native: NativeCredentials::new(exe),
                    copies: RefCell::new(Vec::new()),
                    revoke_during_set: Cell::new(false),
                    mode: Cell::new(ReadMode::Normal),
                    pending: Cell::new(false),
                }
            }
            fn retain_copy(&self, fence: &CredentialFence) {
                assert_cloexec(&fence.0.owner.file);
                let copy = fence
                    .0
                    .owner
                    .file
                    .try_clone()
                    .expect("fork-equivalent copy");
                assert_cloexec(&copy);
                self.copies.borrow_mut().push((copy, fence.1.clone()));
                Self::assert_held(fence);
            }
            fn assert_held(fence: &CredentialFence) {
                let probe = File::options()
                    .read(true)
                    .write(true)
                    .open(&fence.1)
                    .expect("probe");
                assert!(
                    matches!(probe.try_lock(), Err(TryLockError::WouldBlock)),
                    "native reap must not unlock the caller's finalization fence"
                );
            }
            fn assert_released(&self) {
                assert!(
                    !self.copies.borrow().is_empty(),
                    "native caller was reached"
                );
                // Keep all duplicates alive while probing. Close-only release
                // fails deterministically, exactly as a parked unrelated fork.
                for (_, path) in self.copies.borrow().iter() {
                    let probe = File::options()
                        .read(true)
                        .write(true)
                        .open(path)
                        .expect("probe");
                    probe
                        .try_lock()
                        .expect("owner finished: immediate release despite fd copies");
                    probe.unlock().expect("probe release");
                }
            }
        }
        impl Credentials for Keys<'_> {
            fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
                self.native.set(account, secret)
            }
            fn get(&self, account: &str) -> Result<Secret, StoreError> {
                self.native.get(account)
            }
            fn delete(&self, account: &str) -> Result<(), StoreError> {
                self.native.delete(account)
            }
            fn set_controlled(
                &self,
                account: &str,
                secret: &Secret,
                ctl: &ProviderControl,
                fence: &CredentialFence,
            ) -> Result<(), StoreError> {
                self.retain_copy(fence);
                let result = self.native.set_controlled(account, secret, ctl, fence);
                Self::assert_held(fence);
                if result.is_ok() && self.revoke_during_set.get() {
                    let _guard = self.store.lock_write(&[])?;
                    // Reconstruct concurrent durable revocation in the gap
                    // after native set and before registration's final check.
                    self.store
                        .conn
                        .execute("UPDATE providers SET revoked=1 WHERE revoked=0", [])?;
                    self.store.conn.execute(
                        "UPDATE provider_revisions SET state='REVOKED' WHERE state='STORING'",
                        [],
                    )?;
                }
                result
            }
            fn delete_controlled(
                &self,
                account: &str,
                ctl: &ProviderControl,
                fence: &CredentialFence,
            ) -> Result<(), StoreError> {
                self.retain_copy(fence);
                let result = self.native.delete_controlled(account, ctl, fence);
                Self::assert_held(fence);
                result
            }
            fn get_controlled<'a>(
                &'a self,
                account: &'a str,
                ctl: &'a ProviderControl,
                fence: &'a CredentialFence,
            ) -> crate::egress::IoFuture<'a, Secret> {
                Box::pin(async move {
                    self.retain_copy(fence);
                    let control = if self.mode.get() == ReadMode::Deadline {
                        ProviderControl::with_timeout(Duration::from_millis(50))
                    } else {
                        ctl.clone()
                    };
                    let mut call = self.native.get_controlled(account, &control, fence);
                    let result = std::future::poll_fn(|cx| {
                        let result = call.as_mut().poll(cx);
                        if result.is_pending() {
                            self.pending.set(true);
                            if self.mode.get() == ReadMode::Cancel {
                                control.cancel();
                            }
                        }
                        result
                    })
                    .await;
                    drop(call);
                    Self::assert_held(fence);
                    result
                })
            }
        }
        fn config() -> crate::providers::ProviderConfig {
            crate::providers::ProviderConfig {
                idempotency_key: "native-register-0001".into(),
                provider_id: None,
                name: "native fixture".into(),
                endpoint_url: "https://provider.test/embed".into(),
                model: "fixture".into(),
                dimensions: 2,
            }
        }
        fn register(store: &crate::Store, keys: &Keys<'_>) -> crate::providers::ProviderRevision {
            store
                .provider_register(
                    &store.owner(),
                    config(),
                    Secret::new("disposable-fixture".into()),
                    keys,
                )
                .expect("registration")
        }

        #[test]
        fn provider_registration_releases_after_success_errors_and_multiple_native_calls() {
            for case in [
                "success",
                "native-error",
                "before-ready",
                "finalize-error",
                "revoked",
            ] {
                let root = CredentialRoot::new();
                let store = crate::Store::open(&root.0.join("store")).expect("fixture");
                let keys = Keys::new(&store, &root);
                if case == "native-error" {
                    std::fs::write(root.0.join("fail"), b"1").expect("fixture");
                } else if case == "before-ready" {
                    std::fs::write(root.0.join("read-before-ready"), b"1").expect("fixture");
                } else if case == "finalize-error" {
                    store.conn.execute_batch("CREATE TRIGGER fixture_finalize_failure BEFORE INSERT ON provider_events WHEN NEW.event='provider_create' BEGIN SELECT RAISE(ABORT,'fixture finalization'); END;").expect("fixture");
                }
                keys.revoke_during_set.set(case == "revoked");
                let result = store.provider_register(
                    &store.owner(),
                    config(),
                    Secret::new("disposable-fixture".into()),
                    &keys,
                );
                assert_eq!(result.is_ok(), case == "success", "{case}");
                assert_eq!(
                    keys.copies.borrow().len(),
                    if case == "revoked" { 2 } else { 1 }
                );
                keys.assert_released();
                if case == "before-ready" {
                    assert!(
                        std::fs::read(root.0.join("input-received"))
                            .expect("captured input")
                            .is_empty(),
                        "credential input must wait for native-lock readiness"
                    );
                }
            }
        }

        #[test]
        fn provider_revocation_releases_after_native_and_finalization_errors() {
            for case in ["success", "native-error", "finalize-error"] {
                let root = CredentialRoot::new();
                let store = crate::Store::open(&root.0.join("store")).expect("fixture");
                let keys = Keys::new(&store, &root);
                let r = register(&store, &keys);
                if case == "native-error" {
                    std::fs::write(root.0.join("fail"), b"1").expect("fixture");
                } else if case == "finalize-error" {
                    store.conn.execute_batch("CREATE TRIGGER fixture_finalize_failure BEFORE UPDATE OF secret_deleted ON provider_revisions BEGIN SELECT RAISE(ABORT,'fixture finalization'); END;").expect("fixture");
                }
                let result = store.provider_revoke(&store.owner(), &r.provider_id, &keys);
                assert_eq!(result.is_ok(), case == "success", "{case}");
                assert_eq!(keys.copies.borrow().len(), 2);
                keys.assert_released();
            }
        }

        struct NoNetwork;
        impl crate::egress::Dns for NoNetwork {
            fn resolve<'a>(
                &'a self,
                _: &'a str,
                _: u16,
            ) -> crate::egress::IoFuture<'a, Vec<std::net::IpAddr>> {
                panic!("empty embedding must not dispatch")
            }
        }
        impl crate::egress::Http for NoNetwork {
            fn post<'a>(
                &'a self,
                _: &'a crate::egress::Endpoint,
                _: std::net::SocketAddr,
                _: &'a Secret,
                _: Vec<u8>,
            ) -> crate::egress::IoFuture<'a, crate::egress::HttpResponse> {
                panic!("empty embedding must not dispatch")
            }
        }
        #[test]
        fn provider_reads_release_on_success_error_deadline_cancellation_and_future_drop() {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            for case in ["success", "native-error", "cancel", "deadline", "drop"] {
                let root = CredentialRoot::new();
                let store = crate::Store::open(&root.0.join("store")).expect("fixture");
                let keys = Keys::new(&store, &root);
                let r = register(&store, &keys);
                store
                    .conn
                    .execute(
                        "UPDATE provider_revisions SET state='READY' WHERE provider_id=?1",
                        [r.provider_id.as_str()],
                    )
                    .expect("fixture ready state");
                if case == "native-error" {
                    std::fs::write(root.0.join("fail"), b"1").expect("fixture");
                } else if case != "success" {
                    std::fs::write(root.0.join("park"), b"1").expect("fixture");
                }
                keys.mode.set(match case {
                    "cancel" => ReadMode::Cancel,
                    "deadline" => ReadMode::Deadline,
                    "drop" => ReadMode::Drop,
                    _ => ReadMode::Normal,
                });
                runtime.block_on(async {
                    let owner = store.owner();
                    let ctl = ProviderControl::default();
                    let egress = crate::egress::PinnedEgress::new(&NoNetwork, &NoNetwork);
                    let mut request = Box::pin(store.provider_embed(
                        &owner,
                        &r.provider_id,
                        r.revision,
                        &[],
                        &keys,
                        &egress,
                        &ctl,
                    ));
                    if case == "drop" {
                        std::future::poll_fn(|cx| {
                            assert!(request.as_mut().poll(cx).is_pending());
                            assert!(keys.pending.get(), "actual native child started");
                            std::task::Poll::Ready(())
                        })
                        .await;
                        drop(request);
                    } else {
                        let result = request.await;
                        assert_eq!(result.is_ok(), case == "success", "{case}");
                        if case == "cancel" || case == "deadline" {
                            assert!(keys.pending.get(), "actual native child started");
                            assert_eq!(
                                result.expect_err("controlled failure").protocol_code(),
                                if case == "cancel" {
                                    kb_client::ErrorCode::Cancelled
                                } else {
                                    kb_client::ErrorCode::DeadlineExceeded
                                }
                            );
                        }
                    }
                });
                assert_eq!(keys.copies.borrow().len(), 2);
                keys.assert_released();
            }
        }
    }

    // These tests intentionally hold the process-wide registry. Isolate the
    // real boundary so parallel libtest fixtures cannot spend their admission
    // deadlines waiting for a different test's deliberate contention.
    fn in_isolated_process(name: &str) -> bool {
        const ROLE: &str = "KB_LOCAL_LOCK_UNIT_TEST";
        let name = format!("locks::tests::{name}");
        if std::env::var(ROLE).as_deref() == Ok(name.as_str()) {
            return false;
        }
        let output = Command::new(std::env::current_exe().expect("fixture"))
            .args(["--exact", &name, "--nocapture", "--test-threads=1"])
            .env(ROLE, &name)
            .output()
            .expect("isolated registry fixture");
        assert!(output.status.success(), "{name}: {output:?}");
        true
    }

    const CREDENTIAL_ROLE: &str = "KB_TEST_CREDENTIAL_FENCE_ROLE";
    const CREDENTIAL_ROOT: &str = "KB_TEST_CREDENTIAL_FENCE_ROOT";
    #[cfg(unix)]
    fn credential_id() -> KbId {
        KbId::parse("aaaaaaaaaaaaaaaaaaaaaaaa").expect("fixture id")
    }
    #[cfg(unix)]
    fn credential_command(root: &std::path::Path, role: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("fixture"));
        command
            .args([
                "--ignored",
                "--exact",
                "locks::tests::credential_fence_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CREDENTIAL_ROLE, role)
            .env(CREDENTIAL_ROOT, root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command
    }
    #[cfg(unix)]
    fn native_credential_command(root: &std::path::Path, role: &str) -> Command {
        // Strip the private native-worker arguments for the libtest helper.
        // All ownership assertions still exercise the production spawn boundary.
        let mut command = Command::new("sh");
        command.args(["-c", "exec \"$1\" --ignored --exact locks::tests::credential_fence_child --nocapture --test-threads=1", "fixture"])
            .arg(std::env::current_exe().expect("fixture"))
            .env(CREDENTIAL_ROLE, role)
            .env(CREDENTIAL_ROOT, root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command
    }
    struct TestChild(crate::git_read::ProcessChild);
    impl std::ops::Deref for TestChild {
        type Target = crate::git_read::ProcessChild;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
    impl std::ops::DerefMut for TestChild {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.0
        }
    }
    impl Drop for TestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(unix)]
    struct CredentialRoot(std::path::PathBuf);
    #[cfg(unix)]
    impl CredentialRoot {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "kb-credential-fence-{}",
                crate::state::new_uuid_v4().expect("fixture")
            )))
        }
        fn ready(&self, name: &str) {
            let until = Instant::now() + Duration::from_secs(10);
            while !self.0.join(name).exists() {
                assert!(Instant::now() < until, "credential child readiness");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    #[cfg(unix)]
    impl Drop for CredentialRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    #[ignore = "parent-owned credential fence helper"]
    fn credential_fence_child() {
        let root =
            std::path::PathBuf::from(std::env::var_os(CREDENTIAL_ROOT).expect("fixture root"));
        match std::env::var(CREDENTIAL_ROLE)
            .expect("fixture role")
            .as_str()
        {
            #[cfg(unix)]
            "native-owner" => {
                let store = crate::Store::open(&root.join("store")).expect("fixture");
                let fence = credential_lock(&store.paths, &credential_id(), 1, &Default::default())
                    .expect("account admission");
                let mut child = TestChild(
                    fence
                        .spawn_native(native_credential_command(&root, "native-parked"))
                        .expect("native child"),
                );
                std::fs::write(root.join("owner-ready"), b"1").expect("fixture");
                let mut control = [0];
                std::io::Read::read(&mut std::io::stdin(), &mut control).expect("owner control");
                child.0.wait().expect("drain");
            }
            #[cfg(unix)]
            "native-parked" | "native-successor" => {
                let path = root
                    .join("store/locks")
                    .join(format!("provider_{}_1.native.lock", credential_id()));
                if std::env::var(CREDENTIAL_ROLE).expect("role") == "native-successor" {
                    let probe = File::options()
                        .read(true)
                        .write(true)
                        .open(&path)
                        .expect("probe");
                    assert!(matches!(probe.try_lock(), Err(TryLockError::WouldBlock)));
                    std::fs::write(root.join("native-waiting"), b"1").expect("fixture");
                    let _fence = native_credential_lock(&path).expect("native admission");
                    std::fs::write(root.join("native-successor"), b"1").expect("fixture");
                } else {
                    let fence = native_credential_lock(&path).expect("native admission");
                    assert_cloexec(&fence.owner.file);
                    std::fs::write(root.join("native-parked"), std::process::id().to_string())
                        .expect("fixture");
                    let until = Instant::now() + Duration::from_secs(15);
                    while !root.join("release").exists() {
                        assert!(Instant::now() < until, "native release watchdog");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    std::fs::write(root.join("native-drained"), b"1").expect("fixture");
                }
            }
            "parked" => {
                std::fs::write(root.join("parked"), std::process::id().to_string())
                    .expect("fixture");
                let until = Instant::now() + Duration::from_secs(15);
                while !root.join("release").exists() {
                    assert!(Instant::now() < until, "parent must release owned child");
                    std::thread::sleep(Duration::from_millis(10));
                }
                std::fs::write(root.join("drained"), b"1").expect("fixture");
            }
            other => panic!("unexpected fixture role {other}"),
        }
    }
    #[cfg(unix)]
    #[test]
    fn native_provider_fence_is_not_inherited_and_live_calls_retain_owner_until_reap() {
        for cancelled in [false, true] {
            let root = CredentialRoot::new();
            let store = crate::Store::open(&root.0.join("store")).expect("fixture");
            let fence = credential_lock(&store.paths, &credential_id(), 1, &Default::default())
                .expect("admission");
            let copy = fence
                .0
                .owner
                .file
                .try_clone()
                .expect("fork-equivalent copy");
            assert_cloexec(&copy);
            let path = fence.1.clone();
            let mut child = TestChild(
                fence
                    .spawn_native(native_credential_command(&root.0, "native-parked"))
                    .expect("native spawn"),
            );
            root.ready("native-parked");
            #[cfg(target_os = "linux")]
            {
                let files = std::fs::read_dir(format!("/proc/{}/fd", child.0.id()))
                    .expect("child descriptors");
                let targets: Vec<_> = files
                    .flatten()
                    .filter_map(|entry| std::fs::read_link(entry.path()).ok())
                    .collect();
                assert!(
                    !targets.contains(&path),
                    "native exec must not inherit the lifecycle lock"
                );
                assert!(
                    targets.contains(&path.with_extension("native.lock")),
                    "native worker opens its independent fence"
                );
            }
            drop(fence);
            let probe = File::options()
                .read(true)
                .write(true)
                .open(&path)
                .expect("probe");
            assert!(
                matches!(probe.try_lock(), Err(TryLockError::WouldBlock)),
                "live NativeCall retains lifecycle owner"
            );
            if cancelled {
                drop(child);
            } else {
                std::fs::write(root.0.join("release"), b"1").expect("fixture");
                assert!(child.0.wait().expect("reap").success());
                drop(child);
            }
            probe
                .try_lock()
                .expect("reaped last owner releases despite duplicate");
            probe.unlock().expect("probe release");
            drop(copy);
        }
    }
    #[cfg(unix)]
    #[test]
    fn native_owner_death_keeps_effects_serialized_by_the_worker_opened_fence() {
        let root = CredentialRoot::new();
        let store = crate::Store::open(&root.0.join("store")).expect("fixture");
        let mut owner = ChildGuard::spawn(&credential_command(&root.0, "native-owner"))
            .expect("owned native fixture");
        root.ready("owner-ready");
        root.ready("native-parked");
        owner.kill().expect("owner death");
        owner.wait().expect("owner reap");
        let fence = credential_lock(&store.paths, &credential_id(), 1, &Default::default())
            .expect("new lifecycle owner");
        assert!(!root.0.join("native-drained").exists());
        let mut successor = TestChild(
            fence
                .spawn_native(native_credential_command(&root.0, "native-successor"))
                .expect("native successor"),
        );
        root.ready("native-waiting");
        assert!(
            !root.0.join("native-successor").exists(),
            "old native effects must finish first"
        );
        std::fs::write(root.0.join("release"), b"1").expect("release old native owner");
        assert!(successor.0.wait().expect("successor reap").success());
        root.ready("native-drained");
        assert!(root.0.join("native-successor").exists());
    }
    fn native_version(paths: &StorePaths) -> std::io::Result<TestChild> {
        let mut command = Command::new("git");
        command.arg("--version");
        #[cfg(unix)]
        return spawn_git(command, Some(paths)).map(TestChild);
        #[cfg(windows)]
        spawn_git(command, Some(paths), crate::win::Input::Null).map(TestChild)
    }

    #[test]
    fn managed_registry_contention_obeys_admission_and_operation_deadlines_without_launch() {
        if in_isolated_process(
            "managed_registry_contention_obeys_admission_and_operation_deadlines_without_launch",
        ) {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "kb-managed-registry-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = crate::Store::open(&root).expect("fixture");
        // Exercise new ownership and existing-owner reuse with both bounds.
        for held in [false, true] {
            let guard = held.then(|| store.lock_write(&[]).expect("fixture"));
            for operation in [false, true] {
                let registry = OWNERS.lock().expect("fixture");
                let paths = store.paths.clone();
                let (send, receive) = std::sync::mpsc::channel();
                let worker = std::thread::spawn(move || {
                    let _scope = operation.then(|| {
                        crate::git_read::OperationDeadline::for_test(Duration::from_millis(100))
                    });
                    let started = Instant::now();
                    let result = native_version(&paths);
                    send.send((result, started.elapsed())).expect("fixture");
                });
                let bound = if operation {
                    Duration::from_secs(1)
                } else {
                    ADMISSION_TIMEOUT + Duration::from_secs(1)
                };
                let observed = receive.recv_timeout(bound);
                // Always release/join even on the historical blocking bug.
                drop(registry);
                worker.join().expect("fixture");
                let returned_while_contended = observed.is_ok();
                let (result, elapsed) =
                    observed.unwrap_or_else(|_| receive.recv().expect("fixture"));
                let timed_out = match result {
                    Err(error) => error.kind() == std::io::ErrorKind::TimedOut,
                    Ok(mut child) => {
                        child.wait().expect("reap unexpected native child");
                        false
                    }
                };
                assert!(
                    returned_while_contended && timed_out && elapsed < bound,
                    "managed registry wait launched or missed its bound: held={held}, operation={operation}, elapsed={elapsed:?}"
                );
                // A failed admission neither releases the predecessor nor
                // leaves a new owner behind; real native Git still works.
                let probe =
                    open_lock_file(&store.paths, &store.paths.store_lock_file()).expect("fixture");
                if held {
                    assert!(matches!(probe.try_lock(), Err(TryLockError::WouldBlock)));
                } else {
                    probe.try_lock().expect("failed admission leaked no lock");
                    probe.unlock().expect("fixture");
                }
                let mut child = native_version(&store.paths).expect("legitimate native admission");
                assert!(child.wait().expect("native reap").success());
            }
            drop(guard);
            drop(store.lock_write(&[]).expect("reentry"));
        }
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn explicit_guard_registry_contention_obeys_operation_deadline_without_releasing_owner() {
        if in_isolated_process(
            "explicit_guard_registry_contention_obeys_operation_deadline_without_releasing_owner",
        ) {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "kb-guard-registry-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = crate::Store::open(&root).expect("fixture");
        let guard = store.lock_write(&[]).expect("fixture");
        let registry = OWNERS.lock().expect("fixture");
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _scope = crate::git_read::OperationDeadline::for_test(Duration::from_millis(100));
            let started = Instant::now();
            let mut command = Command::new("git");
            command.arg("--version");
            let result = guard.spawn(command).map(TestChild);
            send.send((guard, result, started.elapsed()))
                .expect("fixture");
        });
        let observed = receive.recv_timeout(Duration::from_secs(1));
        drop(registry);
        worker.join().expect("fixture");
        let returned_while_contended = observed.is_ok();
        let (guard, result, elapsed) =
            observed.unwrap_or_else(|_| receive.recv().expect("fixture"));
        let timed_out = match result {
            Err(error) => error.protocol_code() == kb_client::ErrorCode::DeadlineExceeded,
            Ok(mut child) => {
                child.wait().expect("reap unexpected child");
                false
            }
        };
        assert!(returned_while_contended && timed_out && elapsed < Duration::from_secs(1));
        let probe = open_lock_file(&store.paths, &store.paths.store_lock_file()).expect("fixture");
        assert!(matches!(probe.try_lock(), Err(TryLockError::WouldBlock)));
        drop(guard);
        probe
            .try_lock()
            .expect("guard releases after failed admission");
        probe.unlock().expect("fixture");
        drop(store.lock_write(&[]).expect("reentry"));
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn managed_os_contention_times_out_without_releasing_predecessor_or_leaking_a_lock() {
        if in_isolated_process(
            "managed_os_contention_times_out_without_releasing_predecessor_or_leaking_a_lock",
        ) {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "kb-managed-os-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = crate::Store::open(&root).expect("fixture");
        let predecessor =
            open_lock_file(&store.paths, &store.paths.store_lock_file()).expect("fixture");
        predecessor.try_lock().expect("fixture");
        let started = Instant::now();
        let error = match native_version(&store.paths) {
            Err(error) => error,
            Ok(mut child) => {
                child.kill().expect("stop unexpected child");
                child.wait().expect("reap unexpected child");
                panic!("must not launch without exclusion");
            }
        };
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= ADMISSION_TIMEOUT);
        assert!(started.elapsed() < ADMISSION_TIMEOUT + Duration::from_secs(1));
        let probe = open_lock_file(&store.paths, &store.paths.store_lock_file()).expect("fixture");
        assert!(matches!(probe.try_lock(), Err(TryLockError::WouldBlock)));
        predecessor.unlock().expect("fixture");
        let mut child = native_version(&store.paths).expect("admit after release");
        assert!(child.wait().expect("reap").success());
        probe.try_lock().expect("reaped child leaked no lock");
        probe.unlock().expect("fixture");
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn startup_does_not_skip_expiry_recovery_when_registry_is_busy() {
        // Keep the deliberately held process-wide registry from starving
        // other unit tests' bounded admissions.
        if std::env::var_os("KB_STARTUP_REGISTRY_TEST_CHILD").is_none() {
            let output = Command::new(std::env::current_exe().expect("fixture executable"))
                .args([
                    "--exact",
                    "locks::tests::startup_does_not_skip_expiry_recovery_when_registry_is_busy",
                    "--nocapture",
                ])
                .env("KB_STARTUP_REGISTRY_TEST_CHILD", "1")
                .stdin(std::process::Stdio::null())
                .output()
                .expect("spawn startup test");
            assert!(
                output.status.success(),
                "startup child failed: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed;"));
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "kb-startup-registry-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = crate::Store::open(&root).expect("fixture");
        let kb = store
            .bases_create(
                &store.owner(),
                kb_client::decode_input::<kb_client::types::BasesCreate>(serde_json::json!({
                    "name": "Fixture", "slug": "startup-registry", "description": "Startup recovery fixture",
                    "idempotencyKey": "create-startup-registry"
                }))
                .expect("fixture"),
            )
            .expect("fixture")
            .kb
            .id;
        let upload = store
            .upload_begin(
                &store.owner(),
                kb_client::decode_input::<kb_client::types::UploadBegin>(serde_json::json!({
                    "kbId": kb, "kind": "markdown", "mime": "text/markdown", "size": 1,
                    "contentHash": kb_client::snapshot::content_hash(b"x"),
                    "idempotencyKey": "upload-startup-registry"
                }))
                .expect("fixture"),
            )
            .expect("fixture");
        let path = store.paths.uploads_dir().join(upload.upload_id.as_str());
        // The durable expiry intent has committed, but its unlink has not.
        // Its original TTL is still in the future, as after a skewed clock.
        store
            .conn
            .execute(
                "UPDATE staged_uploads SET state='EXPIRED',reserved=0 WHERE id=?1",
                [upload.upload_id.as_str()],
            )
            .expect("expiry intent");
        drop(store);

        let owners = OWNERS.lock().expect("fixture");
        // Model another store's native spawn holding the shared registry.
        // This store's OS lock is idle, so opening must not report success
        // with the durable expiry intent unrecovered.
        let reopened = crate::Store::open(&root);
        drop(owners);
        let error = reopened.expect_err("busy registry must not silently skip startup recovery");
        assert_eq!(
            error.protocol_code(),
            kb_client::ErrorCode::DeadlineExceeded
        );
        assert!(path.exists(), "cleanup must wait for admission");

        let store = crate::Store::open(&root).expect("restart after registry release");
        assert!(!path.exists());
        assert_eq!(
            store
                .conn
                .query_row(
                    "SELECT reserved,reclaimed FROM staged_uploads WHERE id=?1",
                    [upload.upload_id.as_str()],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                )
                .expect("released once"),
            (0, 1)
        );
        assert_eq!(store.sweep_uploads().expect("repeat recovery"), 0);
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn registry_contention_uses_the_same_admission_deadline() {
        if in_isolated_process("registry_contention_uses_the_same_admission_deadline") {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "kb-lock-registry-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = crate::Store::open(&root).expect("fixture");
        let owners = OWNERS.lock().expect("fixture");
        // An idle OS lock does not imply nonblocking admission succeeds:
        // another store's spawn may hold the shared registry.
        let file = open_lock_file(&store.paths, &store.paths.store_lock_file()).expect("fixture");
        file.try_lock().expect("idle OS lock");
        file.unlock().expect("fixture");
        assert!(store.try_lock_write(&[]).expect("fixture").is_none());
        let started = Instant::now();
        let error = store_lock_until(
            &store.paths,
            Admission::Wait,
            started + Duration::from_millis(75),
        )
        .expect_err("busy registry must not block indefinitely");
        assert_eq!(
            error.protocol_code(),
            kb_client::ErrorCode::DeadlineExceeded
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(owners);
        drop(file);
        drop(store.lock_write(&[]).expect("fixture"));
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn unhanded_drop_unlocks_even_with_a_duplicate_description() {
        if in_isolated_process("unhanded_drop_unlocks_even_with_a_duplicate_description") {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "kb-lock-duplicate-{}",
            crate::state::new_uuid_v4().expect("fixture")
        ));
        let store = crate::Store::open(&root).expect("fixture");
        let guard = store.lock_write(&[]).expect("fixture");
        // Like a fork before exec, this duplicates the open file description
        // without marking it as an intended descendant handoff.
        let duplicate = guard.store.owner.file.try_clone().expect("fixture");
        let probe = open_lock_file(&store.paths, &store.paths.store_lock_file()).expect("fixture");
        assert!(matches!(probe.try_lock(), Err(TryLockError::WouldBlock)));
        drop(guard);
        probe.try_lock().expect("drop must explicitly unlock");
        probe.unlock().expect("fixture");
        drop(probe);
        drop(duplicate);
        drop(store);
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }
}
