//! Revision ZIP32 STORE exports: store -> sorted KB fence -> SQLite. The
//! fence owns inventory, reservation, source I/O and READY publication; every
//! Git child inherits it. A durable WRITING receipt precedes the private file.
use crate::{
    LocalPrincipal, Store, StoreError, StorePaths,
    bases::check_input,
    git_read::{
        EntryKind, GitRepo, IncomingBudget, ObjectKind, OperationDeadline, WalkBudget, walk_tree,
    },
    paths::{ensure_dir, open_no_follow, sync_dir},
    state::{format_utc, new_uuid_v4},
    tree::{self, TREE_LIMITS},
};
use kb_client::{ErrorCode, types::*};
use ring::digest::{Context, SHA256};
use rusqlite::{Connection, OptionalExtension};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const EXPORT_MAX_ENTRIES: usize = 8192;
pub const EXPORT_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const EXPORT_DEADLINE: Duration = Duration::from_secs(120);
pub const EXPORT_TTL_MS: u64 = 900_000;
pub const EXPORT_GRACE_MS: u64 = 600_000;
pub const FRAME_BYTES: usize = 196608;
/// Cloneable cancellation/shutdown signal; timeouts can only lower 120s.
#[derive(Clone, Debug)]
pub struct ExportControl {
    pub(crate) cancelled: Arc<AtomicBool>,
    deadline: Instant,
    clock: fn() -> Instant,
    disk_meter: fn(&GitRepo, &Path) -> Result<u64, StoreError>,
}
impl Default for ExportControl {
    fn default() -> Self {
        Self::with_timeout(EXPORT_DEADLINE)
    }
}
impl ExportControl {
    pub fn with_timeout(timeout: Duration) -> Self {
        Self::with_timeout_and_clock(timeout, Instant::now)
    }
    /// Trusted host clock seam, never a serialized tool input. The same clock
    /// drives preflight, service checks and every supervised Git watchdog.
    #[doc(hidden)]
    pub fn with_timeout_and_clock(timeout: Duration, clock: fn() -> Instant) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: clock() + timeout.min(EXPORT_DEADLINE),
            clock,
            disk_meter: available_disk,
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    /// Trusted host fault seam, never a serialized tool input.
    #[doc(hidden)]
    pub fn with_disk_meter(
        mut self,
        meter: fn(&GitRepo, &Path) -> Result<u64, StoreError>,
    ) -> Self {
        self.disk_meter = meter;
        self
    }
    pub(crate) fn check(&self) -> Result<(), StoreError> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(StoreError::OperationAborted(ErrorCode::Cancelled));
        }
        if (self.clock)() >= self.deadline {
            return Err(StoreError::DeadlineExceeded);
        }
        // CPU/file loops honor shorter enclosing scopes as well as this
        // caller's control, just like lock admission and supervised children.
        OperationDeadline::check()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportStage {
    Reserved,
    ArtifactOpened,
    MemberWritten,
    Durable,
    Ready,
    TerminalDurable,
}
pub(crate) fn unavailable() -> StoreError {
    StoreError::StorageUnavailable("export unavailable".into())
}
pub(crate) fn artifact_path(paths: &StorePaths, id: &str) -> Result<PathBuf, StoreError> {
    Uuid::parse(id).map_err(|_| unavailable())?;
    let dir = ensure_dir(paths.root(), &["assets", "tmp"])?;
    let path = dir.join(format!("export-{id}"));
    paths.check_no_follow(&path)?;
    Ok(path)
}
type ExistingReceipt = (String, String, String, Option<String>, Option<String>, u64);
struct Entry {
    path: String,
    size: u64,
    blob: Option<String>,
    hash: Option<ContentHash>,
}
fn inventory(
    s: &Store,
    kb: &KbId,
    repo: &GitRepo,
    rev: &Sha,
    kind: ExportKind,
    c: &ExportControl,
) -> Result<Vec<Entry>, StoreError> {
    c.check()?;
    let assets = s.manifest_entries(kb, repo, rev)?;
    if assets.len() > EXPORT_MAX_ENTRIES
        || assets.iter().map(|e| e.size).sum::<u64>() > EXPORT_MAX_BYTES
    {
        return Err(StoreError::QuotaExceeded("export inventory".into()));
    }
    // Validate names, modes, required files and whole-tree/manifest disjointness
    // even for assets-only export; no arbitrary filesystem directory is read.
    tree::validate_commit(
        repo,
        rev,
        &crate::manifest::SnapshotPolicy(crate::manifest::Policy {
            base: None,
            store: s,
            kb,
            pending: &[],
        }),
    )
    .map_err(|e| match e {
        tree::TreeError::Invalid(_) => StoreError::InvalidArgument("export tree".into()),
        tree::TreeError::Git(e) => e.into(),
    })?;

    let mut out = Vec::new();
    if kind == ExportKind::Whole {
        let mut reader = repo.object_reader()?;
        let info = reader.read_commit(rev)?;
        let entries = walk_tree(
            &mut reader,
            &info.tree,
            &mut WalkBudget::new(TREE_LIMITS.max_entries),
            &mut IncomingBudget::new(
                TREE_LIMITS.max_objects,
                TREE_LIMITS.max_uncompressed_object_bytes,
                None,
            ),
        )?;
        for e in entries.into_iter().filter(|e| e.kind == EntryKind::Blob) {
            c.check()?;
            let bytes = reader.read(&e.sha, ObjectKind::Blob, TREE_LIMITS.max_markdown_bytes)?;
            out.push(Entry {
                path: e.path,
                size: bytes.len() as u64,
                blob: Some(e.sha),
                hash: None,
            });
        }
    }
    for e in assets {
        out.push(Entry {
            path: e.path,
            size: e.size,
            blob: None,
            hash: Some(ContentHash::parse(&e.hash).map_err(|_| unavailable())?),
        });
    }
    if out.len() > EXPORT_MAX_ENTRIES || out.iter().map(|e| e.size).sum::<u64>() > EXPORT_MAX_BYTES
    {
        return Err(StoreError::QuotaExceeded("export inventory".into()));
    }
    c.check()?;
    Ok(out)
}
impl Store {
    pub fn export_prepare(
        &self,
        p: &LocalPrincipal,
        input: ExportPrepareInput,
    ) -> Result<ExportPrepareOutput, StoreError> {
        self.export_prepare_controlled(p, input, &ExportControl::default(), &mut |_, _| Ok(()))
    }
    /// Observer is a fault/crash seam; production uses no observer. Caller
    /// shutdown cancels the same control and joins this synchronous service.
    #[doc(hidden)]
    pub fn export_prepare_controlled(
        &self,
        p: &LocalPrincipal,
        input: ExportPrepareInput,
        c: &ExportControl,
        observe: &mut dyn FnMut(ExportStage, &Uuid) -> Result<(), StoreError>,
    ) -> Result<ExportPrepareOutput, StoreError> {
        check_input::<ExportPrepare>(&input)?;
        c.check()?;
        let _deadline =
            OperationDeadline::bounded_with_clock(c.deadline, c.cancelled.clone(), c.clock);
        let result = (|| {
            let _guard = self
                .lock_write(std::slice::from_ref(&input.kb_id))
                .or_else(|e| OperationDeadline::check().and(Err(e)))?;
            c.check()?;
            self.authorize(p, &input.kb_id, Permission::Read)?;
            self.active_record(&input.kb_id)?;
            let request = serde_json::to_string(&input).map_err(|_| unavailable())?;
            let existing:Option<ExistingReceipt>=self.conn.query_row("SELECT id,request_json,state,response_json,failure_code,expires_ms FROM export_artifacts WHERE actor_key=?1 AND kb_id=?2 AND idempotency_key=?3",(p.actor_key(),input.kb_id.as_str(),input.idempotency_key.as_str()),|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,crate::uploads::unsigned(r,5)?))).optional()?;
            if let Some((_, prior, state, response, failure, expires)) = existing {
                if prior != request {
                    return Err(StoreError::IdempotencyMismatch);
                }
                if state == "ABORTED" {
                    return Err(StoreError::OperationAborted(
                        failure
                            .as_deref()
                            .unwrap_or("CANCELLED")
                            .parse()
                            .map_err(|_| unavailable())?,
                    ));
                }
                if state != "READY" || expires <= self.now_ms() {
                    return Err(StoreError::Conflict("export is not available".into()));
                }
                c.check()?;
                self.authorize(p, &input.kb_id, Permission::Read)?;
                return serde_json::from_str(response.as_deref().ok_or_else(unavailable)?)
                    .map_err(|_| unavailable());
            }
            let counts:(i64,i64)=self.conn.query_row("SELECT count(*),coalesce(sum(actor_key=?1),0) FROM export_artifacts WHERE state IN ('WRITING','READY')",[p.actor_key()],|r|Ok((r.get(0)?,r.get(1)?)))?;
            if counts.0 >= 2 || counts.1 >= 1 {
                return Err(StoreError::QuotaExceeded("active exports".into()));
            }
            crate::uploads::charge_mutation(
                &self.conn,
                &p.actor_key(),
                input.kb_id.as_str(),
                self.now_ms(),
            )?;
            let (repo, rev) = self
                .pinned_revision(p, &input.kb_id, input.rev.as_ref())
                .or_else(|e| OperationDeadline::check().and(Err(e)))?;
            let entries = inventory(self, &input.kb_id, &repo, &rev, input.kind, c)
                .or_else(|e| OperationDeadline::check().and(Err(e)))?;
            // Continuous producer ownership reserves the complete STORE archive
            // until it is materialized. Existing/unreclaimed bytes are already
            // absent from measured free space; unfinished uploads still owe bytes.
            let pending: u64 = self.conn.query_row(
                "SELECT coalesce(sum(max(size-offset,0)),0) FROM staged_uploads WHERE reserved=1",
                [],
                |r| crate::uploads::unsigned(r, 0),
            )?;
            let archive = 22
                + entries
                    .iter()
                    .map(|e| e.size + 92 + 2 * e.path.len() as u64)
                    .sum::<u64>();
            for (path, extra) in [
                (self.paths.root().to_path_buf(), pending),
                (self.paths.assets_dir().join("tmp"), pending + archive),
            ] {
                self.paths.check_no_follow(&path)?;
                let free = (c.disk_meter)(&repo, &path)
                    .or_else(|e| OperationDeadline::check().and(Err(e)))?;
                if free < crate::limits::FREE_DISK_FLOOR_BYTES.saturating_add(extra) {
                    return Err(StoreError::QuotaExceeded("export disk headroom".into()));
                }
            }
            c.check()?;
            let id = new_uuid_v4()?;
            let expires = self.now_ms() + EXPORT_TTL_MS;
            self.conn.execute("INSERT INTO export_artifacts(id,kb_id,actor_key,idempotency_key,request_json,rev,expires_ms,state) VALUES (?1,?2,?3,?4,?5,?6,?7,'WRITING')",rusqlite::params![id.as_str(),input.kb_id.as_str(),p.actor_key(),input.idempotency_key.as_str(),request,rev.as_str(),expires as i64])?;
            let result: Result<ExportPrepareOutput, StoreError> = (|| {
                observe(ExportStage::Reserved, &id)?;
                c.check()?;
                let path = artifact_path(&self.paths, id.as_str())?;
                let mut file = open_no_follow(
                    &path,
                    OpenOptions::new().read(true).write(true).create_new(true),
                )?;
                observe(ExportStage::ArtifactOpened, &id)?;
                c.check()?;
                write_zip(
                    self,
                    p,
                    &input.kb_id,
                    &repo,
                    &entries,
                    &mut file,
                    c,
                    &id,
                    observe,
                )?;
                file.sync_all().map_err(StoreError::Io)?;
                sync_dir(path.parent().ok_or_else(unavailable)?)?;
                observe(ExportStage::Durable, &id)?;
                c.check()?;
                let (size, hash, frames) = seal(&mut file, c)?;
                let out = ExportPrepareOutput {
                    operation_id: id.clone(),
                    transfer_id: id.clone(),
                    rev,
                    size,
                    content_hash: hash,
                    expires_at: IsoInstant::parse(&format_utc(expires / 1000))
                        .map_err(|_| unavailable())?,
                    mime: ZipMime,
                };
                self.authorize(p, &input.kb_id, Permission::Read)?;
                c.check()?;
                let tx = self.conn.unchecked_transaction()?;
                for (n, h) in frames.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO export_frames(export_id,frame,hash) VALUES (?1,?2,?3)",
                        (id.as_str(), n as i64, h),
                    )?;
                }
                tx.execute("UPDATE export_artifacts SET state='READY',size=?2,content_hash=?3,response_json=?4 WHERE id=?1 AND state='WRITING'",(id.as_str(),size as i64,out.content_hash.as_str(),serde_json::to_string(&out).map_err(|_|unavailable())?))?;
                tx.commit()?;
                observe(ExportStage::Ready, &id)?;
                c.check()?;
                Ok(out)
            })();
            // A drained Git/read error must retain the controlling cancel/deadline code.
            let result = result.or_else(|e| OperationDeadline::check().and(Err(e)));
            if let Err(e) = &result {
                // Terminal intent commits before unlink. A crash or failed unlink
                // retries cleanup at next admission/tick; READY can never leak.
                abort(&self.conn, id.as_str(), e.protocol_code())?;
                observe(ExportStage::TerminalDurable, &id)?;
                sweep(&self.conn, &self.paths, self.now_ms(), false)?;
            }
            result
        })();
        result.or_else(|e| OperationDeadline::check().and(Err(e)))
    }
    pub fn sweep_exports(&self) -> Result<usize, StoreError> {
        let g = crate::locks::acquire(&self.paths, &[], true)?.ok_or(StoreError::LockNotHeld)?;
        self.check_guard(&g)?;
        sweep(&self.conn, &self.paths, self.now_ms(), true)
    }
}
// Use OS-shipped utilities through the same lock-inheriting, capped-output,
// deadline/cancellation/drain boundary as Git. No new unsafe/dependency scope.
fn available_disk(repo: &GitRepo, path: &Path) -> Result<u64, StoreError> {
    crate::limits::measure_disk(path, |command, cap| repo.run_command(command, cap))
}

pub(crate) fn abort(conn: &Connection, id: &str, code: ErrorCode) -> Result<(), StoreError> {
    conn.execute("UPDATE export_artifacts SET state='ABORTED',failure_code=?2 WHERE id=?1 AND state IN ('WRITING','READY')",(id,code.as_str()))?;
    Ok(())
}
/// Called only under the drained producer fence. No live WRITING export can
/// hold that fence concurrently. Compact receipts are retained indefinitely.
pub(crate) fn sweep(
    conn: &Connection,
    paths: &StorePaths,
    now: u64,
    restart: bool,
) -> Result<usize, StoreError> {
    if restart {
        conn.execute("UPDATE export_artifacts SET state='ABORTED',failure_code='CANCELLED' WHERE state='WRITING'",[])?;
    }
    conn.execute("UPDATE export_artifacts SET state=CASE WHEN completed_ms IS NULL THEN 'ABORTED' ELSE 'DOWNLOADED' END,failure_code='NOT_FOUND' WHERE state='READY' AND expires_ms<=?1",[now as i64])?;
    let mut stmt=conn.prepare("SELECT id FROM export_artifacts WHERE state IN ('ABORTED','DOWNLOADED') AND reclaimed=0 AND retry_ms<=?1 ORDER BY retry_ms,id LIMIT 100")?;
    let ids = stmt
        .query_map([now as i64], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut error = None;
    for id in &ids {
        let result = (|| {
            let path = artifact_path(paths, id)?;
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(StoreError::Io(e)),
            }
            sync_dir(path.parent().ok_or_else(unavailable)?)?;
            let tx = conn.unchecked_transaction()?;
            tx.execute("DELETE FROM export_frames WHERE export_id=?1", [id])?;
            tx.execute("UPDATE export_artifacts SET reclaimed=1 WHERE id=?1", [id])?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(e) = result {
            conn.execute(
                "UPDATE export_artifacts SET retry_ms=?2 WHERE id=?1",
                (id, now.saturating_add(60_000) as i64),
            )?;
            error.get_or_insert(e);
        }
    }
    error.map_or(Ok(ids.len()), Err)
}
// ZIP32 STORE, UTF8 names, fixed DOS date, signed data descriptors. Bounds
// make ZIP64 unnecessary. Only metadata and one bounded source are resident.
const CRC_TABLE: [u32; 256] = {
    let mut table = [0; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut j = 0;
        while j < 8 {
            c = (c >> 1) ^ if c & 1 == 1 { 0xedb88320 } else { 0 };
            j += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};
fn put16(b: &mut [u8], at: usize, v: u16) {
    b[at..at + 2].copy_from_slice(&v.to_le_bytes());
}
fn put32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_le_bytes());
}
#[allow(clippy::too_many_arguments)] // One writer owns the file, fence and cancellation control.
fn write_zip(
    s: &Store,
    p: &LocalPrincipal,
    kb: &KbId,
    repo: &GitRepo,
    entries: &[Entry],
    file: &mut File,
    c: &ExportControl,
    id: &Uuid,
    observe: &mut dyn FnMut(ExportStage, &Uuid) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    let at = std::cell::Cell::new(0u32);
    let mut directory = Vec::new();
    let mut reader = repo.object_reader()?;
    let mut write = |bytes: &[u8]| -> Result<(), StoreError> {
        c.check()?;
        file.write_all(bytes).map_err(StoreError::Io)?;
        at.set(at.get() + bytes.len() as u32);
        Ok(())
    };
    for e in entries {
        s.authorize(p, kb, Permission::Read)?;
        c.check()?;
        // Source sizes are known from preflight; a CAS source is never loaded
        // as a whole buffer. Git documents are capped at 2 MiB by the validator.
        let mut source: Box<dyn Read> = if let Some(blob) = &e.blob {
            Box::new(std::io::Cursor::new(reader.read(
                blob,
                ObjectKind::Blob,
                TREE_LIMITS.max_markdown_bytes,
            )?))
        } else {
            let path = crate::cas::blob_path(&s.paths, e.hash.as_ref().ok_or_else(unavailable)?);
            s.paths.check_no_follow(&path)?;
            let f =
                open_no_follow(&path, OpenOptions::new().read(true)).map_err(|_| unavailable())?;
            if f.metadata().map_err(StoreError::Io)?.len() != e.size {
                return Err(unavailable());
            }
            Box::new(f)
        };
        let start = at.get();
        let name = e.path.as_bytes();
        let mut local = [0u8; 30];
        put32(&mut local, 0, 0x04034b50);
        put16(&mut local, 4, 20);
        put16(&mut local, 6, 0x808);
        put16(&mut local, 12, 33);
        put16(&mut local, 26, name.len() as u16);
        write(&local)?;
        write(name)?;
        let mut crc = !0u32;
        let mut hash = Context::new(if e.blob.is_some() {
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY
        } else {
            &SHA256
        });
        if e.blob.is_some() {
            hash.update(format!("blob {}\0", e.size).as_bytes());
        }
        let mut size = 0u64;
        let mut buf = [0u8; 65536];
        loop {
            c.check()?;
            let n = source.read(&mut buf).map_err(StoreError::Io)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > e.size {
                return Err(unavailable());
            }
            for b in &buf[..n] {
                crc = (crc >> 8) ^ CRC_TABLE[((crc ^ u32::from(*b)) & 255) as usize];
            }
            hash.update(&buf[..n]);
            write(&buf[..n])?;
        }
        let actual = hash.finish();
        let hex = actual
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if size != e.size
            || e.hash
                .as_ref()
                .is_some_and(|h| format!("sha256:{hex}") != h.as_str())
            || e.blob.as_ref().is_some_and(|h| h != &hex)
        {
            return Err(unavailable());
        }
        let mut desc = [0; 16];
        put32(&mut desc, 0, 0x08074b50);
        put32(&mut desc, 4, !crc);
        put32(&mut desc, 8, size as u32);
        put32(&mut desc, 12, size as u32);
        write(&desc)?;
        let mut central = vec![0; 46];
        put32(&mut central, 0, 0x02014b50);
        put16(&mut central, 4, 20);
        put16(&mut central, 6, 20);
        put16(&mut central, 8, 0x808);
        put16(&mut central, 14, 33);
        put32(&mut central, 16, !crc);
        put32(&mut central, 20, size as u32);
        put32(&mut central, 24, size as u32);
        put16(&mut central, 28, name.len() as u16);
        put32(&mut central, 42, start);
        central.extend_from_slice(name);
        directory.push(central);
        observe(ExportStage::MemberWritten, id)?;
        c.check()?;
    }
    let central_start = at.get();
    let central_len: usize = directory.iter().map(Vec::len).sum();
    for bytes in &directory {
        write(bytes)?;
    }
    let mut end = [0; 22];
    put32(&mut end, 0, 0x06054b50);
    put16(&mut end, 8, entries.len() as u16);
    put16(&mut end, 10, entries.len() as u16);
    put32(&mut end, 12, central_len as u32);
    put32(&mut end, 16, central_start);
    write(&end)?;
    Ok(())
}
pub(crate) fn digest_hash(d: ring::digest::Digest) -> String {
    format!(
        "sha256:{}",
        d.as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}
fn seal(file: &mut File, c: &ExportControl) -> Result<(u64, ContentHash, Vec<String>), StoreError> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(StoreError::Io)?;
    let mut all = Context::new(&SHA256);
    let mut frames = Vec::new();
    let mut size = 0;
    let mut buf = vec![0; FRAME_BYTES];
    loop {
        c.check()?;
        let mut n = 0;
        while n < buf.len() {
            let got = file.read(&mut buf[n..]).map_err(StoreError::Io)?;
            if got == 0 {
                break;
            }
            n += got;
        }
        if n == 0 {
            break;
        }
        size += n as u64;
        all.update(&buf[..n]);
        frames.push(digest_hash(ring::digest::digest(&SHA256, &buf[..n])));
    }
    let hash = ContentHash::parse(&digest_hash(all.finish())).map_err(|_| unavailable())?;
    Ok((size, hash, frames))
}
