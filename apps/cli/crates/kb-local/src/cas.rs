//! Immutable SHA256 CAS. No replacing rename on any platform, no GC.
use crate::{
    StoreError, StorePaths, locks,
    mime::validate_media,
    paths::{ensure_dir, open_no_follow, sync_dir},
    state::new_uuid_v4,
};
use kb_client::types::{ContentHash, Mime};
use ring::digest::{Context, SHA256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

pub const ASSET_MAX_BYTES: u64 = 25 * 1024 * 1024;
#[derive(Debug)]
pub struct PublishedBlob {
    pub path: PathBuf,
    pub hash: ContentHash,
    pub size: u64,
    pub mime: Mime,
    pub new_bytes: bool,
}

pub fn blob_path(paths: &StorePaths, hash: &ContentHash) -> PathBuf {
    let hex = &hash.as_str()[7..];
    paths
        .assets_dir()
        .join("objects")
        .join(&hex[..2])
        .join(&hex[2..])
}

struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Read to EOF with a hard cap, including the extra byte detecting an append.
pub(crate) fn verified_bytes(
    file: &mut File,
    hash: &ContentHash,
    size: u64,
) -> Result<Vec<u8>, StoreError> {
    if file.metadata().map_err(StoreError::Io)?.len() != size {
        return Err(storage());
    }
    file.seek(SeekFrom::Start(0)).map_err(StoreError::Io)?;
    let mut bytes = Vec::new();
    file.take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(StoreError::Io)?;
    if bytes.len() as u64 != size || kb_client::snapshot::content_hash(&bytes) != *hash {
        return Err(storage());
    }
    Ok(bytes)
}
fn storage() -> StoreError {
    StoreError::StorageUnavailable("CAS bytes failed verification".into())
}

/// Exclusive no-follow temp -> streaming bounded hash -> fsync -> atomic
/// no-replace publication -> verify destination -> metadata durability.
pub fn publish_cas<R: Read>(
    paths: &StorePaths,
    source: R,
    hash: &ContentHash,
    size: u64,
    mime: Mime,
) -> Result<PublishedBlob, StoreError> {
    let guard = locks::acquire(paths, &[], true)?.ok_or(StoreError::LockNotHeld)?;
    publish_cas_locked(paths, source, hash, size, mime, &guard)
}

/// Same publisher for a consumer which already owns the producer fence.
pub fn publish_cas_locked<R: Read>(
    paths: &StorePaths,
    mut source: R,
    hash: &ContentHash,
    size: u64,
    mime: Mime,
    guard: &locks::WriteGuard,
) -> Result<PublishedBlob, StoreError> {
    if !guard.matches(paths)? {
        return Err(StoreError::LockNotHeld);
    }
    if size == 0 || size > ASSET_MAX_BYTES {
        return Err(StoreError::InvalidArgument("asset size".into()));
    }
    // CAS publishers and orphan sweeps share this fence through all I/O.
    recover_temps(paths, guard)?;
    let tmp = ensure_dir(paths.root(), &["assets", "tmp"])?;
    let temp = Temp(tmp.join(format!("cas-{}", new_uuid_v4()?)));
    let mut file = open_no_follow(
        &temp.0,
        OpenOptions::new().read(true).write(true).create_new(true),
    )?;
    let mut hasher = Context::new(&SHA256);
    let mut total = 0u64;
    let mut buffer = [0; 65536];
    loop {
        let n = source.read(&mut buffer).map_err(StoreError::Io)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > size {
            return Err(StoreError::InvalidArgument("asset length mismatch".into()));
        }
        hasher.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(StoreError::Io)?;
    }
    let hex: String = hasher
        .finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if total != size || format!("sha256:{hex}") != hash.as_str() {
        return Err(StoreError::InvalidArgument(
            "asset length or hash mismatch".into(),
        ));
    }
    file.sync_all().map_err(StoreError::Io)?;
    validate_media(&verified_bytes(&mut file, hash, size)?, mime)?;
    let shard = ensure_dir(paths.root(), &["assets", "objects", &hex[..2]])?;
    let destination = blob_path(paths, hash);
    paths.check_no_follow(&temp.0)?;
    paths.check_no_follow(&destination)?;
    #[cfg(unix)]
    let published = std::fs::hard_link(&temp.0, &destination);
    #[cfg(windows)]
    let published = crate::win::publish_no_replace(&temp.0, &destination);
    let new_bytes = match published {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(StoreError::Io(e)),
    };
    paths.check_no_follow(&destination)?;
    let mut final_file = open_no_follow(&destination, OpenOptions::new().read(true).write(true))?;
    validate_media(&verified_bytes(&mut final_file, hash, size)?, mime)?;
    final_file.sync_all().map_err(StoreError::Io)?;
    for dir in [
        &shard,
        &paths.assets_dir().join("objects"),
        &paths.assets_dir(),
    ] {
        sync_dir(dir)?;
    }
    drop(file);
    match std::fs::remove_file(&temp.0) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(StoreError::Io(e)),
    }
    sync_dir(&tmp)?;
    drop(temp);
    Ok(PublishedBlob {
        path: destination,
        hash: hash.clone(),
        size,
        mime,
        new_bytes,
    })
}

/// Requires the store fence; never visits final objects. One bounded page of
/// generated temps left by a dead publisher or a failed normal unlink.
pub(crate) fn recover_temps(
    paths: &StorePaths,
    guard: &locks::WriteGuard,
) -> Result<(), StoreError> {
    if !guard.matches(paths)? {
        return Err(StoreError::LockNotHeld);
    }
    // Recovery never publishes a reference to this disposable directory. An
    // existing entry needs no new barrier; creation still syncs its parent.
    // Publication uses ensure_dir's stronger fence even after interrupted
    // creation, before acknowledging any bytes that depend on the directory.
    let tmp = crate::paths::ensure_dir_observed(
        paths.root(),
        &["assets", "tmp"],
        false,
        &mut |_| Ok(()),
    )?;
    let mut first_error = None;
    let mut removed = false;
    // Eligibility before the cap: foreign names are skipped without counting,
    // so they can never keep later temps out of the bounded batch.
    let ours = std::fs::read_dir(&tmp)
        .map_err(StoreError::Io)?
        .filter(|entry| {
            entry.as_ref().map_or(true, |entry| {
                entry
                    .file_name()
                    .to_str()
                    .and_then(|n| n.strip_prefix("cas-"))
                    .is_some_and(|id| kb_client::types::Uuid::parse(id).is_ok())
            })
        })
        .take(100);
    for entry in ours {
        let result = (|| {
            let entry = entry.map_err(StoreError::Io)?;
            paths.check_no_follow(&entry.path())?;
            std::fs::remove_file(entry.path()).map_err(StoreError::Io)?;
            removed = true;
            Ok(())
        })();
        if let Err(e) = result {
            first_error.get_or_insert(e);
        }
    }
    // Persist successful unlinks even if another entry failed inspection or
    // removal. A crash before this fence can only resurrect unreferenced temps,
    // which the next recovery removes again; final objects are never visited.
    if removed {
        sync_dir(&tmp)?;
    }
    first_error.map_or(Ok(()), Err)
}
