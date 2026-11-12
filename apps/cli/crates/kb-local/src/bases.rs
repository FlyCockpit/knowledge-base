//! Local KB lifecycle with the common kb/1 shapes (CONTRACT
//! `knowledge_bases_{list,get,create,update,delete}`).
//!
//! * Create goes through the one-ref journal (`journal.rs`): fixed initial
//!   tree, one root commit, replay per actor + key. The owner holds every
//!   bit; a CONFIG/TEST principal needs a create capability and receives
//!   exactly its `created_kb_bits` ceiling on the new KB, appended in the
//!   finalize transaction. Live-KB quota and the hourly creation window are
//!   checked under the store lock before anything is reserved.
//! * Update/delete are metadata-only receipts written FINALIZED in the same
//!   transaction as the registry change; `metadataVersion` must match.
//!   Delete (owner + manage, `confirm: DELETE`) tombstones: the repository
//!   and history stay on disk, unfinished generations become SUPERSEDED and
//!   unpublished intents abort.
//! * Every private replay rechecks current authority first.

use kb_client::types::{
    BasesCreate, BasesCreateInput, BasesDelete, BasesDeleteInput, BasesDeleteOutput,
    BasesGetOutput, BasesList, BasesListInput, BasesUpdate, BasesUpdateInput, Freshness,
    IndexState, IndexStatus, KbAttachment, KbId, KbMutationOutput, KbRef, MainBranch, Page,
    Permission, Sha, Slug, Tool, True, WriteMode,
};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::collections::BTreeSet;

use crate::cursor::{self, Binding};
use crate::journal::{CreateKbRequest, Phase, parse_key, parse_uuid, request_hash};
use crate::limits::{CREATE_WINDOW_SECS, page_limit};
use crate::locks::{self, WriteGuard};
use crate::state::{
    Bits, LocalPrincipal, PrincipalKind, format_utc, new_uuid_v4, now_secs, now_utc,
};
use crate::store::{KbRecord, KbState, Store, StoreError};

const OP_UPDATE: &str = "KB_UPDATE";
const OP_DELETE: &str = "KB_DELETE";

/// Validate a typed input against the shared kb/1 schema.
pub(crate) fn check_input<T: Tool>(input: &T::Input) -> Result<(), StoreError> {
    use kb_client::error::{ErrorDetails, invalid_input_details};
    kb_client::encode_input::<T>(input)
        .map(|_| ())
        .map_err(|error| match &error {
            kb_client::KbError::Protocol(kb_client::ProtocolError::InvalidInput(violation)) => {
                let value = serde_json::to_value(input).unwrap_or_default();
                match invalid_input_details(violation, &value) {
                    ErrorDetails::InvalidArgument {
                        reason,
                        field,
                        min,
                        max,
                    } => StoreError::invalid_bounded(
                        reason,
                        field,
                        (min, max),
                        "input violates the kb/1 schema",
                    ),
                    _ => StoreError::InvalidArgument("input violates the kb/1 schema".into()),
                }
            }
            _ => StoreError::InvalidArgument("input violates the kb/1 schema".into()),
        })
}

/// Name: 1..120 Unicode scalars, no C0/DEL controls (server parity).
pub(crate) fn validate_kb_name(name: &str) -> Result<(), StoreError> {
    let count = name.chars().count();
    if !(1..=120).contains(&count) || name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(StoreError::InvalidArgument("name".into()));
    }
    Ok(())
}

/// Description uses the same scalar bounds and controls as generated Markdown.
pub(crate) fn validate_kb_description(description: &str) -> Result<(), StoreError> {
    if !(10..=2000).contains(&description.chars().count()) {
        return Err(StoreError::InvalidArgument("description".into()));
    }
    crate::markdown::validate_markdown_bytes(description.as_bytes())
        .map(|_| ())
        .map_err(|_| StoreError::InvalidArgument("description".into()))
}

fn write_mode(bits: Bits) -> WriteMode {
    if bits.contains(Permission::Write) {
        WriteMode::Direct
    } else if bits.contains(Permission::Propose) {
        WriteMode::ProposalRequired
    } else {
        WriteMode::ReadOnly
    }
}

fn parse_state(text: &str) -> Result<IndexState, StoreError> {
    serde_json::from_value(Value::String(text.to_owned()))
        .map_err(|_| StoreError::RecoveryRequired("unknown generation state".into()))
}

fn opt_sha(text: Option<&str>) -> Option<Sha> {
    text.and_then(|s| Sha::parse(s).ok())
}

impl Store {
    // ── Capabilities and budgets ────────────────────────────────────────────

    /// The ceiling a KB_CREATE by `principal` appends: `None` for the owner
    /// (every bit implicitly), the create capability for a narrowed
    /// principal, FORBIDDEN otherwise.
    pub(crate) fn create_grant(
        &self,
        principal: &LocalPrincipal,
    ) -> Result<Option<crate::journal::Grant>, StoreError> {
        let Some(kind) = principal.kind().as_db() else {
            return if principal.id() == self.owner.id() {
                Ok(None)
            } else {
                Err(StoreError::Forbidden)
            };
        };
        let bits: Option<i64> = self
            .conn
            .query_row(
                "SELECT created_kb_bits FROM create_capabilities \
                 WHERE principal_id = ?1 AND kind = ?2",
                (principal.id(), kind),
                |row| row.get(0),
            )
            .optional()?;
        let bits = bits.ok_or(StoreError::Forbidden)?;
        Ok(Some(crate::journal::Grant {
            principal_id: principal.id().to_owned(),
            kind,
            bits,
        }))
    }

    /// Live-KB quota, then the rolling creation window. Runs under the store
    /// lock before any reservation, so a rejection reserves nothing.
    pub(crate) fn check_create_budgets(&self) -> Result<(), StoreError> {
        let limits = self.limits.get();
        let live: i64 = self.conn.query_row(
            "SELECT count(*) FROM kbs WHERE state <> 'TOMBSTONED'",
            [],
            |row| row.get(0),
        )?;
        if live >= i64::from(limits.live_kbs()) {
            return Err(StoreError::QuotaExceeded("live knowledge bases".into()));
        }
        let since = format_utc(now_secs().saturating_sub(CREATE_WINDOW_SECS));
        let recent: i64 = self.conn.query_row(
            "SELECT count(*) FROM operation_intents \
             WHERE operation = 'KB_CREATE' AND created_at >= ?1",
            [since],
            |row| row.get(0),
        )?;
        if recent >= i64::from(limits.creates_per_hour()) {
            return Err(StoreError::RateLimited(CREATE_WINDOW_SECS));
        }
        Ok(())
    }

    /// Register a CONFIG/TEST principal allowed to create KBs; each KB it
    /// creates grants it exactly `created_kb_bits` (must include read).
    pub fn register_creator(
        &self,
        guard: &WriteGuard,
        kind: PrincipalKind,
        created_kb_bits: &[Permission],
    ) -> Result<LocalPrincipal, StoreError> {
        self.check_guard(guard)?;
        let Some(kind_db) = kind.as_db() else {
            return Err(StoreError::InvalidArgument(
                "the owner principal is unique".into(),
            ));
        };
        let bits = Bits::from_permissions(created_kb_bits);
        if !bits.contains(Permission::Read) {
            return Err(StoreError::InvalidArgument(
                "created KB bits must include read".into(),
            ));
        }
        let id = new_uuid_v4()?;
        self.conn.execute(
            "INSERT INTO create_capabilities (principal_id, kind, created_kb_bits, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            (id.as_str(), kind_db, bits.raw(), now_utc()),
        )?;
        Ok(LocalPrincipal::new(id.as_str().to_owned(), kind))
    }

    /// Remove a principal's create capability (existing ceilings stay).
    pub fn revoke_create_capability(
        &self,
        guard: &WriteGuard,
        principal: &LocalPrincipal,
    ) -> Result<(), StoreError> {
        self.check_guard(guard)?;
        let changed = self.conn.execute(
            "DELETE FROM create_capabilities WHERE principal_id = ?1",
            [principal.id()],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    // ── Projections ─────────────────────────────────────────────────────────

    fn kb_attachment(&self, record: &KbRecord, bits: Bits) -> Result<KbAttachment, StoreError> {
        if record.state != KbState::Active {
            return Err(StoreError::RecoveryRequired("kb is not active".into()));
        }
        let (locator, namespace) = self.attachment(&record.id);
        Ok(KbAttachment {
            id: record.id.clone(),
            name: record.name.clone(),
            slug: Slug::parse(&record.slug)
                .map_err(|_| StoreError::RecoveryRequired("malformed slug".into()))?,
            description: record.description.clone(),
            default_branch: MainBranch,
            head_sha: opt_sha(record.head_sha.as_deref())
                .ok_or_else(|| StoreError::RecoveryRequired("kb without head".into()))?,
            metadata_version: record.metadata_version,
            capabilities: bits.permissions(),
            write_mode: write_mode(bits),
            embedding_generation: record.active_generation_id.clone(),
            attachment_locator: locator,
            sealed_namespace: namespace,
        })
    }

    fn generation_state(
        &self,
        kb: &KbId,
        sql: &str,
        arg: &str,
    ) -> Result<Option<(KbId, IndexState)>, StoreError> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(sql, (kb.as_str(), arg), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        row.map(|(id, state)| {
            let id = KbId::parse(&id)
                .map_err(|_| StoreError::RecoveryRequired("malformed generation id".into()))?;
            Ok((id, parse_state(&state)?))
        })
        .transpose()
    }

    /// Freshness over the immutable active and desired snapshots.
    pub(crate) fn index_status(
        &self,
        record: &KbRecord,
        head: &Sha,
    ) -> Result<IndexStatus, StoreError> {
        let active = match &record.active_generation_id {
            Some(id) => self.generation_state(
                &record.id,
                "SELECT id, state FROM index_generations WHERE kb_id = ?1 AND id = ?2",
                id.as_str(),
            )?,
            None => None,
        };
        let desired = self.generation_state(
            &record.id,
            "SELECT id, state FROM index_generations WHERE kb_id = ?1 AND epoch = CAST(?2 AS INTEGER) \
             ORDER BY rowid DESC LIMIT 1",
            &record.desired_epoch.to_string(),
        )?;
        let active_state = active.as_ref().map(|(_, state)| *state);
        let desired_state = desired.as_ref().map(|(_, state)| *state);
        let snapshot = record
            .active_generation_id
            .as_ref()
            .map(|id| self.generation_snapshot(id))
            .transpose()?;
        // A COMPLETE generation always serves: a lexical one whatever the
        // profile, a hybrid one lexically while its profile cannot embed.
        let usable = active_state == Some(IndexState::Complete) && snapshot.is_some();
        let failed = desired_state == Some(IndexState::Failed);
        let building = matches!(
            desired_state,
            Some(IndexState::Pending | IndexState::Building | IndexState::Indexing)
        );
        let indexed_commit_sha = snapshot.as_ref().map(|s| s.commit_sha.clone());
        let (freshness, error_code) = if active.is_some() && !usable {
            (Freshness::Unavailable, Some("INDEX_UNAVAILABLE"))
        } else if failed {
            (Freshness::Failed, Some("INDEX_BUILD_FAILED"))
        } else if building {
            (Freshness::Building, None)
        } else if !usable {
            (Freshness::Unavailable, Some("INDEX_UNAVAILABLE"))
        } else if indexed_commit_sha.as_ref() != Some(head) {
            (Freshness::Stale, None)
        } else {
            (Freshness::Current, None)
        };
        Ok(IndexStatus {
            active_generation_id: active.map(|(id, _)| id),
            desired_generation_id: desired.map(|(id, _)| id),
            desired_epoch: record.desired_epoch.to_string(),
            active_state,
            desired_state,
            indexed_commit_sha,
            head_sha: head.clone(),
            dimensions: snapshot
                .as_ref()
                .and_then(|s| s.profile.as_ref())
                .map(|p| p.dimensions as i64),
            fingerprint: snapshot
                .as_ref()
                .and_then(|s| s.profile.as_ref())
                .map(|p| {
                    kb_client::types::ContentHash::parse(&p.fingerprint)
                        .map_err(|_| StoreError::IndexUnavailable)
                })
                .transpose()?,
            freshness,
            error_code: error_code.map(str::to_owned),
            rebuild_pending: snapshot
                .as_ref()
                .and_then(|s| s.builtin())
                .map(|b| {
                    let live = self.model_state()?;
                    Ok::<_, StoreError>(if live.reloading {
                        Some(kb_client::types::RebuildPendingReason::EmbeddingRuntimeReloading)
                    } else if live.model_id != b.model_id {
                        Some(kb_client::types::RebuildPendingReason::EmbeddingModelChanged)
                    } else if live.context_tokens != b.context_tokens {
                        Some(kb_client::types::RebuildPendingReason::EmbeddingSettingsChanged)
                    } else {
                        None
                    })
                })
                .transpose()?
                .flatten(),
        })
    }

    /// Live attachment of `kb` under `principal`'s current authority.
    /// Authority stays excluded from authorization through response staging:
    /// reuse the caller's held guard, or take the store lock when a mutation
    /// has completed and released its publication guard.
    fn live_attachment(
        &self,
        principal: &LocalPrincipal,
        kb: &KbId,
        held: Option<&WriteGuard>,
    ) -> Result<KbAttachment, StoreError> {
        let _authority = match held {
            Some(guard) => {
                self.check_guard(guard)?;
                None
            }
            None => Some(
                locks::store_lock(&self.paths, true)?
                    .ok_or_else(|| StoreError::Internal("blocking lock returned early".into()))?,
            ),
        };
        let bits = self.authorize(principal, kb, Permission::Read)?;
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        self.kb_attachment(&record, bits)
    }

    // ── Reads ───────────────────────────────────────────────────────────────

    /// `knowledge_bases_list`: live KBs `principal` can read, ordered by ID.
    pub fn bases_list(
        &self,
        principal: &LocalPrincipal,
        input: BasesListInput,
    ) -> Result<Page<KbAttachment>, StoreError> {
        self.bases_list_selected(principal, input, None)
    }

    /// [`Store::bases_list`] limited to a session's KB selection (`kb mcp
    /// --kb`). Unselected KBs are skipped inside the paginated scan, so they
    /// never take a page slot or become a cursor key; the cursor is bound to
    /// the selection and refused under any other one.
    pub fn bases_list_selected(
        &self,
        principal: &LocalPrincipal,
        input: BasesListInput,
        selection: Option<&BTreeSet<String>>,
    ) -> Result<Page<KbAttachment>, StoreError> {
        check_input::<BasesList>(&input)?;
        let limit = page_limit(input.limit)?;
        let selected = selection.map(|kbs| {
            let mut bytes = b"selection:".to_vec();
            for kb in kbs {
                bytes.extend_from_slice(kb.as_bytes());
                bytes.push(b',');
            }
            bytes
        });
        let mut parts: Vec<&[u8]> = vec![b"knowledge_bases_list"];
        parts.extend(selected.as_deref());
        let binding = Binding {
            actor_key: principal.actor_key(),
            kb_id: "*".to_owned(),
            filter_hash: cursor::filter_hash(&parts),
            sort_key: "id",
        };
        let after = match input.cursor.flatten() {
            Some(token) => {
                cursor::verify(&self.cursor_key, &token, &binding, None, self.now_ms())?.last_key
            }
            None => None,
        };
        // Hold authority exclusion through filtering, effective pagination and
        // response staging; revoked rows cannot consume a page slot.
        let _guard = self.lock_write(&[])?;
        let mut items = Vec::new();
        for record in self.live_kbs_after(after.as_deref())? {
            if record.state != KbState::Active
                || record.head_sha.is_none()
                || selection.is_some_and(|kbs| !kbs.contains(record.id.as_str()))
            {
                continue;
            }
            let bits = match self.authorize(principal, &record.id, Permission::Read) {
                Ok(bits) => bits,
                Err(StoreError::NotFound | StoreError::Forbidden) => continue,
                Err(other) => return Err(other),
            };
            items.push(self.kb_attachment(&record, bits)?);
            if items.len() > limit {
                break;
            }
        }
        let next_cursor = if items.len() > limit {
            items.truncate(limit);
            let last = items
                .last()
                .map(|kb| kb.id.as_str().to_owned())
                .unwrap_or_default();
            Some(cursor::sign(
                &self.cursor_key,
                &binding,
                None,
                last,
                self.now_ms(),
            )?)
        } else {
            None
        };
        Ok(Page { items, next_cursor })
    }

    /// `knowledge_bases_get`: attachment plus index status (gated read:
    /// interrupted publications resolve first; repair state is reported).
    pub fn bases_get(
        &self,
        principal: &LocalPrincipal,
        input: KbRef,
    ) -> Result<BasesGetOutput, StoreError> {
        self.authorize(principal, &input.kb_id, Permission::Read)?;
        let record = self.read_kb(&input.kb_id)?;
        let _guard = self.lock_write(&[])?;
        let record = self.kb(&record.id)?.ok_or(StoreError::NotFound)?;
        let bits = self.authorize(principal, &input.kb_id, Permission::Read)?;
        let head = opt_sha(record.head_sha.as_deref())
            .ok_or_else(|| StoreError::RecoveryRequired("active kb without head".into()))?;
        Ok(BasesGetOutput {
            kb: self.kb_attachment(&record, bits)?,
            index: self.index_status(&record, &head)?,
        })
    }

    // ── Mutations ───────────────────────────────────────────────────────────

    /// `knowledge_bases_create` (see module docs).
    pub fn bases_create(
        &self,
        principal: &LocalPrincipal,
        input: BasesCreateInput,
    ) -> Result<KbMutationOutput, StoreError> {
        check_input::<BasesCreate>(&input)?;
        let receipt = self.create_kb(
            principal,
            CreateKbRequest {
                name: input.name,
                slug: input.slug.as_str().to_owned(),
                description: input.description,
                idempotency_key: input.idempotency_key.as_str().to_owned(),
            },
        )?;
        Ok(KbMutationOutput {
            operation_id: receipt.op_id,
            kb: self.live_attachment(principal, &receipt.kb_id, None)?,
        })
    }

    /// `knowledge_bases_update`: manage; pinned `metadataVersion`.
    pub fn bases_update(
        &self,
        principal: &LocalPrincipal,
        input: BasesUpdateInput,
    ) -> Result<KbMutationOutput, StoreError> {
        check_input::<BasesUpdate>(&input)?;
        let key = parse_key(input.idempotency_key.as_str())?;
        let field = |value: &Option<String>| -> Vec<u8> {
            value
                .as_ref()
                .map_or_else(|| b"-".to_vec(), |v| format!("+{v}").into_bytes())
        };
        let hash = request_hash(&[
            b"kb-local/KB_UPDATE/v1",
            input.kb_id.as_str().as_bytes(),
            input.metadata_version.to_string().as_bytes(),
            &field(&input.name),
            &field(&input.description),
        ]);
        let kb = input.kb_id.clone();
        let guard = self.lock_write(std::slice::from_ref(&kb))?;
        self.authorize(principal, &kb, Permission::Manage)?;
        let actor = principal.actor_key();
        if let Some(op_id) = self.replay_metadata(&actor, &kb, OP_UPDATE, key.as_str(), &hash)? {
            return Ok(KbMutationOutput {
                operation_id: op_id,
                kb: self.live_attachment(principal, &kb, Some(&guard))?,
            });
        }
        if let Some(name) = &input.name {
            validate_kb_name(name)?;
        }
        if let Some(description) = &input.description {
            validate_kb_description(description)?;
        }
        let record = self.metadata_record(&kb)?;
        // A common update must produce a usable attachment. Refuse before any
        // metadata or receipt is committed, including unreadied repair rows.
        if record.state != KbState::Active || opt_sha(record.head_sha.as_deref()).is_none() {
            return Err(StoreError::RecoveryRequired("kb is not ready".into()));
        }
        if record.metadata_version != input.metadata_version {
            return Err(StoreError::Conflict("metadata version conflict".into()));
        }
        self.check_disk_admission(0)?;
        let op_id = new_uuid_v4()?;
        let tx = self.conn.unchecked_transaction()?;
        crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
        let changed = tx.execute(
            "UPDATE kbs SET name = coalesce(?3, name), description = coalesce(?4, description), \
             metadata_version = metadata_version + 1 WHERE id = ?1 AND metadata_version = ?2",
            (
                kb.as_str(),
                input.metadata_version,
                input.name.as_deref(),
                input.description.as_deref(),
            ),
        )?;
        if changed != 1 {
            return Err(StoreError::Conflict("metadata version conflict".into()));
        }
        insert_receipt(&tx, &op_id, &actor, &kb, OP_UPDATE, key.as_str(), &hash)?;
        crate::git_read::OperationDeadline::check()?;
        tx.commit()?;
        Ok(KbMutationOutput {
            operation_id: op_id,
            kb: self.live_attachment(principal, &kb, Some(&guard))?,
        })
    }

    /// `knowledge_bases_delete`: owner + manage; tombstone, retaining disk.
    pub fn bases_delete(
        &self,
        principal: &LocalPrincipal,
        input: BasesDeleteInput,
    ) -> Result<BasesDeleteOutput, StoreError> {
        check_input::<BasesDelete>(&input)?;
        let key = parse_key(input.idempotency_key.as_str())?;
        let hash = request_hash(&[
            b"kb-local/KB_DELETE/v1",
            input.kb_id.as_str().as_bytes(),
            input.metadata_version.to_string().as_bytes(),
            b"DELETE",
        ]);
        let kb = input.kb_id.clone();
        let _guard = self.lock_write(std::slice::from_ref(&kb))?;
        let actor = principal.actor_key();
        let is_owner =
            principal.kind() == PrincipalKind::Owner && principal.id() == self.owner.id();
        // The tombstone receipt carries nothing beyond its operation ID; it
        // is replayed only to the (still) owner.
        if let Some(op_id) = self.replay_metadata(&actor, &kb, OP_DELETE, key.as_str(), &hash)? {
            if !is_owner {
                return Err(StoreError::Forbidden);
            }
            return Ok(BasesDeleteOutput {
                operation_id: op_id,
                tombstoned: True,
            });
        }
        self.authorize(principal, &kb, Permission::Manage)?;
        if !is_owner {
            return Err(StoreError::Forbidden);
        }
        let record = self.metadata_record(&kb)?;
        if record.metadata_version != input.metadata_version {
            return Err(StoreError::Conflict("metadata version conflict".into()));
        }
        self.check_disk_admission(0)?;
        let op_id = new_uuid_v4()?;
        let tx = self.conn.unchecked_transaction()?;
        crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
        let changed = tx.execute(
            "UPDATE kbs SET state = 'TOMBSTONED', active_generation_id = NULL, metadata_version = metadata_version + 1 \
             WHERE id = ?1 AND metadata_version = ?2 AND state IN ('ACTIVE', 'REPAIR_REQUIRED')",
            (kb.as_str(), input.metadata_version),
        )?;
        if changed != 1 {
            return Err(StoreError::Conflict("metadata version conflict".into()));
        }
        // Cancel work and release the active pointer for leased retention;
        // the repository and durable history stay on disk.
        // Sealed authority is destroyed in this same tombstone transaction;
        // identities/receipts and the native key for other KBs are retained.
        tx.execute(
            "UPDATE sealed_records SET state='REVOKED',nonce=NULL,ciphertext=NULL WHERE kb_id=?1",
            [kb.as_str()],
        )?;
        tx.execute("DELETE FROM sealed_grants WHERE EXISTS(SELECT 1 FROM sealed_records r WHERE r.namespace=sealed_grants.namespace AND r.record_id=sealed_grants.record_id AND r.kb_id=?1)", [kb.as_str()])?;
        tx.execute(
            "UPDATE index_generations SET state = 'SUPERSEDED', finished_ms = ?2 \
             WHERE kb_id = ?1 AND state IN ('PENDING', 'BUILDING', 'INDEXING')",
            (
                kb.as_str(),
                i64::try_from(self.now_ms()).unwrap_or(i64::MAX),
            ),
        )?;
        tx.execute("UPDATE index_jobs SET state='CANCELLED' WHERE state IN ('PENDING','RUNNING') AND generation_id IN (SELECT id FROM index_generations WHERE kb_id=?1 AND state='SUPERSEDED')",[kb.as_str()])?;
        tx.execute(
            "UPDATE operation_intents SET phase = 'ABORTED', failure_code = 'NOT_FOUND', \
             finished_at = ?2 WHERE kb_id = ?1 AND phase = 'PREPARED'",
            (kb.as_str(), now_utc()),
        )?;
        tx.execute("UPDATE staged_uploads SET reserved_by_op_id=NULL WHERE kb_id=?1 AND reserved_by_op_id IN (SELECT op_id FROM operation_intents WHERE kb_id=?1 AND phase='ABORTED')",[kb.as_str()])?;
        insert_receipt(&tx, &op_id, &actor, &kb, OP_DELETE, key.as_str(), &hash)?;
        crate::git_read::OperationDeadline::check()?;
        tx.commit()?;
        Ok(BasesDeleteOutput {
            operation_id: op_id,
            tombstoned: True,
        })
    }

    /// A live (ACTIVE or REPAIR_REQUIRED) registry row for metadata changes.
    fn metadata_record(&self, kb: &KbId) -> Result<KbRecord, StoreError> {
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        match record.state {
            KbState::Active | KbState::RepairRequired => Ok(record),
            KbState::Creating | KbState::Tombstoned => Err(StoreError::NotFound),
        }
    }

    /// Replay a finalized metadata receipt: its operation ID, or mismatch.
    fn replay_metadata(
        &self,
        actor: &str,
        kb: &KbId,
        operation: &str,
        key: &str,
        hash: &str,
    ) -> Result<Option<kb_client::types::Uuid>, StoreError> {
        let Some(known) = self.find_known(actor, Some(kb), operation, key)? else {
            return Ok(None);
        };
        if known.request_hash != hash {
            return Err(StoreError::IdempotencyMismatch);
        }
        if known.phase != Phase::Finalized {
            return Err(StoreError::RecoveryRequired("metadata receipt".into()));
        }
        parse_uuid(&known.op_id).map(Some)
    }
}

fn insert_receipt(
    tx: &rusqlite::Transaction<'_>,
    op_id: &kb_client::types::Uuid,
    actor: &str,
    kb: &KbId,
    operation: &str,
    key: &str,
    hash: &str,
) -> Result<(), StoreError> {
    let now = now_utc();
    let response = json!({ "opId": op_id.as_str(), "kbId": kb.as_str() }).to_string();
    tx.execute(
        "INSERT INTO operation_intents (op_id, actor_key, kb_id, operation, idempotency_key, \
         request_hash, phase, response_json, created_at, finished_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'FINALIZED', ?7, ?8, ?8)",
        (
            op_id.as_str(),
            actor,
            kb.as_str(),
            operation,
            key,
            hash,
            response,
            now,
        ),
    )?;
    Ok(())
}
