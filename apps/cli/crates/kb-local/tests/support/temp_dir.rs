//! Scoped ownership for test stores, including when a test panics.
use std::path::{Path, PathBuf};

/// A fresh `<temp>/<prefix>-<pid>-<sequence>-<nanos>` path. The per-process
/// sequence keeps parallel tests apart when they read the same clock value
/// (macOS wall time ticks in microseconds) or share a tag.
#[allow(dead_code)] // Shared fixture; some suites only need `TestDir`.
pub fn unique_path(prefix: &str) -> PathBuf {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}-{nanos}",
        std::process::id(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

pub struct TestDir {
    root: PathBuf,
    path: PathBuf,
    before_remove: Option<Box<dyn FnOnce() + Send>>,
}

impl TestDir {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.clone(),
            root,
            before_remove: None,
        }
    }

    #[allow(dead_code)] // Panic regressions inspect the actual deletion boundary.
    pub fn before_remove(&mut self, check: impl FnOnce() + Send + 'static) {
        self.before_remove = Some(Box::new(check));
    }

    #[allow(dead_code)] // Shared fixture; some suites only need the root.
    pub fn child(mut self, name: &str) -> Self {
        self.path = self.root.join(name);
        self
    }
}

impl std::ops::Deref for TestDir {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.path
    }
}
impl AsRef<Path> for TestDir {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}
impl AsRef<std::ffi::OsStr> for TestDir {
    fn as_ref(&self) -> &std::ffi::OsStr {
        self.path.as_os_str()
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        if let Some(check) = self.before_remove.take() {
            check();
        }
        if let Err(error) = std::fs::remove_dir_all(&self.root)
            && error.kind() != std::io::ErrorKind::NotFound
            && !std::thread::panicking()
        {
            panic!("removing test directory {}: {error}", self.root.display());
        }
    }
}
