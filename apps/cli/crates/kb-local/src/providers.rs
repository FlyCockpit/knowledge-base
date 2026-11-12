//! Local HUMAN control plane. Account fence -> short store fence -> SQLite;
//! no store lock across native I/O or HTTP. Durable STORING precedes native writes; REVOKED precedes
//! native deletion. Retries drain incomplete deletion, never restore authority.
pub use crate::fingerprint::EMBEDDING_VERSIONS;
use crate::{
    LocalPrincipal, Store, StoreError,
    credentials::{self, Credentials, Secret},
    egress::{Endpoint, PinnedEgress, unavailable},
    embedder::{ProviderControl, validate_embeddings},
    state::{new_id, new_uuid_v4},
};
use kb_client::types::KbId;
use rusqlite::OptionalExtension;
use serde::Serialize;
#[derive(Clone, Debug)]
pub struct ProviderConfig {
    pub idempotency_key: String,
    pub provider_id: Option<KbId>,
    pub name: String,
    pub endpoint_url: String,
    pub model: String,
    pub dimensions: usize,
}
impl ProviderConfig {
    pub fn fingerprint(&self, e: &Endpoint) -> Result<String, StoreError> {
        crate::fingerprint::embedding_fingerprint(
            e,
            self.model.trim(),
            self.dimensions,
            &EMBEDDING_VERSIONS,
        )
    }
}
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRevision {
    pub operation_id: String,
    pub provider_id: KbId,
    pub revision: i64,
    pub name: String,
    pub endpoint_url: String,
    pub model: String,
    pub dimensions: usize,
    pub fingerprint: String,
    pub state: String,
}
struct RegistrationReceipt {
    provider_id: String,
    revision: i64,
    request_mac: Vec<u8>,
    response: Option<String>,
}
impl ProviderRevision {
    pub fn summary(&self) -> kb_client::types::ProviderSummary {
        use kb_client::types::{ProviderKind, ProviderStatus, ProviderSummary};
        ProviderSummary {
            provider_id: self.provider_id.clone().into(),
            revision: self.revision,
            kind: ProviderKind::OpenaiCompat,
            name: self.name.clone(),
            model: self.model.clone(),
            dimensions: self.dimensions as i64,
            context_tokens: None,
            status: match self.state.as_str() {
                "READY" => ProviderStatus::Ready,
                "REVOKED" => ProviderStatus::Revoked,
                _ => ProviderStatus::Unavailable,
            },
        }
    }
}
impl Store {
    fn provider_now_ms(&self) -> i64 {
        i64::try_from(self.now_ms()).unwrap_or(i64::MAX)
    }
    fn provider_owner(&self, p: &LocalPrincipal) -> Result<(), StoreError> {
        if p != &self.owner {
            Err(StoreError::Forbidden)
        } else {
            Ok(())
        }
    }
    fn provider_loopback(&self) -> Result<bool, StoreError> {
        Ok(self.conn.query_row(
            "SELECT allow_loopback FROM provider_settings WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn provider_set_loopback(
        &self,
        p: &LocalPrincipal,
        enabled: bool,
    ) -> Result<(), StoreError> {
        self.provider_owner(p)?;
        let _guard = self.lock_write(&[])?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE provider_settings SET allow_loopback=?1 WHERE id=1",
            [enabled],
        )?;
        self.provider_event("provider_loopback", None, None)?;
        tx.commit()?;
        Ok(())
    }
    fn provider_event(
        &self,
        event: &str,
        id: Option<&KbId>,
        revision: Option<i64>,
    ) -> Result<(), StoreError> {
        self.conn.execute("INSERT INTO provider_events(id,event,provider_id,revision,created_ms) VALUES(?1,?2,?3,?4,?5)",(new_uuid_v4()?.as_str(),event,id.map(KbId::as_str),revision,self.provider_now_ms()))?;
        Ok(())
    }
    fn credential_account(&self, id: &KbId, v: i64) -> String {
        format!("{}-{}-{v}", self.store_uuid(), id)
    }
    pub fn provider_register(
        &self,
        p: &LocalPrincipal,
        c: ProviderConfig,
        secret: Secret,
        keys: &dyn Credentials,
    ) -> Result<ProviderRevision, StoreError> {
        self.provider_owner(p)?;
        crate::journal::parse_key(&c.idempotency_key)?;
        let guard = self.lock_write(&[])?;
        if !secret.valid()
            || !(1..=2000).contains(&c.dimensions)
            || c.name.trim().is_empty()
            || c.name.chars().count() > 120
            || c.model.trim().is_empty()
            || c.model.chars().count() > 200
        {
            return Err(StoreError::InvalidArgument("provider configuration".into()));
        }
        let e = Endpoint::parse(&c.endpoint_url, self.provider_loopback()?)?;
        let fingerprint = c.fingerprint(&e)?;
        let binding = zeroize::Zeroizing::new(
            serde_json::to_vec(&(
                "kb/provider/register/1",
                self.owner.actor_key(),
                c.provider_id.as_ref().map(KbId::as_str),
                c.name.trim(),
                &fingerprint,
                secret.expose(),
            ))
            .map_err(|_| unavailable())?,
        );
        let mac = ring::hmac::sign(&self.cursor_key.hmac(), &binding);
        let known: Option<RegistrationReceipt> = self.conn.query_row(
            "SELECT provider_id,revision,request_mac,response_json FROM provider_registrations WHERE idempotency_key=?1",
            [&c.idempotency_key], |r| Ok(RegistrationReceipt {provider_id:r.get(0)?,revision:r.get(1)?,request_mac:r.get(2)?,response:r.get(3)?}),
        ).optional()?;
        if let Some(receipt) = known {
            ring::hmac::verify(&self.cursor_key.hmac(), &binding, &receipt.request_mac)
                .map_err(|_| StoreError::IdempotencyMismatch)?;
            let id = KbId::parse(&receipt.provider_id).map_err(|_| unavailable())?;
            let v = receipt.revision;
            let response = receipt.response;
            if self.provider_revision(p, &id, v)?.state == "REVOKED" {
                return Err(unavailable());
            }
            if let Some(response) = response {
                return serde_json::from_str(&response).map_err(|_| unavailable());
            }
            drop(guard);
            return self.finish_provider_registration(p, &id, v, secret, keys);
        }
        let id = c.provider_id.clone().unwrap_or(new_id()?);
        let tx = self.conn.unchecked_transaction()?;
        if c.provider_id.is_some() {
            let revoked: Option<bool> = tx
                .query_row(
                    "SELECT revoked FROM providers WHERE id=?1",
                    [id.as_str()],
                    |r| r.get(0),
                )
                .optional()?;
            if revoked != Some(false) {
                return Err(unavailable());
            }
        } else {
            let count: i64 =
                tx.query_row("SELECT count(*) FROM providers WHERE revoked=0", [], |r| {
                    r.get(0)
                })?;
            if count >= i64::from(crate::limits::PROVIDERS_PER_USER) {
                return Err(StoreError::QuotaExceeded("providers".into()));
            }
            tx.execute(
                "INSERT INTO providers(id,name) VALUES(?1,?2)",
                (id.as_str(), c.name.trim()),
            )?;
        }
        let version: i64 = tx.query_row(
            "SELECT coalesce(max(revision),0)+1 FROM provider_revisions WHERE provider_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )?;
        let total: i64 =
            tx.query_row("SELECT count(*) FROM provider_revisions", [], |r| r.get(0))?;
        if version > i64::from(crate::limits::PROVIDER_REVISIONS_PER_PROVIDER)
            || total >= i64::from(crate::limits::PROVIDER_REVISIONS_PER_USER)
        {
            return Err(StoreError::QuotaExceeded("provider revisions".into()));
        }
        tx.execute("INSERT INTO provider_revisions(provider_id,revision,endpoint_url,model,dimensions,fingerprint,state) VALUES(?1,?2,?3,?4,?5,?6,'STORING')",(id.as_str(),version,e.url().as_str(),c.model.trim(),c.dimensions as i64,fingerprint))?;
        tx.execute("INSERT INTO provider_registrations(operation_id,idempotency_key,request_mac,provider_id,revision) VALUES(?1,?2,?3,?4,?5)",
            (new_uuid_v4()?.as_str(), &c.idempotency_key, mac.as_ref(), id.as_str(), version))?;
        tx.commit()?; // Identity and request binding precede native effects.
        drop(guard);
        self.finish_provider_registration(p, &id, version, secret, keys)
    }
    fn finish_provider_registration(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        v: i64,
        secret: Secret,
        keys: &dyn Credentials,
    ) -> Result<ProviderRevision, StoreError> {
        let ctl = ProviderControl::default();
        let fence = crate::locks::credential_lock(&self.paths, id, v, &ctl)?;
        {
            let _guard = self.lock_write(&[])?;
            let r = self.provider_revision(p, id, v)?;
            if r.state == "REVOKED" {
                return Err(unavailable());
            }
            let response: Option<String> = self.conn.query_row("SELECT response_json FROM provider_registrations WHERE provider_id=?1 AND revision=?2", (id.as_str(),v), |r| r.get(0))?;
            if let Some(response) = response {
                return serde_json::from_str(&response).map_err(|_| unavailable());
            }
        }
        keys.set_controlled(&self.credential_account(id, v), &secret, &ctl, &fence)?;
        let _guard = self.lock_write(&[])?;
        if self.provider_revision(p, id, v)?.state == "REVOKED" {
            drop(_guard);
            keys.delete_controlled(&self.credential_account(id, v), &ctl, &fence)?;
            return Err(unavailable());
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE provider_revisions SET state='REGISTERED' WHERE provider_id=?1 AND revision=?2 AND state='STORING'", (id.as_str(),v))?;
        let r = self.provider_revision(p, id, v)?;
        tx.execute("UPDATE provider_registrations SET response_json=?3 WHERE provider_id=?1 AND revision=?2", (id.as_str(),v,serde_json::to_string(&r).map_err(|_| unavailable())?))?;
        self.provider_event("provider_create", Some(id), Some(v))?;
        tx.commit()?;
        Ok(r)
    }
    pub fn provider_revision(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        version: i64,
    ) -> Result<ProviderRevision, StoreError> {
        self.provider_owner(p)?;
        self.conn.query_row("SELECT p.name,r.endpoint_url,r.model,r.dimensions,r.fingerprint,CASE WHEN p.revoked=1 THEN 'REVOKED' ELSE r.state END,o.operation_id FROM providers p JOIN provider_revisions r ON r.provider_id=p.id JOIN provider_registrations o ON o.provider_id=r.provider_id AND o.revision=r.revision WHERE p.id=?1 AND r.revision=?2",(id.as_str(),version),|row|Ok(ProviderRevision {operation_id:row.get(6)?,provider_id:id.clone(),revision:version,name:row.get(0)?,endpoint_url:row.get(1)?,model:row.get(2)?,dimensions:usize::from(row.get::<_,u16>(3)?),fingerprint:row.get(4)?,state:row.get(5)?})).optional()?.ok_or_else(|| StoreError::Explained(kb_client::ErrorCode::NotFound, format!("no provider `{id}` revision `{version}`")))
    }
    /// Keyset page of latest revisions. IDs are opaque owner-control metadata.
    pub fn provider_list(
        &self,
        p: &LocalPrincipal,
        after: Option<&KbId>,
        limit: usize,
    ) -> Result<Vec<ProviderRevision>, StoreError> {
        self.provider_owner(p)?;
        if !(1..=50).contains(&limit) {
            return Err(StoreError::InvalidArgument("provider page".into()));
        }
        let _guard = self.lock_write(&[])?;
        self.conn.execute("UPDATE provider_revisions SET state='FAILED',attempt=attempt+1 WHERE state='PROBING' AND probe_until_ms<=?1",[self.provider_now_ms()])?;
        let mut q=self.conn.prepare("SELECT p.id,max(r.revision) FROM providers p JOIN provider_revisions r ON r.provider_id=p.id WHERE p.id>?1 GROUP BY p.id ORDER BY p.id LIMIT ?2")?;
        let pins = q
            .query_map((after.map_or("", KbId::as_str), limit as i64), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        pins.into_iter()
            .map(|(id, v)| {
                self.provider_revision(p, &KbId::parse(&id).map_err(|_| unavailable())?, v)
            })
            .collect()
    }
    pub fn provider_revoke(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        keys: &dyn Credentials,
    ) -> Result<(), StoreError> {
        self.provider_owner(p)?;
        let guard = self.lock_write(&[])?;
        let tx = self.conn.unchecked_transaction()?;
        if tx.execute("UPDATE providers SET revoked=1 WHERE id=?1", [id.as_str()])? != 1 {
            return Err(StoreError::Explained(
                kb_client::ErrorCode::NotFound,
                format!("no provider `{id}`"),
            ));
        }
        tx.execute("UPDATE provider_revisions SET state='REVOKED',attempt=attempt+1 WHERE provider_id=?1 AND state<>'REVOKED'",[id.as_str()])?;
        // L-7: every live KB on this provider gets a lexical-only
        // generation now (the revoked pin can no longer build), in the same
        // transaction as the revocation.
        let attached = {
            let mut q = tx.prepare("SELECT id FROM kbs WHERE state='ACTIVE' AND json_extract(profile_json,'$.provider_id')=?1 ORDER BY id")?;
            q.query_map([id.as_str()], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for kb in attached {
            let kb = KbId::parse(&kb).map_err(|_| unavailable())?;
            tx.execute(
                "UPDATE kbs SET desired_epoch=desired_epoch+1 WHERE id=?1",
                [kb.as_str()],
            )?;
            self.enqueue_generation(&kb, &crate::state::new_uuid_v4()?)?;
        }
        if tx.query_row(
            "SELECT count(*) FROM provider_events WHERE event='provider_revoke' AND provider_id=?1",
            [id.as_str()],
            |r| r.get::<_, i64>(0),
        )? == 0
        {
            self.provider_event("provider_revoke", Some(id), None)?;
        }
        tx.commit()?;
        drop(guard);
        let ctl = ProviderControl::default();
        // Durable revocation precedes account admission; never wait under store fence.
        loop {
            let v:Option<i64>=self.conn.query_row("SELECT revision FROM provider_revisions WHERE provider_id=?1 AND secret_deleted=0 ORDER BY revision LIMIT 1",[id.as_str()],|r|r.get(0)).optional()?;
            let Some(v) = v else {
                break;
            };
            let fence = crate::locks::credential_lock(&self.paths, id, v, &ctl)?;
            keys.delete_controlled(&self.credential_account(id, v), &ctl, &fence)?;
            let _guard = self.lock_write(&[])?;
            self.conn.execute("UPDATE provider_revisions SET secret_deleted=1 WHERE provider_id=?1 AND revision=?2",(id.as_str(),v))?;
        }
        Ok(())
    }
    /// Future index/build consumers MUST publish within this fence, after HTTP.
    pub fn with_provider_result<T>(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        v: i64,
        publish: impl FnOnce() -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        self.provider_owner(p)?;
        let _guard = self.lock_write(&[])?;
        self.usable_provider(p, id, v, None)?;
        publish()
    }
    fn usable_provider(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        v: i64,
        attempt: Option<i64>,
    ) -> Result<ProviderRevision, StoreError> {
        let r = self.provider_revision(p, id, v)?;
        if let Some(a) = attempt {
            let live:bool=self.conn.query_row("SELECT state='PROBING' AND attempt=?3 AND probe_until_ms>?4 FROM provider_revisions WHERE provider_id=?1 AND revision=?2",(id.as_str(),v,a,self.provider_now_ms()),|r|r.get(0))?;
            if r.state != "PROBING" || !live {
                return Err(unavailable());
            }
        } else if r.state != "READY" {
            return Err(unavailable());
        }
        Endpoint::parse(&r.endpoint_url, self.provider_loopback()?)?;
        Ok(r)
    }
    pub async fn provider_probe(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        v: i64,
        keys: &dyn Credentials,
        egress: &PinnedEgress<'_>,
        ctl: &ProviderControl,
    ) -> Result<ProviderRevision, StoreError> {
        self.provider_owner(p)?;
        ctl.check()?;
        let attempt = {
            let _guard = self.lock_write(&[])?;
            let r = self.provider_revision(p, id, v)?;
            if !["REGISTERED", "READY", "FAILED", "PROBING"].contains(&r.state.as_str()) {
                return Err(unavailable());
            }
            let tx = self.conn.unchecked_transaction()?;
            let now = self.provider_now_ms();
            let count: i64 = tx.query_row(
                "SELECT count(*) FROM provider_probe_charges WHERE created_ms>?1",
                [now.saturating_sub(60_000)],
                |r| r.get(0),
            )?;
            if count >= i64::from(self.limits.get().probes_per_minute()) {
                return Err(StoreError::RateLimited(60));
            }
            tx.execute(
                "DELETE FROM provider_probe_charges WHERE created_ms<=?1",
                [now.saturating_sub(60_000)],
            )?;
            tx.execute(
                "INSERT INTO provider_probe_charges(id,created_ms) VALUES(?1,?2)",
                (new_uuid_v4()?.as_str(), now),
            )?;
            tx.execute("UPDATE provider_revisions SET state='PROBING',attempt=attempt+1,probe_until_ms=?3 WHERE provider_id=?1 AND revision=?2",(id.as_str(),v,self.provider_now_ms().saturating_add(11_000)))?;
            tx.commit()?;
            self.conn.query_row(
                "SELECT attempt FROM provider_revisions WHERE provider_id=?1 AND revision=?2",
                (id.as_str(), v),
                |r| r.get::<_, i64>(0),
            )?
        };
        let result = self
            .provider_request(
                p,
                id,
                v,
                &["knowledge base provider probe".into()],
                keys,
                egress,
                ctl,
                Some(attempt),
                None,
                &|| Ok(()),
            )
            .await;
        let _guard = self.lock_write(&[])?;
        let tx = self.conn.unchecked_transaction()?;
        let result = result.and_then(|vectors| {
            ctl.check()?;
            self.usable_provider(p, id, v, Some(attempt))?;
            Ok(vectors)
        });
        let state = if result.is_ok() { "READY" } else { "FAILED" };
        let changed=tx.execute("UPDATE provider_revisions SET state=?4 WHERE provider_id=?1 AND revision=?2 AND attempt=?3 AND state='PROBING'",(id.as_str(),v,attempt,state))?;
        if changed != 1 {
            return Err(unavailable());
        }
        self.provider_event("provider_probe", Some(id), Some(v))?;
        tx.commit()?;
        result?;
        self.provider_revision(p, id, v)
    }
    // Explicit pin + trusted ports + control are separate security boundaries.
    #[allow(clippy::too_many_arguments)]
    pub async fn provider_embed(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        v: i64,
        texts: &[String],
        keys: &dyn Credentials,
        egress: &PinnedEgress<'_>,
        ctl: &ProviderControl,
    ) -> Result<Vec<Vec<f64>>, StoreError> {
        self.provider_request(p, id, v, texts, keys, egress, ctl, None, None, &|| Ok(()))
            .await
    }
    pub(crate) async fn provider_embed_admitted(
        &self,
        id: &KbId,
        v: i64,
        texts: &[String],
        io: (
            &dyn Credentials,
            &PinnedEgress<'_>,
            &crate::embedder::QueryEmbeddingControl,
        ),
        admit: &dyn Fn() -> Result<(), StoreError>,
    ) -> Result<Vec<Vec<f64>>, StoreError> {
        self.provider_request(
            &self.owner,
            id,
            v,
            texts,
            io.0,
            io.1,
            &io.2.control,
            None,
            Some(io.2),
            admit,
        )
        .await
    }
    // Same boundary for probes and future pinned build/query consumers.
    #[allow(clippy::too_many_arguments)]
    async fn provider_request(
        &self,
        p: &LocalPrincipal,
        id: &KbId,
        v: i64,
        texts: &[String],
        keys: &dyn Credentials,
        egress: &PinnedEgress<'_>,
        ctl: &ProviderControl,
        attempt: Option<i64>,
        query: Option<&crate::embedder::QueryEmbeddingControl>,
        admit: &dyn Fn() -> Result<(), StoreError>,
    ) -> Result<Vec<Vec<f64>>, StoreError> {
        self.provider_owner(p)?;
        ctl.check()?;
        if texts.len() > 32 {
            return Err(unavailable());
        }
        // Every provider consumer passes the same floor before keys, DNS or HTTP.
        let texts = texts
            .iter()
            .map(|text| crate::sensitive_text::prepare_embedding_query(text))
            .collect::<Result<Vec<_>, _>>()?;
        let r = {
            let _guard = self.lock_write(&[])?;
            admit()?;
            self.usable_provider(p, id, v, attempt)?
        };
        let fence = crate::locks::credential_lock_async(&self.paths, id, v, ctl).await?;
        {
            let _guard = self.lock_write(&[])?;
            ctl.check()?;
            self.usable_provider(p, id, v, attempt)?;
        }
        let secret = keys
            .get_controlled(&self.credential_account(id, v), ctl, &fence)
            .await
            .map_err(|e| {
                if credentials::is_missing_entry(&e) {
                    credentials::provider_key_lost(id.as_str())
                } else {
                    e
                }
            })?;
        drop(fence);
        if !secret.valid() {
            return Err(credentials::unavailable());
        }
        if texts.is_empty() {
            let _guard = self.lock_write(&[])?;
            ctl.check()?;
            self.usable_provider(p, id, v, attempt)?;
            return validate_embeddings(&serde_json::json!({"data":[]}), 0, r.dimensions);
        }
        let endpoint = Endpoint::parse(&r.endpoint_url, self.provider_loopback()?)?;
        let body=serde_json::to_vec(&serde_json::json!({"model":r.model,"input":texts,"dimensions":r.dimensions,"encoding_format":"float"})).map_err(|_|unavailable())?;
        // Closed classification: only the provider call itself (transport,
        // HTTP, an invalid reply) is `EmbeddingFailed`. The pre-send admission
        // callback, deadlines, cancellation and the store/SQL work around the
        // call keep their kind.
        let refused = std::cell::Cell::new(false);
        let bytes = ctl
            .run(egress.post(&endpoint, &secret, body, query, || {
                (|| {
                    ctl.check()?;
                    let _guard = self.lock_write(&[])?;
                    admit()?;
                    self.usable_provider(p, id, v, attempt)?;
                    Ok(())
                })()
                .inspect_err(|_| refused.set(true))
            }))
            .await
            .map_err(|e| match e {
                e if refused.get() => e,
                e @ StoreError::OperationAborted(_) => e,
                // Queries carry their post-admission boundary's classification.
                // Probe/build callers retain their own provider budget.
                StoreError::DeadlineExceeded if query.is_none() => StoreError::EmbeddingTimeout,
                e @ (StoreError::DeadlineExceeded
                | StoreError::EmbeddingTimeout
                | StoreError::EmbeddingFailed) => e,
                _ => StoreError::EmbeddingFailed,
            })?;
        let vectors = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable())
            .and_then(|body| validate_embeddings(&body, texts.len(), r.dimensions))
            .map_err(|_| StoreError::EmbeddingFailed)?;
        let _guard = self.lock_write(&[])?;
        ctl.check()?;
        self.usable_provider(p, id, v, attempt)?;
        Ok(vectors)
    }
}
