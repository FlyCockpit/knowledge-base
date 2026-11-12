//! Per-KB attachment identity.
//!
//! A remote attachment is pinned by its canonical locator
//! `<canonical-origin>/mcp#kb=<id>`; a local managed-store attachment by
//! `kb-local://<storeUuid>/<kbId>`. The sealed namespace is
//! `UUIDv5(NAMESPACE_URL, b"flycockpit/knowledge-attachment/v1\0<remote|local>\0" + locator)`
//! — the exact Cockpit (F) `source_attachment_identity` algorithm and bytes.
//!
//! The client computes the namespace itself and never accepts one from the
//! server: [`verify_attachment`] rejects a returned locator or namespace that
//! differs from the expected attachment. A display-name change never changes
//! identity; an origin move is a different identity and needs an explicit
//! reattachment / sealed re-enrollment, never a silent rewrite.

use std::fmt;

use ring::digest::{SHA1_FOR_LEGACY_USE_ONLY, digest};

use crate::client::{CallControl, ClientError, McpClient};
use crate::origin::KbLocator;
use crate::types::{BasesGet, IndexStatus, KbAttachment, KbId, KbRef, Uuid};

/// RFC 4122 `NAMESPACE_URL` (`6ba7b811-9dad-11d1-80b4-00c04fd430c8`).
pub const NAMESPACE_URL: [u8; 16] = [
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
];

/// Domain-separation prefix shared with Cockpit's attachment identity.
pub const ATTACHMENT_NAME_PREFIX: &[u8] = b"flycockpit/knowledge-attachment/v1\0";

/// Name-based SHA-1 UUID (RFC 4122 version 5), canonical lowercase text.
pub fn uuid_v5(namespace: &[u8; 16], name: &[u8]) -> Uuid {
    let mut input = Vec::with_capacity(16 + name.len());
    input.extend_from_slice(namespace);
    input.extend_from_slice(name);
    let hash = digest(&SHA1_FOR_LEGACY_USE_ONLY, &input);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash.as_ref()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let text = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    Uuid::parse(&text).expect("a formatted v5 uuid is canonical")
}

fn attachment_namespace(kind: &[u8], locator: &str) -> Uuid {
    let mut name = ATTACHMENT_NAME_PREFIX.to_vec();
    name.extend_from_slice(kind);
    name.push(0);
    name.extend_from_slice(locator.as_bytes());
    uuid_v5(&NAMESPACE_URL, &name)
}

/// Sealed namespace of a remote attachment (its canonical locator string).
pub fn remote_attachment_namespace(locator: &KbLocator) -> Uuid {
    attachment_namespace(b"remote", &locator.as_string())
}

/// Canonical locator of a local managed-store KB.
pub fn local_attachment_locator(store: &Uuid, kb_id: &KbId) -> String {
    format!("kb-local://{store}/{kb_id}")
}

/// Sealed namespace of a local managed-store KB. It does not claim
/// equivalence with an arbitrary Cockpit worktree-path identity.
pub fn local_attachment_namespace(store: &Uuid, kb_id: &KbId) -> Uuid {
    attachment_namespace(b"local", &local_attachment_locator(store, kb_id))
}

/// Why a server-returned attachment was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttachmentError {
    /// The expected locator is on another origin than the client's resource;
    /// nothing was sent.
    ResourceMismatch,
    /// The server answered for a different KB id.
    KbMismatch,
    /// The returned locator is not exactly the expected canonical locator
    /// (origin moved or overridden): explicit reattachment is required.
    LocatorMismatch,
    /// The returned sealed namespace is not the one derived from the locator.
    NamespaceMismatch,
    Client(ClientError),
}

impl fmt::Display for AttachmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AttachmentError::ResourceMismatch => {
                f.write_str("kb attachment belongs to a different kb server")
            }
            AttachmentError::KbMismatch => f.write_str("kb server answered for a different kb"),
            AttachmentError::LocatorMismatch => f.write_str(
                "kb attachment locator changed; reattach and re-enroll sealed values explicitly",
            ),
            AttachmentError::NamespaceMismatch => {
                f.write_str("kb server returned a foreign sealed namespace")
            }
            AttachmentError::Client(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for AttachmentError {}

impl From<ClientError> for AttachmentError {
    fn from(error: ClientError) -> Self {
        AttachmentError::Client(error)
    }
}

/// An attachment whose locator and namespace were checked against the
/// client-derived identity. Only [`verify_attachment`] constructs one.
#[derive(Clone, Debug, PartialEq)]
pub struct VerifiedAttachment {
    locator: KbLocator,
    namespace: Uuid,
    attachment: KbAttachment,
}

impl VerifiedAttachment {
    pub fn locator(&self) -> &KbLocator {
        &self.locator
    }

    /// Client-derived sealed namespace (equal to the server's claim).
    pub fn namespace(&self) -> &Uuid {
        &self.namespace
    }

    pub fn kb_id(&self) -> &KbId {
        self.locator.kb_id()
    }

    /// The server's attachment row (display name, capabilities, ...).
    pub fn attachment(&self) -> &KbAttachment {
        &self.attachment
    }
}

/// Check a returned [`KbAttachment`] against the expected locator.
pub fn verify_attachment(
    expected: &KbLocator,
    returned: KbAttachment,
) -> Result<VerifiedAttachment, AttachmentError> {
    if &returned.id != expected.kb_id() {
        return Err(AttachmentError::KbMismatch);
    }
    // The namespace hashes exact bytes, so the canonical text must match
    // exactly — an equivalent-but-different spelling is not accepted.
    if returned.attachment_locator != expected.as_string() {
        return Err(AttachmentError::LocatorMismatch);
    }
    let namespace = remote_attachment_namespace(expected);
    if returned.sealed_namespace != namespace {
        return Err(AttachmentError::NamespaceMismatch);
    }
    Ok(VerifiedAttachment {
        locator: expected.clone(),
        namespace,
        attachment: returned,
    })
}

/// `knowledge_bases_get` for `locator` on this client's resource, verified.
/// A locator on another origin is refused before any I/O.
pub async fn attach(
    client: &McpClient,
    locator: &KbLocator,
    ctl: &CallControl,
) -> Result<(VerifiedAttachment, IndexStatus), AttachmentError> {
    if locator.resource() != client.resource() {
        return Err(AttachmentError::ResourceMismatch);
    }
    let input = KbRef {
        kb_id: locator.kb_id().clone(),
    };
    let out = client.call::<BasesGet>(&input, ctl).await?;
    Ok((verify_attachment(locator, out.kb)?, out.index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4122_v5_example() {
        // Python: uuid.uuid5(uuid.NAMESPACE_URL, "https://example.com/")
        assert_eq!(
            uuid_v5(&NAMESPACE_URL, b"https://example.com/").as_str(),
            "dd2c1780-811a-5296-81c5-178a0ef488bc"
        );
    }
}
