//! Random-access canonical frames. Every call owns the store fence, checks
//! actor + KB + exact expiry + live read, and verifies all sealed frames
//! intersecting the requested slice before returning any bytes.
use crate::{
    LocalPrincipal, Store, StoreError,
    bases::check_input,
    exports::{self, EXPORT_GRACE_MS, FRAME_BYTES},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::types::*;
use rusqlite::OptionalExtension;
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom},
};
impl Store {
    pub fn transfer_read(
        &self,
        p: &LocalPrincipal,
        input: TransferReadInput,
    ) -> Result<TransferReadOutput, StoreError> {
        check_input::<TransferRead>(&input)?;
        let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        self.authorize(p, &input.kb_id, Permission::Read)?;
        self.active_record(&input.kb_id)?;
        let row:Option<(u64,String)>=self.conn.query_row("SELECT size,content_hash FROM export_artifacts WHERE id=?1 AND kb_id=?2 AND actor_key=?3 AND state='READY' AND expires_ms>?4",(input.transfer_id.as_str(),input.kb_id.as_str(),p.actor_key(),self.now_ms() as i64),|r|Ok((crate::uploads::unsigned(r,0)?,r.get(1)?))).optional()?;
        let (size, hash) = row.ok_or(StoreError::NotFound)?;
        if input.offset >= size {
            return Err(StoreError::InvalidArgument("transfer offset".into()));
        }
        let start = input.offset / FRAME_BYTES as u64 * FRAME_BYTES as u64;
        let end = (input.offset + input.max_bytes.unwrap_or(FRAME_BYTES as u64)).min(size);
        let limit = end.div_ceil(FRAME_BYTES as u64) * FRAME_BYTES as u64;
        let bytes = (|| {
            let path = exports::artifact_path(&self.paths, input.transfer_id.as_str())?;
            let mut file = crate::paths::open_no_follow(&path, OpenOptions::new().read(true))?;
            if file.metadata().map_err(StoreError::Io)?.len() != size {
                return Err(exports::unavailable());
            }
            file.seek(SeekFrom::Start(start)).map_err(StoreError::Io)?;
            let mut buffer = vec![0; (limit.min(size) - start) as usize];
            file.read_exact(&mut buffer).map_err(StoreError::Io)?;
            for (n, frame) in buffer.chunks(FRAME_BYTES).enumerate() {
                let expected: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT hash FROM export_frames WHERE export_id=?1 AND frame=?2",
                        (
                            input.transfer_id.as_str(),
                            (start / FRAME_BYTES as u64) as i64 + n as i64,
                        ),
                        |r| r.get(0),
                    )
                    .optional()?;
                let actual =
                    exports::digest_hash(ring::digest::digest(&ring::digest::SHA256, frame));
                if expected.as_deref() != Some(actual.as_str()) {
                    return Err(exports::unavailable());
                }
            }
            Ok(buffer[(input.offset - start) as usize..(end - start) as usize].to_vec())
        })();
        let bytes = match bytes {
            Ok(b) => b,
            Err(_) => {
                exports::abort(
                    &self.conn,
                    input.transfer_id.as_str(),
                    kb_client::ErrorCode::StorageUnavailable,
                )?;
                exports::sweep(&self.conn, &self.paths, self.now_ms(), false)?;
                return Err(exports::unavailable());
            }
        };
        self.authorize(p, &input.kb_id, Permission::Read)?;
        let now = self.now_ms();
        if self.conn.execute("UPDATE export_artifacts SET offset=max(offset,?2) WHERE id=?1 AND state='READY' AND expires_ms>?3",(input.transfer_id.as_str(),end as i64,now as i64))?!=1 {return Err(StoreError::NotFound);}
        if end == size {
            self.conn.execute("UPDATE export_artifacts SET completed_ms=?2,expires_ms=?3 WHERE id=?1 AND state='READY' AND completed_ms IS NULL AND expires_ms>?2",(input.transfer_id.as_str(),now as i64,(now+EXPORT_GRACE_MS) as i64))?;
        }
        Ok(TransferReadOutput {
            transfer_id: input.transfer_id,
            offset: input.offset,
            next_offset: end,
            bytes_base64: STANDARD.encode(bytes),
            eof: end == size,
            content_hash: ContentHash::parse(&hash).map_err(|_| exports::unavailable())?,
        })
    }
    /// EOF acknowledgement, or cancellation before EOF. Idempotent for the
    /// original actor; receipts survive file deletion. No source CAS/history GC.
    pub fn export_complete(
        &self,
        p: &LocalPrincipal,
        input: TransferRef,
    ) -> Result<ExportCompleteOutput, StoreError> {
        check_input::<ExportComplete>(&input)?;
        let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
        self.authorize(p, &input.kb_id, Permission::Read)?;
        self.active_record(&input.kb_id)?;
        let state: Option<String> = self
            .conn
            .query_row(
                "SELECT state FROM export_artifacts WHERE id=?1 AND kb_id=?2 AND actor_key=?3",
                (
                    input.transfer_id.as_str(),
                    input.kb_id.as_str(),
                    p.actor_key(),
                ),
                |r| r.get(0),
            )
            .optional()?;
        if state.ok_or(StoreError::NotFound)? == "WRITING" {
            return Err(StoreError::Conflict("export is not ready".into()));
        }
        self.conn.execute("UPDATE export_artifacts SET state=CASE WHEN completed_ms IS NULL THEN 'ABORTED' ELSE 'DOWNLOADED' END,failure_code='CANCELLED' WHERE id=?1 AND state='READY'",[input.transfer_id.as_str()])?;
        exports::sweep(&self.conn, &self.paths, self.now_ms(), false)?;
        Ok(ExportCompleteOutput {
            transfer_id: input.transfer_id,
            released: True,
        })
    }
}
