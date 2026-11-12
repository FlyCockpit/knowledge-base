//! Opaque HMAC page cursors (CONTRACT `Page`), byte-compatible with
//! `packages/api/src/lib/kb/cursor.ts`: a binary payload (version, expiry,
//! actor, KB, filter hash, sort key, pinned revision, final ordered key),
//! base64url-encoded, then `.` and the base64url HMAC-SHA256 of that text.
//!
//! The key is 32 random bytes in `state.sqlite` (`store_meta.cursor_key`),
//! inside the owner-only store root; it never leaves the process. Any
//! malformed, foreign, tampered, rebound or expired cursor is
//! `INVALID_CURSOR`. Authority is rechecked by callers independently.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use kb_client::types::Sha;
use ring::digest::{SHA256, digest};
use ring::hmac;

use crate::StoreError;
use crate::limits::{CURSOR_MAX_BYTES, CURSOR_TTL_SECS};

const MAX_LAST_KEY_BYTES: usize = 600;
const NULL_LAST_KEY: u16 = 0xffff;

/// The store's cursor key. `Debug` never prints it.
#[derive(Clone)]
pub(crate) struct CursorKey([u8; 32]);

impl std::fmt::Debug for CursorKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CursorKey(..)")
    }
}

impl CursorKey {
    pub(crate) fn from_slice(bytes: &[u8]) -> Result<CursorKey, StoreError> {
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| StoreError::RecoveryRequired("cursor key is malformed".into()))?;
        Ok(CursorKey(key))
    }

    pub(crate) fn hmac(&self) -> hmac::Key {
        hmac::Key::new(hmac::HMAC_SHA256, &self.0)
    }
}

/// What a cursor is bound to. `revision: None` = unpinned (TS `"*"`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Binding {
    pub actor_key: String,
    pub kb_id: String,
    pub filter_hash: [u8; 32],
    pub sort_key: &'static str,
}

/// A verified cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Cursor {
    pub revision: Option<Sha>,
    pub last_key: Option<String>,
    pub expires_ms: u64,
}

fn invalid() -> StoreError {
    StoreError::InvalidCursor
}

/// Stable filter hash of a canonical filter description.
pub(crate) fn filter_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut bytes = b"kb-local/cursor-filter/v1".to_vec();
    for part in parts {
        bytes.extend_from_slice(&(part.len() as u64).to_be_bytes());
        bytes.extend_from_slice(part);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(digest(&SHA256, &bytes).as_ref());
    out
}

fn push_prefixed(out: &mut Vec<u8>, value: &str, max: usize) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    if bytes.len() > max {
        return Err(invalid());
    }
    let len = u16::try_from(bytes.len()).map_err(|_| invalid())?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn encode(binding: &Binding, cursor: &Cursor) -> Result<Vec<u8>, StoreError> {
    let mut out = vec![1u8];
    if cursor.expires_ms >= 1 << 48 {
        return Err(invalid());
    }
    out.extend_from_slice(&cursor.expires_ms.to_be_bytes()[2..]);
    push_prefixed(&mut out, &binding.actor_key, 128)?;
    push_prefixed(&mut out, &binding.kb_id, 64)?;
    out.extend_from_slice(&binding.filter_hash);
    push_prefixed(&mut out, binding.sort_key, 32)?;
    match &cursor.revision {
        None => out.push(0),
        Some(sha) => {
            out.push(1);
            for pair in sha.as_str().as_bytes().chunks(2) {
                let text = std::str::from_utf8(pair).map_err(|_| invalid())?;
                out.push(u8::from_str_radix(text, 16).map_err(|_| invalid())?);
            }
        }
    }
    match &cursor.last_key {
        None => out.extend_from_slice(&NULL_LAST_KEY.to_be_bytes()),
        Some(key) => push_prefixed(&mut out, key, MAX_LAST_KEY_BYTES)?,
    }
    Ok(out)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], StoreError> {
        let end = self.at.checked_add(n).ok_or_else(invalid)?;
        let slice = self.bytes.get(self.at..end).ok_or_else(invalid)?;
        self.at = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, StoreError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn text(&mut self, len: u16, max: usize) -> Result<String, StoreError> {
        if usize::from(len) > max {
            return Err(invalid());
        }
        let bytes = self.take(usize::from(len))?;
        String::from_utf8(bytes.to_vec()).map_err(|_| invalid())
    }

    fn prefixed(&mut self, max: usize) -> Result<String, StoreError> {
        let len = self.u16()?;
        self.text(len, max)
    }
}

fn decode(bytes: &[u8]) -> Result<(Binding, Cursor, String), StoreError> {
    let mut r = Reader { bytes, at: 0 };
    if r.take(1)? != [1] {
        return Err(invalid());
    }
    let mut exp = [0u8; 8];
    exp[2..].copy_from_slice(r.take(6)?);
    let expires_ms = u64::from_be_bytes(exp);
    let actor_key = r.prefixed(128)?;
    let kb_id = r.prefixed(64)?;
    let mut filter_hash = [0u8; 32];
    filter_hash.copy_from_slice(r.take(32)?);
    let sort_key = r.prefixed(32)?;
    let revision = match r.take(1)?[0] {
        0 => None,
        1 => {
            let hex: String = r.take(20)?.iter().map(|b| format!("{b:02x}")).collect();
            Some(Sha::parse(&hex).map_err(|_| invalid())?)
        }
        _ => return Err(invalid()),
    };
    let last_len = r.u16()?;
    let last_key = if last_len == NULL_LAST_KEY {
        None
    } else {
        Some(r.text(last_len, MAX_LAST_KEY_BYTES)?)
    };
    if r.at != bytes.len() {
        return Err(invalid());
    }
    Ok((
        Binding {
            actor_key,
            kb_id,
            filter_hash,
            sort_key: "",
        },
        Cursor {
            revision,
            last_key,
            expires_ms,
        },
        sort_key,
    ))
}

/// Sign a cursor valid for [`CURSOR_TTL_SECS`] from `now_ms`.
pub(crate) fn sign(
    key: &CursorKey,
    binding: &Binding,
    revision: Option<Sha>,
    last_key: String,
    now_ms: u64,
) -> Result<String, StoreError> {
    let cursor = Cursor {
        revision,
        last_key: Some(last_key),
        expires_ms: now_ms.saturating_add(CURSOR_TTL_SECS * 1000),
    };
    sign_cursor(key, binding, &cursor)
}

/// Continuations retain the initial expiry rather than extending a page's pin.
pub(crate) fn sign_cursor(
    key: &CursorKey,
    binding: &Binding,
    cursor: &Cursor,
) -> Result<String, StoreError> {
    let body = URL_SAFE_NO_PAD.encode(encode(binding, cursor)?);
    let mac = URL_SAFE_NO_PAD.encode(hmac::sign(&key.hmac(), body.as_bytes()).as_ref());
    let token = format!("{body}.{mac}");
    if token.len() > CURSOR_MAX_BYTES {
        return Err(StoreError::Internal("cursor exceeds its size cap".into()));
    }
    Ok(token)
}

/// Verify `token` against `expected`; `revision` must equal the pinned one
/// when the caller supplies it.
pub(crate) fn verify(
    key: &CursorKey,
    token: &str,
    expected: &Binding,
    revision: Option<&Sha>,
    now_ms: u64,
) -> Result<Cursor, StoreError> {
    if token.len() > CURSOR_MAX_BYTES {
        return Err(invalid());
    }
    let (body, mac) = token.rsplit_once('.').ok_or_else(invalid)?;
    if body.is_empty() {
        return Err(invalid());
    }
    // Canonical base64url only (non-zero trailing bits are rejected), then a
    // constant-time MAC check over the exact body text.
    let mac = URL_SAFE_NO_PAD.decode(mac).map_err(|_| invalid())?;
    hmac::verify(&key.hmac(), body.as_bytes(), &mac).map_err(|_| invalid())?;
    let bytes = URL_SAFE_NO_PAD.decode(body).map_err(|_| invalid())?;
    let (binding, cursor, sort_key) = decode(&bytes)?;
    if cursor.expires_ms < now_ms {
        return Err(invalid());
    }
    if binding.actor_key != expected.actor_key
        || binding.kb_id != expected.kb_id
        || binding.filter_hash != expected.filter_hash
        || sort_key != expected.sort_key
        || cursor.last_key.is_none()
    {
        return Err(invalid());
    }
    if let Some(revision) = revision
        && cursor.revision.as_ref() != Some(revision)
    {
        return Err(invalid());
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> Binding {
        Binding {
            actor_key: "local:owner".into(),
            kb_id: "abcdefghijklmnopqrstuvwx".into(),
            filter_hash: filter_hash(&[b"docs/"]),
            sort_key: "path",
        }
    }

    fn rev() -> Sha {
        Sha::parse(&"ab".repeat(20)).expect("sha")
    }

    #[test]
    fn round_trip_and_rebinding() {
        let key = CursorKey([7; 32]);
        let token = sign(&key, &binding(), Some(rev()), "docs/a.md".into(), 1000).expect("sign");
        let cursor = verify(&key, &token, &binding(), None, 1000).expect("verify");
        assert_eq!(cursor.revision, Some(rev()));
        assert_eq!(cursor.last_key.as_deref(), Some("docs/a.md"));
        verify(&key, &token, &binding(), Some(&rev()), 1000).expect("pinned");
        let other = Sha::parse(&"cd".repeat(20)).expect("sha");
        assert!(verify(&key, &token, &binding(), Some(&other), 1000).is_err());
        for changed in [
            Binding {
                actor_key: "local:other".into(),
                ..binding()
            },
            Binding {
                kb_id: "bcdefghijklmnopqrstuvwxy".into(),
                ..binding()
            },
            Binding {
                filter_hash: filter_hash(&[b"other/"]),
                ..binding()
            },
            Binding {
                sort_key: "id",
                ..binding()
            },
        ] {
            assert!(matches!(
                verify(&key, &token, &changed, None, 1000),
                Err(StoreError::InvalidCursor)
            ));
        }
        // Another store's key.
        assert!(verify(&CursorKey([8; 32]), &token, &binding(), None, 1000).is_err());
    }

    #[test]
    fn expiry_is_exactly_fifteen_minutes() {
        let key = CursorKey([7; 32]);
        let token = sign(&key, &binding(), None, "k".into(), 1000).expect("sign");
        let ttl = CURSOR_TTL_SECS * 1000;
        verify(&key, &token, &binding(), None, 1000 + ttl).expect("last valid instant");
        assert!(verify(&key, &token, &binding(), None, 1001 + ttl).is_err());
    }

    #[test]
    fn every_single_byte_change_is_rejected() {
        let key = CursorKey([7; 32]);
        let token = sign(&key, &binding(), Some(rev()), "docs/a.md".into(), 1000).expect("sign");
        let bytes = token.as_bytes();
        for i in 0..bytes.len() {
            let mut changed = bytes.to_vec();
            changed[i] = if changed[i] == b'A' { b'B' } else { b'A' };
            let text = String::from_utf8(changed).expect("ascii");
            assert!(
                verify(&key, &text, &binding(), None, 1000).is_err(),
                "byte {i} of {token}"
            );
        }
        assert!(verify(&key, "", &binding(), None, 1000).is_err());
        assert!(verify(&key, &"a".repeat(2000), &binding(), None, 1000).is_err());
    }

    #[test]
    fn oversized_last_key_cannot_be_signed() {
        let key = CursorKey([7; 32]);
        assert!(sign(&key, &binding(), None, "x".repeat(601), 1000).is_err());
    }
}
