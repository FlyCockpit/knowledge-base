//! Human-only local sealed control and common ciphertext resolution.
//! Ownership/order: store-key credential fence -> store -> sorted KB -> SQLite.
//! No keystore I/O holds a store fence. The initial key slot precedes native write;
//! records require READY, never key regeneration. Native children reopen their
//! effect fence before input. Final wrapping/rechecks are synchronous under authority.
use crate::{
    KbState, LocalPrincipal, Store, StoreError,
    credentials::{Credentials, Secret},
    embedder::ProviderControl,
    state::{format_utc, new_uuid_v4, random_bytes},
    tree::SealedOccurrence,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kb_client::{
    ErrorCode,
    sealed::{SealedReference, create_envelope, system_time, validate_recipient_public_key},
    types::{
        IsoInstant, KbId, Permission, SealedResolve, SealedResolveInput, SealedResolveOutput, Uuid,
    },
};
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    hmac,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;
fn unresolved() -> StoreError {
    StoreError::OperationAborted(ErrorCode::UnresolvedReference)
}
fn invalid(why: &str) -> StoreError {
    StoreError::InvalidArgument(format!("sealed input: {why}"))
}
fn resolution_error(error: StoreError, ctl: &ProviderControl) -> StoreError {
    ctl.check()
        .err()
        .unwrap_or_else(|| match error.protocol_code() {
            ErrorCode::NotFound | ErrorCode::Forbidden => unresolved(),
            _ => error,
        })
}
/// Plaintext is bounded UTF8, nonserializable, non-Debug and zeroized on drop.
/// ```compile_fail
/// fn log<T: std::fmt::Debug>() {}
/// log::<kb_local::sealed::Literal>();
/// ```
/// ```compile_fail
/// fn output<T: serde::Serialize>() {}
/// output::<kb_local::sealed::Literal>();
/// ```
pub struct Literal(Zeroizing<String>);
impl Literal {
    pub fn from_utf8(text: String) -> Result<Self, StoreError> {
        let text = Zeroizing::new(text);
        if text.is_empty() || text.len() > 16384 {
            return Err(invalid("the value must be 1 to 16384 bytes of UTF-8"));
        }
        Ok(Self(text))
    }
    pub fn expose(&self) -> &[u8] {
        self.0.as_bytes()
    }
}
pub struct Enroll {
    pub idempotency_key: String,
    pub record_id: Option<Uuid>,
}
pub struct Grant {
    pub idempotency_key: String,
    pub reference: SealedReference,
    pub consumer_id: String,
    pub recipient_key_id: Uuid,
    pub recipient_public_key: String,
    pub expires_at: IsoInstant,
}
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlReply {
    pub operation_id: Uuid,
    pub reference: String,
    pub version: u8,
    pub revoked: bool,
}
fn account(s: &Store) -> String {
    format!("sealed-{}", s.store_uuid())
}
fn aad(r: &SealedReference) -> String {
    format!(
        "kb/local/sealed/1\0{}\0{}\0{}",
        r.namespace(),
        r.record_id(),
        1
    )
}
fn key(secret: &Secret) -> Result<LessSafeKey, StoreError> {
    let bytes = Zeroizing::new(
        STANDARD
            .decode(secret.expose())
            .map_err(|_| crate::credentials::unavailable())?,
    );
    let aead =
        UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| crate::credentials::unavailable())?;
    Ok(LessSafeKey::new(aead))
}
fn event(conn: &Connection, kb: &KbId, op: &Uuid, name: &str, now: u64) -> Result<(), StoreError> {
    conn.execute("INSERT OR IGNORE INTO sealed_events(operation_id,kb_id,event,created_ms) VALUES(?1,?2,?3,?4)",(op.as_str(),kb.as_str(),name,now as i64))?;
    Ok(())
}
impl Store {
    fn sealed_owner(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        destructive: bool,
    ) -> Result<(), StoreError> {
        if p != &self.owner() {
            return Err(StoreError::Forbidden);
        }
        self.authorize(p, kb, Permission::Manage)?;
        if self.kb(kb)?.is_none_or(|k| {
            k.state != KbState::Active && !(destructive && k.state == KbState::RepairRequired)
        }) {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }
    fn sealed_key(
        &self,
        keys: &dyn Credentials,
        ctl: &ProviderControl,
        create: Option<u64>,
    ) -> Result<(crate::locks::CredentialFence, Secret), StoreError> {
        ctl.check()?;
        let a = account(self);
        let fence = crate::locks::named_model_lock_until(
            &self.paths,
            &format!("{a}.lock"),
            Instant::now() + Duration::from_secs(5),
        )?;
        let ready: bool = {
            let _guard = self.lock_write(&[])?;
            let ready: bool = self.conn.query_row(
                "SELECT sealed_key_ready FROM store_meta WHERE id=1",
                [],
                |r| r.get(0),
            )?;
            if !ready
                && (create.is_none()
                    || self.conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM sealed_records)",
                        [],
                        |r| r.get::<_, bool>(0),
                    )?)
            {
                return Err(crate::credentials::unavailable());
            }
            if !ready {
                self.check_disk_admission(create.ok_or_else(crate::credentials::unavailable)?)?;
            }
            ready
        };
        let secret = if ready {
            keys.get_sync_controlled(&a, ctl, &fence).map_err(|e| {
                if crate::credentials::is_missing_entry(&e) {
                    crate::credentials::sealed_key_lost()
                } else {
                    e
                }
            })?
        } else {
            let bytes = Zeroizing::new(random_bytes::<32>()?);
            let secret = Secret::new(STANDARD.encode(*bytes));
            keys.set_controlled(&a, &secret, ctl, &fence)?;
            let saved = keys.get_sync_controlled(&a, ctl, &fence)?;
            if saved.expose() != secret.expose() {
                return Err(crate::credentials::unavailable());
            }
            let _guard = self.lock_write(&[])?;
            ctl.check()?;
            self.check_disk_admission(create.ok_or_else(crate::credentials::unavailable)?)?;
            self.conn.execute(
                "UPDATE store_meta SET sealed_key_ready=1 WHERE id=1 AND sealed_key_ready=0",
                [],
            )?;
            secret
        };
        key(&secret)?;
        Ok((fence, secret))
    }
    fn sealed_namespace(&self, kb: &KbId, r: &SealedReference) -> Result<(), StoreError> {
        if r.namespace() != &self.attachment(kb).1 {
            return Err(unresolved());
        }
        Ok(())
    }
    fn sealed_live(&self, kb: &KbId, r: &SealedReference) -> Result<(), StoreError> {
        self.sealed_record(kb, r, true)
    }
    fn sealed_record(&self, kb: &KbId, r: &SealedReference, live: bool) -> Result<(), StoreError> {
        self.sealed_namespace(kb, r)?;
        let found:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM sealed_records WHERE namespace=?1 AND record_id=?2 AND kb_id=?3 AND owner_id=?4 AND version=1 AND (?5=0 OR (state='ACTIVE' AND ciphertext IS NOT NULL)))",(r.namespace().as_str(),r.record_id().as_str(),kb.as_str(),self.owner.id(),live),|r|r.get(0))?;
        if !found {
            return Err(unresolved());
        }
        Ok(())
    }
    fn sealed_replay(
        &self,
        kb: &KbId,
        op: &str,
        id: &str,
        binding: &[u8],
        mac_key: &hmac::Key,
    ) -> Result<Option<ControlReply>, StoreError> {
        crate::journal::parse_key(id)?;
        let row:Option<(Vec<u8>,String)>=self.conn.query_row("SELECT request_mac,response_json FROM sealed_receipts WHERE kb_id=?1 AND operation=?2 AND idempotency_key=?3",(kb.as_str(),op,id),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        row.map(|(mac, json)| {
            hmac::verify(mac_key, binding, &mac).map_err(|_| StoreError::IdempotencyMismatch)?;
            serde_json::from_str(&json).map_err(|_| unresolved())
        })
        .transpose()
    }
    fn sealed_receipt(
        &self,
        tx: &Connection,
        kb: &KbId,
        op: &str,
        id: &str,
        binding: (&[u8], &hmac::Key),
        r: &SealedReference,
    ) -> Result<ControlReply, StoreError> {
        let response = ControlReply {
            operation_id: new_uuid_v4()?,
            reference: r.to_string(),
            version: 1,
            revoked: op == "REVOKE",
        };
        let mac = hmac::sign(binding.1, binding.0);
        tx.execute(
            "UPDATE kbs SET sealed_policy_generation=sealed_policy_generation+1 WHERE id=?1",
            [kb.as_str()],
        )?;
        tx.execute("INSERT INTO sealed_receipts(kb_id,operation,idempotency_key,request_mac,response_json) VALUES(?1,?2,?3,?4,?5)",(kb.as_str(),op,id,mac.as_ref(),serde_json::to_string(&response).map_err(|_|unresolved())?))?;
        Ok(response)
    }
    /// Human enrollment; optional import UUID is absent-only, including tombstones.
    pub fn sealed_enroll(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        c: Enroll,
        literal: Literal,
        keys: &dyn Credentials,
    ) -> Result<ControlReply, StoreError> {
        let _scope = crate::git_read::OperationDeadline::start();
        crate::journal::parse_key(&c.idempotency_key)?;
        let allocation = literal.expose().len() as u64 + 16;
        {
            let _guard = self.lock_write(std::slice::from_ref(kb))?;
            self.sealed_owner(p, kb, false)?;
            let replay: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM sealed_receipts WHERE kb_id=?1 AND operation='ENROLL' AND idempotency_key=?2)",(kb.as_str(),&c.idempotency_key),|r|r.get(0))?;
            if !replay {
                self.check_disk_admission(allocation)?;
            }
        }
        // JSON can expand each literal byte sixfold. A fixed-slice writer
        // cannot reallocate plaintext; 256 covers the bounded KB/UUID tuple.
        let mut binding = Zeroizing::new(vec![0; literal.expose().len() * 6 + 256]);
        let used = {
            let mut writer = std::io::Cursor::new(binding.as_mut_slice());
            serde_json::to_writer(&mut writer, &(kb, c.record_id.as_ref(), literal.0.as_str()))
                .map_err(|_| invalid("the value could not be encoded"))?;
            writer.position() as usize
        };
        binding.truncate(used);
        let ctl = ProviderControl::default();
        let (_fence, secret) = self.sealed_key(keys, &ctl, Some(allocation))?;
        let mac_key = hmac::Key::new(hmac::HMAC_SHA256, secret.expose().as_bytes());
        let _guard = self.lock_write(std::slice::from_ref(kb))?;
        self.sealed_owner(p, kb, false)?;
        if let Some(reply) =
            self.sealed_replay(kb, "ENROLL", &c.idempotency_key, &binding, &mac_key)?
        {
            self.sealed_live(kb, &reply.reference.parse().map_err(|_| unresolved())?)?;
            return Ok(reply);
        }
        self.check_disk_admission(allocation)?;
        let r = SealedReference::new(self.attachment(kb).1, c.record_id.unwrap_or(new_uuid_v4()?));
        let nonce = random_bytes::<12>()?;
        let mut ciphertext = Zeroizing::new(literal.expose().to_vec());
        key(&secret)?
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(aad(&r).as_bytes()),
                &mut *ciphertext,
            )
            .map_err(|_| unresolved())?;
        ctl.check()?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("INSERT INTO sealed_records(namespace,record_id,kb_id,owner_id,version,state,nonce,ciphertext) VALUES(?1,?2,?3,?4,1,'ACTIVE',?5,?6)", (r.namespace().as_str(),r.record_id().as_str(),kb.as_str(),p.id(),nonce.as_slice(),ciphertext.as_slice())).map_err(|e| crate::store::constraint_to_conflict(e,"record identity already exists"))?;
        crate::uploads::charge_mutation(&tx, &p.actor_key(), kb.as_str(), self.now_ms())?;
        let response = self.sealed_receipt(
            &tx,
            kb,
            "ENROLL",
            &c.idempotency_key,
            (&binding, &mac_key),
            &r,
        )?;
        event(&tx, kb, &response.operation_id, "ENROLL", self.now_ms())?;
        tx.commit()?;
        Ok(response)
    }
    /// Approval pins one record, one registered local consumer and one key.
    pub fn sealed_grant(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        c: Grant,
    ) -> Result<ControlReply, StoreError> {
        let _guard = self.lock_write(std::slice::from_ref(kb))?;
        self.sealed_owner(p, kb, false)?;
        self.sealed_live(kb, &c.reference).map_err(|e| match e.protocol_code() {
            ErrorCode::UnresolvedReference => StoreError::Explained(
                ErrorCode::UnresolvedReference,
                "the sealed record is revoked or unknown in this knowledge base; enroll the value again".into(),
            ),
            _ => e,
        })?;
        let consumer = self.principal(&c.consumer_id).map_err(|_| {
            invalid("unknown consumer ID; `kb sealed owner` prints the store owner's ID")
        })?;
        self.authorize(&consumer, kb, Permission::Read)
            .map_err(|_| invalid("the consumer cannot read this knowledge base"))?;
        validate_recipient_public_key(&c.recipient_public_key)
            .map_err(|_| invalid("the recipient public key is not a base64 X25519 key"))?;
        let past = || invalid("`--expires-at` must be in the future");
        let expiry = system_time(&c.expires_at)
            .map_err(|_| past())?
            .duration_since(UNIX_EPOCH)
            .map_err(|_| past())?
            .as_millis();
        let expiry = i64::try_from(expiry).map_err(|_| past())?;
        if expiry <= self.now_ms() as i64 {
            return Err(past());
        }
        let binding = serde_json::to_vec(&(
            &c.reference.to_string(),
            &c.consumer_id,
            &c.recipient_key_id,
            &c.recipient_public_key,
            &c.expires_at,
        ))
        .map_err(|_| invalid("the grant could not be encoded"))?;
        if let Some(reply) = self.sealed_replay(
            kb,
            "GRANT",
            &c.idempotency_key,
            &binding,
            &self.cursor_key.hmac(),
        )? {
            return Ok(reply);
        }
        self.check_disk_admission(0)?;
        let tx = self.conn.unchecked_transaction()?;
        crate::uploads::charge_mutation(&tx, &p.actor_key(), kb.as_str(), self.now_ms())?;
        tx.execute("INSERT INTO sealed_grants(namespace,record_id,consumer_id,recipient_key_id,recipient_public_key,expires_ms) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(namespace,record_id,consumer_id,recipient_key_id) DO UPDATE SET recipient_public_key=excluded.recipient_public_key,expires_ms=excluded.expires_ms",(c.reference.namespace().as_str(),c.reference.record_id().as_str(),&c.consumer_id,c.recipient_key_id.as_str(),&c.recipient_public_key,expiry))?;
        let reply = self.sealed_receipt(
            &tx,
            kb,
            "GRANT",
            &c.idempotency_key,
            (&binding, &self.cursor_key.hmac()),
            &c.reference,
        )?;
        event(&tx, kb, &reply.operation_id, "GRANT", self.now_ms())?;
        tx.commit()?;
        Ok(reply)
    }
    /// Durable ciphertext/grant destruction. Does not need native key access;
    /// the store key remains available to other records, with distinct AAD.
    pub fn sealed_revoke(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        r: &SealedReference,
        id: &str,
    ) -> Result<ControlReply, StoreError> {
        let reply = {
            let _guard = self.lock_write(std::slice::from_ref(kb))?;
            self.sealed_owner(p, kb, true)?;
            self.sealed_namespace(kb, r)?;
            if let Some(reply) = self.sealed_replay(
                kb,
                "REVOKE",
                id,
                r.to_string().as_bytes(),
                &self.cursor_key.hmac(),
            )? {
                reply
            } else {
                let tx = self.conn.unchecked_transaction()?;
                if tx.execute("UPDATE sealed_records SET state='REVOKED',nonce=NULL,ciphertext=NULL WHERE namespace=?1 AND record_id=?2 AND kb_id=?3",(r.namespace().as_str(),r.record_id().as_str(),kb.as_str()))?!=1 {return Err(unresolved());}
                tx.execute(
                    "DELETE FROM sealed_grants WHERE namespace=?1 AND record_id=?2",
                    (r.namespace().as_str(), r.record_id().as_str()),
                )?;
                crate::uploads::charge_mutation(&tx, &p.actor_key(), kb.as_str(), self.now_ms())?;
                let reply = self.sealed_receipt(
                    &tx,
                    kb,
                    "REVOKE",
                    id,
                    (r.to_string().as_bytes(), &self.cursor_key.hmac()),
                    r,
                )?;
                event(&tx, kb, &reply.operation_id, "REVOKE", self.now_ms())?;
                tx.commit()?;
                reply
            }
        };
        Ok(reply)
    }
    /// Paths on `main` that still mention `r` (L-8: `kb sealed revoke`
    /// warns; those documents stay editable, their unchanged references are
    /// retained, and only changed documents must reference live records).
    pub fn sealed_reference_paths(
        &self,
        kb: &KbId,
        r: &SealedReference,
    ) -> Result<Vec<String>, StoreError> {
        use crate::git_read::{EntryKind, IncomingBudget, ObjectKind, WalkBudget, walk_tree};
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        let Some(head) = record.head_sha else {
            return Ok(Vec::new());
        };
        let head = kb_client::types::Sha::parse(&head).map_err(|_| StoreError::IndexUnavailable)?;
        let repo = crate::git_read::GitRepo::for_kb(&self.paths, kb)?;
        let info = repo.read_commit(&head)?;
        let mut reader = repo.object_reader()?;
        let limits = &crate::tree::TREE_LIMITS;
        let entries = walk_tree(
            &mut reader,
            &info.tree,
            &mut WalkBudget::new(limits.max_entries),
            &mut IncomingBudget::new(
                limits.max_objects,
                limits.max_uncompressed_object_bytes,
                None,
            ),
        )?;
        let mut paths = Vec::new();
        for e in entries {
            if e.kind != EntryKind::Blob || !e.path.ends_with(".md") {
                continue;
            }
            let bytes = reader.read(&e.sha, ObjectKind::Blob, limits.max_markdown_bytes)?;
            let (Ok(text), Ok(parsed)) = (
                std::str::from_utf8(&bytes),
                crate::markdown::parse_markdown(&bytes),
            ) else {
                continue;
            };
            if crate::markdown::sealed_references_in(&parsed, text)
                .iter()
                .any(|x| format!("{{{{{x}}}}}").parse::<SealedReference>().as_ref() == Ok(r))
            {
                paths.push(e.path);
            }
        }
        Ok(paths)
    }
    pub(crate) fn check_local_sealed(
        &self,
        kb: &KbId,
        refs: &[SealedOccurrence],
        live: bool,
    ) -> Result<(), SealedOccurrence> {
        for occurrence in refs {
            let r = format!("{{{{{}}}}}", occurrence.reference).parse::<SealedReference>();
            if r.is_err() || r.is_ok_and(|r| self.sealed_record(kb, &r, live).is_err()) {
                return Err(occurrence.clone());
            }
        }
        Ok(())
    }
    fn resolution_key(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        r: &SealedReference,
        id: &Uuid,
    ) -> Result<String, StoreError> {
        self.authorize(p, kb, Permission::Read)
            .map_err(|error| match error.protocol_code() {
                ErrorCode::NotFound | ErrorCode::Forbidden => unresolved(),
                _ => error,
            })?;
        match self.kb(kb)?.map(|k| k.state) {
            Some(KbState::Active) => {}
            Some(KbState::RepairRequired) => {
                return Err(StoreError::RecoveryRequired(
                    "knowledge base needs repair".into(),
                ));
            }
            _ => return Err(unresolved()),
        }
        self.sealed_live(kb, r)?;
        self.conn.query_row("SELECT recipient_public_key FROM sealed_grants WHERE namespace=?1 AND record_id=?2 AND consumer_id=?3 AND recipient_key_id=?4 AND expires_ms>?5",(r.namespace().as_str(),r.record_id().as_str(),p.id(),id.as_str(),self.now_ms() as i64),|r|r.get(0)).optional()?.ok_or_else(unresolved)
    }
    /// Common tool returns ciphertext only. The consumer is always the admitted
    /// principal, never a request parameter; owner/manage does not bypass approval.
    pub fn sealed_resolve(
        &self,
        p: &LocalPrincipal,
        input: SealedResolveInput,
        keys: &dyn Credentials,
        ctl: &ProviderControl,
    ) -> Result<SealedResolveOutput, StoreError> {
        self.sealed_resolve_observed(p, input, keys, ctl, &mut || Ok(()))
    }
    /// Test/transport barrier after immutable source I/O, before final authority.
    #[doc(hidden)]
    pub fn sealed_resolve_observed(
        &self,
        p: &LocalPrincipal,
        input: SealedResolveInput,
        keys: &dyn Credentials,
        ctl: &ProviderControl,
        before_reply: &mut dyn FnMut() -> Result<(), StoreError>,
    ) -> Result<SealedResolveOutput, StoreError> {
        let _scope = ctl.git_scope();
        crate::bases::check_input::<SealedResolve>(&input)?;
        ctl.check()?;
        let result = (|| {
            let r = input
                .reference
                .parse::<SealedReference>()
                .map_err(|_| unresolved())?;
            {
                let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
                self.resolution_key(p, &input.kb_id, &r, &input.recipient_key_id)?;
            }
            let (repo, rev) = self
                .pinned_revision(p, &input.kb_id, input.rev.as_ref())
                .map_err(|e| resolution_error(e, ctl))?;
            let doc = crate::git_read::read_document(&repo, &rev, input.path.as_str())
                .map_err(|e| resolution_error(crate::documents::source_error(e), ctl))?;
            let parsed = crate::markdown::parse_markdown(doc.markdown.as_bytes())
                .map_err(|_| unresolved())?;
            if !crate::markdown::sealed_references_in(&parsed, &doc.markdown)
                .iter()
                .any(|text| format!("{{{{{text}}}}}") == r.to_string())
            {
                return Err(unresolved());
            }
            before_reply()?;
            ctl.check()?;
            {
                let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
                self.resolution_key(p, &input.kb_id, &r, &input.recipient_key_id)?;
            }
            let (_fence, secret) = match self.sealed_key(keys, ctl, None) {
                Ok(key) => key,
                Err(error) => {
                    let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
                    self.resolution_key(p, &input.kb_id, &r, &input.recipient_key_id)?;
                    return Err(error);
                }
            };
            let _guard = self.lock_write(std::slice::from_ref(&input.kb_id))?;
            repo.resolve_readable_commit(&rev)
                .map_err(|e| resolution_error(e.into(), ctl))?;
            let public = self.resolution_key(p, &input.kb_id, &r, &input.recipient_key_id)?;
            let (nonce,bytes):(Vec<u8>,Vec<u8>)=self.conn.query_row("SELECT nonce,ciphertext FROM sealed_records WHERE namespace=?1 AND record_id=?2 AND state='ACTIVE'",(r.namespace().as_str(),r.record_id().as_str()),|r|Ok((r.get(0)?,r.get(1)?)))?;
            let nonce: [u8; 12] = nonce.try_into().map_err(|_| unresolved())?;
            let mut bytes = Zeroizing::new(bytes);
            let len = key(&secret)?
                .open_in_place(
                    Nonce::assume_unique_for_key(nonce),
                    Aad::from(aad(&r).as_bytes()),
                    bytes.as_mut_slice(),
                )
                .map_err(|_| unresolved())?
                .len();
            bytes.truncate(len);
            ctl.check()?;
            let now = SystemTime::now();
            let secs = now
                .duration_since(UNIX_EPOCH)
                .map_err(|_| unresolved())?
                .as_secs()
                + 60;
            let expires = format_utc(secs).parse().map_err(|_| unresolved())?;
            let out = create_envelope(&bytes, &r, &input.recipient_key_id, &public, expires, now)
                .map_err(|_| unresolved())?;
            crate::limits::check_response_size(
                serde_json::to_vec(&out),
                self.response_limit.get(),
            )?;
            self.resolution_key(p, &input.kb_id, &r, &input.recipient_key_id)?;
            ctl.check()?;
            Ok(out)
        })();
        if result
            .as_ref()
            .is_err_and(|e| e.protocol_code() == ErrorCode::UnresolvedReference)
        {
            let _guard = self.lock_write(&[])?;
            if self.kb(&input.kb_id)?.is_some() {
                event(
                    &self.conn,
                    &input.kb_id,
                    &new_uuid_v4()?,
                    "RESOLVE_DENIED",
                    self.now_ms(),
                )?;
            }
        }
        result
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;
    #[test]
    fn resolution_exit_table_preserves_typed_operational_failures() {
        use crate::git_read::{GitError, SourceError};
        let ctl = ProviderControl::default();
        for (error, expected) in [
            (StoreError::NotFound, ErrorCode::UnresolvedReference),
            (StoreError::Forbidden, ErrorCode::UnresolvedReference),
            (
                StoreError::RecoveryRequired("fixture".into()),
                ErrorCode::RepairRequired,
            ),
            (
                StoreError::StorageUnavailable("fixture".into()),
                ErrorCode::StorageUnavailable,
            ),
            (StoreError::DeadlineExceeded, ErrorCode::DeadlineExceeded),
            (
                StoreError::OperationAborted(ErrorCode::Cancelled),
                ErrorCode::Cancelled,
            ),
        ] {
            assert_eq!(resolution_error(error, &ctl).protocol_code(), expected);
        }
        // Input pin and final reachability use the Git conversion; source
        // reads share the existing document conversion rather than relabeling.
        for (error, expected) in [
            (GitError::NotFound, ErrorCode::UnresolvedReference),
            (
                GitError::Structure("fixture".into()),
                ErrorCode::RepairRequired,
            ),
            (
                GitError::Failed("fixture".into()),
                ErrorCode::StorageUnavailable,
            ),
            (GitError::Timeout, ErrorCode::DeadlineExceeded),
            (GitError::Cancelled, ErrorCode::Cancelled),
        ] {
            assert_eq!(
                resolution_error(
                    crate::documents::source_error(SourceError::Git(error)),
                    &ctl
                )
                .protocol_code(),
                expected
            );
        }
        ctl.cancel();
        assert_eq!(
            resolution_error(StoreError::NotFound, &ctl).protocol_code(),
            ErrorCode::Cancelled
        );
    }
}
