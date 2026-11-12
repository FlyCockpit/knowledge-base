//! Managed store layout and the no-follow filesystem jail.
//!
//! Every managed path is derived from the canonical store root plus validated
//! lowercase IDs (`KbId`: 24..32 `[a-z0-9]`), so two distinct IDs never map to
//! the same path, even on a case-folding filesystem, and no ID can contain a
//! separator or `..`. The store root itself is canonicalized once at open;
//! everything *below* it is walked component by component with `lstat` and
//! refused if any component is a symlink or (Windows) reparse point. Final
//! file opens additionally use `O_NOFOLLOW` / `FILE_FLAG_OPEN_REPARSE_POINT`.
//!
//! Residual race: an intermediate component swapped for a symlink between the
//! `lstat` walk and the open is only possible for a process running as the
//! store owner (every managed directory is owner-only), which already holds
//! the owner's authority over the store.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use kb_client::types::KbId;

use crate::StoreError;

/// Durable registry file (never disposable).
pub const STATE_FILE: &str = "state.sqlite";
/// Initialization scratch name; only ever published by rename.
pub(crate) const STATE_INIT_FILE: &str = "state.sqlite.init";
/// Managed top-level directories, created owner-only.
pub const MANAGED_DIRS: [&str; 5] = ["locks", "repos", "assets", "uploads", "indexes"];

/// Paths of one managed store. Construct through [`crate::Store::open`].
#[derive(Clone, Debug)]
pub struct StorePaths {
    root: PathBuf,
    /// The root directory opened at `Store::open`: replacing the root path
    /// (even with a new store) is detected at use, never silently followed.
    pub(crate) root_handle: Arc<File>,
}

impl StorePaths {
    pub(crate) fn new(root: PathBuf) -> Result<Self, StoreError> {
        let root_handle = Arc::new(open_directory(&root)?);
        Ok(StorePaths { root, root_handle })
    }

    pub(crate) fn check_identity(&self) -> Result<(), StoreError> {
        let current = open_directory(&self.root)?;
        if !same_file(&self.root_handle, &current)? {
            return Err(StoreError::UnsafePath("store root was replaced".into()));
        }
        Ok(())
    }

    /// Canonical store root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn state_db(&self) -> PathBuf {
        self.root.join(STATE_FILE)
    }

    pub fn locks_dir(&self) -> PathBuf {
        self.root.join("locks")
    }

    pub fn store_lock_file(&self) -> PathBuf {
        self.locks_dir().join("store.lock")
    }

    pub fn kb_lock_file(&self, kb: &KbId) -> PathBuf {
        self.locks_dir().join(format!("kb_{kb}.lock"))
    }

    /// Bare Git repository of a KB: `repos/kb_<id>.git`.
    pub fn repo_dir(&self, kb: &KbId) -> PathBuf {
        self.root.join("repos").join(format!("kb_{kb}.git"))
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.root.join("assets")
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.root.join("uploads")
    }

    /// Disposable per-KB index directory: `indexes/<kbId>`.
    pub fn index_dir(&self, kb: &KbId) -> PathBuf {
        self.root.join("indexes").join(kb.as_str())
    }

    /// Disposable generation index: `indexes/<kbId>/<generationId>.sqlite`.
    pub fn index_file(&self, kb: &KbId, generation: &KbId) -> PathBuf {
        self.index_dir(kb).join(format!("{generation}.sqlite"))
    }

    /// Build-time name of a generation index: `indexes/<kbId>/<generationId>.tmp`.
    /// Every byte is written here; only a finalized file is linked to
    /// [`StorePaths::index_file`]. Its rollback journal is `<…>.tmp-journal`.
    pub fn index_temp_file(&self, kb: &KbId, generation: &KbId) -> PathBuf {
        self.index_dir(kb).join(format!("{generation}.tmp"))
    }

    /// Create (owner-only, no-follow) the index directory of `kb`.
    pub fn ensure_index_dir(&self, kb: &KbId) -> Result<PathBuf, StoreError> {
        self.check_identity()?;
        ensure_dir(&self.root, &["indexes", kb.as_str()])
    }

    /// Refuse `path` if any existing component below the root is a symlink
    /// or reparse point. `path` must be inside the store.
    pub fn check_no_follow(&self, path: &Path) -> Result<(), StoreError> {
        self.check_identity()?;
        let rel = path
            .strip_prefix(&self.root)
            .map_err(|_| StoreError::UnsafePath("path is outside the store".into()))?;
        check_components(&self.root, rel)
    }

    pub(crate) fn ensure_managed_dirs(
        &self,
        observer: &mut dyn FnMut(crate::store::OpenStage) -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        for dir in MANAGED_DIRS {
            ensure_dir_observed(&self.root, &[dir], false, observer)?;
        }
        // State is published before managed directories are installed. One
        // containing-directory flush finishes any interrupted installation,
        // including an existing entry whose creator died before its sync.
        sync_dir_observed(&self.root, observer)
    }

    /// Tighten repositories written before Git ran with
    /// `core.sharedRepository=0600` (or under a looser umask). A repository
    /// is walked only while its own directory, `objects` or `refs` still has
    /// group/other bits, so a store that is already owner-only costs three
    /// `stat`s per knowledge base.
    pub(crate) fn tighten_repos(&self) -> Result<(), StoreError> {
        #[cfg(unix)]
        {
            let repos = self.root.join("repos");
            self.check_no_follow(&repos)?;
            for entry in std::fs::read_dir(&repos).map_err(StoreError::Io)? {
                let dir = entry.map_err(StoreError::Io)?.path();
                let meta = std::fs::symlink_metadata(&dir).map_err(StoreError::Io)?;
                if is_link(&meta) || !meta.is_dir() {
                    continue;
                }
                let loose = [dir.clone(), dir.join("objects"), dir.join("refs")]
                    .iter()
                    .any(|path| {
                        std::fs::symlink_metadata(path)
                            .is_ok_and(|meta| !is_link(&meta) && !owner_only_mode_ok(&meta))
                    });
                if loose {
                    make_tree_owner_only(&dir)?;
                }
            }
        }
        Ok(())
    }
}

fn unsafe_path(what: &str) -> StoreError {
    StoreError::UnsafePath(format!(
        "`{what}` is a symlink, reparse point or not a directory"
    ))
}

#[cfg(windows)]
fn is_reparse(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(_meta: &std::fs::Metadata) -> bool {
    false
}

/// `lstat` classification that never follows a link.
pub(crate) fn is_link(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink() || is_reparse(meta)
}

fn check_components(root: &Path, rel: &Path) -> Result<(), StoreError> {
    let mut current = root.to_path_buf();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            return Err(StoreError::UnsafePath("non-normal path component".into()));
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if is_link(&meta) => {
                return Err(unsafe_path(&name.to_string_lossy()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(StoreError::Io(error)),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn owner_only_mode_ok(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o077 == 0
}

/// Clear group/other permission bits on `dir` and everything below it
/// (Unix; a no-op elsewhere). Links are never followed. Children are fixed
/// before their directory, so an interrupted pass leaves `dir` itself still
/// looking loose and [`StorePaths::tighten_repos`] retries it on the next open.
pub(crate) fn make_tree_owner_only(dir: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        fn walk(path: &Path, meta: &std::fs::Metadata) -> io::Result<()> {
            use std::os::unix::fs::PermissionsExt;
            if meta.is_dir() {
                for entry in std::fs::read_dir(path)? {
                    let entry = entry?;
                    let child = entry.path();
                    let child_meta = std::fs::symlink_metadata(&child)?;
                    if child_meta.file_type().is_symlink() {
                        continue;
                    }
                    walk(&child, &child_meta)?;
                }
            } else if !meta.is_file() {
                return Ok(());
            }
            let mode = meta.permissions().mode();
            if mode & 0o077 != 0 {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7700))?;
            }
            Ok(())
        }
        let meta = std::fs::symlink_metadata(dir).map_err(StoreError::Io)?;
        if is_link(&meta) || !meta.is_dir() {
            return Err(unsafe_path("repository"));
        }
        walk(dir, &meta).map_err(StoreError::Io)
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

pub(crate) fn create_private_dir(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        crate::win::create_private_dir(path)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)
    }
}

/// Create `root/<segments...>` one component at a time, owner-only, refusing
/// any existing component that is a link, not a directory, or (Unix)
/// accessible by group/other.
pub(crate) fn ensure_dir(root: &Path, segments: &[&str]) -> Result<PathBuf, StoreError> {
    ensure_dir_observed(root, segments, true, &mut |_| Ok(()))
}

pub(crate) fn ensure_dir_observed(
    root: &Path,
    segments: &[&str],
    sync_existing: bool,
    observer: &mut dyn FnMut(crate::store::OpenStage) -> Result<(), StoreError>,
) -> Result<PathBuf, StoreError> {
    let mut current = root.to_path_buf();
    for segment in segments {
        current.push(segment);
        let mut created_or_raced = false;
        let meta = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                created_or_raced = true;
                match create_private_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(StoreError::Io(error)),
                }
                std::fs::symlink_metadata(&current).map_err(StoreError::Io)?
            }
            Err(error) => return Err(StoreError::Io(error)),
        };
        if is_link(&meta) || !meta.is_dir() {
            return Err(unsafe_path(segment));
        }
        #[cfg(unix)]
        let private = owner_only_mode_ok(&meta);
        #[cfg(windows)]
        let private = crate::win::check_private(&current).map_err(StoreError::Io)?;
        if !private {
            return Err(StoreError::UnsafePath(format!(
                "`{segment}` is accessible by other users"
            )));
        }
        // Ordinary callers still cover interrupted prior creation. Store
        // open batches existing managed entries in one final root sync.
        if sync_existing || created_or_raced {
            sync_dir_observed(
                current.parent().ok_or_else(|| unsafe_path(segment))?,
                observer,
            )?;
        }
    }
    Ok(current)
}

/// Create a new directory exactly once (never adopting an existing one).
pub(crate) fn create_dir_exclusive(paths: &StorePaths, path: &Path) -> Result<(), StoreError> {
    paths.check_no_follow(path)?;
    match create_private_dir(path) {
        Ok(()) => sync_dir(
            path.parent()
                .ok_or_else(|| unsafe_path("directory parent"))?,
        ),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Err(StoreError::Conflict("managed path already exists".into()))
        }
        Err(error) => Err(StoreError::Io(error)),
    }
}

/// `OpenOptions` for a path another user may be able to replace: never
/// follow a final-component link, never block in `open` on a FIFO or device
/// (Unix `O_NONBLOCK | O_NOCTTY`; a regular file ignores `O_NONBLOCK` for
/// I/O, so it needs no clearing once the handle is proven regular), and on
/// Windows open a reparse point itself instead of its target. New files are
/// owner-only (Unix mode 0600).
pub fn no_follow_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    apply_no_follow(&mut options);
    options
}
fn apply_no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
}

/// THE opener for every file whose path may be user-writable (model cache,
/// worker runtime files, store and repository files, CLI config and
/// credentials): `options` (from [`no_follow_options`]) is opened without
/// following a final link or blocking on a FIFO, and the OPENED HANDLE must
/// be a regular file before anyone reads it. Identity and trust checks are
/// the caller's, on this handle's metadata. Intermediate components must
/// already have passed the caller's own chain check.
pub fn open_regular(path: &Path, options: &OpenOptions) -> Result<File, StoreError> {
    let file = options.open(path).map_err(|error| {
        // ELOOP: the final component is a symlink.
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return StoreError::UnsafePath("final path component is a symlink".into());
        }
        StoreError::Io(error)
    })?;
    // The handle's own type: a FIFO, device, directory or reparse point
    // swapped in after any earlier path check is refused here.
    let meta = file.metadata().map_err(StoreError::Io)?;
    if is_link(&meta) || !meta.is_file() {
        return Err(StoreError::UnsafePath("not a regular file".into()));
    }
    Ok(file)
}

/// [`open_regular`] for reading.
pub fn open_regular_read(path: &Path) -> Result<File, StoreError> {
    open_regular(path, no_follow_options().read(true))
}

/// Open a store-owned file ([`open_regular`] with `options`' access mode);
/// on Windows it must also carry an owner-only ACL.
pub(crate) fn open_no_follow(path: &Path, options: &mut OpenOptions) -> Result<File, StoreError> {
    apply_no_follow(options);
    let file = open_regular(path, options)?;
    #[cfg(windows)]
    if !crate::win::check_private_file(&file).map_err(StoreError::Io)? {
        return Err(StoreError::UnsafePath(
            "file is accessible by other users".into(),
        ));
    }
    Ok(file)
}

/// Synchronize directory metadata and underlying storage. Windows uses the
/// documented normal NtFlushBuffersFileEx operation on a writable directory
/// handle; unsupported filesystems and failed barriers propagate errors.
/// The one directory durability barrier: no caller syncs a directory handle
/// itself (`directory_durability_goes_through_one_helper` checks it).
pub fn sync_dir(path: &Path) -> Result<(), StoreError> {
    #[cfg(test)]
    DIRECTORY_SYNCS.with(|syncs| syncs.borrow_mut().push(path.to_path_buf()));
    #[cfg(unix)]
    {
        open_directory(path)?.sync_all().map_err(StoreError::Io)
    }
    #[cfg(windows)]
    {
        crate::win::sync_directory(path).map_err(StoreError::Io)
    }
}

// Thread-local observation covers real recovery barriers without counting
// unrelated parallel fixtures or changing production IO.
#[cfg(test)]
std::thread_local! {
    static DIRECTORY_SYNCS: std::cell::RefCell<Vec<PathBuf>> = const {
        std::cell::RefCell::new(Vec::new())
    };
}

#[cfg(test)]
pub(crate) fn take_directory_syncs() -> Vec<PathBuf> {
    DIRECTORY_SYNCS.with(|syncs| std::mem::take(&mut *syncs.borrow_mut()))
}

/// Pin directory identity without following a final symlink/reparse point.
pub(crate) fn open_directory(path: &Path) -> Result<File, StoreError> {
    let meta = std::fs::symlink_metadata(path).map_err(StoreError::Io)?;
    if is_link(&meta) || !meta.is_dir() {
        return Err(unsafe_path("directory"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS (open a directory) |
        // FILE_FLAG_OPEN_REPARSE_POINT (never follow one).
        options.custom_flags(0x0200_0000 | 0x0020_0000);
    }
    let file = options.open(path).map_err(StoreError::Io)?;
    if is_link(&file.metadata().map_err(StoreError::Io)?) {
        return Err(unsafe_path("directory"));
    }
    Ok(file)
}

pub(crate) fn same_file(a: &File, b: &File) -> Result<bool, StoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let a = a.metadata().map_err(StoreError::Io)?;
        let b = b.metadata().map_err(StoreError::Io)?;
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(windows)]
    {
        Ok(crate::win::file_identity(a).map_err(StoreError::Io)?
            == crate::win::file_identity(b).map_err(StoreError::Io)?)
    }
}

pub(crate) fn sync_dir_observed(
    path: &Path,
    observer: &mut dyn FnMut(crate::store::OpenStage) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    observer(crate::store::OpenStage::SyncDirectory(path.to_path_buf()))?;
    sync_dir(path)
}

#[cfg(all(test, unix))]
mod untrusted_open_tests {
    use super::*;
    /// The one untrusted-path opener never blocks on a FIFO and refuses it
    /// (and links, directories) on the opened handle, for reads and for
    /// read-write lock opens alike.
    #[test]
    fn fifos_links_and_directories_are_refused_without_blocking() {
        let root = std::env::temp_dir().join(format!(
            "kb-open-regular-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        std::fs::create_dir(&root).expect("root");
        let fifo = root.join("fifo");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .expect("mkfifo")
                .success()
        );
        std::os::unix::fs::symlink(root.join("target"), root.join("link")).expect("link");
        std::fs::write(root.join("target"), b"x").expect("target");
        let (tx, rx) = std::sync::mpsc::channel();
        let paths = [fifo.clone(), root.join("link"), root.clone()];
        let worker_paths = paths.clone();
        std::thread::spawn(move || {
            for path in &worker_paths {
                let read = open_regular_read(path).is_err();
                let write =
                    open_no_follow(path, OpenOptions::new().read(true).write(true)).is_err();
                tx.send(read && write).expect("result");
            }
        });
        for path in &paths {
            assert!(
                rx.recv_timeout(std::time::Duration::from_secs(5))
                    .expect("never blocks"),
                "{} refused",
                path.display()
            );
        }
        assert!(open_regular_read(&root.join("target")).is_ok());
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}

#[cfg(test)]
mod directory_durability_tests {
    /// Review r2 #1: a directory handle opened read-only cannot be a
    /// durability barrier on Windows, so every directory sync goes through
    /// [`super::sync_dir`]; nothing else opens a directory and syncs it.
    #[test]
    fn directory_durability_goes_through_one_helper() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut offenders = vec![];
        for dir in [
            root.join("src"),
            root.join("../../src"),
            root.join("../../src/commands"),
        ] {
            for entry in std::fs::read_dir(&dir).expect("sources").flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|e| e != "rs") || path.ends_with("paths.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("source");
                // A handle bound from `open_directory(..)` and synced later.
                for line in text.lines().filter(|l| l.contains("open_directory(")) {
                    if let Some(rest) = line.trim_start().strip_prefix("let ") {
                        let name = rest
                            .trim_start_matches("mut ")
                            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                            .next()
                            .unwrap_or_default();
                        if !name.is_empty() && text.contains(&format!("{name}.sync_all()")) {
                            offenders.push(format!("{}: {name}", path.display()));
                        }
                    }
                }
                let mut at = 0;
                while let Some(found) = text[at..].find(".sync_all()") {
                    let end = at + found;
                    let start = text[..end]
                        .char_indices()
                        .rev()
                        .nth(400)
                        .map_or(0, |(i, _)| i);
                    let before = &text[start..end];
                    // The statement that produced the synced handle.
                    let statement = before.rsplit(';').next().unwrap_or(before);
                    if statement.contains("open_directory(") || statement.contains("O_DIRECTORY") {
                        offenders.push(format!("{}", path.display()));
                    }
                    at = end + 1;
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "sync directories through paths::sync_dir: {offenders:?}"
        );
    }
}
