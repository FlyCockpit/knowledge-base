//! Durable one-ref publication journal.
//!
//! Every publication (`KB_CREATE`, direct `COMMIT`) is one row in
//! `operation_intents`, keyed by nonnull actor + KB + operation + key, and
//! moves exactly one ref (`refs/heads/main`) with an expected-old CAS:
//!
//! 1. Under the store + KB locks (whose acquisition first resolves every
//!    interrupted intent, see `recovery`), authorize and look the key up. A
//!    known key replays: different request hash -> `IDEMPOTENCY_MISMATCH`
//!    (also after compaction); otherwise current authority is rechecked
//!    before the stored private response or stable failure is returned.
//! 2. Reserve the row as PREPARED (for `KB_CREATE` in the same transaction
//!    as the `CREATING` registry row and its exclusive repo directory).
//! 3. Build objects (lock-inheriting children, see `git_write`), run the
//!    whole-tree validator on the actual commit, and record intended SHA,
//!    validated tree, complete metadata delta and replay response (PREPARED).
//! 4. fsync objects, reauthorize, confirm the ref is still the expected old
//!    value, and durably record COMMITTING.
//! 5. Ref CAS, then one SQLite transaction applies the persisted delta and
//!    marks FINALIZED. Only then does the caller see success.
//!
//! A failure before COMMITTING aborts the row in place (nothing was
//! published). A failure from COMMITTING on is never reported as success
//! and is resolved by recovery from the actual ref.

use kb_client::ErrorCode;
use kb_client::types::{IdempotencyKey, KbId, KbPath, Permission, Sha, Slug, Uuid};
use ring::digest::{SHA256, digest};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::bases::{validate_kb_description, validate_kb_name};
use crate::git_read::GitRepo;
use crate::git_write::{self, ObjectWriter, Scratch, TreeEdit};
use crate::locks::WriteGuard;
use crate::paths::{create_dir_exclusive, sync_dir};
use crate::state::{LocalPrincipal, new_id, new_uuid_v4, now_utc};
use crate::store::{KbRecord, KbState, Store, StoreError, constraint_to_conflict};
use crate::tree::{MANAGED_GITIGNORE, TreeError, validate_commit};

/// Publication stages, reported to the observer seam in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Repository directory exists; the registry/intent transaction is not committed.
    Reserving,
    /// PREPARED with intended SHA, delta and response is durable.
    Prepared,
    /// About to fsync the operation's objects (an `Err` here prevents the
    /// barrier; native I/O errors are independently propagated).
    SyncObjects,
    /// COMMITTING is durable; the ref CAS has not run.
    Committing,
    /// The ref CAS succeeded; nothing is finalized yet.
    RefMoved,
    /// Inside the finalize transaction, before COMMIT (an `Err` here is a
    /// failed finalize).
    Finalizing,
    /// FINALIZED is durable; the reply has not been returned.
    Finalized,
}

/// Journal phase of an operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Prepared,
    Committing,
    Finalized,
    Aborted,
}

impl Phase {
    fn parse(value: &str) -> Result<Phase, StoreError> {
        Ok(match value {
            "PREPARED" => Phase::Prepared,
            "COMMITTING" => Phase::Committing,
            "FINALIZED" => Phase::Finalized,
            "ABORTED" => Phase::Aborted,
            _ => return Err(StoreError::RecoveryRequired("unknown journal phase".into())),
        })
    }
}

/// One published file change: `Some` puts Markdown bytes, `None` deletes.
#[derive(Clone, Debug)]
pub struct FileChange {
    pub path: String,
    pub content: Option<Vec<u8>>,
}

/// A direct commit of up to 32 file changes on `base_revision`.
#[derive(Clone, Debug)]
pub struct CommitRequest {
    pub kb: KbId,
    pub base_revision: Sha,
    pub idempotency_key: String,
    pub changes: Vec<FileChange>,
}

/// Create a KB with its initial tree (`index.md` with the description, the
/// managed `.gitignore`, an empty asset manifest).
#[derive(Clone, Debug)]
pub struct CreateKbRequest {
    pub name: String,
    pub slug: String,
    pub description: String,
    pub idempotency_key: String,
}

/// The stable replay response of a finalized operation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub op_id: Uuid,
    pub kb_id: KbId,
    pub commit_sha: Sha,
    /// `None` for `KB_CREATE`.
    pub base_revision: Option<Sha>,
}

/// Journal row (inspection / tests).
#[derive(Clone, Debug)]
pub struct IntentRow {
    pub op_id: Uuid,
    pub actor_key: String,
    pub kb_id: KbId,
    pub operation: String,
    pub idempotency_key: String,
    pub phase: Phase,
    /// The single ref this operation may move.
    pub ref_name: String,
    pub expected_old: Option<Sha>,
    pub intended_new: Option<Sha>,
    pub compacted: bool,
}

/// Maximum changes in one direct commit (CONTRACT: 32 operations).
pub const MAX_CHANGES: usize = 32;
const OP_CREATE: &str = "KB_CREATE";
const OP_COMMIT: &str = "COMMIT";

pub(crate) type Observer<'a> = &'a mut dyn FnMut(Stage) -> Result<(), StoreError>;
/// Build step output: the repository, every object written, the commit.
type BuildFn<'a> =
    &'a mut dyn FnMut(&WriteGuard) -> Result<(GitRepo, Vec<String>, Sha), StoreError>;
/// Validated changes: path and `Some(bytes)` (put) or `None` (delete).
type Changes = Vec<(KbPath, Option<Vec<u8>>)>;

// ── Hashing ────────────────────────────────────────────────────────────────

pub(crate) fn request_hash(parts: &[&[u8]]) -> String {
    // Length-prefixed fields: no two requests share an encoding.
    let mut bytes = Vec::new();
    for part in parts {
        bytes.extend_from_slice(&(part.len() as u64).to_be_bytes());
        bytes.extend_from_slice(part);
    }
    let hex: String = digest(&SHA256, &bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

pub(crate) fn parse_key(key: &str) -> Result<IdempotencyKey, StoreError> {
    IdempotencyKey::parse(key).map_err(|_| StoreError::InvalidArgument("idempotencyKey".into()))
}

pub(crate) fn epoch_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

// ── Rows ───────────────────────────────────────────────────────────────────

pub(crate) struct Pending {
    pub op_id: Uuid,
    pub kb_id: KbId,
    pub operation: String,
    pub phase: Phase,
    pub ref_name: String,
    pub expected_old: Option<Sha>,
    pub intended_new: Option<Sha>,
    pub delta: Option<String>,
}

pub(crate) struct Known {
    pub op_id: String,
    pub request_hash: String,
    pub phase: Phase,
    pub response: Option<String>,
    pub failure: Option<String>,
}

fn opt_sha(value: Option<String>) -> Result<Option<Sha>, StoreError> {
    value
        .map(|s| Sha::parse(&s).map_err(|_| StoreError::RecoveryRequired("journal sha".into())))
        .transpose()
}

pub(crate) fn parse_uuid(value: &str) -> Result<Uuid, StoreError> {
    Uuid::parse(value).map_err(|_| StoreError::RecoveryRequired("journal op id".into()))
}

fn parse_kb(value: &str) -> Result<KbId, StoreError> {
    KbId::parse(value).map_err(|_| StoreError::RecoveryRequired("journal kb id".into()))
}

pub(crate) fn code_from(value: &str) -> ErrorCode {
    ErrorCode::ALL
        .iter()
        .copied()
        .find(|code| code.as_str() == value)
        .unwrap_or(ErrorCode::Conflict)
}

fn receipt_from(response: &str) -> Result<Receipt, StoreError> {
    let bad = || StoreError::RecoveryRequired("journal response".into());
    let value: Value = serde_json::from_str(response).map_err(|_| bad())?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).ok_or_else(bad);
    Ok(Receipt {
        op_id: parse_uuid(text("opId")?)?,
        kb_id: parse_kb(text("kbId")?)?,
        commit_sha: Sha::parse(text("commitSha")?).map_err(|_| bad())?,
        base_revision: match value.get("baseRevision") {
            Some(Value::String(s)) => Some(Sha::parse(s).map_err(|_| bad())?),
            _ => None,
        },
    })
}

/// The typed metadata delta a finalize applies to the registry row.
pub(crate) struct Delta {
    pub head: Sha,
    pub activate: bool,
    /// `false` for a proposal publication: main, the recorded head and the
    /// desired-index epoch are untouched (nondefault never schedules index
    /// work).
    pub updates_main: bool,
    pub desired_epoch: i64,
    /// KB_CREATE by a capability-narrowed principal: its ceiling on the new
    /// KB, appended in the finalize transaction.
    pub grant: Option<Grant>,
    /// Proposal row effects of a change set that moved its owned source ref.
    pub proposal: Option<crate::proposals::ProposalDelta>,
    pub review: Option<crate::pull_requests::ReviewDelta>,
    pub assets: crate::assets::AssetDelta,
}

/// A ceiling row appended atomically with a KB_CREATE finalize.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Grant {
    pub principal_id: String,
    pub kind: &'static str,
    pub bits: i64,
}

impl Delta {
    pub(crate) fn to_json(&self) -> String {
        json!({
            "headSha": self.head.as_str(),
            "state": if self.activate { "ACTIVE" } else { "UNCHANGED" },
            "updatesMain": self.updates_main,
            "proposal": self.proposal.as_ref().map(crate::proposals::ProposalDelta::to_json),
            "assets": self.assets.to_json(),
            "review": self.review.as_ref().map(crate::pull_requests::ReviewDelta::to_json),
            "desiredEpoch": self.desired_epoch,
            "grant": self.grant.as_ref().map(|g| json!({
                "principalId": g.principal_id,
                "kind": g.kind,
                "bits": g.bits,
            })),
        })
        .to_string()
    }

    pub(crate) fn parse(text: &str) -> Result<Delta, StoreError> {
        let bad = || StoreError::RecoveryRequired("journal delta".into());
        let value: Value = serde_json::from_str(text).map_err(|_| bad())?;
        Ok(Delta {
            assets: value
                .get("assets")
                .map(crate::assets::AssetDelta::parse)
                .transpose()?
                .unwrap_or_default(),
            head: Sha::parse(
                value
                    .get("headSha")
                    .and_then(Value::as_str)
                    .ok_or_else(bad)?,
            )
            .map_err(|_| bad())?,
            activate: match value.get("state").and_then(Value::as_str) {
                Some("ACTIVE") => true,
                Some("UNCHANGED") => false,
                _ => return Err(bad()),
            },
            updates_main: value
                .get("updatesMain")
                .and_then(Value::as_bool)
                .ok_or_else(bad)?,
            proposal: match value.get("proposal") {
                None | Some(Value::Null) => None,
                Some(proposal) => Some(crate::proposals::ProposalDelta::parse(proposal)?),
            },
            review: value
                .get("review")
                .filter(|v| !v.is_null())
                .map(crate::pull_requests::ReviewDelta::parse)
                .transpose()?,
            desired_epoch: value
                .get("desiredEpoch")
                .and_then(Value::as_i64)
                .ok_or_else(bad)?,
            grant: match value.get("grant") {
                None | Some(Value::Null) => None,
                Some(grant) => Some(Grant {
                    principal_id: grant
                        .get("principalId")
                        .and_then(Value::as_str)
                        .ok_or_else(bad)?
                        .to_owned(),
                    kind: match grant.get("kind").and_then(Value::as_str) {
                        Some("CONFIG") => "CONFIG",
                        Some("TEST") => "TEST",
                        _ => return Err(bad()),
                    },
                    bits: grant.get("bits").and_then(Value::as_i64).ok_or_else(bad)?,
                }),
            },
        })
    }
}

/// What the build step produced.
struct Built {
    commit: Sha,
    tree: Sha,
}

impl Store {
    pub(crate) fn find_known(
        &self,
        actor: &str,
        kb: Option<&KbId>,
        operation: &str,
        key: &str,
    ) -> Result<Option<Known>, StoreError> {
        let sql = "SELECT op_id, request_hash, phase, response_json, failure_code \
                   FROM operation_intents WHERE actor_key = ?1 AND operation = ?2 \
                   AND idempotency_key = ?3 AND (?4 IS NULL OR kb_id = ?4)";
        let row = self
            .conn
            .query_row(sql, (actor, operation, key, kb.map(KbId::as_str)), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .optional()?;
        row.map(|(op_id, request_hash, phase, response, failure)| {
            Ok(Known {
                op_id,
                request_hash,
                phase: Phase::parse(&phase)?,
                response,
                failure,
            })
        })
        .transpose()
    }

    /// Replay a known key. Authority is checked by the caller first.
    fn replay(&self, known: Known, hash: &str) -> Result<Receipt, StoreError> {
        if known.request_hash != hash {
            return Err(StoreError::IdempotencyMismatch);
        }
        match known.phase {
            Phase::Finalized => receipt_from(known.response.as_deref().unwrap_or("")),
            Phase::Aborted => Err(StoreError::OperationAborted(code_from(
                known.failure.as_deref().unwrap_or(""),
            ))),
            // Recovery ran under this lock and could not resolve it.
            Phase::Prepared | Phase::Committing => Err(StoreError::RecoveryRequired(format!(
                "operation {} awaits repair",
                known.op_id
            ))),
        }
    }

    /// Journal rows of `kb`, oldest first (bounded).
    pub fn intents(&self, kb: &KbId) -> Result<Vec<IntentRow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT op_id, actor_key, kb_id, operation, idempotency_key, phase, expected_old, \
             intended_new, compacted, ref_name FROM operation_intents WHERE kb_id = ?1 \
             ORDER BY created_at, op_id LIMIT 1000",
        )?;
        let rows = stmt.query_map([kb.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, String>(9)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (op, actor, kb, operation, key, phase, old, new, compacted, ref_name) = row?;
            out.push(IntentRow {
                op_id: parse_uuid(&op)?,
                actor_key: actor,
                kb_id: parse_kb(&kb)?,
                operation,
                idempotency_key: key,
                phase: Phase::parse(&phase)?,
                ref_name,
                expected_old: opt_sha(old)?,
                intended_new: opt_sha(new)?,
                compacted: compacted != 0,
            });
        }
        Ok(out)
    }

    /// One keyset page of unresolved rows. Advance past retained repair and
    /// tombstone evidence as well as rows settled by recovery.
    pub(crate) fn pending(
        &self,
        kb: Option<&KbId>,
        after: Option<&Uuid>,
    ) -> Result<Vec<Pending>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT op_id, kb_id, operation, phase, expected_old, intended_new, delta_json, \
             ref_name FROM operation_intents WHERE phase IN ('PREPARED', 'COMMITTING') \
             AND (?1 IS NULL OR kb_id = ?1) AND (?2 IS NULL OR op_id > ?2) \
             ORDER BY op_id LIMIT 1000",
        )?;
        let rows = stmt.query_map((kb.map(KbId::as_str), after.map(Uuid::as_str)), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (op, kb, operation, phase, old, new, delta, ref_name) = row?;
            out.push(Pending {
                op_id: parse_uuid(&op)?,
                kb_id: parse_kb(&kb)?,
                operation,
                phase: Phase::parse(&phase)?,
                ref_name,
                expected_old: opt_sha(old)?,
                intended_new: opt_sha(new)?,
                delta,
            });
        }
        Ok(out)
    }

    /// Drop the recovery-only delta of every terminal row. Key, request
    /// hash, phase, stable failure and replay response are kept forever.
    pub fn compact_receipts(&self, guard: &WriteGuard) -> Result<usize, StoreError> {
        self.check_guard(guard)?;
        Ok(self.conn.execute(
            "UPDATE operation_intents SET delta_json = NULL, compacted = 1 \
             WHERE phase IN ('FINALIZED', 'ABORTED') AND compacted = 0",
            [],
        )?)
    }

    /// Replace a CONFIG/TEST principal's ceiling on `kb` (empty = revoke).
    pub fn set_principal_permissions(
        &self,
        guard: &WriteGuard,
        principal: &LocalPrincipal,
        kb: &KbId,
        permissions: &[Permission],
    ) -> Result<(), StoreError> {
        self.check_guard(guard)?;
        let Some(kind) = principal.kind().as_db() else {
            return Err(StoreError::InvalidArgument(
                "the owner principal holds every bit".into(),
            ));
        };
        let changed = self.conn.execute(
            "UPDATE principal_ceilings SET bits = ?4 \
             WHERE principal_id = ?1 AND kb_id = ?2 AND kind = ?3",
            (
                principal.id(),
                kb.as_str(),
                kind,
                crate::Bits::from_permissions(permissions).raw(),
            ),
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    /// Abort a PREPARED/COMMITTING row whose ref is provably still old.
    /// `KB_CREATE` also tombstones its reserved KB and releases the slug.
    pub(crate) fn abort_intent(
        &self,
        op_id: &Uuid,
        kb: &KbId,
        create: bool,
        code: ErrorCode,
    ) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE operation_intents SET phase = 'ABORTED', failure_code = ?2, \
             finished_at = ?3 WHERE op_id = ?1 AND phase IN ('PREPARED', 'COMMITTING')",
            (op_id.as_str(), code.as_str(), now_utc()),
        )?;
        if changed == 1 && create {
            // The live-slug index releases the slug; the row keeps it.
            tx.execute(
                "UPDATE kbs SET state = 'TOMBSTONED' WHERE id = ?1 AND state = 'CREATING'",
                [kb.as_str()],
            )?;
        }
        if changed == 1 {
            tx.execute("UPDATE staged_uploads SET reserved_by_op_id=NULL WHERE reserved_by_op_id=?1 AND state='READY'",[op_id.as_str()])?;
        }
        tx.commit()?;
        git_write::remove_scratch(&self.paths, op_id);
        Ok(())
    }

    /// Apply the persisted delta and mark FINALIZED, once.
    pub(crate) fn finalize_intent(
        &self,
        op_id: &Uuid,
        kb: &KbId,
        delta: &Delta,
        observer: Observer<'_>,
    ) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        let old_epoch: i64 = tx.query_row(
            "SELECT desired_epoch FROM kbs WHERE id=?1",
            [kb.as_str()],
            |r| r.get(0),
        )?;
        let updated = if !delta.updates_main {
            // A proposal publication leaves main, head and epoch untouched.
            tx.query_row(
                "SELECT count(*) FROM kbs WHERE id = ?1 AND state = 'ACTIVE'",
                [kb.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| usize::try_from(count).unwrap_or(0))?
        } else if delta.activate {
            tx.execute(
                "UPDATE kbs SET head_sha = ?2, state = 'ACTIVE', desired_epoch = ?3 \
                 WHERE id = ?1 AND state = 'CREATING'",
                (kb.as_str(), delta.head.as_str(), delta.desired_epoch),
            )?
        } else {
            tx.execute(
                "UPDATE kbs SET head_sha = ?2, desired_epoch = ?3 \
                 WHERE id = ?1 AND state = 'ACTIVE'",
                (kb.as_str(), delta.head.as_str(), delta.desired_epoch),
            )?
        };
        let finalized = tx.execute(
            "UPDATE operation_intents SET phase = 'FINALIZED', finished_at = ?2 \
             WHERE op_id = ?1 AND phase = 'COMMITTING'",
            (op_id.as_str(), now_utc()),
        )?;
        if updated != 1 || finalized != 1 {
            return Err(StoreError::RecoveryRequired(
                "journal and registry disagree at finalize".into(),
            ));
        }
        if delta.updates_main && delta.desired_epoch > old_epoch {
            self.enqueue_generation(kb, op_id)?;
        }
        if let Some(grant) = &delta.grant {
            tx.execute(
                "INSERT INTO principal_ceilings (principal_id, kind, kb_id, bits) \
                 VALUES (?1, ?2, ?3, ?4)",
                (&grant.principal_id, grant.kind, kb.as_str(), grant.bits),
            )?;
        }
        if let Some(proposal) = &delta.proposal {
            crate::proposals::apply_proposal_delta(&tx, kb, &delta.head, proposal)?;
        }
        if let Some(review) = &delta.review {
            crate::pull_requests::apply_review_delta(&tx, kb, review)?;
        }
        let actor: String = tx.query_row(
            "SELECT actor_key FROM operation_intents WHERE op_id=?1",
            [op_id.as_str()],
            |r| r.get(0),
        )?;
        delta.assets.finalize(&tx, op_id, kb, &actor)?;
        observer(Stage::Finalizing)?;
        crate::git_read::OperationDeadline::check()?;
        tx.commit()?;
        git_write::remove_scratch(&self.paths, op_id);
        Ok(())
    }

    /// Mark `kb` REPAIR_REQUIRED (an unexplained ref value). Never touches
    /// the ref.
    pub(crate) fn mark_repair(&self, kb: &KbId) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE kbs SET state = 'REPAIR_REQUIRED' WHERE id = ?1 AND state <> 'TOMBSTONED'",
            [kb.as_str()],
        )?;
        Ok(())
    }

    // ── KB_CREATE ──────────────────────────────────────────────────────────

    /// Create a KB (owner only) with its initial commit, idempotently.
    pub fn create_kb(
        &self,
        principal: &LocalPrincipal,
        request: CreateKbRequest,
    ) -> Result<Receipt, StoreError> {
        self.create_kb_observed(principal, request, &mut |_| Ok(()))
    }

    /// [`Store::create_kb`] with a stage observer (crash/fault seam).
    #[doc(hidden)]
    pub fn create_kb_observed(
        &self,
        principal: &LocalPrincipal,
        request: CreateKbRequest,
        observer: Observer<'_>,
    ) -> Result<Receipt, StoreError> {
        let key = parse_key(&request.idempotency_key)?;
        let hash = request_hash(&[
            b"kb-local/KB_CREATE/v1",
            request.name.as_bytes(),
            request.slug.as_bytes(),
            request.description.as_bytes(),
        ]);
        let guard = self.lock_write(&[])?;
        // Create capability first (a principal without one learns nothing
        // about keys), then replay under current read authority.
        let grant = self.create_grant(principal)?;
        let actor = principal.actor_key();
        if let Some(known) = self.find_known(&actor, None, OP_CREATE, key.as_str())? {
            let receipt = self.replay(known, &hash)?;
            self.authorize(principal, &receipt.kb_id, Permission::Read)?;
            return Ok(receipt);
        }
        validate_kb_name(&request.name)?;
        validate_kb_description(&request.description)?;
        if Slug::parse(&request.slug).is_err() {
            return Err(StoreError::InvalidArgument("kb metadata".into()));
        }
        // Validate the exact generated source before charging or reserving.
        let index = format!("# Knowledge base\n\n{}\n", request.description);
        crate::markdown::parse_markdown(index.as_bytes())
            .map_err(|_| StoreError::InvalidArgument("kb initial Markdown".into()))?;
        self.check_create_budgets()?;
        self.check_disk_admission(index.len() as u64)?;
        // Reserve KB row, repo directory and PREPARED intent together.
        let kb = new_id()?;
        let op_id = new_uuid_v4()?;
        let repo_dir = self.paths.repo_dir(&kb);
        {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO kbs (id, name, slug, description, state, created_at) \
                 VALUES (?1, ?2, ?3, ?4, 'CREATING', ?5)",
                (
                    kb.as_str(),
                    &request.name,
                    &request.slug,
                    &request.description,
                    now_utc(),
                ),
            )
            .map_err(|e| constraint_to_conflict(e, "slug already in use"))?;
            insert_prepared(
                &tx,
                &op_id,
                &actor,
                &kb,
                OP_CREATE,
                key.as_str(),
                &hash,
                None,
            )?;
            create_dir_exclusive(&self.paths, &repo_dir)?;
            observer(Stage::Reserving)?;
            if let Err(error) = tx.commit() {
                let _ = std::fs::remove_dir(&repo_dir);
                return Err(error.into());
            }
            sync_dir(&self.paths.root().join("repos"))?;
        }
        let message = commit_message("create knowledge base", &op_id, &actor);
        let publication = Publication {
            op_id: &op_id,
            kb: &kb,
            create: true,
            expected_old: None,
            principal,
            required: Permission::Manage,
            base_revision: None,
            desired_epoch: 1,
            grant,
        };
        self.publish(&guard, &publication, observer, &mut |guard| {
            let repo = git_write::init_repo(&repo_dir, guard)?;
            let scratch = Scratch::new(&self.paths, &op_id)?;
            let mut writer = ObjectWriter::new(&repo, guard, scratch);
            let mut edit = TreeEdit::empty();
            for (path, bytes) in [
                ("index.md", index.as_bytes()),
                (".gitignore", MANAGED_GITIGNORE),
                (
                    ".assets/manifest.json",
                    b"{\"version\":1,\"entries\":[]}\n".as_slice(),
                ),
            ] {
                let blob = writer.blob(bytes)?;
                let path =
                    KbPath::parse(path).map_err(|_| StoreError::Internal("initial path".into()))?;
                edit.put(&path, blob)?;
            }
            let tree = edit.write(&mut writer)?;
            let commit = writer.commit(&tree, None, &message, epoch_now())?;
            let written = writer.written().to_vec();
            drop(writer);
            Ok((repo, written, commit))
        })
    }

    // ── COMMIT ─────────────────────────────────────────────────────────────

    /// Publish `request.changes` on `base_revision` as one commit, needing
    /// live `write`. Idempotent per actor + KB + key.
    pub fn commit_files(
        &self,
        principal: &LocalPrincipal,
        request: CommitRequest,
    ) -> Result<Receipt, StoreError> {
        self.commit_files_observed(principal, request, &mut |_| Ok(()))
    }

    /// [`Store::commit_files`] with a stage observer (crash/fault seam).
    #[doc(hidden)]
    pub fn commit_files_observed(
        &self,
        principal: &LocalPrincipal,
        request: CommitRequest,
        observer: Observer<'_>,
    ) -> Result<Receipt, StoreError> {
        let key = parse_key(&request.idempotency_key)?;
        let changes = parse_changes(&request.changes)?;
        let mut parts: Vec<Vec<u8>> = vec![
            b"kb-local/COMMIT/v1".to_vec(),
            request.kb.as_str().as_bytes().to_vec(),
            request.base_revision.as_str().as_bytes().to_vec(),
        ];
        for (path, content) in &changes {
            parts.push(path.as_str().as_bytes().to_vec());
            match content {
                Some(bytes) => {
                    parts.push(b"put".to_vec());
                    parts.push(bytes.clone());
                }
                None => parts.push(b"delete".to_vec()),
            }
        }
        let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
        let hash = request_hash(&refs);
        let kb = request.kb.clone();
        let guard = self.lock_publication(std::slice::from_ref(&kb))?;
        let actor = principal.actor_key();
        // Unreadable KB -> NOT_FOUND before anything about the key leaks.
        self.authorize(principal, &kb, Permission::Write)?;
        if let Some(known) = self.find_known(&actor, Some(&kb), OP_COMMIT, key.as_str())? {
            return self.replay(known, &hash);
        }
        let record = self.active_record(&kb)?;
        let repo = GitRepo::for_kb(&self.paths, &kb)?;
        let head = record
            .head_sha
            .as_deref()
            .and_then(|s| Sha::parse(s).ok())
            .ok_or_else(|| StoreError::RecoveryRequired("active kb without head".into()))?;
        if git_write::read_main(&repo)?.as_ref() != Some(&head) {
            self.mark_repair(&kb)?;
            return Err(StoreError::RecoveryRequired(
                "main ref changed outside the store".into(),
            ));
        }
        if head != request.base_revision {
            return Err(StoreError::Conflict(
                "baseRevision is not the current head".into(),
            ));
        }
        self.check_disk_admission(
            changes
                .iter()
                .filter_map(|(_, bytes)| bytes.as_ref())
                .map(|b| b.len() as u64)
                .sum(),
        )?;
        let op_id = new_uuid_v4()?;
        {
            let tx = self.conn.unchecked_transaction()?;
            crate::uploads::charge_mutation(&tx, &actor, kb.as_str(), self.now_ms())?;
            insert_prepared(
                &tx,
                &op_id,
                &actor,
                &kb,
                OP_COMMIT,
                key.as_str(),
                &hash,
                Some(&head),
            )?;
            tx.commit()?;
        }
        let message = commit_message("update", &op_id, &actor);
        let publication = Publication {
            op_id: &op_id,
            kb: &kb,
            create: false,
            expected_old: Some(&head),
            principal,
            required: Permission::Write,
            base_revision: Some(&head),
            desired_epoch: record.desired_epoch + 1,
            grant: None,
        };
        self.publish(&guard, &publication, observer, &mut |guard| {
            let repo = GitRepo::for_kb(&self.paths, &kb)?;
            let base_tree = TreeEdit::load(&repo, &head)?;
            let mut edit = base_tree;
            let scratch = Scratch::new(&self.paths, &op_id)?;
            let mut writer = ObjectWriter::new(&repo, guard, scratch);
            for (path, content) in &changes {
                match content {
                    Some(bytes) => {
                        let blob = writer.blob(bytes)?;
                        edit.put(path, blob)?;
                    }
                    None => edit.delete(path)?,
                }
            }
            let tree = edit.write(&mut writer)?;
            let base_info = repo.read_commit(&head)?;
            if tree == base_info.tree.as_str() {
                return Err(StoreError::InvalidArgument(
                    "the change set is empty".into(),
                ));
            }
            let commit = writer.commit(&tree, Some(&head), &message, epoch_now())?;
            let written = writer.written().to_vec();
            drop(writer);
            Ok((repo, written, commit))
        })
    }

    pub(crate) fn active_record(&self, kb: &KbId) -> Result<KbRecord, StoreError> {
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        match record.state {
            KbState::Active => Ok(record),
            KbState::RepairRequired => Err(StoreError::RecoveryRequired(
                "knowledge base needs repair".into(),
            )),
            KbState::Creating | KbState::Tombstoned => Err(StoreError::NotFound),
        }
    }

    /// Steps 3–5 of the module docs for a reserved PREPARED row.
    fn publish(
        &self,
        guard: &WriteGuard,
        publication: &Publication<'_>,
        observer: Observer<'_>,
        build: BuildFn<'_>,
    ) -> Result<Receipt, StoreError> {
        let Publication {
            op_id, kb, create, ..
        } = *publication;
        // Before COMMITTING nothing can have been published: abort in place.
        let prepared = (|| -> Result<(GitRepo, Built), StoreError> {
            let (repo, written, commit) = build(guard)?;
            let validated = match validate_commit(
                &repo,
                &commit,
                &crate::manifest::Policy {
                    store: self,
                    kb,
                    pending: &[],
                    base: publication
                        .base_revision
                        .map(|base| crate::manifest::blob_map(&repo, base))
                        .transpose()?
                        .as_ref(),
                },
            ) {
                Ok(validated) => validated,
                Err(TreeError::Invalid(violation)) => {
                    return Err(StoreError::InvalidArgument(violation.message));
                }
                Err(TreeError::Git(error)) => return Err(error.into()),
            };
            let built = Built {
                commit,
                tree: validated.tree,
            };
            self.record_intended(publication, &built)?;
            observer(Stage::Prepared)?;
            observer(Stage::SyncObjects)?;
            git_write::sync_objects(&repo, &written)?;
            Ok((repo, built))
        })();
        let (repo, built) = match prepared {
            Ok(done) => done,
            Err(error) => {
                let code = match error.protocol_code() {
                    ErrorCode::InvalidArgument => ErrorCode::InvalidArgument,
                    ErrorCode::Forbidden => ErrorCode::Forbidden,
                    _ => ErrorCode::Conflict,
                };
                // If this also fails the row stays PREPARED and recovery
                // aborts it at the next lock acquisition.
                let _ = self.abort_intent(op_id, kb, create, code);
                return Err(error);
            }
        };
        // Reauthorize under the held locks, then confirm the expected old
        // ref before the durable COMMITTING record.
        let committing = (|| -> Result<(), StoreError> {
            self.authorize_publication(publication)?;
            if git_write::read_main(&repo)?.as_ref() != publication.expected_old {
                self.mark_repair(kb)?;
                return Err(StoreError::RecoveryRequired(
                    "main ref changed outside the store".into(),
                ));
            }
            crate::git_read::OperationDeadline::reserve_transport()?;
            let changed = self.conn.execute(
                "UPDATE operation_intents SET phase = 'COMMITTING' \
                 WHERE op_id = ?1 AND phase = 'PREPARED'",
                [op_id.as_str()],
            )?;
            if changed != 1 {
                return Err(StoreError::Internal("intent left PREPARED".into()));
            }
            Ok(())
        })();
        if let Err(error) = committing {
            if !matches!(error, StoreError::RecoveryRequired(_)) {
                let code = match error.protocol_code() {
                    ErrorCode::Forbidden | ErrorCode::NotFound => error.protocol_code(),
                    _ => ErrorCode::Conflict,
                };
                let _ = self.abort_intent(op_id, kb, create, code);
            }
            return Err(error);
        }
        // From here on: never success before FINALIZED; recovery resolves.
        observer(Stage::Committing)?;
        if !git_write::update_main(&repo, guard, &built.commit, publication.expected_old)? {
            return Err(StoreError::StorageUnavailable(
                "ref update was refused; recovery will resolve the operation".into(),
            ));
        }
        observer(Stage::RefMoved)?;
        let delta = Delta {
            head: built.commit.clone(),
            activate: create,
            updates_main: true,
            desired_epoch: publication.desired_epoch,
            grant: publication.grant.clone(),
            proposal: None,
            review: None,
            assets: crate::assets::AssetDelta::default(),
        };
        self.finalize_intent(op_id, kb, &delta, observer)?;
        observer(Stage::Finalized)?;
        Ok(Receipt {
            op_id: op_id.clone(),
            kb_id: kb.clone(),
            commit_sha: built.commit,
            base_revision: publication.base_revision.cloned(),
        })
    }

    fn authorize_publication(&self, publication: &Publication<'_>) -> Result<(), StoreError> {
        if publication.create {
            return match self.create_grant(publication.principal)? == publication.grant {
                true => Ok(()),
                false => Err(StoreError::Forbidden),
            };
        }
        self.authorize(publication.principal, publication.kb, publication.required)
            .map(|_| ())
    }

    fn record_intended(
        &self,
        publication: &Publication<'_>,
        built: &Built,
    ) -> Result<(), StoreError> {
        let delta = Delta {
            head: built.commit.clone(),
            activate: publication.create,
            updates_main: true,
            desired_epoch: publication.desired_epoch,
            grant: publication.grant.clone(),
            proposal: None,
            review: None,
            assets: crate::assets::AssetDelta::default(),
        };
        let response = json!({
            "opId": publication.op_id.as_str(),
            "kbId": publication.kb.as_str(),
            "commitSha": built.commit.as_str(),
            "baseRevision": publication.base_revision.map(Sha::as_str),
        })
        .to_string();
        let changed = self.conn.execute(
            "UPDATE operation_intents SET intended_new = ?2, validated_tree = ?3, \
             delta_json = ?4, response_json = ?5 WHERE op_id = ?1 AND phase = 'PREPARED'",
            (
                publication.op_id.as_str(),
                built.commit.as_str(),
                built.tree.as_str(),
                delta.to_json(),
                response,
            ),
        )?;
        if changed != 1 {
            return Err(StoreError::Internal("intent left PREPARED".into()));
        }
        Ok(())
    }
}

struct Publication<'a> {
    op_id: &'a Uuid,
    kb: &'a KbId,
    create: bool,
    expected_old: Option<&'a Sha>,
    principal: &'a LocalPrincipal,
    required: Permission,
    base_revision: Option<&'a Sha>,
    desired_epoch: i64,
    grant: Option<Grant>,
}

#[allow(clippy::too_many_arguments)]
fn insert_prepared(
    tx: &rusqlite::Transaction<'_>,
    op_id: &Uuid,
    actor: &str,
    kb: &KbId,
    operation: &str,
    key: &str,
    hash: &str,
    expected_old: Option<&Sha>,
) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO operation_intents (op_id, actor_key, kb_id, operation, idempotency_key, \
         request_hash, phase, expected_old, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PREPARED', ?7, ?8)",
        (
            op_id.as_str(),
            actor,
            kb.as_str(),
            operation,
            key,
            hash,
            expected_old.map(Sha::as_str),
            now_utc(),
        ),
    )
    .map_err(|e| constraint_to_conflict(e, "idempotency key already reserved"))?;
    Ok(())
}

pub(crate) fn commit_message(subject: &str, op_id: &Uuid, actor: &str) -> String {
    format!("kb: {subject}\n\nKb-Operation-Id: {op_id}\nKb-Actor: {actor}\n")
}

fn parse_changes(changes: &[FileChange]) -> Result<Changes, StoreError> {
    if changes.is_empty() || changes.len() > MAX_CHANGES {
        return Err(StoreError::InvalidArgument("changes".into()));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(changes.len());
    for change in changes {
        let path =
            KbPath::parse(&change.path).map_err(|_| StoreError::InvalidArgument("path".into()))?;
        if !seen.insert(kb_client::casefold_path_key(path.as_str())) {
            return Err(StoreError::InvalidArgument("duplicate path".into()));
        }
        out.push((path, change.content.clone()));
    }
    out.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
    Ok(out)
}
