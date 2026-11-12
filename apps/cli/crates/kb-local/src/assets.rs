//! Asset tools use the atomic edit service. Store -> sorted source/target KB
//! locks -> SQLite; COMMITTING is the authorized reservation, never a lock.
use crate::{
    LocalPrincipal, Store, StoreError,
    bases::check_input,
    changes::{ChangeSet, hash_of},
    cursor::{self, Binding},
    git_read::GitRepo,
    journal::Observer,
    manifest,
    tree::ManifestEntry,
};
use kb_client::types::*;
use rusqlite::Connection;
use serde_json::{Value, json};

#[derive(Default)]
pub(crate) struct AssetDelta {
    pub uploads: Vec<Uuid>,
    pub lineages: Vec<(ManifestEntry, Option<AssetSource>)>,
}
impl AssetDelta {
    pub(crate) fn entries(&self) -> Vec<ManifestEntry> {
        self.lineages.iter().map(|(e, _)| e.clone()).collect()
    }
    pub(crate) fn to_json(&self) -> Value {
        json!({"uploads":self.uploads,"lineages":self.lineages.iter().map(|(e,s)|json!({"entry":{"path":e.path,"hash":e.hash,"size":e.size,"mime":e.mime},"source":s})).collect::<Vec<_>>()})
    }
    pub(crate) fn parse(value: &Value) -> Result<Self, StoreError> {
        let bad = || StoreError::RecoveryRequired("asset journal delta".into());
        let uploads = serde_json::from_value(value.get("uploads").cloned().ok_or_else(bad)?)
            .map_err(|_| bad())?;
        let mut lineages = Vec::new();
        for row in value
            .get("lineages")
            .and_then(Value::as_array)
            .ok_or_else(bad)?
        {
            let e: AssetRef = serde_json::from_value(row.get("entry").cloned().ok_or_else(bad)?)
                .map_err(|_| bad())?;
            let source = serde_json::from_value(row.get("source").cloned().ok_or_else(bad)?)
                .map_err(|_| bad())?;
            lineages.push((
                ManifestEntry {
                    path: e.path.as_str().into(),
                    hash: e.hash.as_str().into(),
                    size: e.size,
                    mime: serde_json::to_value(e.mime)
                        .map_err(|_| bad())?
                        .as_str()
                        .ok_or_else(bad)?
                        .into(),
                },
                source,
            ));
        }
        Ok(Self { uploads, lineages })
    }
    pub(crate) fn upload(&mut self, id: &Uuid) {
        if !self.uploads.contains(id) {
            self.uploads.push(id.clone());
        }
    }
    pub(crate) fn bind(
        &self,
        conn: &Connection,
        op: &Uuid,
        kb: &KbId,
        actor: &str,
    ) -> Result<(), StoreError> {
        for id in &self.uploads {
            if conn.execute("UPDATE staged_uploads SET reserved_by_op_id=?2 WHERE id=?1 AND kb_id=?3 AND actor_key=?4 AND state='READY' AND reserved_by_op_id IS NULL",(id.as_str(),op.as_str(),kb.as_str(),actor))?!=1 {return Err(StoreError::Conflict("upload ownership lost".into()));}
        }
        Ok(())
    }
    pub(crate) fn finalize(
        &self,
        conn: &Connection,
        op: &Uuid,
        kb: &KbId,
        actor: &str,
    ) -> Result<(), StoreError> {
        for (e, source) in &self.lineages {
            conn.execute("INSERT INTO asset_blobs(hash,size,mime,verified_at) VALUES (?1,?2,?3,?4) ON CONFLICT(hash) DO NOTHING",(&e.hash,e.size as i64,&e.mime,crate::state::now_utc()))?;
            let metadata: (i64, String) = conn.query_row(
                "SELECT size,mime FROM asset_blobs WHERE hash=?1",
                [&e.hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if metadata != (e.size as i64, e.mime.clone()) {
                return Err(manifest::unavailable());
            }
            conn.execute("INSERT INTO kb_asset_lineage(kb_id,hash,actor_key,source,source_kb_id,source_rev) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(kb_id,hash) DO NOTHING",rusqlite::params![kb.as_str(),e.hash,actor,if source.is_some(){"IMPORT"}else{"UPLOAD"},source.as_ref().map(|s|s.kb_id.as_str()),source.as_ref().map(|s|s.rev.as_str())])?;
        }
        for id in &self.uploads {
            if conn.execute("UPDATE staged_uploads SET state='CONSUMED',reserved=0,consumed_by_op_id=?2,reserved_by_op_id=NULL WHERE id=?1 AND kb_id=?3 AND actor_key=?4 AND state='READY' AND reserved_by_op_id=?2",(id.as_str(),op.as_str(),kb.as_str(),actor))?!=1 {return Err(StoreError::RecoveryRequired("upload consumption lost".into()));}
        }
        Ok(())
    }
}
impl Store {
    pub fn assets_put(
        &self,
        p: &LocalPrincipal,
        input: AssetsPutInput,
    ) -> Result<ApplyResult, StoreError> {
        check_input::<AssetsPut>(&input)?;
        let hash = hash_of(
            "ASSET_PUT",
            serde_json::to_value(&input).map_err(|_| manifest::unavailable())?,
        );
        self.apply_change_set(
            p,
            ChangeSet {
                operation: "ASSET_PUT",
                kb: input.kb_id,
                base: input.base_revision,
                key: input.idempotency_key.as_str().into(),
                title: "Put asset".into(),
                proposal_number: input.proposal_number,
                proposal_head_sha: input.proposal_head_sha.clone(),
                changes: vec![Change::AssetPut {
                    path: input.path,
                    upload_id: input.upload_id,
                }],
                source_session_ids: Vec::new(),
                dream: None,
                import: None,
                hash,
            },
            &mut |_| Ok(()),
        )
    }
    pub fn assets_import(
        &self,
        p: &LocalPrincipal,
        input: AssetsImportInput,
    ) -> Result<ApplyResult, StoreError> {
        self.assets_import_observed(p, input, &mut |_| Ok(()))
    }
    #[doc(hidden)]
    pub fn assets_import_observed(
        &self,
        p: &LocalPrincipal,
        input: AssetsImportInput,
        observer: Observer<'_>,
    ) -> Result<ApplyResult, StoreError> {
        check_input::<AssetsImport>(&input)?;
        let hash = hash_of(
            "ASSET_IMPORT",
            serde_json::to_value(&input).map_err(|_| manifest::unavailable())?,
        );
        self.apply_change_set(
            p,
            ChangeSet {
                operation: "ASSET_IMPORT",
                kb: input.kb_id,
                base: input.base_revision,
                key: input.idempotency_key.as_str().into(),
                title: "Import asset".into(),
                proposal_number: input.proposal_number,
                proposal_head_sha: input.proposal_head_sha.clone(),
                changes: Vec::new(),
                source_session_ids: Vec::new(),
                dream: None,
                import: Some((input.path, input.source)),
                hash,
            },
            observer,
        )
    }
    pub(crate) fn import_entry(
        &self,
        p: &LocalPrincipal,
        source: &AssetSource,
    ) -> Result<ManifestEntry, StoreError> {
        self.authorize(p, &source.kb_id, Permission::Read)?;
        let record = self.active_record(&source.kb_id)?;
        let repo = GitRepo::for_kb(&self.paths, &source.kb_id)?;
        if crate::git_write::read_main(&repo)?
            .as_ref()
            .map(Sha::as_str)
            != record.head_sha.as_deref()
        {
            self.mark_repair(&source.kb_id)?;
            return Err(StoreError::RecoveryRequired(
                "source main changed outside the store".into(),
            ));
        }
        repo.resolve_readable_commit(&source.rev)
            .map_err(|e| match e {
                crate::git_read::GitError::NotFound => StoreError::NotFound,
                other => other.into(),
            })?;
        self.manifest_entries(&source.kb_id, &repo, &source.rev)?
            .into_iter()
            .find(|e| e.hash == source.hash.as_str())
            .ok_or(StoreError::NotFound)
    }
    pub(crate) fn check_lineage_quota(
        &self,
        kb: &KbId,
        delta: &AssetDelta,
    ) -> Result<(), StoreError> {
        let mut extra = 0u64;
        let mut seen = std::collections::HashSet::new();
        for (e, _) in &delta.lineages {
            let has: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM kb_asset_lineage WHERE kb_id=?1 AND hash=?2)",
                (kb.as_str(), &e.hash),
                |r| r.get(0),
            )?;
            if !has && seen.insert(&e.hash) {
                extra += e.size;
            }
        }
        let kb_bytes:i64=self.conn.query_row("SELECT coalesce(sum(b.size),0) FROM kb_asset_lineage l JOIN asset_blobs b ON b.hash=l.hash WHERE l.kb_id=?1",[kb.as_str()],|r|r.get(0))?;
        let all:i64=self.conn.query_row("SELECT coalesce(sum(b.size),0) FROM kb_asset_lineage l JOIN asset_blobs b ON b.hash=l.hash",[],|r|r.get(0))?;
        let (reserved,kb_reserved):(u64,u64)=self.conn.query_row("SELECT coalesce(sum(size),0),coalesce(sum(CASE WHEN kb_id=?1 THEN size ELSE 0 END),0) FROM staged_uploads WHERE reserved=1",[kb.as_str()],|r|Ok((crate::uploads::unsigned(r,0)?,crate::uploads::unsigned(r,1)?)))?;
        // One producer fence owns these READY rows; the finalize transaction
        // releases exactly their unique reservations while adding lineage.
        let consumed = delta.uploads.iter().try_fold(0u64, |total, id| {
            self.conn
                .query_row(
                    "SELECT size FROM staged_uploads WHERE id=?1 AND kb_id=?2 AND reserved=1",
                    (id.as_str(), kb.as_str()),
                    |r| crate::uploads::unsigned(r, 0),
                )
                .map(|size| total + size)
        })?;
        if kb_bytes as u64 + kb_reserved - consumed + extra > 1 << 30
            || all as u64 + reserved - consumed + extra > 5u64 << 30
        {
            return Err(StoreError::QuotaExceeded("asset lineage".into()));
        }
        Ok(())
    }
    pub fn assets_list(
        &self,
        p: &LocalPrincipal,
        input: AssetsListInput,
    ) -> Result<Page<AssetRef>, StoreError> {
        check_input::<AssetsList>(&input)?;
        self.authorize(p, &input.kb_id, Permission::Read)?;
        let binding = Binding {
            actor_key: p.actor_key(),
            kb_id: input.kb_id.as_str().into(),
            filter_hash: cursor::filter_hash(&[b"knowledge_assets_list"]),
            sort_key: "path",
        };
        let (rev, after) = match input.cursor.flatten() {
            Some(token) => {
                let c = cursor::verify(
                    &self.cursor_key,
                    &token,
                    &binding,
                    input.rev.as_ref(),
                    self.now_ms(),
                )?;
                (
                    Some(c.revision.ok_or(StoreError::InvalidCursor)?),
                    c.last_key,
                )
            }
            None => (input.rev, None),
        };
        let (repo, rev) = self.pinned_revision(p, &input.kb_id, rev.as_ref())?;
        let mut entries = self.manifest_entries(&input.kb_id, &repo, &rev)?;
        entries.retain(|e| {
            after
                .as_ref()
                .is_none_or(|a| e.path.encode_utf16().cmp(a.encode_utf16()).is_gt())
        });
        let limit = crate::limits::page_limit(input.limit)?;
        let more = entries.len() > limit;
        entries.truncate(limit);
        let items = entries
            .iter()
            .map(manifest::asset_ref)
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if more {
            entries
                .last()
                .map(|e| {
                    cursor::sign(
                        &self.cursor_key,
                        &binding,
                        Some(rev),
                        e.path.clone(),
                        self.now_ms(),
                    )
                })
                .transpose()?
        } else {
            None
        };
        self.authorize(p, &input.kb_id, Permission::Read)?;
        let page = Page { items, next_cursor };
        crate::limits::check_response_size(
            serde_json::to_vec(&page),
            crate::limits::RESPONSE_MAX_BYTES,
        )?;
        Ok(page)
    }
}
