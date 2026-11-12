//! Query permit -> store/KB fence -> SQLite pin; no inference under the fence.
//! Both arms and projection use the lease's immutable file. Final authorization
//! stages the response under the fence. Dropping any future releases its permit
//! and lease; synchronous SQLite has a cancellation/deadline progress handler.
use crate::{
    LocalPrincipal, Store, StoreError,
    bases::check_input,
    citation::{self, Context, IndexedRow},
    cursor::{self, Binding, Cursor},
    embedder::QueryEmbeddingControl,
    generations::{GenerationReadError, GenerationReadLease, ProfileSnapshot},
    index::IndexEmbedder,
    index_format::{self, FileMeta, IndexQuantization},
    locks,
    structured::{StructuredDocument, StructuredFilters, match_structured_document},
};
use kb_client::{CancellationToken, ErrorCode, types::*};
use rusqlite::{Connection, params};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use tokio::time::Instant;

pub const QUERY_DEADLINE: Duration = Duration::from_secs(60);
pub const CANDIDATES_PER_ARM: usize = 80;
pub const QUERIES_IN_FLIGHT: usize = 4;
/// Budget kept back from the query embedding so a failing or slow embedder
/// still leaves time to serve the lexical arm.
pub const LEXICAL_FALLBACK_RESERVE: Duration = Duration::from_secs(10);
#[derive(Clone, Debug)]
pub struct SearchControl {
    token: CancellationToken,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}
impl Default for SearchControl {
    fn default() -> Self {
        Self::with_timeout(QUERY_DEADLINE)
    }
}
impl SearchControl {
    pub(crate) fn transport(c: &kb_client::stdio::CallControl) -> Self {
        Self {
            token: c.work_token(),
            cancelled: c.work_flag(),
            ..Self::default()
        }
    }
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            token: CancellationToken::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Instant::now() + timeout.min(QUERY_DEADLINE),
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.token.cancel();
    }
    /// The query embedding's share of the budget: it leaves
    /// [`LEXICAL_FALLBACK_RESERVE`] (at most a quarter of what is left) for
    /// the lexical fallback. Admission uses this whole share; the
    /// target call gets its own bound only after admission.
    fn embedding_remaining(&self) -> Duration {
        let remaining = self.remaining();
        remaining.saturating_sub(LEXICAL_FALLBACK_RESERVE.min(remaining / 4))
    }
    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
    fn git_scope(&self) -> crate::git_read::OperationDeadline {
        crate::git_read::OperationDeadline::bounded(
            std::time::Instant::now() + self.remaining(),
            self.cancelled.clone(),
        )
    }
    fn check(&self) -> Result<(), StoreError> {
        if self.token.is_cancelled() {
            Err(StoreError::OperationAborted(ErrorCode::Cancelled))
        } else if Instant::now() >= self.deadline {
            Err(StoreError::DeadlineExceeded)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchStage {
    BeforeAdmission,
    Pinned,
    BeforeDispatch,
    AfterEmbedding,
    /// Request-wide work, shared by both arms and citation/page selection.
    Eligible {
        documents: usize,
        decoded_rows: usize,
        chunks: usize,
        row_links: usize,
    },
    Vector,
    Fts,
    BeforeReturn,
}
type Ranked = (String, u64, f64);
/// One best rank per chunk per arm, rank1 starts at one, UTF8 path/ordinal ties.
pub fn fuse_ranks(arms: &[Vec<(String, u64)>]) -> Vec<Ranked> {
    let mut scores = BTreeMap::new();
    for arm in arms {
        let mut seen = BTreeSet::new();
        let mut rank = 0;
        for key in arm {
            if seen.insert(key) {
                rank += 1;
                *scores.entry(key.clone()).or_insert(0.) += 1. / (60. + rank as f64);
            }
        }
    }
    let mut hits = scores
        .into_iter()
        .map(|((p, i), s)| (p, i, s))
        .collect::<Vec<_>>();
    hits.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    hits
}
/// L-25 (TS `normalizedRrfScore`): the reply score in (0, 1], the fused RRF
/// sum over its maximum for the arms that ran (`rrf * 61 / arms`). Same
/// float operations on both sides; orders exactly like the fused sum.
pub fn normalized_score(rrf: f64, arms: f64) -> f64 {
    (rrf * 61.) / arms
}
/// The one effective execution mode of a search. It starts from the
/// pinned generation and only ever degrades to lexical — when the profile
/// stops being able to embed queries or the query embedding fails — and every
/// later check, the arms, the projection, the notices and the final return
/// read it from here.
#[derive(Clone, Copy, Debug)]
struct Mode {
    lexical: bool,
    /// Why the search is lexical-only (LEXICAL_ONLY notice detail).
    lexical_only: Option<LexicalOnlyReason>,
}
struct Pin {
    lease: GenerationReadLease,
    name: String,
    status: IndexStatus,
    mode: std::cell::Cell<Mode>,
    _permit: locks::CredentialFence,
}
impl Pin {
    fn lexical(&self) -> bool {
        self.mode.get().lexical
    }
    fn lexical_only(&self) -> Option<LexicalOnlyReason> {
        self.mode.get().lexical_only
    }
    fn degrade(&self, reason: LexicalOnlyReason) {
        if !self.lexical() {
            self.mode.set(Mode {
                lexical: true,
                lexical_only: Some(reason),
            });
        }
    }
}
// Only this connection's TEMP database is writable. Generation bytes stay
// immutable; closing the lease discards all request state, including on error.
fn prepare_eligible(
    conn: &Connection,
    filters: &StructuredFilters,
    prefix: Option<&str>,
    document_id: Option<&str>,
    ctl: &SearchControl,
    observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
) -> Result<u64, StoreError> {
    ctl.check()?;
    conn.execute_batch("PRAGMA temp_store=MEMORY;
        CREATE TEMP TABLE eligible(id INTEGER PRIMARY KEY,path TEXT NOT NULL,chunk_index INTEGER NOT NULL);
        CREATE TEMP TABLE matched_rows(path TEXT NOT NULL,row_index INTEGER NOT NULL,raw TEXT,PRIMARY KEY(path,row_index)) WITHOUT ROWID;
        CREATE TEMP TABLE row_links(id INTEGER NOT NULL,row_index INTEGER NOT NULL,PRIMARY KEY(id,row_index)) WITHOUT ROWID;")?;
    let mut metadata_filters = filters.clone();
    metadata_filters.structured = None;
    let needs_rows = filters.structured.as_ref().is_some_and(|c| !c.is_empty());
    let mut documents = 0;
    let mut decoded_rows = 0;
    let mut chunks = 0;
    let mut row_links = 0;
    let mut eligible = 0u64;
    let mut docs = conn.prepare("SELECT path,metadata_json FROM documents WHERE (?1 IS NULL OR substr(path,1,length(?1))=?1) AND (?2 IS NULL OR document_id=?2) ORDER BY path")?;
    let mut chunk_query = conn.prepare("SELECT id,chunk_index,start_byte,end_byte FROM chunks WHERE path=?1 ORDER BY start_byte,end_byte")?;
    let mut add_chunk = conn.prepare("INSERT INTO eligible VALUES(?1,?2,?3)")?;
    let mut add_row = conn.prepare("INSERT INTO matched_rows VALUES(?1,?2,?3)")?;
    let mut add_link = conn.prepare("INSERT INTO row_links VALUES(?1,?2)")?;
    let mut docs = docs.query(params![prefix, document_id])?;
    while let Some(d) = docs.next()? {
        ctl.check()?;
        documents += 1;
        let path: String = d.get(0)?;
        let mut metadata: serde_json::Value = citation::decode(&d.get::<_, String>(1)?)?;
        metadata["rows"] = json!([]);
        let mut doc: StructuredDocument =
            serde_json::from_value(metadata).map_err(|_| StoreError::IndexUnavailable)?;
        if match_structured_document(&doc, &metadata_filters)?.is_empty() {
            continue;
        }
        let indexed = if needs_rows {
            let raw: String = conn.query_row(
                "SELECT rows_json FROM documents WHERE path=?1",
                [&path],
                |r| r.get(0),
            )?;
            let indexed: Vec<IndexedRow> = citation::decode(&raw)?;
            decoded_rows += indexed.len();
            doc.rows = indexed.iter().map(|r| r.row.clone()).collect();
            let matched = match_structured_document(&doc, filters)?
                .into_iter()
                .flatten()
                .map(|r| r.row_index)
                .collect::<BTreeSet<_>>();
            indexed
                .into_iter()
                .filter(|r| matched.contains(&r.row.row_index))
                .collect::<Vec<_>>()
        } else {
            // Metadata-only queries never read or decode the document's rows.
            add_row.execute(params![path, -1, Option::<String>::None])?;
            vec![]
        };
        // Parser rows have disjoint, increasing source spans; filtering retains
        // their original (possibly sparse) ordinals. Resolve overlaps with two
        // binary searches, never scan all rows or copy their JSON per chunk.
        for r in &indexed {
            ctl.check()?;
            add_row.execute(params![
                path,
                r.row.row_index as i64,
                serde_json::to_string(r).map_err(|_| StoreError::IndexUnavailable)?
            ])?;
        }
        let mut source_chunks = chunk_query.query([&path])?;
        while let Some(c) = source_chunks.next()? {
            ctl.check()?;
            chunks += 1;
            let id: i64 = c.get(0)?;
            let start = u64::from(c.get::<_, u32>(2)?);
            let end = u64::from(c.get::<_, u32>(3)?);
            let first = indexed.partition_point(|r| r.row.span.end_byte <= start);
            let last = indexed.partition_point(|r| r.row.span.start_byte < end);
            if needs_rows && first == last {
                continue;
            }
            add_chunk.execute(params![id, path, c.get::<_, u32>(1)?])?;
            eligible += 1;
            if needs_rows {
                for r in &indexed[first..last] {
                    ctl.check()?;
                    add_link.execute(params![id, r.row.row_index as i64])?;
                    row_links += 1;
                }
            } else {
                add_link.execute(params![id, -1])?;
                row_links += 1;
            }
        }
    }
    ctl.check()?;
    observer(SearchStage::Eligible {
        documents,
        decoded_rows,
        chunks,
        row_links,
    })?;
    Ok(eligible)
}
type ArmRow = (i64, String, u64);
/// Vector arm over `temp.eligible` (§1.4). int8: per-slice vec0
/// KNN (`k = VEC0_SLICE_K`, `rowid IN eligible`), merged and cut to 80. binary_int8_rescore: hamming to the
/// global K(n) candidates by (distance, id), then int8 cosine rescore.
fn vector_arm(
    conn: &Connection,
    meta: &FileMeta,
    unit: &[f32],
    eligible: u64,
) -> Result<Vec<ArmRow>, StoreError> {
    let row = |r: &rusqlite::Row<'_>| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            u64::from(r.get::<_, u32>(2)?),
        ))
    };
    let int8 = || -> Result<Vec<u8>, StoreError> {
        Ok(index_format::i8_bytes(&index_format::quantize_int8(
            unit,
            meta.int8_scale.ok_or(StoreError::IndexUnavailable)?,
        )?))
    };
    let limit = CANDIDATES_PER_ARM as i64;
    let rows = match meta.quantization.ok_or(StoreError::IndexUnavailable)? {
        IndexQuantization::BinaryInt8Rescore => {
            let k = index_format::rescore_k(eligible);
            let candidates = conn
                .prepare("SELECT b.id FROM chunk_bits b WHERE b.id IN (SELECT id FROM eligible) ORDER BY vec_distance_hamming(vec_bit(b.b),vec_bit(?1)),b.id LIMIT ?2")?
                .query_map(
                    params![index_format::binary_bits(unit), i64::try_from(k).map_err(|_| StoreError::IndexUnavailable)?],
                    |r| r.get::<_, i64>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            if candidates.is_empty() {
                return Ok(vec![]);
            }
            let ids =
                serde_json::to_string(&candidates).map_err(|_| StoreError::IndexUnavailable)?;
            conn.prepare("SELECT i.id,c.path,c.chunk_index FROM chunk_int8 i JOIN chunks c ON c.id=i.id WHERE i.id IN (SELECT value FROM json_each(?1)) ORDER BY vec_distance_cosine(vec_int8(i.e),vec_int8(?2)),i.id LIMIT ?3")?
                .query_map(params![ids, int8()?, limit], row)?
                .collect::<Result<Vec<_>, _>>()?
        }
        IndexQuantization::Int8 => {
            let value = int8()?;
            // Exactly the server's reader: per stored slice, vec0 KNN with
            // k = VEC0_SLICE_K, merged by (distance, id), cut to 80. vec0
            // permits no ORDER BY beyond its own distance order.
            let mut knn = conn.prepare("SELECT v.rowid,c.path,c.chunk_index,v.distance FROM chunk_vec v JOIN chunks c ON c.id=v.rowid WHERE v.embedding MATCH vec_int8(?1) AND v.k=?2 AND v.slice=?3 AND v.rowid IN (SELECT id FROM eligible)")?;
            let mut hits = vec![];
            for slice in 0..index_format::slice_count(meta.chunk_count)? {
                let slice = i64::try_from(slice).map_err(|_| StoreError::IndexUnavailable)?;
                hits.extend(
                    knn.query_map(
                        params![value, index_format::VEC0_SLICE_K as i64, slice],
                        |r| Ok((row(r)?, r.get::<_, f64>(3)?)),
                    )?
                    .collect::<Result<Vec<_>, _>>()?,
                );
            }
            hits.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.0.cmp(&b.0.0)));
            hits.truncate(CANDIDATES_PER_ARM);
            hits.into_iter().map(|(hit, _)| hit).collect()
        }
    };
    Ok(rows)
}
fn install(conn: &mut Connection, ctl: &SearchControl) -> Result<(), StoreError> {
    let stop = ctl.clone();
    conn.progress_handler(1000, Some(move || stop.check().is_err()))?;
    Ok(())
}
impl Store {
    fn query_pin(
        &self,
        p: &LocalPrincipal,
        kb: &KbId,
        requested: Option<&KbId>,
        ctl: &SearchControl,
    ) -> Result<Pin, GenerationReadError> {
        ctl.check()?;
        // A managed store has one human user. CONFIG/TEST credentials narrow
        // authority, never create new rate windows or cross-KB permit pools.
        let actor = self.owner.actor_key();
        let hash = kb_client::snapshot::content_hash(actor.as_bytes());
        let mut permit = None;
        for slot in 0..QUERIES_IN_FLIGHT {
            if let Some(held) = locks::try_named_model_lock(
                &self.paths,
                &format!("query-{}-{slot}.lock", &hash.as_str()[7..]),
            )? {
                permit = Some(held);
                break;
            }
        }
        let permit = permit.ok_or(StoreError::RateLimited(1))?;
        let _deadline = ctl.git_scope();
        let guard = self.lock_write(std::slice::from_ref(kb))?;
        ctl.check()?;
        self.authorize(p, kb, Permission::Read)?;
        let lease = self.lease_generation_locked(p, kb, requested, &guard)?;
        let record = self.kb(kb)?.ok_or(StoreError::NotFound)?;
        let head = Sha::parse(
            record
                .head_sha
                .as_deref()
                .ok_or(StoreError::IndexUnavailable)?,
        )
        .map_err(|_| StoreError::IndexUnavailable)?;
        let mut status = self.index_status(&record, &head)?;
        if requested.is_some()
            && requested != record.active_generation_id.as_ref()
            && matches!(status.freshness, Freshness::Current | Freshness::Stale)
        {
            status.freshness = Freshness::Stale;
        }
        // A hybrid generation whose profile can no longer embed queries
        // (built-in disabled, provider revoked or unready) still serves its
        // FTS5 arm, with the LEXICAL_ONLY notice saying why.
        let lexical_only = if lease.snapshot.is_lexical() {
            Some(self.lexical_only_reason(kb)?)
        } else if !self.generation_live(&lease.snapshot, false)? {
            Some(self.unusable_profile_reason(lease.snapshot.hybrid_profile()?)?)
        } else if self.builtin_removed(lease.snapshot.hybrid_profile()?)? {
            // Review r2 #4: the model file was removed (removed built-in).
            Some(LexicalOnlyReason::EmbeddingProfileUnavailable)
        } else {
            None
        };
        let lexical = if lexical_only.is_some() {
            true
        } else {
            !self.effective_available(lease.snapshot.hybrid_profile()?)?
        };
        status.indexed_commit_sha = Some(lease.snapshot.commit_sha.clone());
        status.rebuild_pending = lease
            .snapshot
            .builtin()
            .filter(|_| lexical_only.is_none())
            .map(|b| {
                let live = self.model_state()?;
                Ok::<_, StoreError>(if live.reloading {
                    Some(RebuildPendingReason::EmbeddingRuntimeReloading)
                } else if live.model_id != b.model_id {
                    Some(RebuildPendingReason::EmbeddingModelChanged)
                } else if live.context_tokens != b.context_tokens {
                    Some(RebuildPendingReason::EmbeddingSettingsChanged)
                } else {
                    None
                })
            })
            .transpose()?
            .flatten();
        let now = i64::try_from(self.now_ms()).map_err(|_| StoreError::IndexUnavailable)?;
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM query_charges WHERE created_ms<=?1",
            [now.saturating_sub(60_000)],
        )?;
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM query_charges WHERE actor_key=?1 AND kb_id=?2",
            (&actor, kb.as_str()),
            |r| r.get(0),
        )?;
        if count >= crate::limits::LOCAL_QUERIES_PER_MINUTE_PER_KB {
            return Err(StoreError::RateLimited(60).into());
        }
        tx.execute(
            "INSERT INTO query_charges VALUES(?1,?2,?3,?4)",
            (
                crate::state::new_uuid_v4()?.as_str(),
                &actor,
                kb.as_str(),
                now,
            ),
        )?;
        tx.commit()?;
        Ok(Pin {
            lease,
            name: record.name,
            status,
            mode: std::cell::Cell::new(Mode {
                lexical,
                lexical_only,
            }),
            _permit: permit,
        })
    }
    /// Notice detail from the KB's CURRENT profile (server `lexicalNoticeFor`):
    /// a set, unrevoked profile whose desired (epoch-current) generation is a
    /// hybrid one still pending/building reports `SEMANTIC_INDEX_BUILDING`.
    fn lexical_only_reason(&self, kb: &KbId) -> Result<LexicalOnlyReason, StoreError> {
        let raw: Option<String> = self.conn.query_row(
            "SELECT profile_json FROM kbs WHERE id=?1",
            [kb.as_str()],
            |r| r.get(0),
        )?;
        let Some(raw) = raw else {
            return Ok(LexicalOnlyReason::NoEmbeddingProfile);
        };
        let pin: ProfileSnapshot =
            serde_json::from_str(&raw).map_err(|_| StoreError::IndexUnavailable)?;
        let revoked = pin.builtin.is_none()
            && self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM providers WHERE id=?1 AND revoked<>0)",
                [pin.provider_id.as_str()],
                |r| r.get::<_, bool>(0),
            )?;
        if revoked {
            return Ok(LexicalOnlyReason::EmbeddingProfileRevoked);
        }
        let building: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM kbs k JOIN index_generations g ON g.kb_id=k.id AND g.epoch=k.desired_epoch JOIN index_jobs j ON j.generation_id=g.id WHERE k.id=?1 AND json_type(g.snapshot_json,'$.profile')='object' AND g.state IN ('PENDING','BUILDING','INDEXING') AND j.state IN ('PENDING','RUNNING'))",
            [kb.as_str()],
            |r| r.get(0),
        )?;
        Ok(if building {
            LexicalOnlyReason::SemanticIndexBuilding
        } else {
            LexicalOnlyReason::EmbeddingProfileUnavailable
        })
    }
    /// Notice detail of a hybrid generation searched lexically because its
    /// pinned profile cannot embed queries now: a revoked provider says so,
    /// anything else (built-in disabled, provider unready) is "unavailable".
    fn unusable_profile_reason(
        &self,
        pin: &ProfileSnapshot,
    ) -> Result<LexicalOnlyReason, StoreError> {
        let revoked = pin.builtin.is_none()
            && self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM providers WHERE id=?1 AND revoked<>0)",
                [pin.provider_id.as_str()],
                |r| r.get::<_, bool>(0),
            )?;
        Ok(if revoked {
            LexicalOnlyReason::EmbeddingProfileRevoked
        } else {
            LexicalOnlyReason::EmbeddingProfileUnavailable
        })
    }
    /// Why a keyword-pinned continuation is keyword-only: the generation
    /// itself, a profile that still cannot embed, or the pinned first page.
    fn pinned_lexical_reason(&self, pin: &Pin) -> Result<LexicalOnlyReason, StoreError> {
        if let Some(reason) = pin.lexical_only() {
            return Ok(reason);
        }
        let s = &pin.lease.snapshot;
        if !self.generation_live(s, false)? {
            return self.unusable_profile_reason(s.hybrid_profile()?);
        }
        Ok(LexicalOnlyReason::EmbeddingProfileUnavailable)
    }
    fn query_live(
        &self,
        p: &LocalPrincipal,
        pin: &Pin,
        ctl: &SearchControl,
    ) -> Result<(), GenerationReadError> {
        ctl.check()?;
        let _deadline = ctl.git_scope();
        let _guard = self.lock_write(std::slice::from_ref(&pin.lease.snapshot.kb_id))?;
        self.query_live_locked(p, pin, ctl)
    }
    fn query_live_locked(
        &self,
        p: &LocalPrincipal,
        pin: &Pin,
        ctl: &SearchControl,
    ) -> Result<(), GenerationReadError> {
        ctl.check()?;
        let s = &pin.lease.snapshot;
        self.authorize(p, &s.kb_id, Permission::Read)?;
        // Every lock acquisition can reconcile or recover an index. Preserve
        // that generation's repair even when its old connection still reads.
        self.generation_read_repaired(s)?;
        // Live read authority always stands. A profile that can no longer
        // embed queries (revoked, disabled, unready, reloading or another
        // model) degrades the search to the generation's FTS5 arm.
        if pin.lexical() {
            return Ok(());
        }
        // The same effective query availability the serve order uses.
        let profile = s.hybrid_profile()?;
        if !self.effective_available(profile)? {
            pin.degrade(if self.generation_live(s, false)? {
                // Enabled but reloading or serving another model.
                LexicalOnlyReason::EmbeddingProfileUnavailable
            } else {
                self.unusable_profile_reason(profile)?
            });
        }
        Ok(())
    }
    async fn query_vector(
        &self,
        p: &LocalPrincipal,
        pin: &Pin,
        text: &str,
        ctl: &SearchControl,
        embed: &mut impl AsyncFnMut(
            &ProfileSnapshot,
            &str,
            &QueryEmbeddingControl,
        ) -> Result<Vec<f64>, StoreError>,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<Option<Vec<f32>>, GenerationReadError> {
        observer(SearchStage::BeforeDispatch)?;
        self.query_live(p, pin, ctl)?;
        if pin.lexical() {
            return Ok(None);
        }
        let profile = pin.lease.snapshot.hybrid_profile()?;
        let dims = profile.dimensions;
        // R3-L4: a target whose last query embedding timed out is
        // not tried again until its cooldown ends (one half-open probe then).
        let target = format!(
            "{}|{}:{}:{}",
            self.store_uuid(),
            profile.provider_id,
            profile.revision,
            profile.builtin.as_ref().map_or("", |b| b.model_id.as_str())
        );
        let Some(ticket) = crate::breaker::admit(&target, self.now_ms()) else {
            pin.degrade(LexicalOnlyReason::EmbeddingProfileUnavailable);
            return Ok(None);
        };
        let call = QueryEmbeddingControl::new(
            Instant::now() + ctl.embedding_remaining(),
            ctl.token.clone(),
            ctl.cancelled.clone(),
        );
        // Admission is bounded only by the search's budget share. The adapter
        // enters the target-call boundary after credential/authority admission.
        let raw = call.control.run(embed(profile, text, &call)).await;
        // Same quantizer input as the build: u = f32(v / ‖v‖₂), the one
        // normalization of the raw query embedding; an invalid embedding is
        // the embedder failing.
        let unit = match raw {
            Ok(raw) => {
                index_format::unit_vector(&raw, dims).map_err(|_| StoreError::EmbeddingFailed)
            }
            // The search share ran out during admission or a shortened call.
            // It says nothing about the target; keep time for lexical fallback.
            Err(StoreError::DeadlineExceeded) if call.control.check().is_err() => {
                Err(StoreError::EmbeddingFailed)
            }
            Err(e) => Err(e),
        };
        let unit = match unit {
            Ok(unit) => {
                ticket.succeed();
                unit
            }
            // Closed classification by purpose (`degradable_for`): only the
            // embedder's own rejection of this query, while the search itself
            // is live, degrades to the lexical arm. Independent admission,
            // lock and storage failures keep their kind; the exhausted search
            // share has already been classified above without blaming the target.
            Err(e) if e.degradable_for(crate::qwen::Purpose::Query) && ctl.check().is_ok() => {
                // Only a timeout opens the target's breaker: a failure is
                // fast, and a too-long query or an invalid vector says
                // nothing about the next query.
                if matches!(e, StoreError::EmbeddingTimeout) {
                    ticket.fail(self.now_ms());
                }
                pin.degrade(LexicalOnlyReason::EmbeddingProfileUnavailable);
                return Ok(None);
            }
            // A profile lost while the embedding ran is the other degradable
            // class; every other failure (authorization, lease, SQL) stands.
            Err(e) => {
                match self.query_live(p, pin, ctl) {
                    // An independent embedding/admission failure never
                    // inherits the index's retry, even if admission repaired it.
                    Err(GenerationReadError::Repaired(_)) => return Err(e.into()),
                    live => live?,
                }
                if pin.lexical() {
                    return Ok(None);
                }
                return Err(e.into());
            }
        };
        observer(SearchStage::AfterEmbedding)?;
        self.query_live(p, pin, ctl)?;
        Ok((!pin.lexical()).then_some(unit))
    }
    fn hybrid(
        &self,
        p: &LocalPrincipal,
        pin: &Pin,
        query: (&str, Option<Vec<f32>>),
        eligible: u64,
        ctl: &SearchControl,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<Vec<(i64, Ranked)>, GenerationReadError> {
        let (text, vector) = query;
        let conn = pin.lease.connection();
        let mut vector_rows = None;
        if let Some(unit) = vector {
            observer(SearchStage::Vector)?;
            self.query_live(p, pin, ctl)?;
            if !pin.lexical() {
                vector_rows = Some(
                    vector_arm(conn, pin.lease.meta(), &unit, eligible)
                        .map_err(GenerationReadError::ReadFailed)?,
                );
            }
        }
        observer(SearchStage::Fts)?;
        self.query_live(p, pin, ctl)?;
        // A profile lost after the vector arm ran: its ranks never serve.
        if pin.lexical() {
            vector_rows = None;
        }
        // The lexical arm of a hybrid ranking keeps majority matches only.
        let fts =
            fts_arm(conn, text, vector_rows.is_some()).map_err(GenerationReadError::ReadFailed)?;
        let mut ids = BTreeMap::new();
        let mut arms = vec![];
        let mut arm = |rows: Vec<ArmRow>| {
            arms.push(
                rows.into_iter()
                    .map(|(id, path, index)| {
                        ids.insert((path.clone(), index), id);
                        (path, index)
                    })
                    .collect::<Vec<_>>(),
            );
        };
        if let Some(rows) = vector_rows {
            arm(rows);
        }
        arm(fts);
        let ran = arms.len() as f64;
        fuse_ranks(&arms)
            .into_iter()
            .map(|(path, index, rrf)| {
                ids.get(&(path.clone(), index))
                    .copied()
                    .map(|id| (id, (path, index, normalized_score(rrf, ran))))
                    .ok_or(StoreError::IndexUnavailable)
            })
            .collect::<Result<_, StoreError>>()
            .map_err(GenerationReadError::from)
    }
    /// Trusted host seam for an already admitted embedding call. Production
    /// adapters pass credential/authority admission separately below.
    pub async fn search_generation(
        &self,
        p: &LocalPrincipal,
        input: SearchInput,
        ctl: &SearchControl,
        mut embed: impl AsyncFnMut(&ProfileSnapshot, &str) -> Result<Vec<f64>, StoreError>,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<SearchOutput, StoreError> {
        self.search_generation_admitted(
            p,
            input,
            ctl,
            async |pin, text, call| call.run(embed(pin, text)).await,
            observer,
        )
        .await
    }
    async fn search_generation_admitted(
        &self,
        p: &LocalPrincipal,
        input: SearchInput,
        ctl: &SearchControl,
        mut embed: impl AsyncFnMut(
            &ProfileSnapshot,
            &str,
            &QueryEmbeddingControl,
        ) -> Result<Vec<f64>, StoreError>,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<SearchOutput, StoreError> {
        check_input::<KnowledgeSearch>(&input)?;
        ctl.check()?;
        self.authorize(p, &input.kb_id, Permission::Read)?;
        let result = self
            .search_generation_admitted_once(p, input.clone(), ctl, &mut embed, observer)
            .await;
        if let Err(GenerationReadError::Repaired(_generation)) = &result {
            ctl.check()?;
            return self
                .search_generation_admitted_once(p, input, ctl, &mut embed, observer)
                .await
                .map_err(StoreError::from);
        }
        result.map_err(StoreError::from)
    }
    async fn search_generation_admitted_once(
        &self,
        p: &LocalPrincipal,
        input: SearchInput,
        ctl: &SearchControl,
        mut embed: impl AsyncFnMut(
            &ProfileSnapshot,
            &str,
            &QueryEmbeddingControl,
        ) -> Result<Vec<f64>, StoreError>,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<SearchOutput, GenerationReadError> {
        let text = crate::sensitive_text::prepare_embedding_query(&input.query)?;
        observer(SearchStage::BeforeAdmission)?;
        let mut pin = self.query_pin(p, &input.kb_id, None, ctl)?;
        observer(SearchStage::Pinned)?;
        install(pin.lease.connection_mut(), ctl)?;
        let conn = pin.lease.connection();
        let prepared = async {
            let vector = self
                .query_vector(p, &pin, &text, ctl, &mut embed, observer)
                .await?;
            let eligible = prepare_eligible(
                conn,
                &StructuredFilters::default(),
                input.path_prefix.as_ref().map(KbPathPrefix::as_str),
                input.document_id.as_deref(),
                ctl,
                observer,
            )
            .map_err(GenerationReadError::ReadFailed)?;
            Ok((vector, eligible))
        }
        .await;
        ctl.check()?;
        let (mut vector, eligible) = prepared.map_err(|e| self.sql_failure(p, &pin, e, ctl))?;
        loop {
            let out = (|| {
                let ranked =
                    self.hybrid(p, &pin, (&text, vector.take()), eligible, ctl, observer)?;
                let ctx = context(&pin);
                let results = ranked
                    .into_iter()
                    .take(input.limit.unwrap_or(6) as usize)
                    .map(|(id, r)| {
                        citation::project(conn, id, None, r.2, &ctx)
                            .map_err(GenerationReadError::ReadFailed)
                    })
                    .collect::<Result<_, _>>()?;
                Ok(SearchOutput {
                    results,
                    generation_id: pin.lease.snapshot.id.clone(),
                    freshness: pin.status.freshness,
                    indexed_commit_sha: pin.status.indexed_commit_sha.clone(),
                    head_sha: pin.status.head_sha.clone(),
                    index_notices: notices(&pin),
                })
            })();
            ctl.check()?;
            let out = out.map_err(|e| self.sql_failure(p, &pin, e, ctl))?;
            observer(SearchStage::BeforeReturn)?;
            let ranked_lexical = pin.lexical();
            self.finish_query::<KnowledgeSearch>(p, &pin, ctl, &out)?;
            // The final check degraded the mode: rank again lexically, never
            // return vector ranks of a profile that can no longer serve.
            if pin.lexical() == ranked_lexical {
                return Ok(out);
            }
        }
    }
    pub async fn structured_search_generation(
        &self,
        p: &LocalPrincipal,
        input: StructuredSearchInput,
        ctl: &SearchControl,
        mut embed: impl AsyncFnMut(&ProfileSnapshot, &str) -> Result<Vec<f64>, StoreError>,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<StructuredSearchOutput, StoreError> {
        self.structured_search_generation_admitted(
            p,
            input,
            ctl,
            async |pin, text, call| call.run(embed(pin, text)).await,
            observer,
        )
        .await
    }
    async fn structured_search_generation_admitted(
        &self,
        p: &LocalPrincipal,
        input: StructuredSearchInput,
        ctl: &SearchControl,
        mut embed: impl AsyncFnMut(
            &ProfileSnapshot,
            &str,
            &QueryEmbeddingControl,
        ) -> Result<Vec<f64>, StoreError>,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<StructuredSearchOutput, StoreError> {
        check_input::<StructuredSearch>(&input)?;
        ctl.check()?;
        self.authorize(p, &input.kb_id, Permission::Read)?;
        let result = self
            .structured_search_generation_admitted_once(p, input.clone(), ctl, &mut embed, observer)
            .await;
        if input.cursor.as_ref().and_then(Option::as_ref).is_none()
            && let Err(GenerationReadError::Repaired(_generation)) = &result
        {
            ctl.check()?;
            return self
                .structured_search_generation_admitted_once(p, input, ctl, &mut embed, observer)
                .await
                .map_err(StoreError::from);
        }
        match result {
            // A continuation cannot change its generation or ranking keys.
            Err(GenerationReadError::Repaired(_)) => Err(StoreError::InvalidCursor),
            result => result.map_err(StoreError::from),
        }
    }
    async fn structured_search_generation_admitted_once(
        &self,
        p: &LocalPrincipal,
        input: StructuredSearchInput,
        ctl: &SearchControl,
        mut embed: impl AsyncFnMut(
            &ProfileSnapshot,
            &str,
            &QueryEmbeddingControl,
        ) -> Result<Vec<f64>, StoreError>,
        observer: &mut dyn FnMut(SearchStage) -> Result<(), StoreError>,
    ) -> Result<StructuredSearchOutput, GenerationReadError> {
        let filters:StructuredFilters=serde_json::from_value(json!({"type":input.r#type,"title":input.title,"tags":input.tags,"timestamp":input.timestamp,"structured":input.structured})).map_err(|_|StoreError::IndexUnavailable)?;
        // Validate inverted ranges even when the generation contains zero documents.
        let dummy = StructuredDocument {
            r#type: None,
            title: None,
            title_folded: None,
            tags: vec![],
            timestamp: "2000-01-01T00:00:00Z".into(),
            rows: vec![],
        };
        match_structured_document(&dummy, &filters)?;
        let text = input
            .query
            .as_deref()
            .map(crate::sensitive_text::prepare_embedding_query)
            .transpose()?;
        let binding = Binding {
            actor_key: p.actor_key(),
            kb_id: input.kb_id.to_string(),
            filter_hash: cursor::filter_hash(&[json!({"query":text,"filters":filters})
                .to_string()
                .as_bytes()]),
            sort_key: if text.is_some() {
                "hybrid"
            } else {
                "structured"
            },
        };
        let prior = input
            .cursor
            .as_ref()
            .and_then(Option::as_ref)
            .map(|c| cursor::verify(&self.cursor_key, c, &binding, None, self.now_ms()))
            .transpose()?;
        let (requested, after) = match &prior {
            Some(c) => {
                let (id, key) = c
                    .last_key
                    .as_deref()
                    .and_then(|k| k.split_once(':'))
                    .ok_or(StoreError::InvalidCursor)?;
                (
                    Some(KbId::parse(id).map_err(|_| StoreError::InvalidCursor)?),
                    Some(key),
                )
            }
            None => (None, None),
        };
        observer(SearchStage::BeforeAdmission)?;
        let mut pin = self
            .query_pin(p, &input.kb_id, requested.as_ref(), ctl)
            .map_err(|e| {
                if requested.is_some()
                    && matches!(e, GenerationReadError::Failed(StoreError::IndexUnavailable))
                {
                    StoreError::InvalidCursor.into()
                } else {
                    e
                }
            })?;
        if prior
            .as_ref()
            .is_some_and(|c| c.revision.as_ref() != Some(&pin.lease.snapshot.commit_sha))
        {
            return Err(StoreError::InvalidCursor.into());
        }
        observer(SearchStage::Pinned)?;
        // A continuation of a ranked page keeps that page's ranking mode
        // (`h:`/`l:` in the signed key): a keyword-ranked first page stays
        // keyword-ranked even if the profile recovered (keyword ranking is
        // allowed whenever read authority holds).
        let pinned_mode = match (text.is_some(), after) {
            (true, Some(key)) => Some(RankMode::parse(key)?),
            _ => None,
        };
        if pinned_mode == Some(RankMode::Lexical) {
            pin.degrade(self.pinned_lexical_reason(&pin)?);
        }
        install(pin.lease.connection_mut(), ctl)?;
        let conn = pin.lease.connection();
        let limit = input.limit.unwrap_or(20) as usize;
        // Ranked pages: vector and eligibility once, then rank, project and
        // run the final check; a mode degraded by that check ranks again
        // lexically. Queryless pages never depend on a profile.
        let prepared = async {
            match text.as_deref() {
                Some(text) => {
                    let vector = self
                        .query_vector(p, &pin, text, ctl, &mut embed, observer)
                        .await?;
                    let eligible = prepare_eligible(conn, &filters, None, None, ctl, observer)
                        .map_err(GenerationReadError::ReadFailed)?;
                    Ok((vector, eligible))
                }
                None => {
                    prepare_eligible(conn, &filters, None, None, ctl, observer)
                        .map_err(GenerationReadError::ReadFailed)?;
                    Ok((None, 0))
                }
            }
        }
        .await;
        ctl.check()?;
        let (mut vector, eligible) = prepared.map_err(|e| self.sql_failure(p, &pin, e, ctl))?;
        loop {
            let work = (|| {
                let mut ctx = context(&pin);
                let mut page = vec![];
                if let Some(text) = text.as_deref() {
                    let ranked =
                        self.hybrid(p, &pin, (text, vector.take()), eligible, ctl, observer)?;
                    // A hybrid-ranked page cannot continue in keyword ranking:
                    // its keys mean nothing there. The cursor is refused (the
                    // caller restarts the search, which then ranks keyword-only).
                    if pinned_mode == Some(RankMode::Hybrid) && pin.lexical() {
                        return Err(StoreError::InvalidCursor.into());
                    }
                    let mode = RankMode::of(&pin);
                    ctx = context(&pin);
                    let start = match after {
                        None => 0,
                        Some(key) => {
                            ranked
                                .iter()
                                .position(|(_, r)| hybrid_key(mode, r) == key)
                                .ok_or(StoreError::InvalidCursor)?
                                + 1
                        }
                    };
                    for (id, r) in ranked.into_iter().skip(start).take(limit + 1) {
                        let raw:Option<String>=conn.query_row("SELECT m.raw FROM row_links l JOIN eligible e ON e.id=l.id JOIN matched_rows m ON m.path=e.path AND m.row_index=l.row_index WHERE l.id=?1 ORDER BY l.row_index LIMIT 1",[id],|r|r.get(0)).map_err(|e| GenerationReadError::ReadFailed(e.into()))?;
                        let row = raw
                            .as_deref()
                            .map(citation::decode::<IndexedRow>)
                            .transpose()?;
                        page.push((
                            citation::project(conn, id, row.as_ref(), r.2, &ctx)
                                .map_err(GenerationReadError::ReadFailed)?,
                            hybrid_key(mode, &r),
                        ));
                    }
                } else {
                    ctx.mode = SearchMode::Structured;
                    let (path, row) = match after {
                        None => (None, -1),
                        Some(k) => {
                            let (row, path) = k.split_once(':').ok_or(StoreError::InvalidCursor)?;
                            (
                                Some(path),
                                row.parse::<i64>().map_err(|_| StoreError::InvalidCursor)?,
                            )
                        }
                    };
                    let mut q=conn.prepare("WITH page AS (SELECT min(e.id) AS id,e.path,l.row_index FROM eligible e JOIN row_links l ON l.id=e.id WHERE (?1 IS NULL OR e.path>?1 OR (e.path=?1 AND l.row_index>?2)) GROUP BY e.path,l.row_index ORDER BY e.path,l.row_index LIMIT ?3) SELECT p.id,p.path,p.row_index,m.raw FROM page p JOIN matched_rows m ON m.path=p.path AND m.row_index=p.row_index ORDER BY p.path,p.row_index").map_err(|e| GenerationReadError::ReadFailed(e.into()))?;
                    let candidates = q
                        .query_map(params![path, row, (limit + 1) as i64], |r| {
                            Ok((
                                r.get::<_, i64>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, i64>(2)?,
                                r.get::<_, Option<String>>(3)?,
                            ))
                        })
                        .map_err(|e| GenerationReadError::ReadFailed(e.into()))?;
                    for candidate in candidates {
                        ctl.check()?;
                        let (id, path, row, raw) =
                            candidate.map_err(|e| GenerationReadError::ReadFailed(e.into()))?;
                        let matched = raw
                            .as_deref()
                            .map(citation::decode::<IndexedRow>)
                            .transpose()?;
                        page.push((
                            citation::project(conn, id, matched.as_ref(), 1., &ctx)
                                .map_err(GenerationReadError::ReadFailed)?,
                            format!("{row}:{path}"),
                        ));
                    }
                }
                let more = page.len() > limit;
                page.truncate(limit);
                let next_cursor = if more {
                    let key = page.last().ok_or(StoreError::IndexUnavailable)?.1.clone();
                    Some(cursor::sign_cursor(
                        &self.cursor_key,
                        &binding,
                        &Cursor {
                            revision: Some(pin.lease.snapshot.commit_sha.clone()),
                            last_key: Some(format!("{}:{key}", pin.lease.snapshot.id)),
                            expires_ms: prior
                                .as_ref()
                                .map_or(self.now_ms() + 900_000, |c| c.expires_ms),
                        },
                    )?)
                } else {
                    None
                };
                Ok(StructuredSearchOutput {
                    items: page.into_iter().map(|(h, _)| h).collect(),
                    next_cursor,
                    generation_id: pin.lease.snapshot.id.clone(),
                    freshness: pin.status.freshness,
                    indexed_commit_sha: pin.status.indexed_commit_sha.clone(),
                    head_sha: pin.status.head_sha.clone(),
                    index_notices: if text.is_some() {
                        notices(&pin)
                    } else {
                        vec![]
                    },
                })
            })();
            ctl.check()?;
            let out = work.map_err(|e| self.sql_failure(p, &pin, e, ctl))?;
            observer(SearchStage::BeforeReturn)?;
            let ranked_lexical = pin.lexical();
            self.finish_query::<StructuredSearch>(p, &pin, ctl, &out)?;
            if text.is_none() || pin.lexical() == ranked_lexical {
                return Ok(out);
            }
        }
    }
    /// Classify a read failure against the leased generation, including a
    /// repair already committed by recovery while taking the store fence.
    /// Ordinary unavailability and transient IO never authorize a retry.
    fn sql_failure(
        &self,
        p: &LocalPrincipal,
        pin: &Pin,
        error: GenerationReadError,
        ctl: &SearchControl,
    ) -> GenerationReadError {
        let e = match error {
            GenerationReadError::ReadFailed(e) => e,
            GenerationReadError::Failed(e) => return sql_error(e).into(),
            repaired @ GenerationReadError::Repaired(_) => return repaired,
        };
        let _deadline = ctl.git_scope();
        if let StoreError::Sqlite(rusqlite::Error::SqliteFailure(f, _)) = &e
            && !matches!(
                f.code,
                rusqlite::ErrorCode::OperationInterrupted
                    | rusqlite::ErrorCode::DatabaseBusy
                    | rusqlite::ErrorCode::DatabaseLocked
                    | rusqlite::ErrorCode::SystemIoFailure
                    | rusqlite::ErrorCode::DiskFull
                    | rusqlite::ErrorCode::OutOfMemory
                    | rusqlite::ErrorCode::CannotOpen
                    | rusqlite::ErrorCode::PermissionDenied
                    | rusqlite::ErrorCode::FileLockingProtocolFailed
            )
        {
            let s = &pin.lease.snapshot;
            let repair = (|| {
                ctl.check()?;
                let guard = self.lock_write(std::slice::from_ref(&s.kb_id))?;
                self.read_kb_locked(&guard, &s.kb_id)?;
                self.query_live_locked(p, pin, ctl)?;
                // Activation may have superseded s; diagnose its immutable
                // file regardless, and retire only s if it is proven corrupt.
                if self.generation_file_unreadable(&s.kb_id, &s.id, true) {
                    self.lose_generation_file(&s.kb_id, &s.id)?;
                    ctl.check()?;
                    self.generation_read_repaired(s)?;
                }
                Ok(())
            })();
            if let Err(error) = repair {
                return error;
            }
        }
        sql_error(e).into()
    }
    fn finish_query<T: Tool>(
        &self,
        p: &LocalPrincipal,
        pin: &Pin,
        ctl: &SearchControl,
        out: &T::Output,
    ) -> Result<(), GenerationReadError> {
        let _deadline = ctl.git_scope();
        let guard = self.lock_write(std::slice::from_ref(&pin.lease.snapshot.kb_id))?;
        self.read_kb_locked(&guard, &pin.lease.snapshot.kb_id)?;
        self.query_live_locked(p, pin, ctl)?;
        let encoded =
            kb_client::encode_output::<T>(out).map_err(|_| StoreError::IndexUnavailable)?;
        crate::limits::check_response_size(
            serde_json::to_vec(&encoded),
            self.response_limit.get(),
        )?;
        ctl.check().map_err(GenerationReadError::from)
    }
    async fn embed_search(
        &self,
        pin: &ProfileSnapshot,
        text: &str,
        io: &IndexEmbedder<'_>,
        call: &QueryEmbeddingControl,
        admit: &dyn Fn() -> Result<(), StoreError>,
    ) -> Result<Vec<f64>, StoreError> {
        // Closed classification: the provider and model adapters tag only
        // their own call's failure `EmbeddingFailed` (providers.rs, qwen.rs);
        // admission, store, SQL and cancellation failures keep their kind.
        match (io, &pin.builtin) {
            (
                IndexEmbedder::External { keys, egress }
                | IndexEmbedder::Routed { keys, egress, .. },
                None,
            ) => self
                .provider_embed_admitted(
                    &pin.provider_id,
                    pin.revision,
                    &[text.into()],
                    (*keys, egress, call),
                    admit,
                )
                .await?
                .pop()
                .ok_or(StoreError::IndexUnavailable),
            (
                IndexEmbedder::Builtin(runtime)
                | IndexEmbedder::Routed {
                    builtin: runtime, ..
                },
                Some(b),
            ) => {
                let live = self.model_state()?;
                if live.model_id != b.model_id {
                    return Err(StoreError::IndexUnavailable);
                }
                Ok(runtime
                    .embed_query(
                        self,
                        text,
                        &live,
                        (
                            call.control_remaining(),
                            Some(call.cancel_token()),
                            Some(admit),
                            Some(call),
                        ),
                    )?
                    .vector
                    .into_iter()
                    .map(f64::from)
                    .collect())
            }
            _ => Err(StoreError::IndexUnavailable),
        }
    }
    /// The built-in runtime a search embeds with names the model cache its
    /// effective availability reads (review r2 #4).
    fn attach_runtime_cache(&self, io: &IndexEmbedder<'_>) {
        if let IndexEmbedder::Builtin(runtime)
        | IndexEmbedder::Routed {
            builtin: runtime, ..
        } = io
        {
            self.attach_model_cache(runtime.host().cache().clone());
        }
    }
    pub async fn search(
        &self,
        p: &LocalPrincipal,
        input: SearchInput,
        io: IndexEmbedder<'_>,
        ctl: &SearchControl,
    ) -> Result<SearchOutput, StoreError> {
        self.attach_runtime_cache(&io);
        let kb = input.kb_id.clone();
        self.search_generation_admitted(
            p,
            input,
            ctl,
            async |pin, text, call| {
                self.embed_search(pin, text, &io, call, &|| {
                    ctl.check()?;
                    self.authorize(p, &kb, Permission::Read)?;
                    Ok(())
                })
                .await
            },
            &mut |_| Ok(()),
        )
        .await
    }
    pub async fn structured_search(
        &self,
        p: &LocalPrincipal,
        input: StructuredSearchInput,
        io: IndexEmbedder<'_>,
        ctl: &SearchControl,
    ) -> Result<StructuredSearchOutput, StoreError> {
        self.attach_runtime_cache(&io);
        let kb = input.kb_id.clone();
        self.structured_search_generation_admitted(
            p,
            input,
            ctl,
            async |pin, text, call| {
                self.embed_search(pin, text, &io, call, &|| {
                    ctl.check()?;
                    self.authorize(p, &kb, Permission::Read)?;
                    Ok(())
                })
                .await
            },
            &mut |_| Ok(()),
        )
        .await
    }
}
fn context(pin: &Pin) -> Context<'_> {
    Context {
        snapshot: &pin.lease.snapshot,
        name: &pin.name,
        freshness: pin.status.freshness,
        mode: if pin.lexical() {
            SearchMode::Lexical
        } else {
            SearchMode::Hybrid
        },
    }
}
fn notices(pin: &Pin) -> Vec<IndexNotice> {
    let kb_id = pin.lease.snapshot.kb_id.clone();
    if let Some(detail) = pin.lexical_only() {
        return vec![IndexNotice::LexicalOnly(LexicalOnlyNotice {
            kb_id,
            code: LexicalOnlyCode,
            detail,
        })];
    }
    pin.status
        .rebuild_pending
        .map(|detail| {
            vec![IndexNotice::RebuildPending(RebuildPendingNotice {
                kb_id,
                code: RebuildPendingCode,
                detail,
            })]
        })
        .unwrap_or_default()
}
/// The ranking mode a structured-search page was ordered by; continuation
/// keys carry it so later pages keep the same order (TS `RankMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RankMode {
    Hybrid,
    Lexical,
}
impl RankMode {
    fn of(pin: &Pin) -> Self {
        if pin.lexical() {
            Self::Lexical
        } else {
            Self::Hybrid
        }
    }
    fn parse(key: &str) -> Result<Self, StoreError> {
        match key.split_once(':') {
            Some(("h", _)) => Ok(Self::Hybrid),
            Some(("l", _)) => Ok(Self::Lexical),
            _ => Err(StoreError::InvalidCursor),
        }
    }
}
fn hybrid_key(mode: RankMode, r: &Ranked) -> String {
    let tag = match mode {
        RankMode::Hybrid => "h",
        RankMode::Lexical => "l",
    };
    format!("{tag}:{}:{}:{}", r.2, r.1, r.0)
}
fn sql_error(e: StoreError) -> StoreError {
    match e {
        StoreError::Sqlite(_) => StoreError::IndexUnavailable,
        _ => e,
    }
}
/// FTS5 string literal: double quotes inside are doubled.
fn fts_string(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}
fn alnum_runs(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect()
}
static STOPWORDS: std::sync::LazyLock<BTreeSet<String>> = std::sync::LazyLock::new(|| {
    let lists: BTreeMap<String, serde_json::Value> = serde_json::from_str(include_str!(
        "../../../../../packages/api/src/lib/kb/fixtures/stopwords.json"
    ))
    .unwrap_or_default();
    lists
        .values()
        .filter_map(serde_json::Value::as_array)
        .flatten()
        .filter_map(|w| w.as_str().map(str::to_owned))
        .collect()
});
fn is_stopword(run: &str) -> bool {
    STOPWORDS.contains(&run.to_lowercase())
}
/// The lexical arm's query units (TS `ftsUnits`, shared corpus
/// `fixtures/fts-query.json`), each an FTS5 MATCH expression: text between a
/// pair of double quotes (curly quotes count as straight ones) is one exact
/// phrase of its alphanumeric runs, stopwords included, an unpaired quote is
/// ignored; elsewhere each whitespace-separated word is one unit (a punctuated
/// word requires all of its runs). Unquoted stopword runs
/// (`fixtures/stopwords.json`, every locale) are dropped, and a word left with
/// no run is dropped; if that leaves no unit, the units keep their stopwords.
/// Units are de-duplicated case-insensitively, first kept; every unit of the
/// (at most 1024-scalar) query takes part. Every term is a quoted FTS5 string.
pub fn fts_units(text: &str) -> Vec<String> {
    let parse = |drop_stopwords: bool| {
        let normalized = text.replace(['\u{201c}', '\u{201d}'], "\"");
        let parts = normalized.split('"').collect::<Vec<_>>();
        let mut units: Vec<String> = vec![];
        for (at, part) in parts.iter().enumerate() {
            if at % 2 == 1 && at + 1 < parts.len() {
                let runs = alnum_runs(part);
                if !runs.is_empty() {
                    units.push(fts_string(&runs.join(" ")));
                }
                continue;
            }
            for word in part.split(char::is_whitespace) {
                let mut runs = alnum_runs(word);
                if drop_stopwords {
                    runs.retain(|r| !is_stopword(r));
                }
                match runs.as_slice() {
                    [] => {}
                    [run] => units.push(fts_string(run)),
                    runs => units.push(format!(
                        "({})",
                        runs.iter()
                            .map(|r| fts_string(r))
                            .collect::<Vec<_>>()
                            .join(" AND ")
                    )),
                }
            }
        }
        let mut seen = BTreeSet::new();
        units.retain(|u| seen.insert(u.to_lowercase()));
        units
    };
    let units = parse(true);
    if units.is_empty() {
        parse(false)
    } else {
        units
    }
}
/// Any-unit FTS5 MATCH text; no unit => `""` (matches nothing).
fn fts_match(units: &[String]) -> String {
    if units.is_empty() {
        "\"\"".into()
    } else {
        units.join(" OR ")
    }
}
/// (TS `lexicalCoverageFloor`): the fewest distinct units a lexical
/// candidate must match. Lexical-only keeps every any-unit match; the lexical
/// arm of a hybrid search keeps only a strict majority, so a chunk sharing one
/// incidental word with the query cannot outrank the vector arm's best hit.
pub fn coverage_floor(units: usize, hybrid: bool) -> usize {
    if hybrid { units / 2 + 1 } else { 1 }
}
/// FTS5 arm over `temp.eligible` (TS `ftsArm`): candidates match at
/// least [`coverage_floor`] units and rank by distinct units matched, then
/// bm25 over the table-global statistics, then path/ordinal. MATCH drives the
/// scan and eligibility is a membership test (`+rowid`).
fn fts_arm(conn: &Connection, text: &str, hybrid: bool) -> Result<Vec<ArmRow>, StoreError> {
    let units = fts_units(text);
    if units.is_empty() {
        return Ok(vec![]);
    }
    let floor = coverage_floor(units.len(), hybrid) as i64;
    // Coverage: one posting scan per unit counts, in a request-scoped temp
    // table of this lease's connection, the distinct units each chunk
    // matches; every unit of the query takes part (no compound-select or
    // parameter limit applies). A single unit needs none.
    let counted = units.len() > 1;
    if counted {
        conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS fts_coverage(id INTEGER PRIMARY KEY,n INTEGER NOT NULL); DELETE FROM temp.fts_coverage WHERE id IS NOT NULL;",
        )?;
        let mut count = conn.prepare("INSERT INTO temp.fts_coverage(id,n) SELECT rowid,1 FROM chunk_fts WHERE chunk_fts MATCH ?1 ON CONFLICT(id) DO UPDATE SET n=n+1")?;
        for unit in &units {
            count.execute([unit])?;
        }
    }
    let sql = format!(
        "SELECT c.id,c.path,c.chunk_index FROM chunk_fts {} JOIN chunks c ON c.id=chunk_fts.rowid WHERE chunk_fts MATCH ?1 AND +chunk_fts.rowid IN (SELECT id FROM eligible) {} ORDER BY {} bm25(chunk_fts),c.path,c.chunk_index LIMIT ?3",
        if counted {
            "JOIN temp.fts_coverage v ON v.id=chunk_fts.rowid"
        } else {
            ""
        },
        if counted { "AND v.n>=?2" } else { "AND ?2>0" },
        if counted { "v.n DESC," } else { "" },
    );
    let args: [&dyn rusqlite::ToSql; 3] =
        [&fts_match(&units), &floor, &(CANDIDATES_PER_ARM as i64)];
    let rows = conn
        .prepare(&sql)?
        .query_map(args.as_slice(), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                u64::from(r.get::<_, u32>(2)?),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod sqlite_control_tests {
    use super::*;
    #[test]
    fn vector_arm_reads_every_quantization_over_eligible_in_distance_then_id_order() {
        crate::sqlite_vec::register().expect("sqlite-vec");
        let raw: [[f64; 3]; 5] = [
            [1., 0.1, 0.],
            [1., 1., 0.],
            [0., 1., 0.],
            [1., 0., 0.],
            [-1., 0.2, 0.],
        ];
        let units = raw
            .iter()
            .map(|v| index_format::unit_vector(v, 3).expect("unit"))
            .collect::<Vec<_>>();
        let query = index_format::unit_vector(&[1., 0., 0.], 3).expect("unit");
        for q in [
            IndexQuantization::Int8,
            IndexQuantization::BinaryInt8Rescore,
        ] {
            let db = Connection::open_in_memory().expect("SQLite");
            for sql in index_format::render_ddl(q, 3).expect("ddl") {
                db.execute_batch(&sql).expect("shared DDL");
            }
            let scale =
                Some(index_format::int8_scale(units.iter().map(Vec::as_slice)).expect("scale"));
            db.execute(
                "INSERT INTO documents VALUES('a.md','b','c',NULL,'INDEXED',5,'{}','{}','[]')",
                [],
            )
            .expect("document");
            db.execute_batch("CREATE TEMP TABLE eligible(id INTEGER PRIMARY KEY,path TEXT NOT NULL,chunk_index INTEGER NOT NULL)")
                .expect("eligible");
            for (i, unit) in units.iter().enumerate() {
                let id = i as u64 + 1;
                db.execute(
                    "INSERT INTO chunks VALUES(?1,'a.md',?2,0,1,0,1,'t','s')",
                    (id as i64, i as i64),
                )
                .expect("chunk");
                index_format::insert_vectors(&db, q, id, unit, scale).expect("vectors");
                // Chunk 4 is the exact match but not eligible.
                if id != 4 {
                    db.execute(
                        "INSERT INTO eligible VALUES(?1,'a.md',?2)",
                        (id as i64, i as i64),
                    )
                    .expect("eligible");
                }
            }
            let meta = index_format::FileMeta {
                generation_id: String::new(),
                kb_id: String::new(),
                commit_sha: String::new(),
                fingerprint: Some(String::new()),
                dimensions: Some(3),
                quantization: Some(q),
                int8_scale: scale,
                document_count: 1,
                chunk_count: 5,
                host_snapshot: String::new(),
            };
            let ids = vector_arm(&db, &meta, &query, 4)
                .expect("vector arm")
                .into_iter()
                .map(|(id, path, index)| {
                    assert_eq!((path.as_str(), index), ("a.md", id as u64 - 1));
                    id
                })
                .collect::<Vec<_>>();
            assert_eq!(ids, vec![1, 2, 3, 5], "{q:?}");
        }
    }
    #[test]
    fn vector_arm_ties_at_the_candidate_boundary_keep_the_lowest_ids() {
        crate::sqlite_vec::register().expect("sqlite-vec");
        let unit = index_format::unit_vector(&[1., 2., 3.], 3).expect("unit");
        for q in [
            IndexQuantization::Int8,
            IndexQuantization::BinaryInt8Rescore,
        ] {
            let db = Connection::open_in_memory().expect("SQLite");
            for sql in index_format::render_ddl(q, 3).expect("ddl") {
                db.execute_batch(&sql).expect("shared DDL");
            }
            let scale = Some(index_format::int8_scale([unit.as_slice()]).expect("scale"));
            db.execute(
                "INSERT INTO documents VALUES('a.md','b','c',NULL,'INDEXED',100,'{}','{}','[]')",
                [],
            )
            .expect("document");
            db.execute_batch("CREATE TEMP TABLE eligible(id INTEGER PRIMARY KEY,path TEXT NOT NULL,chunk_index INTEGER NOT NULL)")
                .expect("eligible");
            // 100 identical vectors: every distance ties.
            for id in 1..=100u64 {
                db.execute(
                    "INSERT INTO chunks VALUES(?1,'a.md',?2,0,1,0,1,'t','s')",
                    (id as i64, id as i64 - 1),
                )
                .expect("chunk");
                index_format::insert_vectors(&db, q, id, &unit, scale).expect("vectors");
                db.execute(
                    "INSERT INTO eligible VALUES(?1,'a.md',?2)",
                    (id as i64, id as i64 - 1),
                )
                .expect("eligible");
            }
            let meta = index_format::FileMeta {
                generation_id: String::new(),
                kb_id: String::new(),
                commit_sha: String::new(),
                fingerprint: Some(String::new()),
                dimensions: Some(3),
                quantization: Some(q),
                int8_scale: scale,
                document_count: 1,
                chunk_count: 100,
                host_snapshot: String::new(),
            };
            let ids = vector_arm(&db, &meta, &unit, 100)
                .expect("vector arm")
                .into_iter()
                .map(|(id, _, _)| id)
                .collect::<Vec<_>>();
            assert_eq!(ids, (1..=80).collect::<Vec<i64>>(), "{q:?}");
        }
    }
    /// The shared corpus, exact units and the arm's ranking in both
    /// modes (TS twin in `index-file/format.test.ts`).
    #[test]
    fn fts_units_and_arm_match_the_shared_lexical_corpus() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/api/src/lib/kb/fixtures/fts-query.json"
        ))
        .expect("shared corpus");
        for case in corpus["queries"].as_array().expect("queries") {
            let query = case["query"].as_str().expect("query");
            let units = case["units"]
                .as_array()
                .expect("units")
                .iter()
                .map(|u| u.as_str().expect("unit").to_owned())
                .collect::<Vec<_>>();
            assert_eq!(fts_units(query), units, "{query}");
        }
        assert_eq!(fts_match(&[]), "\"\"");
        let db = Connection::open_in_memory().expect("SQLite");
        let fts = index_format::render_lexical_ddl()
            .expect("ddl")
            .into_iter()
            .find(|sql| sql.contains("USING fts5"))
            .expect("fts5 statement");
        db.execute_batch(
            "CREATE TABLE chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL); CREATE TEMP TABLE eligible(id INTEGER PRIMARY KEY);",
        )
        .expect("chunks");
        db.execute_batch(&fts).expect("fts");
        let documents = corpus["ranking"]["documents"]
            .as_object()
            .expect("documents");
        let mut paths = documents.keys().collect::<Vec<_>>();
        paths.sort();
        for (at, path) in paths.iter().enumerate() {
            db.execute(
                "INSERT INTO chunks VALUES(?1,?2,0,?3)",
                (
                    at as i64 + 1,
                    path.as_str(),
                    documents[*path].as_str().expect("text"),
                ),
            )
            .expect("chunk");
            db.execute("INSERT INTO eligible VALUES(?1)", [at as i64 + 1])
                .expect("eligible");
        }
        db.execute("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')", [])
            .expect("rebuild");
        for case in corpus["ranking"]["cases"].as_array().expect("cases") {
            let query = case["query"].as_str().expect("query");
            for (key, hybrid) in [("expected", false), ("hybrid", true)] {
                let paths = fts_arm(&db, query, hybrid)
                    .expect("arm")
                    .into_iter()
                    .map(|(_, p, _)| p)
                    .collect::<Vec<_>>();
                let expected = case[key]
                    .as_array()
                    .expect("expected")
                    .iter()
                    .map(|p| p.as_str().expect("path").to_owned())
                    .collect::<Vec<_>>();
                assert_eq!(paths, expected, "{query} {key}");
            }
        }
    }
    #[test]
    fn sqlite_progress_interrupts_deadline_and_cross_thread_cancel() {
        for timeout in [true, false] {
            let mut c = Connection::open_in_memory().expect("SQLite");
            let ctl = SearchControl::with_timeout(if timeout {
                Duration::from_millis(20)
            } else {
                QUERY_DEADLINE
            });
            install(&mut c, &ctl).expect("progress boundary");
            let stop = ctl.clone();
            let worker = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                if !timeout {
                    stop.cancel();
                }
            });
            let err=c.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",[],|r|r.get::<_,i64>(0)).expect_err("interrupt actual SQLite execution");
            assert_eq!(
                err.sqlite_error_code(),
                Some(rusqlite::ErrorCode::OperationInterrupted)
            );
            assert!(ctl.check().is_err());
            worker.join().expect("join owned cancel worker");
        }
    }
}
