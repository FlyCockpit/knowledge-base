//! Background export jobs and bounded, verified export consumption.
//!
//! `start_export` admits a job and returns at once; the server builds the ZIP
//! on its own deadline. `wait_for_export` polls `knowledge_export_status` with
//! a bounded backoff until the job leaves pending/building. Only a ready job
//! is downloadable. The verified receipt borrows the preparing client, so
//! acknowledgement always uses its exact credential. Hosts must durably save
//! the verified bytes before calling `complete`.

use std::{fmt, io::Write, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use ring::digest::{Context, SHA256};

use crate::types::{
    ExportCancel, ExportComplete, ExportCompleteOutput, ExportJob, ExportPrepare,
    ExportPrepareInput, ExportState, ExportStatus, KbId, TransferRead, TransferReadInput,
    TransferRef, Uuid,
};
use crate::{CallControl, ClientError, Deadline, KbError, McpClient};

const FRAME_BYTES: u64 = 196608;
/// First poll interval; it grows by half each poll up to `POLL_MAX`.
const POLL_FIRST: Duration = Duration::from_secs(1);
const POLL_MAX: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum ExportError {
    Client(ClientError),
    Io(std::io::Error),
    InvalidFrame,
    HashMismatch,
    /// The job ended without becoming ready (failed, cancelled or expired),
    /// or a download was asked of a job that is not ready.
    NotReady(Box<ExportJob>),
    /// The job was still pending or building when the wait bound passed.
    StillRunning(Box<ExportJob>),
}

impl fmt::Display for ExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Client(error) => error.fmt(f),
            Self::Io(_) => f.write_str("could not write export bytes"),
            Self::InvalidFrame => f.write_str("export frame does not match its descriptor"),
            Self::HashMismatch => f.write_str("export content hash does not verify"),
            Self::NotReady(job) => match (job.state, &job.error) {
                (ExportState::Failed, Some(error)) => write!(f, "export failed: {}", error.message),
                (ExportState::Failed, None) => f.write_str("export failed"),
                (ExportState::Cancelled, _) => f.write_str("export was cancelled"),
                (ExportState::Expired, _) => {
                    f.write_str("export expired or was released; start a new export")
                }
                _ => f.write_str("export is not ready yet"),
            },
            Self::StillRunning(job) => write!(
                f,
                "export `{}` is still being prepared",
                job.transfer_id.as_str()
            ),
        }
    }
}
impl std::error::Error for ExportError {}
impl From<ClientError> for ExportError {
    fn from(error: ClientError) -> Self {
        Self::Client(error)
    }
}

/// Constructed only after every frame, exact size and full SHA-256 verify.
/// The destination writer may still be temporary: save/fsync before `complete`.
pub struct VerifiedExport<'a> {
    client: &'a McpClient,
    kb_id: KbId,
    descriptor: ExportJob,
}

impl VerifiedExport<'_> {
    pub fn descriptor(&self) -> &ExportJob {
        &self.descriptor
    }

    /// A failed acknowledgement leaves the saved bytes valid; the server's
    /// ten-minute EOF grace releases the slot if this reply cannot be obtained.
    pub async fn complete(&self, ctl: &CallControl) -> Result<ExportCompleteOutput, ExportError> {
        let output = self
            .client
            .call_with_retry::<ExportComplete>(
                &TransferRef {
                    kb_id: self.kb_id.clone(),
                    transfer_id: self.descriptor.transfer_id.clone(),
                },
                ctl,
                2,
            )
            .await?;
        if output.transfer_id != self.descriptor.transfer_id {
            return Err(ExportError::InvalidFrame);
        }
        Ok(output)
    }
}

/// Starts (or, for the same key or scope, returns) a background export job.
pub async fn start_export(
    client: &McpClient,
    input: &ExportPrepareInput,
    ctl: &CallControl,
) -> Result<ExportJob, ExportError> {
    Ok(client
        .call_with_retry::<ExportPrepare>(input, ctl, 2)
        .await?)
}

fn job_ref(kb_id: &KbId, transfer_id: &Uuid) -> TransferRef {
    TransferRef {
        kb_id: kb_id.clone(),
        transfer_id: transfer_id.clone(),
    }
}

/// The current state of one of the caller's export jobs.
pub async fn export_status(
    client: &McpClient,
    kb_id: &KbId,
    transfer_id: &Uuid,
    ctl: &CallControl,
) -> Result<ExportJob, ExportError> {
    let job = client
        .call_with_retry::<ExportStatus>(&job_ref(kb_id, transfer_id), ctl, 3)
        .await?;
    if &job.transfer_id != transfer_id {
        return Err(ExportError::InvalidFrame);
    }
    Ok(job)
}

/// Cancels a pending/building job or discards a ready one; returns its state.
pub async fn cancel_export(
    client: &McpClient,
    kb_id: &KbId,
    transfer_id: &Uuid,
    ctl: &CallControl,
) -> Result<ExportJob, ExportError> {
    let job = client
        .call_with_retry::<ExportCancel>(&job_ref(kb_id, transfer_id), ctl, 2)
        .await?;
    if &job.transfer_id != transfer_id {
        return Err(ExportError::InvalidFrame);
    }
    Ok(job)
}

/// Polls until `job` leaves pending/building, for at most `max_wait` (and
/// never past `ctl`'s deadline or cancellation). `on_update` sees every polled
/// state (progress reporting). Ready → `Ok`; failed/cancelled/expired →
/// `NotReady`; still running at the bound → `StillRunning`.
pub async fn wait_for_export(
    client: &McpClient,
    kb_id: &KbId,
    job: ExportJob,
    max_wait: Duration,
    ctl: &CallControl,
    mut on_update: impl FnMut(&ExportJob),
) -> Result<ExportJob, ExportError> {
    let until = tokio::time::Instant::now() + max_wait;
    let mut interval = POLL_FIRST;
    let mut job = job;
    while job.state.is_running() {
        ctl.cancel.check().map_err(ClientError::from)?;
        ctl.deadline.check().map_err(ClientError::from)?;
        let now = tokio::time::Instant::now();
        if now >= until {
            return Err(ExportError::StillRunning(Box::new(job)));
        }
        let wake = (now + interval)
            .min(until)
            .min(tokio::time::Instant::from_std(ctl.deadline.instant()));
        tokio::select! {
            biased;
            () = ctl.cancel.cancelled() => return Err(ClientError::from(KbError::Cancelled).into()),
            () = tokio::time::sleep_until(wake) => {}
        }
        if tokio::time::Instant::now() >= until {
            return Err(ExportError::StillRunning(Box::new(job)));
        }
        // One poll may not outlive the wait bound: it gets the earlier of the
        // caller's deadline and `until`, and running into `until` is
        // "still running", not a failure.
        let poll_until = until.into_std().min(ctl.deadline.instant());
        let poll = CallControl::new(Deadline::at(poll_until), ctl.cancel.clone());
        job = match export_status(client, kb_id, &job.transfer_id, &poll).await {
            Ok(next) => next,
            Err(_)
                if tokio::time::Instant::now() >= until
                    && !ctl.deadline.is_expired()
                    && !ctl.cancel.is_cancelled() =>
            {
                return Err(ExportError::StillRunning(Box::new(job)));
            }
            Err(error) => return Err(error),
        };
        on_update(&job);
        interval = (interval + interval / 2).min(POLL_MAX);
    }
    if job.state == ExportState::Ready {
        Ok(job)
    } else {
        Err(ExportError::NotReady(Box::new(job)))
    }
}

/// Streams a ready job into a private destination. Retries repeat the exact
/// frame offset (including a lost EOF reply); memory is one frame. A write,
/// authority, cancellation or integrity failure never acknowledges.
pub async fn download_export<'a>(
    client: &'a McpClient,
    kb_id: &KbId,
    job: &ExportJob,
    destination: &mut impl Write,
    ctl: &CallControl,
) -> Result<VerifiedExport<'a>, ExportError> {
    if job.state != ExportState::Ready {
        return Err(ExportError::NotReady(Box::new(job.clone())));
    }
    let (Some(size), Some(content_hash)) = (job.size, job.content_hash.clone()) else {
        return Err(ExportError::InvalidFrame);
    };
    let mut hash = Context::new(&SHA256);
    let mut offset = 0;
    while offset < size {
        let frame = client
            .call_with_retry::<TransferRead>(
                &TransferReadInput {
                    kb_id: kb_id.clone(),
                    transfer_id: job.transfer_id.clone(),
                    offset,
                    max_bytes: Some(FRAME_BYTES),
                },
                ctl,
                3,
            )
            .await?;
        if frame.transfer_id != job.transfer_id
            || frame.offset != offset
            || frame.content_hash != content_hash
            || frame.next_offset <= offset
            || frame.next_offset > size
            || frame.next_offset - offset > FRAME_BYTES
            || frame.bytes_base64.len() > (FRAME_BYTES as usize / 3) * 4
            || frame.eof != (frame.next_offset == size)
        {
            return Err(ExportError::InvalidFrame);
        }
        let bytes = STANDARD
            .decode(&frame.bytes_base64)
            .map_err(|_| ExportError::InvalidFrame)?;
        if bytes.len() as u64 != frame.next_offset - offset {
            return Err(ExportError::InvalidFrame);
        }
        ctl.cancel.check().map_err(ClientError::from)?;
        ctl.deadline.check().map_err(ClientError::from)?;
        destination.write_all(&bytes).map_err(ExportError::Io)?;
        hash.update(&bytes);
        offset = frame.next_offset;
    }
    let digest: String = hash
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if content_hash.as_str() != format!("sha256:{digest}") {
        return Err(ExportError::HashMismatch);
    }
    ctl.cancel.check().map_err(ClientError::from)?;
    ctl.deadline.check().map_err(ClientError::from)?;
    Ok(VerifiedExport {
        client,
        kb_id: kb_id.clone(),
        descriptor: job.clone(),
    })
}
