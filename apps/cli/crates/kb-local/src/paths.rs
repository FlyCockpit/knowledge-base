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

/// Initialization stages for bounded crash/fault tests.
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenStage {
    SyncState,
    BeforePublish,
    SyncDirectory(PathBuf),
}

/// The effective user ID, read from a file this process just created (no FFI).
#[cfg(unix)]
pub(crate) fn own_uid() -> Result<u32, StoreError> {
    use std::os::unix::fs::MetadataExt;
    static UID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    if let Some(uid) = UID.get() {
        return Ok(*uid);
    }
    // Linux: /proc/self belongs to the effective user; no write needed.
    #[cfg(target_os = "linux")]
    if let Ok(meta) = std::fs::metadata("/proc/self") {
        return Ok(*UID.get_or_init(|| meta.uid()));
    }
    let path = std::env::temp_dir().join(format!(".kb-uid-{}", crate::state::new_uuid_v4()?));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(StoreError::Io)?;
    let uid = file.metadata().map_err(StoreError::Io)?.uid();
    let _ = std::fs::remove_file(&path);
    Ok(*UID.get_or_init(|| uid))
}

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
        observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
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

/// Most symlinks one [`resolve_entry_path`] call follows.
#[cfg(unix)]
const MAX_ENTRY_LINKS: usize = 40;

/// Resolve an entry-point path to its canonical spelling, once: `--root` (and
/// every store root passed to [`crate::Store::open`] /
/// [`crate::Store::open_existing`]) and the CLI's environment-derived data,
/// cache and runtime directories (`HOME`, XDG, `KB_DATA_DIR`). Callers keep
/// the returned path for every later open, lock, rename and fsync and run
/// their strict checks on it; nothing below re-resolves it.
///
/// Unix: a symlink is followed only if no user but root can have made or
/// changed it: the link is owned by uid 0, and every directory from `/` down
/// to the one holding it is owned by uid 0 and not group- or other-writable
/// (a sticky world-writable directory such as `/tmp` does not qualify). This
/// admits system links such as macOS `/var` → `private/var` and `/tmp` →
/// `private/tmp`, Fedora Atomic `/home` → `var/home` and `/var/run` → `../run`,
/// and refuses every link another user could create or replace. Links inside
/// a link's target obey the same rule; at most 40 are
/// followed. A dangling link is refused. The existing part of the path is
/// resolved; a missing tail is appended as written (it may not contain `..`)
/// and is created later by callers that refuse links.
///
/// Windows: no link is trusted. A symlink, junction or other reparse point in
/// the existing part of the path is refused; that part is then canonicalized
/// (the verbatim spelling the store and its Git layer compare). Residual race,
/// as for the no-follow walk below the store root: a junction swapped in
/// between the walk and the canonicalization needs write access to a
/// directory of the user's own path, which already defeats every per-use
/// check.
pub fn resolve_entry_path(path: &Path) -> Result<PathBuf, StoreError> {
    resolve_entry_path_with(path, &EntryTrust::ROOT)
}

/// Who may own the links and directories [`resolve_entry_path`] follows.
struct EntryTrust<'a> {
    /// uid 0, plus this uid (tests: the current user, who cannot create
    /// root-owned links).
    #[cfg_attr(not(unix), allow(dead_code))]
    uid: u32,
    /// Tests only: directories at or above this path count as root-controlled
    /// (a test cannot make its temporary root's ancestors so).
    #[cfg_attr(not(unix), allow(dead_code))]
    assume_controlled: Option<&'a Path>,
}

impl EntryTrust<'_> {
    const ROOT: EntryTrust<'static> = EntryTrust {
        uid: 0,
        assume_controlled: None,
    };
}

fn resolve_entry_path_with(path: &Path, trust: &EntryTrust<'_>) -> Result<PathBuf, StoreError> {
    if path.as_os_str().is_empty() {
        return Err(StoreError::UnsafePath("empty path".into()));
    }
    let absolute = std::path::absolute(path).map_err(StoreError::Io)?;
    resolve_absolute(path, &absolute, trust)
}

fn entry_refusal(input: &Path, why: String) -> StoreError {
    StoreError::UnsafePath(format!("`{}`: {why}", input.display()))
}

#[cfg(unix)]
fn resolve_absolute(
    input: &Path,
    absolute: &Path,
    trust: &EntryTrust<'_>,
) -> Result<PathBuf, StoreError> {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    enum Part {
        Parent,
        Name(OsString),
        /// A trailing `/` or `/.`: what precedes must be a directory.
        Directory,
    }
    // Reversed, so `pop` yields the next component. `spelled` is the path as
    // written (`std::path::absolute` drops a trailing `/`).
    fn parts(path: &Path, spelled: &Path) -> Vec<Part> {
        let bytes = spelled.as_os_str().as_bytes();
        let trailing = [b"/".as_slice(), b"/."]
            .iter()
            .any(|end| bytes.ends_with(end));
        let mut parts: Vec<Part> = path
            .components()
            .filter_map(|component| match component {
                Component::ParentDir => Some(Part::Parent),
                Component::Normal(name) => Some(Part::Name(name.to_owned())),
                Component::RootDir | Component::CurDir | Component::Prefix(_) => None,
            })
            .collect();
        if trailing {
            parts.push(Part::Directory);
        }
        parts.reverse();
        parts
    }
    let trusted_uid = |uid: u32| uid == 0 || uid == trust.uid;
    // `resolved` never contains a link: each component was `lstat`ed as a
    // non-link, or is a link's resolution.
    let mut resolved = PathBuf::from("/");
    let mut pending = parts(absolute, input);
    // `pending[floor..]` came from link targets, `pending[..floor]` from `input`.
    let mut floor = usize::MAX;
    let mut links = 0;
    let mut missing = false;
    while let Some(part) = pending.pop() {
        let from_link = pending.len() >= floor;
        let name = match part {
            Part::Parent if missing => {
                return Err(entry_refusal(
                    input,
                    "`..` follows a component that does not exist".into(),
                ));
            }
            Part::Directory if missing => continue,
            Part::Directory => {
                // As the kernel requires: a searchable directory, not a file.
                std::fs::symlink_metadata(resolved.join(".")).map_err(StoreError::Io)?;
                continue;
            }
            Part::Parent => {
                // `resolved` is canonical, so its parent is the real `..`,
                // once `..` is valid here: a searchable directory (as the
                // kernel requires; not a file).
                std::fs::symlink_metadata(resolved.join(".")).map_err(StoreError::Io)?;
                resolved.pop();
                continue;
            }
            Part::Name(name) => name,
        };
        let candidate = resolved.join(&name);
        if missing {
            resolved = candidate;
            continue;
        }
        let meta = match std::fs::symlink_metadata(&candidate) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound && from_link => {
                return Err(entry_refusal(
                    input,
                    format!(
                        "a symlink on the path points to `{}`, which does not exist",
                        candidate.display()
                    ),
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing = true;
                resolved = candidate;
                continue;
            }
            Err(error) => return Err(StoreError::Io(error)),
        };
        if !meta.file_type().is_symlink() {
            resolved = candidate;
            continue;
        }
        links += 1;
        if links > MAX_ENTRY_LINKS {
            return Err(entry_refusal(
                input,
                "too many levels of symbolic links".into(),
            ));
        }
        if !trusted_uid(meta.uid()) {
            return Err(entry_refusal(
                input,
                format!(
                    "`{}` is a symlink not owned by root; use the path it points to",
                    candidate.display()
                ),
            ));
        }
        // Nearest first, so a refusal names the directory closest to the link.
        for dir in resolved.ancestors() {
            if trust
                .assume_controlled
                .is_some_and(|controlled| controlled.starts_with(dir))
            {
                break;
            }
            let dir_meta = std::fs::symlink_metadata(dir).map_err(StoreError::Io)?;
            if !dir_meta.is_dir() || !trusted_uid(dir_meta.uid()) || dir_meta.mode() & 0o022 != 0 {
                return Err(entry_refusal(
                    input,
                    format!(
                        "the symlink `{}` is below `{}`, which is not a root-owned directory only root can write; use the path it points to",
                        candidate.display(),
                        dir.display()
                    ),
                ));
            }
        }
        let target = std::fs::read_link(&candidate).map_err(StoreError::Io)?;
        if target.is_absolute() {
            resolved = PathBuf::from("/");
        }
        floor = floor.min(pending.len());
        pending.extend(parts(&target, &target));
    }
    Ok(resolved)
}

#[cfg(windows)]
fn resolve_absolute(
    input: &Path,
    absolute: &Path,
    _trust: &EntryTrust<'_>,
) -> Result<PathBuf, StoreError> {
    // `std::path::absolute` already removed `.` and `..` lexically (the
    // Windows path semantics) without following anything.
    let mut existing = PathBuf::new();
    let mut tail = Vec::new();
    for component in absolute.components() {
        if !tail.is_empty() {
            match component {
                Component::Normal(name) => tail.push(name.to_owned()),
                _ => {
                    return Err(entry_refusal(
                        input,
                        "unexpected component after a missing one".into(),
                    ));
                }
            }
            continue;
        }
        existing.push(component);
        let Component::Normal(name) = component else {
            continue;
        };
        match std::fs::symlink_metadata(&existing) {
            Ok(meta) if is_link(&meta) => {
                return Err(entry_refusal(
                    input,
                    format!(
                        "`{}` is a symlink, junction or reparse point; use the path it points to",
                        existing.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                existing.pop();
                tail.push(name.to_owned());
            }
            Err(error) => return Err(StoreError::Io(error)),
        }
    }
    let mut resolved = existing.canonicalize().map_err(StoreError::Io)?;
    resolved.extend(tail);
    Ok(resolved)
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
    observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
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
    // A file this open creates takes the token's default owner: the user.
    #[cfg(windows)]
    crate::win::user_owns_new_objects().map_err(StoreError::Io)?;
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

/// Windows: give `path` the CLI credential store's owner-only shape (this
/// user as owner, a protected DACL with one full-control entry for this user).
#[cfg(windows)]
pub fn make_owner_only(path: &Path, directory: bool) -> Result<(), StoreError> {
    crate::win::make_owner_only(path, directory).map_err(StoreError::Io)
}

/// Windows: whether `path` (never followed) has exactly that shape.
#[cfg(windows)]
pub fn is_owner_only(path: &Path) -> Result<bool, StoreError> {
    crate::win::is_owner_only(path).map_err(StoreError::Io)
}

/// Flush a regular file `file` opened no-follow from `path` (fsync; on
/// Windows a write-capable handle to the same file, see `win::sync_file`,
/// because Git's objects are read-only there).
pub(crate) fn sync_file(file: &File, path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        let _ = path;
        file.sync_all().map_err(StoreError::Io)
    }
    #[cfg(windows)]
    {
        crate::win::sync_file(file, path).map_err(StoreError::Io)
    }
}

/// [`sync_dir`] for an existing ancestor outside the managed tree (the
/// parents of a store root or credential directory, through the volume
/// root). Unix fsyncs it like any directory. Windows flushes it when this
/// user may add entries to it and otherwise has nothing of ours to persist
/// there (see `win::sync_ancestor_directory`); a standard user cannot open
/// `C:\Users` for flushing.
pub fn sync_ancestor_dir(path: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        sync_dir(path)
    }
    #[cfg(windows)]
    {
        #[cfg(test)]
        DIRECTORY_SYNCS.with(|syncs| syncs.borrow_mut().push(path.to_path_buf()));
        crate::win::sync_ancestor_directory(path).map_err(StoreError::Io)
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
    observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    observer(OpenStage::SyncDirectory(path.to_path_buf()))?;
    sync_dir(path)
}

/// [`sync_ancestor_dir`] with the open-stage observer.
pub(crate) fn sync_ancestor_dir_observed(
    path: &Path,
    observer: &mut dyn FnMut(OpenStage) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    observer(OpenStage::SyncDirectory(path.to_path_buf()))?;
    sync_ancestor_dir(path)
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
    /// A directory handle opened read-only cannot be a
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

#[cfg(all(test, unix))]
#[allow(
    clippy::print_stderr,
    reason = "a test that cannot run on this system prints why it skipped"
)]
mod entry_path_tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    /// A private canonical directory per test (the resolver under test is
    /// not used to make it).
    struct Base(PathBuf);
    impl Base {
        fn new(tag: &str) -> Self {
            let parent = std::env::temp_dir().canonicalize().expect("temp root");
            let path = parent.join(format!(
                "kb-entry-{tag}-{}",
                crate::state::new_uuid_v4().expect("uuid")
            ));
            std::fs::create_dir(&path).expect("base");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                .expect("private base");
            Self(path)
        }
        fn dir(&self, rel: &str, mode: u32) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(&path).expect("dir");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("mode");
            path
        }
        /// Trust the current user's links and directories below the base,
        /// and the temporary root above it as given.
        fn trust(&self) -> EntryTrust<'_> {
            EntryTrust {
                uid: own_uid(),
                assume_controlled: self.0.parent(),
            }
        }
    }
    impl Drop for Base {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn own_uid() -> u32 {
        super::own_uid().expect("uid")
    }

    fn refusal(result: Result<PathBuf, StoreError>) -> String {
        match result {
            Err(StoreError::UnsafePath(message)) => message,
            other => panic!("expected an unsafe-path refusal, got {other:?}"),
        }
    }

    /// The real root-owned system links of this OS: macOS has `/var` and
    /// `/tmp`; merged-/usr Linux has `/bin`, `/sbin`, `/lib`; most Linux
    /// systems have `/var/run`.
    fn system_links() -> Vec<PathBuf> {
        use std::os::unix::fs::MetadataExt;
        [
            "/var",
            "/tmp",
            "/etc",
            "/bin",
            "/sbin",
            "/lib",
            "/var/run",
            "/var/lock",
        ]
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| {
            std::fs::symlink_metadata(path)
                .is_ok_and(|meta| meta.file_type().is_symlink() && meta.uid() == 0)
        })
        .collect()
    }

    #[test]
    fn root_owned_system_links_resolve_to_their_canonical_path() {
        let links = system_links();
        #[cfg(target_os = "macos")]
        assert!(
            links.contains(&PathBuf::from("/var")) && links.contains(&PathBuf::from("/tmp")),
            "macOS has the root-owned /var and /tmp links: {links:?}"
        );
        if links.is_empty() {
            eprintln!("skipped: this system has no root-owned symlink at a well-known path");
            return;
        }
        for link in links {
            let canonical = link.canonicalize().expect("canonical");
            assert_ne!(canonical, link);
            assert_eq!(resolve_entry_path(&link).expect("system link"), canonical);
            // A missing tail below the link is kept as written.
            let name = format!(
                "kb-entry-missing-{}",
                crate::state::new_uuid_v4().expect("uuid")
            );
            assert!(!canonical.join(&name).exists());
            assert_eq!(
                resolve_entry_path(&link.join(&name).join("store")).expect("missing tail"),
                canonical.join(&name).join("store")
            );
        }
    }

    #[test]
    fn macos_user_temp_root_under_var_resolves() {
        // Real users' TMPDIR is `/var/folders/…/T/`, behind the root-owned
        // `/var` link.
        let temp = std::env::temp_dir();
        if !temp.starts_with("/var/folders") {
            eprintln!(
                "skipped: TMPDIR `{}` is not under /var/folders",
                temp.display()
            );
            return;
        }
        assert_eq!(
            resolve_entry_path(&temp).expect("temp root"),
            temp.canonicalize().expect("canonical")
        );
    }

    #[test]
    fn plain_paths_are_normalized_and_relative_paths_are_absolute() {
        let base = Base::new("plain");
        let dir = base.dir("a/b", 0o700);
        let spelled = base.0.join("a/./b/../b");
        assert_eq!(resolve_entry_path(&spelled).expect("plain"), dir);
        let relative = resolve_entry_path(Path::new("kb-entry-relative")).expect("relative");
        assert_eq!(
            relative,
            resolve_entry_path(&std::env::current_dir().expect("cwd"))
                .expect("cwd")
                .join("kb-entry-relative")
        );
        assert!(refusal(resolve_entry_path(Path::new(""))).contains("empty path"));
        let after_missing = base.0.join("missing/../a");
        assert!(refusal(resolve_entry_path(&after_missing)).contains("does not exist"));
        // `..` is only valid after a searchable directory, as for the kernel.
        std::fs::write(base.0.join("file"), b"x").expect("file");
        let after_file = resolve_entry_path(&base.0.join("file/../a")).expect_err("ENOTDIR");
        assert!(
            matches!(&after_file, StoreError::Io(e) if e.raw_os_error() == Some(libc::ENOTDIR)),
            "{after_file:?}"
        );
        // A trailing `/` or `/.` requires a directory, as for the kernel.
        for spelled in ["file/", "file/."] {
            let error = resolve_entry_path(Path::new(&format!("{}/{spelled}", base.0.display())))
                .expect_err("trailing slash after a file");
            assert!(
                matches!(&error, StoreError::Io(e) if e.raw_os_error() == Some(libc::ENOTDIR)),
                "{spelled}: {error:?}"
            );
        }
        assert_eq!(
            resolve_entry_path(Path::new(&format!("{}/a/b/", base.0.display()))).expect("dir/"),
            dir
        );
        if own_uid() != 0 {
            let closed = base.dir("closed", 0o700);
            std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o600))
                .expect("unsearchable");
            let after_closed = resolve_entry_path(&closed.join("../a")).expect_err("EACCES");
            std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o700))
                .expect("restore");
            assert!(
                matches!(&after_closed, StoreError::Io(e) if e.kind() == io::ErrorKind::PermissionDenied),
                "{after_closed:?}"
            );
        }
    }

    #[test]
    fn user_owned_link_is_refused() {
        if own_uid() == 0 {
            eprintln!("skipped: running as root, so every link is root-owned");
            return;
        }
        let base = Base::new("user-link");
        let real = base.dir("real", 0o700);
        let link = base.0.join("link");
        symlink(&real, &link).expect("link");
        let message = refusal(resolve_entry_path(&link.join("store")));
        assert!(message.contains("not owned by root"), "{message}");
        assert!(message.contains(&link.display().to_string()), "{message}");
    }

    #[test]
    fn trusted_link_in_a_controlled_chain_resolves_with_nested_and_relative_targets() {
        // The test seam trusts the current user, so a link like a system one
        // can be built under the temporary root.
        let base = Base::new("trusted");
        let real = base.dir("real/inner", 0o700);
        base.dir("links", 0o755);
        // links/a -> ../real (relative), links/b -> <abs>/links/a/inner (nested)
        symlink("../real", base.0.join("links/a")).expect("a");
        symlink(base.0.join("links/a/inner"), base.0.join("links/b")).expect("b");
        let trust = base.trust();
        assert_eq!(
            resolve_entry_path_with(&base.0.join("links/b/new"), &trust).expect("nested"),
            real.join("new")
        );
        assert_eq!(
            resolve_entry_path_with(&base.0.join("links/a/inner/../inner"), &trust)
                .expect("dot-dot after a link is the target's parent"),
            real
        );
    }

    #[test]
    fn link_in_a_sticky_world_writable_directory_is_refused() {
        let base = Base::new("sticky");
        let sticky = base.dir("sticky", 0o1777);
        let real = base.dir("real", 0o700);
        symlink(&real, sticky.join("link")).expect("link");
        let message = refusal(resolve_entry_path_with(
            &sticky.join("link/store"),
            &base.trust(),
        ));
        assert!(
            message.contains(&format!(
                "`{}`, which is not a root-owned",
                sticky.display()
            )),
            "{message}"
        );
    }

    #[test]
    fn link_in_a_group_writable_parent_or_ancestor_is_refused() {
        let base = Base::new("group");
        let real = base.dir("real", 0o700);
        let group = base.dir("group", 0o770);
        symlink(&real, group.join("link")).expect("link");
        let message = refusal(resolve_entry_path_with(&group.join("link"), &base.trust()));
        assert!(
            message.contains(&format!("`{}`, which is not a root-owned", group.display())),
            "{message}"
        );
        // Checked recursively: a private parent below a group-writable
        // ancestor does not make the link trustworthy.
        let ancestor = base.dir("ancestor", 0o775);
        let parent = base.dir("ancestor/private", 0o700);
        symlink(&real, parent.join("link")).expect("nested link");
        let message = refusal(resolve_entry_path_with(&parent.join("link"), &base.trust()));
        assert!(
            message.contains(&format!(
                "`{}`, which is not a root-owned",
                ancestor.display()
            )),
            "{message}"
        );
    }

    #[test]
    fn dangling_and_looping_links_are_refused() {
        let base = Base::new("dangling");
        base.dir("links", 0o755);
        let dangling = base.0.join("links/dangling");
        symlink(base.0.join("nowhere"), &dangling).expect("dangling");
        let message = refusal(resolve_entry_path_with(
            &dangling.join("store"),
            &base.trust(),
        ));
        assert!(message.contains("does not exist"), "{message}");
        symlink("b", base.0.join("links/a")).expect("a");
        symlink("a", base.0.join("links/b")).expect("b");
        let message = refusal(resolve_entry_path_with(
            &base.0.join("links/a"),
            &base.trust(),
        ));
        assert!(message.contains("too many levels"), "{message}");
    }
}
