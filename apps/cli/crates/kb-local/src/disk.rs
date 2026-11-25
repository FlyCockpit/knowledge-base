//! Free-space admission: the shared free-space meter (`df` on Unix,
//! `GetDiskFreeSpaceExW` on Windows) and the store's disk floor check.

use crate::StoreError;
use crate::limits::{FREE_DISK_FLOOR_BYTES, WRITE_DISK_RESERVE_BYTES};

pub(crate) type DiskMeter = fn(&crate::StorePaths, &std::path::Path) -> Result<u64, StoreError>;

pub(crate) fn available_disk(
    paths: &crate::StorePaths,
    path: &std::path::Path,
) -> Result<u64, StoreError> {
    measure_disk(path, |command, cap| {
        crate::git_read::GitRepo::run_store_command(paths, command, cap)
    })
}

impl crate::Store {
    /// Called under the producer fence, after replay and before fresh effects.
    /// Upload and index capacities are already promised and cannot spend the floor.
    /// Index file bytes already allocated are measured by the disk meter once.
    pub(crate) fn check_disk_admission(&self, additional_bytes: u64) -> Result<(), StoreError> {
        let pending: u64 = self.conn.query_row(
            "SELECT (SELECT coalesce(sum(max(size-offset,0)),0) FROM staged_uploads WHERE reserved=1) + (SELECT coalesce(sum(max(reserved_bytes-allocated_bytes,0)),0) FROM index_generations WHERE reserved_bytes>0)",
            [],
            |r| crate::uploads::unsigned(r, 0),
        )?;
        let required = FREE_DISK_FLOOR_BYTES
            .checked_add(WRITE_DISK_RESERVE_BYTES)
            .and_then(|v| v.checked_add(pending))
            .and_then(|v| v.checked_add(additional_bytes))
            .ok_or_else(|| StoreError::QuotaExceeded("disk headroom".into()))?;
        for path in [
            self.paths.root().to_path_buf(),
            self.paths.root().join("repos"),
            self.paths.root().join("indexes"),
            self.paths.uploads_dir(),
            self.paths.assets_dir(),
        ] {
            self.paths.check_no_follow(&path)?;
            let free = (self.disk_meter.get())(&self.paths, &path)
                .or_else(|e| crate::deadline::OperationDeadline::check().and(Err(e)))?;
            if free < required {
                return Err(StoreError::QuotaExceeded("disk headroom".into()));
            }
        }
        Ok(())
    }
}

// Shared free-space meter; both callers supply the same supervised runner,
// which the Unix `df` child uses.
pub(crate) fn measure_disk(
    path: &std::path::Path,
    run: impl FnOnce(std::process::Command, usize) -> Result<(bool, Vec<u8>), crate::git_read::GitError>,
) -> Result<u64, StoreError> {
    let unavailable = || StoreError::StorageUnavailable("disk measurement unavailable".into());
    // Windows asks the volume directly (GetDiskFreeSpaceExW, quota-aware free
    // bytes for this user): no child process, so no PATH or shell lookup.
    #[cfg(windows)]
    {
        let _ = run;
        // Managed paths are canonical/verbatim; measure their drive root.
        // Reparse/mounted-directory paths were already refused.
        let drive = match path.components().next() {
            Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
                std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => {
                    format!("{}:\\", char::from(letter))
                }
                _ => return Err(unavailable()),
            },
            _ => return Err(unavailable()),
        };
        crate::win::available_disk_bytes(std::path::Path::new(&drive)).map_err(|_| unavailable())
    }
    #[cfg(unix)]
    {
        use std::process::{Command, Stdio};
        let mut command = {
            let mut cmd = Command::new("/bin/df");
            cmd.args(["-P", "-k"])
                .arg(path)
                .env_clear()
                .env("LC_ALL", "C");
            cmd
        };
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let (ok, bytes) = run(command, 4096).map_err(|_| unavailable())?;
        if !ok {
            return Err(unavailable());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| unavailable())?;
        let lines: Vec<_> = text.lines().collect();
        if lines.len() != 2 {
            return Err(unavailable());
        }
        let fields: Vec<_> = lines[1].split_whitespace().collect();
        // Reject ambiguous mount/device names instead of guessing a column.
        if fields.len() != 6 || !fields[4].ends_with('%') {
            return Err(unavailable());
        }
        let total: u64 = fields[1].parse().map_err(|_| unavailable())?;
        let free: u64 = fields[3].parse().map_err(|_| unavailable())?;
        if free > total {
            return Err(unavailable());
        }
        free.checked_mul(1024).ok_or_else(unavailable)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn store_utility_runner_caps_output_drains_deadline_and_allows_reentry() {
        use crate::deadline::OperationDeadline;
        use crate::git_read::{GitError, GitRepo};
        use std::process::{Command, Stdio};
        use std::time::Duration;

        let root = std::env::temp_dir().join(format!(
            "store-runner-{}",
            crate::state::new_uuid_v4().expect("test id")
        ));
        let store = crate::Store::open(&root).expect("store");
        let guard = store.lock_write(&[]).expect("producer fence");
        let command = |source: &str| {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", source])
                .env_clear()
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            c
        };
        assert_eq!(
            GitRepo::run_store_command(store.paths(), command("printf ok"), 8).expect("utility"),
            (true, b"ok".to_vec())
        );
        assert!(matches!(
            GitRepo::run_store_command(store.paths(), command("printf too-large"), 1),
            Err(GitError::Budget(_))
        ));
        let marker = root.join("utility-pid");
        {
            let _deadline = OperationDeadline::for_test(Duration::from_secs(1));
            let mut c = command("printf %s \"$$\" > \"$1\"; exec /bin/sleep 60");
            c.args(["utility", marker.to_str().expect("test path")]);
            assert!(matches!(
                GitRepo::run_store_command(store.paths(), c, 4096),
                Err(GitError::Timeout)
            ));
        }
        let pid = std::fs::read_to_string(marker).expect("utility actually entered");
        assert!(
            !Command::new("/bin/kill")
                .args(["-0", &pid])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("liveness check")
                .success(),
            "timed-out child was drained"
        );
        drop(guard);
        let next = store
            .lock_write(&[])
            .expect("successor admission after drain");
        assert_eq!(
            GitRepo::run_store_command(store.paths(), command("printf next"), 8)
                .expect("successor utility"),
            (true, b"next".to_vec())
        );
        drop(next);
        drop(store);
        std::fs::remove_dir_all(root).expect("own fixture cleanup");
    }
}
