//! Bounded, verified export consumption. The verified receipt borrows the
//! preparing client, so acknowledgement always uses its exact credential.
//! Hosts must durably save the verified bytes before calling `complete`.

use std::{fmt, io::Write};

use base64::{Engine, engine::general_purpose::STANDARD};
use ring::digest::{Context, SHA256};

use crate::types::{
    ExportComplete, ExportCompleteOutput, ExportPrepare, ExportPrepareInput, ExportPrepareOutput,
    KbId, TransferRead, TransferReadInput, TransferRef,
};
use crate::{CallControl, ClientError, McpClient};

const FRAME_BYTES: u64 = 196608;

#[derive(Debug)]
pub enum ExportError {
    Client(ClientError),
    Io(std::io::Error),
    InvalidFrame,
    HashMismatch,
}

impl fmt::Display for ExportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Client(error) => error.fmt(f),
            Self::Io(_) => f.write_str("could not write export bytes"),
            Self::InvalidFrame => f.write_str("export frame does not match its descriptor"),
            Self::HashMismatch => f.write_str("export content hash does not verify"),
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
    descriptor: ExportPrepareOutput,
}

impl VerifiedExport<'_> {
    pub fn descriptor(&self) -> &ExportPrepareOutput {
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

/// Prepare and stream into a private destination. Retries repeat the exact
/// prepare key/frame offset (including a lost EOF reply); memory is one frame.
/// A write, authority, cancellation or integrity failure never acknowledges.
pub async fn download_export<'a>(
    client: &'a McpClient,
    input: &ExportPrepareInput,
    destination: &mut impl Write,
    ctl: &CallControl,
) -> Result<VerifiedExport<'a>, ExportError> {
    let descriptor = client
        .call_with_retry::<ExportPrepare>(input, ctl, 2)
        .await?;
    let mut hash = Context::new(&SHA256);
    let mut offset = 0;
    while offset < descriptor.size {
        let frame = client
            .call_with_retry::<TransferRead>(
                &TransferReadInput {
                    kb_id: input.kb_id.clone(),
                    transfer_id: descriptor.transfer_id.clone(),
                    offset,
                    max_bytes: Some(FRAME_BYTES),
                },
                ctl,
                3,
            )
            .await?;
        if frame.transfer_id != descriptor.transfer_id
            || frame.offset != offset
            || frame.content_hash != descriptor.content_hash
            || frame.next_offset <= offset
            || frame.next_offset > descriptor.size
            || frame.next_offset - offset > FRAME_BYTES
            || frame.bytes_base64.len() > (FRAME_BYTES as usize / 3) * 4
            || frame.eof != (frame.next_offset == descriptor.size)
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
    if descriptor.content_hash.as_str() != format!("sha256:{digest}") {
        return Err(ExportError::HashMismatch);
    }
    ctl.cancel.check().map_err(ClientError::from)?;
    ctl.deadline.check().map_err(ClientError::from)?;
    Ok(VerifiedExport {
        client,
        kb_id: input.kb_id.clone(),
        descriptor,
    })
}
