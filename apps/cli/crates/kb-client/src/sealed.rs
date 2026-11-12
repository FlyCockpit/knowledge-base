//! Sealed values for hosts (Cockpit `RemoteResolver`, CONTRACT "Sealed values
//! and Cockpit adapter").
//!
//! * [`resolve_sealed`] is the only way to obtain plaintext: an explicit host
//!   call that decrypts the recipient envelope into a [`SecretLiteral`] —
//!   zeroized on drop, with no `Debug`, `Display`, `Clone` or `Serialize`.
//! * [`forward_sealed_resolve`] is the agent-forwarding projection: it returns
//!   the server's envelope unchanged (ciphertext only) and never decrypts.
//! * Wire derivation (fixed): `shared = X25519(recipient, ephemeral)`,
//!   rejected when all-zero; `key = HKDF-SHA256(salt = SHA-256(reference),
//!   ikm = shared, info = "kb/sealed/1\0<recipientKeyId>\0<expiresAt>")`;
//!   AES-256-GCM, 12-byte nonce, 16-byte tag appended, AAD =
//!   `reference\0recipientKeyId\0expiresAt`. The envelope must expire within
//!   `(0, 60s]` of the host clock.
//! * [`TravelAuthorization`] moves a literal between attachments only into a
//!   destination reference minted by a separate destination enrollment;
//!   there is no namespace substitution.

use std::fmt;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::digest::{SHA256, digest};
use ring::hkdf::{HKDF_SHA256, Salt};
use ring::rand::{SecureRandom, SystemRandom};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::attachment::VerifiedAttachment;
use crate::client::{CallControl, ClientError, McpClient};
use crate::types::{
    IsoInstant, KbPath, SealedAlgorithm, SealedEnvelope, SealedResolve, SealedResolveInput,
    SealedResolveOutput, Sha, Uuid,
};

/// Longest accepted envelope lifetime.
pub const SEALED_MAX_TTL: Duration = Duration::from_secs(60);
const TAG_LEN: usize = 16;
const REFERENCE_PREFIX: &str = "{{sealed:v1:knowledge_base:";
const REFERENCE_SUFFIX: &str = "}}";

/// Every sealed failure. Display text is fixed and never contains a
/// reference, key or literal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SealedError {
    Client(ClientError),
    /// Not `{{sealed:v1:knowledge_base:<uuid>:<uuid>}}`.
    MalformedReference,
    /// The reference is not in the attachment's sealed namespace.
    ForeignNamespace,
    /// The attachment is on another server than the client.
    ResourceMismatch,
    /// The answer is for another reference than requested.
    ReferenceMismatch,
    /// The answer is for another recipient key than ours.
    RecipientMismatch,
    /// `expiresAt` is at or before the host clock.
    Expired,
    /// `expiresAt` is more than 60 seconds ahead.
    ExpiryTooLong,
    /// Bad base64, key, nonce or ciphertext size.
    MalformedEnvelope,
    /// The ephemeral key yields an all-zero shared secret.
    ZeroSharedSecret,
    /// Authentication failed (wrong key, AAD or tampering).
    Decrypt,
    /// Travel source and destination are the same attachment.
    SameAttachment,
    /// The OS random source failed.
    Random,
}

impl fmt::Display for SealedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SealedError::Client(error) => error.fmt(f),
            SealedError::MalformedReference => f.write_str("malformed sealed reference"),
            SealedError::ForeignNamespace => {
                f.write_str("sealed reference is outside the attachment namespace")
            }
            SealedError::ResourceMismatch => {
                f.write_str("sealed attachment belongs to a different kb server")
            }
            SealedError::ReferenceMismatch => {
                f.write_str("sealed envelope is for a different reference")
            }
            SealedError::RecipientMismatch => {
                f.write_str("sealed envelope is for a different recipient key")
            }
            SealedError::Expired => f.write_str("sealed envelope expired"),
            SealedError::ExpiryTooLong => f.write_str("sealed envelope lifetime exceeds 60s"),
            SealedError::MalformedEnvelope => f.write_str("malformed sealed envelope"),
            SealedError::ZeroSharedSecret => f.write_str("sealed envelope key is invalid"),
            SealedError::Decrypt => f.write_str("sealed envelope failed authentication"),
            SealedError::SameAttachment => {
                f.write_str("sealed travel needs a different destination attachment")
            }
            SealedError::Random => f.write_str("os random source failed"),
        }
    }
}

impl std::error::Error for SealedError {}

impl From<ClientError> for SealedError {
    fn from(error: ClientError) -> Self {
        SealedError::Client(error)
    }
}

/// `{{sealed:v1:knowledge_base:<namespace>:<recordId>}}` — an opaque,
/// non-secret symbolic token.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SealedReference {
    namespace: Uuid,
    record_id: Uuid,
}

impl SealedReference {
    pub fn new(namespace: Uuid, record_id: Uuid) -> Self {
        SealedReference {
            namespace,
            record_id,
        }
    }

    pub fn namespace(&self) -> &Uuid {
        &self.namespace
    }

    pub fn record_id(&self) -> &Uuid {
        &self.record_id
    }
}

impl FromStr for SealedReference {
    type Err = SealedError;

    fn from_str(text: &str) -> Result<Self, SealedError> {
        let inner = text
            .strip_prefix(REFERENCE_PREFIX)
            .and_then(|rest| rest.strip_suffix(REFERENCE_SUFFIX))
            .ok_or(SealedError::MalformedReference)?;
        let (namespace, record) = inner
            .split_once(':')
            .ok_or(SealedError::MalformedReference)?;
        let parse = |s: &str| Uuid::parse(s).map_err(|_| SealedError::MalformedReference);
        Ok(SealedReference::new(parse(namespace)?, parse(record)?))
    }
}

impl fmt::Display for SealedReference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{REFERENCE_PREFIX}{}:{}{REFERENCE_SUFFIX}",
            self.namespace, self.record_id
        )
    }
}

/// A decrypted sealed literal. Zeroized on drop; it has no `Debug`,
/// `Display`, `Clone` or `Serialize`, so it cannot reach logs, agent-visible
/// data or snippets by accident.
///
/// ```compile_fail
/// fn needs_debug<T: std::fmt::Debug>() {}
/// needs_debug::<kb_client::sealed::SecretLiteral>();
/// ```
///
/// ```compile_fail
/// fn needs_serialize<T: serde::Serialize>() {}
/// needs_serialize::<kb_client::sealed::SecretLiteral>();
/// ```
///
/// ```compile_fail
/// fn needs_display<T: std::fmt::Display>() {}
/// needs_display::<kb_client::sealed::SecretLiteral>();
/// ```
///
/// ```compile_fail
/// fn needs_clone<T: Clone>() {}
/// needs_clone::<kb_client::sealed::SecretLiteral>();
/// ```
///
/// It is still an ordinary owned value a host can move across threads (the
/// same bounds compile for ordinary types, so the failures above are real):
///
/// ```
/// fn needs_send<T: Send + Sync>() {}
/// needs_send::<kb_client::sealed::SecretLiteral>();
/// fn needs_serialize<T: serde::Serialize>() {}
/// needs_serialize::<kb_client::types::Uuid>();
/// fn needs_debug<T: std::fmt::Debug + std::fmt::Display + Clone>() {}
/// needs_debug::<kb_client::types::Uuid>();
/// ```
pub struct SecretLiteral(Zeroizing<Vec<u8>>);

impl SecretLiteral {
    /// The literal bytes, for the host's own sealed action only.
    pub fn expose_secret(&self) -> &[u8] {
        &self.0
    }

    /// The literal as UTF-8 text, when it is.
    pub fn expose_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.0).ok()
    }
}

/// A host's long-lived X25519 recipient key and its registered key id.
/// The private half never appears in `Debug` and cannot be serialized.
pub struct RecipientKey {
    id: Uuid,
    secret: StaticSecret,
}

impl RecipientKey {
    /// Load a stored private key (clamped per RFC 7748).
    pub fn from_bytes(id: Uuid, private_key: [u8; 32]) -> Self {
        let private_key = Zeroizing::new(private_key);
        RecipientKey {
            id,
            secret: StaticSecret::from(*private_key),
        }
    }

    /// A fresh key from the OS random source.
    pub fn generate(id: Uuid) -> Result<Self, SealedError> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        SystemRandom::new()
            .fill(bytes.as_mut())
            .map_err(|_| SealedError::Random)?;
        Ok(Self::from_bytes(id, *bytes))
    }

    pub fn id(&self) -> &Uuid {
        &self.id
    }

    /// Canonical base64 public key, as registered at enrollment.
    pub fn public_key_base64(&self) -> String {
        STANDARD.encode(PublicKey::from(&self.secret).as_bytes())
    }
}

impl fmt::Debug for RecipientKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RecipientKey")
            .field("id", &self.id)
            .field("secret", &"[redacted]")
            .finish()
    }
}

fn decode_exact(text: &str, len: usize) -> Result<Vec<u8>, SealedError> {
    let bytes = STANDARD
        .decode(text.as_bytes())
        .map_err(|_| SealedError::MalformedEnvelope)?;
    if bytes.len() != len {
        return Err(SealedError::MalformedEnvelope);
    }
    Ok(bytes)
}

/// Convert a validated wire expiry using the shared RFC3339 parser.
pub fn system_time(instant: &IsoInstant) -> Result<SystemTime, SealedError> {
    let (seconds, fraction) =
        crate::schema::parse_iso_instant(instant.as_str()).ok_or(SealedError::MalformedEnvelope)?;
    let seconds = u64::try_from(seconds).map_err(|_| SealedError::Expired)?;
    let nanos: u32 = format!("{fraction:0<9}")
        .get(..9)
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(0);
    Ok(UNIX_EPOCH + Duration::new(seconds, nanos))
}

/// Decrypt a `knowledge_sealed_resolve` answer for `key`, as of `now`.
/// Host-only; prefer [`resolve_sealed`].
pub fn open_envelope(
    key: &RecipientKey,
    expected: &SealedReference,
    output: &SealedResolveOutput,
    now: SystemTime,
) -> Result<SecretLiteral, SealedError> {
    let reference = expected.to_string();
    if output.reference != reference {
        return Err(SealedError::ReferenceMismatch);
    }
    if output.recipient_key_id != key.id {
        return Err(SealedError::RecipientMismatch);
    }
    let ttl = system_time(&output.expires_at)?
        .duration_since(now)
        .map_err(|_| SealedError::Expired)?;
    if ttl.is_zero() {
        return Err(SealedError::Expired);
    }
    if ttl > SEALED_MAX_TTL {
        return Err(SealedError::ExpiryTooLong);
    }

    let envelope = &output.envelope;
    let ephemeral: [u8; 32] = decode_exact(&envelope.ephemeral_public_key, 32)?
        .try_into()
        .map_err(|_| SealedError::MalformedEnvelope)?;
    let nonce: [u8; NONCE_LEN] = decode_exact(&envelope.nonce, NONCE_LEN)?
        .try_into()
        .map_err(|_| SealedError::MalformedEnvelope)?;
    let mut sealed = Zeroizing::new(
        STANDARD
            .decode(envelope.ciphertext.as_bytes())
            .map_err(|_| SealedError::MalformedEnvelope)?,
    );
    if sealed.len() < TAG_LEN {
        return Err(SealedError::MalformedEnvelope);
    }

    let shared = key.secret.diffie_hellman(&PublicKey::from(ephemeral));
    if !shared.was_contributory() {
        return Err(SealedError::ZeroSharedSecret);
    }
    let aead = envelope_key(
        shared.as_bytes(),
        &reference,
        &output.recipient_key_id,
        &output.expires_at,
    )?;
    let aad = envelope_aad(&reference, &output.recipient_key_id, &output.expires_at);
    let plaintext_len = aead
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad.as_bytes()),
            sealed.as_mut_slice(),
        )
        .map_err(|_| SealedError::Decrypt)?
        .len();
    sealed.truncate(plaintext_len);
    Ok(SecretLiteral(sealed))
}

fn envelope_aad(reference: &str, id: &Uuid, expires: &IsoInstant) -> String {
    format!("{reference}\0{id}\0{expires}")
}
fn envelope_key(
    shared: &[u8],
    reference: &str,
    id: &Uuid,
    expires: &IsoInstant,
) -> Result<LessSafeKey, SealedError> {
    let salt = digest(&SHA256, reference.as_bytes());
    let info = format!("kb/sealed/1\0{id}\0{expires}");
    let parts = [info.as_bytes()];
    let prk = Salt::new(HKDF_SHA256, salt.as_ref()).extract(shared);
    let okm = prk
        .expand(&parts, &AES_256_GCM)
        .map_err(|_| SealedError::Decrypt)?;
    Ok(LessSafeKey::new(UnboundKey::from(okm)))
}
/// Canonical, contributory recipient public key. Also used by human approval.
pub fn validate_recipient_public_key(text: &str) -> Result<(), SealedError> {
    let public: [u8; 32] = decode_exact(text, 32)?
        .try_into()
        .map_err(|_| SealedError::MalformedEnvelope)?;
    if STANDARD.encode(public) != text {
        return Err(SealedError::MalformedEnvelope);
    }
    if !StaticSecret::from([1; 32])
        .diffie_hellman(&PublicKey::from(public))
        .was_contributory()
    {
        return Err(SealedError::ZeroSharedSecret);
    }
    Ok(())
}
/// The canonical (standard, padded) base64 spelling of a recipient public
/// key typed by a person: unpadded and URL-safe spellings of the same 32 bytes
/// are accepted; the result passes [`validate_recipient_public_key`].
pub fn canonical_recipient_public_key(text: &str) -> Result<String, SealedError> {
    use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    let text = text.trim();
    let bytes = [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD]
        .iter()
        .find_map(|engine| engine.decode(text).ok())
        .filter(|bytes| bytes.len() == 32)
        .ok_or(SealedError::MalformedEnvelope)?;
    let canonical = STANDARD.encode(bytes);
    validate_recipient_public_key(&canonical)?;
    Ok(canonical)
}
/// Backend wrapping seam. Returns only recipient ciphertext; derivation is
/// shared with host decryption, not reimplemented by the local backend.
pub fn create_envelope(
    plaintext: &[u8],
    reference: &SealedReference,
    id: &Uuid,
    recipient: &str,
    expires: IsoInstant,
    now: SystemTime,
) -> Result<SealedResolveOutput, SealedError> {
    let ttl = system_time(&expires)?
        .duration_since(now)
        .map_err(|_| SealedError::Expired)?;
    if ttl.is_zero() {
        return Err(SealedError::Expired);
    }
    if ttl > SEALED_MAX_TTL {
        return Err(SealedError::ExpiryTooLong);
    }
    let mut seed = Zeroizing::new([0; 32]);
    let mut nonce = [0; NONCE_LEN];
    SystemRandom::new()
        .fill(seed.as_mut())
        .map_err(|_| SealedError::Random)?;
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| SealedError::Random)?;
    seal_with_material(plaintext, reference, id, recipient, expires, *seed, nonce)
}
fn seal_with_material(
    plaintext: &[u8],
    reference: &SealedReference,
    id: &Uuid,
    recipient: &str,
    expires: IsoInstant,
    seed: [u8; 32],
    nonce: [u8; NONCE_LEN],
) -> Result<SealedResolveOutput, SealedError> {
    validate_recipient_public_key(recipient)?;
    let public: [u8; 32] = decode_exact(recipient, 32)?
        .try_into()
        .map_err(|_| SealedError::MalformedEnvelope)?;
    let seed = Zeroizing::new(seed);
    let ephemeral = StaticSecret::from(*seed);
    let shared = ephemeral.diffie_hellman(&PublicKey::from(public));
    let reference = reference.to_string();
    let aead = envelope_key(shared.as_bytes(), &reference, id, &expires)?;
    let aad = envelope_aad(&reference, id, &expires);
    let mut bytes = Zeroizing::new(plaintext.to_vec());
    aead.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(aad.as_bytes()),
        &mut *bytes,
    )
    .map_err(|_| SealedError::Decrypt)?;
    Ok(SealedResolveOutput {
        reference,
        recipient_key_id: id.clone(),
        expires_at: expires,
        envelope: SealedEnvelope {
            algorithm: SealedAlgorithm,
            ephemeral_public_key: STANDARD.encode(PublicKey::from(&ephemeral).as_bytes()),
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(&*bytes),
        },
    })
}

/// Explicit host resolution: request the envelope for `reference` at
/// `path`/`rev` of `attachment` and decrypt it with `key`. A reference
/// outside the attachment's namespace is refused before any request.
pub async fn resolve_sealed(
    client: &McpClient,
    attachment: &VerifiedAttachment,
    path: &KbPath,
    rev: Option<&Sha>,
    reference: &SealedReference,
    key: &RecipientKey,
    ctl: &CallControl,
) -> Result<SecretLiteral, SealedError> {
    if attachment.locator().resource() != client.resource() {
        return Err(SealedError::ResourceMismatch);
    }
    if reference.namespace() != attachment.namespace() {
        return Err(SealedError::ForeignNamespace);
    }
    let input = SealedResolveInput {
        kb_id: attachment.kb_id().clone(),
        rev: rev.cloned(),
        path: path.clone(),
        reference: reference.to_string(),
        recipient_key_id: key.id().clone(),
    };
    let output = client.call::<SealedResolve>(&input, ctl).await?;
    open_envelope(key, reference, &output, SystemTime::now())
}

/// Agent-forwarding projection: the server's recipient envelope, unchanged.
/// Ciphertext only; nothing here can decrypt it.
pub async fn forward_sealed_resolve(
    client: &McpClient,
    input: &SealedResolveInput,
    ctl: &CallControl,
) -> Result<SealedResolveOutput, SealedError> {
    let output = client.call::<SealedResolve>(input, ctl).await?;
    if output.reference != input.reference {
        return Err(SealedError::ReferenceMismatch);
    }
    if output.recipient_key_id != input.recipient_key_id {
        return Err(SealedError::RecipientMismatch);
    }
    Ok(output)
}

/// An explicitly authorized copy of one sealed literal from a source
/// attachment into a destination reference that a SEPARATE destination
/// enrollment minted. It never derives a destination reference from the
/// source (no namespace substitution); the destination enrollment (a human
/// control-plane operation) is a precondition, not something this does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TravelAuthorization {
    source: SealedReference,
    destination: SealedReference,
}

impl TravelAuthorization {
    pub fn new(
        source_attachment: &VerifiedAttachment,
        source: SealedReference,
        destination_attachment: &VerifiedAttachment,
        destination_enrollment: SealedReference,
    ) -> Result<Self, SealedError> {
        if source.namespace() != source_attachment.namespace() {
            return Err(SealedError::ForeignNamespace);
        }
        if source_attachment.namespace() == destination_attachment.namespace() {
            return Err(SealedError::SameAttachment);
        }
        if destination_enrollment.namespace() != destination_attachment.namespace() {
            return Err(SealedError::ForeignNamespace);
        }
        Ok(TravelAuthorization {
            source,
            destination: destination_enrollment,
        })
    }

    pub fn source(&self) -> &SealedReference {
        &self.source
    }

    pub fn destination(&self) -> &SealedReference {
        &self.destination
    }

    /// Replace exact occurrences of the source reference with the enrolled
    /// destination reference (symbolic tokens only; no literal involved).
    pub fn rewrite_markdown(&self, markdown: &str) -> String {
        markdown.replace(&self.source.to_string(), &self.destination.to_string())
    }

    /// Lend the literal to the explicit destination-enrollment callback.
    pub fn carry<R>(
        &self,
        literal: &SecretLiteral,
        enroll: impl FnOnce(&SealedReference, &[u8]) -> R,
    ) -> R {
        enroll(&self.destination, literal.expose_secret())
    }
}

#[cfg(test)]
mod encryption_tests {
    use super::*;
    #[test]
    fn encryption_matches_shared_server_fixture_exactly() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/kb/fixtures/sealed.json"
        ))
        .unwrap();
        let reference: SealedReference =
            v["result"]["reference"].as_str().unwrap().parse().unwrap();
        let key_id: Uuid = v["result"]["recipientKeyId"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let expires: IsoInstant = v["result"]["expiresAt"].as_str().unwrap().parse().unwrap();
        let result = seal_with_material(
            v["plaintext"].as_str().unwrap().as_bytes(),
            &reference,
            &key_id,
            v["recipientPublicKey"].as_str().unwrap(),
            expires,
            [1; 32],
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        )
        .unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), v["result"]);
    }
}
