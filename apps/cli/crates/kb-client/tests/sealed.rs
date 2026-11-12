//! Host-only sealed resolution, the agent ciphertext projection and
//! the explicit travel helper.
//!
//! The crypto vector is the shared server fixture
//! (`packages/api/src/lib/kb/fixtures/sealed.json`), produced by the TS
//! `createRecipientEnvelope` with fixed X25519 seeds and nonce.

mod common;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use common::{ctl, err, ok, tool_server};
use kb_client::attachment::{VerifiedAttachment, remote_attachment_namespace, verify_attachment};
use kb_client::sealed::{
    RecipientKey, SEALED_MAX_TTL, SealedError, SealedReference, TravelAuthorization,
    forward_sealed_resolve, open_envelope, resolve_sealed,
};
use kb_client::types::{KbAttachment, KbId, SealedResolveInput, SealedResolveOutput, Uuid};
use kb_client::{ErrorCode, KbLocator, TransportPolicy};
use serde_json::{Value, json};

/// `unwrap_err` without requiring `Debug` on the success value (a
/// `SecretLiteral` deliberately has none).
trait Fails {
    fn fails(self) -> SealedError;
}

impl<T> Fails for Result<T, SealedError> {
    fn fails(self) -> SealedError {
        match self {
            Ok(_) => panic!("expected a sealed error"),
            Err(error) => error,
        }
    }
}

const KB_A: &str = "abcdefghijklmnopqrstuvwx";
const KB_B: &str = "zyxwvutsrqponmlkjihgfedc";
const HEAD: &str = "2222222222222222222222222222222222222222";

fn vector() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/api/src/lib/kb/fixtures/sealed.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("test fixture"))
        .expect("test fixture")
}

fn hex32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("test fixture");
    }
    out
}

fn uuid(text: &str) -> Uuid {
    Uuid::parse(text).expect("test fixture")
}

fn result_of(v: &Value) -> SealedResolveOutput {
    serde_json::from_value(v["result"].clone()).expect("test fixture")
}

fn recipient(v: &Value) -> RecipientKey {
    RecipientKey::from_bytes(
        uuid(
            v["result"]["recipientKeyId"]
                .as_str()
                .expect("test fixture"),
        ),
        hex32(v["recipientPrivateKey"].as_str().expect("test fixture")),
    )
}

fn reference_of(v: &Value) -> SealedReference {
    v["result"]["reference"]
        .as_str()
        .expect("test fixture")
        .parse()
        .expect("test fixture")
}

/// 2026-01-15T12:00:00Z, the vector's frozen "now" (expiry is +60s).
fn frozen_now() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_768_478_400)
}

fn plaintext(v: &Value) -> String {
    v["plaintext"].as_str().expect("test fixture").to_owned()
}

#[test]
fn shared_vector_decrypts_exactly() {
    let v = vector();
    let key = recipient(&v);
    assert_eq!(
        key.public_key_base64(),
        v["recipientPublicKey"].as_str().expect("test fixture")
    );
    let literal =
        open_envelope(&key, &reference_of(&v), &result_of(&v), frozen_now()).expect("decrypts");
    assert_eq!(literal.expose_secret(), plaintext(&v).as_bytes());
    assert_eq!(literal.expose_str(), Some(plaintext(&v).as_str()));
    assert_eq!(SEALED_MAX_TTL, Duration::from_secs(60));
}

#[test]
fn wrong_recipient_aad_expiry_or_tampering_fails() {
    let v = vector();
    let key = recipient(&v);
    let reference = reference_of(&v);
    let good = result_of(&v);
    let now = frozen_now();

    // Wrong recipient private key.
    let wrong = RecipientKey::from_bytes(key.id().clone(), [3u8; 32]);
    assert_eq!(
        open_envelope(&wrong, &reference, &good, now).fails(),
        SealedError::Decrypt
    );

    // AAD: same key material under another key id authenticates nothing.
    let other_id = uuid("00000000-0000-4000-8000-000000000004");
    let mut relabelled = good.clone();
    relabelled.recipient_key_id = other_id.clone();
    let rekeyed = RecipientKey::from_bytes(
        other_id,
        hex32(v["recipientPrivateKey"].as_str().expect("test fixture")),
    );
    assert_eq!(
        open_envelope(&rekeyed, &reference, &relabelled, now).fails(),
        SealedError::Decrypt
    );
    // AAD: another reference (expected by the caller too) fails authentication.
    let mut moved = good.clone();
    moved.reference = good.reference.replace("000000000002", "000000000004");
    let moved_ref: SealedReference = moved.reference.parse().expect("test fixture");
    assert_eq!(
        open_envelope(&key, &moved_ref, &moved, now).fails(),
        SealedError::Decrypt
    );
    // AAD: an earlier expiry still inside the window fails authentication.
    let mut shortened = good.clone();
    shortened.expires_at = "2026-01-15T12:00:59.000Z".parse().expect("test fixture");
    assert_eq!(
        open_envelope(&key, &reference, &shortened, now).fails(),
        SealedError::Decrypt
    );

    // Answer for a reference or recipient the host did not ask for.
    assert_eq!(
        open_envelope(&key, &moved_ref, &good, now).fails(),
        SealedError::ReferenceMismatch
    );
    assert_eq!(
        open_envelope(
            &rekeyed_for(&v, "00000000-0000-4000-8000-000000000009"),
            &reference,
            &good,
            now
        )
        .fails(),
        SealedError::RecipientMismatch
    );

    // Expiry: exactly 60s is allowed, at/after expiry and >60s are not.
    assert!(open_envelope(&key, &reference, &good, now).is_ok());
    assert_eq!(
        open_envelope(&key, &reference, &good, now + Duration::from_secs(60)).fails(),
        SealedError::Expired
    );
    assert_eq!(
        open_envelope(&key, &reference, &good, now + Duration::from_secs(3600)).fails(),
        SealedError::Expired
    );
    assert_eq!(
        open_envelope(&key, &reference, &good, now - Duration::from_secs(1)).fails(),
        SealedError::ExpiryTooLong
    );

    // Tampered nonce / ciphertext / tag.
    for field in ["nonce", "ciphertext"] {
        let mut tampered = good.clone();
        let text = if field == "nonce" {
            &mut tampered.envelope.nonce
        } else {
            &mut tampered.envelope.ciphertext
        };
        let mut bytes = STANDARD.decode(text.as_bytes()).expect("test fixture");
        bytes[0] ^= 1;
        *text = STANDARD.encode(&bytes);
        assert_eq!(
            open_envelope(&key, &reference, &tampered, now).fails(),
            SealedError::Decrypt,
            "{field}"
        );
    }
    let mut last = good.clone();
    let mut bytes = STANDARD
        .decode(last.envelope.ciphertext.as_bytes())
        .expect("test fixture");
    let end = bytes.len() - 1;
    bytes[end] ^= 0x80;
    last.envelope.ciphertext = STANDARD.encode(&bytes);
    assert_eq!(
        open_envelope(&key, &reference, &last, now).fails(),
        SealedError::Decrypt
    );
}

fn rekeyed_for(v: &Value, id: &str) -> RecipientKey {
    RecipientKey::from_bytes(
        uuid(id),
        hex32(v["recipientPrivateKey"].as_str().expect("test fixture")),
    )
}

#[test]
fn malformed_envelopes_and_zero_shared_secret_are_rejected() {
    let v = vector();
    let key = recipient(&v);
    let reference = reference_of(&v);
    let good = result_of(&v);
    let now = frozen_now();
    let set = |f: &dyn Fn(&mut SealedResolveOutput)| {
        let mut out = good.clone();
        f(&mut out);
        open_envelope(&key, &reference, &out, now).fails()
    };
    // All-zero and small-order ephemeral keys give an all-zero shared secret.
    assert_eq!(
        set(&|o| o.envelope.ephemeral_public_key = STANDARD.encode([0u8; 32])),
        SealedError::ZeroSharedSecret
    );
    let mut one = [0u8; 32];
    one[0] = 1;
    assert_eq!(
        set(&|o| o.envelope.ephemeral_public_key = STANDARD.encode(one)),
        SealedError::ZeroSharedSecret
    );
    for bad in [
        String::new(),
        "!".repeat(44),
        STANDARD.encode([7u8; 31]),
        STANDARD.encode([7u8; 33]),
        // Non-canonical trailing bits.
        format!("{}B=", &STANDARD.encode([7u8; 32])[..42]),
    ] {
        assert_eq!(
            set(&|o| o.envelope.ephemeral_public_key = bad.clone()),
            SealedError::MalformedEnvelope,
            "{bad}"
        );
    }
    for nonce in [
        STANDARD.encode([0u8; 11]),
        STANDARD.encode([0u8; 13]),
        "AA".into(),
    ] {
        assert_eq!(
            set(&|o| o.envelope.nonce = nonce.clone()),
            SealedError::MalformedEnvelope,
            "{nonce}"
        );
    }
    assert_eq!(
        set(&|o| o.envelope.ciphertext = STANDARD.encode([0u8; 15])),
        SealedError::MalformedEnvelope
    );
}

#[test]
fn secrets_never_reach_debug_or_error_text() {
    let v = vector();
    let key = recipient(&v);
    let canary = plaintext(&v);
    let literal =
        open_envelope(&key, &reference_of(&v), &result_of(&v), frozen_now()).expect("decrypts");
    // Everything a host might log around a resolution.
    let mut logs = vec![
        format!("{key:?}"),
        format!("{:?}", result_of(&v)),
        format!("{:?}", reference_of(&v)),
    ];
    for error in [
        SealedError::Decrypt,
        SealedError::Expired,
        SealedError::ZeroSharedSecret,
        SealedError::MalformedEnvelope,
    ] {
        logs.push(format!("{error:?} {error}"));
    }
    for line in &logs {
        assert!(!line.contains(&canary), "{line}");
        assert!(!line.contains("0202020202"), "{line}");
    }
    assert!(format!("{key:?}").contains("redacted"));
    drop(literal);
}

// ── Wire: host resolve vs agent forwarding ──────────────────────────────────

fn attachment_on(server: &common::ToolServer, id: &str) -> VerifiedAttachment {
    let loc = KbLocator::new(server.resource(), KbId::parse(id).expect("test fixture"));
    let ns = remote_attachment_namespace(&loc);
    let kb: KbAttachment = serde_json::from_value(json!({
        "id": id, "name": "Alpha", "slug": "alpha", "description": "Synthetic sealed attachment.",
        "defaultBranch": "main", "headSha": HEAD, "metadataVersion": 1,
        "capabilities": ["read"], "writeMode": "read_only", "embeddingGeneration": null,
        "attachmentLocator": loc.as_string(), "sealedNamespace": ns.as_str(),
    }))
    .expect("test fixture");
    verify_attachment(&loc, kb).expect("test fixture")
}

fn iso(at: SystemTime) -> String {
    let secs = at
        .duration_since(UNIX_EPOCH)
        .expect("test fixture")
        .as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Test-only sender side of the wire derivation (the server's role).
fn seal(
    reference: &str,
    recipient_id: &str,
    recipient_public: [u8; 32],
    expires_at: &str,
    plaintext: &[u8],
) -> Value {
    use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
    use ring::hkdf::{HKDF_SHA256, Salt};
    let ephemeral = x25519_dalek::StaticSecret::from([9u8; 32]);
    let ephemeral_public = x25519_dalek::PublicKey::from(&ephemeral);
    let shared = ephemeral.diffie_hellman(&x25519_dalek::PublicKey::from(recipient_public));
    let salt = ring::digest::digest(&ring::digest::SHA256, reference.as_bytes());
    let info = format!("kb/sealed/1\0{recipient_id}\0{expires_at}");
    let info_parts = [info.as_bytes()];
    let prk = Salt::new(HKDF_SHA256, salt.as_ref()).extract(shared.as_bytes());
    let okm = prk.expand(&info_parts, &AES_256_GCM).expect("test fixture");
    let key = LessSafeKey::new(UnboundKey::from(okm));
    let nonce = [5u8; 12];
    let aad = format!("{reference}\0{recipient_id}\0{expires_at}");
    let mut buffer = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(aad.as_bytes()),
        &mut buffer,
    )
    .expect("test fixture");
    json!({
        "reference": reference, "recipientKeyId": recipient_id, "expiresAt": expires_at,
        "envelope": {
            "algorithm": "X25519-HKDF-SHA256-AES256GCM",
            "ephemeralPublicKey": STANDARD.encode(ephemeral_public.as_bytes()),
            "nonce": STANDARD.encode(nonce),
            "ciphertext": STANDARD.encode(&buffer),
        },
    })
}

const CANARY: &str = "wire-sealed-canary-7c1d";
const RECIPIENT_ID: &str = "00000000-0000-4000-8000-0000000000c1";
const RECORD: &str = "00000000-0000-4000-8000-0000000000d1";

#[tokio::test]
async fn host_resolve_decrypts_and_agent_projection_forwards_ciphertext_unchanged() {
    let key = RecipientKey::from_bytes(uuid(RECIPIENT_ID), [4u8; 32]);
    let public = STANDARD
        .decode(key.public_key_base64())
        .expect("test fixture");
    let public: [u8; 32] = public.try_into().expect("test fixture");
    let answer = std::sync::Arc::new(std::sync::Mutex::new(Value::Null));
    let slot = answer.clone();
    let server = tool_server(move |tool, _, _| {
        assert_eq!(tool, "knowledge_sealed_resolve");
        ok(slot.lock().expect("test fixture").clone())
    })
    .await;
    let attachment = attachment_on(&server, KB_A);
    let reference = SealedReference::new(attachment.namespace().clone(), uuid(RECORD));
    let expires = iso(SystemTime::now() + Duration::from_secs(30));
    let envelope = seal(
        &reference.to_string(),
        RECIPIENT_ID,
        public,
        &expires,
        CANARY.as_bytes(),
    );
    *answer.lock().expect("test fixture") = envelope.clone();

    let path = "notes/creds.md".parse().expect("test fixture");
    let literal = resolve_sealed(
        &server.client(),
        &attachment,
        &path,
        None,
        &reference,
        &key,
        &ctl(),
    )
    .await
    .expect("host resolves");
    assert_eq!(literal.expose_str(), Some(CANARY));
    let calls = server.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].arguments,
        json!({"kbId": KB_A, "path": "notes/creds.md", "reference": reference.to_string(),
               "recipientKeyId": RECIPIENT_ID})
    );

    // Agent-facing projection: ciphertext only, byte-identical to the wire.
    let input: SealedResolveInput =
        serde_json::from_value(calls[0].arguments.clone()).expect("test fixture");
    let forwarded = forward_sealed_resolve(&server.client(), &input, &ctl())
        .await
        .expect("forwarded");
    assert_eq!(
        serde_json::to_value(&forwarded).expect("test fixture"),
        envelope
    );
    let text = serde_json::to_string(&forwarded).expect("test fixture");
    assert!(!text.contains(CANARY));
    assert!(!format!("{forwarded:?}").contains(CANARY));
}

#[tokio::test]
async fn host_resolve_refuses_foreign_namespaces_before_any_request() {
    let key = RecipientKey::from_bytes(uuid(RECIPIENT_ID), [4u8; 32]);
    let server = tool_server(|_, _, _| err(ErrorCode::UnresolvedReference, json!({}))).await;
    let attachment = attachment_on(&server, KB_A);
    let other = attachment_on(&server, KB_B);
    let foreign = SealedReference::new(other.namespace().clone(), uuid(RECORD));
    let path = "notes/creds.md".parse().expect("test fixture");
    assert_eq!(
        resolve_sealed(
            &server.client(),
            &attachment,
            &path,
            None,
            &foreign,
            &key,
            &ctl()
        )
        .await
        .fails(),
        SealedError::ForeignNamespace
    );
    assert!(server.calls().is_empty());
    // Server-side refusal stays a uniform unresolved error.
    let own = SealedReference::new(attachment.namespace().clone(), uuid(RECORD));
    let e = resolve_sealed(
        &server.client(),
        &attachment,
        &path,
        None,
        &own,
        &key,
        &ctl(),
    )
    .await
    .fails();
    assert!(matches!(e, SealedError::Client(_)), "{e:?}");
}

#[test]
fn references_parse_only_the_v1_grammar() {
    let good = "{{sealed:v1:knowledge_base:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002}}";
    let parsed: SealedReference = good.parse().expect("valid");
    assert_eq!(parsed.to_string(), good);
    assert_eq!(
        parsed.namespace().as_str(),
        "00000000-0000-4000-8000-000000000001"
    );
    for bad in [
        "",
        "{{sealed:v2:knowledge_base:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002}}",
        "{{sealed:v1:knowledge_base:00000000-0000-4000-8000-000000000001}}",
        "{{sealed:v1:knowledge_base:00000000-0000-4000-8000-00000000000G:00000000-0000-4000-8000-000000000002}}",
        " {{sealed:v1:knowledge_base:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002}}",
    ] {
        assert_eq!(
            bad.parse::<SealedReference>().fails(),
            SealedError::MalformedReference,
            "{bad}"
        );
    }
}

// ── Travel ──────────────────────────────────────────────────────────────────

fn verified(origin: &str, id: &str) -> VerifiedAttachment {
    let loc = KbLocator::parse(&format!("{origin}/mcp#kb={id}"), TransportPolicy::HttpsOnly)
        .expect("test fixture");
    let ns = remote_attachment_namespace(&loc);
    let kb: KbAttachment = serde_json::from_value(json!({
        "id": id, "name": "Travel", "slug": "travel", "description": "Synthetic travel attachment.",
        "defaultBranch": "main", "headSha": HEAD, "metadataVersion": 1,
        "capabilities": ["read"], "writeMode": "read_only", "embeddingGeneration": null,
        "attachmentLocator": loc.as_string(), "sealedNamespace": ns.as_str(),
    }))
    .expect("test fixture");
    verify_attachment(&loc, kb).expect("test fixture")
}

#[test]
fn travel_requires_a_separate_destination_enrollment() {
    let source = verified("https://kb.example.test", KB_A);
    let destination = verified("https://kb2.example.test", KB_A);
    let record = uuid(RECORD);
    let src_ref = SealedReference::new(source.namespace().clone(), record.clone());
    let enrolled = SealedReference::new(
        destination.namespace().clone(),
        uuid("00000000-0000-4000-8000-0000000000e1"),
    );
    let auth = TravelAuthorization::new(&source, src_ref.clone(), &destination, enrolled.clone())
        .expect("authorized");
    let markdown = format!("token: {src_ref}\nagain {src_ref}\n");
    assert_eq!(
        auth.rewrite_markdown(&markdown),
        format!("token: {enrolled}\nagain {enrolled}\n")
    );

    // Namespace substitution is not an enrollment: a reference claiming the
    // destination namespace must be the one the destination enrollment
    // minted — a source reference is refused as the destination.
    assert_eq!(
        TravelAuthorization::new(&source, src_ref.clone(), &destination, src_ref.clone()).fails(),
        SealedError::ForeignNamespace
    );
    // Destination reference from a third KB.
    let third = verified("https://kb.example.test", KB_B);
    let stray = SealedReference::new(third.namespace().clone(), record.clone());
    assert_eq!(
        TravelAuthorization::new(&source, src_ref.clone(), &destination, stray).fails(),
        SealedError::ForeignNamespace
    );
    // Source reference not in the source attachment.
    assert_eq!(
        TravelAuthorization::new(&source, enrolled.clone(), &destination, enrolled.clone()).fails(),
        SealedError::ForeignNamespace
    );
    // Travelling within one attachment is not travel.
    let same = SealedReference::new(
        source.namespace().clone(),
        uuid("00000000-0000-4000-8000-0000000000e2"),
    );
    assert_eq!(
        TravelAuthorization::new(&source, src_ref.clone(), &source, same).fails(),
        SealedError::SameAttachment
    );

    // The literal is only lent to the explicit enrollment callback.
    let v = vector();
    let literal = open_envelope(
        &recipient(&v),
        &reference_of(&v),
        &result_of(&v),
        frozen_now(),
    )
    .expect("decrypts");
    let carried = auth.carry(&literal, |target, bytes| (target.to_string(), bytes.len()));
    assert_eq!(carried, (enrolled.to_string(), plaintext(&v).len()));
}
