//! One atomic credential file per canonical origin AND resource. A private OS
//! directory lock serializes credential I/O and abandoned-temp recovery;
//! logout compares the old token before deletion,
//! so a concurrent re-login cannot lose its new credential. No network under
//! these locks. No disposable index or config file contains credentials.
use anyhow::{Context, Result, bail};
use kb_client::{authoring::AuthoringMode, mcp::origin::McpResource, types::SecretToken};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use zeroize::Zeroizing;

pub struct CredentialStore {
    dir: PathBuf,
}
impl CredentialStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
    fn path(&self, resource: &McpResource, extension: &str) -> PathBuf {
        let digest = ring::digest::digest(&ring::digest::SHA256, resource.as_string().as_bytes());
        let name: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
        self.dir.join(format!("{name}.{extension}"))
    }
    fn lock(&self) -> Result<File> {
        check_private_path(&self.dir, true)?;
        // One stable directory-wide lock covers every temp from creation to
        // publication/drop, including recovery of abandoned .tmp files.
        let path = self.dir.join(".lock");
        let mut options = private_options();
        options.read(true).write(true);
        let file = match options.create_new(true).open(&path) {
            Ok(file) => {
                #[cfg(windows)]
                set_private(&path, false)?;
                file
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                kb_local::paths::open_regular(&path, private_options().read(true).write(true))
                    .context("opening private credential lock")?
            }
            Err(e) => return Err(e).context("creating private credential lock"),
        };
        check_file(&file)?;
        #[cfg(windows)]
        check_private_path(&path, false)?;
        file.lock().context("locking credential state")?;
        self.reclaim_temps()?;
        Ok(file)
    }
    fn reclaim_temps(&self) -> Result<()> {
        let mut removed = false;
        for entry in fs::read_dir(&self.dir).context("reading private credential directory")? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix(".tmp")) else {
                continue;
            };
            // tempfile's default namespace, used by the current writer.
            if suffix.len() != 6 || !suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
                continue;
            }
            // Never follow links or remove a file owned by another user. Drop
            // the checked handle before unlinking (required on Windows).
            drop(open_private_file(&entry.path())?);
            fs::remove_file(entry.path()).context("removing abandoned credential temp")?;
            removed = true;
        }
        if removed {
            sync_dir(&self.dir)?;
        }
        Ok(())
    }
    pub fn load(&self, resource: &McpResource) -> Result<Option<SecretToken>> {
        Ok(self.load_entry(resource)?.map(|(token, _)| token))
    }
    /// The stored token and the write mode its login was approved for
    /// (`None`: imported or read-only).
    pub fn load_entry(
        &self,
        resource: &McpResource,
    ) -> Result<Option<(SecretToken, Option<AuthoringMode>)>> {
        check_ancestors(&self.dir)?;
        if !self.dir.try_exists()? {
            return Ok(None);
        }
        let _lock = self.lock()?;
        self.load_locked(resource)
    }
    fn load_locked(
        &self,
        resource: &McpResource,
    ) -> Result<Option<(SecretToken, Option<AuthoringMode>)>> {
        let path = self.path(resource, "json");
        if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
            return Ok(None);
        }
        let mut file = open_private_file(&path)?;
        let mut bytes = Zeroizing::new(Vec::new());
        Read::by_ref(&mut file)
            .take(16385)
            .read_to_end(&mut bytes)
            .context("reading private credential state")?;
        if bytes.len() > 16384 {
            bail!("private credential state is too large");
        }
        #[cfg(windows)]
        let bytes = protect(&bytes, false)?;
        let disk: DiskRead = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid private credential state"))?;
        if disk.origin != resource.origin() || disk.resource != resource.as_string() {
            bail!("private credential origin/resource mismatch");
        }
        if disk.secret.is_empty() || disk.secret.len() > 8192 {
            bail!("invalid stored credential");
        }
        Ok(Some((
            SecretToken::new(disk.secret.to_string()),
            disk.authoring_mode,
        )))
    }
    pub fn save(&self, resource: &McpResource, token: &SecretToken) -> Result<()> {
        self.save_with_mode(resource, token, None)
    }
    /// Save `token` with the write mode it was approved for (`None` stores
    /// no mode).
    pub fn save_with_mode(
        &self,
        resource: &McpResource,
        token: &SecretToken,
        mode: Option<AuthoringMode>,
    ) -> Result<()> {
        ensure_private_dir(&self.dir)?;
        let _lock = self.lock()?;
        let path = self.path(resource, "json");
        if fs::symlink_metadata(&path).is_ok() {
            check_private_path(&path, false)?;
        }
        let file = self.write_temp(resource, token, mode)?;
        file.persist(&path)
            .map_err(|e| e.error)
            .context("publishing private credential state")?;
        sync_dir(&self.dir)
    }
    fn write_temp(
        &self,
        resource: &McpResource,
        token: &SecretToken,
        authoring_mode: Option<AuthoringMode>,
    ) -> Result<NamedTempFile> {
        check_private_path(&self.dir, true)?;
        let resource_string = resource.as_string();
        let bytes = Zeroizing::new(serde_json::to_vec(&DiskWrite {
            origin: resource.origin(),
            resource: &resource_string,
            secret: token.expose_secret(),
            authoring_mode,
        })?);
        #[cfg(windows)]
        let bytes = protect(&bytes, true)?;
        let mut file = tempfile::Builder::new()
            .prefix(".tmp")
            .rand_bytes(6)
            .tempfile_in(&self.dir)
            .context("creating private credential temp file")?;
        #[cfg(windows)]
        set_private(file.path(), false)?;
        check_private_path(file.path(), false)?;
        file.write_all(&bytes)
            .context("writing private credential temp file")?;
        file.as_file()
            .sync_all()
            .context("syncing private credential temp file")?;
        Ok(file)
    }
    pub fn remove_if_matches(
        &self,
        resource: &McpResource,
        expected: &SecretToken,
    ) -> Result<bool> {
        check_ancestors(&self.dir)?;
        if !self.dir.try_exists()? {
            return Ok(false);
        }
        let _lock = self.lock()?;
        if self.load_locked(resource)?.map(|(token, _)| token).as_ref() != Some(expected) {
            return Ok(false);
        }
        fs::remove_file(self.path(resource, "json")).context("removing local credential")?;
        sync_dir(&self.dir)?;
        Ok(true)
    }
}
#[derive(Serialize)]
struct DiskWrite<'a> {
    origin: &'a str,
    resource: &'a str,
    secret: &'a str,
    /// The approved write mode; omitted when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    authoring_mode: Option<AuthoringMode>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskRead {
    origin: String,
    resource: String,
    secret: Zeroizing<String>,
    #[serde(default)]
    authoring_mode: Option<AuthoringMode>,
}

fn check_ancestors(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if is_link(&meta) => {
                bail!("credential path contains a symlink or reparse point")
            }
            Ok(meta) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if meta.is_dir() && meta.mode() & 0o002 != 0 && meta.mode() & 0o1000 == 0 {
                        bail!("credential path has an untrusted writable ancestor");
                    }
                }
                #[cfg(not(unix))]
                let _ = meta;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("checking credential path"),
        }
    }
    Ok(())
}
fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
fn ensure_private_dir(path: &Path) -> Result<()> {
    check_ancestors(path)?;
    if !path.try_exists()? {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty())
            && !parent.try_exists()?
        {
            ensure_private_dir(parent)?;
        }
        let builder = fs::DirBuilder::new();
        #[cfg(unix)]
        let mut builder = builder;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(path) {
            Ok(()) => {
                #[cfg(windows)]
                set_private(path, true)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e).context("creating private credential directory"),
        }
    }
    // Only this managed directory must be owner-only; pre-existing ancestors
    // (e.g. /tmp or the profile root) need not be private and are never chmod'd.
    check_private_path(path, true)?;
    // Publish every directory link parent-first before acknowledging state.
    // Sync existing ancestors too: a racing/failed creator may have made them
    // visible without making their links durable. Re-entry must retry fsync.
    // Windows skips only an ancestor this user can add no entry to; see
    // `kb_local::paths::sync_ancestor_dir`.
    let parents: Vec<_> = path.ancestors().skip(1).collect();
    for parent in parents.into_iter().rev() {
        sync_ancestor_dir(if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        })?;
    }
    Ok(())
}
pub fn check_private_path(path: &Path, directory: bool) -> Result<()> {
    check_ancestors(path)?;
    let meta = fs::symlink_metadata(path).context("checking private path")?;
    if is_link(&meta) || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        bail!("unsafe private credential path");
    }
    check_mode(&meta, directory)?;
    #[cfg(windows)]
    acl(path)?;
    Ok(())
}
#[cfg(unix)]
fn check_mode(meta: &fs::Metadata, directory: bool) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    // A newly-created temporary file identifies the effective uid without FFI
    // or trusting an environment variable. Never change another owner's ACL.
    let uid = tempfile::tempfile()
        .context("determining credential file owner")?
        .metadata()?
        .uid();
    let mode = if directory { 0o700 } else { 0o600 };
    if meta.uid() != uid || meta.mode() & 0o777 != mode {
        bail!("credential path must be current-user-only (0700 directory / 0600 file)");
    }
    if !directory && meta.nlink() != 1 {
        bail!("credential file must not have hard links");
    }
    Ok(())
}
#[cfg(not(unix))]
fn check_mode(_meta: &fs::Metadata, _directory: bool) -> Result<()> {
    Ok(())
}
fn check_file(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file() || is_link(&meta) {
        bail!("unsafe credential file");
    }
    check_mode(&meta, false)
}
/// The shared untrusted-path opener's options (no final link followed, no
/// blocking open on a FIFO; owner-only creation).
fn private_options() -> OpenOptions {
    kb_local::paths::no_follow_options()
}
pub fn open_private_file(path: &Path) -> Result<File> {
    check_private_path(path, false)?;
    let file = kb_local::paths::open_regular(path, private_options().read(true))
        .context("opening private credential file")?;
    check_file(&file)?;
    Ok(file)
}
/// A private file the user names on the command line (`--token-file`, a
/// sealed literal or recipient key file): resolved once to its canonical path
/// (only root-controlled system links such as macOS `/tmp` are followed; see
/// `kb_local::paths::resolve_entry_path`), which the strict checks and the
/// open then use.
pub fn open_user_private_file(path: &Path) -> Result<File> {
    let canonical = kb_local::paths::resolve_entry_path(path)
        .with_context(|| format!("resolving `{}`", path.display()))?;
    open_private_file(&canonical)
}
/// The one platform directory barrier (fsync, or the Windows writable-handle
/// flush).
fn sync_dir(path: &Path) -> Result<()> {
    kb_local::paths::sync_dir(path).context("syncing private credential directory")
}
/// [`sync_dir`] for an existing ancestor of a credential directory.
fn sync_ancestor_dir(path: &Path) -> Result<()> {
    kb_local::paths::sync_ancestor_dir(path).context("syncing private credential directory")
}

// Windows uses the OS DPAPI CurrentUser API and a protected DACL containing
// exactly the current SID, natively (kb-local's audited Windows boundary): no
// helper process. Errors are reported without detail and with no fallback.
#[cfg(windows)]
fn protect(bytes: &[u8], encrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    kb_local::credentials::windows_dpapi(bytes, encrypt)
        .map_err(|_| anyhow::anyhow!("Windows credential protection failed"))
}
#[cfg(windows)]
pub(crate) fn set_private(path: &Path, directory: bool) -> Result<()> {
    kb_local::paths::make_owner_only(path, directory)
        .map_err(|_| anyhow::anyhow!("Windows credential protection failed"))
}
#[cfg(windows)]
fn acl(path: &Path) -> Result<()> {
    match kb_local::paths::is_owner_only(path) {
        Ok(true) => Ok(()),
        Ok(false) => bail!("private ACL required"),
        Err(_) => bail!("Windows credential protection failed"),
    }
}
/// Credential paths refuse symlinked ancestors, and macOS's temporary root sits
/// under the `/var` → `/private/var` link: fixtures use its canonical path.
#[cfg(test)]
pub(crate) fn canonical_tempdir() -> tempfile::TempDir {
    let root = std::env::temp_dir()
        .canonicalize()
        .expect("canonical temporary root");
    tempfile::tempdir_in(root).expect("temporary directory")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AtomicWriterFixture {
        child: std::process::Child,
        reader: Option<std::thread::JoinHandle<std::io::Result<()>>>,
        readiness: std::sync::mpsc::Receiver<std::io::Result<()>>,
    }
    impl AtomicWriterFixture {
        fn ready(&mut self) {
            // Preparation has no ten-second product deadline. This watchdog
            // bounds the owned fixture while observing the real synced temp.
            self.readiness
                .recv_timeout(std::time::Duration::from_secs(180))
                .expect("writer readiness")
                .expect("writer reached the pre-rename boundary");
        }
        fn kill(&mut self) {
            // `Child::wait` closes stdin first. macOS applies SIGKILL
            // asynchronously, so that EOF could still wake the writer, which
            // would then discard the temp the crash must leave: keep the
            // control pipe open until the killed writer is reaped.
            let control = self.child.stdin.take();
            self.child.kill().expect("kill writer");
            self.child.wait().expect("drain writer");
            drop(control);
            self.drain_reader();
        }
        fn finish(&mut self) -> std::process::ExitStatus {
            drop(self.child.stdin.take());
            let status = self.child.wait().expect("writer shutdown");
            self.drain_reader();
            status
        }
        fn drain_reader(&mut self) {
            self.reader
                .take()
                .expect("writer reader")
                .join()
                .expect("reader thread")
                .expect("writer output drain");
        }
    }
    impl Drop for AtomicWriterFixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
        }
    }
    fn atomic_writer_fixture(root: &Path) -> AtomicWriterFixture {
        let child = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--ignored",
                "--exact",
                "state::tests::interrupted_writer_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("KB_TEST_ATOMIC_ROOT", root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("writer");
        let (tx, readiness) = std::sync::mpsc::channel();
        let mut fixture = AtomicWriterFixture {
            child,
            reader: None,
            readiness,
        };
        let output = fixture.child.stdout.take().expect("writer output");
        fixture.reader = Some(std::thread::spawn(move || {
            use std::io::BufRead;
            let mut reported = false;
            let result = (|| {
                for line in std::io::BufReader::new(output).lines() {
                    if line? == "KB_ATOMIC_READY" && !reported {
                        let _ = tx.send(Ok(()));
                        reported = true;
                    }
                }
                if reported {
                    return Ok(());
                }
                Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "writer exited before readiness",
                ))
            })();
            if !reported {
                let _ = tx.send(
                    result
                        .as_ref()
                        .map(|_| ())
                        .map_err(|error| std::io::Error::new(error.kind(), error.to_string())),
                );
            }
            result
        }));
        fixture
    }

    fn temp_count(root: &Path) -> usize {
        fs::read_dir(root)
            .expect("credential directory")
            .filter(|entry| {
                entry
                    .as_ref()
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".tmp")
            })
            .count()
    }

    #[test]
    fn first_save_creates_private_parents_and_replacement_keeps_valid_state() {
        let dir = canonical_tempdir();
        let root = dir.path().join("data/credentials");
        let store = CredentialStore::new(root.clone());
        let resource = McpResource::parse(
            "https://kb.example",
            kb_client::mcp::origin::TransportPolicy::HttpsOnly,
        )
        .expect("resource");
        assert!(!root.parent().expect("data directory").exists());
        assert!(store.load(&resource).expect("empty load").is_none());
        for value in ["disposable-first", "disposable-replacement"] {
            store
                .save(&resource, &SecretToken::new(value.into()))
                .expect("save");
            check_private_path(root.parent().expect("data directory"), true)
                .expect("private data directory");
            check_private_path(&root, true).expect("private credential directory");
            assert_eq!(
                store
                    .load(&resource)
                    .expect("load")
                    .expect("credential")
                    .expose_secret(),
                value
            );
            assert_eq!(temp_count(&root), 0);
        }
    }

    #[test]
    fn closing_the_writer_control_pipe_discards_the_unpublished_temp() {
        let dir = canonical_tempdir();
        let root = dir.path().join("credentials");
        ensure_private_dir(&root).expect("private directory");
        let mut writer = atomic_writer_fixture(&root);
        writer.ready();
        assert_eq!(temp_count(&root), 1);
        assert!(writer.finish().success());
        assert_eq!(temp_count(&root), 0);
        let resource = McpResource::parse(
            "https://kb.example",
            kb_client::mcp::origin::TransportPolicy::HttpsOnly,
        )
        .expect("resource");
        assert!(
            CredentialStore::new(root)
                .load(&resource)
                .expect("load")
                .is_none()
        );
    }

    #[test]
    fn the_approved_write_mode_is_stored_with_the_credential() {
        let dir = canonical_tempdir();
        let root = dir.path().join("credentials");
        let store = CredentialStore::new(root.clone());
        let resource = McpResource::parse(
            "https://kb.example",
            kb_client::mcp::origin::TransportPolicy::HttpsOnly,
        )
        .expect("resource");
        let token = SecretToken::new("disposable-mode".into());
        // No mode: the file carries no `authoring_mode` key (readable only
        // on Unix; Windows stores DPAPI ciphertext).
        store.save(&resource, &token).expect("save");
        #[cfg(unix)]
        {
            let file = fs::read_dir(&root)
                .expect("dir")
                .map(|entry| entry.expect("entry").path())
                .find(|path| path.extension().is_some_and(|e| e == "json"))
                .expect("credential file");
            assert!(
                !fs::read_to_string(&file)
                    .expect("read")
                    .contains("authoring_mode")
            );
        }
        assert_eq!(store.load_entry(&resource).expect("load").unwrap().1, None);
        for mode in AuthoringMode::ALL {
            store
                .save_with_mode(&resource, &token, Some(mode))
                .expect("save");
            let (loaded, stored) = store.load_entry(&resource).expect("load").unwrap();
            assert_eq!(loaded, token);
            assert_eq!(stored, Some(mode));
        }
        assert!(store.remove_if_matches(&resource, &token).expect("remove"));
    }

    #[test]
    fn killed_atomic_writer_preserves_old_private_state() {
        let dir = canonical_tempdir();
        let root = dir.path().join("credentials");
        let store = CredentialStore::new(root.clone());
        let resource = McpResource::parse(
            "https://kb.example",
            kb_client::mcp::origin::TransportPolicy::HttpsOnly,
        )
        .expect("resource");
        store
            .save(&resource, &SecretToken::new("disposable-old".into()))
            .expect("save");
        let mut child = atomic_writer_fixture(&root);
        child.ready();
        child.kill();
        assert_eq!(temp_count(&root), 1, "crash leaves a private orphan");
        assert_eq!(
            store
                .load(&resource)
                .expect("load")
                .expect("old state")
                .expose_secret(),
            "disposable-old"
        );
        assert_eq!(temp_count(&root), 0, "load reclaims the orphan");
        // No interruption recovery path publishes the orphaned temporary file.
        store
            .save(&resource, &SecretToken::new("disposable-reentry".into()))
            .expect("reentry");
        assert_eq!(
            store
                .load(&resource)
                .expect("load")
                .expect("new state")
                .expose_secret(),
            "disposable-reentry"
        );
    }

    #[test]
    fn recovery_waits_for_live_writer_even_for_another_origin() {
        let dir = canonical_tempdir();
        let root = dir.path().join("credentials");
        ensure_private_dir(&root).expect("private directory");
        std::thread::scope(|scope| {
            let mut child = atomic_writer_fixture(&root);
            child.ready();
            let held = private_options()
                .read(true)
                .write(true)
                .open(root.join(".lock"))
                .expect("writer lock inode");
            assert!(
                matches!(held.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
                "ready writer must retain the real OS lock"
            );
            drop(held);
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (tx, rx) = std::sync::mpsc::channel();
            let thread_root = root.clone();
            let recovery = scope.spawn(move || {
                let resource = McpResource::parse(
                    "https://other.example",
                    kb_client::mcp::origin::TransportPolicy::HttpsOnly,
                )
                .expect("other resource");
                started_tx.send(()).expect("started");
                tx.send(CredentialStore::new(thread_root).load(&resource))
                    .expect("result");
            });
            started_rx.recv().expect("started");
            let before_kill = rx.recv_timeout(std::time::Duration::from_millis(200));
            let live_temps = temp_count(&root);
            child.kill();
            assert!(matches!(
                before_kill,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            assert_eq!(live_temps, 1, "live writer's temp retained");
            assert!(rx.recv().expect("recovery").expect("load").is_none());
            recovery.join().expect("drain recovery");
            assert_eq!(temp_count(&root), 0, "dead writer's temp reclaimed");
        });
    }

    #[test]
    #[ignore = "child writer invoked through the parent-owned atomic writer fixture"]
    fn interrupted_writer_child() {
        let root = std::env::var_os("KB_TEST_ATOMIC_ROOT").expect("child root");
        let store = CredentialStore::new(root.into());
        let resource = McpResource::parse(
            "https://kb.example",
            kb_client::mcp::origin::TransportPolicy::HttpsOnly,
        )
        .expect("resource");
        let _lock = store.lock().expect("writer holds the production lock");
        let _temp = store
            .write_temp(&resource, &SecretToken::new("disposable-new".into()), None)
            .expect("private synced temp");
        let mut output = std::io::stdout();
        // libtest prefixes the running test on this line with one test thread.
        // Keep the parent's exact readiness frame independent of that prefix.
        std::io::Write::write_all(&mut output, b"\nKB_ATOMIC_READY\n").expect("ready frame");
        std::io::Write::flush(&mut output).expect("ready pipe");
        // The parent owns this hold. EOF is normal shutdown; SIGKILL models the
        // interruption. No fixed sleep can release the writer before a reader.
        let mut control = [0];
        std::io::Read::read(&mut std::io::stdin(), &mut control).expect("parent control");
    }
}
