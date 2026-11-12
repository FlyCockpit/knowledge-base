//! Actor-bound staging only. Durable intent precedes filesystem effects;
//! acknowledged offsets follow fsync. Lock order: store -> sorted KB -> SQLite.
use crate::{
    KbState, LocalPrincipal, Store, StoreError, StorePaths,
    cas::{ASSET_MAX_BYTES, verified_bytes},
    locks,
    mime::{is_asset_mime, validate_media},
    paths::{open_no_follow, sync_dir},
    state::{format_utc, new_uuid_v4, now_secs},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::error::{ConflictReason, InvalidReason};
use kb_client::{ErrorCode, snapshot::content_hash, types::*};
use rusqlite::{Connection, OptionalExtension};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const FRAME_MAX_BYTES: usize = 196608;
pub const MARKDOWN_MAX_BYTES: u64 = 2 * 1024 * 1024;
const TTL_MS: u64 = 3600 * 1000;
const HOURLY_BYTES: u64 = crate::limits::LOCAL_UPLOAD_BYTES_PER_HOUR;
const HOUR_QUERY: &str = "SELECT coalesce(sum(size),0) FROM staged_uploads WHERE created_ms>?1";
const RESERVED_QUERY: &str = "SELECT coalesce(sum(size),0) FROM staged_uploads WHERE reserved=1";
const KB_RESERVED_QUERY: &str =
    "SELECT coalesce(sum(size),0) FROM staged_uploads WHERE reserved=1 AND kb_id=?1";
const SWEEP_QUERY: &str = "SELECT id FROM (SELECT id FROM staged_uploads WHERE state IN ('WRITING','READY') AND reserved_by_op_id IS NULL AND expires_ms<=?1 ORDER BY expires_ms,id LIMIT 100) UNION SELECT id FROM (SELECT id FROM staged_uploads WHERE state IN ('EXPIRED','CONSUMED') AND reclaimed=0 AND retry_ms<=?1 ORDER BY retry_ms,id LIMIT 100) ORDER BY id LIMIT 100";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadStage {
    Reserved,
    FileDurable,
    OffsetDurable,
    ReadyDurable,
    ExpiredDurable,
}
struct Row {
    id: String,
    op: String,
    kb: String,
    actor: String,
    request: String,
    kind: String,
    size: u64,
    hash: String,
    mime: String,
    offset: u64,
    expires: u64,
    state: String,
    pending_size: Option<u64>,
    pending_hash: Option<String>,
    poisoned: bool,
}
const SELECT: &str = "SELECT id,op_id,kb_id,actor_key,request_json,kind,size,hash,mime,offset,expires_ms,state,pending_size,pending_hash,poisoned FROM staged_uploads";
pub(crate) fn unsigned(r: &rusqlite::Row<'_>, col: usize) -> rusqlite::Result<u64> {
    let value = r.get::<_, i64>(col)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(col, value))
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        op: r.get(1)?,
        kb: r.get(2)?,
        actor: r.get(3)?,
        request: r.get(4)?,
        kind: r.get(5)?,
        size: unsigned(r, 6)?,
        hash: r.get(7)?,
        mime: r.get(8)?,
        offset: unsigned(r, 9)?,
        expires: unsigned(r, 10)?,
        state: r.get(11)?,
        pending_size: r.get::<_, Option<u32>>(12)?.map(u64::from),
        pending_hash: r.get(13)?,
        poisoned: r.get(14)?,
    })
}
fn invalid(why: &str) -> StoreError {
    StoreError::InvalidArgument(why.into())
}
fn expired() -> StoreError {
    StoreError::OperationAborted(ErrorCode::UploadExpired)
}
fn incomplete() -> StoreError {
    StoreError::OperationAborted(ErrorCode::UploadIncomplete)
}
fn not_writable() -> StoreError {
    StoreError::conflict_reason(
        ConflictReason::UploadNotWritable,
        None,
        "the upload is already finished or consumed",
    )
}
fn bytes_mismatch() -> StoreError {
    StoreError::conflict_reason(
        ConflictReason::UploadBytesMismatch,
        Some("/offset"),
        "the chunk disagrees with bytes already acknowledged at this offset",
    )
}
fn hash_mismatch() -> StoreError {
    StoreError::conflict_reason(
        ConflictReason::ContentHashMismatch,
        None,
        "the uploaded bytes do not match the content hash declared at start",
    )
}
fn path(paths: &StorePaths, id: &str) -> Result<PathBuf, StoreError> {
    Uuid::parse(id).map_err(|_| StoreError::RecoveryRequired("invalid upload id".into()))?;
    let p = paths.uploads_dir().join(id);
    paths.check_no_follow(&p)?;
    Ok(p)
}
fn iso(ms: u64) -> Result<IsoInstant, StoreError> {
    IsoInstant::parse(&format_utc(ms / 1000))
        .map_err(|_| StoreError::Internal("upload clock".into()))
}
fn begin_result(r: &Row) -> Result<UploadBeginOutput, StoreError> {
    Ok(UploadBeginOutput {
        operation_id: Uuid::parse(&r.op).map_err(|_| invalid("operation id"))?,
        upload_id: Uuid::parse(&r.id).map_err(|_| invalid("upload id"))?,
        offset: ConstU64::<0>,
        expires_at: iso(r.expires)?,
        max_chunk_bytes: ConstU64::<196608>,
    })
}

impl Store {
    fn upload_authorize(&self, who: &LocalPrincipal, kb: &KbId) -> Result<(), StoreError> {
        self.authorize(who, kb, Permission::Propose)?;
        match self.kb(kb)?.ok_or(StoreError::NotFound)?.state {
            KbState::Active => Ok(()),
            KbState::RepairRequired => {
                Err(StoreError::RecoveryRequired("KB requires repair".into()))
            }
            _ => Err(StoreError::NotFound),
        }
    }
    fn upload_row(&self, who: &LocalPrincipal, kb: &KbId, id: &Uuid) -> Result<Row, StoreError> {
        self.upload_authorize(who, kb)?;
        let r = self
            .conn
            .query_row(&format!("{SELECT} WHERE id=?1"), [id.as_str()], row)
            .optional()?
            .ok_or(StoreError::NotFound)?;
        if r.kb != kb.as_str() || r.actor != who.actor_key() {
            return Err(StoreError::NotFound);
        }
        if r.state == "CONSUMED" {
            return Err(not_writable());
        }
        if r.state == "EXPIRED" || r.expires <= self.now_ms() {
            expire(&self.conn, &self.paths, &r.id, &mut |_| {})?;
            return Err(expired());
        }
        if r.poisoned {
            return Err(StoreError::StorageUnavailable(
                "upload durability failed; use a new key".into(),
            ));
        }
        Ok(r)
    }
    pub fn upload_begin(
        &self,
        who: &LocalPrincipal,
        input: UploadBeginInput,
    ) -> Result<UploadBeginOutput, StoreError> {
        self.upload_begin_observed(who, input, &mut |_| {})
    }
    #[doc(hidden)]
    pub fn upload_begin_observed(
        &self,
        who: &LocalPrincipal,
        input: UploadBeginInput,
        observe: &mut dyn FnMut(UploadStage),
    ) -> Result<UploadBeginOutput, StoreError> {
        // The server's order and reasons: size, MIME, then the size limit.
        let (mime_ok, max) = match input.kind {
            UploadKind::Markdown => (input.mime == Mime::TextMarkdown, MARKDOWN_MAX_BYTES),
            UploadKind::Asset => (is_asset_mime(input.mime), ASSET_MAX_BYTES),
        };
        let field = |leaf: &str| Some(format!("/{leaf}"));
        if input.size == 0 {
            return Err(StoreError::invalid(
                InvalidReason::Schema,
                field("size"),
                "upload size",
            ));
        }
        if !mime_ok {
            return Err(StoreError::invalid(
                InvalidReason::Schema,
                field("mime"),
                "upload MIME",
            ));
        }
        if input.size > max {
            return Err(StoreError::invalid(
                InvalidReason::TooLarge,
                field("size"),
                "upload exceeds size limit",
            ));
        }
        let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        self.upload_authorize(who, &input.kb_id)?;
        let request = serde_json::to_string(&input).map_err(|_| invalid("upload input"))?;
        let existing = self
            .conn
            .query_row(
                &format!("{SELECT} WHERE actor_key=?1 AND kb_id=?2 AND idempotency_key=?3"),
                (
                    who.actor_key(),
                    input.kb_id.as_str(),
                    input.idempotency_key.as_str(),
                ),
                row,
            )
            .optional()?;
        let r = if let Some(r) = existing {
            if r.request != request {
                return Err(StoreError::IdempotencyMismatch);
            }
            self.upload_row(
                who,
                &input.kb_id,
                &Uuid::parse(&r.id).map_err(|_| invalid("upload id"))?,
            )?
        } else {
            self.check_disk_admission(input.size)?;
            let now = i64::try_from(self.now_ms()).map_err(|_| invalid("clock"))?;
            let tx = self.conn.unchecked_transaction()?;
            let hour: u64 = tx.query_row(HOUR_QUERY, [now.saturating_sub(TTL_MS as i64)], |r| {
                unsigned(r, 0)
            })?;
            let reserved: u64 = tx.query_row(RESERVED_QUERY, [], |r| unsigned(r, 0))?;
            if hour + input.size > HOURLY_BYTES {
                return Err(StoreError::RateLimited(3600));
            }
            let kb_reserved: u64 =
                tx.query_row(KB_RESERVED_QUERY, [input.kb_id.as_str()], |r| {
                    unsigned(r, 0)
                })?;
            let kb_lineage:u64=tx.query_row("SELECT coalesce(sum(b.size),0) FROM kb_asset_lineage l JOIN asset_blobs b ON b.hash=l.hash WHERE l.kb_id=?1",[input.kb_id.as_str()],|r|unsigned(r,0))?;
            let lineage:u64=tx.query_row("SELECT coalesce(sum(b.size),0) FROM kb_asset_lineage l JOIN asset_blobs b ON b.hash=l.hash",[],|r|unsigned(r,0))?;
            if kb_reserved + kb_lineage + input.size > 1 << 30
                || reserved + lineage + input.size > 5u64 << 30
            {
                return Err(StoreError::QuotaExceeded("upload storage".into()));
            }
            charge_mutation(&tx, &who.actor_key(), input.kb_id.as_str(), now as u64)?;
            let id = new_uuid_v4()?;
            let op = new_uuid_v4()?;
            tx.execute("INSERT INTO staged_uploads (id,op_id,kb_id,actor_key,idempotency_key,request_json,kind,size,hash,mime,created_ms,expires_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                rusqlite::params![id.as_str(),op.as_str(),input.kb_id.as_str(),who.actor_key(),input.idempotency_key.as_str(),request,
                    if input.kind==UploadKind::Asset {"asset"} else {"markdown"},input.size as i64,input.content_hash.as_str(),serde_json::to_string(&input.mime).map_err(|_| invalid("MIME"))?,now,now.checked_add(TTL_MS as i64).ok_or_else(||invalid("clock"))?])?;
            tx.commit()?;
            observe(UploadStage::Reserved);
            self.upload_row(who, &input.kb_id, &id)?
        };
        let p = path(&self.paths, &r.id)?;
        if p.try_exists().map_err(StoreError::Io)? {
            // Replay is read/open validation only. Temporary I/O failures must
            // preserve the durable binding, reservation and accepted bytes.
            self.open_upload(&r)?;
            sync_dir(&self.paths.uploads_dir())?;
        } else if r.offset == 0 && r.pending_size.is_none() && r.state == "WRITING" {
            let file = open_no_follow(
                &p,
                OpenOptions::new().read(true).write(true).create_new(true),
            )?;
            // An uncertain file durability attempt cannot be certified by a
            // later no-op fsync, even if the process dies before error handling.
            self.conn
                .execute("UPDATE staged_uploads SET poisoned=1 WHERE id=?1", [&r.id])?;
            file.sync_all().map_err(StoreError::Io)?;
            sync_dir(&self.paths.uploads_dir())?;
            self.conn
                .execute("UPDATE staged_uploads SET poisoned=0 WHERE id=?1", [&r.id])?;
        } else {
            return Err(StoreError::StorageUnavailable("upload file missing".into()));
        }
        begin_result(&r)
    }
    fn open_upload(&self, r: &Row) -> Result<File, StoreError> {
        open_no_follow(
            &path(&self.paths, &r.id)?,
            OpenOptions::new().read(true).write(true),
        )
    }
    pub fn upload_write(
        &self,
        who: &LocalPrincipal,
        input: UploadWriteInput,
    ) -> Result<UploadWriteOutput, StoreError> {
        self.upload_write_observed(who, input, &mut |_| {})
    }
    #[doc(hidden)]
    pub fn upload_write_observed(
        &self,
        who: &LocalPrincipal,
        input: UploadWriteInput,
        observe: &mut dyn FnMut(UploadStage),
    ) -> Result<UploadWriteOutput, StoreError> {
        let frame = |reason: InvalidReason| {
            StoreError::invalid(reason, Some("/bytesBase64".into()), "upload frame")
        };
        if input.bytes_base64.len() > FRAME_MAX_BYTES.div_ceil(3) * 4 {
            return Err(frame(InvalidReason::TooLarge));
        }
        let bytes = STANDARD
            .decode(&input.bytes_base64)
            .map_err(|_| frame(InvalidReason::Schema))?;
        if bytes.len() > FRAME_MAX_BYTES {
            return Err(frame(InvalidReason::TooLarge));
        }
        if bytes.is_empty() || STANDARD.encode(&bytes) != input.bytes_base64 {
            return Err(frame(InvalidReason::Schema));
        }
        let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        let r = self.upload_row(who, &input.kb_id, &input.upload_id)?;
        if r.state != "WRITING" {
            return Err(not_writable());
        }
        let end = input
            .offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| {
                StoreError::invalid(InvalidReason::Schema, Some("/offset".into()), "offset")
            })?;
        if input.offset > r.offset {
            return Err(incomplete());
        }
        if input.offset < r.offset && end > r.offset {
            return Err(bytes_mismatch());
        }
        if end > r.size {
            // Server parity: the chunk is the oversized argument.
            return Err(frame(InvalidReason::TooLarge));
        }
        let mut file = self.open_upload(&r)?;
        let len = file.metadata().map_err(StoreError::Io)?.len();
        if len < r.offset || len > r.size {
            return Err(StoreError::StorageUnavailable("upload file length".into()));
        }
        if input.offset == r.offset {
            let hash = content_hash(&bytes);
            if let Some(size) = r.pending_size {
                if size != bytes.len() as u64 || r.pending_hash.as_deref() != Some(hash.as_str()) {
                    return Err(bytes_mismatch());
                }
            } else {
                if len != r.offset {
                    return Err(StoreError::StorageUnavailable(
                        "unexpected upload tail".into(),
                    ));
                }
                self.conn.execute(
                    "UPDATE staged_uploads SET pending_size=?2,pending_hash=?3 WHERE id=?1",
                    (r.id.as_str(), bytes.len() as i64, hash.as_str()),
                )?;
                observe(UploadStage::Reserved);
            }
        }
        let existing = (len.saturating_sub(input.offset)).min(bytes.len() as u64) as usize;
        file.seek(SeekFrom::Start(input.offset))
            .map_err(StoreError::Io)?;
        let mut prefix = vec![0; existing];
        file.read_exact(&mut prefix).map_err(StoreError::Io)?;
        if prefix != bytes[..existing] {
            return Err(bytes_mismatch());
        }
        if input.offset < r.offset {
            if existing != bytes.len() {
                return Err(StoreError::StorageUnavailable(
                    "acknowledged bytes missing".into(),
                ));
            }
        } else {
            self.conn
                .execute("UPDATE staged_uploads SET poisoned=1 WHERE id=?1", [&r.id])?;
            file.write_all(&bytes[existing..]).map_err(StoreError::Io)?;
            file.sync_all().map_err(StoreError::Io)?;
            self.conn
                .execute("UPDATE staged_uploads SET poisoned=0 WHERE id=?1", [&r.id])?;
            observe(UploadStage::FileDurable);
            self.conn.execute("UPDATE staged_uploads SET offset=?2,pending_size=NULL,pending_hash=NULL WHERE id=?1",(r.id.as_str(),end as i64))?;
            observe(UploadStage::OffsetDurable);
        }
        Ok(UploadWriteOutput {
            upload_id: input.upload_id,
            offset: if input.offset < r.offset {
                r.offset
            } else {
                end
            },
        })
    }
    pub fn upload_finish(
        &self,
        who: &LocalPrincipal,
        input: UploadRef,
    ) -> Result<UploadFinishOutput, StoreError> {
        let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        let r = self.upload_row(who, &input.kb_id, &input.upload_id)?;
        if r.offset != r.size || r.pending_size.is_some() {
            return Err(incomplete());
        }
        charge_mutation(
            &self.conn,
            &who.actor_key(),
            input.kb_id.as_str(),
            self.now_ms(),
        )?;
        let hash = ContentHash::parse(&r.hash).map_err(|_| invalid("upload hash"))?;
        let mut file = self.open_upload(&r)?;
        let bytes = verified_bytes(&mut file, &hash, r.size).map_err(|e| match e {
            StoreError::StorageUnavailable(_) => hash_mismatch(),
            other => other,
        })?;
        let mime: Mime = serde_json::from_str(&r.mime).map_err(|_| invalid("MIME"))?;
        if r.kind == "markdown" {
            // The same check and reasons as the server's upload finish.
            if let Err(issue) = crate::markdown::validate_markdown_bytes(&bytes) {
                return Err(StoreError::invalid(
                    issue.code.reason(),
                    None,
                    issue.message,
                ));
            }
        } else {
            validate_media(&bytes, mime)?;
        }
        self.conn.execute(
            "UPDATE staged_uploads SET state='READY' WHERE id=?1 AND state='WRITING'",
            [r.id.as_str()],
        )?;
        Ok(UploadFinishOutput {
            upload_id: input.upload_id,
            content_hash: hash,
            size: r.size,
            mime,
            state: ReadyState,
            expires_at: iso(r.expires)?,
        })
    }
    /// Already under the producer fence; validates ownership/kind/state/TTL and
    /// verifies sealed bytes without consuming or releasing the reservation.
    pub(crate) fn ready_upload(
        &self,
        actor: &str,
        kb: &KbId,
        id: &Uuid,
        kind: &str,
    ) -> Result<(crate::tree::ManifestEntry, Vec<u8>), StoreError> {
        let r = self
            .conn
            .query_row(&format!("{SELECT} WHERE id=?1"), [id.as_str()], row)
            .optional()?
            .ok_or(StoreError::NotFound)?;
        if r.kb != kb.as_str() || r.actor != actor {
            return Err(StoreError::NotFound);
        }
        if r.state == "CONSUMED" {
            return Err(not_writable());
        }
        if r.state == "EXPIRED" || r.expires <= self.now_ms() {
            return Err(expired());
        }
        if r.kind != kind {
            return Err(invalid("upload kind"));
        }
        if r.state != "READY" {
            return Err(incomplete());
        }
        if r.poisoned {
            return Err(StoreError::StorageUnavailable(
                "upload durability failed".into(),
            ));
        }
        let hash = ContentHash::parse(&r.hash).map_err(|_| invalid("upload hash"))?;
        let bytes = verified_bytes(&mut self.open_upload(&r)?, &hash, r.size)?;
        let mime: Mime = serde_json::from_str(&r.mime).map_err(|_| invalid("MIME"))?;
        if kind == "asset" {
            validate_media(&bytes, mime)?;
        }
        Ok((
            crate::tree::ManifestEntry {
                path: "upload".into(),
                hash: r.hash,
                size: r.size,
                mime: serde_json::to_value(mime)
                    .map_err(|_| invalid("MIME"))?
                    .as_str()
                    .ok_or_else(|| invalid("MIME"))?
                    .into(),
            },
            bytes,
        ))
    }
    /// One bounded page; startup, every write admission and the owned minute
    /// timer reclaim more pages. Exact expiry is checked on every operation.
    pub fn sweep_uploads(&self) -> Result<usize, StoreError> {
        self.sweep_uploads_observed(&mut |_| {})
    }
    #[doc(hidden)]
    pub fn sweep_uploads_observed(
        &self,
        observe: &mut dyn FnMut(UploadStage),
    ) -> Result<usize, StoreError> {
        let guard = locks::acquire(&self.paths, &[], true)?.ok_or(StoreError::LockNotHeld)?;
        self.check_guard(&guard)?;
        crate::cas::recover_temps(&self.paths, &guard)?;
        sweep_observed(&self.conn, &self.paths, self.now_ms(), observe)
    }
    #[doc(hidden)]
    pub fn run_upload_timer_for_tests(&self) -> Result<(), StoreError> {
        timer_tick(&self.paths).map(|_| ())
    }
}
// The producer fence serializes this bounded rolling window. The same row
// Shared actor+KB mutation window; callers charge atomically with fresh receipts.
// Replays and transfer frames are exempt.
pub(crate) fn check_mutation_budget(
    conn: &Connection,
    actor: &str,
    kb: &str,
    now: u64,
) -> Result<(), StoreError> {
    mutation_times(conn, actor, kb, now).map(|_| ())
}

fn mutation_times(
    conn: &Connection,
    actor: &str,
    kb: &str,
    now: u64,
) -> Result<Vec<u64>, StoreError> {
    let encoded: Option<String> = conn
        .query_row(
            "SELECT times_json FROM mutation_windows WHERE actor_key=?1 AND kb_id=?2",
            (actor, kb),
            |r| r.get(0),
        )
        .optional()?;
    let mut times: Vec<u64> = serde_json::from_str(encoded.as_deref().unwrap_or("[]"))
        .map_err(|_| StoreError::RecoveryRequired("mutation window".into()))?;
    times.retain(|t| *t > now.saturating_sub(60_000));
    if times.len() >= crate::limits::LOCAL_MUTATIONS_PER_MINUTE_PER_KB {
        return Err(StoreError::RateLimited(60));
    }
    Ok(times)
}

pub(crate) fn charge_mutation(
    conn: &Connection,
    actor: &str,
    kb: &str,
    now: u64,
) -> Result<(), StoreError> {
    let mut times = mutation_times(conn, actor, kb, now)?;
    times.push(now);
    conn.execute("INSERT INTO mutation_windows(actor_key,kb_id,times_json) VALUES (?1,?2,?3) ON CONFLICT(actor_key,kb_id) DO UPDATE SET times_json=excluded.times_json",
        (actor,kb,serde_json::to_string(&times).map_err(|_| invalid("mutation window"))?))?;
    Ok(())
}
fn expire(
    conn: &Connection,
    paths: &StorePaths,
    id: &str,
    observe: &mut dyn FnMut(UploadStage),
) -> Result<(), StoreError> {
    // Terminal intent/quota release commits before recoverable unlink. A
    // crash retries cleanup without charging or releasing anything twice.
    conn.execute("UPDATE staged_uploads SET state='EXPIRED',reserved=0,pending_size=NULL,pending_hash=NULL WHERE id=?1 AND state IN ('WRITING','READY') AND reserved_by_op_id IS NULL",[id])?;
    observe(UploadStage::ExpiredDurable);
    match std::fs::remove_file(path(paths, id)?) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(StoreError::Io(e)),
    }
    // ENOENT can follow an unlink whose directory barrier failed. Repeat the
    // barrier before recording completion in either case.
    sync_dir(&paths.uploads_dir())?;
    conn.execute(
        "UPDATE staged_uploads SET reclaimed=1 WHERE id=?1 AND state IN ('EXPIRED','CONSUMED')",
        [id],
    )?;
    Ok(())
}
pub(crate) fn sweep(conn: &Connection, paths: &StorePaths, now: u64) -> Result<usize, StoreError> {
    sweep_observed(conn, paths, now, &mut |_| {})
}
fn sweep_observed(
    conn: &Connection,
    paths: &StorePaths,
    now: u64,
    observe: &mut dyn FnMut(UploadStage),
) -> Result<usize, StoreError> {
    let mut stmt = conn.prepare(SWEEP_QUERY)?;
    let ids = stmt
        .query_map([i64::try_from(now).map_err(|_| invalid("clock"))?], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut first_error = None;
    for id in &ids {
        if let Err(e) = expire(conn, paths, id, observe) {
            conn.execute(
                "UPDATE staged_uploads SET retry_ms=?2 WHERE id=?1",
                (id, now.saturating_add(60_000) as i64),
            )?;
            first_error.get_or_insert(e);
        }
    }
    if let Some(e) = first_error {
        return Err(e);
    }
    Ok(ids.len())
}
fn timer_tick(paths: &StorePaths) -> Result<usize, StoreError> {
    let Some(guard) = locks::acquire(paths, &[], false)? else {
        return Ok(0);
    };
    let conn = crate::state::open_existing(&paths.state_db())?;
    let temps = crate::cas::recover_temps(paths, &guard);
    let transfers = sweep_transfers(&conn, paths, now_secs() * 1000);
    temps?;
    transfers
}
// Independent retention classes must all run even if a sibling cannot unlink.
// Each persists its own retry deadline; report failure only after both attempts.
pub(crate) fn sweep_transfers(
    conn: &Connection,
    paths: &StorePaths,
    now: u64,
) -> Result<usize, StoreError> {
    let exports = crate::exports::sweep(conn, paths, now, true);
    let uploads = sweep(conn, paths, now);
    Ok(exports? + uploads?)
}
#[derive(Debug)]
pub(crate) struct UploadTimer {
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl UploadTimer {
    pub(crate) fn start(paths: StorePaths) -> Result<Self, StoreError> {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let signal = stop.clone();
        let worker = std::thread::Builder::new()
            .name("kb-upload-expiry".into())
            .spawn(move || {
                loop {
                    let (mutex, cv) = &*signal;
                    let Ok(stopped) = mutex.lock() else { return };
                    let Ok((stopped, _)) =
                        cv.wait_timeout_while(stopped, Duration::from_secs(60), |stop| !*stop)
                    else {
                        return;
                    };
                    if *stopped {
                        return;
                    }
                    drop(stopped);
                    let _ = timer_tick(&paths); // failed cleanup remains eligible
                }
            })
            .map_err(StoreError::Io)?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}
impl Drop for UploadTimer {
    fn drop(&mut self) {
        let (mutex, cv) = &*self.stop;
        if let Ok(mut stop) = mutex.lock() {
            *stop = true;
            cv.notify_all();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn admission_and_sweep_query_plans_exclude_retained_history() {
        let conn = Connection::open_in_memory().expect("SQLite");
        conn.execute_batch(include_str!("db/0001_initial.sql"))
            .expect("schema");
        for (query, expected) in [
            (HOUR_QUERY, "staged_uploads_hour"),
            (RESERVED_QUERY, "staged_uploads_reserved"),
            (KB_RESERVED_QUERY, "staged_uploads_reserved"),
            (SWEEP_QUERY, "staged_uploads_cleanup"),
        ] {
            let mut stmt = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
                .expect("plan");
            let values = vec![rusqlite::types::Value::Integer(0); stmt.parameter_count()];
            let plan = stmt
                .query_map(rusqlite::params_from_iter(values), |r| {
                    r.get::<_, String>(3)
                })
                .expect("explain")
                .collect::<Result<Vec<_>, _>>()
                .expect("plan rows")
                .join("\n");
            assert!(plan.contains(expected), "{query}: {plan}");
            assert!(
                !plan.contains("SCAN staged_uploads") || plan.contains("staged_uploads_reserved"),
                "unbounded receipt scan: {plan}"
            );
            if query == SWEEP_QUERY {
                assert!(plan.contains("staged_uploads_expiry"));
            }
        }
    }
}
