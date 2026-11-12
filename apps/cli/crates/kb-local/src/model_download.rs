//! One per-user, checksum-verified model cache shared by every store.
//!
//! Pinned public HTTPS downloads, bounded streaming/hash and an exclusive,
//! no-replace publication (`<name>.<uuid>.partial` -> hard link).
//!
//! THE trust rule: native code only ever parses an inode this CLI created
//! itself, in the owner-only `verified/` directory of the private cache
//! (`O_EXCL`, owner-only from creation), filled from the stream it hashed.
//! Permissions say nothing about descriptors someone opened earlier, so a
//! file we did not create (the configured `models_dir`, another program's
//! directory, an adopted file, a legacy download) is never loaded in place:
//! it is copied into `verified/` while hashing, then reused by identity.
//!
//! Downloads and adoptions always publish into the private `verified/`
//! directory. A configured `models_dir` is only a source; neither downloads
//! nor removal modify it. Removal records owner intent in the private cache,
//! so a retained source cannot be silently copied back by ordinary loads.
use crate::{
    StoreError,
    egress::{Dns, NativeDns, is_public, unavailable},
    paths::{is_link, sync_dir},
    qwen::{ModelDescriptor, data, descriptor},
};
use ring::digest::{Context, SHA256};
use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
pub fn validate_hop(raw: &str) -> Result<reqwest::Url, StoreError> {
    let u = reqwest::Url::parse(raw).map_err(|_| unavailable())?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.port_or_known_default() != Some(443)
        || !data()?
            .download_hosts
            .iter()
            .any(|h| Some(h.as_str()) == u.host_str())
    {
        return Err(unavailable());
    }
    Ok(u)
}
pub fn validate_addresses(ips: &[IpAddr]) -> Result<IpAddr, StoreError> {
    if ips.is_empty() || ips.iter().any(|ip| !is_public(*ip)) {
        return Err(unavailable());
    }
    Ok(ips[0])
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
fn model_error(why: impl Into<String>) -> StoreError {
    StoreError::Explained(kb_client::ErrorCode::IndexUnavailable, why.into())
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
    if let Ok(meta) = fs::metadata("/proc/self") {
        return Ok(*UID.get_or_init(|| meta.uid()));
    }
    let path = std::env::temp_dir().join(format!(".kb-uid-{}", crate::state::new_uuid_v4()?));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(StoreError::Io)?;
    let uid = file.metadata().map_err(StoreError::Io)?.uid();
    let _ = fs::remove_file(&path);
    Ok(*UID.get_or_init(|| uid))
}

/// A file or directory llama.cpp may load in place after a checksum: not a
/// link, owned by this user (or root) and writable by nobody else (Unix:
/// no group/other write bit; Windows: an owner-only ACL). Anything else could
/// be rewritten between the hash and the load, or while it is mapped.
fn check_trusted(path: &Path, meta: &fs::Metadata, dir: bool) -> Result<(), StoreError> {
    if is_link(meta) || (dir && !meta.is_dir()) || (!dir && !meta.is_file()) {
        return Err(StoreError::UnsafePath(format!(
            "model cache: `{}` is a link or not a regular {}",
            path.display(),
            if dir { "directory" } else { "file" }
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let uid = meta.uid();
        if (uid != own_uid()? && uid != 0) || meta.permissions().mode() & 0o022 != 0 {
            return Err(StoreError::UnsafePath(format!(
                "model cache: `{}` is writable by or owned by another user",
                path.display()
            )));
        }
    }
    #[cfg(windows)]
    if !crate::win::check_private(path).map_err(StoreError::Io)? {
        return Err(StoreError::UnsafePath(format!(
            "model cache: `{}` is accessible by other users",
            path.display()
        )));
    }
    Ok(())
}

/// Every directory from the root to `dir` can only be changed by this user
/// (or root): nobody else can rename or replace an entry along the path.
/// A root-owned sticky directory (`/tmp`) protects other users' entries.
fn check_trusted_chain(dir: &Path) -> Result<(), StoreError> {
    // Callers retain this exact canonical spelling for all subsequent opens.
    // Re-canonicalizing here could validate a different lookup chain from the
    // one the native loader will use. Check root first, without following links.
    let ancestors: Vec<_> = dir.ancestors().collect();
    for ancestor in ancestors.into_iter().rev() {
        let meta = fs::symlink_metadata(ancestor).map_err(StoreError::Io)?;
        if is_link(&meta) || !meta.is_dir() {
            return Err(StoreError::UnsafePath(format!(
                "model cache: `{}` is a link or not a directory",
                ancestor.display()
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let uid = own_uid()?;
            let mode = meta.permissions().mode();
            let owner_ok = meta.uid() == uid || meta.uid() == 0;
            let shared = mode & 0o022 != 0;
            let sticky_root = mode & 0o1000 != 0 && meta.uid() == 0;
            if !owner_ok || (shared && !sticky_root) {
                return Err(StoreError::UnsafePath(format!(
                    "model cache: `{}` can be changed by another user",
                    ancestor.display()
                )));
            }
        }
        #[cfg(windows)]
        if !crate::win::check_directory_integrity(ancestor).map_err(StoreError::Io)? {
            return Err(StoreError::UnsafePath(format!(
                "model cache: `{}` can be changed by another user",
                ancestor.display()
            )));
        }
    }
    Ok(())
}

/// What identifies the exact bytes behind a path, and the permissions
/// guarding them, between two checks. On Unix the inode change time moves
/// with every write, `chmod`, `chown` and link change, so a file whose trust
/// was changed (even and back) is a different artifact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactId {
    size: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    uid: u32,
}
impl ArtifactId {
    fn of(meta: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            size: meta.len(),
            modified: meta.modified().ok(),
            #[cfg(unix)]
            dev: meta.dev(),
            #[cfg(unix)]
            ino: meta.ino(),
            #[cfg(unix)]
            changed: (meta.ctime(), meta.ctime_nsec()),
            #[cfg(unix)]
            mode: meta.mode(),
            #[cfg(unix)]
            uid: meta.uid(),
        }
    }
}
/// One cached model file as found by a cheap stat (no hashing): the file
/// and its full trust result. Equal artifacts are the same bytes under the
/// same protection; the worker keys a resident model on this (ROOT B).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    pub path: PathBuf,
    pub id: ArtifactId,
    /// The CLI's own copy in `verified/` (created there, owner-only from
    /// creation) whose protection still holds (Unix mode/owner and directory
    /// chain, Windows ACL): it may be hashed and loaded in place. Never true
    /// for a file the CLI did not create.
    pub trusted: bool,
}
/// A verified artifact ready for the native load, holding the per-model
/// fence: no removal or publication runs until the load has finished and
/// this is dropped.
pub struct PreparedLoad {
    pub artifact: Artifact,
    _fence: CacheLock,
}
/// A model held in memory, keyed on the artifact a request found at load
/// time (path, identity and full trust result) and the artifact actually
/// loaded (the same, or its verified private copy). A request whose freshly
/// resolved artifact matches neither (a replaced file, a changed mode,
/// directory chain or ACL) must not be served by it (ROOT B).
pub struct Resident<T> {
    model_id: String,
    found: Artifact,
    loaded: Artifact,
    pub value: T,
}
impl<T> Resident<T> {
    pub fn new(model_id: &str, found: &Artifact, loaded: &Artifact, value: T) -> Self {
        Self {
            model_id: model_id.to_owned(),
            found: found.clone(),
            loaded: loaded.clone(),
            value,
        }
    }
    pub fn serves(&self, model_id: &str, found: &Artifact) -> bool {
        self.model_id == model_id && (*found == self.found || *found == self.loaded)
    }
}
impl std::fmt::Debug for PreparedLoad {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.artifact.fmt(f)
    }
}
impl std::ops::Deref for PreparedLoad {
    type Target = Artifact;
    fn deref(&self) -> &Artifact {
        &self.artifact
    }
}

impl Artifact {
    /// The path still names exactly the bytes that were verified.
    pub fn still_current(&self) -> bool {
        fs::symlink_metadata(&self.path).is_ok_and(|meta| ArtifactId::of(&meta) == self.id)
    }
}

/// Every cache read goes through the one untrusted-path opener: no link
/// followed, no blocking open on a FIFO swapped in after `resolve`, and a
/// regular file proven on the handle before any byte is read.
fn open_no_follow_read(path: &Path) -> Result<File, StoreError> {
    crate::paths::open_regular_read(path)
}

fn open_trusted(path: &Path) -> Result<File, StoreError> {
    let file = open_no_follow_read(path)?;
    check_trusted(path, &file.metadata().map_err(StoreError::Io)?, false)?;
    Ok(file)
}

/// Hash an open handle; `Some((size, hex))` unless it exceeds `max` bytes.
/// `sink` receives every chunk (a private copy is written from these bytes).
fn hash_handle(
    file: &mut File,
    max: u64,
    sink: &mut dyn FnMut(&[u8]) -> Result<(), StoreError>,
) -> Result<Option<(u64, String)>, StoreError> {
    let mut hash = Context::new(&SHA256);
    let mut b = vec![0; 1 << 20];
    let mut bytes = 0;
    loop {
        let n = file.read(&mut b).map_err(StoreError::Io)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > max {
            return Ok(None);
        }
        hash.update(&b[..n]);
        sink(&b[..n])?;
    }
    Ok(Some((bytes, hex(hash.finish().as_ref()))))
}

/// `Ok(false)` = missing, wrong size or wrong hash; never trusted by name.
/// The file itself must be writable only by this user.
pub fn verify_artifact(path: &Path, m: &ModelDescriptor) -> Result<bool, StoreError> {
    let info = match fs::symlink_metadata(path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(StoreError::Io(e)),
    };
    if is_link(&info) || !info.is_file() || info.len() != m.size_bytes {
        return Ok(false);
    }
    let mut file = open_trusted(path)?;
    Ok(hash_handle(&mut file, m.size_bytes, &mut |_| Ok(()))?
        .is_some_and(|(n, h)| n == m.size_bytes && h == m.sha256))
}

/// What the cache holds for one model, without hashing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CachedFile {
    Missing,
    /// Expected name and size; checksum not yet checked.
    Present,
    /// Same name, wrong size or not a regular file.
    Mismatch,
}
/// Result of a full checksum check.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verification {
    Missing,
    Verified,
    Mismatch,
}

/// What [`ModelCache::remove_quiesced`] deleted, and what it left.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Removal {
    pub removed: Vec<PathBuf>,
    /// Model files `kb` left in place, each with the reason.
    pub kept: Vec<Kept>,
}
/// A model file `kb model remove` left in place, and why (review #1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Kept {
    pub path: PathBuf,
    pub reason: KeptReason,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeptReason {
    /// In the user's configured `models_dir`: `kb` only ever reads it.
    ModelsDir,
}
impl KeptReason {
    pub fn why(self) -> &'static str {
        match self {
            Self::ModelsDir => {
                "it is in your models_dir, which `kb` only reads and never deletes from"
            }
        }
    }
}

/// The per-user model directory. All stores and the shared embedding worker
/// read weights only from here. `dir` is where downloads go (the configured
/// `models_dir`, possibly another program's directory); `private` is this
/// user's owner-only cache, where a verified copy of any file that is not
/// safe to load in place is kept. They are the same directory by default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelCache {
    dir: PathBuf,
    private: PathBuf,
}
struct Partial {
    path: PathBuf,
    file: File,
}
impl Drop for Partial {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
/// Held while one process publishes into the cache.
pub struct CacheLock(#[allow(dead_code)] File);

fn absolute(dir: &Path) -> Result<(), StoreError> {
    if dir.is_absolute() {
        Ok(())
    } else {
        Err(StoreError::InvalidArgument(format!(
            "model directory `{}` must be an absolute path",
            dir.display()
        )))
    }
}

impl ModelCache {
    /// An absolute directory; it is created (owner-only) on first download.
    pub fn new(dir: PathBuf) -> Result<Self, StoreError> {
        absolute(&dir)?;
        Ok(Self {
            private: dir.clone(),
            dir,
        })
    }
    /// `dir` plus a separate owner-only cache for verified private copies.
    pub fn with_private(dir: PathBuf, private: PathBuf) -> Result<Self, StoreError> {
        absolute(&dir)?;
        absolute(&private)?;
        Ok(Self { dir, private })
    }
    pub fn dir(&self) -> &Path {
        &self.dir
    }
    pub fn private_dir(&self) -> &Path {
        &self.private
    }
    fn file_name(m: &ModelDescriptor) -> Result<&str, StoreError> {
        // File names come only from the checked-in registry.
        if descriptor(&m.model_id)?.file_name != m.file_name
            || m.file_name.contains(['/', '\\'])
            || m.file_name.starts_with('.')
        {
            return Err(unavailable());
        }
        Ok(&m.file_name)
    }
    pub fn file(&self, m: &ModelDescriptor) -> Result<PathBuf, StoreError> {
        Ok(self.dir.join(Self::file_name(m)?))
    }
    /// Where verified private copies live: an owner-only `verified`
    /// directory inside the private cache, distinct from every configured
    /// file even when the configured and private directories are the same.
    fn copies_dir(&self) -> PathBuf {
        self.private.join("verified")
    }
    /// The verified private copy of `m` (it may not exist).
    pub fn private_copy(&self, m: &ModelDescriptor) -> Result<PathBuf, StoreError> {
        Ok(self.copies_dir().join(Self::file_name(m)?))
    }
    fn private_file(&self, m: &ModelDescriptor) -> Result<Option<PathBuf>, StoreError> {
        self.private_copy(m).map(Some)
    }
    /// The download directory exists and is trusted; `Ok(false)` when it is
    /// absent. A configured path may itself be a symlink the user chose.
    pub fn check_dir(&self) -> Result<bool, StoreError> {
        check_dir_at(&self.dir)
    }
    fn removed_path(&self, m: &ModelDescriptor) -> Result<PathBuf, StoreError> {
        Ok(self
            .private
            .join(format!(".{}.removed", Self::file_name(m)?)))
    }
    fn was_removed(&self, m: &ModelDescriptor) -> Result<bool, StoreError> {
        match fs::symlink_metadata(self.removed_path(m)?) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(StoreError::Io(e)),
        }
    }
    fn allow_model(&self, m: &ModelDescriptor) -> Result<(), StoreError> {
        match fs::remove_file(self.removed_path(m)?) {
            Ok(()) => sync_dir(&self.private),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError::Io(e)),
        }
    }
    fn require_not_removed(&self, m: &ModelDescriptor) -> Result<(), StoreError> {
        if self.was_removed(m)? {
            return Err(model_error(format!(
                "model `{}` was removed; run `kb model enable {}` or `kb model download {}` to use it again",
                m.model_id, m.model_id, m.model_id
            )));
        }
        Ok(())
    }
    /// Cheap status (name and size only), private copy included.
    pub fn cached(&self, m: &ModelDescriptor) -> Result<CachedFile, StoreError> {
        Ok(self.cached_file(m)?.0)
    }
    /// [`ModelCache::cached`] with the file it describes: the copy a load
    /// would find first, the mismatching file, or (missing) the configured
    /// download path.
    pub fn cached_file(&self, m: &ModelDescriptor) -> Result<(CachedFile, PathBuf), StoreError> {
        let mut status = (CachedFile::Missing, self.file(m)?);
        if self.was_removed(m)? {
            return Ok(status);
        }
        for path in self.private_file(m)?.into_iter().chain([self.file(m)?]) {
            match fs::symlink_metadata(&path) {
                Ok(meta) if !is_link(&meta) && meta.is_file() && meta.len() == m.size_bytes => {
                    return Ok((CachedFile::Present, path));
                }
                Ok(_) if status.0 == CachedFile::Missing => status = (CachedFile::Mismatch, path),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
        }
        Ok(status)
    }
    /// Find the file a load would use, by a cheap stat: the private copy
    /// first, then the download directory. Never trusted by name alone.
    pub fn resolve(&self, m: &ModelDescriptor) -> Result<Artifact, StoreError> {
        self.require_not_removed(m)?;
        let mut mismatch = None;
        for path in self.private_file(m)?.into_iter().chain([self.file(m)?]) {
            // Resolve directory aliases once and KEEP that spelling. A symlink
            // in a writable directory must never redirect the later native open.
            let parent = path.parent().ok_or_else(unavailable)?;
            let parent = match parent.canonicalize() {
                Ok(parent) => parent,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(StoreError::Io(e)),
            };
            let path = parent.join(Self::file_name(m)?);
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(StoreError::Io(e)),
            };
            if is_link(&meta) || !meta.is_file() || meta.len() != m.size_bytes {
                mismatch = Some(path);
                continue;
            }
            // Only an inode we created, untouched since, loads in place (THE
            // rule): its creation mark must match. Location proves nothing.
            let owned = open_no_follow_read(&path).is_ok_and(|f| self.is_created(m, &path, &f));
            let trusted = owned
                && check_trusted(&path, &meta, false).is_ok()
                && check_trusted_chain(&parent).is_ok();
            return Ok(Artifact {
                id: ArtifactId::of(&meta),
                path,
                trusted,
            });
        }
        Err(match mismatch {
            Some(path) => self.mismatch(m, &path),
            None => model_error(format!(
                "model `{}` is not downloaded; run `kb model download {}`",
                m.model_id, m.model_id
            )),
        })
    }
    fn mismatch(&self, m: &ModelDescriptor, path: &Path) -> StoreError {
        model_error(format!(
            "cached model file `{}` fails its size/SHA-256 check; run `kb model remove {} --yes` and download it again",
            path.display(),
            m.model_id
        ))
    }
    /// The bytes a native load will parse, verified on the handle that read
    /// them. Only our own copy in `verified/` is hashed in place (its
    /// identity rechecked; nobody else ever held it open); any other file is
    /// copied, from the very bytes hashed, into a fresh owner-only inode in
    /// `verified/` and loaded from there.
    ///
    /// The returned guard keeps the per-model fence: the caller loads while
    /// holding it, so removal and publication wait for the load (ROOT B).
    pub fn prepare_load(
        &self,
        m: &ModelDescriptor,
        found: &Artifact,
    ) -> Result<PreparedLoad, StoreError> {
        // The source is opened and identified INSIDE the same fence as removal
        // and every publisher. An old handle must not republish an unlinked file.
        let mutation = self.mutation_lock(m)?;
        self.require_not_removed(m)?;
        let mut file = open_no_follow_read(&found.path)?;
        let opened = file.metadata().map_err(StoreError::Io)?;
        if ArtifactId::of(&opened) != found.id {
            return Err(model_error(format!(
                "model file `{}` changed while it was being verified",
                found.path.display()
            )));
        }
        // The mark is rechecked on the very handle that is hashed.
        let owned = self.is_created(m, &found.path, &file);
        if found.trusted && owned {
            check_trusted_chain(found.path.parent().ok_or_else(unavailable)?)?;
            check_trusted(&found.path, &opened, false)?;
            let ok = hash_handle(&mut file, m.size_bytes, &mut |_| Ok(()))?
                .is_some_and(|(n, h)| n == m.size_bytes && h == m.sha256);
            let now = fs::symlink_metadata(&found.path).map_err(StoreError::Io)?;
            if !ok {
                return Err(self.mismatch(m, &found.path));
            }
            if ArtifactId::of(&now) != found.id {
                return Err(model_error(format!(
                    "model file `{}` changed while it was being verified",
                    found.path.display()
                )));
            }
            return Ok(PreparedLoad {
                artifact: found.clone(),
                _fence: mutation,
            });
        }
        // Not our inode (or no longer protected): never load it; copy the
        // verified bytes into a fresh inode of ours.
        let copies = self.ensure_copies_dir()?;
        let private = copies.canonicalize().map_err(StoreError::Io)?;
        check_trusted_chain(&private)?;
        let _lock = lock_at(&private)?;
        let dest = private.join(Self::file_name(m)?);
        let (mut temp, _) = partial_at(&private, m)?;
        let ok = hash_handle(&mut file, m.size_bytes, &mut |chunk| {
            temp.file.write_all(chunk).map_err(StoreError::Io)
        })?
        .is_some_and(|(n, h)| n == m.size_bytes && h == m.sha256);
        if !ok {
            return Err(self.mismatch(m, &found.path));
        }
        // A copy already there failed its mark (or is the source itself): it
        // is replaced by the fresh inode filled from the stream just hashed.
        // Only in `kb`'s own, proven `verified/` (review r2 #1/#3).
        self.delete_in_copies(m)?;
        finish_at(&private, m, &temp, &dest, &|| self.mismatch(m, &dest))?;
        // Unlinking the partial changes the copy's link count (and ctime):
        // mark and identify the copy only once it is final.
        drop(temp);
        self.record_created(m, &dest)?;
        let meta = fs::symlink_metadata(&dest).map_err(StoreError::Io)?;
        check_trusted(&dest, &meta, false)?;
        Ok(PreparedLoad {
            artifact: Artifact {
                id: ArtifactId::of(&meta),
                path: dest,
                trusted: true,
            },
            _fence: mutation,
        })
    }
    /// Full size + SHA-256 check of the file a load would use.
    pub fn verify(&self, m: &ModelDescriptor) -> Result<Verification, StoreError> {
        Ok(self.verify_file(m)?.0)
    }
    /// [`ModelCache::verify`] with the path of the file actually inspected
    /// (#5: the private copy when a load would use it, not the configured
    /// source).
    pub fn verify_file(&self, m: &ModelDescriptor) -> Result<(Verification, PathBuf), StoreError> {
        let found = match self.resolve(m) {
            Ok(found) => found,
            Err(_) => {
                return Ok(match self.cached_file(m)? {
                    (CachedFile::Missing, path) => (Verification::Missing, path),
                    (_, path) => (Verification::Mismatch, path),
                });
            }
        };
        let mut file = open_no_follow_read(&found.path)?;
        let result = match hash_handle(&mut file, m.size_bytes, &mut |_| Ok(()))? {
            Some((n, h)) if n == m.size_bytes && h == m.sha256 => Verification::Verified,
            _ => Verification::Mismatch,
        };
        Ok((result, found.path))
    }
    /// A verified, loadable path (resolve + prepare_load).
    pub fn verified_path(&self, m: &ModelDescriptor) -> Result<PathBuf, StoreError> {
        let found = self.resolve(m)?;
        Ok(self.prepare_load(m, &found)?.artifact.path)
    }
    /// Remove one model, private copy included. `Ok(false)` if nothing was
    /// deleted (absent, or only another program's file was there).
    pub fn remove(&self, m: &ModelDescriptor) -> Result<bool, StoreError> {
        Ok(!self.remove_quiesced(m, &mut || Ok(()))?.removed.is_empty())
    }
    /// [`ModelCache::remove`], calling `quiesce` (resident loaders must
    /// confirm they released the model) after taking the per-model fence and
    /// before any deletion: a load can neither start nor finish until
    /// deletion is done, and a failed `quiesce` deletes nothing.
    ///
    /// R3-L9: only files `kb` created are deleted: the private copy in
    /// `verified/`, and a file in the configured directory whose inode `kb`
    /// created there (even if it changed since). Another program's file in
    /// `models_dir` is left in place and reported as kept.
    pub fn remove_quiesced(
        &self,
        m: &ModelDescriptor,
        quiesce: &mut dyn FnMut() -> Result<(), StoreError>,
    ) -> Result<Removal, StoreError> {
        let _mutation = self.mutation_lock(m)?;
        // Nothing is deleted unless every loader confirmed the release.
        quiesce()?;
        // Durable owner intent precedes deletion, so even a crash cannot
        // silently adopt a kept models_dir source on the next search.
        let marker = crate::paths::open_regular(
            &self.removed_path(m)?,
            crate::paths::no_follow_options().write(true).create(true),
        )?;
        marker.sync_all().map_err(StoreError::Io)?;
        sync_dir(&self.private)?;
        let mut removal = Removal::default();
        if let Some(path) = self.delete_in_copies(m)? {
            removal.removed.push(path);
        }
        // Review #1: `models_dir` is only a source; whatever is there stays.
        let source = self.file(m)?;
        if source != self.private_copy(m)? && fs::symlink_metadata(&source).is_ok() {
            removal.kept.push(Kept {
                path: source,
                reason: KeptReason::ModelsDir,
            });
        }
        Ok(removal)
    }
    /// Simulate an explicit download's publication of `path` (tests seed
    /// sparse fixtures), including clearing a prior removal's owner intent.
    #[doc(hidden)]
    pub fn record_created_for_tests(
        &self,
        m: &ModelDescriptor,
        path: &Path,
    ) -> Result<(), StoreError> {
        let _mutation = self.mutation_lock(m)?;
        self.record_created(m, path)?;
        self.allow_model(m)
    }
    /// Where `kb` records the identity of the `verified/` directory it
    /// created (in the private cache, beside it).
    fn copies_dir_mark(&self) -> PathBuf {
        self.private.join(".verified-dir.mark")
    }
    /// The identity of an opened directory: Unix device and inode, Windows
    /// file ID.
    fn dir_identity(dir: &File) -> Result<String, StoreError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let meta = dir.metadata().map_err(StoreError::Io)?;
            Ok(format!("{} {}", meta.dev(), meta.ino()))
        }
        #[cfg(windows)]
        {
            Ok(format!(
                "{:?}",
                crate::win::file_identity(dir).map_err(StoreError::Io)?
            ))
        }
    }
    /// Publish a new directory only after its identity proof is durable.
    /// The cache-wide initializer lock precedes any publication lock and is
    /// shared across models (whose mutation locks alone cannot serialize it).
    fn ensure_copies_dir(&self) -> Result<PathBuf, StoreError> {
        self.ensure_copies_dir_observed(&mut |_| Ok(()))
    }
    fn ensure_copies_dir_observed(
        &self,
        observe: &mut dyn FnMut(&'static str) -> Result<(), StoreError>,
    ) -> Result<PathBuf, StoreError> {
        let copies = self.copies_dir();
        ensure_dir_at(&self.private)?;
        let private = self.private.canonicalize().map_err(StoreError::Io)?;
        check_trusted_chain(&private)?;
        let _initialization = acquire_lock(&private.join(".verified-dir.lock"))?;
        if self.open_copies_dir()?.is_some() {
            // Also finishes an interrupted final rename's directory barrier.
            sync_dir(&self.private)?;
            return Ok(copies);
        }

        // This reserved, empty staging directory makes every interruption
        // resumable, including one before any identity marker was written.
        // Never adopt an unmarked directory at the public `verified/` name.
        let staged = private.join(".verified-dir.staging");
        ensure_dir_at(&staged)?;
        observe("stage-created")?;
        check_trusted_chain(&staged)?;
        if fs::read_dir(&staged)
            .map_err(StoreError::Io)?
            .next()
            .transpose()
            .map_err(StoreError::Io)?
            .is_some()
        {
            return Err(StoreError::UnsafePath(
                "model cache initialization directory is not empty; remove it by hand".into(),
            ));
        }
        sync_dir(&staged)?;
        sync_dir(&self.private)?;
        observe("staged")?;
        let identity = Self::dir_identity(&crate::paths::open_directory(&staged)?)?;
        let mark = self.copies_dir_mark();
        let temp = self.private.join(".verified-dir.mark-partial");
        {
            let mut file = crate::paths::open_regular(
                &temp,
                crate::paths::no_follow_options()
                    .write(true)
                    .create(true)
                    .truncate(true),
            )?;
            file.write_all(identity.as_bytes())
                .map_err(StoreError::Io)?;
            observe("marker-written")?;
            file.sync_all().map_err(StoreError::Io)?;
        }
        observe("marker-synced")?;
        fs::rename(&temp, &mark).map_err(StoreError::Io)?;
        observe("marker-renamed")?;
        sync_dir(&self.private)?;
        observe("marker-published")?;
        fs::rename(&staged, &copies).map_err(StoreError::Io)?;
        observe("directory-renamed")?;
        sync_dir(&self.private)?;
        observe("directory-published")?;
        // Use the same proof check as removal before handing out this path.
        self.open_copies_dir()?.ok_or_else(unavailable)?;
        Ok(copies)
    }
    /// Review r2 #1/#3: `kb`'s private `verified/`, opened once without
    /// following links, its whole chain changeable by nobody but this user,
    /// and proven to be the directory `kb` created (its identity equals the
    /// recorded one), so it was never redirected or swapped. Everything in
    /// it is `kb`'s. `None` when it does not exist.
    fn open_copies_dir(&self) -> Result<Option<(File, PathBuf)>, StoreError> {
        let real = match self.private.canonicalize() {
            Ok(private) => private.join("verified"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(StoreError::Io(e)),
        };
        match fs::symlink_metadata(&real) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(StoreError::Io(e)),
            Ok(_) => {}
        }
        check_trusted_chain(&real)?;
        let dir = crate::paths::open_directory(&real)?;
        let recorded = crate::paths::open_regular_read(
            &real
                .parent()
                .ok_or_else(unavailable)?
                .join(".verified-dir.mark"),
        )
        .ok()
        .and_then(|f| {
            let mut text = String::new();
            f.take(256).read_to_string(&mut text).ok().map(|_| text)
        });
        if recorded.as_deref() != Some(Self::dir_identity(&dir)?.as_str()) {
            return Err(StoreError::UnsafePath(format!(
                "model cache: `{}` is not the private model cache `kb` created; nothing was deleted (remove it by hand)",
                real.display()
            )));
        }
        Ok(Some((dir, real)))
    }
    /// Review r2 #1/#3: delete `kb`'s copy of `m` by name in its own private
    /// `verified/` (the only place `kb` ever deletes a model file from;
    /// `models_dir` is only read). The directory is the provenance proof
    /// ([`ModelCache::open_copies_dir`]); the per-file creation mark only
    /// decides whether native code may load a file in place.
    ///
    /// Threat model: the directory and its whole chain are owner-only and
    /// proven to be the one `kb` created, so only processes of this same
    /// user can change entries in it, and such a process could delete the
    /// file itself anyway; another user can neither redirect nor swap it.
    /// The caller holds the per-model fence.
    fn delete_in_copies(&self, m: &ModelDescriptor) -> Result<Option<PathBuf>, StoreError> {
        let name = Self::file_name(m)?;
        let Some((dir, real)) = self.open_copies_dir()? else {
            return Ok(None);
        };
        // By name relative to the opened directory (its descriptor on Linux).
        #[cfg(target_os = "linux")]
        let target = {
            use std::os::fd::AsRawFd;
            PathBuf::from(format!("/proc/self/fd/{}/{name}", dir.as_raw_fd()))
        };
        #[cfg(not(target_os = "linux"))]
        let target = {
            let _ = &dir;
            real.join(name)
        };
        match fs::symlink_metadata(&target) {
            Ok(meta) if is_link(&meta) || !meta.is_file() => {
                return Err(StoreError::UnsafePath(format!(
                    "model cache: `{}` is not a regular file; remove it by hand",
                    real.join(name).display()
                )));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(StoreError::Io(e)),
        }
        fs::remove_file(&target).map_err(StoreError::Io)?;
        self.forget_mark(m, &self.private_copy(m)?)?;
        drop(dir);
        sync_dir(&real)?;
        Ok(Some(real.join(name)))
    }
    /// One publisher at a time in the publication directory
    /// ([`Self::publish_dir`]); waits up to five seconds.
    pub fn lock(&self) -> Result<CacheLock, StoreError> {
        lock_at(&self.publish_dir()?)
    }
    /// The configured directory's lock (removal takes it to delete a source).
    pub fn source_lock(&self) -> Result<CacheLock, StoreError> {
        lock_at(&self.dir)
    }
    /// Create the configured directory and `verified/` with their
    /// platform privacy (tests seed fixtures into them).
    pub fn ensure_dirs(&self) -> Result<(), StoreError> {
        ensure_dir_at(&self.dir)?;
        self.ensure_copies_dir().map(|_| ())
    }
    /// One per-user, per-model fence spans BOTH configured and private copies.
    /// Always acquire it before any directory publication/recovery lock.
    fn mutation_lock(&self, m: &ModelDescriptor) -> Result<CacheLock, StoreError> {
        ensure_dir_at(&self.private)?;
        let private = self.private.canonicalize().map_err(StoreError::Io)?;
        check_trusted_chain(&private)?;
        acquire_lock(&private.join(format!(".{}.mutation.lock", Self::file_name(m)?)))
    }
    /// Where publications (downloads, adoptions) create our own inode:
    /// always the private `verified/` directory. A configured `models_dir`
    /// is only ever read: a source that is copied in, never written to or
    /// deleted from (review #1).
    pub fn publish_dir(&self) -> Result<PathBuf, StoreError> {
        self.ensure_copies_dir()
    }
    /// Where the creation mark of our inode at `path` is kept: one per
    /// location (the copy in `verified/`, or a publication into the
    /// configured directory), in the owner-only `verified/` directory.
    fn mark_path(&self, m: &ModelDescriptor, path: &Path) -> Result<PathBuf, StoreError> {
        let location = if self.in_copies(path) {
            "copy"
        } else {
            "published"
        };
        Ok(self
            .copies_dir()
            .join(format!(".{}.{location}.mark", Self::file_name(m)?)))
    }
    fn in_copies(&self, path: &Path) -> bool {
        let parent = path.parent().and_then(|p| p.canonicalize().ok());
        self.copies_dir()
            .canonicalize()
            .is_ok_and(|c| Some(c) == parent)
    }
    /// THE provenance proof (closed world: no mark, no trust). Taken from the
    /// open handle of an inode the CLI just created and finished: Unix dev,
    /// inode, size, mtime, ctime, mode and owner; Windows file ID, size,
    /// mtime, ChangeTime and an owner-only DACL. Any chmod, ACL change or
    /// write (even through a descriptor opened while the file was loosened)
    /// moves ctime/ChangeTime, so such a file never matches again.
    fn creation_mark(path: &Path, file: &File) -> Result<String, StoreError> {
        let meta = file.metadata().map_err(StoreError::Io)?;
        let nanos = |t: std::io::Result<std::time::SystemTime>| {
            t.ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos())
        };
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            format!(
                "{} {} {}.{} {:o} {}",
                meta.dev(),
                meta.ino(),
                meta.ctime(),
                meta.ctime_nsec(),
                meta.mode(),
                meta.uid()
            )
        };
        #[cfg(windows)]
        let identity = {
            if !crate::win::check_private_file(file).map_err(StoreError::Io)? {
                return Err(StoreError::UnsafePath(format!(
                    "model cache: `{}` is accessible by other users",
                    path.display()
                )));
            }
            format!(
                "{:?} {} private",
                crate::win::file_identity(file).map_err(StoreError::Io)?,
                crate::win::file_change_time(file).map_err(StoreError::Io)?
            )
        };
        Ok(format!(
            "2 {} {} {identity}\n{}",
            meta.len(),
            nanos(meta.modified()),
            path.display()
        ))
    }
    /// Record the inode we just created at `dest` (after every link/unlink of
    /// ours, which also move ctime) as ours.
    fn record_created(&self, m: &ModelDescriptor, dest: &Path) -> Result<(), StoreError> {
        let copies = self.ensure_copies_dir()?;
        let mark = Self::creation_mark(dest, &open_no_follow_read(dest)?)?;
        let temp = copies.join(format!(
            ".{}.{}.mark-partial",
            Self::file_name(m)?,
            crate::state::new_uuid_v4()?
        ));
        {
            let mut file = crate::paths::open_regular(
                &temp,
                crate::paths::no_follow_options()
                    .write(true)
                    .create_new(true),
            )?;
            file.write_all(mark.as_bytes()).map_err(StoreError::Io)?;
            file.sync_all().map_err(StoreError::Io)?;
        }
        fs::rename(&temp, self.mark_path(m, dest)?).map_err(StoreError::Io)?;
        sync_dir(&copies)
    }
    /// The open `file` at `path` is exactly the inode we created there,
    /// untouched since: its current mark equals the recorded one. Anything
    /// missing or unreadable is "no" (closed world).
    fn is_created(&self, m: &ModelDescriptor, path: &Path, file: &File) -> bool {
        let Ok(record) = self.mark_path(m, path) else {
            return false;
        };
        let Ok(handle) = crate::paths::open_regular_read(&record) else {
            return false;
        };
        let mut text = String::new();
        if handle.take(8192).read_to_string(&mut text).is_err() {
            return false;
        }
        Self::creation_mark(path, file).is_ok_and(|mark| mark == text)
    }
    fn forget_mark(&self, m: &ModelDescriptor, path: &Path) -> Result<(), StoreError> {
        match fs::remove_file(self.mark_path(m, path)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError::Io(e)),
        }
    }
    fn partial(&self, m: &ModelDescriptor) -> Result<(Partial, PathBuf), StoreError> {
        partial_at(&self.publish_dir()?, m)
    }
    fn conflict(&self, m: &ModelDescriptor, dest: &Path) -> StoreError {
        model_error(format!(
            "cached model file `{}` fails its size/SHA-256 check; run `kb model remove {} --yes` to delete it, then download again",
            dest.display(),
            m.model_id
        ))
    }
    /// Publish bytes from a trusted host reader (tests, adoption).
    pub fn publish_reader(
        &self,
        m: &ModelDescriptor,
        input: impl Read,
    ) -> Result<PathBuf, StoreError> {
        let _mutation = self.mutation_lock(m)?;
        let path = self.publish_reader_locked(m, input)?;
        self.allow_model(m)?;
        Ok(path)
    }
    fn publish_reader_locked(
        &self,
        m: &ModelDescriptor,
        mut input: impl Read,
    ) -> Result<PathBuf, StoreError> {
        let _lock = lock_at(&self.publish_dir()?)?;
        let (mut temp, dest) = self.partial(m)?;
        if fs::symlink_metadata(&dest).is_ok() {
            // An existing file we did not create is never adopted as ours:
            // it stays a source that loads are copied from.
            if verify_artifact(&dest, m)? {
                return Ok(dest);
            }
            return Err(self.conflict(m, &dest));
        }
        let mut bytes = 0;
        let mut b = vec![0; 1 << 16];
        loop {
            let n = input.read(&mut b).map_err(StoreError::Io)?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            if bytes > m.size_bytes {
                return Err(model_error("model input is larger than the pinned size"));
            }
            temp.file.write_all(&b[..n]).map_err(StoreError::Io)?;
        }
        if bytes != m.size_bytes {
            return Err(model_error("model input does not match the pinned size"));
        }
        finish_at(
            dest.parent().ok_or_else(unavailable)?,
            m,
            &temp,
            &dest,
            &|| self.conflict(m, &dest),
        )?;
        // The partial is unlinked before the mark is taken.
        drop(temp);
        self.record_created(m, &dest)?;
        Ok(dest)
    }
    /// Copy a file (e.g. old per-store weights, or a group-writable shared
    /// copy) into the cache; the copied bytes themselves are verified.
    pub fn adopt(&self, m: &ModelDescriptor, path: &Path) -> Result<PathBuf, StoreError> {
        let _mutation = self.mutation_lock(m)?;
        let copied = self.publish_reader_locked(m, open_no_follow_read(path)?)?;
        self.allow_model(m)?;
        Ok(copied)
    }
    /// Download (or reuse) one pinned model. `progress(done, total)` is
    /// called after every received chunk.
    pub async fn download(
        &self,
        m: &ModelDescriptor,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<PathBuf, StoreError> {
        let _mutation = self.mutation_lock(m)?;
        // This is an explicit owner request to use the model again.
        self.allow_model(m)?;
        // Already present anywhere a load would look (the shared directory
        // or the private copy) with the pinned bytes: nothing to download.
        if let Ok(found) = self.resolve(m)
            && self.verify(m)? == Verification::Verified
        {
            return self.publish_reader_locked(m, open_no_follow_read(&found.path)?);
        }
        // A load checks the private copy first. One of ours that fails its
        // checksum (same size, damaged bytes) would keep shadowing a fresh
        // download, so download and load disagree on the file: it goes now,
        // with the same provenance proof as `kb model remove` (review #1).
        let copy = self.private_copy(m)?;
        if let Ok(meta) = fs::symlink_metadata(&copy)
            && !is_link(&meta)
            && meta.is_file()
            && !verify_artifact(&copy, m)?
        {
            self.delete_in_copies(m)?;
            // The configured file may verify: then it is what loads now.
            if let Ok(found) = self.resolve(m)
                && self.verify(m)? == Verification::Verified
            {
                return self.publish_reader_locked(m, open_no_follow_read(&found.path)?);
            }
        }
        // Downloads always create our own inode in private `verified/`;
        // the configured directory remains a read-only source (THE rule).
        let target = &self.publish_dir()?;
        let _lock = lock_at(target)?;
        let dest = target.join(Self::file_name(m)?);
        if fs::symlink_metadata(&dest).is_ok() {
            // Never destroy possibly user-owned bytes to make room.
            if verify_artifact(&dest, m)? {
                return Ok(dest);
            }
            return Err(self.conflict(m, &dest));
        }
        let (mut temp, dest) = partial_at(target, m)?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let net = |why: &str| model_error(format!("downloading `{}` failed: {why}", m.model_id));
        let operation = async {
            let mut url = validate_hop(&m.url)?;
            for hop in 0..=data()?.max_redirects {
                let host = url.host_str().ok_or_else(unavailable)?.to_owned();
                let ips =
                    tokio::time::timeout(Duration::from_secs(30), NativeDns.resolve(&host, 443))
                        .await
                        .map_err(|_| net("DNS timed out"))?
                        .map_err(|_| net("DNS lookup failed"))?;
                let ip = validate_addresses(&ips)
                    .map_err(|_| net("the download host resolved to a non-public address"))?;
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .referer(false)
                    .resolve(&host, SocketAddr::new(ip, 443))
                    .connect_timeout(Duration::from_secs(30))
                    .build()
                    .map_err(|_| unavailable())?;
                let mut reply = tokio::time::timeout(
                    Duration::from_secs(30),
                    client
                        .get(url.clone())
                        .header("accept-encoding", "identity")
                        .send(),
                )
                .await
                .map_err(|_| net("the connection timed out"))?
                .map_err(|_| net("the connection failed"))?;
                if matches!(reply.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                    if hop == data()?.max_redirects {
                        return Err(net("too many redirects"));
                    }
                    let target = reply
                        .headers()
                        .get("location")
                        .and_then(|h| h.to_str().ok())
                        .ok_or_else(|| net("a redirect had no location"))?;
                    url = validate_hop(url.join(target).map_err(|_| unavailable())?.as_str())
                        .map_err(|_| net("redirected to a host outside the allowlist"))?;
                    continue;
                }
                if reply.status() != 200 {
                    return Err(net(&format!("HTTP status {}", reply.status().as_u16())));
                }
                if reply.content_length().is_some_and(|n| n != m.size_bytes) {
                    return Err(net("the server reported an unexpected size"));
                }
                let mut bytes = 0;
                progress(0, m.size_bytes);
                while let Some(chunk) = tokio::time::timeout(Duration::from_secs(60), reply.chunk())
                    .await
                    .map_err(|_| net("no data for 60 seconds"))?
                    .map_err(|_| net("the transfer was interrupted"))?
                {
                    bytes += chunk.len() as u64;
                    if bytes > m.size_bytes {
                        return Err(net("more bytes than the pinned size"));
                    }
                    temp.file.write_all(&chunk).map_err(StoreError::Io)?;
                    progress(bytes, m.size_bytes);
                }
                if bytes != m.size_bytes {
                    return Err(net("fewer bytes than the pinned size"));
                }
                finish_at(target, m, &temp, &dest, &|| self.conflict(m, &dest))?;
                // The partial is unlinked before the mark is taken.
                drop(temp);
                self.record_created(m, &dest)?;
                return Ok(dest);
            }
            Err(net("too many redirects"))
        };
        tokio::time::timeout(Duration::from_secs(3600), operation)
            .await
            .map_err(|_| net("the one-hour download deadline passed"))?
    }
}

fn check_dir_at(dir: &Path) -> Result<bool, StoreError> {
    match fs::metadata(dir) {
        Ok(meta) => check_trusted(dir, &meta, true).map(|()| true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(StoreError::Io(e)),
    }
}
fn ensure_dir_at(dir: &Path) -> Result<(), StoreError> {
    if check_dir_at(dir)? {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir).map_err(StoreError::Io)?;
    #[cfg(windows)]
    crate::win::make_private(dir).map_err(StoreError::Io)?;
    if !check_dir_at(dir)? {
        return Err(model_error("model directory could not be created"));
    }
    Ok(())
}
/// One publisher per directory at a time; waits up to five seconds.
fn lock_at(dir: &Path) -> Result<CacheLock, StoreError> {
    ensure_dir_at(dir)?;
    let path = dir.join(".kb-model-cache.lock");
    let lock = acquire_lock(&path)?;
    recover_partials_locked(dir)?;
    Ok(lock)
}
fn acquire_lock(path: &Path) -> Result<CacheLock, StoreError> {
    acquire_lock_until(path, Instant::now() + Duration::from_secs(5))
}
fn acquire_lock_until(path: &Path, deadline: Instant) -> Result<CacheLock, StoreError> {
    let file = crate::paths::open_regular(
        path,
        crate::paths::no_follow_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false),
    )?;
    check_trusted(path, &file.metadata().map_err(StoreError::Io)?, false)?;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(fs::TryLockError::WouldBlock) => {
                return Err(model_error(
                    "another `kb` process is downloading or removing a model; retry when it finishes",
                ));
            }
            Err(fs::TryLockError::Error(e)) => return Err(StoreError::Io(e)),
        }
    }
    Ok(CacheLock(file))
}
/// Under the directory lock no publisher is live: every registry-named
/// partial regular file of ours is abandoned scratch.
fn recover_partials_locked(dir: &Path) -> Result<(), StoreError> {
    let models = data()?.models;
    for entry in fs::read_dir(dir).map_err(StoreError::Io)? {
        let entry = entry.map_err(StoreError::Io)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let ours = models.iter().any(|m| {
            name.strip_prefix(&format!(".{}.", m.file_name))
                .and_then(|v| v.strip_suffix(".partial"))
                .is_some_and(|v| {
                    v.as_bytes().get(14) == Some(&b'4') && kb_client::types::Uuid::parse(v).is_ok()
                })
        });
        if !ours {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(StoreError::Io)?;
        if check_trusted(&path, &meta, false).is_err() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // A partial hard-linked elsewhere is not only ours.
            if meta.nlink() != 1 {
                continue;
            }
        }
        fs::remove_file(&path).map_err(StoreError::Io)?;
    }
    Ok(())
}
fn partial_at(dir: &Path, m: &ModelDescriptor) -> Result<(Partial, PathBuf), StoreError> {
    let dest = dir.join(ModelCache::file_name(m)?);
    let path = dir.join(format!(
        ".{}.{}.partial",
        m.file_name,
        crate::state::new_uuid_v4()?
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    let file = options.open(&path).map_err(StoreError::Io)?;
    Ok((Partial { path, file }, dest))
}
fn finish_at(
    dir: &Path,
    m: &ModelDescriptor,
    temp: &Partial,
    dest: &Path,
    conflict: &dyn Fn() -> StoreError,
) -> Result<(), StoreError> {
    temp.file.sync_all().map_err(StoreError::Io)?;
    if !verify_artifact(&temp.path, m)? {
        return Err(model_error(format!(
            "downloaded bytes of `{}` fail the pinned SHA-256 check",
            m.model_id
        )));
    }
    // hard_link is an atomic no-replace publication on supported filesystems.
    match fs::hard_link(&temp.path, dest) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if !verify_artifact(dest, m)? {
                return Err(conflict());
            }
        }
        Err(e) => return Err(StoreError::Io(e)),
    }
    sync_dir(dir)
}

#[cfg(test)]
mod initialization_tests {
    use super::*;

    struct CacheFixture(PathBuf);
    impl CacheFixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "kb-cache-init-{}",
                crate::state::new_uuid_v4().expect("uuid")
            )))
        }
        fn cache(&self) -> ModelCache {
            ModelCache::new(self.0.clone()).expect("cache")
        }
    }
    impl Drop for CacheFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn model() -> ModelDescriptor {
        let mut m = descriptor("embeddinggemma-2-q8_0").expect("model");
        m.size_bytes = 3;
        m.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
        m
    }

    #[test]
    fn copies_initialization_resumes_at_every_publication_boundary() {
        for interrupted in [
            "stage-created",
            "staged",
            "marker-written",
            "marker-synced",
            "marker-renamed",
            "marker-published",
            "directory-renamed",
            "directory-published",
        ] {
            let fixture = CacheFixture::new();
            let cache = fixture.cache();
            let result = cache.ensure_copies_dir_observed(&mut |stage| {
                if matches!(stage, "marker-renamed" | "directory-renamed") {
                    crate::paths::take_directory_syncs();
                }
                if matches!(stage, "marker-published" | "directory-published") {
                    assert!(crate::paths::take_directory_syncs().contains(&cache.private));
                }
                if stage == "marker-published" {
                    assert!(!cache.copies_dir().exists());
                    let staged = cache.private.join(".verified-dir.staging");
                    assert_eq!(
                        fs::read_to_string(cache.copies_dir_mark()).expect("durable marker"),
                        ModelCache::dir_identity(
                            &crate::paths::open_directory(&staged).expect("staged directory")
                        )
                        .expect("identity")
                    );
                }
                if stage == interrupted {
                    Err(StoreError::Io(std::io::Error::other(
                        "interrupted initialization",
                    )))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err(), "{interrupted}");
            // A new process has no in-memory knowledge of the interruption.
            let retry = fixture.cache();
            retry.ensure_copies_dir().expect("resume initialization");
            assert!(retry.open_copies_dir().expect("ownership proof").is_some());
            assert!(!retry.private.join(".verified-dir.staging").exists());
            assert!(!retry.private.join(".verified-dir.mark-partial").exists());
            retry
                .publish_reader(&model(), std::io::Cursor::new(b"abc"))
                .expect("download after retry");
            assert!(retry.remove(&model()).expect("normal removal after retry"));
        }
    }

    #[test]
    fn copies_initialization_refuses_an_unmarked_final_directory() {
        let fixture = CacheFixture::new();
        let cache = fixture.cache();
        ensure_dir_at(&cache.copies_dir()).expect("pre-existing directory");
        let kept = cache.copies_dir().join("keep");
        fs::write(&kept, b"user data").expect("file");
        assert!(matches!(
            cache.ensure_copies_dir(),
            Err(StoreError::UnsafePath(_))
        ));
        assert_eq!(fs::read(kept).expect("untouched"), b"user data");
        assert!(!cache.copies_dir_mark().exists());
    }

    #[test]
    fn copies_initialization_is_serialized_across_models() {
        let fixture = CacheFixture::new();
        let cache = fixture.cache();
        let models = data().expect("registry").models;
        std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for m in models {
                let cache = &cache;
                workers.push(scope.spawn(move || {
                    // Per-model locks deliberately differ between workers.
                    let _mutation = cache.mutation_lock(&m).expect("model fence");
                    cache.ensure_copies_dir().expect("shared initialization")
                }));
            }
            for worker in workers {
                assert_eq!(worker.join().expect("initializer"), cache.copies_dir());
            }
        });
        assert!(cache.open_copies_dir().expect("one identity").is_some());
    }
}
